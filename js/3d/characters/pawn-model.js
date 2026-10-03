// PawnCharacter: the pawn ('p'), after the armoured-knight statuette — a
// foot knight in white (or blackened) plate chased with gold (a gold V down the breastplate,
// gold-edged layered pauldrons with raised haute-pieces, a brown belt with a
// round buckle and a pouch), a great helm with a gold finial, a gold cross on
// the face plate, an eye slit and breathing holes, a big mirror-bright sword
// with a gilded fuller that glints, and a large heater shield: silver field,
// black cross, and a gold lion rampant on a black escutcheon.
//
// Built from parametric surfaces on the king's skeleton (two-bone IK for the
// legs and arms, the right hand locked to the sword grip, the left to the
// shield). Every armour part is mapped into one texture atlas shared by all
// pawns of a colour, so each rigid part of the body draws in a single call.
//
// Standing: upright, the sword planted point-down at his right, the left hand
// resting on the rim of the shield standing on its point.
// Moving: he takes the shield on his arm, raises the sword high over his
// shoulder and marches with a firm, upright stride.
// Attacking: five deliberate cuts — forehand, backhand, flat, overhead and a
// lunging thrust — each leaving a trail of light and ringing on the target.
// Dying: his armour bursts apart into its plates, which fall to the floor.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const KingCharacter = window.Chess3D.KingCharacter;
  const ProceduralCharacter = window.Chess3D.ProceduralCharacter;
  const K = window.Chess3D.KingKit;
  const MB = BABYLON.MeshBuilder;
  const Vec = BABYLON.Vector3, Mat = BABYLON.Matrix, Quat = BABYLON.Quaternion;
  const { TAU, hex, V3, lerp, clamp, smoothstep, spow, curve, grid } = window.Chess3D.SurfaceKit;
  const { LEN, NODE, orth, rotOf, basis, footCycle, cruise, ink } = K;

  // ------------------------------------------------------------ skeleton
  // The body is built at the king's proportions in its own node (soles at
  // y = 0, +z forward), scaled down to pawn height and set on the team disc.
  const S = 0.66;
  const G = 0.07;
  const ANK = LEN.ankle;
  const STAND_Y = 0.537;                     // legs all but straight when standing
  const LEG_MAX = LEN.thigh + LEN.shin - 0.003;
  const SWORD = { blade: 0.64, grip: -0.052 };            // grip: hand centre, below the guard
  const BLADE_W = [[0, 0.046], [0.05, 0.044], [0.4, 0.037], [0.52, 0.03], [0.59, 0.016], [0.625, 0.004], [0.64, 0.0004]];
  const WALK = { step: 0.5, duty: 0.6, speed: 1.5, ramp: 0.12 };

  // Heater shield, shield space: +z out of the face, the straight sides run
  // from the top edge down to `mid`, then curve in to the point at `bot`.
  const SH = { top: 0.25, arch: 0.012, mid: 0.02, bot: -0.33, w: 0.175, bulge: 0.034, th: 0.012 };
  const SHY0 = SH.top + SH.arch, SHOC = (SHY0 + SH.bot) / 2;
  const ESC = { k: 0.44, cy: 0.02 };                       // escutcheon: the outline scaled about its centre
  const shieldHW = (y) => (y >= SH.mid ? SH.w : SH.w * Math.max(0, 1 - Math.pow((SH.mid - y) / (SH.mid - SH.bot), 1.8)));
  const shieldTop = (x) => SH.top + SH.arch * (1 - (x / SH.w) * (x / SH.w));
  const shieldZ = (x) => SH.bulge * (1 - (x / SH.w) * (x / SH.w));
  const shieldUV = (x, y) => [(x / SH.w + 1) / 2, 1 - (SHY0 - y) / (SHY0 - SH.bot)];
  function shieldOutline(n, k, cy) {
    const pts = [];
    for (let i = 0; i <= n; i++) { const x = lerp(-SH.w, SH.w, i / n); pts.push([x, shieldTop(x)]); }
    for (let i = 1; i <= n; i++) { const y = lerp(SH.top, SH.bot, i / n); pts.push([shieldHW(y), y]); }
    for (let i = n - 1; i >= 1; i--) { const y = lerp(SH.top, SH.bot, i / n); pts.push([-shieldHW(y), y]); }
    if (k == null) return pts;
    return pts.map(([x, y]) => [x * k, cy + (y - SHOC) * k]);
  }
  // Where the resting left hand closes on the rim, and how the carried
  // shield sits on the forearm (out along its face, down, across).
  const RIM = V3(0.07, shieldTop(0.07) + 0.004, shieldZ(0.07) - SH.th / 2);
  const CARRY = { n: 0.02, up: 0.1, x: 0.0 };

  // Great helm, face space (origin at the centre of the skull). Keys [y,
  // half-width, front depth, back depth], bottom to top.
  const HTOP = 0.113, HBOT = -0.105;
  const HELM = [[-0.105, 0.07, 0.078, 0.073], [-0.085, 0.066, 0.077, 0.07], [-0.05, 0.066, 0.08, 0.071], [-0.01, 0.067, 0.081, 0.072],
    [0.03, 0.067, 0.079, 0.072], [0.06, 0.063, 0.072, 0.068], [0.08, 0.055, 0.061, 0.06], [0.095, 0.043, 0.047, 0.047],
    [0.105, 0.028, 0.03, 0.031], [0.111, 0.012, 0.013, 0.013], [HTOP, 0, 0, 0]];
  const helmYofV = (v) => HTOP - (HTOP - HBOT) * (0.5 * v + 0.5 * (1 - Math.cos(v * Math.PI / 2)));
  function helmPoint(th, y, lift) {
    const [hw, f, b] = curve(HELM, clamp(y, HBOT, HTOP)).map((k) => Math.max(0, k));
    const c = Math.cos(th), s = Math.sin(th), e = c >= 0 ? 2.5 : 2.2, l = lift || 0;
    const x = (hw + l) * spow(s, 2 / e);
    let z = ((c >= 0 ? f : b) + l) * spow(c, 2 / e);
    const front = smoothstep(0.2, 0.7, c);
    z += 0.007 * Math.exp(-(x / 0.014) * (x / 0.014)) * front * (1 - smoothstep(0.075, 0.1, y));   // keel down the face plate
    const slit = smoothstep(0.004, 0.007, y) * (1 - smoothstep(0.015, 0.018, y)) * smoothstep(0.35, 0.55, c);
    const k = 1 - 0.07 * slit;                                                                     // eye slit groove
    return [x * k, y, z * k];
  }

  // Breastplate keys [y, half-width, front, back] in chest space.
  const CUIRASS = [[-0.17, 0.104, 0.085, 0.078], [-0.13, 0.102, 0.088, 0.077], [-0.08, 0.11, 0.098, 0.079], [-0.03, 0.12, 0.108, 0.083],
    [0.02, 0.13, 0.115, 0.087], [0.055, 0.134, 0.109, 0.089], [0.08, 0.126, 0.094, 0.085], [0.098, 0.106, 0.076, 0.071], [0.112, 0.07, 0.056, 0.057]];
  const gauss = (dx, sx, dy, sy) => Math.exp(-(dx / sx) * (dx / sx) - (dy / sy) * (dy / sy));
  function cuirassPoint(a, y, lift) {
    const [hw, zf, zb] = curve(CUIRASS, clamp(y, -0.17, 0.112)), c = Math.cos(a), s = Math.sin(a), l = lift || 0;
    const e = c >= 0 ? 2.5 : 2.2;
    const x = (hw + l) * spow(s, 2 / e);
    let z = ((c >= 0 ? zf : zb) + l) * spow(c, 2 / e);
    const ax = Math.abs(x);
    z += Math.max(0, c) * (0.01 * gauss(ax - 0.056, 0.04, y - 0.028, 0.04)
      + 0.004 * Math.exp(-(x / 0.008) * (x / 0.008)) * smoothstep(-0.16, -0.1, y) * (1 - smoothstep(0.07, 0.1, y)));
    z -= Math.max(0, -c) * 0.006 * gauss(ax - 0.055, 0.035, y - 0.04, 0.05);
    return [x, y, z];
  }

  // ------------------------------------------------------------ livery
  // White: white steel and a silver shield with a black cross. Black:
  // blackened steel and a dark shield with a red cross. Gold is the team accent.
  const LIVERY = {
    w: { steel: '#e6e9ee', field: '#c9cdd4', cross: '#16161a', inner: '#0c0c0f', mail: '#8d97aa', mailDark: '#2a2e38',
      leather: '#5e3c22', belt: '#6b4428', wood: '#6e5236', grip: '#2a1c14', gem: '#3a7bff', fuller: '#1a2436' },
    b: { steel: '#3a3d47', field: '#44464f', cross: '#8a1c2b', inner: '#0b0b0d', mail: '#555862', mailDark: '#15161a',
      leather: '#2e1f15', belt: '#3a2618', wood: '#3a2a1c', grip: '#1a120d', gem: '#ff3a3a', fuller: '#140c10' }
  };

  // ------------------------------------------------------------ atlas
  // One 1024² atlas (albedo, normal, metal/rough) per colour holds every
  // armour texture; flat colours are swatches the UVs are pinned to.
  const AT = 1024;
  const REG = {
    cuirass: [0, 0, 1024, 384], helm: [0, 384, 512, 256], limb: [512, 384, 512, 192], lame: [512, 576, 512, 128],
    shield: [0, 640, 320, 384], back: [320, 640, 192, 128], mail: [320, 768, 384, 128], belt: [320, 896, 384, 64]
  };
  const SWATCH = { gold: [704, 704, 96], plain: [816, 704, 96], dark: [928, 704, 64], leather: [704, 816, 64], grip: [784, 816, 64], wood: [864, 816, 64] };
  const ormOf = (metal, rough) => `rgb(255,${Math.round(rough * 255)},${Math.round(metal * 255)})`;

  const canvasCache = new Map();
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  // Raised relief: drawHeight paints height (white = raised) and drawAlbedo
  // the colours; outlines of the relief are engraved dark. { albedo, normal }.
  function relief(w, h, drawHeight, drawAlbedo, opts) {
    opts = opts || {};
    const H = makeCanvas(w, h), hc = H.getContext('2d');
    hc.lineCap = hc.lineJoin = 'round';
    drawHeight(hc, w, h);
    const hd = hc.getImageData(0, 0, w, h).data, hm = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) hm[i] = hd[i * 4] / 255;
    const soft = K.boxBlur(hm, w, h, opts.soft || 2);
    const A = makeCanvas(w, h), ac = A.getContext('2d');
    ac.lineCap = ac.lineJoin = 'round';
    drawAlbedo(ac, w, h);
    const ai = ac.getImageData(0, 0, w, h), N = makeCanvas(w, h), nc = N.getContext('2d'), ni = nc.createImageData(w, h);
    const bump = opts.bump || 3, lines = opts.lines == null ? 0.5 : opts.lines, noise = opts.noise == null ? 0.05 : opts.noise;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 4;
        const dx = soft[y * w + Math.min(w - 1, x + 1)] - soft[y * w + Math.max(0, x - 1)];
        const dy = soft[Math.min(h - 1, y + 1) * w + x] - soft[Math.max(0, y - 1) * w + x];
        const edge = Math.min(1, Math.hypot(dx, dy) * 3);
        const g = (1 - lines * edge) * (1 + noise * (Math.random() - 0.5) + (opts.brushed ? 0.035 * Math.sin(y * 1.9 + 3 * Math.sin(x * 0.04)) : 0));
        for (let c = 0; c < 3; c++) ai.data[o + c] = clamp(ai.data[o + c] * g, 0, 255);
        const nx = -dx * bump, ny = dy * bump, l = Math.hypot(nx, ny, 1);
        ni.data[o] = (nx / l * 0.5 + 0.5) * 255; ni.data[o + 1] = (ny / l * 0.5 + 0.5) * 255; ni.data[o + 2] = (1 / l * 0.5 + 0.5) * 255; ni.data[o + 3] = 255;
      }
    }
    ac.putImageData(ai, 0, 0); nc.putImageData(ni, 0, 0);
    return { albedo: A, normal: N };
  }

  // Breastplate/backplate: u round the torso (0.5 = front), v neck to waist.
  // C = { base, hi, lo }: background, raised gold, engraving in the gold.
  function drawCuirass(c, w, h, C) {
    c.fillStyle = C.base; c.fillRect(0, 0, w, h);
    ink(c, C.hi);
    c.fillRect(0, 0, w, h * 0.06); c.fillRect(0, h * 0.925, w, h * 0.075);
    ink(c, C.lo); K.vine(c, 0, w, h * 0.03, h * 0.014, 56, 3); K.vine(c, 0, w, h * 0.962, h * 0.018, 56, 3); ink(c, C.hi);
    K.hline(c, h * 0.085, w, 3); K.hline(c, h * 0.9, w, 3);
    const cx = w / 2;
    [-1, 1].forEach((s) => {
      c.lineWidth = 18; c.beginPath(); c.moveTo(cx + s * 150, h * 0.04);
      c.bezierCurveTo(cx + s * 138, h * 0.3, cx + s * 48, h * 0.42, cx + s * 4, h * 0.55); c.stroke();
      c.lineWidth = 4; c.beginPath(); c.moveTo(cx + s * 184, h * 0.05);
      c.bezierCurveTo(cx + s * 172, h * 0.36, cx + s * 72, h * 0.52, cx + s * 20, h * 0.64); c.stroke();
      for (let k = 0; k < 3; k++) K.spiral(c, cx + s * (100 - 28 * k), h * (0.15 + 0.1 * k), 17 - 3 * k, 1.35, s, 4, -Math.PI / 2);
      K.vvine(c, cx + s * 300, h * 0.12, h * 0.88, 16, 96, 4);
      c.lineWidth = 3; c.beginPath(); c.moveTo(cx + s * 22, h * 0.72); c.quadraticCurveTo(cx + s * 110, h * 0.76, cx + s * 150, h * 0.9); c.stroke();
      K.spiral(c, cx + s * 70, h * 0.8, 14, 1.3, -s, 3, Math.PI / 2);
    });
    c.lineWidth = 20; c.beginPath(); c.moveTo(cx, h * 0.5); c.lineTo(cx, h * 0.93); c.stroke();
    K.fleur(c, cx, h * 0.24, 34);
    [0, w].forEach((x) => {
      c.fillRect(x - 9, 0, 18, h);
      c.lineWidth = 3; c.strokeRect(x - 44, h * 0.085, 88, h * 0.815);
    });
    K.vvine(c, w * 0.25, h * 0.12, h * 0.88, 12, 90, 3); K.vvine(c, w * 0.75, h * 0.12, h * 0.88, 12, 90, 3);
  }

  // Great helm: u round the head (0.5 = front), v from the crown down.
  // C adds `hole` for the eye slit and breathing holes.
  function drawHelm(c, w, h, C) {
    const X = (th) => (th / TAU + 0.5) * w, Y = (y) => (HTOP - y) / (HTOP - HBOT) * h;
    c.fillStyle = C.base; c.fillRect(0, 0, w, h);
    ink(c, C.hi);
    c.fillRect(0, Y(-0.084), w, h - Y(-0.084));
    c.fillRect(X(-1.3), Y(0.035), X(1.3) - X(-1.3), Y(0.022) - Y(0.035));
    c.fillRect(X(0) - 5, Y(0.1), 10, Y(-0.084) - Y(0.1));
    c.fillRect(0, Y(0.1), 6, Y(-0.084) - Y(0.1)); c.fillRect(w - 6, Y(0.1), 6, Y(-0.084) - Y(0.1));
    [-1, 1].forEach((s) => {
      K.spiral(c, X(s * 1.6), Y(-0.035), 13, 1.3, s, 3, -Math.PI / 2);
      K.spiral(c, X(s * 1.95), Y(0.05), 10, 1.2, -s, 3, Math.PI / 2);
      K.leaf(c, X(s * 1.75), Y(0.005), s > 0 ? 0.7 : 2.4, 18, 6);
      K.spiral(c, X(s * 2.6), Y(-0.02), 12, 1.3, -s, 3, Math.PI / 2);
    });
    ink(c, C.lo); K.vine(c, 0, w, Y(-0.096), 3.5, 40, 2); ink(c, C.hi);
    ink(c, C.hole);
    c.lineWidth = Y(0.006) - Y(0.017); c.lineCap = 'round';
    c.beginPath(); c.moveTo(X(-1.0), Y(0.0115)); c.lineTo(X(1.0), Y(0.0115)); c.stroke();
    [-1, 1].forEach((s) => {
      for (let r = 0; r < 5; r++) for (let q = 0; q < 3; q++) c.fillRect(X(s * (0.2 + 0.17 * q)) - 4, Y(-0.02 - 0.0125 * r) - 3, 8, 6);
    });
  }

  // Lion rampant facing dexter, drawn about the origin in lion units (a
  // 100 x 120 box) times k, in the current fill/stroke colour.
  function drawLion(c, k) {
    const P = (x, y) => [(x - 50) * k, (y - 60) * k];
    const stroke = (pts, lw) => { c.lineWidth = lw * k; c.beginPath(); pts.forEach((p, i) => { const q = P(p[0], p[1]); if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]); }); c.stroke(); };
    const bez = (a, b, d, e, lw) => { c.lineWidth = lw * k; c.beginPath(); c.moveTo(...P(...a)); c.bezierCurveTo(...P(...b), ...P(...d), ...P(...e)); c.stroke(); };
    const blob = (x, y, rx, ry, rot) => { const q = P(x, y); c.beginPath(); c.ellipse(q[0], q[1], rx * k, ry * k, rot || 0, 0, TAU); c.fill(); };
    c.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = i / 24 * TAU, r = i % 2 ? 12 : 19, q = P(40 + Math.cos(a) * r, 25 + Math.sin(a) * r * 1.15);
      if (i) c.lineTo(q[0], q[1]); else c.moveTo(q[0], q[1]);
    }
    c.fill();
    bez([40, 34], [48, 50], [56, 62], [60, 80], 21);
    blob(58, 80, 12, 10, 0.5);
    blob(30, 22, 11, 10);
    blob(19, 27, 8, 6, -0.2);
    c.beginPath(); c.moveTo(...P(33, 13)); c.lineTo(...P(40, 3)); c.lineTo(...P(41, 15)); c.fill();
    stroke([[40, 38], [28, 34], [16, 24]], 7); stroke([[16, 24], [9, 19]], 3); stroke([[16, 24], [9, 26]], 3);
    stroke([[46, 48], [32, 53], [18, 47]], 7); stroke([[18, 47], [11, 42]], 3); stroke([[18, 47], [11, 50]], 3);
    stroke([[58, 86], [46, 98], [40, 112]], 9); stroke([[40, 112], [29, 115]], 6);
    stroke([[64, 88], [75, 100], [69, 114]], 9); stroke([[69, 114], [80, 117]], 6);
    bez([68, 76], [92, 74], [99, 44], [83, 30], 4);
    blob(81, 25, 5, 9, 0.6);
  }

  // Shield face: C = { field, cross, inner, gold, lion } per channel.
  function drawShield(c, w, h, C) {
    const pxX = w / (2 * SH.w), pxY = h / (SHY0 - SH.bot);
    const P = (x, y) => [(x + SH.w) * pxX, (SHY0 - y) * pxY];
    const path = (k, cy) => {
      c.beginPath();
      shieldOutline(40, k, cy).forEach(([x, y], i) => { const [px, py] = P(x, y); if (i) c.lineTo(px, py); else c.moveTo(px, py); });
      c.closePath();
    };
    c.lineCap = c.lineJoin = 'round';
    c.fillStyle = C.field; c.fillRect(0, 0, w, h);
    c.fillStyle = C.cross;
    c.fillRect(P(-0.021, 0)[0], 0, 0.042 * pxX, h);
    c.fillRect(0, P(0, 0.118)[1], w, 0.04 * pxY);
    path(ESC.k, ESC.cy); c.fillStyle = C.inner; c.fill();
    c.lineWidth = 7; c.strokeStyle = C.gold; c.stroke();
    c.save();
    const [lx, ly] = P(0, ESC.cy - 0.012);
    c.translate(lx, ly); c.scale(pxX, pxY);
    ink(c, C.lion); c.lineCap = c.lineJoin = 'round';
    drawLion(c, 0.2 / 120);
    c.restore();
    path(1, SHOC); c.lineWidth = 26; c.strokeStyle = C.gold; c.stroke();
    path(0.86, SHOC); c.lineWidth = 3; c.stroke();
    c.fillStyle = C.gold;
    shieldOutline(40, 0.93, SHOC).forEach(([x, y], i) => { if (i % 4) return; const [px, py] = P(x, y); c.beginPath(); c.arc(px, py, 4.5, 0, TAU); c.fill(); });
  }

  function drawWood(c, w, h, C) {
    c.fillStyle = C.base; c.fillRect(0, 0, w, h);
    c.strokeStyle = C.grain; c.lineWidth = 1.2;
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * w;
      c.globalAlpha = 0.3 + Math.random() * 0.4;
      c.beginPath(); c.moveTo(x, 0); c.bezierCurveTo(x + 6, h * 0.3, x - 6, h * 0.7, x + 3, h); c.stroke();
    }
    c.globalAlpha = 1; c.strokeStyle = C.seam; c.lineWidth = 3;
    for (let x = 32; x < w; x += 32) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
  }
  function drawBelt(c, w, h, C) {
    c.fillStyle = C.base; c.fillRect(0, 0, w, h);
    c.fillStyle = C.edge; c.fillRect(0, 0, w, 5); c.fillRect(0, h - 5, w, 5);
    c.fillStyle = C.stitch;
    for (let x = 2; x < w; x += 9) { c.fillRect(x, 9, 5, 2); c.fillRect(x, h - 11, 5, 2); }
  }

  function atlasCanvases(color, team, L) {
    const key = color + team.accent;
    if (canvasCache.has(key)) return canvasCache.get(key);
    const steel = L.steel, gold = team.accent, goldLo = hex(gold).scale(0.5).toHexString();
    const A = makeCanvas(AT, AT), N = makeCanvas(AT, AT), O = makeCanvas(AT, AT);
    const a = A.getContext('2d'), n = N.getContext('2d'), o = O.getContext('2d');
    a.fillStyle = steel; a.fillRect(0, 0, AT, AT);
    n.fillStyle = 'rgb(128,128,255)'; n.fillRect(0, 0, AT, AT);
    o.fillStyle = ormOf(1, 0.28); o.fillRect(0, 0, AT, AT);
    const put = (reg, pair, metal, rough) => {
      const [x, y, w, h] = REG[reg];
      a.drawImage(pair.albedo, x, y, w, h); n.drawImage(pair.normal, x, y, w, h);
      if (metal != null) { o.fillStyle = ormOf(metal, rough); o.fillRect(x, y, w, h); }
    };
    put('cuirass', relief(1024, 384, (c, w, h) => drawCuirass(c, w, h, { base: '#000', hi: '#fff', lo: '#000' }),
      (c, w, h) => drawCuirass(c, w, h, { base: steel, hi: gold, lo: goldLo }), { brushed: true }), 1, 0.27);
    put('helm', relief(512, 256, (c, w, h) => drawHelm(c, w, h, { base: '#5a5a5a', hi: '#fff', lo: '#303030', hole: '#000' }),
      (c, w, h) => drawHelm(c, w, h, { base: steel, hi: gold, lo: goldLo, hole: '#07080b' }), { brushed: true }), 1, 0.27);
    put('limb', K.embossed(`plimb${key}`, 512, 256, steel, gold, K.drawLimb, { brushed: true }), 1, 0.27);
    put('lame', K.embossed(`plame${key}`, 512, 128, steel, gold, K.drawLame, { brushed: true }), 1, 0.27);
    put('shield', relief(320, 384,
      (c, w, h) => drawShield(c, w, h, { field: '#404040', cross: '#505050', inner: '#383838', gold: '#fff', lion: '#e8e8e8' }),
      (c, w, h) => drawShield(c, w, h, { field: L.field, cross: L.cross, inner: L.inner, gold, lion: gold }), { brushed: true, lines: 0.4 }));
    o.save(); o.translate(REG.shield[0], REG.shield[1]);
    drawShield(o, REG.shield[2], REG.shield[3], { field: ormOf(0.95, 0.3), cross: ormOf(0.15, 0.5), inner: ormOf(0.15, 0.45), gold: ormOf(1, 0.22), lion: ormOf(1, 0.22) });
    o.restore();
    const wood = hex(L.wood);
    put('back', relief(192, 128, (c, w, h) => drawWood(c, w, h, { base: '#555', grain: '#444', seam: '#000' }),
      (c, w, h) => drawWood(c, w, h, { base: L.wood, grain: wood.scale(0.6).toHexString(), seam: wood.scale(0.35).toHexString() }), { lines: 0.3, noise: 0.1 }), 0, 0.8);
    put('mail', K.embossed(`pmail${key}`, 384, 128, L.mailDark, L.mail, K.drawMail, { soft: 1, lines: 0.3 }), 0.9, 0.45);
    const belt = hex(L.belt);
    put('belt', relief(384, 64, (c, w, h) => drawBelt(c, w, h, { base: '#888', edge: '#444', stitch: '#fff' }),
      (c, w, h) => drawBelt(c, w, h, { base: L.belt, edge: belt.scale(0.6).toHexString(), stitch: '#c9a877' }), { lines: 0.3, noise: 0.12 }), 0, 0.6);
    const swatch = (k, color, metal, rough) => {
      const [x, y, s] = SWATCH[k];
      a.fillStyle = color; a.fillRect(x, y, s, s);
      o.fillStyle = ormOf(metal, rough); o.fillRect(x, y, s, s);
    };
    swatch('gold', gold, 1, 0.22); swatch('plain', steel, 0.95, 0.26); swatch('dark', '#0a0a0c', 0, 0.85);
    swatch('leather', L.leather, 0, 0.62); swatch('grip', L.grip, 0, 0.7); swatch('wood', L.wood, 0, 0.8);
    const out = { albedo: A, normal: N, orm: O };
    canvasCache.set(key, out);
    return out;
  }

  // Gilded filigree down the fuller (along canvas y, tip at the top) and its glow mask.
  function fullerCanvases(color, gold, L) {
    const key = 'fuller' + color + gold;
    if (canvasCache.has(key)) return canvasCache.get(key);
    const paint = (bg, fg) => {
      const cv = makeCanvas(32, 256), c = cv.getContext('2d');
      c.fillStyle = bg; c.fillRect(0, 0, 32, 256); ink(c, fg); c.lineCap = c.lineJoin = 'round';
      K.vvine(c, 16, 4, 252, 8, 52, 2.4);
      c.lineWidth = 2; c.strokeRect(2, 2, 28, 252);
      return cv;
    };
    const out = { albedo: paint(L.fuller, gold), glow: paint('#000', '#fff') };
    canvasCache.set(key, out);
    return out;
  }

  function starCanvas() {
    if (canvasCache.has('star')) return canvasCache.get('star');
    const cv = makeCanvas(64, 64), c = cv.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, 64, 64);
    c.globalCompositeOperation = 'lighter';
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.1, 'rgba(255,255,255,0.8)');
    g.addColorStop(0.3, 'rgba(170,200,255,0.18)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    [[0, 30, 2.2], [Math.PI / 2, 30, 2.2], [Math.PI / 4, 15, 1.4], [-Math.PI / 4, 15, 1.4]].forEach(([a, len, lw]) => {
      const dx = Math.cos(a) * len, dy = Math.sin(a) * len, lg = c.createLinearGradient(32 - dx, 32 - dy, 32 + dx, 32 + dy);
      lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)');
      c.strokeStyle = lg; c.lineWidth = lw; c.beginPath(); c.moveTo(32 - dx, 32 - dy); c.lineTo(32 + dx, 32 + dy); c.stroke();
    });
    canvasCache.set('star', cv);
    return cv;
  }

  // GPU textures, shared by every pawn of a colour in a scene (a pawn's
  // dispose() leaves them alone).
  const texCache = new Map();
  function sharedTextures(scene, color, team, L) {
    const key = scene.uid + color;
    if (texCache.has(key)) return texCache.get(key);
    const mk = (name, canvas) => {
      const t = new BABYLON.DynamicTexture(`pawn_${name}_${color}`, canvas, scene, true);
      t.update();
      t.wrapU = t.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
      return t;
    };
    const atlas = atlasCanvases(color, team, L), fuller = fullerCanvases(color, team.accent, L);
    const out = { albedo: mk('albedo', atlas.albedo), normal: mk('normal', atlas.normal), orm: mk('orm', atlas.orm),
      fuller: mk('fuller', fuller.albedo), fullerGlow: mk('fullerGlow', fuller.glow), star: mk('star', starCanvas()) };
    texCache.set(key, out);
    scene.onDisposeObservable.addOnce(() => texCache.delete(key));
    return out;
  }

  // Flip a surface so its average normal faces `dir` (for open, flat-ish sheets).
  function orient(vd, dir) {
    let d = 0;
    for (let i = 0; i < vd.normals.length; i += 3) d += vd.normals[i] * dir[0] + vd.normals[i + 1] * dir[1] + vd.normals[i + 2] * dir[2];
    if (d >= 0) return vd;
    for (let k = 0; k < vd.indices.length; k += 3) { const t = vd.indices[k + 1]; vd.indices[k + 1] = vd.indices[k + 2]; vd.indices[k + 2] = t; }
    vd.normals = vd.normals.map((x) => -x);
    return vd;
  }

  // ------------------------------------------------------------ poses
  // Plain numbers: hips position/rotation, spine/chest/neck/head rotations,
  // ankle targets [x, y, z, pitch, yaw], the sword's guard and blade
  // direction [x, y, z, dx, dy, dz, roll], the shield resting on the ground
  // [x, y, z, yaw, pitch, roll], `strap` (0 = left hand on its rim, 1 =
  // carried on the forearm, the hand at handL, the face toward shieldN),
  // elbow pole directions and the blade glow. All in body space. `free` (0..1)
  // lets the left hand leave the rim for handL (thumb along thumbL) without
  // taking the shield with it: scratching, polishing, slapping.
  const FIELDS = ['hips', 'hipsRot', 'spine', 'chest', 'neck', 'head', 'footR', 'footL', 'kneeOut', 'sword', 'shield', 'strap',
    'handL', 'shieldN', 'elbowR', 'elbowL', 'glow', 'free', 'thumbL', 'freeR', 'handR', 'thumbR'];
  const flat = (P) => FIELDS.reduce((a, f) => a.concat(P[f]), []);
  function unflat(arr, like) {
    const P = {};
    let i = 0;
    FIELDS.forEach((f) => {
      if (Array.isArray(like[f])) { P[f] = arr.slice(i, i + like[f].length); i += like[f].length; } else P[f] = arr[i++];
    });
    return P;
  }
  const clonePose = (P) => unflat(flat(P), P);
  const withPose = (P, o) => Object.assign(clonePose(P), o);
  function mixPose(a, b, t) { const fa = flat(a), fb = flat(b); return unflat(fa.map((x, i) => lerp(x, fb[i], t)), a); }

  // Highest the hips can sit with the leg reaching the ankle target `f`
  // (the knee just short of locking).
  function legReach(P, f, s) {
    const dx = f[0] - (P.hips[0] + s * NODE.hip[0]), dz = f[2] - P.hips[2];
    return f[1] + Math.sqrt(Math.max(0, LEG_MAX * LEG_MAX - dx * dx - dz * dz)) - NODE.hip[1];
  }

  // Sword held with the hand at `h`, the blade along `d`.
  function swordAt(h, d, roll) {
    const D = V3(d[0], d[1], d[2]).normalize();
    return [h[0] - D.x * SWORD.grip, h[1] - D.y * SWORD.grip, h[2] - D.z * SWORD.grip, D.x, D.y, D.z, roll || 0];
  }
  // Planted point-down with the tip at `tip`.
  function planted(tip, d) {
    const D = V3(d[0], d[1], d[2]).normalize(), g = V3(tip[0], tip[1], tip[2]).subtract(D.scale(SWORD.blade));
    return [g.x, g.y, g.z, D.x, D.y, D.z, 0];
  }

  function restPose() {
    return {
      hips: [0, STAND_Y, 0], hipsRot: [0, 0, 0], spine: [0.01, 0, 0], chest: [-0.05, 0, 0], neck: [0, 0, 0], head: [0.04, 0, 0],
      footR: [0.105, ANK, 0.02, 0, 0.16], footL: [-0.105, ANK, 0, 0, -0.16], kneeOut: 0.25,
      sword: planted([0.21, 0.003, 0.25], [0.03, -1, 0.12]), shield: [-0.14, 0.325, 0.22, -0.18, -0.1, 0], strap: 0,
      handL: [0.02, 0.66, 0.2], shieldN: [0.1, 0, 1], elbowR: [1, -0.5, -0.6], elbowL: [-1, -0.3, -0.5], glow: 0,
      free: 0, thumbL: [0.3, 1, 0.25], freeR: 0, handR: [0.2, 0.6, 0.1], thumbR: [0, 1, 0.3]
    };
  }
  // Marching: shield on the arm before him, sword raised high over the shoulder.
  function marchPose() {
    return withPose(restPose(), {
      spine: [0, 0, 0], chest: [-0.07, 0, 0], head: [0.03, 0, 0],
      footR: [0.1, ANK, 0.0, 0, 0.1], footL: [-0.1, ANK, 0, 0, -0.1],
      sword: swordAt([0.23, 0.99, 0.07], [0.2, 0.8, -0.56], 0.3), strap: 1,
      elbowR: [1, -0.2, 0.2], elbowL: [-1, -0.5, -0.2], glow: 0.15
    });
  }
  function guardPose() {
    return withPose(marchPose(), {
      hips: [0, 0.505, 0], hipsRot: [0, 0.15, 0], spine: [0.05, 0.05, 0], chest: [0.02, 0.06, 0], head: [0.04, -0.15, 0],
      footR: [0.11, ANK, 0.1, 0, 0.2], footL: [-0.12, ANK, -0.12, 0, -0.35], kneeOut: 0.35,
      sword: swordAt([0.2, 0.86, 0.2], [0.12, 0.8, 0.58], 0), handL: [0.0, 0.7, 0.26], shieldN: [0.25, 0, 1],
      elbowR: [1, -0.5, -0.3], glow: 0.6
    });
  }

  // ------------------------------------------------------------ character
  class PawnCharacter extends KingCharacter {
    _makeMats() { return {}; }

    async build() {
      await ProceduralCharacter.prototype.build.call(this);
      this._stance = 'rest';
      this._applyPose(restPose());
      this._startGlint();
    }

    // A game animation taking over (move, attack, hit...) cuts an idle fidget
    // short; see pawn-fidgets.js.
    get busy() { return this._busy; }
    set busy(v) {
      if (v && this._fid) this._endFidget(false);
      super.busy = v;
    }

    tickProxy(now, allowHeavy) {
      return this._fid ? false : super.tickProxy(now, allowHeavy);   // a fidgeting pawn draws live
    }

    setSelected(on) {
      if (on && this._fid) this._endFidget(true);
      super.setSelected(on);
    }

    dispose() {
      if (this._fid) this._endFidget(false);
      // What CharacterBase.dispose() does first (not called from here): leave
      // the instance pool, and drop pool sources cloned from this pawn.
      this._showLive();
      if (window.Chess3D.InstancePool) window.Chess3D.InstancePool.forget(this);
      if (this._glintObs) { this.scene.onBeforeRenderObservable.remove(this._glintObs); this._glintObs = null; }
      if (this._trail) { this._trail.dispose(); this._trail = null; }
      this.alive = false;
      const glow = this.ctx && this.ctx.glow;
      if (glow) this._glowExcluded.forEach((m) => glow.removeExcludedMesh(m));
      this._glowExcluded = [];
      const mats = this.materials.concat(this._ownMats || []);
      this.root.dispose(false, false);
      mats.forEach((m) => m.dispose(false, false));          // the textures are shared
    }

    // ---------------------------------------------------------- build
    _buildSoldier(team) {
      const scene = this.scene, L = this.L = LIVERY[this.color] || LIVERY.w;
      this._pivots = [];
      const tex = sharedTextures(scene, this.color, team, L);
      this._texShared = tex;
      // Placeholder materials name the atlas region each part is mapped into;
      // _atlasize() swaps them all for the one armour material.
      const M = this.pMats = {};
      ['cuirass', 'helm', 'limb', 'lame', 'shield', 'back', 'mail', 'belt', 'gold', 'plain', 'dark', 'leather', 'grip', 'wood'].forEach((k) => {
        const m = new BABYLON.StandardMaterial(`ph_${k}_${this.id}`, scene);
        m.metadata = { atlas: k };
        M[k] = m;
      });
      const armor = this._atlasMat = new BABYLON.PBRMaterial(`pawnArmor_${this.id}`, scene);
      armor.albedoTexture = tex.albedo; armor.bumpTexture = tex.normal; armor.bumpTexture.level = 0.85;
      armor.metallicTexture = tex.orm; armor.useRoughnessFromMetallicTextureGreen = true; armor.useMetallnessFromMetallicTextureBlue = true;
      armor.useAmbientOcclusionFromMetallicTextureRed = false; armor.metallic = 1; armor.roughness = 1; armor.maxSimultaneousLights = 8;
      this.materials.push(armor);
      // Blade and fuller are driven by the attack glow, so they stay out of setFlash's list.
      M.blade = new BABYLON.PBRMaterial(`pawnBlade_${this.id}`, scene);
      M.blade.albedoColor = hex('#eef3fa'); M.blade.metallic = 1; M.blade.roughness = 0.1; M.blade.maxSimultaneousLights = 8;
      M.fuller = new BABYLON.PBRMaterial(`pawnFuller_${this.id}`, scene);
      M.fuller.albedoTexture = tex.fuller; M.fuller.emissiveTexture = tex.fullerGlow; M.fuller.metallic = 0.85; M.fuller.roughness = 0.25;
      M.fuller.backFaceCulling = false; M.fuller.twoSidedLighting = true; M.fuller.maxSimultaneousLights = 8;
      this._ownMats = [M.blade, M.fuller];
      M.gem = new BABYLON.StandardMaterial(`pawnGem_${this.id}`, scene);
      M.gem.diffuseColor = hex(L.gem).scale(0.3); M.gem.emissiveColor = hex(L.gem).scale(0.6);
      M.gem.specularColor = new BABYLON.Color3(1, 1, 1); M.gem.specularPower = 128;
      this.materials.push(M.gem);
      this._glowColor = hex(team.glow);
      this._goldColor = hex(team.accent);

      // --- skeleton ---
      const R = this.rig = {};
      R.base = this._node('body', this.visual, [0, G, 0]);
      R.base.scaling.setAll(S);
      R.hips = this._node('hips', R.base, [0, STAND_Y, 0]);
      R.spine = this._node('spine', R.hips, NODE.spine);
      R.chest = this._node('chest', R.spine, NODE.chest);
      R.neck = this._node('neck', R.chest, NODE.neck);
      R.head = this._node('head', R.neck, NODE.head);
      R.face = this._node('face', R.head, NODE.face);
      ['R', 'L'].forEach((side) => {
        const s = side === 'R' ? 1 : -1;
        R['arm' + side] = this._node('arm' + side, R.chest, [s * NODE.shoulder[0], NODE.shoulder[1], NODE.shoulder[2]]);
        R['shoulder' + side] = this._node('shoulder' + side, R.chest, [s * NODE.shoulder[0], NODE.shoulder[1], NODE.shoulder[2]]);
        R['fore' + side] = this._node('fore' + side, R['arm' + side], [0, -LEN.upper, 0]);
        R['hand' + side] = this._node('hand' + side, R['fore' + side], [0, -LEN.fore, 0]);
        R['thigh' + side] = this._node('thigh' + side, R.hips, [s * NODE.hip[0], NODE.hip[1], NODE.hip[2]]);
        R['shin' + side] = this._node('shin' + side, R['thigh' + side], [0, -LEN.thigh, 0]);
        R['foot' + side] = this._node('foot' + side, R['shin' + side], [0, -LEN.shin, 0]);
      });
      // Separate plates (each draws on its own and flies off on its own when he dies).
      R.breast = this._node('breast', R.chest);
      R.back = this._node('backplate', R.chest);
      R.gorget = this._node('gorget', R.chest);
      R.fauld = this._node('fauld', R.spine);
      R.belt = R.fauld;
      R.sword = this._node('sword', R.base);
      R.shield = this._node('shield', R.base);
      this.parts.torso = R.hips;
      this.parts.head = R.head;

      this._buildLegs(R, M);
      this._buildPawnPelvis(R, M);
      this._buildPawnTorso(R, M);
      this._buildPawnArms(R, M);
      this._buildHelm(R.face, M);
      this._buildPawnSword(R.sword, M);
      this._buildShield(R.shield, M);
      this._atlasize();
      this.parts.extraPivots = this._pivots;
    }

    // Re-map every placeholder-material mesh's UVs into its atlas region (or
    // pin them to its swatch) and give it the shared armour material.
    _atlasize() {
      const armor = this._atlasMat;
      this._meshes.forEach((m) => {
        const key = m.material && m.material.metadata && m.material.metadata.atlas;
        if (!key) return;
        const uv = m.getVerticesData(BABYLON.VertexBuffer.UVKind);
        if (uv) {
          const out = new Array(uv.length);
          if (SWATCH[key]) {
            const [x, y, s] = SWATCH[key], U = (x + s / 2) / AT, V = 1 - (y + s / 2) / AT;
            for (let i = 0; i < uv.length; i += 2) { out[i] = U; out[i + 1] = V; }
          } else {
            const [x, y, w, h] = REG[key];
            for (let i = 0; i < uv.length; i += 2) {
              out[i] = (x + 1 + clamp(uv[i], 0, 1) * (w - 2)) / AT;
              out[i + 1] = 1 - (y + 1 + (1 - clamp(uv[i + 1], 0, 1)) * (h - 2)) / AT;
            }
          }
          m.setVerticesData(BABYLON.VertexBuffer.UVKind, out, false);
        }
        m.material = armor;
      });
      // Only the atlas placeholders are gone now; the blade, fuller, gems etc.
      // are still on their meshes (disposing them left the sword with no material).
      Object.values(this.pMats).forEach((ph) => { if (ph.metadata && ph.metadata.atlas) ph.dispose(); });
      this.pMats = null;
    }

    _buildPawnPelvis(R, M) {
      // mail skirt under the fauld
      this._surf('mailSkirt', grid(28, 6, (u, v) => {
        const a = (u - 0.5) * TAU, c = Math.cos(a), bottom = -0.1 + 0.03 * Math.pow(Math.max(0, c), 2);
        const y = lerp(0.07, bottom, v), fl = 1 + 0.16 * v;
        return [0.108 * fl * Math.sin(a), y, (c >= 0 ? 0.09 : 0.098) * fl * c, u, 1 - v];
      }, { closed: true }), M.mail, R.hips);
      // fauld: three lames flaring over the hips, cut high at the front
      for (let k = 0; k < 3; k++) {
        const top = -0.004 - 0.03 * k, g = 1.05 + 0.05 * k;
        const pt = (u, v) => {
          const a = (u - 0.5) * TAU, c = Math.cos(a);
          const bottom = top - 0.044 + 0.03 * Math.pow(Math.max(0, c), 2) * (k ? 1 : 0.5);
          const p = cuirassPoint(a, -0.17, 0), sc = g + 0.07 * v;
          return [p[0] * sc, lerp(top, bottom, v), p[2] * sc, u, 1 - v];
        };
        this._surf(`fauld${k}`, grid(40, 3, pt, { closed: true }), M.lame, R.fauld);
        this._cord(`fauldEdge${k}`, Array.from({ length: 41 }, (_, i) => pt(i / 40, 1)), 0.0022, M.gold, R.fauld, 5);
      }
      // brown leather belt with a round gold buckle, studs and a pouch on the right hip
      const beltPt = (a, y, l) => { const p = cuirassPoint(a, y - NODE.chest[1], 0.008 + l); return [p[0], y, p[2]]; };
      this._surf('belt', grid(48, 2, (u, v) => {
        const p = beltPt((u - 0.5) * TAU, lerp(0.024, -0.006, v), 0);
        return [p[0], p[1], p[2], u, 1 - v];
      }, { closed: true }), M.belt, R.belt);
      for (let k = 0; k < 8; k++) {
        const a = (k / 8 - 0.5) * TAU + Math.PI / 8;
        if (Math.abs(a) < 0.35) continue;
        this._ball(`beltStud${k}`, beltPt(a, 0.009, 0.001), 0.011, M.gold, R.belt, [1, 1, 0.5]).rotation.y = a;
      }
      const bp = beltPt(0, 0.009, 0.004);
      this._cord('buckle', Array.from({ length: 21 }, (_, k) => {
        const a = k / 20 * TAU; return [bp[0] + 0.024 * Math.cos(a), bp[1] + 0.022 * Math.sin(a), bp[2] + 0.001];
      }), 0.0042, M.gold, R.belt, 7);
      this._cord('buckleTongue', [[bp[0] - 0.024, bp[1], bp[2] + 0.003], [bp[0] + 0.004, bp[1] + 0.002, bp[2] + 0.006], [bp[0] + 0.024, bp[1], bp[2] + 0.003]], 0.0024, M.gold, R.belt, 5);
      this._ball('buckleBoss', [bp[0], bp[1], bp[2] - 0.002], 0.03, M.leather, R.belt, [1.3, 1, 0.3]);
      const pa = 0.95, pp = beltPt(pa, -0.03, 0.012);
      const pouch = this._ball('pouch', pp, 0.066, M.leather, R.belt, [0.85, 1.05, 0.5]);
      pouch.rotation.y = pa;
      const fl = beltPt(pa, -0.012, 0.026);
      this._leaf('pouchFlap', fl, [0, -1, 0], [Math.cos(pa), 0, -Math.sin(pa)], [Math.sin(pa), 0, Math.cos(pa)], 0.048, 0.052, 0.006, M.leather, M.gold, R.belt, 0.1);
      const st = beltPt(pa, -0.03, 0.03);
      this._ball('pouchStud', st, 0.012, M.gold, R.belt, [1, 1, 0.6]);
    }

    _buildPawnTorso(R, M) {
      const half = (name, a0, a1, parent) => {
        this._surf(name, grid(24, 30, (u, v) => {
          const a = lerp(a0, a1, u), p = cuirassPoint(a, lerp(0.112, -0.17, v));
          return [p[0], p[1], p[2], a / TAU + 0.5, 1 - v];
        }), M.cuirass, parent);
        this._cord(`${name}Hem`, Array.from({ length: 17 }, (_, k) => cuirassPoint(lerp(a0, a1, k / 16), -0.168, 0.002)), 0.003, M.gold, parent, 6);
      };
      half('breast', -Math.PI / 2, Math.PI / 2, R.breast);
      half('backR', Math.PI / 2, Math.PI, R.back);
      half('backL', -Math.PI, -Math.PI / 2, R.back);
      // gorget: two lames rising round the neck into the helm
      for (let k = 0; k < 2; k++) {
        const pt = (u, v) => {
          const a = (u - 0.5) * TAU, c = Math.cos(a), back = Math.max(0, -c);
          const y0 = 0.09 + 0.026 * k, y1 = y0 + 0.034;
          const r = lerp(0.072 - 0.008 * k, 0.064 - 0.008 * k, v) + 0.004 * back * v;
          return [r * Math.sin(a), lerp(y0, y1, v), -0.004 + r * 0.96 * c, u, v];
        };
        this._surf(`gorget${k}`, grid(32, 3, pt, { closed: true }), M.lame, R.gorget);
        this._cord(`gorgetEdge${k}`, Array.from({ length: 33 }, (_, i) => pt(i / 32, 1)), 0.0024, M.gold, R.gorget, 5);
      }
      this._cord('neckMail', [[0, 0.082, -0.004], [0, 0.132, -0.002], [0, 0.182, 0]], [[0, 0.04], [1, 0.034]], M.mail, R.gorget, 16);
    }

    _buildPawnArms(R, M) {
      ['R', 'L'].forEach((side) => {
        const s = side === 'R' ? 1 : -1, arm = R['arm' + side], fore = R['fore' + side], hand = R['hand' + side];
        const sh = R['shoulder' + side];
        // pauldron: four layered domes round the shoulder, gold-edged
        const ax = V3(s * 0.5, 1, 0).normalize(), f1 = V3(0, 0, 1), f2 = Vec.Cross(ax, f1);
        const lames = [[0, 0.95, 0.082], [0.82, 1.3, 0.087], [1.18, 1.66, 0.091], [1.52, 2.02, 0.095]];
        lames.forEach(([p0, p1, rad], k) => {
          const pt = (u, v) => {
            const p = lerp(p0, p1, v), a = u * TAU, r = rad * (1 + 0.06 * v * (k ? 1 : smoothstep(0.7, 1, v)));
            const stretch = 1 + 0.2 * Math.pow(Math.cos(a), 2) * Math.sin(p);
            const d = ax.scale(Math.cos(p)).add(f1.scale(Math.cos(a) * Math.sin(p) * stretch)).add(f2.scale(Math.sin(a) * Math.sin(p)));
            return [s * 0.008 + d.x * r, 0.004 + d.y * r, d.z * r, u, 1 - v];
          };
          this._surf(`pauldron${side}${k}`, grid(28, k ? 4 : 10, pt, { closed: true }), M.lame, sh);
          this._cord(`pauldronEdge${side}${k}`, Array.from({ length: 29 }, (_, i) => pt(i / 28, 1)), 0.0026, M.gold, sh, 5);
        });
        // haute-piece: an upstanding flange on the inner edge, guarding the neck
        const x0 = -s * 0.042, top = (z) => 0.004 + Math.sqrt(Math.max(0, 0.082 * 0.082 - 0.05 * 0.05 - z * z));
        const hp = (u, v) => {
          const z = lerp(-0.058, 0.058, u), y0 = top(z) - 0.004, h = 0.036 * Math.sqrt(Math.max(0, 1 - Math.pow(z / 0.062, 2))) + 0.006;
          return [x0 + s * 0.012 * v * (1 - Math.pow(z / 0.06, 2)), y0 + h * v, z];
        };
        this._surf(`hautePiece${side}`, grid(14, 3, hp), M.plain, sh);
        this._cord(`hautePieceRim${side}`, Array.from({ length: 15 }, (_, i) => hp(i / 14, 1)), 0.0028, M.gold, sh, 5);
        // rerebrace, couter with a fan plate
        this._limbTube(`rerebrace${side}`, [[0, -0.03, 0.035, 0.035, 0.035], [1, -0.185, 0.031, 0.031, 0.031]], M.limb, arm, { nu: 18 });
        this._cop(`couter${side}`, [0, -0.1, 0], [0, -LEN.upper, -0.012], [0, -LEN.upper - 0.1, 0.02], 0.037, M.plain, arm);
        this._leaf(`couterWing${side}`, [s * 0.031, -LEN.upper, -0.012], [0, 1, 0], [0, 0, 1], [s, 0, -0.2], 0.066, 0.058, 0.011, M.plain, M.gold, arm);
        // vambrace and a flared gauntlet cuff
        this._limbTube(`vambrace${side}`, [[0, -0.01, 0.031, 0.031, 0.031], [1, -0.15, 0.026, 0.027, 0.026]], M.limb, fore, { nu: 18 });
        this._limbTube(`cuff${side}`, [[0, -0.132, 0.029, 0.029, 0.029], [0.6, -0.168, 0.033, 0.035, 0.033], [1, -0.186, 0.037, 0.04, 0.037]], M.lame, fore, { nu: 20 });
        this._cord(`cuffRim${side}`, Array.from({ length: 21 }, (_, k) => {
          const a = k / 20 * TAU; return [0.038 * Math.sin(a), -0.186, 0.041 * Math.cos(a)];
        }), 0.0026, M.gold, fore, 6);
        this._buildFist(hand, s, M);
      });
    }

    // Great helm: a flat-topped dome with a keel down the face plate, an eye
    // slit and breathing holes, a gold cross on the face, a gold rim, a ridge
    // over the crown and a gold finial.
    _buildHelm(face, M) {
      this._surf('helm', grid(56, 44, (u, v) => {
        const th = (u - 0.5) * TAU, y = helmYofV(v), p = helmPoint(th, y);
        return [p[0], p[1], p[2], u, (y - HBOT) / (HTOP - HBOT)];
      }, { closed: true }), M.helm, face);
      // inside of the helm's lower edge, so it doesn't read as paper-thin
      this._surf('helmLining', grid(40, 2, (u, v) => {
        const th = (u - 0.5) * TAU, p = helmPoint(th, lerp(HBOT, HBOT + 0.02, v), -0.004);
        return [p[0], p[1], p[2]];
      }, { closed: true, inward: true }), M.dark, face);
      this._cord('helmRim', Array.from({ length: 49 }, (_, k) => helmPoint((k / 48 - 0.5) * TAU, HBOT + 0.002, 0.001)), 0.0038, M.gold, face, 6);
      const ridge = [];
      for (let k = 0; k <= 10; k++) ridge.push(helmPoint(0, lerp(0.04, HTOP - 0.004, k / 10), 0.003));
      for (let k = 1; k <= 10; k++) ridge.push(helmPoint(Math.PI, lerp(HTOP - 0.004, 0.0, k / 10), 0.003));
      this._cord('helmRidge', ridge, [[0, 0.003], [0.5, 0.0045], [1, 0.003]], M.gold, face, 6);
      // finial
      this._cord('finialCollar', Array.from({ length: 13 }, (_, k) => { const a = k / 12 * TAU; return [0.012 * Math.sin(a), HTOP - 0.002, 0.012 * Math.cos(a)]; }), 0.003, M.gold, face, 5);
      this._ball('finialKnob', [0, HTOP + 0.012, 0], 0.024, M.gold, face, [1, 0.9, 1]);
      this._cord('finialSpike', [[0, HTOP + 0.022, 0], [0, HTOP + 0.046, 0]], [[0, 0.006], [1, 0.0008]], M.gold, face, 6);
      // hinge rosettes and rivets
      [-1, 1].forEach((s) => {
        const p = helmPoint(s * Math.PI / 2, 0.006, 0.002);
        this._ball(`hinge${s}`, p, 0.02, M.gold, face, [0.45, 1, 1]);
      });
      for (let k = 0; k < 14; k++) {
        const th = (k / 14 - 0.5) * TAU + Math.PI / 14;
        this._ball(`helmRivet${k}`, helmPoint(th, -0.078, 0.001), 0.0075, M.gold, face);
      }
    }

    // A great sword along sword-space +y from the guard: a mirror blade with
    // a gilded fuller, a gold cross-guard with scrolled quillons and a jewel,
    // a leather grip bound in gold wire and a jewelled wheel pommel.
    _buildPawnSword(sw, M) {
      const Lb = SWORD.blade;
      this._surf('blade', grid(12, 34, (u, v) => {
        const y = v * Lb, w = curve(BLADE_W, y)[0], th = lerp(0.0085, 0.0035, v), a = u * TAU;
        return [w * spow(Math.cos(a), 2 / 1.25), y, th * spow(Math.sin(a), 2 / 1.25)];
      }, { closed: true, capEnd: true }), M.blade, sw);
      [1, -1].forEach((s) => this._surf(`fuller${s}`, grid(2, 18, (u, v) => {
        const y = lerp(0.03, 0.44, v), w = 0.0095 * (1 - 0.35 * v), th = lerp(0.0085, 0.0035, y / Lb) * 0.97 + 0.0004;
        return [(1 - 2 * u) * w * s, y, s * th, u, 1 - v];
      }), M.fuller, sw));
      // guard
      this._surf('guardBlock', grid(16, 8, (u, v) => {
        const a = u * TAU, y = lerp(-0.012, 0.014, v), w = 0.022 + 0.01 * Math.sin(Math.PI * v);
        return [w * spow(Math.cos(a), 0.5), y, 0.013 * spow(Math.sin(a), 0.5)];
      }, { closed: true, capStart: true, capEnd: true }), M.gold, sw);
      [-1, 1].forEach((s) => {
        this._cord(`quillon${s}`, [[s * 0.02, 0, 0], [s * 0.06, -0.004, 0], [s * 0.1, 0.003, 0], [s * 0.118, 0.018, 0]],
          [[0, 0.0088], [0.5, 0.0068], [1, 0.0055]], M.gold, sw, 10);
        // the end rolls up into a scroll toward the blade
        const curl = [];
        for (let k = 0; k <= 14; k++) {
          const t = k / 14, a = -Math.PI / 2 + t * 1.7 * Math.PI, r = 0.012 * (1 - 0.65 * t);
          curl.push([s * (0.108 + Math.cos(a) * r), 0.03 + Math.sin(a) * r, 0]);
        }
        this._cord(`quillonCurl${s}`, curl, [[0, 0.0055], [1, 0.003]], M.gold, sw, 6);
        this._ball(`quillonKnob${s}`, [s * 0.106, 0.031, 0], 0.008, M.gold, sw);
      });
      [1, -1].forEach((f) => {
        this._leaf(`langet${f}`, [0, 0.03, f * 0.0075], [0, 1, 0], [1, 0, 0], [0, 0, f], 0.05, 0.024, 0.003, M.gold, M.gold, sw, 0.8);
        this._ball(`guardGem${f}`, [0, 0.001, f * 0.012], 0.012, M.gem, sw, [1, 1, 0.5]);
      });
      // grip bound in gold wire
      this._surf('grip', grid(12, 16, (u, v) => {
        const a = u * TAU, y = lerp(-0.012, -0.118, v), r = 0.0105 + 0.0018 * Math.sin(Math.PI * v);
        return [r * Math.sin(a), y, r * Math.cos(a)];
      }, { closed: true }), M.grip, sw);
      this._cord('gripWire', Array.from({ length: 49 }, (_, k) => {
        const t = k / 48, a = t * 7 * TAU, y = lerp(-0.015, -0.115, t), r = 0.0116 + 0.0018 * Math.sin(Math.PI * t);
        return [r * Math.sin(a), y, r * Math.cos(a)];
      }), 0.0011, M.gold, sw, 4);
      [-0.014, -0.117].forEach((y, i) => this._cord(`ferrule${i}`, Array.from({ length: 13 }, (_, k) => {
        const a = k / 12 * TAU; return [0.0122 * Math.sin(a), y, 0.0122 * Math.cos(a)];
      }), 0.0024, M.gold, sw, 5));
      // wheel pommel
      const PY = -0.142;
      this._surf('pommel', grid(20, 10, (u, v) => {
        const a = u * TAU, ph = (v - 0.5) * Math.PI, r = 0.024 * Math.pow(Math.max(0, Math.cos(ph)), 0.35);
        return [r * Math.cos(a), PY + r * Math.sin(a), 0.011 * Math.sin(ph)];
      }, { closed: true }), M.gold, sw);
      this._cord('pommelRim', Array.from({ length: 21 }, (_, k) => { const a = k / 20 * TAU; return [0.019 * Math.cos(a), PY + 0.019 * Math.sin(a), 0]; }), 0.0026, M.gold, sw, 5);
      [1, -1].forEach((f) => this._ball(`pommelGem${f}`, [0, PY, f * 0.01], 0.016, M.gem, sw, [1, 1, 0.5]));
      this._ball('pommelNut', [0, PY - 0.026, 0], 0.012, M.gold, sw);
      const tip = new BABYLON.TransformNode(`swordTip_${this.id}`, this.scene);
      tip.parent = sw; tip.position.y = Lb;
      const base = new BABYLON.TransformNode(`swordBase_${this.id}`, this.scene);
      base.parent = sw; base.position.y = 0.05;
      this.parts.swordTip = tip; this.parts.swordBase = base;
    }

    // Heater shield: a curved steel face with its painted cross, border and
    // raised escutcheon with the lion, a wooden back with leather straps and
    // a gold rim round the edge.
    _buildShield(sd, M) {
      const face = grid(18, 28, (u, v) => {
        const s = 2 * u - 1, y = lerp(shieldTop(s * SH.w), SH.bot, v), x = s * shieldHW(y), [tu, tv] = shieldUV(x, y);
        return [x, y, shieldZ(x), tu, tv];
      });
      this._surf('shieldFace', orient(face, [0, 0, 1]), M.shield, sd);
      const back = grid(12, 20, (u, v) => {
        const s = 2 * u - 1, y = lerp(shieldTop(s * SH.w), SH.bot, v), x = s * shieldHW(y), [tu, tv] = shieldUV(x, y);
        return [x, y, shieldZ(x) - SH.th, tu, tv];
      });
      this._surf('shieldBack', orient(back, [0, 0, -1]), M.back, sd);
      const rim = shieldOutline(40).map(([x, y]) => [x, y, shieldZ(x) - SH.th / 2]);
      rim.push(rim[0], rim[1]);
      this._cord('shieldRim', rim, 0.0088, M.gold, sd, 8);
      // escutcheon, standing a little proud of the face
      const esc = grid(12, 16, (u, v) => {
        const s = 2 * u - 1, yb = lerp(shieldTop(s * SH.w), SH.bot, v), xb = s * shieldHW(yb);
        const x = xb * ESC.k, y = ESC.cy + (yb - SHOC) * ESC.k, [tu, tv] = shieldUV(x, y);
        return [x, y, shieldZ(x) + 0.0035, tu, tv];
      });
      this._surf('escutcheon', orient(esc, [0, 0, 1]), M.shield, sd);
      const er = shieldOutline(20, ESC.k, ESC.cy).map(([x, y]) => [x, y, shieldZ(x) + 0.0028]);
      er.push(er[0], er[1]);
      this._cord('escutcheonRim', er, 0.0036, M.gold, sd, 6);
      // straps (enarmes) and grip on the back
      const zb = (x) => shieldZ(x) - SH.th;
      [0.12, 0.02].forEach((y, i) => this._cord(`enarme${i}`, [[-0.1, y, zb(-0.1) - 0.002], [-0.05, y, zb(-0.05) - 0.016], [0.05, y, zb(0.05) - 0.016], [0.1, y, zb(0.1) - 0.002]],
        0.007, M.leather, sd, 6));
      [-0.1, 0.1].forEach((x, i) => [0.12, 0.02].forEach((y, j) => this._ball(`strapRivet${i}${j}`, [x, y, zb(x) - 0.002], 0.014, M.gold, sd, [1, 1, 0.5])));
    }

    // ---------------------------------------------------------- IK + poses
    _applyPose(P) {
      const R = this.rig;
      R.hips.position.set(P.hips[0], P.hips[1], P.hips[2]);
      R.hips.rotation.set(P.hipsRot[0], P.hipsRot[1], P.hipsRot[2]);
      R.spine.rotation.set(P.spine[0], P.spine[1], P.spine[2]);
      R.chest.rotation.set(P.chest[0], P.chest[1], P.chest[2]);
      R.neck.rotation.set(P.neck[0], P.neck[1], P.neck[2]);
      R.head.rotation.set(P.head[0], P.head[1], P.head[2]);
      this.root.computeWorldMatrix(true);
      [this.visual, R.base, R.hips, R.spine, R.chest, R.neck, R.head].forEach((n) => n.computeWorldMatrix(true));
      const B = R.base.getWorldMatrix(), Brot = rotOf(B);
      const k = Vec.TransformNormal(V3(1, 0, 0), B).length() || 1;
      const toW = (p) => Vec.TransformCoordinates(p, B);
      const dirW = (d) => Vec.TransformNormal(V3(d[0], d[1], d[2]), Brot).normalize();

      ['R', 'L'].forEach((side) => {
        const s = side === 'R' ? 1 : -1, f = P['foot' + side], thigh = R['thigh' + side];
        thigh.computeWorldMatrix(true);
        const pole = dirW([s * P.kneeOut, 0.15, 1]);
        this._twoBone(thigh, R['shin' + side], thigh.getAbsolutePosition().clone(), toW(V3(f[0], f[1], f[2])), pole, pole, LEN.thigh * k, LEN.shin * k);
        this._setWorldRot(R['foot' + side], Mat.RotationYawPitchRoll(f[4], f[3], 0).multiply(Brot));
      });

      // sword, and the right hand on its grip
      const q = P.sword, D = V3(q[3], q[4], q[5]).normalize();
      let X = orth(V3(1, 0, 0), D);
      const Z0 = Vec.Cross(X, D);
      X = X.scale(Math.cos(q[6])).add(Z0.scale(Math.sin(q[6])));
      R.sword.position.set(q[0], q[1], q[2]);
      if (!R.sword.rotationQuaternion) R.sword.rotationQuaternion = new Quat();
      Quat.FromRotationMatrixToRef(basis(X, D, Vec.Cross(X, D)), R.sword.rotationQuaternion);
      R.sword.computeWorldMatrix(true);
      const SW = R.sword.getWorldMatrix();
      // (freeR > 0: the right hand lets go of the grip for handR, thumb along thumbR)
      const gripW = Vec.TransformCoordinates(V3(0, SWORD.grip, 0), SW), gripT = Vec.TransformNormal(V3(0, 1, 0), rotOf(SW)).normalize();
      const fr = clamp(P.freeR, 0, 1);
      if (fr > 0) {
        this._arm(R, 'R', Vec.Lerp(gripW, toW(V3(P.handR[0], P.handR[1], P.handR[2])), fr),
          Vec.Lerp(gripT, dirW(P.thumbR), fr).normalize(), dirW(P.elbowR), k);
      } else {
        this._arm(R, 'R', gripW, gripT, dirW(P.elbowR), k);
      }

      // shield: resting on its point with the hand on the rim, or carried on the forearm
      const sh = P.shield, strap = clamp(P.strap, 0, 1);
      const restQ = Quat.RotationYawPitchRoll(sh[3], sh[4], sh[5]), restP = V3(sh[0], sh[1], sh[2]);
      const restM = Mat.Compose(V3(1, 1, 1), restQ, restP);
      const rimB = Vec.TransformCoordinates(RIM, restM), rimT = Vec.TransformNormal(V3(1, 0, 0), restM);
      const hold = Math.max(strap, clamp(P.free, 0, 1));
      const target = toW(Vec.Lerp(rimB, V3(P.handL[0], P.handL[1], P.handL[2]), hold));
      const thumbB = Vec.Lerp(rimT, V3(P.thumbL[0], P.thumbL[1], P.thumbL[2]).normalize(), hold).normalize();
      this._arm(R, 'L', target, Vec.TransformNormal(thumbB, Brot).normalize(), dirW(P.elbowL), k);
      let pos = restP, rot = restQ;
      if (strap > 0) {
        const inv = this._invB || (this._invB = new Mat());
        B.invertToRef(inv);
        R.foreL.computeWorldMatrix(true); R.handL.computeWorldMatrix(true);
        const e = Vec.TransformCoordinates(R.foreL.getAbsolutePosition(), inv), wr = Vec.TransformCoordinates(R.handL.getAbsolutePosition(), inv);
        const mid = Vec.Lerp(e, wr, 0.5);
        const N = V3(P.shieldN[0], P.shieldN[1], P.shieldN[2]).normalize(), U = orth(V3(0, 1, 0), N), Xs = Vec.Cross(U, N);
        const cq = Quat.FromRotationMatrix(basis(Xs, U, N));
        const cp = mid.add(N.scale(CARRY.n)).subtract(U.scale(CARRY.up)).add(Xs.scale(CARRY.x));
        pos = Vec.Lerp(restP, cp, strap);
        rot = Quat.Slerp(restQ, cq, strap);
      }
      R.shield.position.copyFrom(pos);
      if (!R.shield.rotationQuaternion) R.shield.rotationQuaternion = new Quat();
      R.shield.rotationQuaternion.copyFrom(rot);

      // pauldrons follow part of the arms' swing
      ['R', 'L'].forEach((side) => {
        const shn = R['shoulder' + side], dir = V3(0, -1, 0).applyRotationQuaternion(R['arm' + side].rotationQuaternion);
        if (!shn.rotationQuaternion) shn.rotationQuaternion = new Quat();
        Quat.FromUnitVectorsToRef(V3(0, -1, 0), dir, this._tmpQ || (this._tmpQ = new Quat()));
        Quat.SlerpToRef(Quat.Identity(), this._tmpQ, 0.4, shn.rotationQuaternion);
      });
      this._setGlow(P.glow);
      this._cur = P;
    }

    _setGlow(g) {
      const M = this.pMatsLive || (this.pMatsLive = { blade: this._ownMats[0], fuller: this._ownMats[1] });
      // a faint sheen of its own so the mirror blade never reads black against a dark sky
      M.blade.emissiveColor = new BABYLON.Color3(0.13, 0.14, 0.17).add(this._glowColor.scale(0.12 * g)).add(new BABYLON.Color3(0.25, 0.25, 0.28).scale(g * g * 0.5));
      M.fuller.emissiveColor = this._goldColor.scale(0.3 + 0.9 * g).add(this._glowColor.scale(0.4 * g));
    }

    _playKeys(keys, onTime) {
      const like = keys[0][1], total = keys[keys.length - 1][0];
      const fk = keys.map(([t, P]) => [t, ...flat(P)]);
      return Tween.run(total, (_, raw) => {
        const t = raw * total;
        this._applyPose(unflat(curve(fk, t), like));
        if (onTime) onTime(t);
      }, Ease.linear);
    }
    _blendTo(target, ms, ease) {
      const from = clonePose(this._cur);
      return Tween.run(ms, (t) => this._applyPose(mixPose(from, target, t)), ease || Ease.inOutCubic);
    }

    // ---------------------------------------------------------- glint
    // Now and then a star of light flashes somewhere along the blade (more
    // often while it glows).
    _startGlint() {
      const scene = this.scene;
      const mat = new BABYLON.StandardMaterial(`glint_${this.id}`, scene);
      mat.diffuseColor = BABYLON.Color3.Black(); mat.specularColor = BABYLON.Color3.Black();
      mat.emissiveTexture = this._texShared.star; mat.disableLighting = true; mat.backFaceCulling = false;
      mat.alpha = 0.999; mat.alphaMode = BABYLON.Engine.ALPHA_ADD;
      this._ownMats.push(mat);
      const g = MB.CreatePlane(`glint_${this.id}`, { size: 1 }, scene);
      g.material = mat; g.parent = this.rig.sword; g.isPickable = false;
      g.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      g.setEnabled(false);
      this._glint = { mesh: g, t: 0, dur: 0, wait: 0.4 + Math.random() * 2.5, size: 0.08 };
      this._glintObs = scene.onBeforeRenderObservable.add(() => this._tickGlint(scene.getEngine().getDeltaTime() / 1000 * (Tween.speed || 1)));
    }
    _tickGlint(dt) {
      const gl = this._glint;
      if (!gl || !this.alive || this._shattered) return;
      const hot = this._cur && this._cur.glow > 0.3;
      if (gl.dur > 0) {
        gl.t += dt;
        const k = gl.t / gl.dur;
        if (k >= 1) {
          gl.dur = 0; gl.mesh.setEnabled(false);
          gl.wait = hot ? 0.15 + Math.random() * 0.35 : 0.8 + Math.random() * 2.2;
          return;
        }
        gl.mesh.scaling.setAll(Math.max(1e-4, gl.size * Math.pow(Math.sin(Math.PI * k), 1.5)));
      } else if ((gl.wait -= dt) <= 0) {
        const y = lerp(0.1, SWORD.blade * 0.9, Math.random()), w = curve(BLADE_W, y)[0];
        gl.t = 0; gl.dur = 0.4 + Math.random() * 0.25; gl.size = (hot ? 0.1 : 0.07) + Math.random() * 0.05;
        gl.mesh.position.set((Math.random() < 0.5 ? -1 : 1) * w * (0.4 + 0.5 * Math.random()), y, 0);
        gl.mesh.scaling.setAll(1e-4);
        gl.mesh.setEnabled(true);
      }
    }

    // ---------------------------------------------------------- idle
    // Pooled (instance-pool.js): the rig is hidden and the pawn doesn't bob.
    updateIdlePooled() { this.visual.position.y = this.selectLift; }

    // The idle sway is slow, so each pawn re-solves its pose every other frame
    // (half the pawns on each), which halves the cost of sixteen of them.
    updateIdle(t) {
      if (this._busy || this._fid) return;
      this._idleTick = (this._idleTick === undefined ? (this.idlePhase > Math.PI ? 1 : 0) : this._idleTick) ^ 1;
      if (this._idleTick && this._stance === this._idleStance && this.visual.position.y === this.selectLift) return;
      this._idleStance = this._stance;
      const ph = this.idlePhase;
      this.visual.position.y = this.selectLift;
      const P = this._stance === 'rest' ? restPose() : marchPose();
      P.chest[0] += 0.012 * Math.sin(t * 1.4 + ph);
      P.spine[0] += 0.004 * Math.sin(t * 1.4 + ph + 0.4);
      P.head[1] += 0.14 * Math.sin(t * 0.3 + ph) + 0.04 * Math.sin(t * 0.8 + ph * 2);
      P.head[0] += 0.02 * Math.sin(t * 0.45 + ph);
      this._applyPose(P);
    }

    // ---------------------------------------------------------- moving
    // Take up the shield and raise the sword, turn, march to the square, turn
    // back and ground the shield and sword again. With opts.keepFacing (the
    // approach to a capture) he stays up, facing where he went.
    async moveTo(pos, style, opts) {
      opts = opts || {};
      this.busy = true;
      if (this._stance === 'rest') await this._raise();
      const d = pos.subtract(this.root.position);
      d.y = 0;
      if (d.length() > 0.02) {
        await this._turnTo(Math.atan2(d.x, d.z));
        await this._walk(pos);
      }
      this.root.position.x = pos.x; this.root.position.z = pos.z;
      if (!opts.keepFacing) {
        await this._turnTo(this.baseFacing);
        await this._lower();
      }
      this.busy = false;
    }

    _raise() {
      const M = marchPose();
      const mid = withPose(mixPose(this._cur, M, 0.45), { sword: swordAt([0.25, 0.8, 0.22], [0.3, 0.25, 0.92], 0.15), strap: 0.45 });
      this._stance = 'march';
      return this._playKeys([[0, clonePose(this._cur)], [120, mid], [260, M]]);
    }

    async _lower() {
      const E = restPose();
      const mid = withPose(mixPose(this._cur, E, 0.5), { sword: swordAt([0.24, 0.78, 0.22], [0.25, -0.2, 0.95], 0.1), strap: 0.55 });
      await this._playKeys([[0, clonePose(this._cur)], [130, mid], [290, E]]);
      this._stance = 'rest';
      const fx = this.ctx.effects;
      if (fx && fx.dustPuff) fx.dustPuff(this.root.position.clone());
    }

    // Turn on the spot, stepping from foot to foot.
    async _turnTo(yaw) {
      const start = this.root.rotation.y;
      let diff = (yaw - start) % TAU;
      if (diff > Math.PI) diff -= TAU;
      if (diff < -Math.PI) diff += TAU;
      if (Math.abs(diff) < 0.01) return;
      const base = marchPose(), steps = Math.max(1, Math.round(Math.abs(diff) / 0.9));
      await Tween.run(130 + 190 * Math.abs(diff) / Math.PI, (e, raw) => {
        this.root.rotation.y = start + diff * e;
        const P = clonePose(base), ph = raw * steps * Math.PI;
        P.footR[1] += 0.035 * Math.max(0, Math.sin(ph * 2));
        P.footL[1] += 0.035 * Math.max(0, -Math.sin(ph * 2));
        P.hips[0] = 0.01 * Math.sin(ph * 2);
        this._applyPose(P);
      }, Ease.linear);
      this.root.rotation.y = yaw;
    }

    // March to `target`: long firm strides with a high knee, the body upright
    // and steady, the sword held high; the stance foot slides back under the
    // body at exactly the walking speed, so the feet stay planted.
    async _walk(target) {
      const from = this.root.position.clone(), d = target.subtract(from);
      d.y = 0;
      const dist = d.length(), dir = d.scale(1 / dist), fx = this.ctx.effects;
      const ms = dist / WALK.speed * 1000 / (1 - WALK.ramp);
      const along = cruise(WALK.ramp), base = marchPose(), L = WALK.step, db = dist / S;
      let lastStep = 0;
      await Tween.run(ms, (_, raw) => {
        const trav = dist * along(raw), tb = trav / S;
        this.root.position.set(from.x + dir.x * trav, from.y, from.z + dir.z * trav);
        const phase = tb / (2 * L), w = smoothstep(0, 0.5 * L, tb) * smoothstep(0, 0.5 * L, db - tb);
        const P = clonePose(base);
        [['footR', 0], ['footL', 0.5]].forEach(([f, off]) => {
          const p = ((phase + off) % 1 + 1) % 1, [z, lift, pitch] = footCycle(p, L, WALK.duty);
          P[f][1] += lift * 1.7 * w; P[f][2] = lerp(P[f][2], z, w); P[f][3] = pitch * w;
        });
        const bob = Math.cos(2 * TAU * (phase - 0.3));
        // The hips ride on the straight stance leg (an inverted pendulum):
        // highest over the planted foot, lowest when both feet are down.
        P.hips[1] = Math.min(STAND_Y, legReach(P, P.footR, 1), legReach(P, P.footL, -1)) - 0.002;
        P.hips[0] = 0.012 * Math.cos(TAU * (phase - 0.3)) * w;
        P.hipsRot[1] = 0.09 * Math.sin(TAU * phase) * w;
        P.chest[1] = -0.07 * Math.sin(TAU * phase) * w;
        P.kneeOut = 0.15;
        P.sword[1] += 0.008 * bob * w;
        P.handL[1] += 0.006 * bob * w;
        this._applyPose(P);
        const step = Math.floor(phase * 2);
        if (step !== lastStep && w > 0.5) {
          lastStep = step;
          if (fx && fx.dustPuff) fx.dustPuff(this.root.position.clone());
        }
      }, Ease.linear);
    }

    // ---------------------------------------------------------- combat
    // Two blows: a lunging thrust, then a full spin on the spot that brings
    // the blade round in a flat cut. Each rings on the target; resolves as the
    // spinning cut lands.
    async playAttack(targetPos) {
      this.busy = true;
      const fx = this.ctx.effects, team = Config.TEAM[this.color];
      await this.faceTowards(targetPos, TIMING.turn);
      const Gd = guardPose();
      const cut = (hand, dir, roll, o) => withPose(Gd, Object.assign({ sword: swordAt(hand, dir, roll), glow: 1 }, o || {}));
      // thrust
      const wind1 = cut([0.24, 0.8, -0.12], [0.08, 0.35, 0.93], 0, { chest: [-0.04, 0.35, 0], spine: [0, 0.1, 0], hipsRot: [0, 0.22, 0], hips: [0, 0.51, -0.04], glow: 1.4, elbowR: [1, -0.3, -0.6] });
      const stab = cut([0.06, 0.64, 0.48], [0, 0.3, 0.95], 0, { chest: [0.18, -0.1, 0], spine: [0.08, 0, 0], hips: [0, 0.48, 0.12], hipsRot: [0, -0.05, 0], head: [-0.08, 0, 0],
        footR: [0.11, ANK, 0.34, 0, 0.1], footL: [-0.12, ANK + 0.03, -0.16, 0.45, -0.3], elbowR: [1, -0.4, -0.2], glow: 1.6 });
      // spin: the sword trails out behind the right side, the body whirls
      // round to the right and the arm sweeps the blade in flat across the front
      const spin = (rel, hand, dir, o) => cut(hand, dir, 0, Object.assign({ chest: [0.02, 0.3, 0], spine: [0.02, 0.1, 0], hipsRot: [0, 0.1, 0], hips: [0, 0.5, 0], glow: 1.5, elbowR: [1, -0.3, -0.2] }, o || {}));
      const coil = spin(0, [0.3, 0.86, -0.04], [0.6, 0.1, -0.79], { chest: [0, 0.5, 0], spine: [0, 0.2, 0], hipsRot: [0, 0.22, 0], head: [0.04, -0.35, 0], elbowR: [1, -0.4, -0.4] });
      const swing = spin(0, [0.34, 0.9, 0.1], [0.97, 0.08, 0.23], { chest: [0.02, 0.1, 0] });
      const sweep = spin(0, [0.26, 0.88, 0.28], [0.7, 0.06, 0.71], { chest: [0.04, -0.1, 0] });
      const slash = spin(0, [0.14, 0.84, 0.38], [0.2, 0.06, 0.98], { chest: [0.06, -0.2, 0], hipsRot: [0, 0, 0] });
      const follow = spin(0, [0.08, 0.82, 0.44], [0.02, 0.04, 1], { chest: [0.1, -0.3, 0], spine: [0.04, -0.15, 0], hipsRot: [0, -0.1, 0], head: [0.04, 0.15, 0], elbowR: [0.5, -0.8, -0.1] });
      const T0 = 520, T1 = 940;                                  // the spin runs T0..T1
      const keys = [[0, clonePose(this._cur)], [170, Gd], [300, wind1], [380, stab], [460, stab],
        [T0, coil], [T0 + 150, swing], [T0 + 290, sweep], [T0 + 370, slash], [T1, follow]];
      const hit = () => {
        const b = this.parts.swordBase.getAbsolutePosition(), t = this.parts.swordTip.getAbsolutePosition();
        return Vec.Lerp(b, t, 0.62);
      };
      const clash = (k) => () => {
        if (fx && fx.burst) fx.burst({ pos: hit(), color1: '#ffffff', color2: team.accent, count: 34, speed: { min: 1.2, max: 3.5 }, life: 0.4, size: 0.07, gravity: [0, -5, 0], blend: 'ADD' });
        if (window.ChessSound && ChessSound.playClang) ChessSound.playClang(0.8 + 0.2 * k, 0.9 + 0.12 * k);
      };
      const swoosh = (g) => () => window.ChessSound && ChessSound.playSwoosh && ChessSound.playSwoosh(g);
      const events = [
        [130, () => { this._trail = fx && fx.bladeTrail ? fx.bladeTrail(this.parts.swordBase, this.parts.swordTip, hex(team.glow).scale(0.6).add(new BABYLON.Color3(0.4, 0.38, 0.3)).toHexString(), { life: 260 }) : null; }],
        [310, swoosh(1.2)], [385, clash(0)],
        [T0 + 20, swoosh(1.1)], [T0 + 360, clash(1)]
      ];
      // yaw: one whole turn over the spin, easing in and out; the blade (held at
      // the right) sweeps round with it and reaches the front as the turn ends
      const yaw0 = this.root.rotation.y;
      let next = 0;
      await this._playKeys(keys, (t) => {
        const u = Math.min(1, Math.max(0, (t - T0) / (T1 - T0)));
        this.root.rotation.y = yaw0 + TAU * (u * u * (3 - 2 * u));
        while (next < events.length && t >= events[next][0]) events[next++][1]();
      });
      this.root.rotation.y = yaw0;
      while (next < events.length) events[next++][1]();
      if (window.ChessSound && ChessSound.playClang) ChessSound.playClang(1.1, 0.8);
      if (fx && fx.burst) fx.burst({ pos: hit(), color1: '#ffffff', color2: team.accent, count: 44, speed: { min: 1, max: 3 }, life: 0.45, size: 0.09 });
      this._stance = 'march';
      const trail = this._trail;
      this._trail = null;
      Tween.wait(160).then(() => trail && trail.stop());
    }

    async playRecover() {
      this.busy = true;
      this._stance = 'march';
      await this._blendTo(marchPose(), 560, Ease.inOutCubic);
      this.busy = false;
    }

    async playHit() {
      this.busy = true;
      const base = clonePose(this._cur);
      const hit = withPose(base, { chest: [base.chest[0] - 0.18, base.chest[1], base.chest[2]], head: [base.head[0] - 0.28, base.head[1], 0.08],
        spine: [base.spine[0] - 0.06, base.spine[1], base.spine[2]] });
      await Tween.run(280, (t, raw) => {
        this.setFlash(1 - raw);
        this._applyPose(mixPose(base, hit, Math.sin(Math.PI * Math.min(1, raw * 1.4))));
      }, Ease.linear);
      this.setFlash(0);
      this.busy = false;
    }

    // He reels, sags, and his armour bursts apart: every plate, the helm,
    // the sword and the shield fly off and fall onto the board.
    async playDeath() {
      this.busy = true;
      const cur = clonePose(this._cur);
      const jolt = withPose(cur, { chest: [cur.chest[0] - 0.22, cur.chest[1], 0.06], head: [cur.head[0] - 0.4, cur.head[1], 0.1], spine: [cur.spine[0] - 0.08, cur.spine[1], 0] });
      const sag = withPose(cur, { hips: [cur.hips[0], cur.hips[1] - 0.05, cur.hips[2] - 0.02], chest: [0.28, cur.chest[1], -0.05], spine: [0.12, 0, 0],
        head: [0.45, 0.2, -0.15], kneeOut: 0.5, glow: 0 });
      await this._playKeys([[0, cur], [200, jolt], [650, sag]], (t) => this.setFlash(0.55 * Math.max(0, Math.sin(t / 650 * Math.PI * 3))));
      this.setFlash(0);
      this._shatter();
      await Tween.wait(1700);
    }

    _shatter() {
      if (this._shattered) return;
      this._shattered = true;
      if (this._glint) this._glint.mesh.setEnabled(false);
      const R = this.rig, root = this.root, fx = this.ctx.effects, team = Config.TEAM[this.color];
      [root, ...root.getDescendants(false)].forEach((n) => n.computeWorldMatrix(true));
      const glint = this._glint && this._glint.mesh;
      const nodes = this._pivots.filter((n) => n.getChildMeshes(true).some((m) => m !== glint));
      const frags = nodes.map((node) => {
        const inv = node.getWorldMatrix().clone().invert();
        let min = V3(Infinity, Infinity, Infinity), max = V3(-Infinity, -Infinity, -Infinity);
        node.getChildMeshes(true).forEach((m) => {
          if (m === glint) return;
          m.computeWorldMatrix(true);
          m.getBoundingInfo().boundingBox.vectorsWorld.forEach((p) => {
            const q = Vec.TransformCoordinates(p, inv);
            min = Vec.Minimize(min, q); max = Vec.Maximize(max, q);
          });
        });
        const cl = min.add(max).scale(0.5);
        node.setParent(root);
        if (!node.rotationQuaternion) node.rotationQuaternion = Quat.FromEulerAngles(node.rotation.x, node.rotation.y, node.rotation.z);
        const sc = node.scaling.x, q = node.rotationQuaternion.clone();
        const C = node.position.add(cl.scale(sc).applyRotationQuaternion(q));
        const corners = [];
        for (let i = 0; i < 8; i++) corners.push(V3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z).subtract(cl).scale(sc));
        const heavy = node === R.sword || node === R.shield;
        let out = V3(C.x, 0, C.z);
        if (out.lengthSquared() < 0.0009) { const a = Math.random() * TAU; out = V3(Math.cos(a), 0, Math.sin(a)); }
        out.normalize();
        const hgt = clamp((C.y - 0.1) / 0.6, 0, 1), r = Math.random();
        let v = out.scale(0.15 + 0.3 * r + 0.2 * hgt).add(V3(0, 0.35 + 0.8 * Math.random() * hgt, 0));
        let w = V3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().scale(3 + 7 * Math.random());
        if (heavy) {
          v = out.scale(0.12 + 0.12 * r).add(V3(0, 0.25, 0));
          const up = V3(0, 1, 0).applyRotationQuaternion(q);
          w = Vec.Cross(up, out.scale(-1));
          w = (w.lengthSquared() > 1e-6 ? w.normalize() : V3(1, 0, 0)).scale(node === R.sword ? 3.2 : 2.4);
        }
        if (node === R.face) v.y += 0.5;
        return { node, cl, sc, q, C, corners, v, w, heavy, landed: false };
      });
      this._frags = frags;
      const chest = root.position.add(V3(0, 0.45, 0));
      if (fx && fx.burst) fx.burst({ pos: chest, color1: '#ffffff', color2: team.glow, count: 50, speed: { min: 0.8, max: 2.6 }, life: 0.55, size: 0.08 });
      if (fx && fx.dissolve) fx.dissolve(root.position.clone(), team.glow, 0.7);

      const g = 3.4, FR = 0.39, T = 3200, tmp = V3(0, 0, 0);
      let last = 0;
      Tween.run(T, (_, raw) => {
        if (!this.alive) return;
        // fixed small substeps, so a slow frame rate never leaves pieces hanging in the air
        const now = raw * T / 1000, span = now - last;
        last = now;
        if (span <= 0) return;
        const n = Math.ceil(span / 0.02), dt = span / n;
        for (let sub = 0; sub < n; sub++) frags.forEach((f) => {
          f.v.y -= g * dt;
          f.C.addInPlace(f.v.scale(dt));
          const wl = f.w.length();
          if (wl > 1e-4) { f.q = Quat.RotationAxis(f.w.scale(1 / wl), wl * dt).multiply(f.q); f.q.normalize(); }
          let minY = Infinity;
          f.corners.forEach((p) => { p.rotateByQuaternionToRef(f.q, tmp); if (tmp.y < minY) minY = tmp.y; });
          minY += f.C.y;
          const floor = f.C.x * f.C.x + f.C.z * f.C.z < FR * FR ? G : 0.003;
          if (minY < floor) {
            f.C.y += floor - minY;
            if (f.v.y < 0) {
              const impact = -f.v.y;
              f.v.y = impact > 0.3 ? impact * 0.3 : 0;
              f.v.x *= 0.6; f.v.z *= 0.6;
              if (impact > 0.3) f.w.scaleInPlace(0.55);
              if (f.heavy && !f.landed && fx && fx.dustPuff) fx.dustPuff(root.position.add(V3(f.C.x, 0, f.C.z)));
              f.landed = true;
            }
            // sliding friction; the sword and shield keep toppling until they lie down
            f.v.x *= 0.9; f.v.z *= 0.9;
            V3(0, 1, 0).rotateByQuaternionToRef(f.q, tmp);
            const wl2 = f.w.length();
            if (f.heavy && Math.abs(tmp.y) > 0.3 && wl2 > 1e-4) f.w.scaleInPlace(Math.max(wl2, 2.6) / wl2);
            else f.w.scaleInPlace(0.9);
          }
          f.node.rotationQuaternion.copyFrom(f.q);
          f.node.position.copyFrom(f.C.subtract(f.cl.scale(f.sc).applyRotationQuaternion(f.q)));
        });
      }, Ease.linear);
    }

    async dissolve() {
      const fx = this.ctx.effects, team = Config.TEAM[this.color];
      if (this._glint) this._glint.mesh.setEnabled(false);
      if (fx && fx.dissolve) fx.dissolve(this.root.position.clone(), team.glow, this._shattered ? 0.25 : Config.PIECE_HEIGHT.p);
      const meshes = this._meshes.filter((m) => m.name !== `base_${this.id}`);
      await Tween.run(this._shattered ? 1000 : 700, (t) => { meshes.forEach((m) => { m.visibility = 1 - t; }); }, Ease.inCubic);
    }

    // Victory: the sword thrust straight up, blazing, then grounded again.
    async playVictory() {
      this.busy = true;
      const fx = this.ctx.effects, team = Config.TEAM[this.color];
      const cur = clonePose(this._cur);
      const up = withPose(marchPose(), { sword: swordAt([0.15, 1.3, 0.08], [0.04, 1, 0.08], 0), elbowR: [1, -0.3, -0.2], chest: [-0.1, 0, 0], head: [-0.15, 0, 0], glow: 1.6 });
      await this._playKeys([[0, cur], [300, withPose(mixPose(cur, up, 0.5), { strap: 0.6 })], [640, up]]);
      if (fx && fx.burst) fx.burst({ pos: this.parts.swordTip.getAbsolutePosition(), color1: '#ffffff', color2: team.glow, count: 40, speed: { min: 0.5, max: 2 }, life: 0.8, size: 0.1 });
      if (window.ChessSound && ChessSound.playClang) ChessSound.playClang(0.5, 1.3);
      await Tween.wait(900);
      await this._playKeys([[0, clonePose(this._cur)], [700, this._stance === 'rest' ? restPose() : marchPose()]]);
      this.busy = false;
    }
  }

  // The pose toolkit, for pawn-fidgets.js.
  PawnCharacter.kit = { restPose, marchPose, withPose, clonePose, mixPose, flat, unflat, swordAt, planted, legReach,
    STAND_Y, ANK, S, G, SWORD };
  window.Chess3D.PawnCharacter = PawnCharacter;
})();
