// KingCharacter: the king piece ('k'), after the paladin-king reference — a
// bearded king with long wavy hair and a jewelled crown, in silver plate
// chased with gold filigree (a gold rondel on the left pauldron, gold fleurons
// on the right), a gold-bordered cape over his shoulders and a green cloth
// panel under a green leather belt, holding a great sword with a flared gold
// guard. He is always seated on his throne, both hands resting on the
// pommel of the sword planted before him.
//
// Everything is built from parametric surfaces (the face is a sculpted head
// surface with nose, brow, sockets, lips and chin; hair and beard are swept
// locks and shells) on a small skeleton driven by two-bone IK: the legs
// reach for foot targets and the hands for grip points on the sword, so a
// pose is just "where the hips, feet and sword are".
//
// Moving: he rises, the throne sinks into the board, he walks slowly to the
// square, turns, the throne rises behind him and he sits again.
// Attacking: three shining two-handed cuts with light trails behind the blade.
// Dying: he slumps on the throne and a pale ghost of him rises to the sky.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const ProceduralCharacter = window.Chess3D.ProceduralCharacter;
  const MB = BABYLON.MeshBuilder;
  const Vec = BABYLON.Vector3, Mat = BABYLON.Matrix, Quat = BABYLON.Quaternion;
  const { TAU, hex, V3, lerp, clamp, smoothstep, spow, curve, bezier, grid, sweep } = window.Chess3D.SurfaceKit;

  // ------------------------------------------------------------ skeleton
  // Visual space: origin on the board under the piece, +z forward, soles on
  // the team disc (y = G). Standing, the hips node is 0.53 above the soles.
  const G = 0.07;
  const LEN = { thigh: 0.235, shin: 0.23, ankle: 0.055, upper: 0.2, fore: 0.19 };
  const NODE = {
    spine: [0, 0.08, 0], chest: [0, 0.15, 0], neck: [0, 0.112, -0.004], head: [0, 0.05, 0.01], face: [0, 0.058, 0.012],
    shoulder: [0.148, 0.078, -0.006], hip: [0.078, -0.018, 0]
  };
  const STAND_Y = G + 0.53;
  const FRONT = 0.14;                          // standing in front of the throne: this far ahead of its centre
  const HAND_GRIP = (s) => [-s * 0.012, -0.062, 0];   // grip axis through the fist, in hand space
  const SWORD = { blade: 0.55, gripR: -0.035, gripL: -0.098 };
  const WALK = { step: 0.16, duty: 0.62, speed: 0.5, ramp: 0.18 };
  const SOUL_MS = 4400;                        // the ghost's whole ascent

  // ------------------------------------------------------------ livery
  const LIVERY = {
    w: { hair: '#94703f', hairHi: '#d8b479', hairDark: '#5a4022', beard: '#80603a', skin: '#e0b08c', lips: '#a85e52', iris: '#6a5236',
      cape: '#efe7d4', capeShade: '#d8ccb0', panel: '#1f5a3c', strap: '#1d4d34', leather: '#3b2a1b', gem: '#e0203c', gem2: '#2f6fe0',
      mail: '#9aa0aa', soul: '#d6ecff' },
    b: { hair: '#2b1e15', hairHi: '#6a4d33', hairDark: '#140d08', beard: '#261a12', skin: '#c3926f', lips: '#8a4a42', iris: '#4a3322',
      cape: '#5a0f1c', capeShade: '#3a0812', panel: '#4a0d18', strap: '#3a0a12', leather: '#1e1510', gem: '#ff3a44', gem2: '#9a4dff',
      mail: '#4a4a52', soul: '#ffe0d6' }
  };

  // ------------------------------------------------------------ textures
  // Canvases are painted once per colour scheme and shared by every king;
  // each king wraps them in its own DynamicTexture (which never owns them).
  const canvasCache = new Map();
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function rgb(c) { const k = hex(c); return [k.r * 255, k.g * 255, k.b * 255]; }

  function boxBlur(src, w, h, r) {
    const a = Float32Array.from(src), t = new Float32Array(w * h), n = 2 * r + 1;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < h; y++) {
        let acc = 0; const row = y * w;
        for (let k = -r; k <= r; k++) acc += a[row + ((k % w) + w) % w];
        for (let x = 0; x < w; x++) {
          t[row + x] = acc / n;
          acc += a[row + (x + r + 1) % w] - a[row + ((x - r) % w + w) % w];
        }
      }
      for (let x = 0; x < w; x++) {
        let acc = 0;
        for (let k = -r; k <= r; k++) acc += t[clamp(k, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = acc / n;
          acc += t[Math.min(h - 1, y + r + 1) * w + x] - t[Math.max(0, y - r) * w + x];
        }
      }
    }
    return a;
  }

  // Raised ornament. drawHeight(ctx, w, h) paints the relief white on black
  // (grey = lower relief); opts.drawColor, same convention, picks where the
  // `raised` colour shows (else the relief itself does). The relief's outlines
  // are engraved dark. Returns { albedo, normal } canvases.
  function embossed(key, w, h, base, raised, drawHeight, opts) {
    if (canvasCache.has(key)) return canvasCache.get(key);
    opts = opts || {};
    const paintMask = (fn) => {
      const c = makeCanvas(w, h), x = c.getContext('2d');
      x.fillStyle = '#000'; x.fillRect(0, 0, w, h);
      x.fillStyle = x.strokeStyle = '#fff'; x.lineCap = x.lineJoin = 'round';
      fn(x, w, h);
      const d = x.getImageData(0, 0, w, h).data, m = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) m[i] = d[i * 4] / 255;
      return m;
    };
    const hm = paintMask(drawHeight), cm = opts.drawColor ? paintMask(opts.drawColor) : hm;
    const soft = boxBlur(hm, w, h, opts.soft || 2), sharp = boxBlur(cm, w, h, 1);
    const A = makeCanvas(w, h), N = makeCanvas(w, h), ac = A.getContext('2d'), nc = N.getContext('2d');
    const ai = ac.createImageData(w, h), ni = nc.createImageData(w, h);
    const B = rgb(base), R = rgb(raised), bump = opts.bump || 3;
    const noise = opts.noise == null ? 0.05 : opts.noise, lines = opts.lines == null ? 0.55 : opts.lines;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, o = i * 4;
        const dx = soft[y * w + (x + 1) % w] - soft[y * w + (x - 1 + w) % w];
        const dy = soft[Math.min(h - 1, y + 1) * w + x] - soft[Math.max(0, y - 1) * w + x];
        const k = smoothstep(0.3, 0.7, sharp[i]), edge = Math.min(1, Math.hypot(dx, dy) * 3);
        const g = (1 - lines * edge) * (1 + noise * (Math.random() - 0.5) + (opts.brushed ? 0.035 * Math.sin(y * 1.9 + 3 * Math.sin(x * 0.04)) : 0));
        ai.data[o] = clamp(lerp(B[0], R[0], k) * g, 0, 255);
        ai.data[o + 1] = clamp(lerp(B[1], R[1], k) * g, 0, 255);
        ai.data[o + 2] = clamp(lerp(B[2], R[2], k) * g, 0, 255);
        ai.data[o + 3] = 255;
        const nx = -dx * bump, ny = dy * bump, l = Math.hypot(nx, ny, 1);
        ni.data[o] = (nx / l * 0.5 + 0.5) * 255; ni.data[o + 1] = (ny / l * 0.5 + 0.5) * 255; ni.data[o + 2] = (1 / l * 0.5 + 0.5) * 255; ni.data[o + 3] = 255;
      }
    }
    ac.putImageData(ai, 0, 0); nc.putImageData(ni, 0, 0);
    const out = { albedo: A, normal: N };
    canvasCache.set(key, out);
    return out;
  }

  function painted(key, w, h, paint) {
    if (!canvasCache.has(key)) { const c = makeCanvas(w, h); paint(c.getContext('2d'), w, h); canvasCache.set(key, c); }
    return canvasCache.get(key);
  }

  // --- filigree strokes (mask canvases: white = raised) ---
  function spiral(c, cx, cy, r0, turns, dir, lw, a0) {
    c.lineWidth = lw; c.beginPath();
    let x = cx, y = cy;
    for (let i = 0; i <= 36; i++) {
      const t = i / 36, a = a0 + dir * t * turns * TAU, r = r0 * (1 - 0.82 * t);
      x = cx + Math.cos(a) * r; y = cy + Math.sin(a) * r;
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    }
    c.stroke();
    c.beginPath(); c.arc(x, y, lw * 0.9, 0, TAU); c.fill();
  }
  function leaf(c, x, y, ang, len, wid) {
    c.save(); c.translate(x, y); c.rotate(ang); c.beginPath(); c.moveTo(0, 0);
    c.quadraticCurveTo(len * 0.45, -wid, len, 0); c.quadraticCurveTo(len * 0.45, wid, 0, 0); c.fill(); c.restore();
  }
  // Scroll vine along x from x0 to x1 round y = yc: a wavy stem with a curl
  // in the hollow of every bay and a leaf at every crossing.
  function vine(c, x0, x1, yc, amp, period, lw) {
    c.lineWidth = lw; c.beginPath();
    for (let x = x0; x <= x1; x += 2) {
      const y = yc + amp * Math.sin((x - x0) / period * TAU);
      if (x === x0) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    const half = period / 2;
    for (let k = 0; x0 + (k + 0.5) * half < x1; k++) {
      const bulge = k % 2 ? -1 : 1, sx = x0 + (k + 0.5) * half;
      spiral(c, sx, yc - bulge * amp * 0.2, amp * 0.72, 1.35, bulge, lw * 0.75, bulge > 0 ? Math.PI / 2 : -Math.PI / 2);
      leaf(c, x0 + k * half, yc, (k % 2 ? 1 : -1) * 0.9, amp * 0.8, amp * 0.24);
    }
  }
  function vvine(c, cx, y0, y1, amp, period, lw) {
    c.save(); c.translate(cx, y0); c.rotate(Math.PI / 2); vine(c, 0, y1 - y0, 0, amp, period, lw); c.restore();
  }
  function rosette(c, cx, cy, r, petals, lw) {
    c.lineWidth = lw;
    c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.stroke();
    c.beginPath(); c.arc(cx, cy, r * 0.25, 0, TAU); c.fill();
    for (let i = 0; i < petals; i++) {
      const a = i / petals * TAU;
      leaf(c, cx + Math.cos(a) * r * 0.3, cy + Math.sin(a) * r * 0.3, a, r * 0.58, r * 0.19);
    }
  }
  function fleur(c, x, y, s) {
    leaf(c, x, y + s * 0.2, -Math.PI / 2, s, s * 0.28);
    [-1, 1].forEach((k) => {
      c.save(); c.translate(x, y + s * 0.15); c.scale(k, 1);
      c.lineWidth = s * 0.14; c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(s * 0.55, -s * 0.2, s * 0.45, -s * 0.62); c.stroke();
      c.beginPath(); c.arc(s * 0.45, -s * 0.62, s * 0.1, 0, TAU); c.fill();
      c.restore();
    });
    c.fillRect(x - s * 0.34, y + s * 0.18, s * 0.68, s * 0.12);
    leaf(c, x, y + s * 0.3, Math.PI / 2, s * 0.45, s * 0.2);
  }
  function hline(c, y, w, lw) { c.lineWidth = lw; c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
  const ink = (c, color) => { c.fillStyle = c.strokeStyle = color; };

  // --- layouts ---
  // Breastplate/backplate: u round the torso (0.5 = front), v from the neck down.
  function drawCuirass(c, w, h) {
    c.fillRect(0, 0, w, h * 0.05); c.fillRect(0, h * 0.94, w, h * 0.06);
    ink(c, '#000'); vine(c, 0, w, h * 0.025, h * 0.012, 64, 3); vine(c, 0, w, h * 0.97, h * 0.014, 64, 3); ink(c, '#fff');
    hline(c, h * 0.075, w, 4); hline(c, h * 0.915, w, 4);
    [0, w].forEach((x) => { c.lineWidth = 5; c.strokeRect(x - 26, h * 0.075, 52, h * 0.84); vvine(c, x, h * 0.09, h * 0.9, 13, 96, 4); });
    const cx = w / 2;
    c.lineWidth = 6; c.strokeRect(cx - 50, h * 0.075, 100, h * 0.84);
    vvine(c, cx, h * 0.5, h * 0.9, 24, 110, 5);
    ink(c, '#000'); c.beginPath(); c.arc(cx, h * 0.3, 72, 0, TAU); c.fill(); ink(c, '#fff');
    rosette(c, cx, h * 0.3, 64, 12, 7);
    c.lineWidth = 3; c.beginPath(); c.arc(cx, h * 0.3, 74, 0, TAU); c.stroke();
    [-1, 1].forEach((s) => {
      c.lineWidth = 9; c.beginPath();
      c.moveTo(cx + s * 56, h * 0.09); c.bezierCurveTo(cx + s * 150, h * 0.12, cx + s * 220, h * 0.26, cx + s * 236, h * 0.5); c.stroke();
      for (let k = 0; k < 4; k++) {
        const t = 0.18 + k * 0.22, bx = cx + s * lerp(70, 230, t), by = h * lerp(0.1, 0.46, t * t);
        spiral(c, bx - s * 22, by + 22, 20, 1.3, s, 4, -Math.PI / 2);
        leaf(c, bx, by, s > 0 ? 2.2 : 0.9, 26, 8);
      }
      c.lineWidth = 4; c.beginPath(); c.moveTo(cx + s * 56, h * 0.62); c.quadraticCurveTo(cx + s * 140, h * 0.7, cx + s * 150, h * 0.88); c.stroke();
    });
    [0.25, 0.75].forEach((u) => {
      c.fillRect(u * w - 5, h * 0.075, 10, h * 0.84);
      for (let y = h * 0.14; y < h * 0.9; y += 46) { c.beginPath(); c.arc(u * w, y, 8, 0, TAU); c.fill(); }
    });
  }
  // Limb plates: u round the limb (0.5 = front), v from the top down.
  function drawLimb(c, w, h) {
    c.fillRect(0, 0, w, h * 0.1); c.fillRect(0, h * 0.9, w, h * 0.1);
    ink(c, '#000'); vine(c, 0, w, h * 0.05, h * 0.028, 64, 3); vine(c, 0, w, h * 0.95, h * 0.028, 64, 3); ink(c, '#fff');
    hline(c, h * 0.135, w, 3); hline(c, h * 0.865, w, 3);
    c.lineWidth = 4; c.strokeRect(w * 0.43, h * 0.135, w * 0.14, h * 0.73);
    vvine(c, w * 0.5, h * 0.15, h * 0.85, w * 0.04, h * 0.28, 4);
    [0.18, 0.82].forEach((u) => vvine(c, w * u, h * 0.2, h * 0.8, w * 0.025, h * 0.3, 3));
  }
  // Lames (pauldrons, fauld, tassets, gorget): v from the top down to the free edge.
  function drawLame(c, w, h) {
    c.fillRect(0, h * 0.7, w, h * 0.3);
    ink(c, '#000'); vine(c, 0, w, h * 0.85, h * 0.07, w / 6, 3); ink(c, '#fff');
    hline(c, h * 0.62, w, 3); hline(c, h * 0.06, w, 3);
    for (let x = w / 16; x < w; x += w / 8) { c.beginPath(); c.arc(x, h * 0.36, 5, 0, TAU); c.fill(); }
  }
  function drawGoldBand(c, w, h) {
    c.fillStyle = '#444'; c.fillRect(0, 0, w, h); ink(c, '#fff');
    vine(c, 0, w, h / 2, h * 0.22, w / 2, 5);
    hline(c, h * 0.08, w, 6); hline(c, h * 0.92, w, 6);
  }
  function drawCape(c, w, h) {
    ink(c, '#555');
    for (let y = 40; y < h * 0.86; y += 76) {
      for (let x = 60 + (Math.round(y / 76) % 2) * 44; x < w - 50; x += 88) fleur(c, x, y, 20);
    }
    ink(c, '#fff');
    c.fillRect(0, 0, 34, h); c.fillRect(w - 34, 0, 34, h); c.fillRect(0, h * 0.92, w, h * 0.08);
    ink(c, '#000');
    vvine(c, 17, 0, h, 10, 70, 3); vvine(c, w - 17, 0, h, 10, 70, 3); vine(c, 0, w, h * 0.96, h * 0.02, 70, 3);
    ink(c, '#fff');
    c.lineWidth = 4; c.beginPath(); c.moveTo(44, 0); c.lineTo(44, h * 0.9); c.lineTo(w - 44, h * 0.9); c.lineTo(w - 44, 0); c.stroke();
  }
  function drawCapeColor(c, w, h) {
    c.fillRect(0, 0, 34, h); c.fillRect(w - 34, 0, 34, h); c.fillRect(0, h * 0.92, w, h * 0.08);
    c.lineWidth = 4; c.beginPath(); c.moveTo(44, 0); c.lineTo(44, h * 0.9); c.lineTo(w - 44, h * 0.9); c.lineTo(w - 44, 0); c.stroke();
  }
  function drawPanel(c, w, h) {
    c.lineWidth = 8; c.strokeRect(14, 10, w - 28, h - 24);
    c.lineWidth = 3; c.strokeRect(28, 24, w - 56, h - 52);
    vvine(c, w / 2, 40, h * 0.72, 30, 120, 5);
    fleur(c, w / 2, h * 0.84, 48);
    c.fillRect(0, h - 14, w, 14);
  }
  function drawVelvet(c, w, h) {
    c.fillStyle = '#fff'; c.fillRect(0, 0, w, h); ink(c, '#000'); c.lineWidth = 5;
    for (let k = -2; k <= 2; k++) {
      c.beginPath(); c.moveTo(k * w / 2, 0); c.lineTo(k * w / 2 + w, h); c.stroke();
      c.beginPath(); c.moveTo(k * w / 2 + w, 0); c.lineTo(k * w / 2, h); c.stroke();
    }
    ink(c, '#fff');
  }
  function drawVelvetButtons(c, w, h) {
    [[0, 0], [w / 2, h / 2], [w, 0], [0, h], [w, h], [w / 2, -h / 2]].forEach(([x, y]) => { c.beginPath(); c.arc(x, y, 7, 0, TAU); c.fill(); });
  }
  function drawMail(c, w, h) {
    c.lineWidth = 2.4;
    for (let y = 0; y <= h; y += 8) {
      for (let x = ((y / 8) % 2) * 5; x <= w; x += 10) { c.beginPath(); c.arc(x, y, 4.6, 0, TAU); c.stroke(); }
    }
  }
  function paintHair(c, w, h, L) {
    c.fillStyle = L.hair; c.fillRect(0, 0, w, h);
    const tones = [L.hairDark, L.hair, L.hairHi, L.hairHi];
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * w, y0 = Math.random() * h * 0.6, len = 40 + Math.random() * h;
      c.strokeStyle = tones[i % 4]; c.globalAlpha = 0.25 + Math.random() * 0.35; c.lineWidth = 0.6 + Math.random() * 1.6;
      c.beginPath(); c.moveTo(x, y0); c.quadraticCurveTo(x + (Math.random() - 0.5) * 10, y0 + len / 2, x + (Math.random() - 0.5) * 6, y0 + len); c.stroke();
    }
    c.globalAlpha = 1;
    const g = c.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0.25)'); g.addColorStop(0.25, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.05)');
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  }
  function paintRunes(c, w, h) {
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#fff'; c.lineWidth = 2.2; c.lineCap = 'round';
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let x = 6; x < w - 6; x += 14) {
      c.beginPath();
      const n = 2 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const ax = x + rnd() * 8, ay = 5 + rnd() * (h - 10), bx = x + rnd() * 8, by = 5 + rnd() * (h - 10);
        c.moveTo(ax, ay); c.lineTo(bx, by);
      }
      c.stroke();
    }
  }

  // ------------------------------------------------------------ head
  // Face space: origin at the centre of the skull, +z out of the face.
  // Keys [y, half-width, front depth, back depth], bottom to top.
  const HEAD = [
    [-0.09, 0.028, 0.006, 0.05], [-0.078, 0.026, 0.014, 0.046], [-0.071, 0.025, 0.03, 0.04], [-0.065, 0.027, 0.045, 0.033],
    [-0.057, 0.033, 0.052, 0.031], [-0.046, 0.04, 0.054, 0.034], [-0.034, 0.043, 0.056, 0.042], [-0.02, 0.046, 0.055, 0.05],
    [-0.006, 0.048, 0.055, 0.055], [0.008, 0.049, 0.057, 0.058], [0.022, 0.048, 0.056, 0.059], [0.038, 0.045, 0.051, 0.056],
    [0.052, 0.039, 0.042, 0.048], [0.062, 0.03, 0.031, 0.036], [0.068, 0.018, 0.018, 0.022], [0.071, 0, 0, 0]
  ];
  // Nose keys [y, projection, width].
  const NOSE = [[-0.032, 0, 0.007], [-0.029, 0.003, 0.008], [-0.027, 0.01, 0.009], [-0.024, 0.017, 0.0095], [-0.02, 0.018, 0.008],
    [-0.013, 0.0135, 0.0065], [-0.004, 0.008, 0.0055], [0.006, 0.003, 0.0055], [0.015, 0, 0.006]];
  const EYE = { x: 0.0205, y: 0.0058, r: 0.0105 };
  const headTh = (u) => { const s = 2 * u - 1; return Math.PI * (0.45 * s + 0.55 * s * s * s); };
  const HEAD_V = [[0, 0.071], [0.16, 0.048], [0.78, -0.062], [1, -0.09]];
  function headY(v) {
    let i = 0;
    while (i < HEAD_V.length - 2 && v > HEAD_V[i + 1][0]) i++;
    const a = HEAD_V[i], b = HEAD_V[i + 1];
    return lerp(a[1], b[1], (v - a[0]) / (b[0] - a[0]));
  }
  const gauss = (dx, sx, dy, sy) => Math.exp(-(dx / sx) * (dx / sx) - (dy / sy) * (dy / sy));

  function headPoint(th, y, lift) {
    const [w, f, b] = curve(HEAD, clamp(y, -0.09, 0.071)).map((k) => Math.max(0, k));
    const c = Math.cos(th), s = Math.sin(th), e = c >= 0 ? 2.3 : 2.0;
    let x = w * spow(s, 2 / e), z = (c >= 0 ? f : b) * spow(c, 2 / e);
    const front = smoothstep(0.15, 0.6, c), ax = Math.abs(x);
    const [nd, nw] = y > -0.032 && y < 0.015 ? curve(NOSE, y) : [0, 0.006];
    const dz = Math.max(0, nd) * Math.exp(-(x / nw) * (x / nw))
      + 0.0045 * gauss(ax - 0.0105, 0.0045, y + 0.0255, 0.0045)       // nostril wings
      - 0.0065 * gauss(ax - EYE.x, 0.0115, y - EYE.y, 0.0075)         // eye sockets
      + 0.0035 * gauss(ax - 0.02, 0.017, y - 0.0175, 0.0055)          // brow ridge
      + 0.003 * gauss(ax - 0.034, 0.012, y + 0.01, 0.01)              // cheekbones
      - 0.002 * gauss(ax - 0.034, 0.01, y + 0.03, 0.01)               // hollows under them
      + 0.0033 * gauss(x, 0.0135, y + 0.032, 0.0036) + 0.0036 * gauss(x, 0.0125, y + 0.0415, 0.0036)   // lips
      - 0.0024 * gauss(x, 0.0145, y + 0.0368, 0.0012)                 // parting of the lips
      + 0.0042 * gauss(x, 0.014, y + 0.058, 0.007);                   // chin
    z += dz * front;
    x *= 1 - 0.05 * Math.exp(-Math.pow((y - 0.03) / 0.012, 2)) * Math.exp(-Math.pow((c - 0.35) / 0.35, 2));   // temples
    if (lift) {
      const nx = x / 0.0022, ny = y / 0.0049, nz = z / 0.0034, l = Math.hypot(nx, ny, nz) || 1;
      x += lift * nx / l; y += lift * ny / l; z += lift * nz / l;
    }
    return [x, y, z];
  }
  // Point on the face at lateral offset x and height y (front half).
  function faceAt(x, y, lift) {
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (headPoint(mid, y, 0)[0] < Math.abs(x)) lo = mid; else hi = mid; }
    return headPoint((x < 0 ? -1 : 1) * lo, y, lift);
  }
  // Hairline height round the head (θ = 0 at the brow).
  function hairline(th) {
    const a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
    if (a < 0.55) return 0.037 + 0.003 * (a / 0.55);
    if (a < 1.45) return lerp(0.04, 0.004, smoothstep(0.55, 1.45, a));
    return lerp(0.004, -0.066, smoothstep(1.45, 1.9, a));
  }

  function paintFace(c, w, h, L) {
    const img = c.createImageData(w, h), sk = rgb(L.skin), lp = rgb(L.lips), hr = rgb(L.hair);
    for (let py = 0; py < h; py++) {
      const y = headY((py + 0.5) / h);
      const [hw] = curve(HEAD, y);
      for (let px = 0; px < w; px++) {
        const th = headTh((px + 0.5) / w), x = hw * Math.sin(th), ax = Math.abs(x), front = Math.cos(th) > 0 ? 1 : 0;
        let col = sk.slice(), k;
        const mix = (to, t) => { col = col.map((v, i) => lerp(v, to[i], clamp(t, 0, 1))); };
        mix([sk[0] * 1.02, sk[1] * 0.82, sk[2] * 0.8], 0.35 * front * gauss(ax - 0.033, 0.012, y + 0.012, 0.012));   // cheeks
        mix([sk[0] * 1.04, sk[1] * 0.84, sk[2] * 0.82], 0.3 * front * gauss(x, 0.007, y + 0.02, 0.006));             // nose tip
        k = front * Math.exp(-Math.pow(x / 0.016, 4)) * (gauss(0, 1, y + 0.032, 0.0038) + gauss(0, 1, y + 0.0415, 0.0042));
        mix(lp, 0.85 * k);                                                                                           // lips
        mix([sk[0] * 0.55, sk[1] * 0.42, sk[2] * 0.4], 0.8 * front * gauss(ax - 0.0056, 0.0022, y + 0.0268, 0.0016)); // nostrils
        mix([sk[0] * 0.7, sk[1] * 0.58, sk[2] * 0.56], 0.45 * front * gauss(ax - EYE.x, 0.011, y - 0.0125, 0.0028)); // lid creases
        mix([sk[0] * 0.8, sk[1] * 0.68, sk[2] * 0.68], 0.25 * front * gauss(ax - EYE.x, 0.011, y + 0.004, 0.003));   // under the eyes
        mix([sk[0] * 0.75, sk[1] * 0.62, sk[2] * 0.6], 0.3 * front * gauss(ax - 0.004, 0.0014, y - 0.012, 0.007));   // frown lines
        if (y > hairline(th) - 0.004) mix(hr, 0.85 * smoothstep(hairline(th) - 0.004, hairline(th) + 0.004, y));
        const n = 1 + (Math.random() - 0.5) * 0.05;
        const o = (py * w + px) * 4;
        img.data[o] = clamp(col[0] * n, 0, 255); img.data[o + 1] = clamp(col[1] * n, 0, 255); img.data[o + 2] = clamp(col[2] * n, 0, 255); img.data[o + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------ torso
  // Cuirass keys [y, half-width, front, back] in chest space.
  const CUIRASS = [[-0.168, 0.106, 0.084, 0.078], [-0.13, 0.104, 0.087, 0.077], [-0.08, 0.111, 0.096, 0.079], [-0.03, 0.12, 0.106, 0.083],
    [0.02, 0.128, 0.112, 0.087], [0.055, 0.132, 0.106, 0.089], [0.08, 0.125, 0.092, 0.085], [0.098, 0.105, 0.074, 0.071], [0.112, 0.068, 0.055, 0.056]];
  function cuirassPoint(a, y, lift) {
    const [hw, zf, zb] = curve(CUIRASS, clamp(y, -0.168, 0.112)), c = Math.cos(a), s = Math.sin(a), l = lift || 0;
    const e = c >= 0 ? 2.5 : 2.2;
    const x = (hw + l) * spow(s, 2 / e);
    let z = ((c >= 0 ? zf : zb) + l) * spow(c, 2 / e);
    const ax = Math.abs(x);
    z += Math.max(0, c) * (0.009 * gauss(ax - 0.056, 0.04, y - 0.028, 0.04)
      + 0.0035 * Math.exp(-(x / 0.008) * (x / 0.008)) * smoothstep(-0.16, -0.1, y) * (1 - smoothstep(0.07, 0.1, y)));
    z -= Math.max(0, -c) * 0.006 * gauss(ax - 0.055, 0.035, y - 0.04, 0.05);
    return [x, y, z];
  }

  // Cape in chest space: u across from the right edge (0) to the left (1),
  // v from the shoulders to the hem. Keys [v, half-width, centre z, curl,
  // centre y, extra height at the edges] per shape.
  const CAPE = {
    stand: [[0, 0.165, 0.004, 0.09, 0.134, 0.036], [0.06, 0.19, -0.035, 0.082, 0.112, 0.02], [0.12, 0.205, -0.07, 0.074, 0.062, 0],
      [0.4, 0.23, -0.1, 0.08, -0.2, 0], [0.7, 0.26, -0.13, 0.1, -0.47, 0], [1, 0.29, -0.17, 0.12, -0.745, 0]],
    sit: [[0, 0.165, 0.004, 0.09, 0.134, 0.036], [0.06, 0.19, -0.035, 0.082, 0.112, 0.02], [0.12, 0.2, -0.066, 0.072, 0.062, 0],
      [0.38, 0.205, -0.076, 0.07, -0.2, 0], [0.55, 0.215, -0.07, 0.06, -0.29, 0], [0.75, 0.24, -0.02, 0.05, -0.305, 0], [1, 0.255, 0.04, 0.04, -0.41, 0]],
    billow: [[0, 0.165, 0.004, 0.09, 0.134, 0.036], [0.06, 0.19, -0.04, 0.082, 0.112, 0.02], [0.12, 0.21, -0.085, 0.076, 0.062, 0],
      [0.4, 0.25, -0.15, 0.09, -0.19, 0], [0.7, 0.28, -0.23, 0.11, -0.44, 0], [1, 0.31, -0.31, 0.12, -0.69, 0]]
  };
  function capePoint(keys, u, v) {
    const phi = (u - 0.5) * Math.PI * 0.92;
    const [A, zc, B, yc, ye] = curve(keys, v);
    const deep = smoothstep(0.08, 1, v), fold = 0.028 * deep * Math.sin(7 * phi + 0.6) + 0.01 * deep * Math.sin(15 * phi + 2);
    return [-A * Math.sin(phi) + 0.008 * deep * Math.cos(7 * phi + 0.6), yc + ye * Math.pow(Math.sin(phi), 2), zc - (B + fold) * Math.cos(phi)];
  }
  // The cape hangs from a pivot behind the neck, counter-rotated against the
  // torso's lean and twist so it keeps falling behind him.
  const CAPE_PIVOT = [0, 0.125, -0.06];
  const capeLocal = (keys, u, v) => { const p = capePoint(keys, u, v); return [p[0] - CAPE_PIVOT[0], p[1] - CAPE_PIVOT[1], p[2] - CAPE_PIVOT[2]]; };
  // Cloth panel hanging from the belt, hips space: keys [v, y, z, half-width].
  const PANEL = {
    stand: [[0, 0.07, 0.1], [0.12, 0.03, 0.112], [0.3, -0.03, 0.112], [1, -0.26, 0.104]],
    sit: [[0, 0.07, 0.1], [0.12, 0.056, 0.13], [0.3, 0.05, 0.17], [0.6, 0.046, 0.24], [0.8, 0.005, 0.275], [1, -0.05, 0.28]],
    billow: [[0, 0.07, 0.1], [0.12, 0.03, 0.114], [0.3, -0.03, 0.125], [1, -0.235, 0.18]]
  };
  function panelPoint(keys, u, v) {
    const [y, z] = curve(keys, v), s = 1 - 2 * u, hw = 0.05 + 0.014 * v;
    return [hw * s, y, z - 0.014 * s * s];
  }

  // ------------------------------------------------------------ poses
  // A pose is plain numbers: hips position/rotation, spine/chest/neck/head
  // rotations, ankle targets [x, y, z, pitch, yaw], the sword's guard and
  // blade direction [x, y, z, dx, dy, dz, roll] (all in visual space), grip
  // weights (1 = that hand on the sword), free hand targets and thumb
  // directions, elbow pole directions, and the cape/cloth and blade glow.
  const FIELDS = ['hips', 'hipsRot', 'spine', 'chest', 'neck', 'head', 'footR', 'footL', 'kneeOut', 'sword', 'gripR', 'gripL',
    'handR', 'handL', 'thumbR', 'thumbL', 'elbowR', 'elbowL', 'sit', 'billow', 'glow'];
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
  function shiftPose(P, dz) {
    const Q = clonePose(P);
    [Q.hips, Q.footR, Q.footL, Q.sword, Q.handR, Q.handL].forEach((p) => { p[2] += dz; });
    return Q;
  }

  function standPose(dz) {
    return {
      hips: [0, STAND_Y, dz], hipsRot: [0, 0, 0], spine: [0.02, 0, 0], chest: [-0.03, 0, 0], neck: [0, 0, 0], head: [0.03, 0, 0],
      footR: [0.095, G + LEN.ankle, dz + 0.012, 0, 0.12], footL: [-0.095, G + LEN.ankle, dz - 0.004, 0, -0.12], kneeOut: 0.25,
      sword: [0.09, 0.78, dz + 0.15, 0.1, 0.76, -0.64, 0.25], gripR: 1, gripL: 0,
      handR: [0.22, 0.5, dz + 0.02], handL: [-0.215, 0.53, dz + 0.04], thumbR: [0, 0, 1], thumbL: [0.25, 0, 1],
      elbowR: [0.8, -0.7, -0.5], elbowL: [-1, -0.3, -0.5], sit: 0, billow: 0, glow: 0
    };
  }
  // The sword planted before the throne: tip on the board, hilt at the lap.
  const PLANTED = (() => {
    const D = V3(0, -0.9, 0.44).normalize(), tip = V3(0, G + 0.003, 0.34), g = tip.subtract(D.scale(SWORD.blade));
    return [g.x, g.y, g.z, D.x, D.y, D.z, 0];
  })();
  function sitPose() {
    return {
      hips: [0, 0.378, -0.1], hipsRot: [0, 0, 0], spine: [0, 0, 0], chest: [-0.03, 0, 0], neck: [0, 0, 0], head: [0.04, 0, 0],
      footR: [0.13, G + LEN.ankle, 0.15, 0, 0.2], footL: [-0.13, G + LEN.ankle, 0.15, 0, -0.2], kneeOut: 0.45,
      sword: PLANTED.slice(), gripR: 1, gripL: 1,
      handR: [0.12, 0.42, 0.1], handL: [-0.12, 0.42, 0.1], thumbR: [0, 0, 1], thumbL: [0, 0, 1],
      elbowR: [0.9, -0.65, -0.3], elbowL: [-0.9, -0.65, -0.3], sit: 1, billow: 0, glow: 0
    };
  }
  function fightPose() {
    return withPose(standPose(0), {
      hips: [0, 0.575, 0], hipsRot: [0, 0.12, 0], spine: [0.04, 0.05, 0], chest: [0.02, 0.05, 0], head: [0.05, -0.12, 0],
      footR: [0.1, G + LEN.ankle, 0.09, 0, 0.15], footL: [-0.12, G + LEN.ankle, -0.1, 0, -0.35], kneeOut: 0.35,
      sword: [0.04, 0.8, 0.24, 0.05, 0.78, 0.62, 0], gripR: 1, gripL: 1,
      elbowR: [1, -0.6, -0.3], elbowL: [-1, -0.7, -0.2], glow: 0.6, billow: 0.25
    });
  }

  // One foot's stride at phase p: stance (planted, sliding back under the
  // body at exactly the walking speed) then swing forward. [z, lift, pitch].
  function footCycle(p, L, duty) {
    const Ld = L * duty;
    const heel = (pitch) => (pitch > 0 ? 0.1 * Math.sin(pitch) : 0.035 * Math.sin(-pitch));
    if (p < duty) {
      const s = p / duty, pitch = -0.22 * (1 - smoothstep(0, 0.18, s)) + 0.42 * smoothstep(0.72, 1, s);
      return [Ld * (1 - 2 * s), heel(pitch), pitch];
    }
    const s = (p - duty) / (1 - duty), pitch = lerp(0.42, -0.22, smoothstep(0.1, 0.95, s));
    return [lerp(-Ld, Ld, s * s * (3 - 2 * s)), 0.028 * Math.sin(Math.PI * s) + heel(pitch), pitch];
  }
  // Trapezoid velocity profile: accelerate over `ramp`, cruise, decelerate.
  function cruise(ramp) {
    const vmax = 1 / (1 - ramp);
    return (t) => {
      if (t < ramp) return vmax * t * t / (2 * ramp);
      if (t > 1 - ramp) return 1 - vmax * (1 - t) * (1 - t) / (2 * ramp);
      return vmax * (t - ramp / 2);
    };
  }

  // ------------------------------------------------------------ math
  function orth(v, axis) {
    const r = v.subtract(axis.scale(Vec.Dot(v, axis)));
    if (r.lengthSquared() < 1e-10) return Vec.Cross(axis, Math.abs(axis.y) < 0.9 ? V3(0, 1, 0) : V3(1, 0, 0)).normalize();
    return r.normalize();
  }
  function rotOf(M) {
    const m = M.m, r = [];
    for (let k = 0; k < 3; k++) {
      const l = Math.hypot(m[k * 4], m[k * 4 + 1], m[k * 4 + 2]) || 1;
      r.push(m[k * 4] / l, m[k * 4 + 1] / l, m[k * 4 + 2] / l, 0);
    }
    return Mat.FromValues(...r, 0, 0, 0, 1);
  }
  const basis = (x, y, z) => Mat.FromValues(x.x, x.y, x.z, 0, y.x, y.y, y.z, 0, z.x, z.y, z.z, 0, 0, 0, 0, 1);

  // ------------------------------------------------------------ character
  class KingCharacter extends ProceduralCharacter {
    _mat(name, color, metallic, roughness, twoSided, track) {
      const mat = new BABYLON.PBRMaterial(`${name}_${this.id}`, this.scene);
      mat.albedoColor = typeof color === 'string' ? hex(color) : color;
      mat.metallic = metallic; mat.roughness = roughness; mat.maxSimultaneousLights = 8;
      if (twoSided) { mat.backFaceCulling = false; mat.twoSidedLighting = true; }
      if (track !== false) this.materials.push(mat);
      return mat;
    }
    _texMat(name, pair, metallic, roughness, twoSided, bumpLevel) {
      const mat = this._mat(name, '#ffffff', metallic, roughness, twoSided);
      mat.albedoTexture = this._tex(`${name}Tex`, pair.albedo);
      if (pair.normal) { mat.bumpTexture = this._tex(`${name}Nrm`, pair.normal); mat.bumpTexture.level = bumpLevel || 0.8; }
      return mat;
    }
    _tex(name, canvas) {
      const t = new BABYLON.DynamicTexture(`${name}_${this.id}`, canvas, this.scene, true);
      t.update();
      t.wrapU = t.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      return t;
    }
    _jewel(name, color) {
      const mat = new BABYLON.StandardMaterial(`${name}_${this.id}`, this.scene);
      mat.diffuseColor = hex(color).scale(0.3); mat.emissiveColor = hex(color).scale(0.55);
      mat.specularColor = new BABYLON.Color3(1, 1, 1); mat.specularPower = 128;
      this.materials.push(mat);
      return mat;
    }
    _surf(name, vd, mat, parent) {
      const mesh = new BABYLON.Mesh(`${name}_${this.id}`, this.scene);
      vd.applyToMesh(mesh);
      return this._add(mesh, parent, mat);
    }
    _node(name, parent, pos) {
      const n = new BABYLON.TransformNode(`${name}_${this.id}`, this.scene);
      n.parent = parent;
      if (pos) n.position.set(pos[0], pos[1], pos[2]);
      this._pivots.push(n);
      return n;
    }
    // Tube through `pts` (Catmull-Rom) with radius keys [[t, r], ...] or a constant.
    _cord(name, pts, radius, mat, parent, sides) {
      const keys = pts.map((p, i) => [i / (pts.length - 1), ...p]);
      const rk = typeof radius === 'number' ? [[0, radius], [1, radius]] : radius;
      return this._surf(name, sweep(sides || 8, Math.min(48, Math.max(6, pts.length * 2)), (t) => curve(keys, t), (t, a) => {
        const r = curve(rk, t)[0];
        return [r * Math.cos(a), r * Math.sin(a)];
      }, { capStart: true, capEnd: true }), mat, parent);
    }
    _ball(name, p, d, mat, parent, sc) {
      const m = MB.CreateSphere(`${name}_${this.id}`, { diameter: d, segments: d >= 0.025 ? 9 : d >= 0.012 ? 6 : 4 }, this.scene);
      m.position.set(p[0], p[1], p[2]);
      if (sc) m.scaling.set(sc[0], sc[1], sc[2]);
      return this._add(m, parent, mat);
    }
    // Limb plate: keys [[v, y, rx, rzFront, rzBack, zc], ...]; u = 0.5 at the front.
    _limbTube(name, keys, mat, parent, opts) {
      opts = opts || {};
      return this._surf(name, grid(opts.nu || 20, opts.nv || 14, (u, v) => {
        const [y, rx, rzF, rzB, zc] = curve(keys, v), a = (u - 0.5) * TAU, c = Math.cos(a);
        return [rx * Math.sin(a), y, (zc || 0) + (c >= 0 ? rzF : rzB) * c, u, 1 - v];
      }, { closed: true, capStart: opts.capStart, capEnd: opts.capEnd }), mat, parent);
    }
    // Joint cop: a rounded plate cupping the joint at b, stretched from a to c.
    _cop(name, a, b, c, r, mat, parent) {
      const A = V3(...a), B = V3(...b), C = V3(...c);
      const p0 = B.add(A.subtract(B).normalize().scale(0.034)), p2 = B.add(C.subtract(B).normalize().scale(0.032));
      const out = B.subtract(p0.add(p2).scale(0.5)).normalize().scale(0.007);
      const keys = [[0, p0.x, p0.y, p0.z], [0.5, B.x + out.x, B.y + out.y, B.z + out.z], [1, p2.x, p2.y, p2.z]];
      return this._surf(name, sweep(16, 10, (t) => curve(keys, t), (t, ang) => {
        const k = r * (0.8 + 0.2 * Math.sin(Math.PI * t));
        return [k * Math.cos(ang), k * Math.sin(ang)];
      }, { capStart: true, capEnd: true }), mat, parent);
    }
    // Leaf-shaped plate centred at c: `len` along ax, `wid` along ay, bulging along n, rimmed.
    _leaf(name, c, ax, ay, n, len, wid, bulge, mat, rimMat, parent, taper) {
      const C = V3(...c), X = V3(...ax).normalize(), Y = V3(...ay).normalize(), N = V3(...n).normalize(), tp = taper == null ? 0.25 : taper;
      const pt = (s, q) => {
        const w = Math.sqrt(Math.max(0, 1 - s * s)) * (1 - tp * s);
        const p = C.add(X.scale(s * len / 2)).add(Y.scale(q * w * wid / 2)).add(N.scale(bulge * (1 - s * s) * (1 - 0.6 * q * q)));
        return [p.x, p.y, p.z];
      };
      this._surf(name, grid(10, 12, (u, v) => pt(2 * v - 1, 2 * u - 1)), mat, parent);
      if (rimMat) {
        const rim = [];
        for (let k = 0; k <= 24; k++) { const a = k / 24 * TAU; rim.push(pt(Math.cos(a) * 0.999, Math.sign(Math.sin(a)) || 0)); }
        this._cord(`${name}Rim`, rim, 0.0017, rimMat, parent, 5);
      }
    }

    async build() {
      await super.build();
      this._seated = true;
      this._cur = sitPose();
      this._applyPose(this._cur);
    }

    dispose() {
      if (this._kfid) this._kfAbort();
      if (this._phoneMat) { this._phoneMat.forEach((m) => m.dispose()); this._phoneMat = null; }
      if (this._trail) { this._trail.dispose(); this._trail = null; }
      const T = this.parts && this.parts.throne;
      if (T && T.parent !== this.visual && !T.isDisposed()) T.dispose(false, true);
      super.dispose();
    }

    // ---------------------------------------------------------- build
    _buildKing(team) {
      const L = this.L = LIVERY[this.color] || LIVERY.w;
      const key = this.color + team.armor + team.accent;
      this._pivots = [];
      const armorCol = team.armor, goldCol = team.accent;
      const M = this.kMats = {
        cuirass: this._texMat('cuirass', embossed(`cuirass${key}`, 1024, 512, armorCol, goldCol, drawCuirass, { brushed: true }), 1, 0.26),
        limb: this._texMat('limbPlate', embossed(`limb${key}`, 512, 256, armorCol, goldCol, drawLimb, { brushed: true }), 1, 0.26),
        lame: this._texMat('lamePlate', embossed(`lame${key}`, 512, 128, armorCol, goldCol, drawLame, { brushed: true }), 1, 0.26),
        plain: this._mat('steel', armorCol, 0.95, 0.24),
        gold: this._mat('gold', goldCol, 1, 0.2),
        goldBand: this._texMat('goldBand', embossed(`band${key}`, 256, 128, hex(goldCol).scale(0.7).toHexString(), goldCol, drawGoldBand, { lines: 0.7 }), 1, 0.22),
        mail: this._texMat('mail', embossed(`mail${key}`, 128, 128, hex(L.mail).scale(0.4).toHexString(), L.mail, drawMail, { soft: 1, lines: 0.3 }), 0.9, 0.45),
        skin: this._mat('face', '#ffffff', 0, 0.55),
        skinPlain: this._mat('skin', L.skin, 0, 0.55),
        eyeWhite: this._mat('eyeWhite', '#efe9df', 0, 0.15),
        iris: this._mat('iris', L.iris, 0, 0.2),
        dark: this._mat('pupil', '#0b0807', 0, 0.2),
        hair: this._mat('hair', '#ffffff', 0, 0.48, true),
        beard: this._mat('beard', '#ffffff', 0, 0.55, true),
        cape: this._texMat('cape', embossed(`cape${key}${L.cape}`, 512, 512, L.cape, goldCol, drawCape, { drawColor: drawCapeColor, lines: 0.35, bump: 2 }), 0, 0.75, true, 0.5),
        panel: this._texMat('panel', embossed(`panel${key}${L.panel}`, 256, 512, L.panel, goldCol, drawPanel, { lines: 0.35 }), 0, 0.7, true, 0.5),
        strap: this._mat('strap', L.strap, 0, 0.55),
        leather: this._mat('grip', L.leather, 0, 0.6),
        pearl: this._mat('pearl', '#f3eee4', 0, 0.22),
        ruby: this._jewel('ruby', L.gem),
        sapphire: this._jewel('sapphire', L.gem2),
        velvet: this._texMat('velvet', embossed(`velvet${team.cloth}${goldCol}`, 256, 256, team.cloth, goldCol, drawVelvet,
          { drawColor: drawVelvetButtons, soft: 6, lines: 0.15, bump: 4, noise: 0.08 }), 0, 0.85, false, 0.9),
        // Blade and runes are driven by the attack glow, so they stay out of setFlash's list.
        blade: this._mat('blade', '#eef3f8', 1, 0.07, false, false),
        rune: new BABYLON.StandardMaterial(`rune_${this.id}`, this.scene)
      };
      M.skin.albedoTexture = this._tex('faceTex', painted(`face${this.color}${L.skin}`, 256, 256, (c, w, h) => paintFace(c, w, h, L)));
      M.hair.albedoTexture = this._tex('hairTex', painted(`hair${L.hair}`, 256, 256, (c, w, h) => paintHair(c, w, h, L)));
      M.beard.albedoTexture = this._tex('beardTex', painted(`beard${L.beard}`, 256, 256, (c, w, h) => paintHair(c, w, h, Object.assign({}, L, { hair: L.beard }))));
      [M.hair, M.beard].forEach((m) => { m.sheen.isEnabled = true; m.sheen.intensity = 0.3; });
      [M.cape, M.panel, M.velvet].forEach((m) => { m.sheen.isEnabled = true; m.sheen.intensity = 0.35; });
      M.eyeWhite.clearCoat.isEnabled = true; M.iris.clearCoat.isEnabled = true; M.pearl.clearCoat.isEnabled = true;
      M.skin.metallicF0Factor = 0.35; M.skinPlain.metallicF0Factor = 0.35;
      M.rune.diffuseColor = BABYLON.Color3.Black(); M.rune.specularColor = BABYLON.Color3.Black(); M.rune.backFaceCulling = false;
      M.rune.emissiveTexture = this._tex('runeTex', painted('runes', 256, 32, paintRunes));
      M.rune.emissiveTexture.wrapU = M.rune.emissiveTexture.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
      this._glowColor = hex(team.glow);
      this._goldColor = hex(goldCol);

      // --- skeleton ---
      const R = this.rig = { base: this.visual };
      R.hips = this._node('hips', this.visual, [0, STAND_Y, 0]);
      R.spine = this._node('spine', R.hips, NODE.spine);
      R.chest = this._node('chest', R.spine, NODE.chest);
      R.neck = this._node('neck', R.chest, NODE.neck);
      R.head = this._node('head', R.neck, NODE.head);
      R.face = this._node('face', R.head, NODE.face);
      R.capeNode = this._node('capeNode', R.chest, CAPE_PIVOT);
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
      R.sword = this._node('sword', this.visual);
      this.parts.torso = R.hips;
      this.parts.head = R.head;

      this._buildLegs(R, M);
      this._buildPelvis(R, M);
      this._buildTorso(R, M);
      this._buildArms(R, M);
      this._buildHead(R, M, L);
      this._buildCrown(R.face, M);
      this._buildCape(R, M);
      this._buildSword(R, M);
      this._buildThrone(M, team);
      this.parts.extraPivots = this._pivots;
    }

    _buildLegs(R, M) {
      ['R', 'L'].forEach((side) => {
        const s = side === 'R' ? 1 : -1, thigh = R['thigh' + side], shin = R['shin' + side], foot = R['foot' + side];
        // cuisse, with a gold-edged ridge down the front
        this._limbTube(`cuisse${side}`, [[0, 0.035, 0.05, 0.05, 0.05], [0.15, 0.0, 0.056, 0.06, 0.055], [0.55, -0.1, 0.05, 0.054, 0.05],
          [1, -0.205, 0.042, 0.046, 0.042]], M.limb, thigh, { nu: 24 });
        // tassets: three lames over the front and outside of the thigh
        for (let k = 0; k < 3; k++) {
          const y0 = 0.07 - 0.05 * k, y1 = y0 - 0.062, r = 0.062 + 0.004 * k;
          const pt = (u, v) => {
            const a = s * 0.35 + lerp(-1.25, 1.35, u) * s, y = lerp(y0, y1, v), rr = r + 0.008 * v;
            return [rr * Math.sin(a) * 0.95, y, rr * Math.cos(a) + 0.004, u, 1 - v];
          };
          this._surf(`tasset${side}${k}`, grid(16, 3, pt), M.lame, thigh);
          this._cord(`tassetEdge${side}${k}`, Array.from({ length: 17 }, (_, i) => pt(i / 16, 1)), 0.0022, M.gold, thigh, 5);
        }
        // poleyn with a fan plate on the outside
        this._cop(`poleyn${side}`, [0, -0.15, 0.01], [0, -LEN.thigh, 0.018], [0, -LEN.thigh - 0.09, 0.012], 0.034, M.plain, thigh);
        this._leaf(`poleynWing${side}`, [s * 0.036, -LEN.thigh + 0.004, 0.006], [0, 1, 0.1], [0, -0.1, 1], [s, 0, 0.15],
          0.07, 0.06, 0.012, M.plain, M.gold, thigh);
        this._ball(`poleynBoss${side}`, [0, -LEN.thigh + 0.002, 0.053], 0.016, M.gold, thigh, [1, 1, 0.5]);
        // greave with a calf swell
        this._limbTube(`greave${side}`, [[0, -0.005, 0.038, 0.037, 0.04], [0.25, -0.06, 0.042, 0.04, 0.05], [0.6, -0.14, 0.036, 0.034, 0.038],
          [1, -0.215, 0.03, 0.03, 0.031]], M.limb, shin, { nu: 22 });
        // sabaton: lames over the foot to a blunt point, flat sole
        const FOOT = [[-0.042, 0.018, -0.022], [-0.03, 0.027, -0.006], [0.0, 0.031, 0.0], [0.03, 0.033, -0.017], [0.06, 0.033, -0.029],
          [0.085, 0.028, -0.037], [0.102, 0.018, -0.043], [0.114, 0.004, -0.05]];
        const footPt = (z, a, lift) => {
          const [hw, top] = curve(FOOT, z), sole = -LEN.ankle, c = Math.cos(a), sn = Math.sin(a);
          return [(hw + lift) * spow(c, 0.7), sole + (sn > 0 ? (top - sole + lift) * Math.pow(sn, 0.8) : 0), z];
        };
        this._surf(`sabaton${side}`, grid(24, 16, (u, v) => footPt(lerp(-0.042, 0.114, v), u * TAU, 0),
          { closed: true, capStart: true, capEnd: true }), M.plain, foot);
        [0.012, 0.038, 0.064, 0.088].forEach((z, i) => {
          this._cord(`sabatonLame${side}${i}`, Array.from({ length: 9 }, (_, k) => footPt(z, k / 8 * Math.PI, 0.0015)), 0.0017, M.gold, foot, 5);
        });
        this._cord(`ankleRing${side}`, Array.from({ length: 17 }, (_, k) => {
          const a = k / 16 * TAU; return [0.034 * Math.sin(a), 0.004, 0.034 * Math.cos(a)];
        }), 0.004, M.gold, foot, 6);
      });
    }

    _buildPelvis(R, M) {
      // mail skirt, short at the front so the seated thighs clear it
      this._surf('mailSkirt', grid(28, 6, (u, v) => {
        const a = (u - 0.5) * TAU, c = Math.cos(a), bottom = -0.078 + 0.05 * Math.pow(Math.max(0, c), 2);
        const y = lerp(0.07, bottom, v), fl = 1 + 0.12 * v;
        return [0.11 * fl * Math.sin(a), y, (c >= 0 ? 0.09 : 0.1) * fl * c, u * 4, (1 - v) * 1.5];
      }, { closed: true }), M.mail, R.hips);
      // fauld: lames flaring over the hips, cut high at the front
      for (let k = 0; k < 3; k++) {
        const top = -0.004 - 0.03 * k, g = 1.05 + 0.05 * k;
        const pt = (u, v) => {
          const a = (u - 0.5) * TAU, c = Math.cos(a);
          const bottom = top - 0.044 + 0.03 * Math.pow(Math.max(0, c), 2) * (k ? 1 : 0.5);
          const p = cuirassPoint(a, -0.168, 0), sc = g + 0.07 * v;
          return [p[0] * sc, lerp(top, bottom, v), p[2] * sc, u, 1 - v];
        };
        this._surf(`fauld${k}`, grid(40, 3, pt, { closed: true }), M.lame, R.spine);
        this._cord(`fauldEdge${k}`, Array.from({ length: 41 }, (_, i) => pt(i / 40, 1)), 0.0022, M.gold, R.spine, 5);
      }
      // green leather belt with gold plaques and an ornate buckle
      const beltPt = (a, y, l) => { const p = cuirassPoint(a, y - NODE.chest[1], 0.007 + l); return [p[0], y, p[2]]; };
      this._surf('belt', grid(48, 2, (u, v) => beltPt((u - 0.5) * TAU, lerp(0.02, -0.004, v), 0), { closed: true }), M.strap, R.spine);
      [0.02, -0.004].forEach((y, i) => this._cord(`beltEdge${i}`, Array.from({ length: 49 }, (_, k) => beltPt((k / 48 - 0.5) * TAU, y, 0.001)), 0.0018, M.gold, R.spine, 5));
      for (let k = 1; k < 10; k++) {
        const a = (k / 10 - 0.5) * TAU * 0.9 + Math.PI;
        const p = beltPt(a, 0.008, 0.002);
        this._ball(`beltStud${k}`, p, 0.012, M.gold, R.spine, [1, 1, 0.5]).rotation.y = a;
      }
      const bp = beltPt(0, 0.008, 0.002);
      this._surf('buckle', grid(16, 4, (u, v) => {
        const a = u * TAU, r = lerp(0, 1, v);
        return [bp[0] + 0.024 * r * Math.cos(a), bp[1] + 0.02 * r * Math.sin(a), bp[2] + 0.006 * (1 - r * r) + 0.002];
      }, { closed: true }), M.gold, R.spine);
      this._cord('buckleRim', Array.from({ length: 17 }, (_, k) => {
        const a = k / 16 * TAU; return [bp[0] + 0.024 * Math.cos(a), bp[1] + 0.02 * Math.sin(a), bp[2] + 0.003];
      }), 0.003, M.gold, R.spine, 6);
      this._ball('buckleGem', [bp[0], bp[1], bp[2] + 0.008], 0.014, M.ruby, R.spine, [1, 1.2, 0.6]);
      // a second, slanting sword belt over the fauld
      const hipBelt = (t, l) => {
        const a = (t - 0.5) * TAU, y = -0.05 + 0.03 * Math.sin(a + 0.6);
        const p = cuirassPoint(a, -0.168, 0), sc = 1.16 + l;
        return [p[0] * sc, y, p[2] * sc];
      };
      this._cord('hipBelt', Array.from({ length: 41 }, (_, k) => hipBelt(k / 40, 0)), 0.006, M.strap, R.spine, 6);
      const hb = hipBelt(0.64, 0.02);
      this._ball('hipBuckle', hb, 0.022, M.gold, R.spine, [1, 1, 0.45]).rotation.y = 0.8;
      // cloth panel hanging from the belt (morphs to lie over the lap when seated)
      const panelMesh = this._surf('panel', grid(8, 20, (u, v) => [...panelPoint(PANEL.stand, u, v), u, 1 - v]), M.panel, R.hips);
      this._addMorphs(panelMesh, (keys) => grid(8, 20, (u, v) => panelPoint(keys, u, v)), [PANEL.sit, PANEL.billow]);
      R.panelMesh = panelMesh;
    }

    // Morph targets for `mesh` (sit, billow) from shape builders sharing its topology.
    _addMorphs(mesh, build, shapes) {
      const mgr = new BABYLON.MorphTargetManager(this.scene);
      const indices = mesh.getIndices();
      shapes.forEach((keys, i) => {
        const vd = build(keys), normals = [];
        BABYLON.VertexData.ComputeNormals(vd.positions, indices, normals);
        const t = new BABYLON.MorphTarget(`${mesh.name}_m${i}`, 0, this.scene);
        t.setPositions(vd.positions); t.setNormals(normals);
        mgr.addTarget(t);
      });
      mesh.morphTargetManager = mgr;
    }

    _buildTorso(R, M) {
      const chest = R.chest;
      this._surf('cuirass', grid(64, 30, (u, v) => {
        const p = cuirassPoint((u - 0.5) * TAU, lerp(0.112, -0.168, v));
        return [p[0], p[1], p[2], u, 1 - v];
      }, { closed: true }), M.cuirass, chest);
      this._cord('cuirassHem', Array.from({ length: 49 }, (_, k) => cuirassPoint((k / 48 - 0.5) * TAU, -0.166, 0.002)), 0.003, M.gold, chest, 6);
      // gorget: rising lames round the neck, a high collar behind
      for (let k = 0; k < 3; k++) {
        const pt = (u, v) => {
          const a = (u - 0.5) * TAU, c = Math.cos(a), back = Math.max(0, -c);
          const y0 = 0.092 + 0.024 * k, y1 = y0 + 0.032 + 0.028 * back * (k === 2 ? 1 : 0.3);
          const r = lerp(0.066 - 0.006 * k, 0.058 - 0.006 * k, v) + 0.006 * back * v;
          return [r * Math.sin(a), lerp(y0, y1, v), -0.004 + r * 0.96 * c, u, v];
        };
        this._surf(`gorget${k}`, grid(32, 3, pt, { closed: true }), M.lame, chest);
        this._cord(`gorgetEdge${k}`, Array.from({ length: 33 }, (_, i) => pt(i / 32, 1)), 0.0022, M.gold, chest, 5);
      }
      // neck
      this._cord('neck', [[0, -0.03, 0], [0, 0.02, 0.002], [0, 0.075, 0.004]], [[0, 0.031], [1, 0.028]], M.skinPlain, R.neck, 16);
    }

    _buildArms(R, M) {
      ['R', 'L'].forEach((side) => {
        const s = side === 'R' ? 1 : -1, arm = R['arm' + side], fore = R['fore' + side], hand = R['hand' + side];
        const sh = R['shoulder' + side];
        // pauldron: layered domes round the shoulder joint (on a pivot that
        // follows only part of the arm's swing, so it never tips over)
        const ax = V3(s * 0.5, 1, 0).normalize(), f1 = V3(0, 0, 1), f2 = Vec.Cross(ax, f1);
        const lames = [[0, 0.95, 0.074], [0.82, 1.3, 0.079], [1.18, 1.66, 0.083], [1.52, 1.98, 0.086]];
        lames.forEach(([p0, p1, rad], k) => {
          const pt = (u, v) => {
            const p = lerp(p0, p1, v), a = u * TAU, r = rad * (1 + 0.06 * v * (k ? 1 : smoothstep(0.7, 1, v)));
            const stretch = 1 + 0.18 * Math.pow(Math.cos(a), 2) * Math.sin(p);           // longer to the front and back
            const d = ax.scale(Math.cos(p)).add(f1.scale(Math.cos(a) * Math.sin(p) * stretch)).add(f2.scale(Math.sin(a) * Math.sin(p)));
            return [s * 0.008 + d.x * r, 0.004 + d.y * r, d.z * r, u, 1 - v];
          };
          this._surf(`pauldron${side}${k}`, grid(28, k ? 4 : 10, pt, { closed: true }), M.lame, sh);
          this._cord(`pauldronEdge${side}${k}`, Array.from({ length: 29 }, (_, i) => pt(i / 28, 1)), 0.0025, M.gold, sh, 5);
        });
        const outward = (a, p, r) => ax.scale(Math.cos(p)).add(f1.scale(Math.cos(a) * Math.sin(p))).add(f2.scale(Math.sin(a) * Math.sin(p))).scale(r);
        if (s < 0) {
          // gold rondel on the left pauldron, as in the reference
          const n = outward(-Math.PI * 0.22, 1.0, 1).normalize(), c = n.scale(0.097).add(V3(s * 0.008, 0.004, 0));
          const up = orth(V3(0, 1, 0), n), rt = Vec.Cross(up, n);
          const at = (r, a, h) => c.add(rt.scale(r * Math.cos(a))).add(up.scale(r * Math.sin(a))).add(n.scale(h));
          this._surf('rondel', grid(28, 10, (u, v) => { const r = 0.046 * Math.sin(Math.PI * v), p = at(r, u * TAU, (v < 0.5 ? 0.012 : 0.004) * Math.cos(Math.PI * v)); return [p.x, p.y, p.z]; }, { closed: true }), M.gold, sh);
          [0.046, 0.033, 0.02].forEach((r, i) => this._cord(`rondelRing${i}`, Array.from({ length: 29 }, (_, k) => {
            const p = at(r, k / 28 * TAU, 0.012 * (1 - Math.pow(r / 0.046, 2)) + 0.002); return [p.x, p.y, p.z];
          }), 0.0025, M.gold, arm, 6));
          for (let k = 0; k < 12; k++) {
            const a = k / 12 * TAU, p = at(0.027, a, 0.009);
            this._leaf(`rondelPetal${k}`, [p.x, p.y, p.z], [rt.x * Math.cos(a) + up.x * Math.sin(a), rt.y * Math.cos(a) + up.y * Math.sin(a), rt.z * Math.cos(a) + up.z * Math.sin(a)],
              [-rt.x * Math.sin(a) + up.x * Math.cos(a), -rt.y * Math.sin(a) + up.y * Math.cos(a), -rt.z * Math.sin(a) + up.z * Math.cos(a)], [n.x, n.y, n.z], 0.016, 0.007, 0.002, M.gold, null, sh);
          }
          const g = at(0, 0, 0.016);
          this._ball('rondelGem', [g.x, g.y, g.z], 0.014, M.sapphire, sh);
        } else {
          // gold fleurons fanning up from the right pauldron
          [-0.5, 0, 0.5].forEach((a, i) => {
            const base = outward(Math.PI / 2 + a * 0.9, 0.55, 0.08).add(V3(s * 0.008, 0.004, 0));
            const dir = V3(s * 0.55, 1, a * 0.3).normalize(), nrm = orth(V3(0, 0, 1), dir), side2 = Vec.Cross(nrm, dir);
            const len = i === 1 ? 0.085 : 0.066;
            const c = base.add(dir.scale(len * 0.42));
            this._leaf(`fleuron${i}`, [c.x, c.y, c.z], [dir.x, dir.y, dir.z], [side2.x, side2.y, side2.z], [nrm.x, nrm.y, nrm.z],
              len, len * 0.42, 0.007, M.gold, M.gold, sh, 0.5);
            this._leaf(`fleuronBack${i}`, [c.x, c.y, c.z - 0.002], [dir.x, dir.y, dir.z], [side2.x, side2.y, side2.z], [-nrm.x, -nrm.y, -nrm.z],
              len, len * 0.42, 0.003, M.gold, null, sh, 0.5);
          });
        }
        // rerebrace, couter with a fan plate
        this._limbTube(`rerebrace${side}`, [[0, -0.03, 0.034, 0.034, 0.034], [1, -0.185, 0.03, 0.03, 0.03]], M.limb, arm, { nu: 20 });
        this._cop(`couter${side}`, [0, -0.1, 0], [0, -LEN.upper, -0.012], [0, -LEN.upper - 0.1, 0.02], 0.036, M.plain, arm);
        this._leaf(`couterWing${side}`, [s * 0.03, -LEN.upper, -0.012], [0, 1, 0], [0, 0, 1], [s, 0, -0.2], 0.064, 0.056, 0.011, M.plain, M.gold, arm);
        // vambrace and a flared, gilded gauntlet cuff
        this._limbTube(`vambrace${side}`, [[0, -0.01, 0.03, 0.03, 0.03], [1, -0.15, 0.025, 0.026, 0.025]], M.limb, fore, { nu: 20 });
        this._limbTube(`cuff${side}`, [[0, -0.132, 0.028, 0.028, 0.028], [0.6, -0.168, 0.032, 0.034, 0.032], [1, -0.186, 0.036, 0.039, 0.036]], M.lame, fore, { nu: 22 });
        this._cord(`cuffRim${side}`, Array.from({ length: 23 }, (_, k) => {
          const a = k / 22 * TAU; return [0.037 * Math.sin(a), -0.186, 0.04 * Math.cos(a)];
        }), 0.0025, M.gold, fore, 6);
        this._buildFist(hand, s, M);
      });
    }

    // Gauntleted fist closed round a grip running along hand-space z
    // (pinky to thumb), the palm facing the body's midline.
    _buildFist(hand, s, M) {
      const [gx, gy] = HAND_GRIP(s);
      this._surf('palm', sweep(14, 8, (t) => [s * 0.002, lerp(-0.004, -0.056, t), 0], (t, a) => {
        const w = lerp(0.019, 0.024, t), th = lerp(0.012, 0.0125, t);
        return [th * spow(Math.cos(a), 0.85), w * spow(Math.sin(a), 0.85)];
      }, { side: [1, 0, 0], capStart: true, capEnd: true }), M.plain, hand);
      [-0.0165, -0.0055, 0.0055, 0.0165].forEach((z, i) => {
        const r = 0.019, a0 = Math.atan2(0.006, s * 0.019), sweepA = 3.7 - (i === 0 ? 0.3 : 0);
        this._surf(`finger${i}`, this._fingerVD(gx, gy, r, a0, s, sweepA, z, i === 0 ? 0.0078 : 0.0088), M.plain, hand);
        const k = [gx + r * Math.cos(a0 - s * 0.35), gy + r * Math.sin(a0 - s * 0.35), z];
        this._ball(`knuckle${i}`, [k[0] + s * 0.003, k[1], k[2]], 0.011, M.gold, hand, [0.7, 0.7, 0.9]);
      });
      this._cord('thumb', [[s * -0.004, -0.018, 0.02], [s * -0.016, -0.034, 0.028], [s * -0.027, -0.054, 0.018], [s * -0.03, -0.066, 0.006]],
        [[0, 0.0085], [0.6, 0.0075], [1, 0.006]], M.plain, hand, 10);
      this._cord('handBack', [[s * 0.013, -0.01, -0.012], [s * 0.015, -0.03, 0], [s * 0.013, -0.05, 0.012]], 0.0022, M.gold, hand, 5);
    }
    _fingerVD(gx, gy, r, a0, s, span, z, th) {
      return sweep(8, 12, (t) => {
        const a = a0 - s * t * span;
        return [gx + r * Math.cos(a), gy + r * Math.sin(a), z];
      }, (t, a) => {
        const k = 1 - 0.2 * t;
        return [th * k * Math.cos(a), 0.0061 * k * Math.sin(a)];
      }, { side: [0, 0, 1], capStart: true, capEnd: true });
    }

    _buildHead(R, M, L) {
      const face = R.face;
      this._surf('head', grid(96, 64, (u, v) => {
        const p = headPoint(headTh(u), headY(v), 0);
        return [p[0], p[1], p[2], u, 1 - v];
      }, { closed: true }), M.skin, face);

      // eyes: eyeballs set in the sockets, irises and pupils, heavy upper lids
      [-1, 1].forEach((s) => {
        const surf = faceAt(s * EYE.x, EYE.y, 0);
        const c = [s * EYE.x, EYE.y, surf[2] + 0.0008 - EYE.r];
        this._ball(`eyeball${s}`, c, EYE.r * 2, M.eyeWhite, face);
        const look = V3(-s * 0.06, -0.08, 1).normalize();
        const at = (d) => [c[0] + look.x * d, c[1] + look.y * d, c[2] + look.z * d];
        const iris = this._ball(`iris${s}`, at(EYE.r * 0.94), 0.0116, M.iris, face, [1, 1, 0.3]);
        iris.rotation.set(-Math.asin(look.y), Math.atan2(look.x, look.z), 0);
        const pupil = this._ball(`pupil${s}`, at(EYE.r * 1.0), 0.0048, M.dark, face, [1, 1, 0.3]);
        pupil.rotation.copyFrom(iris.rotation);
        const lid = (name, e0, e1, rr) => this._surf(name, grid(12, 5, (u, v) => {
          const az = lerp(-1.25, 1.25, u), el = lerp(e0, e1, v);
          return [c[0] + rr * Math.cos(el) * Math.sin(az), c[1] + rr * Math.sin(el), c[2] + rr * Math.cos(el) * Math.cos(az)];
        }), M.skinPlain, face);
        lid(`lidUpper${s}`, 1.35, 0.24, EYE.r * 1.1);
        lid(`lidLower${s}`, -1.2, -0.42, EYE.r * 1.07);
        this._cord(`lash${s}`, Array.from({ length: 9 }, (_, k) => {
          const az = lerp(-1.1, 1.1, k / 8), rr = EYE.r * 1.12, el = 0.24 + 0.05 * Math.cos(az * 1.4);
          return [c[0] + rr * Math.cos(el) * Math.sin(az), c[1] + rr * Math.sin(el), c[2] + rr * Math.cos(el) * Math.cos(az)];
        }), 0.0009, M.dark, face, 4);
        // eyebrows: short strands along the brow ridge, low and knitted at the inner end
        for (let i = 0; i < 16; i++) {
          const t = i / 15, x = s * lerp(0.005, 0.034, t), y = 0.0148 + 0.0055 * Math.sin(Math.PI * t * 0.85) - 0.0028 * (1 - t) + 0.0012 * ((i % 3) - 1);
          const a = faceAt(x, y, 0.0012), b = faceAt(x + s * 0.011, y + 0.0018 - 0.0025 * t, 0.0016);
          this._surf(`brow${s}_${i}`, sweep(4, 4, (q) => [lerp(a[0], b[0], q), lerp(a[1], b[1], q), lerp(a[2], b[2], q) + 0.0008 * Math.sin(Math.PI * q)],
            (q, ang) => [(0.0022 * (1 - 0.7 * q)) * Math.cos(ang), 0.0008 * Math.sin(ang)], { side: [0, 1, 0], capStart: true, capEnd: true }), M.beard, face);
        }
      });

      // beard: a shell over the jaw and chin, ragged at the cheek line, fuller at the chin
      const beardTop = (th) => {
        const a = Math.abs(th);
        if (a > 1.3) return 0.004;
        if (a > 0.42) return lerp(-0.031, 0.002, smoothstep(0.42, 1.3, a)) + 0.0015 * Math.sin(a * 40);
        return lerp(-0.047, -0.031, smoothstep(0.18, 0.42, a));
      };
      this._surf('beard', grid(72, 30, (u, v) => {
        const th = lerp(-1.75, 1.75, u), y = lerp(-0.086, 0.006, v);
        const top = beardTop(th), inside = 1 - smoothstep(top - 0.004, top + 0.001, y);
        const chin = gauss(th, 0.5, y + 0.066, 0.016);
        const p = headPoint(th, y, lerp(-0.002, 0.0045 + 0.007 * chin, inside));
        const dn = 0.009 * chin * inside;                 // the chin beard falls a little below the jaw
        return [p[0], p[1] - dn, p[2] + dn * 0.4, u * 3, 1 - v];
      }), M.beard, face);
      // moustache: two thick locks from under the nose round the mouth into the beard
      [-1, 1].forEach((s) => {
        for (let k = 0; k < 3; k++) {
          const pts = [[0.0015, -0.028], [0.009, -0.03], [0.017, -0.034], [0.022, -0.041], [0.023, -0.05]].map(([x, y]) => {
            const p = faceAt(s * (x + 0.0012 * k), y - 0.0012 * k, 0.0022 + 0.001 * k);
            return p;
          });
          this._surf(`moustache${s}_${k}`, sweep(6, 14, (t) => bezier(pts, t), (t, a) => {
            const w = (0.0052 - 0.001 * k) * Math.sin(Math.PI * (0.12 + 0.88 * t)) + 0.0008;
            return [w * Math.cos(a), 0.0022 * Math.sin(a)];
          }, { side: [0, 1, 0.3], capStart: true, capEnd: true }), M.beard, face);
        }
      });
      // chin tuft strands to break the silhouette
      for (let i = 0; i < 7; i++) {
        const x = (i - 3) * 0.0055, a = faceAt(x, -0.055, 0.004);
        const ctrl = [a, [a[0] * 1.1, a[1] - 0.012, a[2] + 0.004], [a[0] * 0.8, a[1] - 0.026 + Math.abs(x) * 0.6, a[2] - 0.002]];
        this._surf(`chinLock${i}`, sweep(5, 8, (t) => bezier(ctrl, t), (t, ang) => [(0.0045 * (1 - 0.8 * t) + 0.0006) * Math.cos(ang), 0.0018 * Math.sin(ang)],
          { side: [1, 0, 0], capStart: true, capEnd: true }), M.beard, face);
      }

      // hair: a shell over the scalp and long wavy locks, parted in the middle
      this._surf('scalp', grid(64, 30, (u, v) => {
        const th = (u - 0.5) * TAU, y = lerp(0.071, -0.075, v), hl = hairline(th);
        const inside = smoothstep(hl - 0.003, hl + 0.004, y), back = Math.max(0, -Math.cos(th));
        const part = 0.0025 * Math.exp(-Math.pow(Math.sin(th) / 0.05, 2)) * Math.max(0, Math.cos(th)) * smoothstep(0.05, 0.068, y);
        const p = headPoint(th, y, lerp(-0.0015, 0.006 + 0.006 * back - part, inside));
        return [p[0], p[1], p[2], u * 4, 1 - v];
      }, { closed: true }), M.hair, face);
      const locks = [];
      // front locks sweeping from the parting over the temples and ears to the shoulders
      [-1, 1].forEach((s) => {
        for (let i = 0; i < 10; i++) locks.push({ s, th0: s * (0.1 + 0.12 * i), y0: 0.068 - 0.004 * i, th2: s * (1.4 + 0.035 * i), kind: 'front', i });
        for (let i = 0; i < 12; i++) locks.push({ s, th0: s * (1.55 + 0.13 * i), y0: 0.062 - 0.002 * i, kind: 'back', i });
      });
      locks.forEach((lk, n) => {
        const j = Math.sin(n * 12.9898) * 0.5, s = lk.s;
        let ctrl;
        // Locks come to rest on the pauldrons at the sides and on the cape behind.
        const endAt = (th, jj) => {
          const sn = Math.sin(th), side2 = sn * sn;
          return [sn * 0.084 + 0.004 * jj, lerp(-0.155, -0.086, side2) + 0.008 * jj, lerp(-0.122, -0.028, side2)];
        };
        if (lk.kind === 'front') {
          const k = lk.i / 9, E = endAt(s * (1.35 + 0.25 * k), j);
          ctrl = [headPoint(lk.th0, lk.y0, 0.007), headPoint(lk.th0 + s * 0.5, 0.036, 0.013), headPoint(lk.th2, -0.012, 0.017 + 0.004 * k),
            [s * 0.064, -0.058, -0.008 - 0.012 * k], E];
        } else {
          const th = lk.th0, E = endAt(th, j);
          const r0 = headPoint(th, lk.y0, 0.007), r1 = headPoint(th, 0.0, 0.016), r2 = headPoint(th, -0.05, 0.022);
          ctrl = [r0, r1, r2, [lerp(r2[0], E[0], 0.5) * 1.1, lerp(r2[1], E[1], 0.5), lerp(r2[2], E[2], 0.5) - 0.012], E];
        }
        const side = lk.kind === 'front' ? [Math.cos(lk.th0 + s * 0.8), 0, -Math.sin(lk.th0 + s * 0.8)] : [Math.cos(lk.th0), 0, -Math.sin(lk.th0)];
        const width = 0.017 + 0.004 * j;
        this._surf(`lock${n}`, sweep(6, 22, (t) => {
          const p = bezier(ctrl, t), w = smoothstep(0.35, 1, t);
          return [p[0] + 0.006 * w * Math.sin(t * 13 + n), p[1], p[2] + 0.005 * w * Math.cos(t * 11 + n * 2)];
        }, (t, a) => {
          const w = width * (1 - 0.75 * t) * (0.7 + 0.3 * Math.sin(Math.PI * Math.min(1, 0.25 + t))) + 0.0015;
          return [w * Math.cos(a), (0.0032 * (1 - 0.5 * t) + 0.001) * Math.sin(a)];
        }, { side, capStart: true, capEnd: true }), M.hair, face);
      });
    }

    // Crown: a gilded band of chased gold set with rubies and sapphires,
    // tall pointed fleurons (the front one largest, with a great ruby) and
    // pearl-tipped spikes between them.
    _buildCrown(face, M) {
      const crown = this._node('crown', face, [0, 0.047, -0.003]);
      crown.rotation.x = -0.1;
      this._crownOn(crown, { rx: 0.061, rzF: 0.066, rzB: 0.072, band: 0.02, flare: 0.14,
        points: [[0, 0.03, 0.066, 'big'], [0.78, 0.022, 0.046], [-0.78, 0.022, 0.046], [1.55, 0.02, 0.05], [-1.55, 0.02, 0.05],
          [2.3, 0.02, 0.04], [-2.3, 0.02, 0.04], [Math.PI, 0.02, 0.044]] }, M);
    }
    _crownOn(node, spec, M) {
      const { rx, rzF, rzB, band, flare } = spec, rm = (rx + rzF) / 2;
      const ell = (phi, k) => [rx * k * Math.sin(phi), (Math.cos(phi) >= 0 ? rzF : rzB) * k * Math.cos(phi)];
      const at = (phi, y, off) => { const k = 1 + off / rm + (y > 0 ? flare * Math.pow(y / 0.06, 2) : 0.06 * (y + band) / band); const [x, z] = ell(phi, k); return [x, y, z]; };
      // band
      this._surf('crownBand', grid(64, 3, (u, v) => { const p = at(u * TAU + Math.PI, lerp(0, -band, v), 0.0015); return [...p, u * 6, 1 - v]; }, { closed: true }), M.goldBand, node);
      this._surf('crownBandIn', grid(64, 3, (u, v) => at(u * TAU, lerp(0, -band, v), -0.0015), { closed: true, inward: true }), M.gold, node);
      [0, -band].forEach((y, i) => this._cord(`crownRim${i}`, Array.from({ length: 65 }, (_, k) => at(k / 64 * TAU, y, 0.001)), 0.0028, M.gold, node, 6));
      spec.points.forEach(([phi0, W, H, kind], n) => {
        const hw = (t) => (W / 2) * Math.pow(1 - t, 1.25) * (1 + 1.5 * t);
        const pt = (a, t, off) => at(phi0 + a * hw(t) / rm, t * H, off);
        [0.0014, -0.0014].forEach((off, side) => this._surf(`crownPoint${n}_${side}`, grid(10, 14, (u, v) => pt(2 * u - 1, v, off), { inward: side === 1 }), M.gold, node));
        const rim = [];
        for (let k = 0; k <= 14; k++) rim.push(pt(-1, k / 14, 0));
        for (let k = 14; k >= 0; k--) rim.push(pt(1, k / 14, 0));
        this._cord(`crownPointRim${n}`, rim, 0.0019, M.gold, node, 5);
        // a curl at each foot of the fleuron
        [-1, 1].forEach((q) => {
          const pts = [];
          for (let k = 0; k <= 12; k++) {
            const t = k / 12, a = q * (0.2 + 1.9 * t), r = 0.009 * (1 - 0.7 * t);
            const p = at(phi0 + q * (W * 0.55) / rm + Math.cos(a + Math.PI / 2) * r / rm, 0.004 + r * Math.sin(a + Math.PI / 2) + 0.004, 0.0022);
            pts.push(p);
          }
          this._cord(`crownCurl${n}_${q}`, pts, 0.0016, M.gold, node, 5);
        });
        const tip = pt(0, 1, 0);
        this._ball(`crownPearl${n}`, [tip[0], tip[1] + 0.003, tip[2]], kind === 'big' ? 0.009 : 0.007, M.pearl, node);
        const g = pt(0, 0.32, 0.0026);
        const gem = this._ball(`crownGem${n}`, g, kind === 'big' ? 0.017 : 0.01, n % 2 ? M.sapphire : M.ruby, node, kind === 'big' ? [0.85, 1.15, 0.5] : [1, 1, 0.5]);
        gem.rotation.y = phi0;
        if (kind === 'big') {
          this._cord('bigGemBezel', Array.from({ length: 17 }, (_, k) => {
            const a = k / 16 * TAU, p = at(phi0 + Math.cos(a) * 0.0082 / rm, 0.32 * H + Math.sin(a) * 0.011, 0.0024); return p;
          }), 0.0016, M.gold, node, 5);
        }
      });
      // pearl-topped spikes between the fleurons
      spec.points.forEach(([phi0], n) => {
        const next = spec.points[(n + 1) % spec.points.length][0];
        let mid = (phi0 + next) / 2;
        if (Math.abs(next - phi0) > Math.PI) mid += Math.PI;
        if (spec.points.length < 8 && n % 2) return;
        const base = at(mid, 0, 0), top = at(mid, 0.02, 0.001);
        this._cord(`crownSpike${n}`, [base, top], [[0, 0.0032], [1, 0.0015]], M.gold, node, 6);
        this._ball(`crownSpikePearl${n}`, [top[0], top[1] + 0.003, top[2]], 0.0062, M.pearl, node);
        const bg = at(mid, -band / 2, 0.0028);
        this._ball(`bandGem${n}`, bg, 0.0085, n % 2 ? M.ruby : M.sapphire, node, [1, 1, 0.5]).rotation.y = mid;
      });
    }

    _buildCape(R, M) {
      const NU = 36, NV = 40;
      const vOf = (v) => v * v * 0.35 + v * 0.65;        // denser rows over the shoulders
      const cape = this._surf('cape', grid(NU, NV, (u, v) => [...capeLocal(CAPE.stand, u, vOf(v)), u, 1 - v]), M.cape, R.capeNode);
      this._addMorphs(cape, (keys) => grid(NU, NV, (u, v) => capeLocal(keys, u, vOf(v))), [CAPE.sit, CAPE.billow]);
      R.capeMesh = cape;
      // clasps where the cape meets the pauldrons, joined by a chain across the chest
      [-1, 1].forEach((s) => {
        const p = capePoint(CAPE.stand, s > 0 ? 0.01 : 0.99, 0.0);
        this._ball(`clasp${s}`, [p[0], p[1] - 0.01, p[2] + 0.01], 0.026, M.gold, R.chest, [1, 1, 0.5]);
        this._ball(`claspGem${s}`, [p[0], p[1] - 0.01, p[2] + 0.017], 0.012, M.ruby, R.chest);
      });
    }

    // Great sword along sword-space +y from the guard: a mirror-bright blade
    // with glowing runes down the fuller, a flared gold guard with spiked
    // quillons and wings over the blade, a wrapped grip and a jewelled pommel.
    _buildSword(R, M) {
      const sw = R.sword, Lb = SWORD.blade;
      const W = [[0, 0.036], [0.07, 0.038], [0.33, 0.033], [0.44, 0.026], [0.51, 0.014], [0.54, 0.005], [0.55, 0.0005]];
      this._surf('blade', grid(12, 30, (u, v) => {
        const y = v * Lb, w = curve(W, y)[0], th = lerp(0.0068, 0.003, v), a = u * TAU;
        return [w * spow(Math.cos(a), 2 / 1.25), y, th * spow(Math.sin(a), 2 / 1.25)];
      }, { closed: true, capEnd: true }), M.blade, sw);
      [1, -1].forEach((s) => {
        this._surf(`runes${s}`, grid(2, 16, (u, v) => {
          const y = lerp(0.04, 0.37, v), w = 0.0065 * (1 - 0.3 * v), th = lerp(0.0068, 0.003, y / Lb) * 0.97 + 0.0004;
          return [(1 - 2 * u) * w * s, y, s * th, u, 1 - v];
        }), M.rune, sw);
      });
      // guard block, quillons curving toward the blade with spiked ends
      this._surf('guardBlock', grid(16, 8, (u, v) => {
        const a = u * TAU, y = lerp(-0.012, 0.016, v), w = 0.02 + 0.012 * Math.sin(Math.PI * v);
        return [w * spow(Math.cos(a), 0.5), y, 0.012 * spow(Math.sin(a), 0.5)];
      }, { closed: true, capStart: true, capEnd: true }), M.gold, sw);
      [-1, 1].forEach((s) => {
        const pts = [[s * 0.02, 0.0, 0], [s * 0.055, 0.004, 0], [s * 0.085, 0.016, 0], [s * 0.1, 0.034, 0]];
        this._cord(`quillon${s}`, pts, [[0, 0.0085], [0.6, 0.007], [1, 0.0045]], M.gold, sw, 10);
        [-0.7, 0, 0.7].forEach((a, i) => {
          const dir = V3(s * Math.cos(0.9 + a), Math.sin(0.9 + a), 0);
          const b = V3(s * 0.1, 0.034, 0);
          this._cord(`spike${s}_${i}`, [[b.x, b.y, b.z], [b.x + dir.x * 0.018, b.y + dir.y * 0.018, 0]], [[0, 0.004], [1, 0.0004]], M.gold, sw, 6);
        });
        this._ball(`quillonBall${s}`, [s * 0.1, 0.034, 0], 0.011, M.gold, sw);
        // wing over the blade base
        [1, -1].forEach((f) => this._leaf(`guardWing${s}_${f}`, [s * 0.017, 0.035, f * 0.006], [s * 0.35, 1, 0], [1, -s * 0.35, 0], [0, 0, f],
          0.05, 0.024, 0.003, M.gold, M.gold, sw, 0.55));
      });
      [1, -1].forEach((f) => this._ball(`guardGem${f}`, [0, 0.003, f * 0.011], 0.013, M.ruby, sw, [1, 1, 0.5]));
      // wrapped grip, ferrules and pommel
      this._surf('grip', grid(12, 20, (u, v) => {
        const a = u * TAU, y = lerp(-0.012, -0.128, v), r = 0.0105 + 0.0006 * Math.pow(Math.sin(a + v * 40), 2);
        return [r * Math.sin(a), y, r * Math.cos(a)];
      }, { closed: true }), M.leather, sw);
      [-0.014, -0.066, -0.127].forEach((y, i) => this._cord(`ferrule${i}`, Array.from({ length: 13 }, (_, k) => {
        const a = k / 12 * TAU; return [0.0122 * Math.sin(a), y, 0.0122 * Math.cos(a)];
      }), 0.0022, M.gold, sw, 5));
      this._surf('pommel', grid(8, 10, (u, v) => {
        const a = u * TAU, y = lerp(-0.128, -0.162, v), r = 0.019 * Math.sin(Math.PI * Math.min(1, 0.08 + v)) + 0.004;
        return [r * spow(Math.sin(a), 0.7), y, r * spow(Math.cos(a), 0.7)];
      }, { closed: true, capEnd: true }), M.gold, sw);
      [1, -1].forEach((f) => this._ball(`pommelGem${f}`, [0, -0.145, f * 0.017], 0.011, M.sapphire, sw, [1, 1, 0.5]));
      const tip = new BABYLON.TransformNode(`swordTip_${this.id}`, this.scene);
      tip.parent = sw; tip.position.y = Lb;
      const base = new BABYLON.TransformNode(`swordBase_${this.id}`, this.scene);
      base.parent = sw; base.position.y = 0.05;
      this.parts.swordTip = tip; this.parts.swordBase = base;
    }

    // Throne: gilded frame on lion-paw feet, tufted velvet seat, padded
    // arms ending in volutes, and an arched back crowned with a small crown.
    _buildThrone(M, team) {
      const T = this._node('throne', this.visual);
      this.parts.throne = T;
      const gold = M.gold, vel = M.velvet;
      const superBox = (name, c, h, e, mat, puff, parent) => this._surf(name, grid(28, 14, (u, v) => {
        const th = u * TAU - Math.PI, ph = (v - 0.5) * Math.PI, cp = Math.cos(ph), sp = Math.sin(ph);
        const x = h[0] * spow(cp, e) * spow(Math.cos(th), e), z = h[2] * spow(cp, e) * spow(Math.sin(th), e);
        let y = h[1] * spow(sp, e);
        if (puff && sp > 0) y += puff * (1 - Math.pow(x / h[0], 2)) * (1 - Math.pow(z / h[2], 2));
        return [c[0] + x, c[1] + y, c[2] + z, (x / h[0]) * 0.5 + 0.5, (z / h[2]) * 0.5 + 0.5];
      }, { closed: true }), mat, parent || T);
      const lathe = (name, prof, cx, cz, mat) => {
        const keys = prof.map((p, i) => [i / (prof.length - 1), p[0], p[1]]);
        return this._surf(name, grid(16, prof.length * 3, (u, v) => {
          const [y, r] = curve(keys, v), a = u * TAU;
          return [cx + r * Math.sin(a), y, cz + r * Math.cos(a)];
        }, { closed: true, capStart: true, capEnd: true }), mat, T);
      };
      const LOW = [[G, 0.02], [G + 0.012, 0.027], [G + 0.028, 0.02], [0.13, 0.013], [0.16, 0.019], [0.19, 0.012], [0.225, 0.016], [0.275, 0.017]];
      const XP = 0.2, ZF = 0.06, ZB = -0.245;
      [[XP, ZF], [-XP, ZF]].forEach(([x, z], i) => lathe(`frontPost${i}`, LOW.concat([[0.3, 0.012], [0.34, 0.018], [0.38, 0.012], [0.425, 0.011], [0.455, 0.015]]), x, z, gold));
      [[XP, ZB], [-XP, ZB]].forEach(([x, z], i) => {
        lathe(`backPost${i}`, LOW.concat([[0.32, 0.013], [0.5, 0.012], [0.53, 0.017], [0.56, 0.012], [0.76, 0.012], [0.8, 0.017], [0.83, 0.013]]), x, z, gold);
        this._ball(`finial${i}`, [x, 0.855, z], 0.034, gold, T);
        this._cord(`finialSpike${i}`, [[x, 0.87, z], [x, 0.915, z]], [[0, 0.007], [1, 0.0008]], gold, T, 6);
      });
      // lion paws
      [[XP, ZF], [-XP, ZF], [XP, ZB], [-XP, ZB]].forEach(([x, z], i) => {
        for (let k = 0; k < 4; k++) {
          const a = (k - 1.5) * 0.55 + (z > 0 ? 0 : Math.PI) + (x > 0 ? 0.35 : -0.35) * (z > 0 ? 1 : -1);
          this._ball(`paw${i}_${k}`, [x + Math.sin(a) * 0.024, G + 0.009, z + Math.cos(a) * 0.024], 0.02, gold, T, [0.9, 0.8, 1.2]).rotation.y = a;
        }
      });
      // seat rails, apron and cushion
      superBox('railFront', [0, 0.255, ZF], [XP, 0.022, 0.018], 0.35, gold);
      superBox('railBack', [0, 0.255, ZB], [XP, 0.022, 0.018], 0.35, gold);
      [-1, 1].forEach((s) => superBox(`railSide${s}`, [s * XP, 0.255, (ZF + ZB) / 2], [0.017, 0.022, (ZF - ZB) / 2], 0.35, gold));
      this._surf('apron', grid(40, 4, (u, v) => {
        const x = lerp(-0.18, 0.18, u), bottom = 0.2 - 0.016 * Math.abs(Math.sin(x / 0.18 * 2.5 * Math.PI)) - 0.02 * Math.exp(-Math.pow(x / 0.03, 2));
        return [x, lerp(0.234, bottom, v), ZF + 0.012 - 0.004 * v];
      }), gold, T);
      this._ball('apronGem', [0, 0.205, ZF + 0.016], 0.018, M.ruby, T, [1, 1, 0.5]);
      [-1, 1].forEach((s) => {
        const pts = [];
        for (let k = 0; k <= 14; k++) { const t = k / 14, a = s * (Math.PI + t * 1.6 * TAU), r = 0.022 * (1 - 0.75 * t); pts.push([s * 0.06 + Math.cos(a) * r, 0.212 + Math.sin(a) * r, ZF + 0.017]); }
        this._cord(`apronScroll${s}`, pts, 0.0035, gold, T, 5);
      });
      superBox('cushion', [0, 0.287, (ZF + ZB) / 2 + 0.005], [0.186, 0.016, 0.152], 0.3, vel, 0.008);
      // arms: gilded rails, velvet pads, volutes and balusters
      [-1, 1].forEach((s) => {
        const x = s * 0.212;
        superBox(`armRail${s}`, [x, 0.455, -0.085], [0.024, 0.012, 0.165], 0.35, gold);
        superBox(`armPad${s}`, [x, 0.47, -0.1], [0.02, 0.009, 0.13], 0.35, vel, 0.004);
        const pts = [];
        for (let k = 0; k <= 18; k++) { const t = k / 18, a = -Math.PI / 2 + t * 1.7 * TAU, r = 0.03 * (1 - 0.72 * t); pts.push([x, 0.44 + Math.sin(a) * r, 0.085 + Math.cos(a) * r]); }
        this._cord(`volute${s}`, pts, [[0, 0.012], [0.6, 0.008], [1, 0.005]], gold, T, 8);
        [-0.03, -0.14].forEach((z, i) => lathe(`baluster${s}_${i}`, [[0.275, 0.009], [0.3, 0.013], [0.33, 0.008], [0.36, 0.014], [0.39, 0.008], [0.42, 0.012], [0.445, 0.009]], x, z, gold));
      });
      // back: tufted velvet in front, chased gold behind, framed by a gilded arch
      const arch = (x) => 0.8 + 0.085 * (1 - Math.pow(Math.abs(x) / 0.2, 1.6)) + 0.03 * Math.exp(-Math.pow(x / 0.035, 2));
      const ZBK = -0.262;
      this._surf('backVelvet', grid(24, 24, (u, v) => {
        const x = lerp(-0.178, 0.178, u), y = lerp(0.3, arch(x) - 0.014, v), z = ZBK + 0.012 * Math.pow(x / 0.178, 2);
        return [x, y, z, x * 3.2 + 0.5, y * 3.2];
      }), vel, T);
      this._surf('backGold', grid(24, 24, (u, v) => {
        const x = lerp(0.178, -0.178, u), y = lerp(0.3, arch(x) - 0.004, v);
        return [x, y, ZBK - 0.022 + 0.012 * Math.pow(x / 0.178, 2), u * 2, y * 3];
      }), M.goldBand, T);
      const frame = [];
      for (let k = 0; k <= 40; k++) { const x = lerp(-0.19, 0.19, k / 40); frame.push([x, arch(x) - 0.006, ZBK - 0.011 + 0.012 * Math.pow(x / 0.178, 2)]); }
      this._cord('backArch', frame, 0.012, gold, T, 10);
      superBox('backRailLow', [0, 0.305, ZBK - 0.011], [0.19, 0.014, 0.016], 0.35, gold);
      [-1, 1].forEach((s) => this._cord(`backSide${s}`, [[s * 0.19, 0.3, ZBK - 0.011], [s * 0.19, arch(s * 0.19) - 0.006, ZBK - 0.009]], 0.011, gold, T, 8));
      // medallion on the back of the throne
      const md = this._surf('backMedallion', grid(28, 6, (u, v) => {
        const a = u * TAU, r = 0.07 * v; return [r * Math.cos(a), 0.62 + r * Math.sin(a), ZBK - 0.024 - 0.012 * (1 - v * v)];
      }, { closed: true }), gold, T);
      this._cord('medallionRim', Array.from({ length: 29 }, (_, k) => { const a = k / 28 * TAU; return [0.07 * Math.cos(a), 0.62 + 0.07 * Math.sin(a), ZBK - 0.026]; }), 0.005, gold, T, 6);
      this._ball('medallionGem', [0, 0.62, ZBK - 0.038], 0.03, M.ruby, T, [1, 1, 0.5]);
      // crest: a small crown on the peak of the arch
      const crest = this._node('crest', T, [0, arch(0) + 0.004, ZBK - 0.011]);
      this._crownOn(crest, { rx: 0.032, rzF: 0.024, rzB: 0.024, band: 0.014, flare: 0.25,
        points: [[0, 0.02, 0.05, 'big'], [1.25, 0.018, 0.038], [-1.25, 0.018, 0.038], [2.4, 0.016, 0.03], [-2.4, 0.016, 0.03]] }, M);
    }

    // ---------------------------------------------------------- IK + poses
    _setWorldRot(node, Mw) {
      const L = Mw.multiply(rotOf(node.parent.getWorldMatrix()).transpose());
      if (!node.rotationQuaternion) node.rotationQuaternion = new Quat();
      Quat.FromRotationMatrixToRef(L, node.rotationQuaternion);
      node.computeWorldMatrix(true);
    }
    // Two-bone chain from S to W: the joint bends toward `pole`; each
    // segment's local +z (its front) turns toward `front`.
    _twoBone(upper, lower, S, W, pole, front, a, b) {
      const d = W.subtract(S);
      let dist = d.length();
      const dir = dist > 1e-6 ? d.scale(1 / dist) : V3(0, -1, 0);
      dist = clamp(dist, Math.abs(a - b) + 1e-4, a + b - 1e-4);
      const x = (a * a - b * b + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, a * a - x * x));
      const p = orth(pole, dir);
      const E = S.add(dir.scale(x)).add(p.scale(h)), Wc = S.add(dir.scale(dist));
      const yU = S.subtract(E).normalize(), zU = orth(front, yU);
      this._setWorldRot(upper, basis(Vec.Cross(yU, zU), yU, zU));
      const yL = E.subtract(Wc).normalize(), zL = orth(front, yL);
      this._setWorldRot(lower, basis(Vec.Cross(yL, zL), yL, zL));
      return { E, W: Wc };
    }
    _arm(R, side, grip, thumb, pole, k) {
      const s = side === 'R' ? 1 : -1, arm = R['arm' + side], fore = R['fore' + side], hand = R['hand' + side];
      arm.computeWorldMatrix(true);
      const S = arm.getAbsolutePosition().clone(), zH = thumb.normalize(), G3 = HAND_GRIP(s);
      let F = grip.subtract(S).normalize(), res = null;
      for (let pass = 0; pass < 2; pass++) {
        let yH = F.scale(-1);
        yH = orth(yH, zH);
        const xH = Vec.Cross(yH, zH);
        const wrist = grip.subtract(xH.scale(G3[0] * k)).subtract(yH.scale(G3[1] * k)).subtract(zH.scale(G3[2] * k));
        res = this._twoBone(arm, fore, S, wrist, pole, pole.scale(-1), LEN.upper * k, LEN.fore * k);
        F = res.W.subtract(res.E).normalize();
        if (pass === 1) this._setWorldRot(hand, basis(xH, yH, zH));
      }
    }

    _applyPose(P, rig) {
      const R = rig || this.rig;
      R.hips.position.set(P.hips[0], P.hips[1], P.hips[2]);
      R.hips.rotation.set(P.hipsRot[0], P.hipsRot[1], P.hipsRot[2]);
      R.spine.rotation.set(P.spine[0], P.spine[1], P.spine[2]);
      R.chest.rotation.set(P.chest[0], P.chest[1], P.chest[2]);
      R.neck.rotation.set(P.neck[0], P.neck[1], P.neck[2]);
      R.head.rotation.set(P.head[0], P.head[1], P.head[2]);
      if (R.capeNode) {
        const sit = clamp(P.sit, 0, 1), k2 = 1 - sit;
        R.capeNode.rotation.set(-(P.hipsRot[0] + P.spine[0] + P.chest[0]) * 0.85 * k2,
          -(P.hipsRot[1] + P.spine[1] + P.chest[1]) * 0.75, -(P.hipsRot[2] + P.spine[2] + P.chest[2]) * 0.8 * k2);
      }
      if (R.base === this.visual) this.root.computeWorldMatrix(true);
      [R.base, R.hips, R.spine, R.chest, R.neck, R.head, R.capeNode].forEach((n) => n && n.computeWorldMatrix(true));
      const B = R.base.getWorldMatrix(), Brot = rotOf(B);
      const k = Vec.TransformNormal(V3(1, 0, 0), B).length() || 1;
      const toW = (p) => Vec.TransformCoordinates(V3(p[0], p[1], p[2]), B);
      const dirW = (d) => Vec.TransformNormal(V3(d[0], d[1], d[2]), Brot).normalize();

      ['R', 'L'].forEach((side) => {
        const s = side === 'R' ? 1 : -1, f = P['foot' + side], thigh = R['thigh' + side];
        thigh.computeWorldMatrix(true);
        const pole = dirW([s * P.kneeOut, 0.15, 1]);
        this._twoBone(thigh, R['shin' + side], thigh.getAbsolutePosition().clone(), toW(f), pole, pole, LEN.thigh * k, LEN.shin * k);
        this._setWorldRot(R['foot' + side], Mat.RotationYawPitchRoll(f[4], f[3], 0).multiply(Brot));
      });

      let gripR = null, gripL = null, bladeW = null;
      if (R.sword) {
        const q = P.sword, D = V3(q[3], q[4], q[5]).normalize();
        let X = orth(V3(1, 0, 0), D);
        const Z0 = Vec.Cross(X, D);
        X = X.scale(Math.cos(q[6])).add(Z0.scale(Math.sin(q[6])));
        R.sword.position.set(q[0], q[1], q[2]);
        if (!R.sword.rotationQuaternion) R.sword.rotationQuaternion = new Quat();
        Quat.FromRotationMatrixToRef(basis(X, D, Vec.Cross(X, D)), R.sword.rotationQuaternion);
        R.sword.computeWorldMatrix(true);
        const SW = R.sword.getWorldMatrix();
        gripR = Vec.TransformCoordinates(V3(0, SWORD.gripR, 0), SW);
        gripL = Vec.TransformCoordinates(V3(0, SWORD.gripL, 0), SW);
        bladeW = Vec.TransformNormal(V3(0, 1, 0), rotOf(SW)).normalize();
      }
      ['R', 'L'].forEach((side) => {
        const w = R.sword ? (side === 'R' ? P.gripR : P.gripL) : 0;
        const free = toW(P['hand' + side]), freeThumb = dirW(P['thumb' + side]);
        const target = w > 0 ? Vec.Lerp(free, side === 'R' ? gripR : gripL, w) : free;
        const thumb = w > 0 ? Vec.Lerp(freeThumb, bladeW, w).normalize() : freeThumb;
        this._arm(R, side, target, thumb, dirW(P['elbow' + side]), k);
        const sh = R['shoulder' + side];
        if (sh) {
          const dir = V3(0, -1, 0).applyRotationQuaternion(R['arm' + side].rotationQuaternion);
          if (!sh.rotationQuaternion) sh.rotationQuaternion = new Quat();
          Quat.FromUnitVectorsToRef(V3(0, -1, 0), dir, this._tmpQ || (this._tmpQ = new Quat()));
          Quat.SlerpToRef(Quat.Identity(), this._tmpQ, 0.4, sh.rotationQuaternion);
        }
      });

      [R.capeMesh, R.panelMesh].forEach((m) => {
        const mgr = m && m.morphTargetManager;
        if (!mgr) return;
        mgr.getTarget(0).influence = clamp(P.sit, 0, 1);
        mgr.getTarget(1).influence = clamp(P.billow, 0, 1) * (1 - clamp(P.sit, 0, 1));
      });
      if (R === this.rig) { this._setGlow(P.glow); this._cur = P; }
    }

    _setGlow(g) {
      const M = this.kMats;
      M.blade.emissiveColor = this._glowColor.scale(0.12 * g).add(new BABYLON.Color3(0.25, 0.25, 0.28).scale(g * g * 0.5));
      M.rune.emissiveColor = this._goldColor.scale(0.35 + 0.9 * g).add(this._glowColor.scale(0.5 * g));
    }

    // Play keyed poses: keys [[ms, pose], ...] (Catmull-Rom between them).
    // onTime(ms) runs every frame after the pose is applied.
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

    // ---------------------------------------------------------- idle
    // Pooled (instance-pool.js): the rig is hidden and the king doesn't bob.
    updateIdlePooled() { this.visual.position.y = this.selectLift; }

    // A fidgeting king (king-fidgets.js) draws live, and a game animation
    // taking him over or a selection cuts the fidget short.
    get busy() { return this._busy; }
    set busy(v) {
      if (v && this._kfid) this._endKingFidget(false);
      super.busy = v;
    }
    tickProxy(now, allowHeavy) {
      return this._kfid ? false : super.tickProxy(now, allowHeavy);
    }
    setSelected(on) {
      if (on && this._kfid) this._endKingFidget(true);
      super.setSelected(on);
    }

    updateIdle(t) {
      if (this.busy || this._kfid) return;        // _kfid: an idle fidget is posing him (king-fidgets.js)
      const ph = this.idlePhase;
      this.visual.position.y = this.selectLift;
      const P = this._seated ? sitPose() : standPose(this._dz || 0);
      P.chest[0] += 0.012 * Math.sin(t * 1.5 + ph);
      P.spine[0] += 0.005 * Math.sin(t * 1.5 + ph + 0.4);
      P.head[1] += 0.2 * Math.sin(t * 0.33 + ph) + 0.05 * Math.sin(t * 0.9 + ph * 2);
      P.head[0] += 0.03 * Math.sin(t * 0.47 + ph);
      if (!this._seated) P.billow = 0.08 + 0.05 * Math.sin(t * 1.1 + ph);
      this._applyPose(P);
    }
    setWalking() {}

    // ---------------------------------------------------------- moving
    // Rise, let the throne sink, walk slowly to the square, turn round, let
    // the throne rise behind and sit down again. With opts.keepFacing (the
    // approach to a capture) he stays standing, facing where he went.
    async moveTo(pos, style, opts) {
      opts = opts || {};
      this.busy = true;
      if (this._seated) {
        await this._standUp();
        this._leaveThrone();
      }
      let target = pos.clone();
      target.y = this.root.position.y;
      const home = V3(Math.sin(this.baseFacing), 0, Math.cos(this.baseFacing));
      if (!opts.keepFacing) target = target.add(home.scale(FRONT));
      const d = target.subtract(this.root.position);
      d.y = 0;
      if (d.length() > 0.02) {
        await this._turnTo(Math.atan2(d.x, d.z));
        await this._walk(target);
      }
      if (!opts.keepFacing) {
        await this._turnTo(this.baseFacing);
        this.root.position.copyFrom(pos);
        this._dz = FRONT;
        this._applyPose(shiftPose(this._cur, FRONT));
        if (this._throneGone) await this._throneGone;
        await this._summonThrone();
        await this._sitDown();
        const fx = this.ctx.effects;
        if (fx && fx.dustPuff) fx.dustPuff(pos);
      }
      this.busy = false;
    }

    _standUp() {
      const S = sitPose(), E = standPose(FRONT);
      const lean = withPose(S, { hips: [0, 0.388, -0.05], spine: [0.22, 0, 0], chest: [0.26, 0, 0], head: [-0.24, 0, 0], sit: 0.75,
        sword: [PLANTED[0], PLANTED[1] + 0.04, PLANTED[2] + 0.03, PLANTED[3], PLANTED[4], PLANTED[5], 0] });
      const rise = withPose(E, { hips: [0, 0.54, 0.08], spine: [0.12, 0, 0], chest: [0.1, 0, 0], head: [-0.1, 0, 0], sit: 0.2,
        sword: [0.08, 0.72, 0.33, 0.1, 0.3, 0.95, 0.6], gripL: 0.3, footR: S.footR, footL: S.footL });
      this._seated = false;
      return this._playKeys([[0, clonePose(this._cur)], [420, lean], [760, rise], [1080, E]]);
    }

    _sitDown() {
      const S = sitPose(), E = shiftPose(standPose(0), FRONT);
      const lower = withPose(E, { sword: [0.03, 0.66, 0.34, 0.05, -0.55, 0.83, 0], gripL: 0.6, footR: S.footR, footL: S.footL });
      const lean = withPose(S, { hips: [0, 0.44, -0.02], spine: [0.24, 0, 0], chest: [0.24, 0, 0], head: [-0.24, 0, 0], sit: 0.6,
        sword: [PLANTED[0], PLANTED[1] + 0.04, PLANTED[2] + 0.03, PLANTED[3], PLANTED[4], PLANTED[5], 0] });
      return this._playKeys([[0, clonePose(this._cur)], [320, lower], [700, lean], [1050, S]]).then(() => { this._seated = true; this._dz = 0; });
    }

    // Detach the throne where it stands and sink it into the board; move
    // the root under the king (standing FRONT ahead of it) so he walks and
    // turns about his own feet.
    _leaveThrone() {
      const T = this.parts.throne, fwd = V3(Math.sin(this.root.rotation.y), 0, Math.cos(this.root.rotation.y));
      T.computeWorldMatrix(true);
      T.setParent(null);
      this.root.position.addInPlace(fwd.scale(this._dz || FRONT));
      this._applyPose(shiftPose(this._cur, -(this._dz || FRONT)));
      this._dz = 0;
      const fx = this.ctx.effects, team = Config.TEAM[this.color];
      const where = T.position.clone();
      this._throneGone = Tween.wait(200).then(() => {
        if (fx && fx.dissolve) fx.dissolve(where, team.accent, 1.0);
        return Tween.run(650, (t) => { T.scaling.set(1 - 0.12 * t, Math.max(0.001, 1 - t), 1 - 0.12 * t); }, Ease.inCubic);
      }).then(() => { T.setEnabled(false); });
    }

    async _summonThrone() {
      const T = this.parts.throne, fx = this.ctx.effects, team = Config.TEAM[this.color];
      this._throneGone = null;
      T.parent = this.visual;
      T.position.set(0, 0, 0);
      T.rotationQuaternion = null;
      T.rotation.set(0, 0, 0);
      T.scaling.set(0.88, 0.001, 0.88);
      T.setEnabled(true);
      if (fx && fx.dissolve) fx.dissolve(this.root.position.clone(), team.accent, 1.1);
      if (fx && fx.sparks) fx.sparks(this.root.position.add(V3(0, 0.3, 0)), team.accent);
      await Tween.run(650, (t) => { T.scaling.set(lerp(0.88, 1, t), Math.max(0.001, t), lerp(0.88, 1, t)); }, Ease.outBack);
      T.scaling.set(1, 1, 1);
    }

    // Turn on the spot to face yaw, stepping from foot to foot.
    async _turnTo(yaw) {
      const start = this.root.rotation.y;
      let diff = (yaw - start) % TAU;
      if (diff > Math.PI) diff -= TAU;
      if (diff < -Math.PI) diff += TAU;
      if (Math.abs(diff) < 0.01) return;
      const base = standPose(0), steps = Math.max(1, Math.round(Math.abs(diff) / 0.9));
      await Tween.run(320 + 480 * Math.abs(diff) / Math.PI, (e, raw) => {
        this.root.rotation.y = start + diff * e;
        const P = clonePose(base), ph = raw * steps * Math.PI;
        P.footR[1] += 0.024 * Math.max(0, Math.sin(ph * 2));
        P.footL[1] += 0.024 * Math.max(0, -Math.sin(ph * 2));
        P.hips[0] = 0.008 * Math.sin(ph * 2);
        P.billow = 0.15;
        this._applyPose(P);
      }, Ease.linear);
      this.root.rotation.y = yaw;
    }

    // Walk to `target` at a stately pace; the stance foot slides back under
    // the body at exactly the walking speed, so the feet stay planted.
    async _walk(target) {
      const from = this.root.position.clone(), d = target.subtract(from);
      d.y = 0;
      const dist = d.length(), dir = d.scale(1 / dist), fx = this.ctx.effects;
      const ms = dist / WALK.speed * 1000 / (1 - WALK.ramp);
      const along = cruise(WALK.ramp), base = standPose(0), L = WALK.step;
      let lastStep = 0;
      await Tween.run(ms, (_, raw) => {
        const trav = dist * along(raw);
        this.root.position.set(from.x + dir.x * trav, from.y, from.z + dir.z * trav);
        const phase = trav / (2 * L), w = smoothstep(0, 0.6 * L, trav) * smoothstep(0, 0.6 * L, dist - trav);
        const P = clonePose(base);
        [['footR', 0], ['footL', 0.5]].forEach(([f, off]) => {
          const p = ((phase + off) % 1 + 1) % 1, [z, lift, pitch] = footCycle(p, L, WALK.duty);
          P[f][1] += lift * w; P[f][2] = lerp(P[f][2], z, w); P[f][3] = pitch * w;
        });
        const c = Math.cos(TAU * (phase - 0.3));
        P.hips[1] += (0.007 * Math.cos(2 * TAU * (phase - 0.3)) - 0.006) * w;
        P.hips[0] = 0.01 * c * w;
        P.hipsRot[1] = 0.07 * Math.sin(TAU * phase) * w;
        P.chest[1] = -0.09 * Math.sin(TAU * phase) * w;
        P.chest[0] += 0.03 * w; P.head[0] -= 0.03 * w;
        P.handL = [-0.2, 0.53, 0.02 + 0.07 * Math.cos(TAU * phase) * w];
        P.billow = 0.55 * w + 0.1 * Math.sin(TAU * phase * 2) * w;
        this._applyPose(P);
        const step = Math.floor(phase * 2 + 0.5);
        if (step !== lastStep && w > 0.5) { lastStep = step; if (fx && fx.dustPuff && Math.random() < 0.5) fx.dustPuff(this.root.position.clone()); }
      }, Ease.linear);
    }

    // ---------------------------------------------------------- combat
    // Three two-handed cuts — a diagonal forehand, a rising backhand and an
    // overhead blow with a step in — each leaving a trail of light. Resolves
    // at the moment the last blow lands.
    async playAttack(targetPos) {
      this.busy = true;
      const fx = this.ctx.effects, team = Config.TEAM[this.color];
      await this.faceTowards(targetPos, TIMING.turn);
      const F = fightPose();
      const wind1 = withPose(F, { sword: [0.17, 1.0, 0.0, 0.45, 0.55, -0.7, 0.3], chest: [-0.04, 0.45, 0], spine: [0.02, 0.22, 0], hipsRot: [0, 0.25, 0],
        head: [0.02, -0.35, 0], glow: 1, elbowR: [1, -0.2, -0.6], elbowL: [0.2, -1, -0.4] });
      const mid1 = withPose(F, { sword: [0.05, 0.82, 0.3, -0.25, 0.15, 0.95, 0.4], chest: [0.06, 0, 0], spine: [0.04, 0, 0], hipsRot: [0, 0.05, 0], head: [0.06, 0, 0], glow: 1 });
      const end1 = withPose(F, { sword: [-0.16, 0.55, 0.2, -0.78, -0.5, 0.36, 0.5], chest: [0.16, -0.45, 0], spine: [0.08, -0.2, 0], hipsRot: [0, -0.15, 0],
        head: [0.1, 0.25, 0], glow: 1, elbowR: [0.3, -1, -0.3], elbowL: [-1, -0.3, -0.5] });
      const wind2 = withPose(end1, { sword: [-0.19, 0.5, 0.1, -0.85, -0.45, 0, 0.5], chest: [0.14, -0.6, 0] });
      const mid2 = withPose(F, { sword: [0, 0.76, 0.3, 0.3, 0.12, 0.95, -0.4], chest: [0.06, 0.05, 0], glow: 1 });
      const end2 = withPose(F, { sword: [0.17, 1.0, 0.12, 0.72, 0.62, -0.1, -0.4], chest: [-0.08, 0.5, 0], spine: [0, 0.2, 0], hipsRot: [0, 0.25, 0],
        elbowR: [1, -0.1, -0.5], elbowL: [0.2, -1, -0.3], glow: 1 });
      const wind3 = withPose(F, { sword: [0.03, 1.14, -0.03, 0.05, 0.55, -0.83, 0], chest: [-0.22, 0.05, 0], spine: [-0.08, 0, 0], hips: [0, 0.59, -0.02],
        head: [-0.05, 0, 0], elbowR: [1, 0.2, -0.3], elbowL: [-1, 0.2, -0.3], glow: 1.6 });
      const mid3 = withPose(F, { sword: [0, 1.0, 0.3, 0, 0.6, 0.8, 0], chest: [0.05, 0, 0], hips: [0, 0.57, 0.06], glow: 1.6,
        footR: [0.1, G + LEN.ankle + 0.04, 0.2, -0.2, 0.1] });
      const impact = withPose(F, { sword: [0, 0.6, 0.42, 0, -0.3, 0.95, 0], chest: [0.32, 0, 0], spine: [0.12, 0, 0], hips: [0, 0.54, 0.12], hipsRot: [0.05, 0, 0],
        footR: [0.1, G + LEN.ankle, 0.27, 0, 0.1], footL: [-0.12, G + LEN.ankle + 0.035, -0.12, 0.45, -0.3], head: [-0.1, 0, 0],
        elbowR: [1, -0.5, -0.4], elbowL: [-1, -0.5, -0.4], glow: 1.6 });
      const keys = [[0, clonePose(this._cur)], [380, F], [560, wind1], [665, mid1], [770, end1], [900, wind2], [1005, mid2], [1110, end2],
        [1390, wind3], [1515, mid3], [1600, impact]];
      const hit = targetPos.add(V3(0, 0.5, 0));
      const events = [
        [470, () => { this._trail = fx && fx.bladeTrail ? fx.bladeTrail(this.parts.swordBase, this.parts.swordTip, hex(team.glow).scale(0.6).add(new BABYLON.Color3(0.4, 0.38, 0.3)).toHexString()) : null; }],
        [590, () => window.ChessSound && ChessSound.playSwoosh && ChessSound.playSwoosh()],
        [665, () => fx && fx.sparks && fx.sparks(hit, team.accent)],
        [930, () => window.ChessSound && ChessSound.playSwoosh && ChessSound.playSwoosh(0.9)],
        [1005, () => fx && fx.sparks && fx.sparks(hit, team.accent)],
        [1300, () => fx && fx.burst && fx.burst({ pos: this.parts.swordTip.getAbsolutePosition(), color1: '#ffffff', color2: team.accent, count: 30,
          speed: { min: 0.3, max: 1.2 }, life: 0.5, size: 0.09 })],
        [1470, () => window.ChessSound && ChessSound.playSwoosh && ChessSound.playSwoosh(1.2)]
      ];
      let next = 0;
      await this._playKeys(keys, (t) => { while (next < events.length && t >= events[next][0]) events[next++][1](); });
      while (next < events.length) events[next++][1]();
      if (fx && fx.burst) fx.burst({ pos: hit, color1: '#ffffff', color2: team.accent, count: 40, speed: { min: 1, max: 3 }, life: 0.45, size: 0.1 });
      const trail = this._trail;
      this._trail = null;
      Tween.wait(120).then(() => trail && trail.stop());
    }

    async playRecover() {
      this.busy = true;
      await this._blendTo(standPose(0), 520, Ease.inOutCubic);
      this.busy = false;
    }

    async playHit() {
      this.busy = true;
      const base = clonePose(this._cur);
      const hit = withPose(base, { chest: [base.chest[0] - 0.16, base.chest[1], base.chest[2]], head: [base.head[0] - 0.25, base.head[1], 0.08],
        spine: [base.spine[0] - 0.06, base.spine[1], base.spine[2]] });
      await Tween.run(260, (t, raw) => {
        this.setFlash(1 - raw);
        this._applyPose(mixPose(base, hit, Math.sin(Math.PI * Math.min(1, raw * 1.4))));
      }, Ease.linear);
      this.setFlash(0);
      this.busy = false;
    }

    // Slump on the throne (or crumple where he stands), the sword toppling
    // to the floor, then release the soul.
    async playDeath() {
      this.busy = true;
      const fx = this.ctx.effects;
      const cur = clonePose(this._cur);
      const tipAt = (q) => { const D = V3(q[3], q[4], q[5]).normalize(); return V3(q[0], q[1], q[2]).add(D.scale(SWORD.blade)); };
      const tip0 = tipAt(cur.sword), tip1 = V3(-0.26, 0.078, 0.22);
      const D1 = V3(0.43, 0.0, 0.18).normalize().scale(-1);
      const swordAt = (t) => {
        const D0 = V3(cur.sword[3], cur.sword[4], cur.sword[5]).normalize();
        const D = Vec.Lerp(D0, D1, t).normalize(), tip = Vec.Lerp(tip0, tip1, t * t);
        const g = tip.subtract(D.scale(SWORD.blade));
        g.y = Math.max(g.y, 0.085);
        return [g.x, g.y, g.z, D.x, D.y, D.z, 0];
      };
      let keys;
      if (this._seated) {
        const jolt = withPose(cur, { chest: [-0.14, 0, 0], head: [-0.28, 0, 0.05], spine: [-0.05, 0, 0] });
        const slump = withPose(cur, { hips: [0, 0.372, -0.08], spine: [0.16, 0, 0.04], chest: [0.3, 0.05, 0.06], neck: [0.2, 0, 0.05], head: [0.55, 0.15, 0.25],
          gripR: 0, gripL: 0, handR: [0.1, 0.41, 0.1], handL: [-0.1, 0.41, 0.12], elbowR: [1, -0.4, -0.2], elbowL: [-1, -0.4, -0.2], sword: swordAt(0.55) });
        const limp = withPose(slump, { spine: [0.2, 0, 0.05], chest: [0.42, 0.06, 0.08], neck: [0.26, 0, 0.06], head: [0.72, 0.2, 0.32],
          handR: [0.12, 0.4, 0.13], handL: [-0.12, 0.39, 0.14], sword: swordAt(1) });
        keys = [[0, cur], [260, jolt], [760, slump], [1250, limp]];
      } else {
        const kneel = withPose(cur, { hips: [0, 0.34, cur.hips[2] - 0.02], chest: [0.35, 0, 0], spine: [0.2, 0, 0], head: [0.5, 0, 0.2],
          footR: [0.1, G + LEN.ankle, cur.hips[2] + 0.14, 0, 0.1], footL: [-0.1, G + LEN.ankle + 0.02, cur.hips[2] - 0.2, 1.0, -0.1],
          gripR: 0, gripL: 0, handR: [0.16, 0.3, cur.hips[2] + 0.1], handL: [-0.16, 0.3, cur.hips[2] + 0.1], sword: swordAt(0.6), sit: 0, billow: 0 });
        const down = withPose(kneel, { hips: [0, 0.27, cur.hips[2]], chest: [0.6, 0, 0], head: [0.7, 0.1, 0.3], sword: swordAt(1) });
        keys = [[0, cur], [300, withPose(cur, { chest: [-0.2, 0, 0], head: [-0.3, 0, 0] })], [900, kneel], [1300, down]];
      }
      let landed = false;
      await this._playKeys(keys, (t) => {
        if (!landed && t > keys[keys.length - 1][0] - 80) {
          landed = true;
          if (fx && fx.dustPuff) fx.dustPuff(this.parts.swordTip.getAbsolutePosition());
        }
      });
      this._releaseSoul();
      await Tween.wait(650);
    }

    // A pale, glowing ghost of the king rises out of the body towards the
    // sky in a shaft of light, fading as it goes. It lives on its own (not
    // under the character's root) and disposes itself; `soulDone` resolves
    // once it has gone, so the game can hold the end screen until then.
    _releaseSoul() {
      if (this._soulReleased) return this.soulDone;
      this._soulReleased = true;
      const scene = this.scene, fx = this.ctx.effects;
      const col = hex(this.L.soul);
      const mat = new BABYLON.StandardMaterial(`soulMat_${this.id}`, scene);
      mat.diffuseColor = BABYLON.Color3.Black(); mat.specularColor = BABYLON.Color3.Black();
      mat.emissiveColor = col.scale(0.45); mat.disableLighting = true; mat.alpha = 0;
      mat.emissiveFresnelParameters = new BABYLON.FresnelParameters({ bias: 0.15, power: 2, leftColor: BABYLON.Color3.White(), rightColor: col.scale(0.35) });
      mat.opacityFresnelParameters = new BABYLON.FresnelParameters({ bias: 0.25, power: 1.6, leftColor: BABYLON.Color3.White(), rightColor: new BABYLON.Color3(0.15, 0.15, 0.15) });
      mat.needDepthPrePass = true;

      const ghostRoot = new BABYLON.TransformNode(`soul_${this.id}`, scene);
      this.visual.computeWorldMatrix(true);
      ghostRoot.position.copyFrom(this.visual.getAbsolutePosition());
      ghostRoot.rotation.y = this.root.rotation.y;
      const hips = this.rig.hips.clone(`soul_${this.id}_hips`, ghostRoot);
      const nodes = [hips, ...hips.getDescendants(false)];
      const rig = { base: ghostRoot, hips };
      Object.keys(this.rig).forEach((k) => {
        const src = this.rig[k];
        if (k === 'base' || k === 'hips' || k === 'sword' || !src || !src.name) return;
        rig[k] = nodes.find((n) => n.name.endsWith('.' + src.name)) || null;
      });
      nodes.forEach((n) => {
        if (!(n instanceof BABYLON.AbstractMesh)) return;
        n.material = mat; n.isPickable = false; n.receiveShadows = false;
        if (n.morphTargetManager) n.morphTargetManager = null;
      });
      rig.capeMesh = null; rig.panelMesh = null;
      const start = withPose(clonePose(this._cur), { gripR: 0, gripL: 0 });
      const float = withPose(standPose(0), { hips: [0, 0.62, 0], chest: [-0.1, 0, 0], head: [-0.35, 0, 0], gripR: 0, gripL: 0,
        footR: [0.07, 0.17, 0.02, 0.9, 0.1], footL: [-0.07, 0.17, 0.0, 0.9, -0.1], handR: [0.3, 0.68, 0.12], handL: [-0.3, 0.68, 0.12],
        thumbR: [0.2, 0.4, 1], thumbL: [-0.2, 0.4, 1], elbowR: [0.6, -1, -0.2], elbowL: [-0.6, -1, -0.2], sit: 0, billow: 0 });
      if (fx && fx.heavenlyLight) fx.heavenlyLight(this.root.position.clone(), this.L.soul, SOUL_MS - 200);
      if (window.ChessSound && ChessSound.playSoul) ChessSound.playSoul();
      const y0 = ghostRoot.position.y;
      this.soulDone = Tween.run(SOUL_MS, (_, raw) => {
        const emerge = smoothstep(0, 0.25, raw);
        this._applyPose(mixPose(start, float, emerge), rig);
        ghostRoot.position.y = y0 + 0.08 * emerge + 3.0 * Math.pow(smoothstep(0.22, 1, raw), 1.5);
        const s = 1 + 0.3 * smoothstep(0.1, 1, raw);
        ghostRoot.scaling.set(s, s, s);
        mat.alpha = 0.55 * smoothstep(0, 0.12, raw) * (1 - smoothstep(0.6, 1, raw));
      }, Ease.linear).then(() => {
        ghostRoot.dispose(false, false);
        mat.dispose();
      });
      return this.soulDone;
    }

    async dissolve() {
      this._releaseSoul();
      const fx = this.ctx.effects, team = Config.TEAM[this.color];
      if (fx && fx.dissolve) fx.dissolve(this.root.position.clone(), team.glow, Config.PIECE_HEIGHT.k);
      const meshes = this._meshes.filter((m) => m.name !== `base_${this.id}`);
      const T = this.parts.throne;
      await Tween.run(1100, (t) => {
        meshes.forEach((m) => { m.visibility = 1 - t; });
        if (T && T.parent === this.visual) T.scaling.set(1 - 0.12 * t, Math.max(0.001, 1 - t), 1 - 0.12 * t);
      }, Ease.inCubic);
    }

    // Victory: the sword raised high over the head, blazing, then planted again.
    async playVictory() {
      this.busy = true;
      const fx = this.ctx.effects, team = Config.TEAM[this.color];
      const cur = clonePose(this._cur);
      const up = withPose(cur, { sword: [0.12, cur.hips[1] + 0.75, cur.hips[2] + 0.06, 0.08, 1, 0.12, 0], gripL: 0,
        handL: [-0.13, cur.hips[1] + 0.05, cur.hips[2] + 0.18], chest: [cur.chest[0] - 0.08, 0, 0], head: [-0.15, 0, 0], elbowR: [1, -0.3, -0.3], glow: 1.6 });
      await this._playKeys([[0, cur], [520, up]]);
      if (fx && fx.sparks) fx.sparks(this.parts.swordTip.getAbsolutePosition(), team.accent);
      if (fx && fx.burst) fx.burst({ pos: this.parts.swordTip.getAbsolutePosition(), color1: '#ffffff', color2: team.glow, count: 40, speed: { min: 0.5, max: 2 }, life: 0.8, size: 0.1 });
      await Tween.wait(900);
      await this._playKeys([[0, clonePose(this._cur)], [650, cur]]);
      this.busy = false;
    }
  }

  window.Chess3D.KingCharacter = KingCharacter;
  // The pose toolkit, for king-fidgets.js.
  KingCharacter.kit = { standPose, sitPose, fightPose, withPose, clonePose, mixPose, flat, unflat, shiftPose, PLANTED, G, LEN, SWORD, STAND_Y, FRONT };
  // Shared with the other plate-armoured characters (pawn): texture painters,
  // gait helpers, rig math and proportions.
  window.Chess3D.KingKit = { embossed, painted, boxBlur, spiral, leaf, vine, vvine, rosette, fleur, hline, ink,
    drawLimb, drawLame, drawMail, footCycle, cruise, orth, rotOf, basis, LEN, NODE, HAND_GRIP };
})();
