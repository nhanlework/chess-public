// KnightCharacter: the knight piece ('n'), a mounted knight after the
// jousting-knight reference — a white horse (black for the dark side) under
// a caparison banded in red, a steel chanfron and a red bridle, ridden by a
// knight in full plate with a red plume and a red lance.
// The anatomy is built from parametric surfaces (lofted sections and swept
// tubes) instead of primitives, so muscle, joints, armour and cloth read as
// continuous forms. Its attack is a charge: the horse gathers itself, gallops
// from its own square straight at the victim and the lance is driven home.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const ProceduralCharacter = window.Chess3D.ProceduralCharacter;
  const MB = BABYLON.MeshBuilder;
  const { TAU, hex, V3, lerp, clamp, smoothstep, spow, curve, bezier, grid, sweep } = window.Chess3D.SurfaceKit;

  // ------------------------------------------------------------ livery
  // White side: grey-white horse, ivory caparison banded in red. Dark side:
  // black horse, charcoal caparison banded in crimson. Plate armour and gold
  // come from the team palette.
  const LIVERY = {
    w: { coat: '#e6e3dd', hair: '#f4f2ed', hoof: '#48413e', dark: '#1a1414', cloth: '#f2efe8', band: '#b3121b',
      lining: '#8e0f17', strap: '#a3141c', saddle: '#5a3420', lance: '#b3121b', plume: '#c8141c' },
    b: { coat: '#2b2624', hair: '#141110', hoof: '#141111', dark: '#050404', cloth: '#29282e', band: '#a3141f',
      lining: '#5e0b12', strap: '#7a0f18', saddle: '#2e1d14', lance: '#26242a', plume: '#a3141f' }
  };

  // ------------------------------------------------------------ horse
  // Mount space: origin on the board under the horse, +z toward the head.
  // Barrel keys [z, top, bottom, half-width] from the point of the buttock
  // to the chest; sections are superellipses, flatter over the back.
  const BODY = [
    [-0.288, 0.462, 0.438, 0.006], [-0.278, 0.505, 0.395, 0.05], [-0.255, 0.532, 0.36, 0.088],
    [-0.215, 0.548, 0.338, 0.114], [-0.15, 0.552, 0.325, 0.128], [-0.07, 0.54, 0.318, 0.134],
    [0.02, 0.538, 0.315, 0.135], [0.1, 0.55, 0.32, 0.13], [0.16, 0.556, 0.332, 0.12],
    [0.21, 0.535, 0.348, 0.1], [0.245, 0.49, 0.365, 0.07], [0.262, 0.44, 0.385, 0.03], [0.268, 0.415, 0.4, 0.004]
  ];
  const Z_MIN = BODY[0][0], Z_MAX = BODY[BODY.length - 1][0];
  const E_UP = 2.6, E_DN = 2.1;

  function barrel(z) {
    const [top, bot, hw] = curve(BODY, clamp(z, Z_MIN, Z_MAX));
    return { c: (top + bot) / 2, hy: (top - bot) / 2, hw };
  }
  function barrelPoint(a, z) {
    const b = barrel(z), c = Math.cos(a);
    const e = c >= 0 ? E_UP : E_DN;
    return [b.hw * spow(Math.sin(a), 2 / e), b.c + b.hy * spow(c, 2 / e), z];
  }
  // Height of the barrel's upper surface over (x, z).
  function backHeight(x, z) {
    const b = barrel(z), r = Math.min(1, Math.abs(x) / Math.max(1e-4, b.hw));
    return b.c + b.hy * Math.pow(1 - Math.pow(r, E_UP), 1 / E_UP);
  }

  // Caparison: θ runs round the horse from the chest (0) over the right
  // flank (π/2) to the rump (π); each column falls from the spine over the
  // barrel to its widest line, then hangs free to the hem, flaring into
  // folds. The hem rises in a round arch over each leg.
  const CLOTH = { ox: 0.152, oz: 0.296, z0: -0.01, e: 2.5, dome: 0.46, lift: 0.008, flare: 0.05, folds: 22 };
  const ARCHES = [[0.65, 0.43], [2.37, 0.5]];     // [θ, half-width] of the leg openings (mirrored)
  const HEM = { flank: 0.205, chest: 0.24, rump: 0.235, arch: 0.345 };

  function clothDir(th) {
    const p = 2 / CLOTH.e, x = CLOTH.ox * spow(Math.sin(th), p), z = CLOTH.oz * spow(Math.cos(th), p), l = Math.hypot(x, z);
    return [x / l, z / l];
  }
  // Plan distance from the cloth centre to the barrel's widest line (memoised:
  // every column is queried many times while the cloth and its trim are built).
  const rimCache = new Map();
  function rimDist(dx, dz) {
    const key = `${dx.toFixed(5)},${dz.toFixed(5)}`;
    if (rimCache.has(key)) return rimCache.get(key);
    const inside = (r) => {
      const z = CLOTH.z0 + r * dz;
      return z >= Z_MIN && z <= Z_MAX && barrel(z).hw > Math.abs(r * dx);
    };
    let lo = 0, hi = 0.4;
    for (let i = 0; i < 28; i++) { const mid = (lo + hi) / 2; if (inside(mid)) lo = mid; else hi = mid; }
    rimCache.set(key, lo);
    return lo;
  }
  function hemY(th) {
    const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
    let y = HEM.flank + (HEM.chest - HEM.flank) * Math.pow(Math.max(0, Math.cos(a)), 6)
      + (HEM.rump - HEM.flank) * Math.pow(Math.max(0, -Math.cos(a)), 6);
    ARCHES.forEach(([c, w]) => {
      const d = Math.abs(a - c) / w;
      if (d < 1) y += (HEM.arch - y) * Math.pow(Math.cos(d * Math.PI / 2), 1.3);
    });
    return y;
  }
  function clothPoint(th, v, lift) {
    const [dx, dz] = clothDir(th), rb = rimDist(dx, dz), z0 = CLOTH.z0;
    if (v <= CLOTH.dome) {
      const s = Math.sin((v / CLOTH.dome) * Math.PI / 2), r = rb * s;
      const y = backHeight(r * dx, z0 + r * dz) + lift;
      const re = r + lift * Math.pow(s, 6);
      return [re * dx, y, z0 + re * dz];
    }
    const s = (v - CLOTH.dome) / (1 - CLOTH.dome);
    const y0 = barrel(z0 + rb * dz).c + lift, hem = hemY(th);
    const y = lerp(y0, hem, s) + 0.007 * s * s * Math.sin(CLOTH.folds * th + 1.3);
    const r = rb + lift + CLOTH.flare * Math.pow(s, 1.4) + 0.011 * Math.pow(s, 1.2) * Math.sin(CLOTH.folds * th);
    return [r * dx, y, z0 + r * dz];
  }

  // Neck: lofted between the crest and the throat line (y, z) with a
  // section narrower along the crest. t = 0 in the chest, 1 at the poll.
  const NECK_CREST = [[0, 0.545, 0.06], [0.25, 0.63, 0.15], [0.5, 0.715, 0.225], [0.75, 0.785, 0.283], [1, 0.828, 0.322]];
  const NECK_THROAT = [[0, 0.38, 0.235], [0.25, 0.47, 0.276], [0.5, 0.57, 0.292], [0.75, 0.66, 0.294], [1, 0.738, 0.296]];
  const NECK_W = [[0, 0.098], [0.3, 0.07], [0.6, 0.054], [0.85, 0.047], [1, 0.044]];
  const NECK_PIVOT = [0, 0.47, 0.16];
  const POLL = [0, 0.828, 0.322];
  const HEAD_PITCH = 1.08, HEAD_SCALE = 1.0;

  function neckPoint(t, a, lift) {
    const [ty, tz] = curve(NECK_CREST, t), [by, bz] = curve(NECK_THROAT, t), [w] = curve(NECK_W, t);
    const cy = (ty + by) / 2, cz = (tz + bz) / 2, dy = (ty - by) / 2, dz = (tz - bz) / 2, h = Math.hypot(dy, dz);
    const c = Math.cos(a), s = Math.sin(a), l = lift || 0;
    const narrow = 1 - 0.34 * Math.pow(Math.max(0, c), 3) - 0.1 * Math.pow(Math.max(0, -c), 2);
    const r = (h + l) * spow(c, 2 / 2.3);
    return [(w * narrow + l) * spow(s, 2 / 2.3), cy + dy / h * r, cz + dz / h * r];
  }

  // Head, in head space: origin at the poll, +z down the face to the
  // muzzle, +y toward the forehead. Keys [z, top, bottom, half-width].
  const HEAD = [
    [-0.03, 0.006, -0.04, 0.03], [-0.012, 0.018, -0.058, 0.04], [0.015, 0.025, -0.084, 0.05], [0.048, 0.025, -0.093, 0.054],
    [0.078, 0.022, -0.074, 0.047], [0.108, 0.019, -0.055, 0.036], [0.145, 0.017, -0.046, 0.031], [0.175, 0.013, -0.048, 0.031],
    [0.197, 0.004, -0.046, 0.033], [0.21, -0.008, -0.042, 0.029], [0.218, -0.02, -0.034, 0.017], [0.221, -0.026, -0.03, 0.003]
  ];
  const HEAD_Z = [HEAD[0][0], HEAD[HEAD.length - 1][0]];
  function headPoint(z, a, lift) {
    const [top, bot, w] = curve(HEAD, z), c = Math.cos(a), s = Math.sin(a), l = lift || 0;
    const cy = (top + bot) / 2, hh = (top - bot) / 2, e = c >= 0 ? 2.8 : 2.2;
    const jaw = 1 - 0.2 * Math.pow(Math.max(0, -c), 1.5) * smoothstep(0.1, 0.02, z);
    return [(w * jaw + l) * spow(s, 2 / e), cy + (hh + l) * spow(c, 2 / e), z];
  }
  const EYE = { z: 0.07, y: 0.004 };

  // Leg segments. Keys [t, y, zc, rx, rzFront, rzBack]: the centre (0, y, zc)
  // and an egg-shaped horizontal section. Each pivots at its top joint.
  const LEG = {
    foreUpper: [[0, 0.075, 0.005, 0.046, 0.05, 0.046], [0.2, 0.03, 0.006, 0.042, 0.05, 0.042], [0.4, -0.02, 0.002, 0.033, 0.04, 0.032],
      [0.62, -0.068, 0, 0.024, 0.026, 0.023], [0.8, -0.105, 0, 0.019, 0.021, 0.019], [0.9, -0.125, 0.001, 0.021, 0.025, 0.02],
      [0.97, -0.14, 0, 0.018, 0.02, 0.017], [1, -0.146, 0, 0.008, 0.009, 0.008]],
    foreLower: [[0, 0.018, 0, 0.013, 0.014, 0.012], [0.1, 0.008, 0, 0.018, 0.02, 0.018], [0.3, -0.02, -0.002, 0.0155, 0.016, 0.019],
      [0.6, -0.055, -0.003, 0.0145, 0.015, 0.02], [0.8, -0.078, -0.002, 0.017, 0.017, 0.023], [0.9, -0.09, -0.002, 0.02, 0.019, 0.03],
      [0.97, -0.1, -0.002, 0.018, 0.017, 0.022], [1, -0.104, -0.002, 0.008, 0.008, 0.01]],
    hindUpper: [[0, 0.09, 0.03, 0.05, 0.05, 0.062], [0.2, 0.04, 0.015, 0.044, 0.045, 0.058], [0.42, -0.015, -0.008, 0.032, 0.03, 0.045],
      [0.65, -0.062, -0.026, 0.022, 0.021, 0.03], [0.82, -0.095, -0.038, 0.019, 0.02, 0.026], [0.92, -0.112, -0.044, 0.021, 0.021, 0.036],
      [0.98, -0.124, -0.045, 0.017, 0.018, 0.02], [1, -0.128, -0.045, 0.008, 0.008, 0.01]],
    hindLower: [[0, 0.012, 0, 0.014, 0.014, 0.016], [0.1, 0.002, 0, 0.018, 0.019, 0.022], [0.35, -0.03, -0.002, 0.0155, 0.017, 0.02],
      [0.65, -0.065, -0.003, 0.015, 0.016, 0.021], [0.82, -0.088, -0.002, 0.017, 0.017, 0.024], [0.91, -0.1, -0.002, 0.02, 0.019, 0.03],
      [0.97, -0.109, -0.002, 0.018, 0.017, 0.022], [1, -0.113, -0.002, 0.008, 0.008, 0.01]],
    pastern: [[0, 0.012, -0.004, 0.012, 0.012, 0.012], [0.15, 0.004, -0.004, 0.017, 0.017, 0.021], [0.5, -0.012, 0.002, 0.0155, 0.016, 0.016],
      [0.85, -0.026, 0.008, 0.018, 0.019, 0.017], [1, -0.03, 0.009, 0.012, 0.012, 0.012]],
    hoof: [[0, -0.024, 0.009, 0.0185, 0.019, 0.016], [0.5, -0.04, 0.012, 0.0205, 0.024, 0.018], [1, -0.056, 0.015, 0.023, 0.03, 0.02]]
  };
  // Hip pivot, knee/hock and fetlock joints per leg (FR, FL, BR, BL).
  const LEGS = [
    { name: 'FR', fore: true, at: [0.068, 0.35, 0.155] }, { name: 'FL', fore: true, at: [-0.068, 0.35, 0.155] },
    { name: 'BR', fore: false, at: [0.075, 0.345, -0.15] }, { name: 'BL', fore: false, at: [-0.075, 0.345, -0.15] }
  ];
  const KNEE = { fore: [0, -0.13, 0], hind: [0, -0.115, -0.045] };
  const FETLOCK = { fore: -0.09, hind: -0.1 };

  // Poses: [hip, knee/hock, fetlock] per leg in LEGS order. Positive angles
  // swing the part below the joint backward.
  const POSE = {
    rest: [[-0.62, 1.3, 0.55], [0.04, 0, 0], [0.06, -0.04, 0.02], [-0.05, 0.03, 0]],
    stand: [[0.02, 0, 0], [0.03, 0, 0], [0.04, -0.03, 0.02], [-0.03, 0.02, 0]],
    jump: [[-1.05, 1.9, 0.9], [-0.95, 1.8, 0.9], [0.75, -0.95, 0.7], [0.65, -0.9, 0.7]],
    gather: [[-0.75, 1.55, 0.7], [-0.55, 1.35, 0.6], [-0.42, -0.35, -0.1], [-0.36, -0.3, -0.1]],
    rear: [[-1.15, 1.8, 0.8], [-0.85, 1.6, 0.8], [-0.5, -0.25, -0.1], [-0.42, -0.2, -0.1]],
    fallen: [[-0.5, 1.2, 0.6], [0.3, 0.6, 0.4], [0.5, -0.7, 0.4], [-0.2, -0.4, 0.3]]
  };

  // One stride of a leg at phase p in [0, 1): stance (hoof planted, the leg
  // sweeping back under the body) for the first `duty`, then the swing
  // forward with the knee or hock folded.
  function strideAngles(fore, p, duty, amp) {
    const reach = fore ? [-0.5, 0.45] : [-0.42, 0.5];
    if (p < duty) {
      const s = p / duty;
      return [lerp(reach[0], reach[1], s) * amp, fore ? 0 : -0.18 * Math.sin(Math.PI * s) * amp, -0.25 * Math.sin(Math.PI * s) * amp];
    }
    const s = (p - duty) / (1 - duty), lift = Math.sin(Math.PI * s);
    return [lerp(reach[1], reach[0], s * s * (3 - 2 * s)) * amp, (fore ? 1.75 : -1.2) * Math.pow(lift, 1.2) * amp, 1.1 * lift * amp];
  }
  // Footfall phases (FR, FL, BR, BL): trot moves diagonal pairs together;
  // the right-lead gallop lands left hind, right hind, left fore, right fore.
  const GAIT = {
    trot: { phase: [0, 0.5, 0.5, 0], duty: 0.46, amp: 0.62, hz: 2.4 },
    gallop: { phase: [0.4, 0.3, 0.1, 0], duty: 0.32, amp: 1, hz: 3.2 }
  };

  // Rider: rider space origin on the saddle seat.
  const RIDER_AT = [0, 0.575, -0.035];
  const TORSO = [[0, 0.07, 0.055, 0.06], [0.05, 0.078, 0.058, 0.06], [0.09, 0.072, 0.062, 0.055], [0.13, 0.086, 0.078, 0.058],
    [0.17, 0.1, 0.084, 0.064], [0.205, 0.106, 0.07, 0.064], [0.228, 0.08, 0.052, 0.05], [0.245, 0.046, 0.042, 0.04]];
  function torsoPoint(a, y, lift) {
    const [rx, rzF, rzB] = curve(TORSO, y), l = lift || 0, c = Math.cos(a), p = 2 / 2.4;
    const ridge = 0.006 * Math.exp(-Math.pow(Math.sin(a) / 0.16, 2)) * Math.max(0, c) * smoothstep(0.09, 0.14, y) * (1 - smoothstep(0.2, 0.232, y));
    return [(rx + l) * spow(Math.sin(a), p), y, ((c >= 0 ? rzF : rzB) + l) * spow(c, p) + ridge];
  }
  const HELM_AT = [0, 0.316, 0.004];
  function helmPoint(th, ph, lift) {
    const s = Math.sin(ph), c = Math.cos(ph), front = Math.max(0, Math.cos(th)), l = lift || 0;
    const ry = c >= 0 ? 0.061 : 0.066;
    const visor = smoothstep(1.24, 1.3, ph);
    const k = 1 + 0.04 * visor;
    const beak = 0.026 * Math.pow(front, 6) * Math.exp(-Math.pow((ph - 1.78) / 0.42, 2));
    const comb = 0.007 * Math.exp(-Math.pow(Math.sin(th) * s / 0.012, 2)) * (1 - smoothstep(1.2, 1.6, ph));
    const flare = 0.005 * smoothstep(2.15, 2.5, ph);
    return [(0.05 * k + flare + l) * s * Math.sin(th), (ry + comb + l) * c, (0.057 * k + flare + l) * s * Math.cos(th) + beak * (1 + l * 10)];
  }
  // Lance angles [x, z] on the hand: carried slanting up, couched level.
  const LANCE = { carry: [0.55, -0.06], couch: [1.5, 0.2], len: 0.78 };
  const CHARGE = { gather: 520, perUnit: 380, min: 620, bite: 0.03 };  // bite: how far short of the victim's centre the tip stops

  // ------------------------------------------------------------ textures
  // Caparison in (u, v): u = arc length round the rim from the chest,
  // v = arc length from the spine down to the hem. layout.uOf(θ) maps a
  // column to u, layout.perim / layout.depth give world sizes.
  function drawCaparison(c, w, h, L, gold, layout) {
    c.fillStyle = L.cloth;
    c.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {               // linen weave
      c.fillStyle = `rgba(0,0,0,${0.015 + Math.random() * 0.03})`;
      c.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 5, 1);
    }
    const shade = c.createLinearGradient(0, 0, 0, h);
    shade.addColorStop(0, 'rgba(255,255,255,0.05)');
    shade.addColorStop(0.5, 'rgba(0,0,0,0)');
    shade.addColorStop(1, 'rgba(0,0,0,0.14)');
    c.fillStyle = shade;
    c.fillRect(0, 0, w, h);
    const px = (world) => world / layout.perim * w, py = (world) => world / layout.depth * h;
    const edge = Math.max(2, px(0.004));
    const band = (th, width, v0) => {
      [layout.uOf(th) * w, layout.uOf(th) * w + (th === 0 ? w : 0)].forEach((x) => {
        const bw = px(width), y0 = v0 * h;
        c.fillStyle = L.band; c.fillRect(x - bw / 2, y0, bw, h - y0);
        c.fillStyle = gold; c.fillRect(x - bw / 2 - edge, y0, edge, h - y0); c.fillRect(x + bw / 2, y0, edge, h - y0);
      });
    };
    band(0, 0.05, 0.3);
    [1.28, 1.8].forEach((th) => { band(th, 0.055, 0.22); band(TAU - th, 0.055, 0.22); });
    band(Math.PI, 0.05, 0.42);
    // hem border
    c.fillStyle = L.band; c.fillRect(0, h * 0.905, w, h * 0.095);
    c.fillStyle = gold; c.fillRect(0, h * 0.905 - edge, w, edge); c.fillRect(0, h - edge * 0.8, w, edge * 0.8);
    // heraldic shield on each hindquarter
    [Math.PI - 0.8, Math.PI + 0.8].forEach((th) => {
      const cx = layout.uOf(th) * w, cy = h * 0.5, sw = px(0.078), sh = py(0.092);
      c.beginPath();
      c.moveTo(cx - sw / 2, cy - sh / 2); c.lineTo(cx + sw / 2, cy - sh / 2);
      c.quadraticCurveTo(cx + sw / 2, cy + sh * 0.2, cx, cy + sh / 2);
      c.quadraticCurveTo(cx - sw / 2, cy + sh * 0.2, cx - sw / 2, cy - sh / 2);
      c.closePath();
      c.fillStyle = L.band; c.fill();
      c.lineWidth = Math.max(3, sw * 0.07); c.strokeStyle = gold; c.stroke();
      c.fillStyle = gold;
      c.fillRect(cx - sw * 0.07, cy - sh * 0.36, sw * 0.14, sh * 0.72);
      c.fillRect(cx - sw * 0.3, cy - sh * 0.14, sw * 0.6, sh * 0.13);
    });
  }

  // ------------------------------------------------------------ character
  class KnightCharacter extends ProceduralCharacter {
    _mat(name, color, metallic, roughness, twoSided) {
      const mat = new BABYLON.PBRMaterial(`${name}_${this.id}`, this.scene);
      mat.albedoColor = typeof color === 'string' ? hex(color) : color;
      mat.metallic = metallic; mat.roughness = roughness; mat.maxSimultaneousLights = 8;
      if (twoSided) { mat.backFaceCulling = false; mat.twoSidedLighting = true; }
      this.materials.push(mat);
      return mat;
    }

    _surf(name, vd, mat, parent) {
      const mesh = new BABYLON.Mesh(`${name}_${this.id}`, this.scene);
      vd.applyToMesh(mesh);
      return this._add(mesh, parent, mat);
    }

    _node(name, parent, pos, rot) {
      const n = new BABYLON.TransformNode(`${name}_${this.id}`, this.scene);
      n.parent = parent;
      if (pos) n.position.set(pos[0], pos[1], pos[2]);
      if (rot) n.rotation.set(rot[0], rot[1], rot[2]);
      this._pivots.push(n);
      return n;
    }

    // Tube through `pts` (Catmull-Rom) with radius keys [[t, r], ...] or a constant.
    _cord(name, pts, radius, mat, parent, sides) {
      const keys = pts.map((p, i) => [i / (pts.length - 1), ...p]);
      const rk = typeof radius === 'number' ? [[0, radius], [1, radius]] : radius;
      return this._surf(name, sweep(sides || 8, Math.min(40, Math.max(6, pts.length * 2)), (t) => curve(keys, t), (t, a) => {
        const r = curve(rk, t)[0];
        return [r * Math.cos(a), r * Math.sin(a)];
      }, { capStart: true, capEnd: true }), mat, parent);
    }

    // Joint cop (poleyn, couter): a rounded plate cupping the joint at b,
    // stretched along the limb from a through b to c.
    _cop(name, a, b, c, r, mat, parent) {
      const A = V3(...a), B = V3(...b), C = V3(...c);
      const p0 = B.add(A.subtract(B).normalize().scale(0.032)), p2 = B.add(C.subtract(B).normalize().scale(0.03));
      const out = B.subtract(p0.add(p2).scale(0.5)).normalize().scale(0.006);
      const keys = [[0, p0.x, p0.y, p0.z], [0.5, B.x + out.x, B.y + out.y, B.z + out.z], [1, p2.x, p2.y, p2.z]];
      return this._surf(name, sweep(14, 10, (t) => curve(keys, t), (t, ang) => {
        const k = r * (0.82 + 0.18 * Math.sin(Math.PI * t));
        return [k * Math.cos(ang), k * Math.sin(ang)];
      }, { capStart: true, capEnd: true }), mat, parent);
    }

    // Leaf-shaped plate (fan plates, wings) centred at c: `len` along ax,
    // `wid` along ay, bulging `bulge` along n, rimmed in gold.
    _leaf(name, c, ax, ay, n, len, wid, bulge, mat, rimMat, parent) {
      const [C, X, Y, N] = [c, ax, ay, n].map((v) => V3(...v).normalize()).map((v, i) => (i ? v : V3(...c)));
      const pt = (s, q) => {
        const w = Math.sqrt(Math.max(0, 1 - s * s)) * (1 - 0.25 * s);
        const p = C.add(X.scale(s * len / 2)).add(Y.scale(q * w * wid / 2)).add(N.scale(bulge * (1 - s * s) * (1 - 0.6 * q * q)));
        return [p.x, p.y, p.z];
      };
      this._surf(name, grid(10, 12, (u, v) => pt(2 * v - 1, 2 * u - 1)), mat, parent);
      const rim = [];
      for (let k = 0; k <= 24; k++) {
        const a = k / 24 * TAU;
        rim.push(pt(Math.cos(a) * 0.999, Math.sign(Math.sin(a)) || 0));
      }
      this._cord(`${name}Rim`, rim, 0.0018, rimMat, parent, 5);
    }

    async build() {
      await super.build();
      this._reinsObserver = this.scene.onBeforeRenderObservable.add(() => this._updateReins());
    }

    dispose() {
      if (this._reinsObserver) this.scene.onBeforeRenderObservable.remove(this._reinsObserver);
      this._reinsObserver = null;
      super.dispose();
    }

    _buildKnight(team) {
      const L = LIVERY[this.color] || LIVERY.w;
      this._pivots = [];
      const M = this.kMats = {
        coat: this._mat('coat', L.coat, 0, 0.55),
        hair: this._mat('hair', L.hair, 0, 0.5, true),
        hoof: this._mat('hoof', L.hoof, 0, 0.35),
        dark: this._mat('eyeDark', L.dark, 0, 0.12),
        lining: this._mat('lining', L.lining, 0, 0.85, true),
        strap: this._mat('strap', L.strap, 0, 0.5),
        rein: this._mat('rein', L.strap, 0, 0.5),
        saddle: this._mat('saddle', L.saddle, 0, 0.55, true),
        plate: this._mat('plate', team.armor, 0.92, 0.24, true),
        gold: this._mat('gold', team.accent, 1, 0.28),
        lance: this._mat('lance', L.lance, 0.05, 0.42),
        plume: this._mat('plume', L.plume, 0, 0.75, true)
      };
      M.coat.sheen.isEnabled = true; M.coat.sheen.intensity = 0.25;
      M.hair.sheen.isEnabled = true; M.hair.sheen.intensity = 0.4;
      M.dark.clearCoat.isEnabled = true;

      // The whole mount (horse + rider) hangs off `torso`, so the shared hit,
      // death and dissolve animations move the pair as one piece.
      const mount = new BABYLON.TransformNode(`torso_${this.id}`, this.scene);
      mount.parent = this.visual;
      this.parts.torso = mount;

      this._buildBarrel(mount, M);
      this._buildCaparison(mount, M, L, team);
      this._buildLegs(mount, M);
      this._buildTail(mount, M);
      this._buildNeckAndHead(mount, M);
      this._buildSaddle(mount, M);
      this._buildRider(mount, M);
      this._buildReins(mount, M);
      // The base build() merges same-material meshes under these pivots.
      this.parts.extraPivots = this._pivots.filter((n) => ![this.parts.head, this.parts.armR, this.parts.armL, this.parts.weapon].includes(n));
    }

    _buildBarrel(mount, M) {
      this._surf('barrel', grid(28, 40, (u, v) => barrelPoint(u * TAU, lerp(Z_MIN, Z_MAX, 0.5 - 0.5 * Math.cos(Math.PI * v))),
        { closed: true }), M.coat, mount);
    }

    _buildCaparison(mount, M, L, team) {
      const NU = 128, NV = 30;
      const pts = [];
      for (let j = 0; j <= NV; j++) {
        const row = [];
        for (let i = 0; i <= NU; i++) row.push(clothPoint((i / NU) * TAU, j / NV, CLOTH.lift));
        pts.push(row);
      }
      // Texture coordinates from arc lengths: u round the rim, v down each column.
      const rimRow = pts[Math.round(NV * CLOTH.dome)], rimLen = [0];
      for (let i = 1; i <= NU; i++) rimLen.push(rimLen[i - 1] + BABYLON.Vector3.Distance(V3(...rimRow[i]), V3(...rimRow[i - 1])));
      const perim = rimLen[NU];
      const colLen = [];
      for (let i = 0; i <= NU; i++) {
        const acc = [0];
        for (let j = 1; j <= NV; j++) acc.push(acc[j - 1] + BABYLON.Vector3.Distance(V3(...pts[j][i]), V3(...pts[j - 1][i])));
        colLen.push(acc);
      }
      const depth = colLen.reduce((s, a) => s + a[NV], 0) / (NU + 1);
      const uOf = (th) => {
        const f = ((th / TAU) % 1 + 1) % 1 * NU, i = Math.floor(f);
        return i >= NU ? 1 : lerp(rimLen[i], rimLen[i + 1], f - i) / perim;
      };
      const gold = team.accent;
      const tex = new BABYLON.DynamicTexture(`capTex_${this.id}`, { width: 2048, height: 512 }, this.scene, true);
      drawCaparison(tex.getContext(), 2048, 512, L, gold, { uOf, perim, depth });
      tex.update();
      tex.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
      const clothMat = this._mat('caparison', '#ffffff', 0, 0.85);
      clothMat.albedoTexture = tex;
      clothMat.sheen.isEnabled = true; clothMat.sheen.intensity = 0.35;
      const surfaceFrom = (lift, inward) => grid(NU, NV, (u, v) => {
        const i = Math.round(u * NU), j = Math.round(v * NV);
        const p = lift === CLOTH.lift ? pts[j][i] : clothPoint(u * TAU, v, lift);
        return [p[0], p[1], p[2], rimLen[i] / perim, 1 - colLen[i][j] / colLen[i][NV]];
      }, { closed: true, inward });
      this._surf('caparison', surfaceFrom(CLOTH.lift, false), clothMat, mount);
      this._surf('capLining', surfaceFrom(CLOTH.lift - 0.004, true), M.lining, mount);
      this._clothAt = (th, y) => {                   // cloth surface point on column θ at height y
        let best = null;
        for (let v = 0; v <= 1; v += 0.01) {
          const p = clothPoint(th, v, CLOTH.lift);
          if (!best || Math.abs(p[1] - y) < Math.abs(best[1] - y)) best = p;
        }
        return best;
      };
    }

    _legSeg(name, keys, mat, parent, cap) {
      return this._surf(name, grid(16, 22, (u, v) => {
        const [y, zc, rx, rzF, rzB] = curve(keys, v), a = u * TAU, c = Math.cos(a);
        return [rx * Math.sin(a), y, zc + (c >= 0 ? rzF : rzB) * c];
      }, { closed: true, capEnd: cap }), mat, parent);
    }

    _buildLegs(mount, M) {
      const legs = [];
      LEGS.forEach((spec, idx) => {
        const kind = spec.fore ? 'fore' : 'hind';
        const upper = this._node(`hLeg${spec.name}`, mount, spec.at);
        this._legSeg(`hUpper${spec.name}`, LEG[`${kind}Upper`], M.coat, upper, true);
        const lower = this._node(`hShin${spec.name}`, upper, KNEE[kind]);
        this._legSeg(`hLower${spec.name}`, LEG[`${kind}Lower`], M.coat, lower, true);
        const fet = this._node(`hFet${spec.name}`, lower, [0, FETLOCK[kind], 0]);
        this._legSeg(`hPastern${spec.name}`, LEG.pastern, M.coat, fet, true);
        this._legSeg(`hHoof${spec.name}`, LEG.hoof, M.hoof, fet, true);
        // Feathering: a fringe of hair over the back of the fetlock.
        this._surf(`hFeather${spec.name}`, grid(14, 5, (u, v) => {
          const a = Math.PI * (0.55 + 0.9 * u), zig = (Math.round(u * 14) % 2) * 0.006 * v;
          const r = 0.021 + 0.01 * v;
          return [r * Math.sin(a), 0.006 - 0.036 * v + zig, -0.003 + r * Math.cos(a) * 1.15];
        }), M.hair, fet);
        const rest = POSE.rest[idx];
        upper.rotation.x = rest[0]; lower.rotation.x = rest[1]; fet.rotation.x = rest[2];
        legs.push({ upper, lower, fet, rest, fore: spec.fore });
      });
      this.parts.hLegs = legs;
    }

    _buildTail(mount, M) {
      const tail = this._node('tail', mount, [0, 0.505, -0.272]);
      this.parts.tail = tail;
      this._cord('tailDock', [[0, 0.012, 0.012], [0, 0.004, -0.028], [0, -0.028, -0.052], [0, -0.07, -0.066]],
        [[0, 0.022], [0.6, 0.019], [1, 0.008]], M.coat, tail);
      const LOCKS = 22;
      for (let i = 0; i < LOCKS; i++) {
        const j = Math.sin(i * 12.9898) * 0.5, k = Math.sin(i * 4.1414) * 0.5;
        const ring = i / LOCKS * TAU, rx = Math.sin(ring) * 0.011, ry = Math.cos(ring) * 0.009;
        const d = 0.25 + 0.75 * ((i * 7) % LOCKS) / LOCKS;       // where along the dock the lock springs from
        const root = [rx, -0.07 * d + ry, -0.03 - 0.035 * d];
        const spread = rx * 1.5 + 0.012 * k;
        const ctrl = [root, [spread * 0.8, root[1] - 0.02, root[2] - 0.06], [spread * 1.6 + 0.01 * j, -0.19 + 0.02 * k, -0.12 - 0.03 * j],
          [spread * 2.2 - 0.01 * j, -0.33, -0.07 + 0.03 * k], [spread * 2.4, -0.4 + 0.03 * Math.abs(j), -0.1 + 0.04 * j]];
        const len = 0.88 + 0.12 * j;
        this._surf(`tailLock${i}`, sweep(6, 20, (t) => {
          const p = bezier(ctrl, t * len);
          return [p[0] + 0.006 * Math.sin(t * 8 + i), p[1], p[2] + 0.005 * Math.sin(t * 6 + i * 2)];
        }, (t, a) => {
          const w = 0.024 * (1 - 0.82 * t) * (0.75 + 0.25 * Math.sin(Math.PI * Math.min(1, t + 0.3))) + 0.002;
          return [w * Math.cos(a), (0.0055 * (1 - 0.6 * t) + 0.0015) * Math.sin(a)];
        }, { side: [Math.cos(ring), 0, 0.3], capStart: true, capEnd: true }), M.hair, tail);
      }
    }

    _buildNeckAndHead(mount, M) {
      const NP = NECK_PIVOT, rel = (p) => [p[0] - NP[0], p[1] - NP[1], p[2] - NP[2]];
      const neck = this._node('neck', mount, NP);
      this.parts.neck = neck;
      this._surf('neck', grid(24, 20, (u, v) => rel(neckPoint(v, u * TAU)), { closed: true }), M.coat, neck);

      // Mane: a long outer layer falling down the right side of the neck over
      // a short layer standing along the crest.
      const lock = (name, t0, a0, a1, len, width, j, lift) => {
        const tangent = V3(...neckPoint(Math.min(1, t0 + 0.02), a0)).subtract(V3(...neckPoint(Math.max(0, t0 - 0.02), a0))).normalize();
        this._surf(name, sweep(6, 14, (s) => {
          const e = Math.pow(s, 0.85) * len;
          const a = lerp(a0, a1, e) + 0.06 * Math.sin(s * 5 + j * 9);
          const t = clamp(t0 - 0.1 * e * e + 0.012 * Math.sin(s * 6 + j * 4), 0, 1);
          return rel(neckPoint(t, a, lift + 0.011 * Math.sin(Math.PI * Math.min(1, s * 1.3)) + 0.006 * s));
        }, (s, a) => {
          const w = width * (1 - 0.8 * s) * (0.7 + 0.3 * Math.sin(Math.PI * Math.min(1, 0.2 + s))) + 0.0015;
          return [w * Math.cos(a), (0.0045 * (1 - 0.6 * s) + 0.001) * Math.sin(a)];
        }, { side: [tangent.x, tangent.y, tangent.z], capStart: true, capEnd: true }), M.hair, neck);
      };
      for (let i = 0; i < 30; i++) {
        const j = Math.sin(i * 78.233) * 0.5, t0 = 0.06 + 0.94 * (i / 29) + 0.012 * j;
        lock(`maneLock${i}`, clamp(t0, 0, 1), 0.1 + 0.08 * j, 1.35 + 0.25 * j - 0.3 * t0, 0.95 + 0.08 * j, 0.016, j, 0.004);
      }
      for (let i = 0; i < 16; i++) {
        const j = Math.sin(i * 12.9898) * 0.5, t0 = 0.1 + 0.88 * (i / 15);
        lock(`maneTop${i}`, t0, -0.25 + 0.1 * j, 0.55 + 0.15 * j, 0.9, 0.013, j, 0.008);
      }
      // Breast collar: a red strap from the saddle round the chest, over the cloth.
      const collar = [];
      for (let k = 0; k <= 14; k++) {
        const f = k / 14 * 2 - 1, th = f * 1.3, p = this._clothAt(th, 0.465 + 0.07 * Math.pow(Math.abs(f), 3));
        collar.push(rel([p[0] * 1.015, p[1], p[2] + 0.004 * Math.cos(th)]));
      }
      this._cord('breastCollar', collar, 0.006, M.strap, neck);
      const boss = MB.CreateSphere(`collarBoss_${this.id}`, { diameter: 0.026, segments: 12 }, this.scene);
      boss.position.set(...collar[7]); boss.position.z += 0.004; boss.scaling.z = 0.45;
      this._add(boss, neck, M.gold);

      // Head.
      const head = this._node('horseHead', neck, rel(POLL), [HEAD_PITCH, 0, 0]);
      head.scaling.setAll(HEAD_SCALE);
      this.parts.horseHead = head;
      this._surf('hHead', grid(28, 30, (u, v) => headPoint(lerp(HEAD_Z[0], HEAD_Z[1], v), u * TAU), { closed: true, capEnd: true }), M.coat, head);
      const sideX = (z, y) => {                        // head surface x at (z, y)
        const [top, bot, w] = curve(HEAD, z), cy = (top + bot) / 2, hh = (top - bot) / 2, c = clamp((y - cy) / hh, -1, 1);
        const e = c >= 0 ? 2.8 : 2.2;
        return w * Math.pow(1 - Math.pow(Math.abs(c), e), 1 / e);
      };
      [-1, 1].forEach((s) => {
        // eye, set in a soft brow
        const ex = sideX(EYE.z, EYE.y);
        const eye = MB.CreateSphere(`hEye${s}_${this.id}`, { diameter: 1, segments: 10 }, this.scene);
        eye.scaling.set(0.012, 0.017, 0.024);
        eye.position.set(s * (ex - 0.001), EYE.y, EYE.z);
        eye.rotation.y = s * 0.25;
        this._add(eye, head, M.dark);
        this._cord(`hBrow${s}`, [[s * (ex - 0.002), EYE.y + 0.012, EYE.z - 0.016], [s * (ex + 0.002), EYE.y + 0.013, EYE.z],
          [s * (ex - 0.001), EYE.y + 0.01, EYE.z + 0.015]], [[0, 0.003], [0.5, 0.0045], [1, 0.002]], M.coat, head);
        // nostril and the line of the mouth
        const nz = 0.201, ny = -0.014, nx = sideX(nz, ny);
        const nostril = MB.CreateSphere(`hNostril${s}_${this.id}`, { diameter: 1, segments: 10 }, this.scene);
        nostril.scaling.set(0.006, 0.014, 0.009);
        nostril.position.set(s * (nx - 0.002), ny, nz);
        nostril.rotation.set(0.5, s * 0.5, s * 0.3);
        this._add(nostril, head, M.dark);
        this._cord(`hMouth${s}`, [[s * 0.012, -0.038, 0.214], [s * 0.021, -0.041, 0.2], [s * 0.026, -0.045, 0.182]], 0.0018, M.dark, head);
        // ear: a cupped leaf, pricked up and a little forward
        const ear = this._node(`hEar${s}`, head, [s * 0.024, 0.02, 0.006], [-1.0, s * 0.15, -s * 0.25]);
        this._surf(`hEarLeaf${s}`, grid(8, 10, (u, v) => {
          const x = (2 * u - 1), hw = 0.018 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.12 + 0.9 * v)), 0.8) * (1 - 0.25 * v);
          return [x * hw - s * 0.004 * v * v, v * 0.062, -0.011 * (1 - x * x) * (hw / 0.018) + 0.003 * v];
        }), M.hair, ear);
      });

      // Chanfron: a steel face plate from the poll to above the nostrils,
      // cut away round the eyes, with a gold ridge, edges and a rondel.
      const CH = [0.0, 0.178];
      const halfSpan = (z) => lerp(1.2, 0.95, z / CH[1]) - 0.55 * Math.exp(-Math.pow((z - EYE.z) / 0.028, 2));
      this._surf('chanfron', grid(16, 24, (u, v) => {
        const z = lerp(CH[0], CH[1], v);
        return headPoint(z, (2 * u - 1) * halfSpan(z), 0.004 + 0.002 * Math.cos((2 * u - 1) * 1.5));
      }), M.plate, head);
      const edge = (side) => {
        const pts = [];
        for (let k = 0; k <= 16; k++) { const z = lerp(CH[0], CH[1], k / 16); pts.push(headPoint(z, side * halfSpan(z), 0.0055)); }
        return pts;
      };
      this._cord('chanfronEdgeR', edge(1), 0.0022, M.gold, head, 6);
      this._cord('chanfronEdgeL', edge(-1), 0.0022, M.gold, head, 6);
      const tip = [];
      for (let k = 0; k <= 10; k++) { const a = lerp(-1, 1, k / 10) * halfSpan(CH[1]); tip.push(headPoint(CH[1], a, 0.0055)); }
      this._cord('chanfronTip', tip, 0.0024, M.gold, head, 6);
      const ridge = [];
      for (let k = 0; k <= 10; k++) ridge.push(headPoint(lerp(0.02, CH[1] - 0.01, k / 10), 0, 0.0065));
      this._cord('chanfronRidge', ridge, [[0, 0.0025], [0.5, 0.0035], [1, 0.002]], M.gold, head, 6);
      const rondel = MB.CreateCylinder(`rondel_${this.id}`, { diameterTop: 0.004, diameterBottom: 0.026, height: 0.014, tessellation: 16 }, this.scene);
      const rp = headPoint(0.045, 0, 0.006);
      rondel.position.set(rp[0], rp[1] + 0.005, rp[2]);
      this._add(rondel, head, M.gold);
      [-1, 1].forEach((s) => {                          // flared guards over the eyes
        const pts = [];
        for (let k = 0; k <= 8; k++) {
          const z = EYE.z + lerp(-0.022, 0.022, k / 8);
          pts.push(headPoint(z, s * (halfSpan(z) + 0.02), 0.007 + 0.004 * Math.sin(Math.PI * k / 8)));
        }
        this._cord(`eyeGuard${s}`, pts, 0.0028, M.gold, head, 6);
      });

      // Bridle: headpiece, browband, cheek pieces, noseband and bit rings.
      const loop = (z, lift, a0, a1, n) => {
        const pts = [];
        for (let k = 0; k <= n; k++) pts.push(headPoint(z, lerp(a0, a1, k / n), lift));
        return pts;
      };
      this._cord('headpiece', loop(0.012, 0.007, -2.4, 2.4, 14), 0.0028, M.strap, head, 6);
      this._cord('browband', loop(0.03, 0.009, -1.45, 1.45, 10), 0.0026, M.strap, head, 6);
      this._cord('noseband', loop(0.155, 0.0075, -3.1, 3.1, 18), 0.003, M.strap, head, 6);
      [-1, 1].forEach((s) => {
        const pts = [];
        for (let k = 0; k <= 8; k++) { const z = lerp(0.012, 0.172, k / 8); pts.push(headPoint(z, s * lerp(1.7, 2.1, k / 8), 0.0075)); }
        this._cord(`cheekpiece${s}`, pts, 0.0026, M.strap, head, 6);
        const bp = headPoint(0.178, s * 2.2, 0.006);
        const ring = MB.CreateTorus(`bitRing${s}_${this.id}`, { diameter: 0.02, thickness: 0.0035, tessellation: 16 }, this.scene);
        ring.position.set(bp[0], bp[1], bp[2]);
        ring.rotation.z = Math.PI / 2;
        this._add(ring, head, M.gold);
        const bit = new BABYLON.TransformNode(`bit${s}_${this.id}`, this.scene);
        bit.parent = head; bit.position.set(bp[0] + s * 0.004, bp[1] - 0.006, bp[2]);
        (this._bits = this._bits || []).push(bit);
      });
      // Forelock falling from between the ears over the chanfron.
      for (let i = 0; i < 4; i++) {
        const x = (i - 1.5) * 0.006;
        this._surf(`forelock${i}`, sweep(5, 8, (s) => {
          const p = headPoint(lerp(0.0, 0.05 + 0.006 * i, s), x * 8, 0.009 + 0.005 * Math.sin(Math.PI * s));
          return [p[0] + x, p[1], p[2]];
        }, (s, a) => [(0.007 * (1 - 0.7 * s) + 0.001) * Math.cos(a), 0.0022 * Math.sin(a)], { side: [1, 0, 0], capStart: true, capEnd: true }), M.hair, head);
      }
    }

    _buildSaddle(mount, M) {
      const zc = RIDER_AT[2];
      // seat pad on the cloth
      this._surf('saddleSeat', grid(14, 12, (u, v) => {
        const x = lerp(-0.105, 0.105, u), z = lerp(zc - 0.1, zc + 0.095, v);
        const dip = 0.01 * Math.cos(Math.PI * (v - 0.5));
        return [x, backHeight(x, z) + CLOTH.lift + 0.012 - 0.004 * dip, z];
      }), M.saddle, mount);
      // cantle (curved back-rest) and pommel arch, both rimmed in gold
      const wall = (name, zAt, rad, h, lean, span) => {
        const pt = (u, v) => {
          const a = (2 * u - 1) * span, x = rad * 1.1 * Math.sin(a), z = zAt + rad * Math.cos(a) * 0.55 * Math.sign(zAt - zc);
          const y0 = backHeight(x, z) + CLOTH.lift + 0.008;
          return [x, y0 + v * h * (1 - 0.45 * (2 * u - 1) * (2 * u - 1)), z + lean * v];
        };
        this._surf(name, grid(16, 5, pt), M.saddle, mount);
        const rim = [];
        for (let k = 0; k <= 16; k++) rim.push(pt(k / 16, 1));
        this._cord(`${name}Rim`, rim, 0.0045, M.gold, mount, 6);
      };
      wall('cantle', zc - 0.085, 0.085, 0.07, -0.03, 1.15);
      wall('pommel', zc + 0.1, 0.06, 0.045, 0.02, 1.0);
      // girth strap and saddle flaps
      [-1, 1].forEach((s) => {
        this._surf(`saddleFlap${s}`, grid(6, 8, (u, v) => {
          const z = lerp(zc - 0.075, zc + 0.06, u), p = this._clothAt(s > 0 ? Math.PI / 2 + (zc - z) * 3 : -Math.PI / 2 - (zc - z) * 3, lerp(0.54, 0.42, v));
          return [p[0] + s * 0.004, p[1], z];
        }), M.saddle, mount);
      });
    }

    _buildRider(mount, M) {
      const rider = this._node('rider', mount, RIDER_AT);
      this.parts.rider = rider;
      const plate = M.plate, gold = M.gold, dark = M.dark;

      // cuirass: globular breastplate and backplate with a median ridge
      this._surf('cuirass', grid(32, 16, (u, v) => torsoPoint(u * TAU, lerp(0.248, 0.0, v)), { closed: true }), plate, rider);
      this._cord('neckTrim', Array.from({ length: 25 }, (_, k) => torsoPoint(k / 24 * TAU, 0.232, 0.002)), 0.003, gold, rider, 6);
      this._cord('waistBelt', Array.from({ length: 25 }, (_, k) => torsoPoint(k / 24 * TAU, 0.088, 0.004)), 0.005, gold, rider, 6);
      // fauld: three flaring lames over the hips, each edged in gold
      for (let k = 0; k < 3; k++) {
        const yT = 0.078 - 0.026 * k, yB = yT - 0.032, g = 1.04 + 0.07 * k;
        const ring = (a, v) => {
          const p = torsoPoint(a, 0.06), sc = g + 0.12 * v;
          return [p[0] * sc, lerp(yT, yB, v), p[2] * sc];
        };
        this._surf(`fauld${k}`, grid(28, 3, (u, v) => ring(u * TAU, v), { closed: true }), plate, rider);
        this._cord(`fauldEdge${k}`, Array.from({ length: 29 }, (_, i) => ring(i / 28 * TAU, 1)), 0.0022, gold, rider, 5);
      }
      // gorget
      [0, 1].forEach((k) => {
        this._surf(`gorget${k}`, grid(20, 2, (u, v) => {
          const a = u * TAU, r = 0.052 - 0.006 * k - 0.004 * v;
          return [r * Math.sin(a), 0.232 + 0.02 * k + 0.018 * v, r * 0.95 * Math.cos(a)];
        }, { closed: true }), plate, rider);
      });

      // legs: cuisse, poleyn with a fan plate, greave and pointed sabaton in a stirrup
      [-1, 1].forEach((s) => {
        const hip = [s * 0.062, 0.03, 0.012], knee = [s * 0.168, -0.058, 0.098], ankle = [s * 0.18, -0.2, 0.058], toe = [s * 0.184, -0.216, 0.142];
        this._cord(`cuisse${s}`, [hip, [s * 0.12, 0.0, 0.07], knee], [[0, 0.041], [0.6, 0.036], [1, 0.03]], plate, rider, 14);
        this._cord(`greave${s}`, [knee, [s * 0.176, -0.13, 0.08], ankle], [[0, 0.029], [0.35, 0.03], [1, 0.021]], plate, rider, 14);
        this._cop(`poleyn${s}`, hip, knee, ankle, 0.036, plate, rider);
        this._leaf(`poleynWing${s}`, [knee[0] + s * 0.03, knee[1] + 0.004, knee[2] - 0.006], [0, 1, 0.15], [0, -0.15, 1], [s, 0, 0],
          0.058, 0.05, 0.01, plate, gold, rider);
        this._cord(`sabaton${s}`, [ankle, [s * 0.182, -0.21, 0.09], toe], [[0, 0.022], [0.55, 0.02], [0.85, 0.012], [1, 0.003]], plate, rider, 10);
        // stirrup and its leather
        this._cord(`stirrupLeather${s}`, [[s * 0.128, 0.0, -0.005], [s * 0.168, -0.12, 0.03], [s * 0.19, -0.22, 0.08]], 0.0035, M.saddle, rider, 5);
        const st = MB.CreateTorus(`stirrup${s}_${this.id}`, { diameter: 0.048, thickness: 0.006, tessellation: 18 }, this.scene);
        st.position.set(s * 0.188, -0.224, 0.09); st.rotation.set(Math.PI / 2, 0, 0); st.scaling.set(1, 1, 0.8);
        this._add(st, rider, gold);
      });

      // helm: an armet with a keeled visor, eye slit, breaths and a red plume
      const helm = this._node('head', rider, HELM_AT);
      this.parts.head = helm;
      this._surf('helm', grid(48, 26, (u, v) => helmPoint(u * TAU, v * 2.5), { closed: true, capEnd: true }), plate, helm);
      this._surf('eyeSlit', grid(24, 2, (u, v) => helmPoint(lerp(-1.1, 1.1, u), lerp(1.2, 1.255, v), 0.0012)), dark, helm);
      [0, 1, 2].forEach((k) => {
        this._surf(`breaths${k}`, grid(6, 1, (u, v) => helmPoint(lerp(0.55, 0.95, u), 1.72 + 0.1 * k + 0.018 * v, 0.0012)), dark, helm);
      });
      this._cord('visorTrim', Array.from({ length: 21 }, (_, k) => helmPoint(lerp(-1.45, 1.45, k / 20), 1.3, 0.0015)), 0.0022, gold, helm, 5);
      [-1, 1].forEach((s) => {
        const p = helmPoint(s * Math.PI / 2, 1.28, 0.002);
        const rivet = MB.CreateSphere(`visorPivot${s}_${this.id}`, { diameter: 0.013, segments: 8 }, this.scene);
        rivet.position.set(p[0], p[1], p[2]); rivet.scaling.x = 0.5;
        this._add(rivet, helm, gold);
      });
      const plume = this._node('plume', helm, [0, 0.05, -0.034], [-0.35, 0, 0]);
      this.parts.plume = plume;
      this._cord('plumeHolder', [[0, -0.012, 0.004], [0, 0.012, 0]], [[0, 0.007], [1, 0.005]], gold, plume, 8);
      for (let i = 0; i < 9; i++) {
        const f = i / 8 - 0.5, h = 1 - Math.abs(f) * 0.6;
        const ctrl = [[f * 0.01, 0.008, 0], [f * 0.035, 0.08 * h, 0.01], [f * 0.06, 0.1 * h, -0.1], [f * 0.075, 0.02 * h, -0.19], [f * 0.07, -0.06, -0.2]];
        this._surf(`feather${i}`, sweep(6, 16, (t) => bezier(ctrl, t), (t, a) => {
          const w = (0.018 + 0.01 * h) * Math.pow(Math.sin(Math.PI * (0.12 + 0.88 * t)), 0.6) * (1 + 0.18 * Math.sin(t * 38 + i));
          return [w * Math.cos(a), 0.005 * Math.sin(a)];
        }, { side: [1, 0, 0], capStart: true, capEnd: true }), M.plume, plume);
      }

      // arms: pauldrons, rerebraces, couters, vambraces and gauntlets
      const makeArm = (side, elbow, hand) => {
        const s = side === 'R' ? 1 : -1;
        const arm = this._node(`arm${side}`, rider, [s * 0.112, 0.205, 0]);
        const ax = V3(s * 0.55, 1, 0).normalize(), f1 = V3(0, 0, 1), f2 = BABYLON.Vector3.Cross(ax, f1);
        [[0, 1.0, 0.052], [0.9, 1.32, 0.056], [1.22, 1.66, 0.059]].forEach(([p0, p1, R], k) => {
          const pt = (u, v) => {
            const p = lerp(p0, p1, v), a = u * TAU, r = R * (1 + 0.07 * v * (k ? 1 : smoothstep(0.7, 1, v)));
            const d = ax.scale(Math.cos(p)).add(f1.scale(Math.cos(a) * Math.sin(p))).add(f2.scale(Math.sin(a) * Math.sin(p)));
            return [s * 0.006 + d.x * r, d.y * r, d.z * r];
          };
          this._surf(`pauldron${side}${k}`, grid(24, k ? 3 : 8, pt, { closed: true }), plate, arm);
          this._cord(`pauldronEdge${side}${k}`, Array.from({ length: 25 }, (_, i) => pt(i / 24, 1)), 0.0022, gold, arm, 5);
        });
        this._cord(`rerebrace${side}`, [[s * 0.004, -0.01, 0], elbow], [[0, 0.029], [1, 0.025]], plate, arm, 12);
        this._cop(`couter${side}`, [0, 0, 0], elbow, hand, 0.031, plate, arm);
        this._leaf(`couterWing${side}`, [elbow[0] + s * 0.026, elbow[1], elbow[2] - 0.008], [0, 1, 0.2], [0, -0.2, 1], [s, 0, 0],
          0.052, 0.046, 0.009, plate, gold, arm);
        const dir = V3(...hand).subtract(V3(...elbow)).normalize();
        const wrist = V3(...hand).subtract(dir.scale(0.03));
        this._cord(`vambrace${side}`, [elbow, [wrist.x, wrist.y, wrist.z]], [[0, 0.024], [1, 0.02]], plate, arm, 12);
        const cuffEnd = wrist.add(dir.scale(0.012)), cuffStart = wrist.subtract(dir.scale(0.022));
        this._surf(`cuff${side}`, sweep(14, 4, (t) => { const p = BABYLON.Vector3.Lerp(cuffStart, cuffEnd, t); return [p.x, p.y, p.z]; },
          (t, a) => { const r = lerp(0.021, 0.031, t); return [r * Math.cos(a), r * Math.sin(a)]; }), plate, arm);
        // gauntlet: a mitten of lames closed round the grip, fingers curled under
        const fingers = V3(...hand).add(dir.scale(0.018)).add(V3(0, -0.012, 0));
        this._surf(`gauntlet${side}`, sweep(12, 10, (t) => bezier([[wrist.x, wrist.y, wrist.z], hand, [fingers.x, fingers.y, fingers.z]], t),
          (t, a) => {
            const r = 1 - 0.35 * t * t;
            const c = Math.cos(a), sn = Math.sin(a), p = 2 / 3;
            return [0.019 * r * spow(c, p), 0.023 * r * spow(sn, p)];
          }, { side: [1, 0, 0], capStart: true, capEnd: true }), plate, arm);
        this._cord(`knuckles${side}`, [[hand[0] - 0.017, hand[1] - 0.004, hand[2] + 0.018], [hand[0], hand[1] - 0.002, hand[2] + 0.024],
          [hand[0] + 0.017, hand[1] - 0.004, hand[2] + 0.018]], 0.0035, gold, arm, 6);
        return arm;
      };
      const handR = [0.02, -0.125, 0.082];
      this.parts.armR = makeArm('R', [0.03, -0.1, -0.024], handR);
      const handL = [0.07, -0.118, 0.098];
      this.parts.armL = makeArm('L', [-0.018, -0.1, -0.006], handL);
      this._handL = new BABYLON.TransformNode(`reinHand_${this.id}`, this.scene);
      this._handL.parent = this.parts.armL; this._handL.position.set(handL[0] + 0.004, handL[1] - 0.012, handL[2] + 0.004);

      this._buildLance(handR, M);
    }

    _buildLance(hand, M) {
      const lance = this._node('weapon', this.parts.armR, hand, [LANCE.carry[0], 0, LANCE.carry[1]]);
      this.parts.weapon = lance;
      const len = LANCE.len;
      const SHAFT = [[-0.3, 0.0105], [-0.12, 0.0135], [-0.02, 0.012], [0.03, 0.016], [0.12, 0.019], [0.3, 0.016], [0.5, 0.012], [len - 0.06, 0.008]];
      this._surf('lanceShaft', sweep(12, 30, (t) => [0, lerp(-0.3, len - 0.06, t), 0], (t, a) => {
        const r = curve(SHAFT, lerp(-0.3, len - 0.06, t))[0];
        return [r * Math.cos(a), r * Math.sin(a)];
      }, { side: [1, 0, 0], capStart: true, capEnd: true }), M.lance, lance);
      // vamplate: a steel cone guarding the hand
      this._surf('vamplate', grid(24, 4, (u, v) => {
        const a = u * TAU, r = lerp(0.017, 0.05, Math.pow(v, 0.8));
        return [r * Math.sin(a), lerp(0.03, 0.115, v), r * Math.cos(a)];
      }, { closed: true }), M.plate, lance);
      this._cord('vamplateRim', Array.from({ length: 25 }, (_, k) => [0.05 * Math.sin(k / 24 * TAU), 0.115, 0.05 * Math.cos(k / 24 * TAU)]), 0.0028, M.gold, lance, 5);
      // socket collar and lozenge-section head
      this._cord('lanceCollar', [[0, len - 0.075, 0], [0, len - 0.05, 0]], [[0, 0.0105], [1, 0.0095]], M.gold, lance, 10);
      this._surf('lanceHead', sweep(4, 10, (t) => [0, lerp(len - 0.055, len + 0.035, t), 0], (t, a) => {
        const r = 0.014 * Math.sin(Math.PI * Math.min(1, 0.25 + t * 0.9)) * (1 - t * 0.2);
        return [r * Math.cos(a), r * 0.45 * Math.sin(a)];
      }, { side: [1, 0, 0], capStart: true, capEnd: true }), M.plate, lance);
      this._cord('lanceButt', [[0, -0.31, 0], [0, -0.27, 0]], [[0, 0.011], [1, 0.012]], M.plate, lance, 10);
      const tip = new BABYLON.TransformNode(`lanceTip_${this.id}`, this.scene);
      tip.parent = lance; tip.position.y = len + 0.035;
      this.parts.lanceTip = tip;
    }

    // Reins run from the bit rings to the left gauntlet; rebuilt every frame
    // (their own node, so they are never merged) to follow the head and hand.
    _buildReins(mount, M) {
      const node = new BABYLON.TransformNode(`reins_${this.id}`, this.scene);
      node.parent = mount;
      this._reins = { node, meshes: [] };
      (this._bits || []).forEach((bit, i) => {
        const mesh = MB.CreateTube(`rein${i}_${this.id}`, { path: this._reinPath(bit), radius: 0.0032, tessellation: 6, updatable: true }, this.scene);
        this._add(mesh, node, M.rein);
        this._reins.meshes.push(mesh);
      });
    }

    _reinPath(bit) {
      const node = this._reins.node;
      node.computeWorldMatrix(true);
      const inv = node.getWorldMatrix().clone().invert();
      const a = BABYLON.Vector3.TransformCoordinates(bit.getAbsolutePosition(), inv);
      const b = BABYLON.Vector3.TransformCoordinates(this._handL.getAbsolutePosition(), inv);
      const mid = a.add(b).scale(0.5);
      mid.y -= 0.045;
      const path = [];
      for (let k = 0; k <= 9; k++) {
        const t = k / 9;
        path.push(a.scale((1 - t) * (1 - t)).add(mid.scale(2 * t * (1 - t))).add(b.scale(t * t)));
      }
      return path;
    }

    _updateReins() {
      if (!this._reins || !this.alive) return;
      (this._bits || []).forEach((bit, i) => {
        MB.CreateTube(null, { path: this._reinPath(bit), radius: 0.0032, instance: this._reins.meshes[i] });
      });
    }

    // ---------------------------------------------------------- animation
    _applyLegs(pose) {
      this.parts.hLegs.forEach((l, i) => {
        l.upper.rotation.x = pose[i][0]; l.lower.rotation.x = pose[i][1]; l.fet.rotation.x = pose[i][2];
      });
    }
    _readLegs() { return this.parts.hLegs.map((l) => [l.upper.rotation.x, l.lower.rotation.x, l.fet.rotation.x]); }
    static _mixPose(a, b, t) { return a.map((leg, i) => leg.map((x, k) => lerp(x, b[i][k], t))); }

    _legsTo(pose, ms, ease) {
      const from = this._readLegs(), to = pose || this.parts.hLegs.map((l) => l.rest);
      return Tween.run(ms, (t) => this._applyLegs(KnightCharacter._mixPose(from, to, t)), ease || Ease.inOutCubic);
    }

    _gaitPose(gait, p) {
      const G = GAIT[gait];
      return LEGS.map((spec, i) => strideAngles(spec.fore, ((p + G.phase[i]) % 1 + 1) % 1, G.duty, G.amp));
    }

    // Pitch the whole mount about a point on the ground (z) so the hooves
    // there stay planted.
    _pitch(angle, pivotZ) {
      const T = this.parts.torso, py = Config.BOARD_Y + 0.075;
      T.rotation.x = angle;
      const c = Math.cos(angle), s = Math.sin(angle);
      T.position.y = py - (py * c - pivotZ * s);
      T.position.z = pivotZ - (py * s + pivotZ * c);
    }

    updateIdle(t) {
      if (this.busy) return;
      const P = this.parts, ph = this.idlePhase;
      this.visual.position.y = this.selectLift + Math.sin(t * 1.4 + ph) * 0.004;
      P.neck.rotation.x = Math.sin(t * 1.1 + ph) * 0.025;
      P.horseHead.rotation.x = HEAD_PITCH + Math.sin(t * 1.7 + ph) * 0.04;
      P.tail.rotation.z = Math.sin(t * 1.3 + ph) * 0.1;
      P.tail.rotation.x = 0.04 * Math.sin(t * 0.8 + ph);
      P.plume.rotation.z = Math.sin(t * 2.1 + ph) * 0.05;
      P.head.rotation.y = Math.sin(t * 0.5 + ph) * 0.12;
      // The raised fore hoof paws the air now and then.
      const paw = Math.pow(Math.max(0, Math.sin(t * 1.2 + ph)), 3);
      const fr = P.hLegs[0];
      fr.upper.rotation.x = fr.rest[0] - 0.14 * paw;
      fr.lower.rotation.x = fr.rest[1] + 0.25 * paw;
      fr.fet.rotation.x = fr.rest[2] + 0.2 * paw;
    }

    setWalking(on) {
      if (on) {
        if (this._walkObserver) return;
        const t0 = performance.now();
        const from = this._readLegs();
        this._walkObserver = this.scene.onBeforeRenderObservable.add(() => {
          const t = (performance.now() - t0) / 1000, p = t * GAIT.trot.hz * Tween.speed;
          const w = smoothstep(0, 0.18, t);
          this._applyLegs(KnightCharacter._mixPose(from, this._gaitPose('trot', p), w));
          this.visual.position.y = this.selectLift + Math.abs(Math.sin(p * TAU)) * 0.02 * w;
          this.parts.neck.rotation.x = Math.sin(p * TAU * 2) * 0.04 * w;
          this.parts.tail.rotation.x = 0.25 * w;
        });
      } else if (this._walkObserver) {
        this.scene.onBeforeRenderObservable.remove(this._walkObserver);
        this._walkObserver = null;
        this._legsTo(null, 200);
        const y0 = this.visual.position.y, tx = this.parts.tail.rotation.x;
        Tween.run(200, (t) => {
          this.visual.position.y = lerp(y0, this.selectLift, t);
          this.parts.tail.rotation.x = tx * (1 - t);
        });
      }
    }

    // A chess move is a leap: legs tucked like a show jumper over a fence.
    async moveTo(pos, style, opts) {
      // Skip ProceduralCharacter.moveTo: it drives the old two-joint horse legs.
      const baseMove = window.Chess3D.CharacterBase.prototype.moveTo;
      if (style !== 'leap') return baseMove.call(this, pos, style, opts);
      this._legsTo(POSE.jump, TIMING.turn + 150);
      await baseMove.call(this, pos, style, opts);
      await this._legsTo(null, 180);
    }

    playAttack(targetPos) { return this.playCharge(targetPos); }

    // Pose of the last frame of the charge (lance driven home), shared by
    // playCharge and _strikeReach. k = thrust amount, p = gallop phase.
    _strikePose(k, p, couchZ, armX0) {
      const P = this.parts;
      this._pitch(0.07 * Math.sin(TAU * (p + 0.15)), 0);
      this.visual.position.z = 0.06 * k;
      P.armR.rotation.x = armX0 - 0.3 * k;
      P.weapon.rotation.x = LANCE.couch[0] + 0.42 * k;
      P.weapon.rotation.z = couchZ;
      P.rider.rotation.x = 0.14 * k;
    }

    // Where the lance tip ends up at impact, relative to the root:
    // { fwd, lat } along the charge direction and to its right. Poses the
    // model into the strike for a moment and puts everything back.
    _strikeReach(dir, p, couchZ, armX0) {
      const P = this.parts, T = P.torso, lance = P.weapon;
      const saved = [T.rotation.x, T.position.y, T.position.z, this.visual.position.z, P.armR.rotation.x, lance.rotation.x, lance.rotation.z, P.rider.rotation.x];
      const chain = [];
      for (let n = P.lanceTip; n; n = n.parent) chain.unshift(n);
      this._strikePose(1, p, couchZ, armX0);
      chain.forEach((n) => n.computeWorldMatrix(true));
      const rel = P.lanceTip.getAbsolutePosition().subtract(this.root.position);
      [T.rotation.x, T.position.y, T.position.z, this.visual.position.z, P.armR.rotation.x, lance.rotation.x, lance.rotation.z, P.rider.rotation.x] = saved;
      chain.forEach((n) => n.computeWorldMatrix(true));
      return { fwd: rel.x * dir.x + rel.z * dir.z, lat: rel.x * dir.z - rel.z * dir.x };
    }

    // Charge: gather on the haunches while couching the lance, gallop flat
    // out from where it stands straight at the victim and drive the lance
    // in. Resolves at impact; the horse stops a lance's length short of the
    // victim (pieces on the squares beside an L-move sit clear of its path).
    async playCharge(victimPos) {
      this.busy = true;
      const P = this.parts, root = this.root, lance = P.weapon, arm = P.armR;
      await this.faceTowards(victimPos, TIMING.turn);

      const from = root.position.clone();
      let dir = victimPos.subtract(from);
      dir.y = 0;
      const total = dir.length();
      dir = total > 1e-6 ? dir.scale(1 / total) : V3(0, 0, 1);
      // Aim: swing the couched lance across the horse's neck until its tip
      // lines up with the victim, then stop where it reaches just inside it.
      const armX0 = arm.rotation.x;
      const strides = Math.max(1.4, Math.max(0, total - 0.9) / 0.5);
      let couchZ = LANCE.couch[1], hit;
      for (let i = 0; i < 3; i++) {
        hit = this._strikeReach(dir, strides, couchZ, armX0);
        couchZ += Math.atan2(hit.lat, hit.fwd);
      }
      const run = Math.max(0, total - hit.fwd - CHARGE.bite);
      const ms = Math.max(CHARGE.min, run * CHARGE.perUnit);

      // 1. gather ("lấy đà"): weight back, forehand light, lance lowered
      const l0 = lance.rotation.clone();
      this._legsTo(POSE.gather, CHARGE.gather, Ease.outCubic);
      await Tween.run(CHARGE.gather, (t) => {
        this._pitch(-0.2 * t, -0.2);
        this.visual.position.z = -0.05 * t;
        lance.rotation.x = lerp(l0.x, LANCE.couch[0], t);
        lance.rotation.z = lerp(l0.z, couchZ, t);
        P.neck.rotation.x = -0.14 * t;
        P.tail.rotation.x = 0.3 * t;
        P.rider.rotation.x = -0.08 * t;
      }, Ease.inOutCubic);

      // 2. charge: accelerate from the square at a flat-out gallop
      const gathered = this._readLegs();
      await Tween.run(ms, (_, raw) => {
        const s = Math.pow(raw, 1.55);
        root.position.x = from.x + dir.x * run * s;
        root.position.z = from.z + dir.z * run * s;
        const p = strides * raw, w = smoothstep(0, 0.18, raw);
        this._applyLegs(KnightCharacter._mixPose(gathered, this._gaitPose('gallop', p), w));
        this.visual.position.y = this.selectLift + 0.022 * (1 + Math.sin(TAU * (p - 0.1))) * w;
        P.neck.rotation.x = lerp(-0.14, 0.07 * Math.sin(TAU * p + 1), w);
        // 3. thrust over the last stretch: rider leans in, arm drives the lance
        const k = smoothstep(0.78, 1, raw);
        this._strikePose(k, p, couchZ, armX0);
        this._pitch(lerp(-0.2, 0.07 * Math.sin(TAU * (p + 0.15)), w), 0);
        this.visual.position.z = lerp(-0.05, 0, w) + 0.06 * k;
        P.rider.rotation.x = lerp(-0.08, 0.14, Math.max(w * 0.5, k));
      }, Ease.linear);
    }

    async playRecover() {
      const P = this.parts, T = P.torso, lance = P.weapon;
      const pose = this._pose;
      const s = {
        rx: T.rotation.x, py: T.position.y, pz: T.position.z, vz: this.visual.position.z, vx: this.visual.rotation.x,
        rider: P.rider.rotation.x, neck: P.neck.rotation.x, tail: P.tail.rotation.x,
        armR: P.armR.rotation.clone(), armL: P.armL.rotation.clone(), lance: lance.rotation.clone()
      };
      const ms = TIMING.attackRecover + 160;
      const legs = this._legsTo(null, ms, Ease.outCubic);
      await Tween.run(ms, (t) => {
        T.rotation.x = s.rx * (1 - t); T.position.y = s.py * (1 - t); T.position.z = s.pz * (1 - t);
        this.visual.position.z = s.vz * (1 - t); this.visual.rotation.x = s.vx * (1 - t);
        P.rider.rotation.x = s.rider * (1 - t); P.neck.rotation.x = s.neck * (1 - t); P.tail.rotation.x = s.tail * (1 - t);
        P.armR.rotation = BABYLON.Vector3.Lerp(s.armR, pose.armR, t);
        P.armL.rotation = BABYLON.Vector3.Lerp(s.armL, pose.armL, t);
        lance.rotation = BABYLON.Vector3.Lerp(s.lance, pose.weapon, t);
      }, Ease.outCubic);
      await legs;
      this.busy = false;
    }

    async playVictory() {
      // The horse rears twice in a levade, the lance raised high.
      const P = this.parts, lance = P.weapon, l0 = lance.rotation.x;
      for (let i = 0; i < 2; i++) {
        this._legsTo(POSE.rear, 260, Ease.outCubic);
        await Tween.run(260, (t) => { this._pitch(-0.42 * t, -0.2); lance.rotation.x = l0 - 0.4 * t; P.neck.rotation.x = -0.15 * t; }, Ease.outCubic);
        this._legsTo(null, 260, Ease.inCubic);
        await Tween.run(260, (t) => { this._pitch(-0.42 * (1 - t), -0.2); lance.rotation.x = l0 - 0.4 * (1 - t); P.neck.rotation.x = -0.15 * (1 - t); }, Ease.inCubic);
      }
    }

    async playDeath() {
      // The horse buckles and rolls onto its side, legs folding.
      this.busy = true;
      this.setFlash(0.8);
      const baseY = this.visual.position.y;
      this._legsTo(POSE.fallen, TIMING.death, Ease.inCubic);
      await Tween.run(TIMING.death, (t) => {
        this.visual.rotation.z = -1.35 * t;
        this.visual.position.y = baseY - 0.02 * t;
        this.parts.neck.rotation.x = 0.35 * t;
      }, Ease.inCubic);
    }
  }

  window.Chess3D.KnightCharacter = KnightCharacter;
})();
