// QueenCharacter: the queen piece ('q'), a sorceress queen after the painted
// reference — a sculpted face with lidded eyes and lashes, long wind-swept
// hair under a tall sunburst crown, a lace Medici collar opening into a deep
// V, a damask gown with a gold-embroidered bodice, puffed upper sleeves over
// long hanging over-sleeves, and articulated hands: the right rests on her
// waist, the left holds a jewelled gold scepter whose crystal orb sparkles.
// Everything is built from parametric surfaces (lofts and swept tubes).
//  - She flies when she moves: rises inside a magic aura and glides slowly.
//  - Attack: levitates, eyes and scepter blaze, she points the scepter at the
//    target and calls down a meteor shower while four volcanoes erupt around it.
//  - Death: she turns into the shadow of a black dragon that flies away.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const ProceduralCharacter = window.Chess3D.ProceduralCharacter;
  const { TAU, hex, V3, lerp, clamp, smoothstep, spow, curve, bezier, grid, sweep } = window.Chess3D.SurfaceKit;
  const Vec = BABYLON.Vector3, Q = BABYLON.Quaternion, M4 = BABYLON.Matrix, C3 = BABYLON.Color3;
  const gauss = (dx, dy, sx, sy) => Math.exp(-(dx * dx) / (sx * sx) - (dy * dy) / (sy * sy));

  // ------------------------------------------------------------ livery
  // White side: royal-blue gown and ivory lace, chestnut hair, blue magic.
  // Dark side: wine-black gown and black lace, raven hair, ember magic.
  // Gold comes from the team accent.
  const LIVERY = {
    w: { gown: '#1f3a7d', gownHi: '#4a6cc0', gownLo: '#0b1735', lining: '#8fb0ee', lace: '#f4efe4', skin: '#f3d5c3', blush: '#e0928a',
      lips: '#b33e4c', hair: '#8b5a31', hairHi: '#d8a86a', hairLo: '#3f2412', brow: '#6a4428', iris: '#3d78a8', lid: '#a87868',
      gem: '#5fd0ff', orb: '#a8ecff', eyeGlow: '#bff2ff' },
    b: { gown: '#3e0c1d', gownHi: '#7a2040', gownLo: '#150309', lining: '#c23a55', lace: '#2c262e', skin: '#efcdb8', blush: '#d68078',
      lips: '#8a1c30', hair: '#1d1512', hairHi: '#5a4538', hairLo: '#070404', brow: '#150e0b', iris: '#7a2a18', lid: '#6e4048',
      gem: '#ff5a3d', orb: '#ffb07a', eyeGlow: '#ffd08a' }
  };

  // ------------------------------------------------------------ body
  // Torso-space units (the board square is 1). Torso keys [y, rx, rzFront,
  // rzBack]; sections are superellipses. Bust added as two soft bumps.
  const TORSO = [[0.575, 0.056, 0.043, 0.045], [0.6, 0.055, 0.042, 0.044], [0.64, 0.059, 0.045, 0.045], [0.68, 0.066, 0.05, 0.046],
    [0.72, 0.074, 0.054, 0.048], [0.755, 0.084, 0.052, 0.05], [0.782, 0.09, 0.046, 0.048], [0.803, 0.074, 0.038, 0.04],
    [0.822, 0.048, 0.031, 0.032], [0.842, 0.027, 0.025, 0.025]];
  function torsoPoint(th, y, lift) {
    const [rx, rzF, rzB] = curve(TORSO, y), s = Math.sin(th), c = Math.cos(th), p = 2 / 2.3, l = lift || 0;
    const x = rx * spow(s, p);
    const bust = 0.019 * (gauss(x - 0.037, y - 0.712, 0.028, 0.03) + gauss(x + 0.037, y - 0.712, 0.028, 0.03)) * smoothstep(0, 0.6, c);
    return [(rx + l) * spow(s, p), y, ((c >= 0 ? rzF : rzB) + l) * spow(c, p) + bust];
  }
  // Bodice top edge: a deep V at the front, level over the shoulders and back.
  function neckY(th) {
    const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
    return lerp(0.7, 0.81, smoothstep(0.03, 1.0, a)) + 0.006 * smoothstep(1.3, 2.4, a);
  }
  // Skirt keys [y, r]: fitted at the waist, a full bell to the floor with a
  // short train behind; folds deepen toward the hem.
  const SKIRT = [[0.077, 0.25], [0.1, 0.236], [0.16, 0.207], [0.24, 0.176], [0.33, 0.146], [0.42, 0.119], [0.5, 0.095], [0.56, 0.074],
    [0.612, 0.058]];
  const WAIST = 0.612;
  function hemY(th) { return 0.079 + 0.004 * (1 + Math.sin(9 * th + 0.5)); }
  function skirtPoint(th, y, lift) {
    const [r] = curve(SKIRT, y), s = Math.sin(th), c = Math.cos(th), l = lift || 0;
    const low = smoothstep(0.52, 0.1, y), back = Math.max(0, -c);
    const fold = 1 + 0.07 * low * (0.6 * Math.sin(7 * th + 0.4) + 0.4 * Math.sin(12 * th + 1.7));
    const rz = r * lerp(0.77, 0.95, smoothstep(0.61, 0.36, y)) * (1 + 0.5 * back * back * smoothstep(0.34, 0.08, y));
    return [(r * fold + l) * s, y, (rz * fold + l) * c];
  }
  function skirtAt(th, v, lift) { return skirtPoint(th, lerp(WAIST, hemY(th), Math.pow(v, 0.92)), lift); }

  // Arms: shoulder joints, bone lengths.
  const SHOULDER = { R: [0.086, 0.772, -0.004], L: [-0.086, 0.772, -0.004] };
  const L1 = 0.165, L2 = 0.148;

  // ------------------------------------------------------------ head
  // Head rig: normalised units (chin to crown ~1), origin between the eyes,
  // scaled by K into place. Keys [y, half width, front depth, back depth].
  const HEAD_AT = [0, 0.924, 0.006], K = 0.125;
  const EYE_X = 0.132, EYE_Y = -0.004, EYE_R = 0.055;
  // A soft oval: full cheeks, a tapering jaw and a small pointed chin.
  const HEAD = [[-0.66, 0.16, 0.14, 0.16], [-0.57, 0.163, 0.165, 0.168], [-0.5, 0.17, 0.24, 0.18], [-0.42, 0.212, 0.295, 0.21],
    [-0.33, 0.246, 0.33, 0.26], [-0.24, 0.283, 0.345, 0.32], [-0.14, 0.315, 0.35, 0.38], [-0.04, 0.33, 0.35, 0.43],
    [0.06, 0.336, 0.356, 0.455], [0.16, 0.332, 0.352, 0.466], [0.26, 0.31, 0.326, 0.452], [0.36, 0.264, 0.27, 0.392],
    [0.45, 0.18, 0.18, 0.28], [0.52, 0, 0, 0]];
  // Feminine relief on the face: a soft brow, almond eye openings, a fine
  // straight nose with a rounded tip, apple cheeks, full lips with a cupid's
  // bow and a soft rounded chin.
  let carve = 1;          // 0 while measuring the uncarved face (to seat the eyes)
  function faceRelief(x, y) {
    const ax = Math.abs(x);
    // almond-shaped eye openings, outer corners lifted
    const ex = ax - EYE_X, ey = y - EYE_Y - 0.12 * ex;
    const almond = carve * Math.exp(-Math.pow(Math.pow(ex / 0.074, 2) + Math.pow(ey / (0.034 - 0.1 * ex * ex / 0.074), 2), 2));
    // nose: a narrow bridge rising to a small rounded tip
    const t = clamp((0.0 - y) / 0.19, 0, 1);
    let nose = y >= -0.18 ? 0.006 + 0.07 * Math.pow(t, 1.8) : 0.076 * Math.exp(-Math.pow((y + 0.18) / 0.03, 2));
    if (y > 0) nose *= Math.exp(-Math.pow(y / 0.04, 2));
    const nw = 0.024 + 0.022 * t;
    const tip = 0.014 * gauss(x, y + 0.165, 0.028, 0.026);
    const bow = 0.004 * (gauss(ax - 0.022, y + 0.245, 0.018, 0.01) - gauss(x, y + 0.25, 0.01, 0.01));    // cupid's bow
    return nose * Math.exp(-(x * x) / (nw * nw)) + tip
      + 0.011 * gauss(ax - 0.036, y + 0.185, 0.02, 0.016)      // nostril wings
      - 0.028 * gauss(ax - EYE_X, y - EYE_Y, 0.08, 0.05)       // eye sockets
      - 0.075 * almond
      + 0.012 * gauss(ax - 0.12, y - 0.1, 0.12, 0.035)         // soft brow
      + 0.026 * gauss(ax - 0.17, y + 0.15, 0.08, 0.08)         // apple of the cheek
      + 0.012 * gauss(ax - 0.23, y + 0.06, 0.06, 0.05)         // cheekbone
      - 0.006 * gauss(x, y + 0.225, 0.014, 0.02)               // philtrum
      + 0.022 * gauss(x, y + 0.258, 0.078, 0.02) + bow         // upper lip
      + 0.03 * gauss(x, y + 0.315, 0.068, 0.026)               // lower lip
      - 0.014 * gauss(x, y + 0.284, 0.09, 0.006)               // parting line
      - 0.006 * gauss(ax - 0.088, y + 0.285, 0.012, 0.012)     // mouth corners
      - 0.01 * gauss(x, y + 0.365, 0.06, 0.015)                // under the lower lip
      + 0.022 * gauss(x, y + 0.44, 0.07, 0.045);               // chin
  }
  function headPoint(th, y, lift) {
    const [w, df, db] = curve(HEAD, y).map((k) => Math.max(0, k));
    const s = Math.sin(th), c = Math.cos(th), n = 2 + 0.25 * Math.max(0, c);
    const x = w * spow(s, 2 / n);
    const z = (c >= 0 ? df : db) * spow(c, 2 / n) + faceRelief(x, y) * smoothstep(0.05, 0.6, c);
    const l = lift || 0, len = Math.hypot(x, z) || 1;
    return [x + l * x / len, y, z + l * z / len];
  }
  function headFront(x, y, lift) {
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 26; i++) {
      const mid = (lo + hi) / 2;
      if (headPoint(mid, y)[0] < Math.abs(x)) lo = mid; else hi = mid;
    }
    return headPoint(lo, y, lift)[2];
  }
  // Lower edge of the hair cap: a high forehead with a centre parting,
  // swept back over the temples, covering the ears, down to the nape.
  const HAIRLINE = [[0, 0.28], [0.45, 0.255], [0.9, 0.16], [1.2, 0.04], [1.42, -0.1], [1.7, -0.32], [2.2, -0.52], [Math.PI, -0.58]];
  function hairline(th) { return curve(HAIRLINE, Math.abs(Math.atan2(Math.sin(th), Math.cos(th))))[0]; }
  
  // ------------------------------------------------------------ math helpers
  function axesM(x, y, z) { const m = new M4(); M4.FromXYZAxesToRef(x, y, z, m); return m; }
  // Orthonormal axes with y along `y` and z as close as possible to zHint.
  function frameYZ(y, zHint) {
    y = y.normalizeToNew();
    let z = zHint.subtract(y.scale(Vec.Dot(zHint, y)));
    if (z.lengthSquared() < 1e-8) z = Vec.Cross(y, new Vec(1, 0, 0));
    z.normalize();
    return [Vec.Cross(y, z), y, z];
  }
  function frameXZ(x, zHint) {
    x = x.normalizeToNew();
    let z = zHint.subtract(x.scale(Vec.Dot(zHint, x)));
    if (z.lengthSquared() < 1e-8) z = Vec.Cross(new Vec(0, 1, 0), x);
    z.normalize();
    return [x, Vec.Cross(z, x), z];
  }
  const quatOf = (axes) => Q.FromRotationMatrix(axesM(...axes));
  const rotM = (q) => { const m = new M4(); q.toRotationMatrix(m); return m; };
  // Local rotation of a child whose parent has world rotation matrix P, so
  // that its world rotation is W (Babylon: world = local x parentWorld).
  const localQ = (W, P) => Q.FromRotationMatrix(W.multiply(P.transpose()));

  // ------------------------------------------------------------ textures
  function canvasTex(name, w, h, scene, draw, alpha) {
    const dt = new BABYLON.DynamicTexture(name, { width: w, height: h }, scene, true);
    const c = dt.getContext();
    draw(c, w, h);
    dt.update();
    if (alpha) dt.hasAlpha = true;
    return dt;
  }
  function rgba(col, a) {
    const c = typeof col === 'string' ? hex(col) : col;
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
  }
  // A baroque scroll: an S of two opposed curls with a leaf at the join.
  function scrollMotif(c, x, y, s, flip) {
    const f = flip ? -1 : 1;
    c.beginPath();
    c.moveTo(x, y + s);
    c.bezierCurveTo(x + f * s * 0.9, y + s * 0.6, x + f * s * 0.9, y - s * 0.2, x + f * s * 0.3, y - s * 0.3);
    c.bezierCurveTo(x - f * s * 0.1, y - s * 0.35, x - f * s * 0.05, y - s * 0.05, x + f * s * 0.2, y - s * 0.05);
    c.moveTo(x, y + s);
    c.bezierCurveTo(x - f * s * 0.7, y + s * 1.1, x - f * s * 0.9, y + s * 1.7, x - f * s * 0.4, y + s * 1.8);
    c.stroke();
    c.beginPath();
    c.ellipse(x + f * s * 0.35, y + s * 0.95, s * 0.12, s * 0.28, f * 0.6, 0, TAU);
    c.fill();
  }
  // Damask: medallions of scrolls in a lighter tone over the gown colour.
  function drawDamask(c, w, h, L, cols, rows) {
    c.fillStyle = L.gown; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 4000; i++) {                          // satin weave
      c.fillStyle = `rgba(255,255,255,${0.012 + Math.random() * 0.02})`;
      c.fillRect(Math.random() * w, Math.random() * h, 1, 2 + Math.random() * 6);
    }
    const cw = w / cols, ch = h / rows;
    c.strokeStyle = rgba(L.gownHi, 0.3); c.fillStyle = rgba(L.gownHi, 0.22); c.lineWidth = Math.max(1.2, cw * 0.025);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const x = (i + 0.5 + (j % 2) * 0.5) * cw, y = (j + 0.25) * ch, s = ch * 0.22;
        [x, x - w].forEach((xx) => { scrollMotif(c, xx, y, s, false); scrollMotif(c, xx, y, s, true); });
        c.beginPath(); c.arc(x, y + s * 2.3, s * 0.18, 0, TAU); c.fill();
      }
    }
  }
  // Gown skirt: damask, a gold-embroidered front panel and a gold hem band.
  function drawSkirt(c, w, h, L, gold) {
    drawDamask(c, w, h, L, 16, 8);
    const shade = c.createLinearGradient(0, 0, 0, h);
    shade.addColorStop(0, 'rgba(0,0,0,0.25)'); shade.addColorStop(0.3, 'rgba(0,0,0,0)'); shade.addColorStop(1, 'rgba(0,0,0,0.2)');
    c.fillStyle = shade; c.fillRect(0, 0, w, h);
    const cx = w / 2, pw = w * 0.07;
    c.fillStyle = rgba(L.gownLo, 0.9); c.fillRect(cx - pw / 2, 0, pw, h);
    c.strokeStyle = gold; c.fillStyle = gold; c.lineWidth = w * 0.004;
    [cx - pw / 2, cx + pw / 2].forEach((x) => { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); });
    for (let y = h * 0.02; y < h * 0.9; y += pw * 1.25) {
      scrollMotif(c, cx, y, pw * 0.3, false); scrollMotif(c, cx, y, pw * 0.3, true);
    }
    const bh = h * 0.06;
    c.fillStyle = rgba(L.gownLo, 1); c.fillRect(0, h - bh, w, bh);
    c.fillStyle = gold; c.fillRect(0, h - bh, w, h * 0.006); c.fillRect(0, h - h * 0.008, w, h * 0.008);
    c.lineWidth = w * 0.0025;
    for (let x = 0; x < w; x += bh * 1.2) { scrollMotif(c, x, h - bh * 0.85, bh * 0.25, false); scrollMotif(c, x + bh * 0.6, h - bh * 0.85, bh * 0.25, true); }
  }
  // Bodice: a gold-embroidered stomacher narrowing to the waist point.
  function drawBodice(c, w, h, L, gold) {
    drawDamask(c, w, h, L, 8, 3);
    const cx = w / 2;
    c.strokeStyle = gold; c.fillStyle = gold; c.lineWidth = w * 0.006;
    [-1, 1].forEach((s) => {
      c.beginPath(); c.moveTo(cx + s * w * 0.09, 0); c.quadraticCurveTo(cx + s * w * 0.06, h * 0.6, cx + s * w * 0.012, h); c.stroke();
      for (let k = 0; k < 4; k++) scrollMotif(c, cx + s * w * 0.035, h * (0.1 + 0.22 * k), h * 0.07 * (1 - 0.15 * k), s < 0);
      // under-bust arcs
      c.beginPath(); c.moveTo(cx + s * w * 0.09, h * 0.45); c.quadraticCurveTo(cx + s * w * 0.2, h * 0.52, cx + s * w * 0.27, h * 0.36); c.stroke();
    });
    for (let k = 0; k < 5; k++) { c.beginPath(); c.arc(cx, h * (0.12 + 0.19 * k), w * 0.007, 0, TAU); c.fill(); }
  }
  // Lace: an openwork net of scalloped rings on transparent, a solid gold
  // edge along the rim (v = 1 side) and a band at the base.
  function drawLace(c, w, h, L, gold) {
    c.clearRect(0, 0, w, h);
    c.fillStyle = L.lace; c.fillRect(0, h * 0.08, w, h * 0.12);
    c.strokeStyle = L.lace; c.lineWidth = w * 0.006;
    const n = 14, cw = w / n;
    for (let j = 0; j < 5; j++) {
      for (let i = 0; i <= n; i++) {
        const x = (i + (j % 2) * 0.5) * cw, y = h * (0.28 + j * 0.15);
        c.beginPath(); c.arc(x, y, cw * 0.36, 0, TAU); c.stroke();
        c.beginPath(); c.arc(x, y, cw * 0.14, 0, TAU); c.stroke();
        for (let k = 0; k < 6; k++) {
          const a = k / 6 * TAU;
          c.beginPath(); c.moveTo(x + Math.cos(a) * cw * 0.14, y + Math.sin(a) * cw * 0.14);
          c.lineTo(x + Math.cos(a) * cw * 0.36, y + Math.sin(a) * cw * 0.36); c.stroke();
        }
      }
    }
    c.fillStyle = gold; c.fillRect(0, 0, w, h * 0.07);
    c.fillStyle = L.lace; c.fillRect(0, h * 0.07, w, h * 0.02);
  }
  // Hair strands: streaks along the texture's v, fading to ragged ends at
  // the bottom when `ends` (alpha-tested).
  function drawHair(c, w, h, L, ends) {
    c.clearRect(0, 0, w, h);
    c.fillStyle = L.hair; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * w, lw = 0.6 + Math.random() * 2.2;
      const k = Math.random();
      c.strokeStyle = k < 0.35 ? rgba(L.hairHi, 0.25 + Math.random() * 0.35) : rgba(L.hairLo, 0.2 + Math.random() * 0.4);
      c.lineWidth = lw;
      c.beginPath(); c.moveTo(x, 0);
      c.bezierCurveTo(x + (Math.random() - 0.5) * 10, h * 0.33, x + (Math.random() - 0.5) * 10, h * 0.66, x + (Math.random() - 0.5) * 6, h);
      c.stroke();
    }
    if (!ends) return;
    c.globalCompositeOperation = 'destination-out';
    for (let x = 0; x < w; x += 2) {
      const len = h * (0.04 + 0.16 * Math.pow(Math.random(), 1.5));
      const g = c.createLinearGradient(0, h - len, 0, h);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)');
      c.fillStyle = g; c.fillRect(x, h - len, 2, len);
    }
    c.globalCompositeOperation = 'source-over';
  }
  // Soft radial glow for flares (white core fading out).
  function drawFlare(c, w, h) {
    c.clearRect(0, 0, w, h);
    const g = c.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.15, 'rgba(255,255,255,0.75)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    // four-point star rays
    c.globalCompositeOperation = 'lighter';
    const ray = (horiz) => {
      const gr = horiz ? c.createLinearGradient(0, 0, w, 0) : c.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = gr;
      if (horiz) c.fillRect(0, h / 2 - h * 0.012, w, h * 0.024); else c.fillRect(w / 2 - w * 0.012, 0, w * 0.024, h);
    };
    ray(true); ray(false);
    c.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------ character
  class QueenCharacter extends ProceduralCharacter {
    _mat(name, color, metallic, roughness, twoSided) {
      const mat = new BABYLON.PBRMaterial(`${name}_${this.id}`, this.scene);
      mat.albedoColor = typeof color === 'string' ? hex(color) : color;
      mat.metallic = metallic; mat.roughness = roughness; mat.maxSimultaneousLights = 8;
      if (twoSided) { mat.backFaceCulling = false; mat.twoSidedLighting = true; }
      this.materials.push(mat);
      return mat;
    }
    // Self-lit material for jewels, the orb and glows; kept out of
    // this.materials so the shared flash doesn't overwrite its glow.
    _glowMat(name, color, alpha) {
      const mat = new BABYLON.StandardMaterial(`${name}_${this.id}`, this.scene);
      mat.emissiveColor = typeof color === 'string' ? hex(color) : color;
      mat.diffuseColor = C3.Black(); mat.specularColor = C3.Black(); mat.disableLighting = true;
      if (alpha !== undefined) mat.alpha = alpha;
      return mat;
    }
    _surf(name, vd, mat, parent) {
      const mesh = new BABYLON.Mesh(`${name}_${this.id}`, this.scene);
      vd.applyToMesh(mesh);
      return this._add(mesh, parent, mat);
    }
    _node(name, parent, pos, merge) {
      const n = new BABYLON.TransformNode(`${name}_${this.id}`, this.scene);
      n.parent = parent;
      if (pos) n.position.set(pos[0], pos[1], pos[2]);
      if (merge !== false) this._pivots.push(n);
      return n;
    }
    // Tube through `pts` (Catmull-Rom) with radius keys [[t, r], ...] or a constant.
    _cord(name, pts, radius, mat, parent, sides, flat) {
      const keys = pts.map((p, i) => [i / (pts.length - 1), p[0], p[1], p[2]]);
      const rk = typeof radius === 'number' ? [[0, radius], [1, radius]] : radius;
      return this._surf(name, sweep(sides || 8, Math.min(48, Math.max(6, pts.length * 3)), (t) => curve(keys, t), (t, a) => {
        const r = curve(rk, t)[0];
        return [r * Math.cos(a), r * (flat || 1) * Math.sin(a)];
      }, { capStart: true, capEnd: true }), mat, parent);
    }
    _ball(name, p, r, mat, parent, sc, seg) {
      const m = BABYLON.MeshBuilder.CreateSphere(`${name}_${this.id}`, { diameter: 2 * r, segments: seg || 10 }, this.scene);
      m.position.set(p[0], p[1], p[2]);
      if (sc) m.scaling.set(sc[0], sc[1], sc[2]);
      return this._add(m, parent, mat);
    }
    _ring(fn, n) { return Array.from({ length: n + 1 }, (_, i) => fn(i / n * TAU)); }

    async build() {
      await super.build();
      this._tickObserver = this.scene.onBeforeRenderObservable.add(() => this._tick());
      const fx = this.ctx && this.ctx.effects;
      if (fx && fx.sparkles) this._sparkles = fx.sparkles(this.parts.orbCore, this._magic, this._orbColor);
    }

    dispose() {
      if (this._tickObserver) this.scene.onBeforeRenderObservable.remove(this._tickObserver);
      this._tickObserver = null;
      if (this._walkAura) this._walkAura.stop();
      if (this._attackAura) this._attackAura.stop();
      if (this._sparkles) this._sparkles.dispose();
      this._releaseOrbLight();
      this._sparkles = null;
      const glow = this.ctx && this.ctx.glow;
      if (glow && this.parts && this.parts.orbFlare) [this.parts.orbFlare, ...this.parts.eyeGlows.map((g) => g.flare)].forEach((m) => glow.removeExcludedMesh(m));
      super.dispose();
    }

    _buildQueen(team) {
      const L = this.L = LIVERY[this.color] || LIVERY.w;
      this._pivots = [];
      this._magic = team.glow;
      this._orbColor = L.orb;
      const scene = this.scene, id = this.id;
      const gold = this.mats.accent;
      const M = this.qMats = {
        gold,
        skin: this._mat('qSkin', L.skin, 0, 0.5),
        gown: this._mat('qGown', '#ffffff', 0, 0.55),
        bodice: this._mat('qBodice', '#ffffff', 0, 0.5),
        sleeve: this._mat('qSleeve', '#ffffff', 0, 0.55, true),
        lining: this._mat('qLining', L.lining, 0.1, 0.45, true),
        velvet: this._mat('qVelvet', L.gown, 0, 0.6),
        lace: this._mat('qLace', '#ffffff', 0, 0.6, true),
        hair: this._mat('qHair', '#ffffff', 0, 0.45, true),
        brow: this._mat('qBrow', L.brow, 0, 0.6),
        lash: this._mat('qLash', '#120a08', 0, 0.5),
        sclera: this._mat('qSclera', '#f4f0ec', 0, 0.2),
        lip: this._mat('qLipGloss', L.lips, 0, 0.3),
        pale: this._mat('qPaleGold', C3.Lerp(hex(team.accent), C3.White(), 0.45), 1, 0.2),
        gem: this._glowMat('qGem', hex(L.gem).scale(0.32)),
        orb: this._glowMat('qOrb', L.orb)
      };
      [M.gown, M.bodice, M.sleeve, M.velvet].forEach((m) => { m.sheen.isEnabled = true; m.sheen.intensity = 0.35; m.sheen.color = hex(L.gownHi).scale(0.7); });
      M.hair.sheen.isEnabled = true; M.hair.sheen.intensity = 0.5; M.hair.sheen.color = hex(L.hairHi);
      M.sclera.clearCoat.isEnabled = true;
      M.skin.subSurface.isTranslucencyEnabled = false;
      M.gown.albedoTexture = canvasTex(`qSkirtTex_${id}`, 1024, 1024, scene, (c, w, h) => drawSkirt(c, w, h, L, team.accent));
      M.bodice.albedoTexture = canvasTex(`qBodiceTex_${id}`, 512, 512, scene, (c, w, h) => drawBodice(c, w, h, L, team.accent));
      const sleeveTex = canvasTex(`qSleeveTex_${id}`, 512, 512, scene, (c, w, h) => {
        drawDamask(c, w, h, L, 4, 4);
        c.fillStyle = team.accent;
        c.fillRect(0, 0, w * 0.035, h); c.fillRect(w * 0.965, 0, w * 0.035, h); c.fillRect(0, h * 0.95, w, h * 0.05);
      });
      M.sleeve.albedoTexture = sleeveTex;
      const laceTex = canvasTex(`qLaceTex_${id}`, 512, 256, scene, (c, w, h) => drawLace(c, w, h, L, team.accent), true);
      M.lace.albedoTexture = laceTex; M.lace.useAlphaFromAlbedoTexture = true;
      M.lace.transparencyMode = BABYLON.PBRMaterial.PBRMATERIAL_ALPHATEST; M.lace.alphaCutOff = 0.4;
      const hairTex = canvasTex(`qHairTex_${id}`, 256, 512, scene, (c, w, h) => drawHair(c, w, h, L, true), true);
      M.hair.albedoTexture = hairTex; M.hair.useAlphaFromAlbedoTexture = true;
      M.hair.transparencyMode = BABYLON.PBRMaterial.PBRMATERIAL_ALPHATEST; M.hair.alphaCutOff = 0.35;
      this._flareTex = canvasTex(`qFlareTex_${id}`, 128, 128, scene, drawFlare, true);

      const torso = new BABYLON.TransformNode(`torso_${id}`, scene);
      torso.parent = this.visual;
      this.parts.torso = torso;

      this._buildGown(torso, M, L, team);
      this._buildCollar(torso, M);
      this._buildHead(torso, M, L);
      this._buildArms(torso, M, L);
      this._buildScepter(M, L, team);
      this._applyArms(this._restPose());
      this.parts.extraPivots = this._pivots;
    }

    // --------------------------------------------------------- gown
    _buildGown(torso, M, L, team) {
      const gold = M.gold;
      // skirt: u runs round from the back seam, the embroidered panel at the front
      this._surf('skirt', grid(96, 44, (u, v) => {
        const th = Math.PI * (2 * u - 1);
        return [...skirtAt(th, v), u, 1 - v];
      }, { closed: true }), M.gown, torso);
      // inside of the hem so the bell never looks hollow from low angles
      this._surf('skirtInner', grid(48, 4, (u, v) => skirtAt(Math.PI * (2 * u - 1), 0.9 + 0.1 * v, -0.004), { closed: true, inward: true }), M.velvet, torso);
      this._cord('hemCord', this._ring((th) => skirtAt(th, 1, 0.002), 96), 0.0035, gold, torso, 6);
      // bodice (texture: u round from the back, v from the neckline down)
      this._surf('bodice', grid(64, 22, (u, v) => {
        const th = Math.PI * (2 * u - 1), top = neckY(th);
        return [...torsoPoint(th, lerp(top, 0.585, v)), u, 1 - v];
      }, { closed: true }), M.bodice, torso);
      // skin inside the V and the shoulders' top line
      this._surf('chest', grid(48, 16, (u, v) => torsoPoint(Math.PI * (2 * u - 1), lerp(0.842, 0.68, v), -0.0015), { closed: true }), M.skin, torso);
      this._surf('neck', sweep(18, 8, (t) => [0, lerp(0.8, 0.89, t), lerp(0.0, 0.004, t)], (t, a) => {
        const r = lerp(0.034, 0.0195, smoothstep(0, 0.45, t)), front = Math.max(0, Math.sin(a));
        return [r * Math.cos(a), r * (0.92 - 0.06 * front) * Math.sin(a)];
      }, { side: [1, 0, 0] }), M.skin, torso);
      this._cord('neckTrim', this._ring((th) => torsoPoint(th, neckY(th), 0.0025), 96), 0.0024, gold, torso, 6);
      // girdle: a gold band dipping to a point at the front, a jewelled clasp
      // and a chain falling down the skirt to a pendant
      const beltY = (th) => 0.604 - 0.024 * Math.pow(Math.max(0, Math.cos(th)), 3);
      const beltPt = (th, dy, l) => {
        const y = beltY(th) + dy, a = torsoPoint(th, Math.max(0.585, y), 0), b = skirtPoint(th, Math.min(WAIST, y), 0);
        const r = Math.max(Math.hypot(a[0], a[2]), Math.hypot(b[0], b[2])) + l;
        return [r * Math.sin(th), y, r * Math.cos(th)];
      };
      this._surf('girdle', grid(64, 3, (u, v) => beltPt(Math.PI * (2 * u - 1), 0.008 - 0.016 * v, 0.003), { closed: true }), gold, torso);
      [0.008, -0.008].forEach((dy, i) => this._cord(`girdleEdge${i}`, this._ring((th) => beltPt(th, dy, 0.004), 64), 0.0018, M.pale, torso, 5));
      for (let k = -3; k <= 3; k++) {
        const p = beltPt(k * 0.42, 0, 0.006);
        this._ball(`girdleGem${k}`, p, k === 0 ? 0.0085 : 0.0042, M.gem, torso, [1, 1.2, 0.6]);
      }
      const clasp = beltPt(0, -0.004, 0.005);
      this._cord('claspRing', this._ring((a) => [clasp[0] + 0.012 * Math.cos(a), clasp[1] + 0.012 * Math.sin(a), clasp[2] + 0.001], 20), 0.0022, gold, torso, 5);
      const chain = [];
      for (let k = 0; k <= 12; k++) {
        const v = 0.02 + 0.3 * k / 12, th = 0.05 * Math.sin(k * 0.8);
        chain.push(skirtAt(th, v, 0.004));
      }
      chain.forEach((p, k) => { if (k) this._ball(`chainLink${k}`, p, 0.0028, gold, torso, [1, 1.4, 0.8], 6); });
      const pend = chain[chain.length - 1];
      this._ball('chainPendant', [pend[0], pend[1] - 0.012, pend[2] + 0.004], 0.008, M.gem, torso, [1, 1.5, 0.6]);
      this._cord('pendantFrame', this._ring((a) => [pend[0] + 0.0105 * Math.sin(a), pend[1] - 0.012 + 0.015 * Math.cos(a), pend[2] + 0.004], 20), 0.0016, gold, torso, 5);
      // raised gold lacing on the bodice front: two lines converging on the point
      [-1, 1].forEach((s) => {
        const pts = [];
        for (let k = 0; k <= 10; k++) {
          const y = lerp(0.705, 0.592, k / 10), x = s * lerp(0.024, 0.006, k / 10);
          const th = Math.asin(clamp(x / curve(TORSO, y)[0], -1, 1));
          pts.push(torsoPoint(th, y, 0.0022));
        }
        this._cord(`stomacher${s}`, pts, 0.0017, gold, torso, 5);
      });
      // necklace: a fine chain round the neck base with a teardrop pendant
      const neckPath = this._ring((th) => torsoPoint(th, 0.826 - 0.055 * Math.pow(Math.max(0, Math.cos(th)), 6), 0.0022), 72);
      this._cord('necklace', neckPath, 0.0014, gold, torso, 5);
      const np = torsoPoint(0, 0.766, 0.004);
      this._ball('neckGem', [np[0], np[1] - 0.008, np[2] + 0.002], 0.0065, M.gem, torso, [1, 1.5, 0.6]);
      this._cord('neckGemFrame', this._ring((a) => [np[0] + 0.0085 * Math.sin(a), np[1] - 0.008 + 0.012 * Math.cos(a), np[2] + 0.002], 20), 0.0013, gold, torso, 5);
    }

    // --------------------------------------------------------- collar
    // Medici collar: lace edged in gold, lying along the V as lapels and
    // rising behind the neck like a fan.
    _buildCollar(torso, M) {
      const E = 0.05;
      const collarPt = (u, v) => {
        const th = E + u * (TAU - 2 * E);
        const b = torsoPoint(th, neckY(th), 0.003);
        const a = Math.min(th, TAU - th);                          // angle from the front
        const back = smoothstep(1.0, 2.6, a);
        const o = new Vec(Math.sin(th), 0, Math.cos(th));
        // behind the neck it stands off the body (wired), leaving room for the hair
        const gap = 0.03 * smoothstep(1.8, 2.9, a);
        const d = o.scale(lerp(1, 0.4, back)).add(new Vec(0, lerp(0.3, 1, back), 0)).normalize();
        const h = lerp(0.016, 0.08, Math.pow(back, 1.2)) * (1 + 0.07 * Math.sin(th * 22) * v);
        const p = new Vec(...b).add(o.scale(gap)).add(new Vec(0, gap * 0.2, 0)).add(d.scale(h * v)).add(o.scale(h * 0.5 * v * v * back));
        return [p.x, p.y, p.z, u * 6, v];
      };
      this._surf('collar', grid(96, 8, collarPt), M.lace, torso);
      this._cord('collarRim', Array.from({ length: 97 }, (_, i) => collarPt(i / 96, 1).slice(0, 3)), 0.0022, M.gold, torso, 5);
    }

    // --------------------------------------------------------- head
    _buildHead(torso, M, L) {
      const scene = this.scene, id = this.id;
      const head = this._node('head', torso, HEAD_AT, false);
      this.parts.head = head;
      const rig = this._node('faceRig', head);
      rig.scaling.setAll(K);
      this.parts.faceRig = rig;

      // Face with painted vertex colours: a warm flush on the cheeks and
      // nose, tinted lips, soft brown shadow on the lids, and occlusion in
      // the creases (eye sockets, under the nose, mouth corners, under the jaw).
      const faceVD = grid(112, 96, (u, v) => headPoint(Math.PI * (2 * u - 1), 0.52 - v * 1.2));
      const base = hex(L.skin), blush = hex(L.blush), lip = hex(L.lips), lidC = hex(L.lid), shade = base.multiply(new C3(0.72, 0.6, 0.6));
      faceVD.colors = [];
      for (let i = 0; i < faceVD.positions.length; i += 3) {
        const x = faceVD.positions[i], y = faceVD.positions[i + 1], z = faceVD.positions[i + 2], ax = Math.abs(x);
        const front = smoothstep(0, 0.15, z);
        const wBlush = front * Math.min(1, 0.28 * gauss(ax - 0.19, y + 0.15, 0.085, 0.075) + 0.12 * gauss(x, y + 0.16, 0.03, 0.035));
        const my = (y + 0.286) * (1 + 0.5 * smoothstep(0.02, 0.07, ax));
        const wLip = front * 0.85 * smoothstep(0.25, 0.6, gauss(x, my, 0.082, 0.042)) * (1 - 0.6 * gauss(x, y + 0.284, 0.09, 0.004));
        const wLid = front * 0.5 * gauss(ax - EYE_X, y - 0.05, 0.07, 0.03);
        const wAO = front * Math.min(0.6, 0.35 * gauss(ax - EYE_X + 0.01, y - 0.0, 0.09, 0.06) + 0.35 * gauss(ax - 0.03, y + 0.2, 0.02, 0.012)
          + 0.3 * gauss(ax - 0.09, y + 0.285, 0.014, 0.014) + 0.2 * gauss(x, y + 0.365, 0.05, 0.012) + 0.25 * gauss(ax - 0.06, y - 0.015, 0.02, 0.03))
          + 0.35 * smoothstep(-0.46, -0.58, y);
        let col = C3.Lerp(base, blush, wBlush);
        col = C3.Lerp(col, lidC, wLid);
        col = C3.Lerp(col, shade, wAO);
        col = C3.Lerp(col, lip, wLip);
        const lin = col.toLinearSpace();
        faceVD.colors.push(lin.r, lin.g, lin.b, 1);
      }
      const faceMat = this._mat('qFace', '#ffffff', 0, 0.52);
      faceMat.sheen.isEnabled = true; faceMat.sheen.intensity = 0.12; faceMat.sheen.color = hex(L.blush);
      this._surf('face', faceVD, faceMat, rig);

      // ears (mostly under the hair; the lobes carry the earrings)
      [-1, 1].forEach((s) => {
        const ear = this._ball(`ear${s}`, [s * 0.315, -0.11, -0.05], 0.07, M.skin, rig, [0.35, 1.35, 0.85], 10);
        ear.rotation.set(-0.15, s * 0.35, 0);
      });

      // eyes: eyeball, a textured iris set in it, almond lids, lashes, brows
      const irisTex = canvasTex(`qIrisTex_${id}`, 128, 128, scene, (c, w) => {
        const r = w / 2, col = hex(L.iris);
        c.fillStyle = '#f2eee9'; c.fillRect(0, 0, w, w);
        const g = c.createRadialGradient(r, r, r * 0.2, r, r, r);
        g.addColorStop(0, rgba(col.scale(0.55), 1)); g.addColorStop(0.45, rgba(col, 1)); g.addColorStop(0.85, rgba(col.scale(0.8), 1)); g.addColorStop(1, rgba(col.scale(0.25), 1));
        c.fillStyle = g; c.beginPath(); c.arc(r, r, r, 0, TAU); c.fill();
        for (let k = 0; k < 90; k++) {                         // radial fibres
          const a = k / 90 * TAU + Math.random() * 0.05;
          c.strokeStyle = Math.random() < 0.5 ? rgba(C3.Lerp(col, C3.White(), 0.45), 0.35) : rgba(col.scale(0.4), 0.3);
          c.lineWidth = 1 + Math.random();
          c.beginPath(); c.moveTo(r + Math.cos(a) * r * 0.3, r + Math.sin(a) * r * 0.3); c.lineTo(r + Math.cos(a) * r * 0.92, r + Math.sin(a) * r * 0.92); c.stroke();
        }
        c.fillStyle = '#060404'; c.beginPath(); c.arc(r, r, r * 0.36, 0, TAU); c.fill();
      });
      const irisMat = this._mat('qIrisTex', '#ffffff', 0, 0.12);
      irisMat.albedoTexture = irisTex; irisMat.clearCoat.isEnabled = true; irisMat.clearCoat.intensity = 1; irisMat.clearCoat.roughness = 0.05;
      this.parts.eyeGlows = [];
      [-1, 1].forEach((s) => {
        carve = 0;
        const E = new Vec(s * EYE_X, EYE_Y, headFront(EYE_X, EYE_Y) - 0.041);
        carve = 1;
        const R = EYE_R, IR = 0.028, P = Math.asin(IR / R);
        this._ball(`eyeball${s}`, [E.x, E.y, E.z], R, M.sclera, rig, null, 18);
        // iris: a spherical cap over the front of the eyeball, gazing slightly inward
        const gaze = -s * 0.06;
        this._surf(`iris${s}`, grid(28, 7, (u, v) => {
          const a = u * TAU, pol = v * P, rr = R + 0.0008;
          const px = rr * Math.sin(pol) * Math.cos(a), py = rr * Math.sin(pol) * Math.sin(a), pz = rr * Math.cos(pol);
          const cx = px * Math.cos(gaze) + pz * Math.sin(gaze), cz = -px * Math.sin(gaze) + pz * Math.cos(gaze);
          return [E.x + cx, E.y + py, E.z + cz, 0.5 + 0.5 * v * Math.cos(a), 0.5 + 0.5 * v * Math.sin(a)];
        }, { closed: true }), irisMat, rig);
        const lidPt = (lat, lon, r) => [E.x + r * Math.cos(lat) * Math.sin(lon), E.y + r * Math.sin(lat), E.z + r * Math.cos(lat) * Math.cos(lon)];
        // outer corners lifted: an almond eye; the upper lid just grazes the iris
        const tilt = (lon) => 0.09 * s * lon / 1.6;
        const upper = (lon) => 0.4 + tilt(lon) - 0.12 * lon * lon / 2.56;
        const lower = (lon) => -0.5 + tilt(lon) * 0.5 + 0.14 * lon * lon / 2.4;
        this._surf(`upperLid${s}`, grid(20, 6, (u, v) => {
          const lon = (2 * u - 1) * 1.6, lat = lerp(1.5, upper(lon), Math.sqrt(v));
          return lidPt(lat, lon, R + 0.0035 + 0.003 * Math.sin(Math.PI * v));
        }), M.skin, rig);
        this._surf(`lowerLid${s}`, grid(20, 5, (u, v) => {
          const lon = (2 * u - 1) * 1.55, lat = lerp(lower(lon), -1.3, v * v);
          return lidPt(lat, lon, R + 0.003);
        }), M.skin, rig);
        // crease above the lid
        this._cord(`lidCrease${s}`, Array.from({ length: 13 }, (_, k) => {
          const lon = (2 * k / 12 - 1) * 1.3;
          return lidPt(upper(lon) + 0.42, lon, R + 0.006);
        }), 0.003, M.skin, rig, 5);
        const rim = (latFn, r, n, span) => Array.from({ length: n + 1 }, (_, k) => {
          const lon = (2 * k / n - 1) * span;
          return lidPt(latFn(lon), lon, r);
        });
        const outerT = (t) => (s > 0 ? t : 1 - t);
        this._cord(`lash${s}`, rim(upper, R + 0.0065, 18, 1.5), [[0, 0.0035], [0.5, 0.0055], [0.8, 0.0075], [1, 0.003]].map(([t, r]) => [outerT(t), r]).sort((a, b) => a[0] - b[0]), M.lash, rig, 6, 0.55);
        this._cord(`lowerLash${s}`, rim(lower, R + 0.004, 12, 1.35), 0.0016, M.lash, rig, 5);
        // a few lashes flicking up at the outer corner
        for (let k = 0; k < 3; k++) {
          const lon = s * (1.05 + 0.2 * k), oc = lidPt(upper(lon), lon, R + 0.0065);
          this._cord(`lashFlick${s}_${k}`, [oc, [oc[0] + s * (0.012 + 0.006 * k), oc[1] + 0.012, oc[2] + 0.002]], [[0, 0.0035], [1, 0.0008]], M.lash, rig, 4);
        }
        // brows: fine, softly arched, tapering outward
        for (let j = 0; j < 3; j++) {
          const pts = [[0.05, 0.118], [0.1, 0.142], [0.16, 0.157], [0.215, 0.148], [0.262, 0.118]].map(([x, y]) =>
            [s * x, y + (j - 1) * 0.004, headFront(x, y + (j - 1) * 0.004) + 0.0025]);
          this._cord(`brow${s}_${j}`, pts, [[0, 0.0055], [0.5, 0.0045], [1, 0.001]], M.brow, rig, 5, 0.35);
        }
        // glow (hidden until she casts): a bright iris cap and a flare
        const glow = this._node(`eyeGlow${s}`, rig, [E.x, E.y, E.z + R - 0.004], false);
        const cap = BABYLON.MeshBuilder.CreateSphere(`eyeGlowCap${s}_${id}`, { diameter: 0.05, segments: 8 }, scene);
        cap.scaling.set(1, 1, 0.35); cap.parent = glow; cap.isPickable = false;
        cap.material = this._glowMat(`eyeGlowMat${s}`, L.eyeGlow);
        const flare = BABYLON.MeshBuilder.CreatePlane(`eyeFlare${s}_${id}`, { size: 0.5 }, scene);
        flare.parent = glow; flare.isPickable = false; flare.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        flare.material = this._flareMat(`eyeFlareMat${s}`, this._magic);
        glow.setEnabled(false);
        this.parts.eyeGlows.push({ node: glow, flare, cap });
      });

      this._buildHair(rig, M, L);
      this._buildCrown(head, M, L);
      // earrings: a gold stud, a short chain and a teardrop jewel
      [-1, 1].forEach((s) => {
        const top = [s * 0.043, -0.03, -0.004];
        this._ball(`earStud${s}`, top, 0.0035, M.gold, head);
        this._cord(`earChain${s}`, [top, [top[0], top[1] - 0.012, top[2]]], 0.0009, M.gold, head, 4);
        this._ball(`earDrop${s}`, [top[0], top[1] - 0.019, top[2]], 0.0036, M.gem, head, [1, 1.6, 1]);
        this._cord(`earFrame${s}`, this._ring((a) => [top[0], top[1] - 0.019 + 0.008 * Math.cos(a), top[2] + 0.0055 * Math.sin(a)], 16), 0.0009, M.gold, head, 4);
      });
    }

    _flareMat(name, color) {
      const mat = new BABYLON.StandardMaterial(`${name}_${this.id}`, this.scene);
      mat.diffuseColor = C3.Black(); mat.specularColor = C3.Black(); mat.disableLighting = true;
      mat.emissiveTexture = this._flareTex; mat.opacityTexture = this._flareTex;
      mat.emissiveColor = hex(color); mat.alphaMode = BABYLON.Engine.ALPHA_ADD; mat.backFaceCulling = false;
      mat.disableDepthWrite = true;
      return mat;
    }

    // Hair: a centre parting, the hair flowing over the scalp in strand
    // clumps; the side hair falls forward over the shoulders, the rest down
    // the back (under the standing collar), over a darker under-layer.
    _buildHair(rig, M, L) {
      const rand = (() => { let x = this.color === 'w' ? 7 : 13; return () => { x = (x * 16807) % 2147483647; return x / 2147483647; }; })();
      const under = this._mat('qHairUnder', C3.Lerp(hex(L.hair), hex(L.hairLo), 0.55), 0, 0.6, true);
      const light = this._mat('qHairLight', '#ffffff', 0, 0.42, true);
      light.albedoTexture = M.hair.albedoTexture; light.useAlphaFromAlbedoTexture = true;
      light.transparencyMode = M.hair.transparencyMode; light.alphaCutOff = M.hair.alphaCutOff;
      light.albedoColor = C3.Lerp(C3.White(), hex(L.hairHi), 0.35).scale(1.12);
      light.sheen.isEnabled = true; light.sheen.intensity = 0.5; light.sheen.color = hex(L.hairHi);
      // scalp: strands streaming from the parting
      this._surf('hairCap', grid(80, 28, (u, v) => {
        const th = Math.PI * (2 * u - 1), yb = hairline(th), y = lerp(0.53, yb, v);
        const front = Math.max(0, Math.cos(th));
        const part = 0.02 * Math.exp(-Math.pow(th / 0.05, 2)) * smoothstep(0.05, 0.4, v) * front;
        const lift = lerp(0.04, lerp(0.012, 0.035, 1 - front), smoothstep(0.6, 1, v)) + 0.004 * Math.sin(th * 40 + v * 4) - part;
        return [...headPoint(th, y, lift), u * 4, 1 - v];
      }, { closed: true }), M.hair, rig);

      const back = this._node('hairBack', rig, [0, 0, -0.2]);
      const sides = [-1, 1].map((s) => this._node(`hairSide${s}`, rig, [s * 0.25, 0, 0]));
      this.parts.hairBack = back;
      this.parts.hairLocks = [-1, 1].map((s, i) => ({ node: sides[i], s }));
      const local = (node, p) => [p[0] - node.position.x, p[1] - node.position.y, p[2] - node.position.z];

      // under-layer down the back so gaps between clumps read as depth
      const UL = [[-2.3, 0.5, -0.44], [-1.25, 0.46, -0.4], [-0.95, 0.3, -0.3], [-0.6, 0.32, -0.34], [-0.3, 0.44, -0.46], [0.1, 0.42, -0.46]];
      this._surf('hairUnder', grid(24, 24, (u, v) => {
        const q = 2 * u - 1, y = lerp(0.05, -2.2 - 0.15 * Math.cos(q * 1.5), v), [hw, zc] = curve(UL, y);
        const wrap = smoothstep(-0.35, 0.0, y), th = Math.PI + q * 1.3, hp = headPoint(th, y, 0.03);
        return [...local(back, [lerp(q * hw, hp[0], wrap), y, lerp(zc - 0.04 * (1 - q * q), hp[2], wrap)]), u * 2, 1 - v];
      }), under, back);

      // a clump: flattened, tapering tube along `pts`, `w` wide; wavy below `free`
      const clump = (name, pts, w, node, mat, free, phase, amp) => {
        const keys = pts.map((p, i) => [i / (pts.length - 1), ...p]);
        return this._surf(name, sweep(8, 36, (t) => {
          const p = curve(keys, t), k = smoothstep(free, 1, t);
          return local(node, [p[0] + amp * k * Math.sin(t * 13 + phase), p[1], p[2] + amp * 0.6 * k * Math.cos(t * 11 + phase)]);
        }, (t, a) => {
          const ww = w * Math.min(1, 0.35 + t * 5) * (1 - 0.8 * Math.pow(t, 1.4)) + 0.004;
          return [ww * Math.cos(a), (0.018 * (1 - 0.6 * t) + 0.004) * Math.sin(a)];
        }, { side: [1, 0, 0], capStart: true, capEnd: true }), mat, node);
      };
      // over the scalp from the parting to where the hair leaves the head
      const scalpPath = (s, th0, y0, th1, y1) => Array.from({ length: 5 }, (_, k) => {
        const t = k / 4;
        return headPoint(s * lerp(th0, th1, t), lerp(y0, y1, t), lerp(0.038, 0.075, t));
      });

      [-1, 1].forEach((s, si) => {
        // front: swept from the parting over the temple and ear, falling
        // forward over the shoulder onto the breast
        for (let k = 0; k < 11; k++) {
          const f = k / 10, j = rand();
          const th0 = lerp(0.12, 1.05, f), y0 = lerp(0.46, 0.3, f) - 0.02 * j;
          const path = scalpPath(s, th0, y0, lerp(1.2, 1.55, f) + 0.08 * j, lerp(0.02, -0.18, f));
          const lx = lerp(0.46, 0.72, f) + 0.08 * (j - 0.5), len = 1.75 + 0.45 * rand();
          path.push([s * (lx - 0.02), -0.5, 0.2 - 0.12 * f], [s * (lx + 0.04), -0.95, 0.36 - 0.05 * f], [s * (lx + 0.06), -1.35, 0.52 - 0.05 * f],
            [s * (lx + 0.02), -0.4 - len, 0.62 - 0.04 * f]);
          clump(`hairF${s}_${k}`, path, 0.075 + 0.03 * rand(), sides[si], rand() < 0.35 ? light : M.hair, 0.35, rand() * 6, 0.05 + 0.03 * rand());
        }
        // a few strands escaping in the wind beside the shoulder
        for (let k = 0; k < 3; k++) {
          const j = rand(), th = 1.3 + 0.15 * k;
          const path = scalpPath(s, 0.5 + 0.2 * k, 0.4, th, -0.05);
          path.push([s * (0.7 + 0.1 * k), -0.35, -0.05], [s * (0.95 + 0.12 * k), -0.7, -0.12], [s * (1.15 + 0.15 * k + 0.1 * j), -1.05, -0.2]);
          clump(`hairWind${s}_${k}`, path, 0.055, sides[si], light, 0.3, rand() * 6, 0.06);
        }
      });
      // back: from the crown down the back of the head, gathering past the
      // nape (inside the collar) and spreading over the back
      for (let k = 0; k < 26; k++) {
        const q = (k / 25) * 2 - 1, j = rand(), s = q < 0 ? -1 : 1, aq = Math.abs(q);
        const th = Math.PI - q * 1.55;
        const path = [headPoint(th, 0.45, 0.04), headPoint(th, 0.2, 0.055), headPoint(th, -0.05, 0.07), headPoint(Math.PI - q * 1.35, -0.3, 0.075)];
        const len = 2.0 + 0.3 * Math.cos(q * 1.4) + 0.2 * j;
        path.push([q * 0.3, -0.62, -0.3 - 0.05 * (1 - aq)], [q * 0.3, -0.95, -0.3 - 0.06 * (1 - aq)], [q * 0.5, -1.3, -0.47 - 0.06 * (1 - aq)],
          [q * 0.58 + s * 0.04 * j, -0.3 - len, -0.5 - 0.05 * (1 - aq)]);
        clump(`hairB${k}`, path, 0.1 + 0.03 * rand(), back, rand() < 0.3 ? light : M.hair, 0.45, rand() * 6, 0.04);
      }
    }

    // Crown: a gold circlet of rising spires fanning out like a sunburst,
    // the centre one tallest, set with jewels and tipped with pearls.
    _buildCrown(head, M, L) {
      const crown = this._node('crown', head, [0, 0.043, -0.006]);
      this.parts.crown = crown;
      const RX = 0.041, RZ = 0.046;
      const bandPt = (a, y, l) => [(RX + l + 0.002 * y / 0.014) * Math.sin(a), y, (RZ + l + 0.002 * y / 0.014) * Math.cos(a)];
      this._surf('crownBand', grid(64, 3, (u, v) => bandPt(u * TAU, lerp(-0.004, 0.012, v), 0), { closed: true }), M.gold, crown);
      this._surf('crownBandIn', grid(64, 2, (u, v) => bandPt(u * TAU, lerp(-0.004, 0.012, v), -0.0015), { closed: true, inward: true }), M.gold, crown);
      [-0.004, 0.012].forEach((y, i) => this._cord(`crownRim${i}`, this._ring((a) => bandPt(a, y, 0.0006), 64), 0.0016, M.pale, crown, 5));
      // [angle from the front, height, outward tilt, base half-width]
      const SPIRES = [[0, 0.086, 0.1, 0.006], [0.3, 0.05, 0.3, 0.0045], [0.58, 0.078, 0.42, 0.0055], [0.9, 0.045, 0.5, 0.0042],
        [1.2, 0.062, 0.58, 0.005], [1.55, 0.04, 0.6, 0.004], [1.9, 0.048, 0.55, 0.0042], [2.35, 0.036, 0.45, 0.0038], [2.8, 0.04, 0.35, 0.004],
        [Math.PI, 0.034, 0.3, 0.0038]];
      SPIRES.forEach(([a0, h, tilt, w], i) => [-1, 1].forEach((s) => {
        if (s < 0 && (a0 === 0 || a0 === Math.PI)) return;
        const a = s * a0, base = bandPt(a, 0.01, 0.0005);
        const out = new Vec(Math.sin(a), 0, Math.cos(a));
        const dir = out.scale(Math.sin(tilt)).add(new Vec(0, Math.cos(tilt), 0));
        const tip = new Vec(...base).add(dir.scale(h));
        const mid = new Vec(...base).add(dir.scale(h * 0.45)).add(out.scale(0.004));
        // a four-sided spire: diamond section, swelling then tapering to a point
        this._surf(`spire${i}_${s}`, sweep(4, 10, (t) => bezier([base, [mid.x, mid.y, mid.z], [tip.x, tip.y, tip.z]], t), (t, ang) => {
          const r = w * (1 - t) * (0.8 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.8)));
          return [r * Math.cos(ang), r * 0.55 * Math.sin(ang)];
        }, { side: [out.x, out.y, out.z], capStart: true, capEnd: true }), M.gold, crown);
        this._ball(`spirePearl${i}_${s}`, [tip.x, tip.y + 0.002, tip.z], 0.0026 + (i === 0 ? 0.0012 : 0), M.pale, crown, null, 8);
        if (i % 2 === 0) this._ball(`spireGem${i}_${s}`, bandPt(a, 0.004, 0.0015), i === 0 ? 0.0042 : 0.0026, M.gem, crown, [1, 1.3, 0.6], 8);
        // filigree between spires: a small scroll loop
        const a2 = s * (a0 + 0.15);
        if (a0 < 2.9) {
          const c0 = bandPt(a2, 0.018, 0.001), r = 0.0045;
          const o2 = new Vec(Math.sin(a2), 0, Math.cos(a2)), t2 = new Vec(Math.cos(a2), 0, -Math.sin(a2));
          this._cord(`crownScroll${i}_${s}`, Array.from({ length: 13 }, (_, k) => {
            const ang = -Math.PI / 2 + k / 12 * 1.6 * TAU, rr = r * (1 - 0.7 * k / 12);
            const p = new Vec(...c0).add(t2.scale(Math.cos(ang) * rr)).add(new Vec(0, Math.sin(ang) * rr + r, 0)).add(o2.scale(0.0005));
            return [p.x, p.y, p.z];
          }), 0.0009, M.gold, crown, 4);
        }
      }));
    }

    // --------------------------------------------------------- arms
    _buildArms(torso, M, L) {
      this.parts.arms = {};
      ['R', 'L'].forEach((side) => {
        const s = side === 'R' ? 1 : -1;
        const arm = this._node(`arm${side}`, torso, SHOULDER[side], false);
        arm.rotationQuaternion = Q.Identity();
        const fore = this._node(`fore${side}`, arm, [0, -L1, 0], false);
        fore.rotationQuaternion = Q.Identity();
        const hand = this._node(`hand${side}`, fore, [0, -L2, 0]);
        hand.rotationQuaternion = Q.Identity();
        this.parts[`arm${side}`] = arm; this.parts[`fore${side}`] = fore;
        // puffed upper sleeve: pleated, with gold bands at both ends
        this._surf(`puff${side}`, sweep(28, 16, (t) => [s * 0.004 * (1 - t), lerp(0.024, -0.098, t), 0], (t, a) => {
          const r = curve([[0, 0.012], [0.12, 0.04], [0.4, 0.054], [0.75, 0.046], [1, 0.024]], t)[0] * (1 + 0.075 * Math.cos(12 * a) * Math.sin(Math.PI * t));
          return [r * Math.cos(a), r * Math.sin(a)];
        }, { side: [1, 0, 0], capStart: true }), M.sleeve, arm);
        this._cord(`puffBand${side}`, this._ring((a) => [0.027 * Math.cos(a), -0.094, 0.027 * Math.sin(a)], 24), 0.0035, M.gold, arm, 6);
        for (let k = 0; k < 6; k++) {                          // jewels studding the puff's pleat seams
          const a = k / 6 * TAU;
          this._ball(`puffGem${side}${k}`, [0.056 * Math.cos(a), -0.035, 0.056 * Math.sin(a)], 0.0035, M.gem, arm, null, 6);
        }
        this._cord(`upperSleeve${side}`, [[0, -0.09, 0], [0, -0.13, 0], [0, -L1 + 0.012, 0]], [[0, 0.027], [1, 0.03]], M.sleeve, arm, 16);
        this._ball(`elbow${side}`, [0, -L1, 0], 0.021, M.velvet, arm, null, 12);
        // forearm: fitted sleeve and a lace ruffle at the wrist
        this._cord(`foreSleeve${side}`, [[0, 0.004, 0], [0, -0.06, 0], [0, -L2 + 0.02, 0]], [[0, 0.02], [1, 0.0155]], M.velvet, fore, 14);
        this._cord(`cuffBand${side}`, this._ring((a) => [0.0165 * Math.cos(a), -L2 + 0.024, 0.0165 * Math.sin(a)], 20), 0.0022, M.gold, fore, 5);
        this._surf(`ruffle${side}`, grid(32, 3, (u, v) => {
          const a = u * TAU, r = lerp(0.016, 0.027, v) * (1 + 0.12 * Math.sin(a * 9) * v);
          return [r * Math.cos(a), lerp(-L2 + 0.022, -L2 + 0.004, v), r * Math.sin(a), u * 2, 0.1 + 0.8 * v];
        }, { closed: true }), M.lace, fore);
        // long hanging over-sleeve from the elbow (kept hanging by _tick)
        const hang = this._node(`hang${side}`, fore, [0, 0.004, 0], false);
        hang.rotationQuaternion = Q.Identity();
        this._buildHangingSleeve(hang, s, M);
        this._buildHand(hand, s, M, side);
        this.parts.arms[side] = { arm, fore, hand, hang, s, S: new Vec(...SHOULDER[side]) };
      });
    }

    // Open over-sleeve: a cone hanging from the elbow, slit at the front,
    // longer behind, lined in a lighter satin and bordered in gold.
    _buildHangingSleeve(hang, s, M) {
      const OPEN = 0.95;
      const pt = (u, v, l) => {
        const a = Math.PI + (2 * u - 1) * (Math.PI - OPEN / 2);  // round from one slit edge via the back
        const back = Math.max(0, -Math.cos(a));
        const len = 0.2 + 0.1 * back;
        const r = lerp(0.029, 0.078, Math.pow(v, 0.8)) * (1 + 0.06 * Math.sin(a * 7) * v) + (l || 0);
        return [s * 0.004 + r * Math.sin(a), 0.01 - len * v, r * Math.cos(a) - 0.006 * v, u, 1 - v];
      };
      this._surf('overSleeve', grid(30, 18, (u, v) => pt(u, v, 0)), M.sleeve, hang);
      this._surf('overSleeveLining', grid(30, 18, (u, v) => pt(u, v, -0.002), { inward: true }), M.lining, hang);
      this._cord('overSleeveHem', Array.from({ length: 31 }, (_, i) => pt(i / 30, 1, 0.0005).slice(0, 3)), 0.0026, M.gold, hang, 5);
      [0, 1].forEach((u) => this._cord(`overSleeveEdge${u}`, Array.from({ length: 13 }, (_, j) => pt(u, j / 12, 0).slice(0, 3)), 0.0022, M.gold, hang, 5));
    }

    // Hand in hand space: wrist at the origin, fingers along -y, palm facing
    // +z, the thumb on the +x side for the right hand (s = 1), -x for the left.
    _buildHand(hand, s, M, side) {
      const skin = M.skin;
      // palm: a flattened superellipsoid, cupped a little
      this._surf(`palm${side}`, grid(18, 12, (u, v) => {
        const a = u * TAU, y = lerp(0.004, -0.064, v), k = Math.sin(Math.PI * clamp(v * 1.08, 0, 1));
        const hw = lerp(0.0135, 0.0205, smoothstep(0, 0.6, v)) * (0.55 + 0.45 * Math.pow(k, 0.3));
        const ht = 0.0085 * (0.6 + 0.4 * Math.pow(k, 0.3));
        return [hw * spow(Math.cos(a), 0.7) + s * 0.002 * v, y, ht * spow(Math.sin(a), 0.7) - 0.002 * Math.sin(Math.PI * v)];
      }, { closed: true, capStart: true, capEnd: true }), skin, hand);
      const grip = side === 'L';
      const X = [0.0135, 0.0045, -0.0045, -0.0135].map((x) => s * x);
      const LEN = [0.041, 0.046, 0.043, 0.034];
      const C = new Vec(0, -0.052, 0.018);                      // grip axis (along x) for the scepter
      this.parts[`grip${side}`] = C;
      X.forEach((x, i) => {
        const k0 = new Vec(x, -0.061, 0.0005 * i);
        let pts;
        if (grip) {
          // wrap round the shaft: spiral from the knuckle closing on the grip axis
          const rel = k0.subtract(new Vec(x, C.y, C.z)), r0 = Math.hypot(rel.y, rel.z);
          const psi0 = Math.atan2(rel.z, -rel.y), rw = 0.0128, sweepA = LEN[i] / ((r0 + rw) / 2) * 0.95;
          pts = Array.from({ length: 9 }, (_, j) => {
            const t = j / 8, psi = psi0 + sweepA * t, r = lerp(r0, rw, smoothstep(0, 0.45, t));
            return [x - s * 0.0015 * t * (i - 1.5), C.y - Math.cos(psi) * r, C.z + Math.sin(psi) * r];
          });
        } else {
          // resting flat: gently curved, spread a little
          const curl = [0.12, 0.22, 0.18], seg = [0.46, 0.3, 0.24], spread = (i - 1.5) * 0.06 * s;
          pts = [[k0.x, k0.y, k0.z]];
          let p = k0.clone(), ang = 0;
          for (let j = 0; j < 3; j++) {
            ang += curl[j];
            const d = new Vec(Math.sin(spread) * Math.cos(ang), -Math.cos(spread) * Math.cos(ang), Math.sin(ang));
            p = p.add(d.scale(LEN[i] * seg[j]));
            pts.push([p.x, p.y, p.z]);
          }
        }
        const r0 = [0.0055, 0.0056, 0.0053, 0.0047][i];
        this._cord(`finger${side}${i}`, pts, [[0, r0], [0.45, r0 * 0.88], [0.5, r0 * 0.92], [0.78, r0 * 0.78], [0.82, r0 * 0.82], [0.96, r0 * 0.7], [1, r0 * 0.35]], skin, hand, 8);
        if (!grip && i === 2) {                                  // a jewelled ring
          const p = new Vec(...pts[1]).add(new Vec(...pts[0])).scale(0.5);
          this._cord(`ring${side}`, this._ring((a) => [p.x + 0.0062 * Math.cos(a), p.y, p.z + 0.0062 * Math.sin(a)], 14), 0.0012, M.gold, hand, 4);
          this._ball(`ringGem${side}`, [p.x, p.y, p.z - 0.006], 0.0024, M.gem, hand, null, 6);
        }
      });
      // thumb
      const tb = grip
        ? [[s * 0.012, -0.012, 0.006], [s * 0.02, -0.03, 0.018], [s * 0.016, -0.046, 0.032], [s * 0.006, -0.056, 0.036]]
        : [[s * 0.012, -0.012, 0.004], [s * 0.022, -0.028, 0.008], [s * 0.028, -0.043, 0.01], [s * 0.03, -0.055, 0.009]];
      this._cord(`thumb${side}`, tb, [[0, 0.009], [0.35, 0.0065], [0.7, 0.0058], [0.95, 0.0045], [1, 0.0025]], skin, hand, 8);
      // wrist
      this._cord(`wrist${side}`, [[0, 0.03, 0], [0, 0.0, 0], [0, -0.012, 0]], [[0, 0.0135], [1, 0.012]], skin, hand, 10, 0.72);
    }

    // --------------------------------------------------------- scepter
    // Gold shaft wound with a pale-gold spiral, a jewelled knop, and a head
    // of four curling arms caging a crystal orb circled by two rings.
    _buildScepter(M, L, team) {
      const A = this.parts.arms.L, s = A.s;
      const C = this.parts.gripL;
      const scepter = this._node('weapon', A.hand, [C.x, C.y, C.z], false);
      // scepter +y along the hand's thumb side (-x for the left hand)
      scepter.rotationQuaternion = quatOf([new Vec(0, -s, 0), new Vec(s, 0, 0), new Vec(0, 0, 1)]);
      this.parts.weapon = scepter;
      const body = this._node('scepterBody', scepter, null);
      const gold = M.gold, pale = M.pale;
      const Y0 = -0.19, Y1 = 0.29;
      const SH = [[Y0, 0.004], [Y0 + 0.03, 0.0065], [-0.05, 0.0062], [0.05, 0.0062], [0.2, 0.0058], [Y1, 0.0065]];
      this._surf('shaft', sweep(12, 30, (t) => [0, lerp(Y0, Y1, t), 0], (t, a) => {
        const r = curve(SH, lerp(Y0, Y1, t))[0];
        return [r * Math.cos(a), r * Math.sin(a)];
      }, { side: [1, 0, 0] }), gold, body);
      // spiral
      const TURNS = 7;
      this._cord('spiral', Array.from({ length: 90 }, (_, k) => {
        const t = k / 89, a = t * TURNS * TAU, y = lerp(-0.15, 0.25, t);
        return [0.0072 * Math.cos(a), y, 0.0072 * Math.sin(a)];
      }), 0.0015, pale, body, 5);
      // pommel and finial point
      this._ball('pommel', [0, Y0 - 0.004, 0], 0.011, gold, body, [1, 0.8, 1], 12);
      this._surf('pommelPoint', sweep(8, 4, (t) => [0, lerp(Y0 - 0.012, Y0 - 0.035, t), 0], (t, a) => {
        const r = 0.0065 * (1 - t);
        return [r * Math.cos(a), r * Math.sin(a)];
      }, { capEnd: true }), gold, body);
      // knops with jewels
      [[-0.07, 0.0105], [0.07, 0.0105], [0.19, 0.012]].forEach(([y, r], i) => {
        this._ball(`knop${i}`, [0, y, 0], r, gold, body, [1, 0.55, 1], 12);
        for (let k = 0; k < 4; k++) {
          const a = k / 4 * TAU + i;
          this._ball(`knopGem${i}_${k}`, [Math.cos(a) * r * 0.95, y, Math.sin(a) * r * 0.95], 0.0028, M.gem, body, null, 6);
        }
      });
      // head: collar cup and four curling arms caging the orb
      const OY = 0.345;
      this._surf('headCup', sweep(16, 6, (t) => [0, lerp(Y1 - 0.01, Y1 + 0.02, t), 0], (t, a) => {
        const r = lerp(0.007, 0.017, Math.pow(t, 0.7));
        return [r * Math.cos(a), r * Math.sin(a)];
      }, { capStart: true }), gold, body);
      for (let k = 0; k < 4; k++) {
        const a = k / 4 * TAU + Math.PI / 4, o = new Vec(Math.cos(a), 0, Math.sin(a));
        const P = (r, y) => [o.x * r, y, o.z * r];
        const pts = [P(0.014, Y1 + 0.018), P(0.03, OY - 0.02), P(0.034, OY + 0.008), P(0.024, OY + 0.035), P(0.008, OY + 0.05), P(0.002, OY + 0.058)];
        this._cord(`cageArm${k}`, pts, [[0, 0.0034], [0.5, 0.0026], [1, 0.0014]], gold, body, 6);
        // outward curl on each arm
        const cc = new Vec(...P(0.036, OY - 0.004)), t2 = new Vec(0, 1, 0);
        this._cord(`cageCurl${k}`, Array.from({ length: 12 }, (_, j) => {
          const ang = Math.PI + j / 11 * 1.5 * TAU, rr = 0.007 * (1 - 0.7 * j / 11);
          const p = cc.add(o.scale(0.007 + Math.cos(ang) * rr)).add(t2.scale(Math.sin(ang) * rr));
          return [p.x, p.y, p.z];
        }), 0.0013, gold, body, 4);
        this._ball(`cageGem${k}`, P(0.033, OY - 0.014), 0.003, M.gem, body, null, 6);
      }
      // finial: a small four-point star over the cage
      const star = this._node('scepterStar', scepter, [0, OY + 0.066, 0], false);
      [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]].forEach((d, k) => {
        this._surf(`starRay${k}`, sweep(4, 3, (t) => [d[0] * 0.016 * t, d[1] * 0.016 * t, 0], (t, a) => {
          const r = 0.0035 * (1 - t);
          return [r * Math.cos(a), r * 0.5 * Math.sin(a)];
        }, { side: [0, 0, 1], capEnd: true }), pale, star);
      });
      this.parts.star = star;
      // orb: bright core inside a faceted crystal shell, two gyroscope rings
      const orb = this._node('orb', scepter, [0, OY + 0.012, 0], false);
      this.parts.orb = orb;
      const core = BABYLON.MeshBuilder.CreateSphere(`orbCore_${this.id}`, { diameter: 0.028, segments: 12 }, this.scene);
      core.parent = orb; core.isPickable = false; core.material = M.orb;
      this.parts.orbCore = core;
      const shellMat = this._glowMat('orbShell', hex(this._magic).scale(0.7), 0.45);
      shellMat.alphaMode = BABYLON.Engine.ALPHA_ADD;
      const shell = BABYLON.MeshBuilder.CreateIcoSphere(`orbShell_${this.id}`, { radius: 0.022, subdivisions: 1, flat: true }, this.scene);
      shell.parent = orb; shell.isPickable = false; shell.material = shellMat;
      this.parts.orbShell = shell;
      const ringMat = this._glowMat('orbRing', C3.Lerp(hex(team.accent), C3.White(), 0.3).scale(0.9));
      this.parts.orbRings = [0.031, 0.036].map((d, k) => {
        const r = BABYLON.MeshBuilder.CreateTorus(`orbRing${k}_${this.id}`, { diameter: 2 * d, thickness: 0.0022, tessellation: 40 }, this.scene);
        r.parent = orb; r.isPickable = false; r.material = ringMat;
        r.rotation.set(k ? 1.1 : 0.4, 0, k ? 0.3 : -0.5);
        return r;
      });
      // flare: a billboard glow around the orb that blooms when she casts
      const flare = BABYLON.MeshBuilder.CreatePlane(`orbFlare_${this.id}`, { size: 0.16 }, this.scene);
      flare.parent = orb; flare.isPickable = false; flare.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      flare.material = this._flareMat('orbFlareMat', this._magic);
      flare.material.alpha = 0.55;
      this.parts.orbFlare = flare;
      if (this.ctx && this.ctx.glow) this.ctx.glow.addExcludedMesh(flare);
      this.parts.eyeGlows.forEach((g) => this.ctx && this.ctx.glow && this.ctx.glow.addExcludedMesh(g.flare));
      this._flare = 0;          // 0 at rest -> 1 blazing (see _setBlaze)
    }

    // --------------------------------------------------------- posing
    // Arm pose: wrist targets and hand orientations in torso space.
    _restPose() {
      const s = -1;
      return {
        L: { W: new Vec(-0.17, 0.655, 0.12), pole: new Vec(-1, -0.2, -0.6),
          H: quatOf(frameXZ(new Vec(s * -0.08, s * 1, s * 0.02), new Vec(0.9, 0.1, 0.45))) },
        R: { W: new Vec(0.072, 0.612, 0.05), pole: new Vec(1, 0.1, -0.7),
          H: quatOf(frameYZ(new Vec(0.9, 0.35, 0.05), new Vec(0.15, 0, -1))) }
      };
    }

    // Two-bone IK: place the elbow on the pole side, aim upper arm, forearm
    // and hand (all in torso space) and write local rotations.
    _solveArm(side, P) {
      const A = this.parts.arms[side];
      const S = A.S;
      let d = P.W.subtract(S);
      const dist = clamp(d.length(), 0.03, L1 + L2 - 1e-4);
      d.normalize();
      const a = (L1 * L1 + dist * dist - L2 * L2) / (2 * dist), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      let pole = P.pole.subtract(d.scale(Vec.Dot(P.pole, d)));
      if (pole.lengthSquared() < 1e-8) pole = new Vec(A.s, 0, -1);
      pole.normalize();
      const E = S.add(d.scale(a)).add(pole.scale(h));
      const W = S.add(d.scale(dist));
      const armAxes = frameYZ(S.subtract(E), new Vec(0, 0, 1).add(pole.scale(-0.3)));
      const Am = axesM(...armAxes);
      A.arm.rotationQuaternion = Q.FromRotationMatrix(Am);
      const foreAxes = frameYZ(E.subtract(W), armAxes[2]);
      const Fm = axesM(...foreAxes);
      A.fore.rotationQuaternion = localQ(Fm, Am);
      A.hand.rotationQuaternion = localQ(rotM(P.H), Fm);
      A.foreWorld = Fm;
    }
    _applyArms(pose) {
      this._curPose = pose;
      this._solveArm('L', pose.L);
      this._solveArm('R', pose.R);
    }
    static _mixArm(a, b, t) {
      return { W: Vec.Lerp(a.W, b.W, t), pole: Vec.Lerp(a.pole, b.pole, t).normalize(), H: Q.Slerp(a.H, b.H, t) };
    }
    _armsTo(pose, ms, ease) {
      const from = this._curPose;
      return Tween.run(ms, (t) => this._applyArms({ L: QueenCharacter._mixArm(from.L, pose.L, t), R: QueenCharacter._mixArm(from.R, pose.R, t) }),
        ease || Ease.inOutCubic);
    }
    // Left-arm pose aiming the scepter along `dir` (torso space) from a
    // nearly straight arm.
    _aimPose(dir, reach) {
      const s = -1, S = this.parts.arms.L.S, d = dir.normalizeToNew();
      return {
        W: S.add(d.scale((L1 + L2) * (reach || 0.93))), pole: new Vec(-0.4, -1, -0.3),
        H: quatOf(frameXZ(d.scale(s), new Vec(0.8, 0.2, 0).add(d.scale(-0.2))))
      };
    }
    _toTorso(worldPos) {
      const inv = this.parts.torso.getWorldMatrix().clone().invert();
      return Vec.TransformCoordinates(worldPos, inv);
    }

    // Blaze level 0..1: eyes, orb flare, sparkles and a light on the orb.
    _setBlaze(k) {
      this._flare = k;
      const P = this.parts;
      P.eyeGlows.forEach((g) => {
        g.node.setEnabled(k > 0.02);
        g.flare.scaling.setAll(0.3 + 1.2 * k);
        g.flare.material.alpha = 0.9 * k;
        g.cap.material.emissiveColor = C3.Lerp(hex(this.L.iris), hex(this.L.eyeGlow), k).scale(0.4 + 0.8 * k);
      });
      P.orbFlare.scaling.setAll(1 + 7 * k);
      P.orbFlare.material.alpha = 0.55 + 0.45 * k;
      P.orbCore.scaling.setAll(1 + 0.8 * k);
      if (this._sparkles) this._sparkles.setLevel(1 + 5 * k);
      const q = this.ctx && this.ctx.quality;
      if (k > 0.02 && !this._orbLight && !(q && q.shadows === 0)) {
        const fx = this.ctx && this.ctx.effects;
        this._orbLight = fx && fx.fxLight ? fx.fxLight(`orbLight_${this.id}`) : new BABYLON.PointLight(`orbLight_${this.id}`, Vec.Zero(), this.scene);
        this._orbLight.parent = P.orb;
        this._orbLight.diffuse = hex(this._magic); this._orbLight.specular = hex(this._magic);
        this._orbLight.range = 2.5;
      }
      if (this._orbLight) {
        this._orbLight.intensity = 2.5 * k;
        if (k <= 0.02) { this._releaseOrbLight(); }
      }
    }

    _releaseOrbLight() {
      if (!this._orbLight) return;
      const fx = this.ctx && this.ctx.effects;
      if (fx && fx.releaseLight) fx.releaseLight(this._orbLight); else this._orbLight.dispose();
      this._orbLight = null;
    }

    // Per frame (also while busy): orb rings spin, the orb pulses, the
    // over-sleeves hang plumb, hair sways (streams back with `_wind`).
    _tick() {
      if (!this.parts || !this.parts.orb) return;
      const P = this.parts, t = performance.now() / 1000, ph = this.idlePhase;
      P.orbRings[0].rotation.y = t * 1.7; P.orbRings[1].rotation.y = -t * 1.2;
      P.orbShell.rotation.y = t * 0.6; P.orbShell.rotation.x = t * 0.35;
      P.star.rotation.z = Math.sin(t * 0.8) * 0.2;
      if (this._flare < 0.02) P.orbFlare.scaling.setAll(1 + 0.15 * Math.sin(t * 3.1 + ph));
      // over-sleeves: world-down in torso space, lagging a little as she moves
      ['L', 'R'].forEach((side) => {
        const A = P.arms[side];
        if (!A.foreWorld) return;
        const sway = new Vec(0.05 * Math.sin(t * 1.3 + ph + A.s), 1, 0.04 * Math.sin(t * 0.9 + ph) + 0.45 * (this._wind || 0));
        A.hang.rotationQuaternion = localQ(axesM(...frameYZ(sway, new Vec(0, 0, 1))), A.foreWorld);
      });
      const w = this._wind || 0;
      P.hairBack.rotation.x = -0.04 * Math.sin(t * 0.9 + ph) - 0.35 * w;
      P.hairLocks.forEach(({ node, s }) => {
        node.rotation.z = s * (0.05 + 0.04 * Math.sin(t * 1.1 + ph + s) + 0.12 * w);
        node.rotation.x = -0.03 * Math.sin(t * 0.8 + ph) - 0.3 * w;
      });
    }

    updateIdle(t) {
      if (this.busy) return;
      const P = this.parts, ph = this.idlePhase;
      this.visual.position.y = this.selectLift + 0.003 * Math.sin(t * 1.2 + ph);
      P.head.rotation.y = 0.14 * Math.sin(t * 0.45 + ph);
      P.head.rotation.x = 0.04 * Math.sin(t * 0.7 + ph) - 0.02;
      P.head.rotation.z = 0.03 * Math.sin(t * 0.37 + ph);
      const rest = this._restPose();
      rest.L.W.y += 0.006 * Math.sin(t * 1.1 + ph);
      rest.L.W.z += 0.004 * Math.sin(t * 0.8 + ph);
      this._applyArms(rest);
    }

    setWalking() {}

    // --------------------------------------------------------- moving
    // She flies: rises inside her aura, glides slowly with her hair and
    // sleeves streaming, then settles softly on the square.
    async moveTo(pos, style, opts) {
      opts = opts || { keepFacing: false };
      this.busy = true;
      const fx = this.ctx && this.ctx.effects, team = Config.TEAM[this.color];
      const root = this.root, from = root.position.clone();
      const dx = pos.x - from.x, dz = pos.z - from.z, dist = Math.hypot(dx, dz);
      const aura = fx && fx.magicAura ? fx.magicAura(root, { color: team.glow, color2: this.L.orb, height: 1.0 }) : null;
      this._walkAura = aura;
      if (window.ChessSound && window.ChessSound.playMagic) window.ChessSound.playMagic(0.6);
      const HOVER = 0.3, y0 = this.visual.position.y, base = this.selectLift;
      const lift = Tween.run(520, (t) => { this.visual.position.y = lerp(y0, base + HOVER, t); }, Ease.inOutCubic);
      if (dist > 1e-3) await this.faceTowards(pos, 380);
      await lift;
      if (dist > 1e-3) {
        const ms = clamp(dist * 620, 1000, 2800);
        const rest = this._restPose();
        const glide = { L: rest.L, R: { W: new Vec(0.13, 0.64, -0.02), pole: new Vec(1, -0.3, -0.6), H: quatOf(frameYZ(new Vec(0.4, 1, -0.4), new Vec(0.6, 0, 0.6))) } };
        this._armsTo(glide, 500);
        await Tween.run(ms, (t, raw) => {
          root.position.x = from.x + dx * t;
          root.position.z = from.z + dz * t;
          const speed = Math.sin(Math.PI * raw);
          this._wind = speed;
          this.visual.position.y = base + HOVER + 0.03 * Math.sin(raw * Math.PI * 2 * Math.max(1, ms / 900));
          this.visual.rotation.x = 0.1 * speed;
        }, (x) => (1 - Math.cos(Math.PI * x)) / 2);
        this._wind = 0;
        this._armsTo(this._restPose(), 450);
      }
      await Tween.run(560, (t) => {
        this.visual.position.y = lerp(base + HOVER, base, t);
        this.visual.rotation.x *= (1 - t);
      }, Ease.inOutCubic);
      this.visual.rotation.x = 0;
      if (aura) aura.stop();
      this._walkAura = null;
      if (fx && fx.dustPuff) fx.dustPuff(pos);
      if (!opts.keepFacing) await this.faceHome(TIMING.turn * 1.6);
      this.busy = false;
    }

    // --------------------------------------------------------- attack
    // Rises with her eyes alight and the scepter blazing, points it at the
    // target: comets rain down on it and four volcanoes burst up round it.
    // Resolves as the last, largest comet strikes the target.
    async playAttack(targetPos) {
      this.busy = true;
      const fx = this.ctx && this.ctx.effects, team = Config.TEAM[this.color], snd = window.ChessSound;
      const P = this.parts;
      this._attackAura = fx && fx.magicAura ? fx.magicAura(this.root, { color: team.glow, color2: this.L.orb, height: 1.2, strong: true }) : null;
      if (snd && snd.playMagic) snd.playMagic(1);
      // 1. levitate, eyes and scepter igniting; the scepter is raised high
      const raise = { L: { W: new Vec(-0.16, 0.9, 0.06), pole: new Vec(-1, -0.4, -0.3), H: quatOf(frameXZ(new Vec(0.05, -1, 0.05), new Vec(0.9, 0, 0.3))) },
        R: { W: new Vec(0.2, 0.7, 0.07), pole: new Vec(1, -0.6, -0.4), H: quatOf(frameYZ(new Vec(-0.6, 0.7, -0.3), new Vec(0.3, 0.3, 1))) } };
      const y0 = this.visual.position.y;
      this._armsTo(raise, 700, Ease.inOutCubic);
      await Tween.run(760, (t) => {
        this.visual.position.y = lerp(y0, this.selectLift + 0.42, t);
        this._wind = 0.25 * t;
        this._setBlaze(t);
        P.head.rotation.x = -0.12 * t;
      }, Ease.inOutCubic);
      await Tween.wait(160);
      // 2. point the scepter at the target
      const aimAt = this._toTorso(targetPos.add(new Vec(0, 0.25, 0)));
      const S = P.arms.L.S;
      const dir = aimAt.subtract(S);
      const aim = { L: this._aimPose(dir, 0.95), R: raise.R };
      await this._armsTo(aim, 380, Ease.outCubic);
      const orbPos = () => P.orbCore.getAbsolutePosition();
      if (fx && fx.markTarget) fx.markTarget(orbPos(), targetPos, team.glow);
      // 3. comets fall; the first impacts wake four volcanoes around the target
      let volcano = null;
      const shower = fx && fx.meteorShower ? fx.meteorShower(targetPos, {
        from: this.root.position, glow: team.glow,
        onFirstImpact: () => { if (fx.volcanoes) volcano = this._volcano = fx.volcanoes(targetPos, { glow: team.glow }); }
      }) : null;
      // hold the pointing pose, the scepter pulsing with power
      let holding = true;
      const hold = Tween.run(shower ? shower.duration : TIMING.projectile, (t, raw) => {
        if (holding) this._setBlaze(0.85 + 0.15 * Math.sin(raw * 30));
      }, Ease.linear);
      if (shower) await shower.landed; else await hold;
      holding = false;
      this._setBlaze(1);
      this._volcano = volcano;
      this.busy = false;
    }

    async playRecover() {
      this.busy = true;
      const y0 = this.visual.position.y, h0 = this.parts.head.rotation.x, w0 = this._wind || 0;
      if (this._attackAura) { this._attackAura.stop(); this._attackAura = null; }
      const volcano = this._volcano;
      this._volcano = null;
      if (volcano) Tween.wait(1500).then(() => volcano.subside());
      this._armsTo(this._restPose(), 900, Ease.inOutCubic);
      await Tween.run(950, (t) => {
        this.visual.position.y = lerp(y0, this.selectLift, t);
        this._setBlaze(1 - t);
        this.parts.head.rotation.x = h0 * (1 - t);
        this._wind = w0 * (1 - t);
      }, Ease.inOutCubic);
      this._setBlaze(0);
      this._wind = 0;
      this.busy = false;
    }

    async playVictory() {
      // raises the scepter high; the orb flashes and showers sparks
      this.busy = true;
      const fx = this.ctx && this.ctx.effects;
      const raise = { L: { W: new Vec(-0.14, 0.93, 0.05), pole: new Vec(-1, -0.4, -0.3), H: quatOf(frameXZ(new Vec(0, -1, 0.05), new Vec(0.9, 0, 0.3))) },
        R: this._restPose().R };
      await this._armsTo(raise, 420, Ease.outCubic);
      if (fx && fx.burst) fx.burst({ pos: this.parts.orbCore.getAbsolutePosition(), color1: this.L.orb, color2: '#ffffff', count: 40,
        speed: { min: 0.6, max: 1.6 }, life: 0.9, size: 0.06, gravity: [0, -0.8, 0] });
      await Tween.run(500, (t) => this._setBlaze(Math.sin(Math.PI * t) * 0.8), Ease.linear);
      this._setBlaze(0);
      await this._armsTo(this._restPose(), 420);
      this.busy = false;
    }

    // --------------------------------------------------------- death
    // She darkens into shadow, smoke swirls round her and she becomes the
    // silhouette of a black dragon with blazing eyes that flies off into
    // the sky. Resolves once she has vanished (the dragon flies on alone).
    async playDeath() {
      this.busy = true;
      const fx = this.ctx && this.ctx.effects, team = Config.TEAM[this.color];
      const mats = this.materials.map((m) => ({ m, c: m.albedoColor ? m.albedoColor.clone() : null }));
      this.setFlash(0);
      if (fx && fx.shadowSmoke) fx.shadowSmoke(this.root.position.clone());
      const y0 = this.visual.position.y;
      await Tween.run(520, (t) => {
        mats.forEach(({ m, c }) => { if (c) m.albedoColor = C3.Lerp(c, new C3(0.02, 0.015, 0.03), t); });
        this.visual.position.y = y0 + 0.12 * t;
        this._setBlaze(0);
      }, Ease.inOutCubic);
      if (fx && fx.shadowDragon) {
        fx.shadowDragon(this.root.position.clone(), this.root.rotation.y, { glow: team.glow });
      }
      const disc = this._meshes.find((m) => m.name === `base_${this.id}`);
      await Tween.run(380, (t) => {
        const s = Math.max(0.001, 1 - t);
        this.visual.scaling.set(s, s * (1 + 0.6 * t), s);
        this.visual.position.y = y0 + 0.12 + 0.3 * t;
        if (disc) disc.scaling.set(s, 1, s);
      }, Ease.inCubic);
      this.visual.setEnabled(false);
      if (disc) disc.setEnabled(false);
    }

    // Already turned to shadow: give the dragon a moment on screen.
    async dissolve() {
      this.visual.setEnabled(false);
      await Tween.wait(1100);
    }
  }

  window.Chess3D.QueenCharacter = QueenCharacter;
})();
