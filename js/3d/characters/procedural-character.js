// ProceduralCharacter: builds all 6 piece types out of primitive meshes and
// animates them with code (no external models). See plan §9.3-§9.4.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const CharacterBase = window.Chess3D.CharacterBase;

  function hex(c) { return BABYLON.Color3.FromHexString(c); }

  function makeCanvasTexture(name, w, h, scene, draw) {
    const dt = new BABYLON.DynamicTexture(name, { width: w, height: h }, scene, true);
    draw(dt.getContext(), w, h);
    dt.update();
    // DynamicTexture defaults to CLAMP; tiled stripes need wrapping.
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    return dt;
  }

  // One diagonal stripe period per tile; uScale/vScale set the density.
  function drawStripes(c, w, h, a, b) {
    const img = c.createImageData(w, h);
    const ca = hex(a), cb = hex(b);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const col = ((x / w + y / h) % 1) < 0.5 ? ca : cb;
        const k = (y * w + x) * 4;
        img.data[k] = col.r * 255; img.data[k + 1] = col.g * 255; img.data[k + 2] = col.b * 255; img.data[k + 3] = 255;
      }
    }
    c.putImageData(img, 0, 0);
  }

  // Queen livery after the painted court-queen reference: ivory satin gown
  // with a lace hem, auburn hair and teal jewels; the dark side mirrors it in
  // plum-black satin with raven hair and red jewels. Gold and the cape colour
  // come from the team palette.
  const QUEEN_LIVERY = {
    w: { gown: '#e3e7f0', lace: '#b3bccf', satin: '#e3e7f0', hair: '#7a3420', collar: '#123b30', gem: '#3fd8c8', eye: '#1f4d4a', lips: '#b5635a' },
    b: { gown: '#2e2934', lace: '#756b82', satin: '#34303b', hair: '#1c1512', collar: '#2b0f14', gem: '#ff4a3d', eye: '#2a1a1a', lips: '#8a3a3a' }
  };
  // Silhouette keys. Gown: [y, r] from the waist down to the hem (mermaid —
  // fitted to the knee, then flared). Torso: [rx, rz] every DY from Y0 up to
  // the neck. Cross-sections are ellipses with theta = 0 facing +z.
  const QUEEN_GOWN = [[0.555, 0.061], [0.52, 0.064], [0.47, 0.082], [0.4, 0.08], [0.31, 0.068], [0.22, 0.076],
    [0.15, 0.112], [0.105, 0.165], [0.08, 0.21], [0.072, 0.235]];
  const QUEEN_TORSO = { Y0: 0.52, DY: 0.04, keys: [[0.055, 0.044], [0.057, 0.046], [0.062, 0.05], [0.074, 0.057],
    [0.083, 0.06], [0.097, 0.056], [0.1, 0.05], [0.036, 0.031], [0.019, 0.019]] };

  function smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  // Catmull-Rom sample through a list of equally spaced keys at t in [0, 1].
  function spline(keys, t) {
    const n = keys.length - 1;
    const f = Math.min(n - 1e-6, Math.max(0, t * n)), i = Math.floor(f), s = f - i;
    const k = (j) => keys[Math.max(0, Math.min(n, j))];
    const p0 = k(i - 1), p1 = k(i), p2 = k(i + 1), p3 = k(i + 2);
    return p1.map((_, c) => 0.5 * (2 * p1[c] + (p2[c] - p0[c]) * s
      + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * s * s
      + (3 * p1[c] - p0[c] - 3 * p2[c] + p3[c]) * s * s * s));
  }

  // Parametric surface over a (u, v) grid, v running top to bottom and u in
  // the direction of increasing theta; fn(u, v) -> [x, y, z].
  function gridVertexData(nu, nv, fn) {
    const positions = [], uvs = [], indices = [];
    for (let j = 0; j <= nv; j++) {
      for (let i = 0; i <= nu; i++) {
        positions.push(...fn(i / nu, j / nv));
        uvs.push(i / nu, 1 - j / nv);
      }
    }
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    const normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    const vd = new BABYLON.VertexData();
    vd.positions = positions; vd.indices = indices; vd.normals = normals; vd.uvs = uvs;
    return vd;
  }

  // Torso surface at angle th and height y; `inset` shrinks it (the skin
  // layer showing through the neckline sits just inside the bodice).
  function queenTorsoPoint(th, y, inset) {
    const T = QUEEN_TORSO;
    const [rx, rz] = spline(T.keys, (y - T.Y0) / (T.DY * (T.keys.length - 1)));
    const front = Math.max(0, Math.cos(th));
    const bust = 1 + 0.2 * Math.exp(-Math.pow((y - 0.655) / 0.03, 2)) * front * front;
    const k = inset || 1;
    return [rx * k * Math.sin(th), y, rz * k * bust * Math.cos(th)];
  }

  // Top edge of the bodice: level round the back, a V plunging at the front.
  function queenNeckline(th) {
    return 0.765 - 0.1 * Math.max(0, 1 - Math.abs(th) / 0.5);
  }

  // Gown surface: v = 0 at the waist, 1 at the hem; the lower skirt gathers
  // into folds and trails into a short train behind.
  function queenGownPoint(th, v, lift) {
    const [y, r0] = spline(QUEEN_GOWN, v);
    const lower = smoothstep(0.55, 1, v);
    const back = Math.max(0, -Math.cos(th));
    const r = r0 * (1 + 0.5 * back * back * lower) * (1 + 0.045 * lower * Math.sin(14 * th)) + (lift || 0);
    return [r * Math.sin(th), y, r * (0.8 + 0.2 * v * v) * Math.cos(th)];
  }

  // Cape: hangs from behind the shoulders (u sweeps her right side -> back ->
  // left side), wraps further forward as it falls and pools on the floor.
  function queenCapePoint(u, v, lift) {
    const W = Math.PI * (0.36 + 0.34 * smoothstep(0.3, 1, v));
    const th = Math.PI + (2 * u - 1) * W;
    const e = Math.pow(v, 1.3);
    const back = Math.max(0, -Math.cos(th));
    const rx = 0.114 + 0.2 * e;
    const rz = (0.078 + 0.24 * e) * (1 + 0.35 * back * smoothstep(0.5, 1, v));
    const fold = 1 + 0.07 * v * Math.sin(9 * (th - Math.PI));
    const l = lift || 0;
    return [(rx * fold + l) * Math.sin(th), Math.max(0.074, 0.775 - 0.73 * v), (rz * fold + l) * Math.cos(th)];
  }

  // Gown texture: plain satin at the top, sheer-looking lace (scalloped
  // vines and dots) over the flared lower skirt. v runs waist (top) -> hem.
  function drawGownLace(c, w, h, L) {
    c.fillStyle = L.gown;
    c.fillRect(0, 0, w, h);
    const top = h * 0.6;
    const fade = c.createLinearGradient(0, top - h * 0.08, 0, h);
    fade.addColorStop(0, 'rgba(255,255,255,0)');
    fade.addColorStop(1, 'rgba(255,255,255,0.18)');
    c.fillStyle = fade;
    c.fillRect(0, top - h * 0.08, w, h);
    c.strokeStyle = L.lace; c.fillStyle = L.lace;
    c.lineWidth = 1.5;
    const REPEAT = 28, cell = w / REPEAT;
    for (let i = 0; i < REPEAT; i++) {
      const x = (i + 0.5) * cell;
      for (let row = 0, y = top; y < h - cell * 0.4; row++, y += cell * 0.9) {
        const dx = row % 2 ? cell * 0.5 : 0;
        c.beginPath();                              // vine: an S-curl per cell
        c.arc(x + dx - cell * 0.18, y, cell * 0.2, Math.PI * 0.2, Math.PI * 1.5);
        c.arc(x + dx + cell * 0.18, y + cell * 0.1, cell * 0.2, Math.PI * 1.2, Math.PI * 2.5);
        c.stroke();
        c.beginPath();
        c.arc(x + dx, y + cell * 0.4, cell * 0.06, 0, Math.PI * 2);
        c.fill();
      }
      c.beginPath();                                // scalloped edge along the hem
      c.arc(x, h - cell * 0.2, cell * 0.5, Math.PI, 0);
      c.stroke();
    }
    c.beginPath();                                  // lace border where the flare begins
    c.moveTo(0, top - 2); c.lineTo(w, top - 2);
    c.lineWidth = 3;
    c.stroke();
  }

  // King livery after the storybook-king reference: ivory coat, red velvet
  // cape, spotted ermine, blue hose, brown hair and beard. The dark king wears
  // charcoal under a wine-black cape, with raven hair and a grey beard. Gold
  // comes from the team accent.
  const KING_LIVERY = {
    w: { coat: '#efeadf', cape: '#8e1712', fur: '#f3efe6', spot: '#15130f', hose: '#2e4a7d', hair: '#55301c', beard: '#6a4127',
      eye: '#2a1d17', cheek: '#e3907f', gem: '#ff3b3b', gem2: '#4f8dff' },
    b: { coat: '#2d2931', cape: '#3a0c14', fur: '#c9c2b6', spot: '#0c0b0a', hose: '#1d1c26', hair: '#1f1a17', beard: '#8f8a84',
      eye: '#1e1614', cheek: '#b36e5f', gem: '#ff4a3d', gem2: '#ffb347' }
  };
  // Coat silhouette: [rx, rz] every DY from the hem at Y0 up to the neck —
  // a stout barrel chest and a round belly over the belt (BELT: [bottom, top]).
  const KING_COAT = { Y0: 0.16, DY: 0.06, keys: [[0.13, 0.11], [0.125, 0.105], [0.12, 0.1], [0.117, 0.097], [0.115, 0.096],
    [0.114, 0.099], [0.116, 0.104], [0.118, 0.1], [0.12, 0.092], [0.118, 0.085], [0.098, 0.07], [0.045, 0.04]] };
  const KING_BELT = [0.482, 0.524];

  function kingCoatPoint(th, y, lift) {
    const T = KING_COAT;
    const [rx, rz] = spline(T.keys, (y - T.Y0) / (T.DY * (T.keys.length - 1)));
    const l = lift || 0;
    return [(rx + l) * Math.sin(th), y, (rz + l) * Math.cos(th)];
  }

  // Ermine shoulder cape: a short dome over the shoulders, open in a V that
  // widens toward the front hem; u runs from one front edge round the back.
  function kingMantlePoint(u, v, lift) {
    const gap = 0.22 + 0.36 * v, th = gap + u * (2 * Math.PI - 2 * gap);
    const s = Math.sin(v * Math.PI / 2), l = lift || 0;
    return [(0.055 + 0.11 * s + l) * Math.sin(th), 0.835 - 0.165 * v, (0.048 + 0.076 * s + l) * Math.cos(th)];
  }

  // Cape: hangs from under the shoulder cape, sweeps forward round the sides
  // as it falls and pools on the floor behind (same scheme as the queen's).
  function kingCapePoint(u, v, lift) {
    const W = Math.PI * (0.38 + 0.32 * smoothstep(0.25, 1, v));
    const th = Math.PI + (2 * u - 1) * W;
    const e = Math.pow(v, 1.2), back = Math.max(0, -Math.cos(th));
    const rx = 0.15 + 0.16 * e;
    const rz = (0.09 + 0.2 * e) * (1 + 0.28 * back * smoothstep(0.5, 1, v));
    const fold = 1 + 0.06 * v * Math.sin(9 * (th - Math.PI));
    const l = lift || 0;
    return [(rx * fold + l) * Math.sin(th), Math.max(0.074, 0.72 - 0.68 * v), (rz * fold + l) * Math.cos(th)];
  }

  // Bishop livery after the painted reference: a cream-and-gold mitre and
  // shoulder cape, a black chasuble sewn with gold crosses under a black cope
  // embroidered in crimson, a grey-white alb, white hair and beard. The white
  // bishop swaps to an ivory chasuble under a deep-blue cope. Gold comes from
  // the team accent.
  const BISHOP_LIVERY = {
    w: { chasuble: '#ebe4d3', chasubleLine: '#cfc3a8', cope: '#22386f', embroidery: '#c9a64a', embroideryLight: '#f0dca0',
      lining: '#2c4c9c', alb: '#d8d4cc', cuff: '#22386f', mozzetta: '#ece5d2', mozzettaLine: '#d9cfb4', skin: '#e2b9a0',
      lip: '#b27c6c', eye: '#4d6070', hair: '#ebe8e3', hairMid: '#c9c5bf', hairDark: '#9d978f', jewel: '#3a8fd8', jewel2: '#c8323c' },
    b: { chasuble: '#151317', chasubleLine: '#2c2832', cope: '#1d1519', embroidery: '#a3182c', embroideryLight: '#d24a58',
      lining: '#6e0f1e', alb: '#cdc9c1', cuff: '#151317', mozzetta: '#e6dfcb', mozzettaLine: '#d2c8ad', skin: '#d9ab8f',
      lip: '#a26a5c', eye: '#3f4b56', hair: '#e6e3de', hairMid: '#c2beb8', hairDark: '#948e87', jewel: '#2f86c8', jewel2: '#c42a36' }
  };
  // Alb silhouette: [rx, rz] every DY from the hem at Y0 up to the neck —
  // flared to the floor, narrow at the waist, broad shoulders.
  const BISHOP_ROBE = { Y0: 0.074, DY: 0.0725, keys: [[0.2, 0.175], [0.172, 0.15], [0.15, 0.13], [0.132, 0.113], [0.117, 0.099],
    [0.104, 0.088], [0.094, 0.079], [0.1, 0.08], [0.112, 0.083], [0.118, 0.082], [0.05, 0.045]] };
  // Mitre (head space): band height, height at the sides and at the peaks.
  const BISHOP_MITRE = { base: 0.012, side: 0.14, peak: 0.222, z: -0.006 };
  // Head sculpt, normalised so chin-to-crown is ~1 with the origin between the
  // eyes: [half width, front depth, back depth] every DY from the neck up.
  const BISHOP_HEAD = { Y0: -0.62, DY: 0.095, keys: [[0.2, 0.16, 0.16], [0.22, 0.24, 0.18], [0.27, 0.36, 0.2], [0.3, 0.38, 0.26],
    [0.32, 0.39, 0.34], [0.335, 0.38, 0.4], [0.34, 0.36, 0.44], [0.34, 0.37, 0.46], [0.335, 0.37, 0.46], [0.32, 0.35, 0.43],
    [0.28, 0.3, 0.36], [0.2, 0.2, 0.24], [0, 0, 0]] };

  function smax(a, b, k) { return 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k)); }
  function gauss(dx, dy, sx, sy) { return Math.exp(-(dx * dx) / (sx * sx) - (dy * dy) / (sy * sy)); }

  function bishopRobeRadii(y) {
    const T = BISHOP_ROBE;
    return spline(T.keys, (y - T.Y0) / (T.DY * (T.keys.length - 1)));
  }

  // Alb surface; the lower skirt breaks into folds and trails a little behind.
  function bishopRobePoint(th, y, lift) {
    const [rx, rz] = bishopRobeRadii(y);
    const low = smoothstep(0.4, BISHOP_ROBE.Y0, y), back = Math.max(0, -Math.cos(th));
    const fold = 1 + 0.045 * low * Math.sin(11 * th);
    const l = lift || 0;
    return [(rx * fold + l) * Math.sin(th), y, (rz * fold * (1 + 0.3 * back * low) + l) * Math.cos(th)];
  }

  // Depth of the alb's front at a given x (0 once x is past its side).
  function bishopRobeZ(x, y) {
    const rx = bishopRobeRadii(y)[0];
    return bishopRobePoint(Math.asin(Math.min(1, Math.abs(x) / rx)), y)[2];
  }

  // Chasuble front panel: hangs straight from the chest past the waist and
  // rides out over the flared alb. u runs across, v neck -> hem.
  function bishopChasublePoint(u, v) {
    const y = 0.835 - v * (0.835 - 0.13), w = 0.058 + 0.056 * v, x = (2 * u - 1) * w;
    const hang = smax(bishopRobeZ(x, 0.66), bishopRobeZ(x, y), 0.02) + 0.008;
    const k = smoothstep(0.84, 0.74, y); // eases back onto the chest at the neckline
    return [x, y, 0.045 * Math.cos(x / w * 1.2) * (1 - k) + hang * k];
  }

  // Shoulder cape (mozzetta): a smooth dome over the shoulders, its neckline
  // plunging to a point at the chest, the lower edge level round the arms.
  function bishopMozzettaPoint(th, v, lift) {
    const c = Math.cos(th);
    const yTop = 0.835 - 0.13 * Math.max(0, 1 - Math.abs(th) / 0.6);
    const yBot = 0.69 + 0.012 * Math.pow(Math.max(0, c), 8);
    const y = yTop + v * (yBot - yTop);
    const s = Math.sin(Math.PI / 2 * Math.min(1, Math.max(0, (0.845 - y) / 0.13)));
    const drape = 1 + 0.025 * v * Math.sin(8 * th), l = lift || 0;
    return [((0.056 + 0.09 * s) * drape + l) * Math.sin(th), y, ((0.05 + 0.056 * s) * drape + l) * c];
  }

  // Cope: hangs from under the mozzetta, open wide at the front so the arms
  // come out through it, and pools behind. u sweeps right edge -> back -> left edge.
  function bishopCopePoint(u, v, lift) {
    const edge = 0.85 + 0.4 * smoothstep(0, 0.3, v) - 0.25 * smoothstep(0.4, 1, v);
    const th = Math.PI + (2 * u - 1) * (Math.PI - edge);
    const e = Math.pow(v, 1.1), back = Math.max(0, -Math.cos(th)), shoulder = smoothstep(0.02, 0.17, v);
    const rx = 0.1 + 0.075 * shoulder + 0.07 * e;
    const rz = (0.075 + 0.035 * shoulder + 0.12 * e) * (1 + 0.35 * back * smoothstep(0.5, 1, v));
    const fold = 1 + 0.05 * v * Math.sin(10 * (th - Math.PI)), l = lift || 0;
    return [(rx * fold + l) * Math.sin(th), Math.max(0.074, 0.8 - 0.74 * v), (rz * fold + l) * Math.cos(th)];
  }

  // Mitre (head space): a pointed arch from the front, its sides swelling a
  // little as they rise; front and back panels close together at the top edge.
  function bishopMitrePoint(th, v, lift) {
    const M = BISHOP_MITRE;
    const top = M.side + (M.peak - M.side) * Math.pow(Math.abs(Math.cos(th)), 2.5);
    const rx = 0.047 + 0.022 * v - 0.008 * v * v, rz = 0.06 * (1 - Math.pow(v, 1.8)), l = lift || 0;
    return [(rx + l) * Math.sin(th), M.base + v * (top - M.base), (rz + l) * Math.cos(th) + M.z];
  }

  // Facial relief added to the front of the head at (x, y): brow ridge and
  // furrowed brow, deep-set eyes with bags, a strong nose, cheekbones over
  // hollow cheeks, lips and chin.
  function bishopFaceRelief(x, y) {
    const ax = Math.abs(x);
    const t = Math.min(1, Math.max(0, (0.03 - y) / 0.23));
    let nose = y >= -0.2 ? 0.02 + 0.13 * Math.pow(t, 1.3) : 0.15 * Math.exp(-Math.pow((y + 0.2) / 0.03, 2));
    if (y > 0.03) nose *= Math.exp(-Math.pow((y - 0.03) / 0.03, 2));
    const nw = 0.035 + 0.035 * t;
    return nose * Math.exp(-(x * x) / (nw * nw))
      - 0.07 * gauss(ax - 0.135, y, 0.075, 0.05)
      + 0.04 * gauss(x, y - 0.075, 0.26, 0.035)
      - 0.014 * gauss(ax - 0.03, y - 0.07, 0.018, 0.04)
      + 0.012 * gauss(ax - 0.14, y + 0.075, 0.06, 0.02)
      + 0.035 * gauss(ax - 0.055, y + 0.2, 0.028, 0.03)
      + 0.03 * gauss(ax - 0.2, y + 0.08, 0.07, 0.06)
      - 0.018 * gauss(ax - 0.2, y + 0.26, 0.06, 0.07)
      + 0.025 * gauss(x, y + 0.285, 0.1, 0.025)
      + 0.022 * gauss(x, y + 0.34, 0.08, 0.022)
      - 0.015 * gauss(x, y + 0.31, 0.11, 0.009)
      + 0.04 * gauss(x, y + 0.44, 0.11, 0.06);
  }

  // Head surface at angle th (0 = facing +z) and height y. Cross-sections are
  // superellipses, flatter across the face; `lift` pushes outward.
  function bishopHeadPoint(th, y, lift) {
    const H = BISHOP_HEAD;
    const [w, df, db] = spline(H.keys, (y - H.Y0) / (H.DY * (H.keys.length - 1))).map((k) => Math.max(0, k));
    const s = Math.sin(th), c = Math.cos(th), n = 2 + 0.6 * Math.max(0, c);
    const x = w * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    const z = (c >= 0 ? df : db) * Math.sign(c) * Math.pow(Math.abs(c), 2 / n) + bishopFaceRelief(x, y) * smoothstep(0.05, 0.6, c);
    const l = lift || 0, len = Math.hypot(x, z) || 1;
    return [x + l * x / len, y, z + l * z / len];
  }

  // Depth of the face at (x, y), for seating eyes, brows and moustache.
  function bishopHeadFront(x, y, lift) {
    let lo = 0, hi = Math.PI / 2;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (bishopHeadPoint(mid, y)[0] < Math.abs(x)) lo = mid; else hi = mid;
    }
    return bishopHeadPoint(lo, y, lift)[2];
  }

  // Beard (head space): u sweeps sideburn -> chin -> sideburn, v runs from its
  // top edge to the tip. Full over the jaw, it falls onto the chest in a
  // rounded point, short at the sideburns.
  function bishopBeardPoint(u, v, lift) {
    const th = (2 * u - 1) * 1.5, a = Math.abs(th) / 1.5;
    const yTop = -0.34 + 0.32 * Math.pow(a, 1.2), yBot = -1.08 + 0.53 * Math.pow(a, 1.5);
    const y = yTop + v * (yBot - yTop);
    const t = 0.035 + 0.05 * Math.sin(Math.PI * Math.min(1, v * 1.25)) + (lift || 0);
    const p = bishopHeadPoint(th, Math.max(y, -0.5), t);
    if (y < -0.5) {
      const drop = -0.5 - y;
      p[0] *= 1 - 0.6 * smoothstep(0, 0.58, drop);
      p[2] += drop * 0.45;
    }
    p[1] = y;
    return p;
  }

  // Hair (head space): swept back over the ears below the mitre, longer behind.
  function bishopHairPoint(u, v, lift) {
    const th = 1.05 + u * (2 * Math.PI - 2.1), back = Math.max(0, -Math.cos(th));
    return bishopHeadPoint(th, 0.26 - v * (0.4 + 0.12 * back), 0.025 + 0.02 * v + (lift || 0));
  }

  // --- painted textures ------------------------------------------------------
  // Each draws from a palette P, so the same routine paints the albedo and,
  // with a mask palette, the metallic/roughness map (gold shines, cloth doesn't).
  // kx squeezes motifs horizontally where the texture is stretched round a body.
  function drawCrossFlory(c, x, y, s, P, kx) {
    c.save(); c.translate(x, y); c.scale(kx || 1, 1);
    const shape = (grow, col) => {
      c.fillStyle = col;
      const a = s * 0.13 + grow, L = s * 0.78;
      c.fillRect(-a, -L, 2 * a, 2 * L);
      c.fillRect(-L, -a, 2 * L, 2 * a);
      [[0, -1], [0, 1], [-1, 0], [1, 0]].forEach(([dx, dy]) => {
        [[0, 0.1], [0.2, -0.06], [-0.2, -0.06]].forEach(([k, out]) => {
          c.beginPath();
          c.arc(dx * L - dy * k * s + dx * out * s, dy * L + dx * k * s + dy * out * s, s * 0.15 + grow, 0, Math.PI * 2);
          c.fill();
        });
      });
      c.beginPath(); c.arc(0, 0, s * 0.2 + grow, 0, Math.PI * 2); c.fill();
    };
    shape(s * 0.05, P.goldDark);
    shape(0, P.gold);
    c.strokeStyle = P.goldLight; c.lineWidth = Math.max(1, s * 0.05);
    c.beginPath(); c.moveTo(0, -s * 0.7); c.lineTo(0, s * 0.7); c.moveTo(-s * 0.7, 0); c.lineTo(s * 0.7, 0); c.stroke();
    c.restore();
  }

  function drawBishopGem(c, x, y, r, col, P, kx) {
    c.save(); c.translate(x, y); c.scale(kx || 1, 1);
    c.fillStyle = P.goldDark; c.beginPath(); c.arc(0, 0, r * 1.4, 0, Math.PI * 2); c.fill();
    c.fillStyle = col; c.beginPath(); c.ellipse(0, 0, r, r * 1.2, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = P.shine; c.beginPath(); c.arc(-r * 0.3, -r * 0.4, r * 0.3, 0, Math.PI * 2); c.fill();
    c.restore();
  }

  // Mitre (v runs top edge -> band): damask-figured silk, gold orphreys front
  // and back set with jewels, a jewelled circlet, gold roundels with crosses.
  function drawBishopMitre(c, w, h, P) {
    const kx = 0.55;
    c.fillStyle = P.base; c.fillRect(0, 0, w, h);
    c.strokeStyle = P.line; c.lineWidth = 1.5;
    for (let i = -h; i < w; i += 26) {
      c.beginPath(); c.moveTo(i, h); c.lineTo(i + h * 0.6, 0); c.stroke();
      c.beginPath(); c.moveTo(i, 0); c.lineTo(i + h * 0.6, h); c.stroke();
    }
    const band = (x0, x1, y0, y1) => {
      c.fillStyle = P.gold; c.fillRect(x0, y0, x1 - x0, y1 - y0);
      c.strokeStyle = P.goldDark; c.lineWidth = 3; c.strokeRect(x0 + 2, y0 + 2, x1 - x0 - 4, y1 - y0 - 4);
    };
    const OW = w * 0.03;
    [w * 0.5, 0, w].forEach((x) => {
      band(x - OW, x + OW, 0, h);
      for (let i = 0, y = h * 0.1; y < h * 0.82; i++, y += h * 0.11) drawBishopGem(c, x, y, OW * 0.5, i % 2 ? P.gem1 : P.gem2, P, kx);
    });
    band(0, w, h * 0.86, h);
    for (let i = 0, x = w / 32; x < w; i++, x += w / 16) drawBishopGem(c, x, h * 0.93, h * 0.026, i % 2 ? P.gem1 : P.gem2, P, kx);
    band(0, w, 0, h * 0.03);
    [0.36, 0.64, 0.14, 0.86].forEach((u) => {
      const x = u * w, y = h * 0.5, r = h * 0.1;
      c.save(); c.translate(x, y); c.scale(kx, 1);
      c.fillStyle = P.goldDark; c.beginPath(); c.arc(0, 0, r * 1.12, 0, Math.PI * 2); c.fill();
      c.fillStyle = P.gold; c.beginPath(); c.arc(0, 0, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = P.base; c.beginPath(); c.arc(0, 0, r * 0.8, 0, Math.PI * 2); c.fill();
      c.restore();
      drawCrossFlory(c, x, y, r * 0.62, P, kx);
      drawBishopGem(c, x, y, r * 0.13, P.gem2, P, kx);
    });
  }

  // Chasuble front (u across, v neck -> hem): gold orphreys down both edges
  // and two columns of gold crosses flory on the silk.
  function drawBishopChasuble(c, w, h, P) {
    c.fillStyle = P.base; c.fillRect(0, 0, w, h);
    c.strokeStyle = P.line; c.lineWidth = 1;
    for (let i = 0; i < 160; i++) {
      const x = (i * 97) % w;
      c.beginPath(); c.moveTo(x, 0); c.lineTo(x + ((i * 37) % 7) - 3, h); c.stroke();
    }
    [[0.04, 0.13], [0.87, 0.96]].forEach(([a, b]) => {
      const x0 = a * w, x1 = b * w, m = (x0 + x1) / 2, d = (x1 - x0) * 0.28;
      c.fillStyle = P.gold; c.fillRect(x0, 0, x1 - x0, h);
      c.strokeStyle = P.goldDark; c.lineWidth = 2; c.strokeRect(x0 + 2, -2, x1 - x0 - 4, h + 4);
      c.fillStyle = P.goldDark;
      for (let y = 10; y < h; y += 26) {
        c.beginPath(); c.moveTo(m, y - d); c.lineTo(m + d, y); c.lineTo(m, y + d); c.lineTo(m - d, y); c.closePath(); c.fill();
      }
    });
    for (let r = 0; r < 5; r++) [0.31, 0.69].forEach((u) => drawCrossFlory(c, u * w, h * (0.14 + 0.18 * r), w * 0.1, P));
    c.fillStyle = P.gold; c.fillRect(0, h * 0.975, w, h * 0.025);
  }

  // Cope (u right edge -> back -> left edge, v top -> hem): scrolling
  // embroidery over the cloth, embroidered orphreys down the front edges and
  // round the hem.
  function drawBishopCope(c, w, h, P) {
    c.fillStyle = P.base; c.fillRect(0, 0, w, h);
    c.strokeStyle = P.emb; c.lineWidth = 3; c.lineCap = 'round';
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i < 10; i++) {
        const x = (i + (row % 2) * 0.5) * w / 10 + w * 0.05, y = h * (0.1 + row * 0.19), s = h * 0.05;
        c.beginPath(); c.arc(x - s * 0.5, y, s * 0.5, Math.PI * 0.2, Math.PI * 1.6); c.stroke();
        c.beginPath(); c.arc(x + s * 0.5, y, s * 0.5, Math.PI * 1.2, Math.PI * 2.6); c.stroke();
        c.beginPath(); c.arc(x, y - s * 0.9, s * 0.18, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.moveTo(x, y - s * 0.7); c.lineTo(x, y + s * 0.8); c.stroke();
      }
    }
    const edge = (x0, x1) => {
      const m = (x0 + x1) / 2, s = (x1 - x0) * 0.3;
      c.fillStyle = P.emb; c.fillRect(x0, 0, x1 - x0, h);
      c.strokeStyle = P.gold; c.lineWidth = 2; c.strokeRect(x0 + 3, -2, x1 - x0 - 6, h + 4);
      c.strokeStyle = P.embLight; c.lineWidth = 2.5;
      for (let y = 0; y < h; y += s * 2.4) {
        c.beginPath(); c.arc(m - s * 0.4, y, s, -Math.PI / 2, Math.PI / 2); c.stroke();
        c.beginPath(); c.arc(m + s * 0.4, y + s * 1.2, s, Math.PI / 2, Math.PI * 1.5); c.stroke();
      }
    };
    edge(0, w * 0.06); edge(w * 0.94, w);
    c.fillStyle = P.emb; c.fillRect(0, h * 0.95, w, h * 0.05);
    c.fillStyle = P.gold; c.fillRect(0, h * 0.95, w, 2);
  }

  // Mozzetta (u round the shoulders, v neckline -> lower edge): gold borders
  // and a gold cross flory on each side of the chest and at the back.
  function drawBishopMozzetta(c, w, h, P) {
    const kx = 0.57;
    c.fillStyle = P.base; c.fillRect(0, 0, w, h);
    c.strokeStyle = P.line; c.lineWidth = 1.5;
    for (let x = 0; x < w; x += 9) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + 4, h); c.stroke(); }
    c.fillStyle = P.gold; c.fillRect(0, h * 0.86, w, h * 0.14); c.fillRect(0, 0, w, h * 0.09);
    c.strokeStyle = P.goldDark; c.lineWidth = 2;
    [h * 0.885, h * 0.975, h * 0.02, h * 0.07].forEach((y) => { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); });
    [0.38, 0.62, 0, 1].forEach((u) => drawCrossFlory(c, u * w, h * 0.47, h * 0.27, P, kx));
  }

  // Skull medallion face: a gold skull in relief on a gold boss.
  function drawBishopSkull(c, w, h, P) {
    const g = c.createRadialGradient(w * 0.45, h * 0.4, w * 0.05, w / 2, h / 2, w * 0.5);
    g.addColorStop(0, P.goldLight); g.addColorStop(1, P.goldDark);
    c.fillStyle = g; c.fillRect(0, 0, w, h);
    c.fillStyle = P.bone;
    c.beginPath(); c.ellipse(w * 0.5, h * 0.42, w * 0.25, h * 0.24, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(w * 0.5, h * 0.62, w * 0.17, h * 0.13, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = P.dark;
    [-1, 1].forEach((s) => { c.beginPath(); c.ellipse(w * (0.5 + s * 0.1), h * 0.46, w * 0.075, h * 0.085, s * 0.2, 0, Math.PI * 2); c.fill(); });
    c.beginPath(); c.moveTo(w * 0.5, h * 0.53); c.lineTo(w * 0.46, h * 0.6); c.lineTo(w * 0.54, h * 0.6); c.closePath(); c.fill();
    c.strokeStyle = P.dark; c.lineWidth = 1.5;
    for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(w * (0.5 + i * 0.035), h * 0.64); c.lineTo(w * (0.5 + i * 0.035), h * 0.72); c.stroke(); }
    c.beginPath(); c.moveTo(w * 0.37, h * 0.68); c.lineTo(w * 0.63, h * 0.68); c.stroke();
    c.strokeStyle = P.goldDark; c.lineWidth = w * 0.04;
    c.beginPath(); c.arc(w / 2, h / 2, w * 0.46, 0, Math.PI * 2); c.stroke();
  }

  // Sleeve cuff band (u round the wrist): gold edges, embroidered crosses.
  function drawBishopCuff(c, w, h, P) {
    c.fillStyle = P.base; c.fillRect(0, 0, w, h);
    c.fillStyle = P.gold; c.fillRect(0, 0, w, h * 0.16); c.fillRect(0, h * 0.84, w, h * 0.16);
    c.fillStyle = P.emb;
    for (let i = 0; i < 4; i++) {
      const x = (i + 0.5) * w / 4, y = h / 2, s = h * 0.24;
      c.fillRect(x - s * 0.2, y - s, s * 0.4, s * 2); c.fillRect(x - s, y - s * 0.2, s * 2, s * 0.4);
    }
  }

  // Hair/beard strands on transparent (alpha-tested): a solid underlayer
  // with wavy strands over it that run past it to a ragged fringe.
  function drawBishopStrands(c, w, h, P) {
    c.clearRect(0, 0, w, h);
    c.fillStyle = P.hairDark; c.fillRect(0, 0, w, h * 0.7);
    c.lineCap = 'round';
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * w, y0 = -h * 0.05 + Math.random() * h * 0.2, len = h * (0.55 + 0.45 * Math.random());
      c.strokeStyle = Math.random() < 0.65 ? P.hair : P.hairMid;
      c.lineWidth = 1 + Math.random() * 2;
      c.beginPath(); c.moveTo(x, y0);
      c.bezierCurveTo(x + (Math.random() - 0.5) * 10, y0 + len * 0.33, x + (Math.random() - 0.5) * 14, y0 + len * 0.66,
        x + (Math.random() - 0.5) * 8, y0 + len);
      c.stroke();
    }
  }

  // Scale a surface's UVs so a tiled texture repeats su x sv times over it.
  function tileUVs(vd, su, sv) {
    for (let i = 0; i < vd.uvs.length; i += 2) { vd.uvs[i] *= su; vd.uvs[i + 1] *= sv; }
    return vd;
  }

  // Ermine tile: white fur with two staggered black tail tips.
  function drawErmine(c, w, h, L) {
    c.fillStyle = L.fur;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = 'rgba(0,0,0,0.07)'; c.lineWidth = 2;
    for (let i = 0; i < 40; i++) {                  // soft fur streaks
      const x = (i * 37) % w, y = (i * 53) % h;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 3, y + 10); c.stroke();
    }
    const k = w / 128;
    c.fillStyle = c.strokeStyle = L.spot; c.lineWidth = 2.5 * k;
    [[0.25, 0.25], [0.75, 0.75]].forEach(([fx, fy]) => {
      const x = fx * w, y = fy * h;
      c.beginPath(); c.ellipse(x, y, 5 * k, 9 * k, 0, 0, Math.PI * 2); c.fill();
      [-1, 0, 1].forEach((j) => {
        c.beginPath(); c.moveTo(x + j * 4 * k, y + 6 * k); c.lineTo(x + j * 7 * k, y + 18 * k); c.stroke();
      });
    });
  }

  // Gold trim tile: a ringed boss between diamonds, dark gold on gold.
  function drawTrim(c, w, h, gold, dark) {
    c.fillStyle = gold;
    c.fillRect(0, 0, w, h);
    c.strokeStyle = c.fillStyle = dark; c.lineWidth = w / 16;
    c.beginPath(); c.arc(w / 2, h / 2, w * 0.26, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(w / 2, h / 2, w * 0.08, 0, Math.PI * 2); c.fill();
    const d = w * 0.14;
    [[0, 0], [w, 0], [0, h], [w, h]].forEach(([x, y]) => {
      c.beginPath(); c.moveTo(x, y - d); c.lineTo(x + d, y); c.lineTo(x, y + d); c.lineTo(x - d, y); c.closePath(); c.fill();
    });
  }

  // Rook: a stone keep after the reference tower that breaks apart and
  // reassembles into a hunched stone golem when it moves. The keep stays one
  // merged model for idle play; the golem is a separate rig whose blocks are
  // cut from the same masonry (see _buildRook and _setTowerMorph).
  const ROOK = {
    TILE: 0.272,                 // world size of one masonry tile (4 bricks x 8 courses)
    HEAD_Y: 0.75,                // parapet base in the keep
    BASTION: { w: 0.56, h: 0.21, d: 0.46, y: 0.2, cut: 0.12 },   // cut: |x| where it splits into hips and legs
    SHAFT: { y0: 0.3, y1: 0.75, r0: 0.168, r1: 0.157, wall: 0.07, around: 4, tess: 40, rings: 3, segs: 4 },
    // Golem skeleton (visual space at rest): short pillar legs, a hunched
    // chest on a narrow waist and long arms that nearly reach the board.
    SOLE: 0.07,
    HIP: { x: 0.13, y: 0.44 }, THIGH: 0.19, SHIN: 0.18,   // sole at HIP.y - THIGH - SHIN
    WAIST: 0.05, SHOULDER: { x: 0.3, y: 0.3 }, NECK: { y: 0.37, z: 0.03 },
    UPPER: 0.25, FORE: 0.22,
    STRIDE: 0.5, STEP: 210,      // max sole travel and ms per step
    // Morph timing and stages over m (0 keep .. 1 golem): the mortar cracks
    // open, the blocks lift and fly into place one after another
    // (STAGGER), then the eyes and core ignite and the golem stands.
    MORPH_IN: 860, MORPH_OUT: 760, ROAR: 340,
    STAGE: { crack: 0.2, fly0: 0.12, fly1: 0.86, wake0: 0.72 },
    STAGGER: 0.35
  };

  // Golem poses for _applyPose: hip drop/shift, torso lean/twist/roll, head
  // pitch, arm swing (x, relative to the torso) and splay (z), elbows, and
  // each sole's z offset and lift.
  const ROOK_POSE_ZERO = { hipY: 0, hipZ: 0, lean: 0, twist: 0, roll: 0, headX: 0, armRX: 0, armRZ: 0, armLX: 0, armLZ: 0,
    foreRX: 0, foreLX: 0, footRZ: 0, footRY: 0, footLZ: 0, footLY: 0 };
  const rookPose = (o) => Object.assign({}, ROOK_POSE_ZERO, o);
  const blendPose = (a, b, t) => {
    const o = {};
    Object.keys(ROOK_POSE_ZERO).forEach((k) => { o[k] = a[k] + (b[k] - a[k]) * t; });
    return o;
  };
  const ROOK_POSE = {
    rest: rookPose({ hipY: -0.02, lean: 0.36, headX: -0.3, armRX: -0.5, armLX: -0.5, armRZ: 0.12, armLZ: 0.12, foreRX: -0.28, foreLX: -0.28 }),
    // Squatting low while its blocks gather; it rises as it wakes.
    crouch: rookPose({ hipY: -0.13, lean: 0.8, headX: -0.55, armRX: -0.85, armLX: -0.85, armRZ: 0.3, armLZ: 0.3, foreRX: -0.6, foreLX: -0.6 }),
    roar: rookPose({ hipY: -0.01, lean: -0.12, headX: -0.4, armRX: -0.9, armLX: -0.9, armRZ: 1.0, armLZ: 1.0, foreRX: -1.2, foreLX: -1.2 }),
    windup: rookPose({ hipY: -0.01, hipZ: -0.05, lean: -0.18, headX: -0.25, armRX: -2.7, armLX: -2.7, armRZ: 0.22, armLZ: 0.22,
      foreRX: -0.85, foreLX: -0.85, footLZ: -0.04 }),
    smash: rookPose({ hipY: -0.13, hipZ: 0.1, lean: 0.95, headX: -0.45, armRX: -1.45, armLX: -1.45, armRZ: 0.08, armLZ: 0.08,
      foreRX: -0.3, foreLX: -0.3, footRZ: 0.2, footLZ: -0.05 }),
    cheer: rookPose({ hipY: 0.0, lean: -0.08, headX: -0.45, armRX: -2.75, armLX: -2.75, armRZ: 0.45, armLZ: 0.45, foreRX: -0.35, foreLX: -0.35 })
  };

  const ROOK_LIVERY = {
    w: { brick: '#bcb6ab', warm: '#b59f86', mortar: '#7e7870', trim: '#aba59b', dark: '#4a4640', rock: '#9a8a77', iron: '#3b2f28', moss: '#6f7d48' },
    b: { brick: '#4a4650', warm: '#5a4843', mortar: '#1f1d22', trim: '#55515b', dark: '#18171b', rock: '#3a3332', iron: '#17151a', moss: '#36412c' }
  };

  // Seeded PRNG (mulberry32) so every rook of a team shares its masonry and boulders.
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Smooth value noise over an n x n lattice that wraps every `size` pixels.
  function wrapNoise(rand, n, size) {
    const a = new Float32Array(n * n), sp = size / n;
    for (let i = 0; i < a.length; i++) a[i] = rand();
    const g = (i, j) => a[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
    return (x, y) => {
      const fx = x / sp, fy = y / sp, ix = Math.floor(fx), iy = Math.floor(fy);
      let sx = fx - ix, sy = fy - iy;
      sx = sx * sx * (3 - 2 * sx); sy = sy * sy * (3 - 2 * sy);
      return (g(ix, iy) * (1 - sx) + g(ix + 1, iy) * sx) * (1 - sy) + (g(ix, iy + 1) * (1 - sx) + g(ix + 1, iy + 1) * sx) * sy;
    };
  }

  // Masonry for the rook, drawn once per team: a brick albedo tile with
  // staggered courses of uneven, weathered blocks (some warm-tinted as in the
  // reference), its normal map (bevelled, chipped bricks over sunken mortar),
  // its mortar mask, and a grit tile for the boulders. Every tile wraps both ways.
  const rookMasonryCache = {};
  function rookMasonry(color, L) {
    if (rookMasonryCache[color]) return rookMasonryCache[color];
    const S = 512, ROWS = 8, GAP = 5, BEVEL = 9, rowH = S / ROWS;
    const rand = rng(color === 'w' ? 11 : 23);
    const coarse = wrapNoise(rand, 32, S), fine = wrapNoise(rand, 128, S);
    const rgb = (h) => { const c = hex(h); return [c.r * 255, c.g * 255, c.b * 255]; };
    const base = rgb(L.brick), warm = rgb(L.warm), mortar = rgb(L.mortar);
    const canvas = () => { const cv = document.createElement('canvas'); cv.width = cv.height = S; return cv; };
    const albedo = canvas(), normal = canvas();
    const ac = albedo.getContext('2d'), img = ac.createImageData(S, S), px = img.data;
    const height = new Float32Array(S * S);
    const put = (i, c, k) => { px[i * 4] = c[0] * k; px[i * 4 + 1] = c[1] * k; px[i * 4 + 2] = c[2] * k; px[i * 4 + 3] = 255; };
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) put(y * S + x, mortar, 0.8 + 0.35 * fine(x, y));
    }
    for (let r = 0; r < ROWS; r++) {
      const widths = [];
      let sum = 0;
      while (sum < S) { const w = (S / 4) * (0.65 + 0.7 * rand()); widths.push(w); sum += w; }
      let x0 = rand() * S;
      widths.forEach((w0) => {
        const w = w0 * S / sum, tint = rand() < 0.2 ? 0.35 + 0.4 * rand() : 0.12 * rand(), lum = 0.82 + 0.3 * rand();
        const col = base.map((c, i) => (c + (warm[i] - c) * tint) * lum);
        const ys = r * rowH + GAP / 2, ye = (r + 1) * rowH - GAP / 2, xs = x0 + GAP / 2, xe = x0 + w - GAP / 2;
        for (let y = Math.ceil(ys); y < ye; y++) {
          for (let xx = Math.ceil(xs); xx < xe; xx++) {
            const x = xx % S, n = coarse(x * 2, y * 2);
            const e = Math.min(xx - xs, xe - xx, y - ys, ye - y) + (n - 0.5) * 8;   // chipped edges
            const bevel = smoothstep(0, BEVEL, e);
            if (bevel <= 0) continue;
            const i = y * S + x;
            height[i] = bevel * (0.75 + 0.25 * coarse(x, y)) + 0.06 * fine(x, y);
            put(i, col, (0.8 + 0.2 * bevel) * (0.86 + 0.22 * n + 0.08 * (fine(x, y) - 0.5)));
          }
        }
        x0 += w;
      });
    }
    ac.putImageData(img, 0, 0);
    const nc = normal.getContext('2d'), nimg = nc.createImageData(S, S), nd = nimg.data, K = 3;
    const h = (x, y) => height[((y + S) % S) * S + ((x + S) % S)];
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const nx = (h(x - 1, y) - h(x + 1, y)) * K, ny = (h(x, y + 1) - h(x, y - 1)) * K;
        const l = Math.hypot(nx, ny, 1), i = (y * S + x) * 4;
        nd[i] = (nx / l * 0.5 + 0.5) * 255; nd[i + 1] = (ny / l * 0.5 + 0.5) * 255; nd[i + 2] = (1 / l * 0.5 + 0.5) * 255; nd[i + 3] = 255;
      }
    }
    nc.putImageData(nimg, 0, 0);
    // Mortar mask (white seams, black bricks): the golem's emissive map, so
    // its cracks glow along the courses.
    const mortarMask = canvas(), mc = mortarMask.getContext('2d'), mimg = mc.createImageData(S, S);
    for (let i = 0; i < S * S; i++) {
      const k = 255 * (1 - smoothstep(0, 0.3, height[i])) * (0.65 + 0.35 * fine(i % S, (i / S) | 0));
      mimg.data[i * 4] = mimg.data[i * 4 + 1] = mimg.data[i * 4 + 2] = k; mimg.data[i * 4 + 3] = 255;
    }
    mc.putImageData(mimg, 0, 0);
    const grit = document.createElement('canvas');
    grit.width = grit.height = 128;
    const gc = grit.getContext('2d'), gimg = gc.createImageData(128, 128), rock = rgb(L.rock);
    const gn = wrapNoise(rand, 16, 128), gf = wrapNoise(rand, 64, 128);
    for (let i = 0; i < 128 * 128; i++) {
      const x = i % 128, y = (i / 128) | 0, k = 0.7 + 0.35 * gn(x, y) + 0.25 * (gf(x, y) - 0.5) + (rand() < 0.04 ? 0.15 : 0);
      gimg.data[i * 4] = rock[0] * k; gimg.data[i * 4 + 1] = rock[1] * k; gimg.data[i * 4 + 2] = rock[2] * k; gimg.data[i * 4 + 3] = 255;
    }
    gc.putImageData(gimg, 0, 0);
    return (rookMasonryCache[color] = { albedo, normal, grit, mortar: mortarMask });
  }

  // Chiselled boulder `size` across: an icosphere cut by a few random planes
  // into flat facets, lightly dented. Positions are scaled before the normals
  // are computed so the facets shade correctly without mesh scaling.
  function rockVertexData(seed, size, detail) {
    const vd = BABYLON.CreateIcoSphereVertexData({ radius: 1, subdivisions: detail || 1, flat: true });
    const rand = rng(seed), cuts = [];
    for (let i = 0; i < 6; i++) {
      const z = 2 * rand() - 1, a = 2 * Math.PI * rand(), s = Math.sqrt(1 - z * z);
      cuts.push([s * Math.cos(a), z, s * Math.sin(a), 0.62 + 0.3 * rand()]);
    }
    const p = Array.from(vd.positions);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i], y = p[i + 1], z = p[i + 2];
      let r = 1 + 0.05 * Math.sin(x * 12.9 + y * 7.3 + z * 5.1 + seed);
      cuts.forEach(([nx, ny, nz, o]) => { const d = x * nx + y * ny + z * nz; if (d * r > o) r = o / d; });
      p[i] = x * r * size[0] / 2; p[i + 1] = y * r * size[1] / 2; p[i + 2] = z * r * size[2] / 2;
    }
    const normals = [];
    BABYLON.VertexData.ComputeNormals(p, vd.indices, normals);
    vd.positions = p; vd.normals = normals;
    return vd;
  }

  class ProceduralCharacter extends CharacterBase {
    // --- mesh helpers ----------------------------------------------------
    _add(mesh, parent, mat) {
      mesh.material = mat;
      mesh.parent = parent;
      mesh.receiveShadows = true;
      this._registerMesh(mesh);
      return mesh;
    }

    // Helpers shared by the parametric builders (queen, king). Everything
    // they create is registered on this character; scroll curls are gold.
    _kit() {
      const scene = this.scene, id = this.id, gold = this.mats.accent;
      const MB = BABYLON.MeshBuilder;
      const V3 = (x, y, z) => new BABYLON.Vector3(x, y, z);
      const P3 = (p) => new BABYLON.Vector3(p[0], p[1], p[2]);
      const pbr = (name, color, metallic, roughness) => {
        const mat = new BABYLON.PBRMaterial(`${name}_${id}`, scene);
        mat.albedoColor = hex(color); mat.metallic = metallic; mat.roughness = roughness; mat.maxSimultaneousLights = 8;
        this.materials.push(mat);
        return mat;
      };
      const surface = (name, vd, mat, parent) => {
        const mesh = new BABYLON.Mesh(`${name}_${id}`, scene);
        vd.applyToMesh(mesh);
        return this._add(mesh, parent, mat);
      };
      const tube = (name, path, radius, mat, parent, taper) => this._add(MB.CreateTube(`${name}_${id}`, {
        path, tessellation: 8, cap: BABYLON.Mesh.CAP_ALL,
        radiusFunction: (i) => radius * (1 - (taper || 0) * i / (path.length - 1))
      }, scene), parent, mat);
      // Cylinder spanning two points (MeshBuilder cylinders are built along +Y).
      const limb = (name, a, b, dA, dB, mat, parent) => {
        const dir = b.subtract(a);
        const mesh = MB.CreateCylinder(`${name}_${id}`, { height: dir.length(), diameterBottom: dA, diameterTop: dB, tessellation: 12 }, scene);
        mesh.position = a.add(b).scale(0.5);
        dir.normalize();
        const axis = BABYLON.Vector3.Cross(BABYLON.Vector3.Up(), dir);
        const angle = Math.acos(Math.min(1, Math.max(-1, dir.y)));
        mesh.rotationQuaternion = axis.lengthSquared() < 1e-10
          ? BABYLON.Quaternion.Identity()
          : BABYLON.Quaternion.RotationAxis(axis.normalize(), angle);
        return this._add(mesh, parent, mat);
      };
      const ball = (name, p, d, mat, parent, sc) => {
        const mesh = MB.CreateSphere(`${name}_${id}`, { diameter: d, segments: 10 }, scene);
        mesh.position = p;
        if (sc) mesh.scaling.set(sc[0], sc[1], sc[2]);
        return this._add(mesh, parent, mat);
      };
      // Filigree curl: a spiral in the plane of ax/ay around c, starting
      // `size` out at angle `phase` (default: below c) and winding inward.
      const scroll = (name, c, ax, ay, size, turns, radius, parent, phase) => {
        const a0 = phase === undefined ? -Math.PI / 2 : phase, path = [];
        for (let i = 0; i <= 20; i++) {
          const t = i / 20, a = a0 + t * turns * Math.PI * 2, r = size * (1 - 0.8 * t);
          path.push(c.add(ax.scale(Math.cos(a) * r)).add(ay.scale(Math.sin(a) * r)));
        }
        return tube(name, path, radius, gold, parent, 0.6);
      };
      const ring = (fn, n) => {
        const path = [];
        for (let i = 0; i <= n; i++) path.push(P3(fn(Math.PI * (2 * i / n - 1))));
        return path;
      };
      const UP = V3(0, 1, 0);
      return { V3, P3, UP, pbr, surface, tube, limb, ball, scroll, ring };
    }

    _makeMats(team) {
      const scene = this.scene;
      const id = this.id;
      const armor = new BABYLON.PBRMaterial(`armor_${id}`, scene);
      armor.albedoColor = hex(team.armor); armor.metallic = 0.85; armor.roughness = 0.3; armor.maxSimultaneousLights = 8;
      const cloth = new BABYLON.PBRMaterial(`cloth_${id}`, scene);
      cloth.albedoColor = hex(team.cloth); cloth.metallic = 0; cloth.roughness = 0.8; cloth.maxSimultaneousLights = 8;
      const accent = new BABYLON.PBRMaterial(`accent_${id}`, scene);
      accent.albedoColor = hex(team.accent); accent.metallic = 1; accent.roughness = 0.25; accent.maxSimultaneousLights = 8;
      const skin = new BABYLON.PBRMaterial(`skin_${id}`, scene);
      skin.albedoColor = hex(team.skin); skin.metallic = 0; skin.roughness = 0.6; skin.maxSimultaneousLights = 8;
      const stone = new BABYLON.PBRMaterial(`stone_${id}`, scene);
      stone.albedoColor = hex(team.stone); stone.metallic = 0; stone.roughness = 0.9; stone.maxSimultaneousLights = 8;
      const magic = new BABYLON.StandardMaterial(`magic_${id}`, scene);
      magic.emissiveColor = hex(team.glow); magic.disableLighting = true; magic.diffuseColor = BABYLON.Color3.Black();
      // Deviation: plan's material table doesn't list a wood tone; needed for
      // spears/staves. Simplest addition that keeps the described look.
      const wood = new BABYLON.PBRMaterial(`wood_${id}`, scene);
      wood.albedoColor = hex('#6b4a2b'); wood.metallic = 0; wood.roughness = 0.8;
      const mats = { armor, cloth, accent, skin, stone, magic, wood };
      this.materials.push(armor, cloth, accent, skin, stone, magic, wood);
      return mats;
    }

    async build() {
      const team = Config.TEAM[this.color];
      this.mats = this._makeMats(team);
      this.parts = {};
      this.buildTeamBase(team);
      const builders = {
        p: this._buildSoldier, n: this._buildKnight, b: this._buildBishop,
        r: this._buildRook, q: this._buildQueen, k: this._buildKing
      };
      (builders[this.type] || this._buildSoldier).call(this, team);
      this._savePose();
      // Merge same-material siblings under each rigid pivot to cut draw calls
      // (plan §9 FPS criterion: apply if FPS < 50 at high quality).
      const P = this.parts;
      this.optimizeStaticMeshes([this.root, P.torso, P.head, P.armR, P.armL, P.weapon, P.foreR, P.foreL, P.legR, P.legL, P.shield,
        ...(P.extraPivots || [])]);
      if (this.type === 'r') {
        // Fold the rook into its keep, and compile the golem's shaders now:
        // the rig is hidden until the first move, and blocks whose shaders
        // are still compiling would be missing from its first frames.
        this._setTowerMorph(0);
        this._skinGolem();
        this._golemRoot.getChildMeshes(false).forEach((mesh) => mesh.material && mesh.material.forceCompilation(mesh));
      }
    }

    // Rook: measure the giant's limbs at full size; folded away they would
    // read as specks and lose their shadows for good.
    applyRenderBudget(quality) {
      if (this.type !== 'r') return super.applyRenderBudget(quality);
      this._setTowerMorph(1);
      super.applyRenderBudget(quality);
      this._setTowerMorph(0);
    }

    _savePose() {
      this._pose = {
        torso: this.parts.torso ? this.parts.torso.rotation.clone() : null,
        armR: this.parts.armR ? this.parts.armR.rotation.clone() : null,
        armL: this.parts.armL ? this.parts.armL.rotation.clone() : null,
        weapon: this.parts.weapon ? this.parts.weapon.rotation.clone() : null
      };
    }

    // Rook: walks as the stone giant (see _rookMoveTo).
    async moveTo(pos, style, opts) {
      if (this.type === 'r') return this._rookMoveTo(pos, opts);
      return super.moveTo(pos, style, opts);
    }

    // --- builders ----------------------------------------------------------
    // Pawn: a full-plate foot knight modelled after a classic armoured-knight
    // statuette — close helm with a pointed visor, layered pauldrons, mail
    // skirt under tassets, articulated legs, a sword held low and a heater
    // shield on the left arm.
    _buildSoldier(team) {
      const scene = this.scene, m = this.mats, id = this.id;
      const MB = BABYLON.MeshBuilder;

      const mail = new BABYLON.PBRMaterial(`mail_${id}`, scene);
      mail.albedoColor = hex(team.armor).scale(0.62); mail.metallic = 0.9; mail.roughness = 0.6; mail.maxSimultaneousLights = 8;
      const slit = new BABYLON.PBRMaterial(`slit_${id}`, scene);
      slit.albedoColor = hex('#08080a'); slit.metallic = 0; slit.roughness = 1;
      const shieldMat = new BABYLON.PBRMaterial(`shieldFace_${id}`, scene);
      shieldMat.albedoColor = hex(team.cloth); shieldMat.metallic = 0.3; shieldMat.roughness = 0.55; shieldMat.maxSimultaneousLights = 8;
      shieldMat.backFaceCulling = false; shieldMat.twoSidedLighting = true;
      this.materials.push(mail, slit, shieldMat);

      const torso = new BABYLON.TransformNode(`torso_${id}`, scene);
      torso.parent = this.visual;
      this.parts.torso = torso;

      // --- legs (own pivots so the walk cycle can swing them) ---
      const makeLeg = (side) => {
        const leg = new BABYLON.TransformNode(`leg${side}_${id}`, scene);
        leg.parent = this.visual;
        leg.position.set(side === 'R' ? 0.055 : -0.055, 0.33, 0);
        const thigh = MB.CreateCylinder(`thigh${side}_${id}`, { diameterTop: 0.08, diameterBottom: 0.068, height: 0.1, tessellation: 16 }, scene);
        thigh.position.y = -0.05;
        this._add(thigh, leg, m.armor);
        const knee = MB.CreateSphere(`knee${side}_${id}`, { diameter: 0.072, segments: 10 }, scene);
        knee.position.set(0, -0.1, 0.008);
        knee.scaling.set(1, 0.85, 1.15);
        this._add(knee, leg, m.armor);
        const kneeBand = MB.CreateTorus(`kneeBand${side}_${id}`, { diameter: 0.066, thickness: 0.01, tessellation: 16 }, scene);
        kneeBand.position.y = -0.125;
        this._add(kneeBand, leg, m.accent);
        const greave = MB.CreateCylinder(`greave${side}_${id}`, { diameterTop: 0.066, diameterBottom: 0.056, height: 0.12, tessellation: 16 }, scene);
        greave.position.y = -0.19;
        this._add(greave, leg, m.armor);
        const sabaton = MB.CreateBox(`sabaton${side}_${id}`, { width: 0.064, height: 0.032, depth: 0.1 }, scene);
        sabaton.position.set(0, -0.246, 0.018);
        this._add(sabaton, leg, m.armor);
        const toe = MB.CreateSphere(`toe${side}_${id}`, { diameter: 0.064, segments: 8 }, scene);
        toe.position.set(0, -0.252, 0.066);
        toe.scaling.set(1, 0.45, 0.9);
        this._add(toe, leg, m.armor);
        return leg;
      };
      this.parts.legR = makeLeg('R');
      this.parts.legL = makeLeg('L');

      // --- hips: mail skirt, tassets, belt, fauld ---
      const skirt = MB.CreateCylinder(`skirt_${id}`, { diameterTop: 0.2, diameterBottom: 0.225, height: 0.09, tessellation: 24 }, scene);
      skirt.position.y = 0.305; skirt.scaling.z = 0.8;
      this._add(skirt, torso, mail);
      [-1, 1].forEach((s) => {
        const tasset = MB.CreateBox(`tasset_${id}_${s}`, { width: 0.085, height: 0.075, depth: 0.012 }, scene);
        tasset.position.set(s * 0.052, 0.318, 0.094);
        tasset.rotation.set(-0.18, s * 0.25, 0);
        this._add(tasset, torso, m.armor);
      });
      [0.372, 0.398].forEach((y, i) => {
        const lame = MB.CreateCylinder(`fauld_${id}_${i}`, { diameterTop: 0.2 - i * 0.01, diameterBottom: 0.215 - i * 0.01, height: 0.028, tessellation: 24 }, scene);
        lame.position.y = y; lame.scaling.z = 0.8;
        this._add(lame, torso, m.armor);
      });
      const belt = MB.CreateTorus(`belt_${id}`, { diameter: 0.214, thickness: 0.016, tessellation: 24 }, scene);
      belt.position.y = 0.356; belt.scaling.z = 0.8;
      this._add(belt, torso, m.wood);
      const buckle = MB.CreateBox(`buckle_${id}`, { width: 0.03, height: 0.024, depth: 0.012 }, scene);
      buckle.position.set(0.02, 0.356, 0.088);
      this._add(buckle, torso, m.accent);

      // --- breastplate, gorget, pauldrons ---
      const cuirass = MB.CreateCylinder(`cuirass_${id}`, { diameterTop: 0.25, diameterBottom: 0.19, height: 0.17, tessellation: 24 }, scene);
      cuirass.position.y = 0.48; cuirass.scaling.z = 0.74;
      this._add(cuirass, torso, m.armor);
      const chest = MB.CreateSphere(`chest_${id}`, { diameter: 0.22, segments: 16 }, scene);
      chest.position.set(0, 0.49, 0.012);
      chest.scaling.set(1, 0.78, 0.72);
      this._add(chest, torso, m.armor);
      const ridge = MB.CreateBox(`ridge_${id}`, { width: 0.012, height: 0.13, depth: 0.012 }, scene);
      ridge.position.set(0, 0.47, 0.088);
      ridge.rotation.x = -0.12;
      this._add(ridge, torso, m.armor);
      const gorget = MB.CreateCylinder(`gorget_${id}`, { diameterTop: 0.1, diameterBottom: 0.15, height: 0.05, tessellation: 20 }, scene);
      gorget.position.y = 0.585;
      this._add(gorget, torso, m.armor);
      [-1, 1].forEach((s) => {
        const pauldron = MB.CreateSphere(`pauldron_${id}_${s}`, { diameter: 0.15, slice: 0.5, segments: 14, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        pauldron.position.set(s * 0.15, 0.535, 0);
        pauldron.scaling.set(1, 0.8, 1.05);
        pauldron.rotation.z = -s * 0.4;
        this._add(pauldron, torso, m.armor);
        const lame = MB.CreateSphere(`pauldronLame_${id}_${s}`, { diameter: 0.13, slice: 0.5, segments: 12, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        lame.position.set(s * 0.175, 0.5, 0);
        lame.scaling.set(1, 0.7, 1);
        lame.rotation.z = -s * 0.75;
        this._add(lame, torso, m.armor);
        const rivet = MB.CreateSphere(`rivet_${id}_${s}`, { diameter: 0.018, segments: 6 }, scene);
        rivet.position.set(s * 0.13, 0.585, 0.04);
        this._add(rivet, torso, m.accent);
      });

      // --- close helm with pointed visor ---
      const head = new BABYLON.TransformNode(`head_${id}`, scene);
      head.parent = torso; head.position.y = 0.655;
      this.parts.head = head;
      const helm = MB.CreateSphere(`helm_${id}`, { diameter: 0.16, segments: 16 }, scene);
      helm.position.y = 0.01;
      helm.scaling.set(0.95, 1.08, 1);
      this._add(helm, head, m.armor);
      const visor = MB.CreateCylinder(`visor_${id}`, { diameterTop: 0.03, diameterBottom: 0.14, height: 0.075, tessellation: 16 }, scene);
      visor.rotation.x = Math.PI / 2;
      visor.position.set(0, -0.005, 0.068);
      visor.scaling.set(0.92, 1, 0.85);
      this._add(visor, head, m.armor);
      const eyeSlit = MB.CreateBox(`eyeSlit_${id}`, { width: 0.1, height: 0.012, depth: 0.05 }, scene);
      eyeSlit.position.set(0, 0.022, 0.066);
      this._add(eyeSlit, head, slit);
      const comb = MB.CreateBox(`comb_${id}`, { width: 0.012, height: 0.03, depth: 0.15 }, scene);
      comb.position.set(0, 0.086, -0.005);
      this._add(comb, head, m.armor);
      const helmRim = MB.CreateTorus(`helmRim_${id}`, { diameter: 0.145, thickness: 0.014, tessellation: 20 }, scene);
      helmRim.position.y = -0.058;
      this._add(helmRim, head, m.armor);
      [-1, 1].forEach((s) => {
        const pivot = MB.CreateSphere(`visorPivot_${id}_${s}`, { diameter: 0.022, segments: 6 }, scene);
        pivot.position.set(s * 0.075, 0.012, 0.012);
        this._add(pivot, head, m.accent);
      });

      // Arm = shoulder pivot (animated) + a fixed-bent forearm node, so the
      // rest pose keeps a bent elbow while playAttack/walk only touch armR/armL.
      const makeArm = (side) => {
        const s = side === 'R' ? 1 : -1;
        const arm = new BABYLON.TransformNode(`arm${side}_${id}`, scene);
        arm.parent = torso; arm.position.set(s * 0.155, 0.53, 0);
        const upper = MB.CreateCapsule(`upperArm${side}_${id}`, { height: 0.14, radius: 0.032 }, scene);
        upper.position.y = -0.07;
        this._add(upper, arm, m.armor);
        const elbow = MB.CreateSphere(`couter${side}_${id}`, { diameter: 0.058, segments: 8 }, scene);
        elbow.position.set(0, -0.14, -0.006);
        this._add(elbow, arm, m.armor);
        const fore = new BABYLON.TransformNode(`fore${side}_${id}`, scene);
        fore.parent = arm; fore.position.y = -0.14;
        const brace = MB.CreateCylinder(`vambrace${side}_${id}`, { diameterTop: 0.056, diameterBottom: 0.05, height: 0.1, tessellation: 12 }, scene);
        brace.position.y = -0.055;
        this._add(brace, fore, m.armor);
        const cuff = MB.CreateCylinder(`cuff${side}_${id}`, { diameterTop: 0.058, diameterBottom: 0.078, height: 0.035, tessellation: 12 }, scene);
        cuff.position.y = -0.11;
        this._add(cuff, fore, m.armor);
        const fist = MB.CreateSphere(`gauntlet${side}_${id}`, { diameter: 0.058, segments: 8 }, scene);
        fist.position.y = -0.145;
        fist.scaling.set(0.9, 1.1, 1);
        this._add(fist, fore, m.armor);
        return { arm, fore };
      };

      const right = makeArm('R');
      this.parts.armR = right.arm;
      this.parts.foreR = right.fore;
      right.fore.rotation.set(-0.7, 0, 0.1);
      // Sword gripped in the right gauntlet, blade angled down and forward.
      const weapon = new BABYLON.TransformNode(`weapon_${id}`, scene);
      weapon.parent = right.fore; weapon.position.y = -0.145;
      weapon.rotation.x = Math.PI - 0.2;
      this.parts.weapon = weapon;
      const pommel = MB.CreateSphere(`pommel_${id}`, { diameter: 0.03, segments: 8 }, scene);
      pommel.position.y = -0.055;
      this._add(pommel, weapon, m.accent);
      const grip = MB.CreateCylinder(`grip_${id}`, { diameter: 0.02, height: 0.08, tessellation: 8 }, scene);
      grip.position.y = -0.01;
      this._add(grip, weapon, m.wood);
      const guard = MB.CreateBox(`guard_${id}`, { width: 0.11, height: 0.016, depth: 0.018 }, scene);
      guard.position.y = 0.035;
      this._add(guard, weapon, m.accent);
      const blade = MB.CreateBox(`blade_${id}`, { width: 0.03, height: 0.22, depth: 0.008 }, scene);
      blade.position.y = 0.153;
      this._add(blade, weapon, m.armor);
      const bladeTip = MB.CreateCylinder(`bladeTip_${id}`, { diameterTop: 0, diameterBottom: 0.03, height: 0.04, tessellation: 4 }, scene);
      bladeTip.position.y = 0.283;
      bladeTip.rotation.y = Math.PI / 4;
      bladeTip.scaling.z = 0.25;
      this._add(bladeTip, weapon, m.armor);

      const left = makeArm('L');
      this.parts.armL = left.arm;
      this.parts.foreL = left.fore;
      left.fore.rotation.set(-0.75, 0, -0.1);
      this._buildHeaterShield(left.arm, shieldMat);
    }

    // Heater shield (flat top, curved sides meeting in a point), slightly
    // convex, with a rim and a cross (gold by default) — built as custom
    // geometry since MeshBuilder has no such primitive and CreatePolygon needs
    // earcut. opts: { position, rotation, scale, rimMat, crossMat, boss }.
    _buildHeaterShield(parent, faceMat, opts) {
      const scene = this.scene, m = this.mats, id = this.id;
      opts = opts || {};
      const rimMat = opts.rimMat || m.accent;
      const crossMat = opts.crossMat || m.accent;
      const pos = opts.position || [-0.04, -0.19, 0.14];
      const rot = opts.rotation || [0.06, -0.38, 0.05];
      const W = 0.1, TOP = 0.11, BOT = -0.16, T = 0.012, BULGE = 1.6;
      const bez = (p0, c, p1, t) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * c + t * t * p1;
      const outline = [];
      const N = 14;
      for (let i = 0; i <= N; i++) { // left side, top -> point
        const t = i / N;
        outline.push([bez(-W, -W, 0, t), bez(TOP, BOT + 0.12, BOT, t)]);
      }
      for (let i = 1; i <= N; i++) { // right side, point -> top
        const t = i / N;
        outline.push([bez(0, W, W, t), bez(BOT, BOT + 0.12, TOP, t)]);
      }
      const z = (x) => -BULGE * x * x;

      // Planar UVs keep it mergeable with other same-material meshes (MergeMeshes
      // needs matching vertex attributes).
      const positions = [], indices = [], uvs = [];
      const pushV = (x, y, zz) => {
        positions.push(x, y, zz); uvs.push(x / (2 * W) + 0.5, (y - BOT) / (TOP - BOT));
        return positions.length / 3 - 1;
      };
      [T / 2, -T / 2].forEach((off, face) => {
        const c = pushV(0, 0, off);
        const ring = outline.map(([x, y]) => pushV(x, y, z(x) + off));
        for (let i = 0; i < ring.length; i++) {
          const a = ring[i], b = ring[(i + 1) % ring.length];
          if (face === 0) indices.push(c, b, a); else indices.push(c, a, b);
        }
      });
      for (let i = 0; i < outline.length; i++) { // edge band
        const [x0, y0] = outline[i], [x1, y1] = outline[(i + 1) % outline.length];
        const a = pushV(x0, y0, z(x0) + T / 2), b = pushV(x1, y1, z(x1) + T / 2);
        const c = pushV(x1, y1, z(x1) - T / 2), d = pushV(x0, y0, z(x0) - T / 2);
        indices.push(a, b, c, a, c, d);
      }
      const normals = [];
      BABYLON.VertexData.ComputeNormals(positions, indices, normals);
      const vd = new BABYLON.VertexData();
      vd.positions = positions; vd.indices = indices; vd.normals = normals; vd.uvs = uvs;
      const shield = new BABYLON.Mesh(`shield_${id}`, scene);
      vd.applyToMesh(shield);
      shield.position.set(pos[0], pos[1], pos[2]);
      shield.rotation.set(rot[0], rot[1], rot[2]);
      if (opts.scale) shield.scaling.setAll(opts.scale);
      this._add(shield, parent, faceMat);
      this.parts.shield = shield;

      const front = (x, y, lift) => new BABYLON.Vector3(x, y, z(x) + T / 2 + lift);
      const rimPath = outline.map(([x, y]) => front(x * 0.97, y * 0.97, 0.002));
      rimPath.push(rimPath[0].clone());
      const rim = BABYLON.MeshBuilder.CreateTube(`shieldRim_${id}`, { path: rimPath, radius: 0.0075, tessellation: 6 }, scene);
      rim.parent = shield;
      this._add(rim, shield, rimMat);
      const crossV = BABYLON.MeshBuilder.CreateBox(`crossV_${id}`, { width: 0.02, height: 0.19, depth: 0.008 }, scene);
      crossV.position.set(0, -0.015, T / 2 + 0.004);
      this._add(crossV, shield, crossMat);
      const crossH = BABYLON.MeshBuilder.CreateBox(`crossH_${id}`, { width: 0.13, height: 0.02, depth: 0.008 }, scene);
      crossH.position.set(0, 0.04, T / 2 + 0.002 - BULGE * 0.002);
      this._add(crossH, shield, crossMat);
      if (opts.boss === false) return;
      const boss = BABYLON.MeshBuilder.CreateSphere(`boss_${id}`, { diameter: 0.036, segments: 8 }, scene);
      boss.position.set(0, 0.04, T / 2 + 0.006);
      boss.scaling.z = 0.5;
      this._add(boss, shield, m.accent);
    }

    // Bishop: an old prelate after the painted reference, built from smooth
    // surfaces rather than stacked primitives. A sculpted face (brow ridge,
    // deep-set eyes under heavy lids, strong nose, hollow cheeks) with a full
    // white beard, moustache, bushy brows and swept-back hair; a jewelled
    // mitre with a gold halo behind it; a cream mozzetta with gold crosses
    // over a black cope embroidered in crimson; a black chasuble sewn with
    // gold crosses over a grey-white alb; skull medallions on a chain; gold
    // coins in his right hand and a gold crozier with a skull in its crook in
    // his left. Ornament is painted into textures (with a matching
    // metallic/roughness map), so gold reads as gold without extra lumps.
    _buildBishop(team) {
      const scene = this.scene, m = this.mats, id = this.id;
      const MB = BABYLON.MeshBuilder, Vec = BABYLON.Vector3, C3 = BABYLON.Color3;
      const { V3, P3, pbr, surface, tube, limb, ball } = this._kit();
      const L = BISHOP_LIVERY[this.color] || BISHOP_LIVERY.w;
      const gold = m.accent;
      const line = (fn, n) => {
        const path = [];
        for (let i = 0; i <= n; i++) path.push(P3(fn(i / n)));
        return path;
      };
      const twoSided = (mat) => { mat.backFaceCulling = false; mat.twoSidedLighting = true; return mat; };
      // Smooth tube with an arbitrary radius profile r(t), t in [0, 1].
      const ftube = (name, pts, r, mat, parent, smooth) => {
        const path = smooth ? BABYLON.Curve3.CreateCatmullRomSpline(pts, smooth, false).getPoints() : pts;
        const n = path.length - 1;
        return this._add(MB.CreateTube(`${name}_${id}`, { path, tessellation: 12, cap: BABYLON.Mesh.CAP_ALL,
          radiusFunction: (i) => r(i / n) }, scene), parent, mat);
      };
      // Flat ribbon along `path`, `width(t)` wide to one side (sgn) in the
      // plane facing `normal`, its middle bulged toward it.
      const blade = (name, path, width, sgn, normal, mat, parent, bulge) => {
        const n = path.length - 1, A = [], M = [], B = [];
        path.forEach((p, i) => {
          const tng = path[Math.min(n, i + 1)].subtract(path[Math.max(0, i - 1)]).normalize();
          const side = Vec.Cross(tng, normal).normalize().scale(sgn * width(i / n));
          A.push(p); M.push(p.add(side.scale(0.5)).add(normal.scale(bulge || 0.003))); B.push(p.add(side));
        });
        return this._add(MB.CreateRibbon(`${name}_${id}`, { pathArray: [A, M, B], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene), parent, mat);
      };
      // Tube swept along a smooth path with a free cross-section r(t, a),
      // a = angle round the path from its downward side (lets sleeves sag).
      const sweep = (name, pts, radius, mat, parent, range, nu) => {
        const path = BABYLON.Curve3.CreateCatmullRomSpline(pts, 10, false).getPoints();
        const n = path.length - 1, N = [], B = [];
        path.forEach((p, i) => {
          const t = path[Math.min(n, i + 1)].subtract(path[Math.max(0, i - 1)]).normalize();
          let d = V3(0, -1, 0).add(t.scale(t.y));
          if (d.lengthSquared() < 1e-6) d = V3(0, 0, 1);
          d.normalize();
          N.push(d); B.push(Vec.Cross(t, d));
        });
        const at = (arr, f) => { const i = Math.min(n - 1, Math.floor(f)); return Vec.Lerp(arr[i], arr[i + 1], f - i); };
        const [t0, t1] = range || [0, 1];
        return surface(name, gridVertexData(nu || 18, Math.max(2, Math.round(n * (t1 - t0))), (u, v) => {
          const t = t0 + (t1 - t0) * v, f = t * n, a = u * Math.PI * 2, r = radius(t, a);
          const p = at(path, f).add(at(N, f).scale(Math.cos(a) * r)).add(at(B, f).scale(Math.sin(a) * r));
          return [p.x, p.y, p.z];
        }), mat, parent);
      };
      // Rotate v about unit axis k by ang (Rodrigues).
      const rot = (v, k, ang) => v.scale(Math.cos(ang)).add(Vec.Cross(k, v).scale(Math.sin(ang)))
        .add(k.scale(Vec.Dot(k, v) * (1 - Math.cos(ang))));

      // --- materials: painted cloth with matching metallic/roughness maps ---
      const GD = hex(team.accent).scale(0.55).toHexString(), GL = C3.Lerp(hex(team.accent), C3.White(), 0.45).toHexString();
      const pal = (base, line, extra) => Object.assign({ base, line, gold: team.accent, goldDark: GD, goldLight: GL,
        gem1: L.jewel, gem2: L.jewel2, shine: '#ffffff', emb: L.embroidery, embLight: L.embroideryLight, bone: GL, dark: '#1c1411' }, extra);
      const MASK_METAL = 'rgb(0,90,255)', MASK_CLOTH = 'rgb(0,215,0)', MASK_GEM = 'rgb(0,40,0)';
      const maskPal = { base: MASK_CLOTH, line: MASK_CLOTH, gold: MASK_METAL, goldDark: MASK_METAL, goldLight: MASK_METAL,
        gem1: MASK_GEM, gem2: MASK_GEM, shine: MASK_GEM, emb: MASK_CLOTH, embLight: MASK_CLOTH, bone: MASK_METAL, dark: MASK_CLOTH };
      const painted = (name, w, h, draw, P) => {
        const mat = twoSided(pbr(name, '#ffffff', 1, 1));
        mat.albedoTexture = makeCanvasTexture(`${name}Tex_${id}`, w, h, scene, (c) => draw(c, w, h, P));
        mat.metallicTexture = makeCanvasTexture(`${name}Mask_${id}`, w / 2, h / 2, scene, (c) => draw(c, w / 2, h / 2, maskPal));
        mat.useRoughnessFromMetallicTextureGreen = true;
        mat.useMetallnessFromMetallicTextureBlue = true;
        mat.useRoughnessFromMetallicTextureAlpha = false;
        return mat;
      };
      const mitreMat = painted('mitre', 512, 512, drawBishopMitre, pal(L.mozzetta, L.mozzettaLine));
      const chasubleMat = painted('chasuble', 256, 1024, drawBishopChasuble, pal(L.chasuble, L.chasubleLine));
      const copeMat = painted('cope', 512, 512, drawBishopCope, pal(L.cope, L.cope));
      const mozzettaMat = painted('mozzetta', 1024, 256, drawBishopMozzetta, pal(L.mozzetta, L.mozzettaLine));
      const skullMat = painted('skullMedal', 128, 128, drawBishopSkull, pal('#000000', '#000000'));
      const cuffMat = painted('cuff', 256, 64, drawBishopCuff, pal(L.cuff, L.cuff));
      // Plain colours are given in sRGB like the painted textures; PBR albedo
      // is linear, so convert or they wash out next to the painted cloth.
      const lpbr = (name, color, metallic, roughness) => {
        const mat = pbr(name, color, metallic, roughness);
        mat.albedoColor = hex(color).toLinearSpace();
        return mat;
      };
      const alb = twoSided(lpbr('alb', L.alb, 0, 0.75));
      const lining = twoSided(lpbr('lining', L.lining, 0, 0.6));
      const embroidery = lpbr('embroidery', L.embroidery, 0.2, 0.5);
      const belt = pbr('belt', GD, 0.7, 0.45);
      const skin = lpbr('skin', L.skin, 0, 0.55);
      const lid = twoSided(lpbr('lid', L.skin, 0, 0.55));
      const sclera = lpbr('sclera', '#e6ded3', 0, 0.3);
      const iris = lpbr('iris', L.eye, 0, 0.25);
      const pupil = lpbr('pupil', '#0d0b0a', 0, 0.2);
      const whisker = lpbr('whisker', L.hair, 0, 0.75);
      const bone = lpbr('bone', '#d9ccae', 0.1, 0.55);
      const coinMat = pbr('coin', '#000000', 1, 0.3);
      coinMat.albedoColor = C3.Lerp(hex(team.accent), hex('#ffd27a'), 0.5).toLinearSpace();
      const socketDark = pbr('skullHole', '#1a1310', 0, 0.9);
      const strands = (name, uScale) => {
        const mat = twoSided(pbr(name, '#ffffff', 0, 0.8));
        const tex = makeCanvasTexture(`${name}Tex_${id}`, 256, 256, scene, (c, w, h) => drawBishopStrands(c, w, h, L));
        tex.hasAlpha = true; tex.uScale = uScale; tex.wrapV = BABYLON.Texture.CLAMP_ADDRESSMODE;
        mat.albedoTexture = tex;
        mat.useAlphaFromAlbedoTexture = true;
        mat.transparencyMode = BABYLON.PBRMaterial.PBRMATERIAL_ALPHATEST;
        mat.alphaCutOff = 0.45;
        return mat;
      };
      const beardMat = strands('beard', 4), hairMat = strands('hair', 6);

      const torso = new BABYLON.TransformNode(`torso_${id}`, scene);
      torso.parent = this.visual;
      this.parts.torso = torso;

      // --- alb to the floor, belted at the waist ---
      const TOP = 0.799, Y0 = BISHOP_ROBE.Y0;
      surface('alb', gridVertexData(64, 48, (u, v) => bishopRobePoint(Math.PI * (2 * u - 1), TOP - v * (TOP - Y0))), alb, torso);
      surface('belt', gridVertexData(56, 2, (u, v) => bishopRobePoint(Math.PI * (2 * u - 1), 0.485 - v * 0.03, 0.004)), belt, torso);

      // --- chasuble front panel ---
      surface('chasuble', gridVertexData(12, 48, bishopChasublePoint), chasubleMat, torso);

      // --- cope: painted outside, lining inside, embroidered piping ---
      surface('copeLining', gridVertexData(64, 44, (u, v) => bishopCopePoint(u, v)), lining, torso);
      surface('cope', gridVertexData(64, 44, (u, v) => bishopCopePoint(u, v, 0.004)), copeMat, torso);
      [0, 1].forEach((u) => tube(`copeEdge${u}`, line((v) => bishopCopePoint(u, v, 0.002), 44), 0.003, embroidery, torso));
      tube('copeHem', line((u) => bishopCopePoint(u, 1, 0.003), 64).map((p) => p.add(V3(0, 0.003, 0))), 0.003, embroidery, torso);

      // --- mozzetta with gold-piped edges ---
      surface('mozzetta', gridVertexData(72, 12, (u, v) => bishopMozzettaPoint(Math.PI * (2 * u - 1), v)), mozzettaMat, torso);
      tube('mozzettaHem', line((u) => bishopMozzettaPoint(Math.PI * (2 * u - 1), 1, 0.002), 72), 0.0028, gold, torso);
      tube('mozzettaNeck', line((u) => bishopMozzettaPoint(Math.PI * (2 * u - 1), 0, 0.002), 72), 0.0025, gold, torso);

      // --- skull medallions on a chain ---
      const medallion = (name, c, r) => {
        const disc = MB.CreateDisc(`${name}_${id}`, { radius: r, tessellation: 28, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        disc.position = c;
        disc.rotation.x = -0.12;
        this._add(disc, torso, skullMat);
        const rim = MB.CreateTorus(`${name}Rim_${id}`, { diameter: r * 2.1, thickness: r * 0.22, tessellation: 28 }, scene);
        rim.position = c.clone(); rim.rotation.x = Math.PI / 2 - 0.12;
        this._add(rim, torso, gold);
        for (let i = 0; i < 12; i++) {
          const a = i / 12 * Math.PI * 2;
          ball(`${name}Bead${i}`, c.add(V3(Math.cos(a) * r * 1.28, Math.sin(a) * r * 1.28, -0.001)), r * 0.28, gold, torso);
        }
        const bail = MB.CreateTorus(`${name}Bail_${id}`, { diameter: r * 0.6, thickness: r * 0.15, tessellation: 12 }, scene);
        bail.position = c.add(V3(0, r * 1.45, -0.002));
        this._add(bail, torso, gold);
      };
      const chestZ = (y) => bishopChasublePoint(0.5, (0.835 - y) / (0.835 - 0.13))[2];
      const MED1 = V3(0, 0.713, chestZ(0.713) + 0.008), MED2 = V3(0, 0.605, chestZ(0.605) + 0.008);
      medallion('medalTop', MED1, 0.019);
      medallion('medalLow', MED2, 0.017);
      [-1, 1].forEach((s) => tube(`chain${s}`, line((t) => [s * 0.018 * Math.sin(Math.PI * t) + s * 0.004, MED1.y - 0.02 - t * (MED1.y - MED2.y - 0.042),
        MED1.z - 0.002 - t * (MED1.z - MED2.z)], 12), 0.0013, gold, torso));

      // --- arms: alb sleeves sagging into bell cuffs over embroidered bands ---
      const makeArm = (side, pts, cuffRange, bell, hang) => {
        const s = side === 'R' ? 1 : -1;
        const arm = new BABYLON.TransformNode(`arm${side}_${id}`, scene);
        arm.parent = torso; arm.position.set(s * 0.105, 0.735, 0);
        const r = (t) => 0.024 + bell * smoothstep(0.45, 1, t);
        const sag = (t, a) => 1 + hang * smoothstep(0.5, 1, t) * Math.max(0, Math.cos(a));
        sweep(`sleeve${side}`, pts, (t, a) => r(t) * sag(t, a), alb, arm, [0, 1], 20);
        sweep(`cuff${side}`, pts, (t, a) => (r(t) + 0.003) * sag(t, a), cuffMat, arm, cuffRange, 20);
        return arm;
      };
      const armR = makeArm('R', [V3(0, -0.005, 0), V3(0.012, -0.075, -0.012), V3(0.018, -0.145, -0.012), V3(0.028, -0.19, 0.04), V3(0.033, -0.215, 0.095)], [0.8, 0.9], 0.011, 0.2);
      const armL = makeArm('L', [V3(0, -0.005, 0), V3(-0.015, -0.075, -0.015), V3(-0.03, -0.14, -0.03), V3(-0.04, -0.12, 0.01), V3(-0.045, -0.085, 0.05)], [0.8, 0.9], 0.006, 0.05);
      this.parts.armR = armR;
      this.parts.armL = armL;

      // --- hands: palm, thenar pad, jointed fingers and thumb ---
      // W = wrist, F = toward the knuckles, N = direction the palm faces,
      // thumbSide picks which edge carries the thumb; fingers curl toward N.
      const hand = (name, parent, W, F, Nraw, thumbSide, curls, thumb) => {
        F = F.normalize();
        const N = Nraw.subtract(F.scale(Vec.Dot(Nraw, F))).normalize();
        const S = Vec.Cross(N, F).normalize().scale(thumbSide);
        const k = Vec.Cross(F, N).normalize();
        const PL = 0.044, PW = 0.037, PT = 0.015;
        const frame = Vec.RotationFromAxis(S, F, Vec.Cross(S, F));
        const pad = (pname, c, sx, sy, sz) => {
          const mesh = MB.CreateSphere(`${pname}_${id}`, { diameter: 1, segments: 16 }, scene);
          mesh.position = c; mesh.rotation = frame.clone(); mesh.scaling.set(sx, sy, sz);
          return this._add(mesh, parent, skin);
        };
        pad(`${name}Palm`, W.add(F.scale(PL * 0.52)), PW, PL, PT);
        pad(`${name}Thenar`, W.add(F.scale(PL * 0.3)).add(S.scale(PW * 0.28)).add(N.scale(PT * 0.15)), PW * 0.55, PL * 0.6, PT * 0.95);
        limb(`${name}Wrist`, W.subtract(F.scale(0.022)), W.add(F.scale(0.008)), 0.028, 0.03, skin, parent);
        const finger = (fname, base, dir, axis, lens, bends, r0) => {
          const pts = [base.subtract(dir.scale(0.006)), base];
          let p = base, d = dir;
          lens.forEach((len, i) => { d = rot(d, axis, bends[i]); p = p.add(d.scale(len)); pts.push(p); });
          ftube(fname, pts, (t) => r0 * (1 - 0.3 * t), skin, parent, 5);
          ball(`${fname}Tip`, p, r0 * 1.35, skin, parent);
        };
        const lens = [[0.022, 0.014, 0.011], [0.024, 0.016, 0.012], [0.022, 0.015, 0.011], [0.017, 0.012, 0.009]];
        const radii = [0.0043, 0.0045, 0.0042, 0.0036];
        [0.36, 0.12, -0.12, -0.35].forEach((o, i) => {
          const base = W.add(F.scale(PL * [0.9, 0.94, 0.9, 0.84][i])).add(S.scale(o * PW)).add(N.scale(PT * 0.1));
          finger(`${name}Finger${i}`, base, F.add(S.scale(o * 0.2)).normalize(), k, lens[i], curls, radii[i]);
        });
        const tBase = W.add(F.scale(PL * 0.28)).add(S.scale(PW * 0.44)).add(N.scale(PT * 0.3));
        const tDir = F.scale(thumb.f).add(S.scale(thumb.s)).add(N.scale(thumb.n)).normalize();
        finger(`${name}Thumb`, tBase, tDir, Vec.Cross(tDir, N).normalize(), [0.02, 0.016], thumb.bends, 0.0053);
        return { N, F, S, palm: W.add(F.scale(PL * 0.52)), PL, PW, PT };
      };
      // Right hand: palm up at the hip, cupping a pile of gold coins.
      const coinHand = hand('handR', armR, V3(0.033, -0.215, 0.095), V3(-0.08, -0.12, 1), V3(0.12, 1, 0.1), 1,
        [0.3, 0.35, 0.25], { f: 0.8, s: 0.45, n: 0.35, bends: [0.25, 0.3] });
      // Left hand: a closed grip round the crozier's shaft.
      hand('handL', armL, V3(-0.045, -0.085, 0.05), V3(0, 0, 1), V3(1, 0, 0), -1,
        [1.25, 1.35, 0.9], { f: 0.75, s: 0.3, n: 0.55, bends: [0.5, 0.45] });

      // --- coins: a small heap in the palm and a string hanging from it ---
      const coinFrame = Vec.RotationFromAxis(coinHand.S, coinHand.N, Vec.Cross(coinHand.S, coinHand.N));
      [[0, 0, 0], [0.004, -0.003, 1], [-0.003, 0.004, 2], [0.006, 0.006, 1.6], [-0.006, -0.005, 0.8], [0.001, 0.001, 3]].forEach(([ds, df, level], i) => {
        const coin = MB.CreateCylinder(`coin${i}_${id}`, { diameter: 0.021, height: 0.0035, tessellation: 20 }, scene);
        coin.position = coinHand.palm.add(coinHand.N.scale(coinHand.PT * 0.5 + 0.002 + level * 0.0036))
          .add(coinHand.S.scale(ds)).add(coinHand.F.scale(df));
        coin.rotation = coinFrame.add(V3(0.15 * Math.sin(i * 2.3), 0, 0.15 * Math.cos(i * 1.7)));
        this._add(coin, armR, coinMat);
      });
      const hang = coinHand.palm.add(coinHand.S.scale(-coinHand.PW * 0.55)).add(coinHand.F.scale(0.012));
      tube('coinString', [hang, hang.add(V3(0, -0.028, 0.002)), hang.add(V3(0.002, -0.056, 0.003)), hang.add(V3(0.001, -0.08, 0.003))], 0.0012, gold, armR);
      [-0.03, -0.058, -0.084].forEach((dy, i) => {
        const coin = MB.CreateCylinder(`hangCoin${i}_${id}`, { diameter: 0.018, height: 0.003, tessellation: 20 }, scene);
        coin.position = hang.add(V3(0.001, dy, 0.005)); coin.rotation.x = Math.PI / 2;
        this._add(coin, armR, coinMat);
      });

      // --- crozier: gold shaft with turned knops, a crocketed spiral crook
      // with a skull at its heart, a glowing jewel in the knop ---
      const staff = new BABYLON.TransformNode(`weapon_${id}`, scene);
      staff.parent = armL; staff.position.set(-0.028, -0.085, 0.075);
      this.parts.weapon = staff;
      const lathe = (name, prof, y0) => {
        const mesh = MB.CreateLathe(`${name}_${id}`, { shape: prof.map(([r, y]) => V3(r, y, 0)), tessellation: 20, cap: BABYLON.Mesh.CAP_ALL }, scene);
        mesh.position.y = y0;
        return this._add(mesh, staff, gold);
      };
      const shaft = MB.CreateCylinder(`staffShaft_${id}`, { diameter: 0.015, height: 0.93, tessellation: 14 }, scene);
      shaft.position.y = -0.12;
      this._add(shaft, staff, gold);
      lathe('staffFoot', [[0.0001, 0], [0.005, 0.004], [0.009, 0.016], [0.0075, 0.03]], -0.585);
      const collar = [[0.0075, 0], [0.011, 0.005], [0.012, 0.011], [0.009, 0.018], [0.0075, 0.024]];
      [0.05, -0.3].forEach((y, i) => lathe(`staffCollar${i}`, collar, y));
      lathe('staffKnop', [[0.0075, 0], [0.012, 0.008], [0.017, 0.024], [0.019, 0.04], [0.016, 0.055], [0.011, 0.066], [0.009, 0.072],
        [0.012, 0.078], [0.0075, 0.084]], 0.258);
      const CX = -0.055, CY = 0.42, TURNS = 1.3, CR = 0.055;
      const crookPt = (t) => {
        const phi = t * TURNS * Math.PI * 2, r = CR * (1 - 0.62 * t);
        return [CX + r * Math.cos(phi), CY + r * Math.sin(phi), 0];
      };
      ftube('crook', [V3(0, 0.335, 0), V3(0, 0.39, 0), ...line(crookPt, 60)], (t) => 0.008 * (1 - 0.45 * t), gold, staff);
      for (let i = 0; i < 8; i++) {
        const t = 0.06 + i * 0.075, phi = t * TURNS * Math.PI * 2, r = CR * (1 - 0.62 * t) + 0.0095;
        ball(`crocket${i}`, V3(CX + r * Math.cos(phi), CY + r * Math.sin(phi), 0), 0.009, gold, staff, [1, 1, 0.7]);
      }
      // skull in the spiral
      ball('skullCranium', V3(CX, CY + 0.003, 0), 0.022, bone, staff, [0.9, 0.85, 0.9]);
      ball('skullJaw', V3(CX, CY - 0.007, 0.003), 0.015, bone, staff, [0.85, 0.7, 0.8]);
      [-1, 1].forEach((s) => ball(`skullEye${s}`, V3(CX + s * 0.0045, CY, 0.0085), 0.0055, socketDark, staff));
      ball('skullNose', V3(CX, CY - 0.0045, 0.0092), 0.003, socketDark, staff);
      const orb = MB.CreateSphere(`orb_${id}`, { diameter: 0.013, segments: 12 }, scene);
      orb.position.set(0, 0.298, 0.018);
      this._add(orb, staff, m.magic);
      this.parts.orb = orb;

      // --- head: mitre, halo and lappets in scene units; the face rig below
      // is sculpted in normalised head units and scaled into place ---
      const head = new BABYLON.TransformNode(`head_${id}`, scene);
      head.parent = torso; head.position.set(0, 0.872, 0.012);
      this.parts.head = head;
      const K = 0.125;
      const face = new BABYLON.TransformNode(`faceRig_${id}`, scene);
      face.parent = head; face.scaling.setAll(K);
      this.parts.extraPivots = [face];

      // Skin: vertex colours warm the nose and cheeks, shade the eye sockets
      // and tint the lips.
      const faceVD = gridVertexData(72, 64, (u, v) => bishopHeadPoint(Math.PI * (2 * u - 1), 0.52 - v * 1.14));
      const base = hex(L.skin), warm = new C3(base.r * 1.04, base.g * 0.8, base.b * 0.78), shade = base.scale(0.7), lip = hex(L.lip);
      faceVD.colors = [];
      for (let i = 0; i < faceVD.positions.length; i += 3) {
        const x = faceVD.positions[i], y = faceVD.positions[i + 1], front = faceVD.positions[i + 2] > 0 ? 1 : 0, ax = Math.abs(x);
        const wWarm = front * Math.min(1, 0.55 * gauss(x, y + 0.19, 0.06, 0.05) + 0.4 * gauss(ax - 0.2, y + 0.12, 0.08, 0.07));
        const wShade = front * 0.6 * gauss(ax - 0.135, y + 0.005, 0.06, 0.045);
        const wLip = front * gauss(x, y + 0.31, 0.075, 0.035);
        const col = C3.Lerp(C3.Lerp(C3.Lerp(base, warm, wWarm), shade, wShade), lip, wLip);
        const lin = col.toLinearSpace(); // vertex colours are read as linear
        faceVD.colors.push(lin.r, lin.g, lin.b, 1);
      }
      surface('face', faceVD, pbr('face', '#ffffff', 0, 0.55), face);
      const neck = MB.CreateCylinder(`neck_${id}`, { diameter: 0.4, height: 0.5, tessellation: 20 }, scene);
      neck.position.y = -0.68;
      this._add(neck, face, lid);

      // eyes: eyeball, iris and pupil under heavy upper lids
      [-1, 1].forEach((s) => {
        const E = V3(s * 0.135, 0.005, bishopHeadFront(0.135, 0.005) - 0.028);
        ball(`eyeball${s}`, E, 0.092, sclera, face);
        ball(`iris${s}`, E.add(V3(0, 0, 0.039)), 0.042, iris, face, [1, 1, 0.35]);
        ball(`pupil${s}`, E.add(V3(0, 0, 0.0445)), 0.018, pupil, face, [1, 1, 0.3]);
        const shell = (lname, r, lat0, lat1) => surface(lname, gridVertexData(16, 6, (u, v) => {
          const lon = (2 * u - 1) * 1.7, lat = lat0 + (lat1 - lat0) * v;
          return [E.x + r * Math.cos(lat) * Math.sin(lon), E.y + r * Math.sin(lat), E.z + r * Math.cos(lat) * Math.cos(lon)];
        }), lid, face);
        shell(`upperLid${s}`, 0.052, 1.45, 0.18);
        shell(`lowerLid${s}`, 0.05, -0.5, -1.25);
        const rim = (lat, r) => line((t) => {
          const lon = (2 * t - 1) * 1.5;
          return [E.x + r * Math.cos(lat) * Math.sin(lon), E.y + r * Math.sin(lat), E.z + r * Math.cos(lat) * Math.cos(lon)];
        }, 16);
        tube(`upperLidRim${s}`, rim(0.18, 0.053), 0.007, lid, face);
        tube(`lowerLidRim${s}`, rim(-0.5, 0.051), 0.005, lid, face);
        // bushy brows, drawn down at the inner ends in a frown
        for (let j = 0; j < 7; j++) {
          const dy = (j - 3) * 0.0055, x0 = 0.045 + (j % 3) * 0.012, lift = 0.008 + (j % 2) * 0.005;
          const pts = [[x0, 0.052], [0.1, 0.076], [0.17, 0.088], [0.23 + (j % 2) * 0.015, 0.068]].map(([x, y]) =>
            V3(s * x, y + dy, bishopHeadFront(x, y + dy) + lift));
          ftube(`brow${s}_${j}`, pts, (t) => 0.0085 * (1 - 0.6 * t), whisker, face, 4);
        }
      });
      // moustache: a stranded shell over the upper lip drooping into the beard
      surface('moustache', gridVertexData(24, 8, (u, v) => {
        const x = (2 * u - 1) * 0.16, a = Math.abs(x) / 0.16;
        const y = -0.228 - v * (0.08 + 0.13 * a * a);
        return [x * (1 + 0.1 * v), y, bishopHeadFront(x, y) + 0.012 + 0.03 * Math.sin(Math.PI * Math.min(1, v * 1.2)) * (1 - 0.4 * a)];
      }), beardMat, face);
      surface('beard', gridVertexData(40, 28, bishopBeardPoint), beardMat, face);
      surface('hair', gridVertexData(40, 10, bishopHairPoint), hairMat, face);

      // mitre, gold edge piping and base rim
      surface('mitre', gridVertexData(48, 24, (u, v) => bishopMitrePoint(Math.PI * (2 * u - 1), 1 - v)), mitreMat, head);
      tube('mitreEdge', line((t) => bishopMitrePoint(Math.PI * (t - 0.5), 1, 0.001), 30), 0.0022, gold, head);
      tube('mitreRim', line((t) => bishopMitrePoint(Math.PI * (2 * t - 1), 0, 0.0015), 40), 0.0026, gold, head);
      // lappets hanging from the back of the mitre
      [-1, 1].forEach((s) => blade(`lappet${s}`, [V3(s * 0.022, 0.035, -0.06), V3(s * 0.028, -0.02, -0.07), V3(s * 0.034, -0.1, -0.076)],
        () => 0.018, -s, V3(0, 0, -1), lining, head, 0.002));
      // halo: a fine gold ring behind the head
      const halo = MB.CreateTorus(`halo_${id}`, { diameter: 0.24, thickness: 0.0045, tessellation: 48 }, scene);
      halo.position.set(0, 0.035, -0.075); halo.rotation.x = Math.PI / 2;
      this._add(halo, head, gold);
    }

    // Rook: a stone keep after the reference tower — a bastion with a barred
    // gate, boulders piled at its feet, a round brick tower with barred arched
    // windows, a corbelled parapet crowned with merlons and an iron spike.
    // Beside it hangs a stone golem built from the same masonry cut into
    // blocks: the bastion splits into hips, thighs, shins and feet, the
    // tower into twelve curved wedges (chest, shoulders, hump and arm
    // plates), the parapet into a small head with a merlon brow and horns,
    // and the boulder piles become its fists, all held together by a glowing
    // core. Each block keeps its place in the keep and in the golem (see
    // _setTowerMorph); meshes merge per block, so the keep's draw calls are
    // unchanged and the golem's only cost anything while it is out.
    _buildRook(team) {
      const scene = this.scene, m = this.mats, id = this.id;
      const MB = BABYLON.MeshBuilder, DOUBLE = BABYLON.Mesh.DOUBLESIDE;
      const { V3, pbr, surface, tube, limb, ball } = this._kit();
      const L = ROOK_LIVERY[this.color] || ROOK_LIVERY.w;
      const T = ROOK.TILE, P = this.parts, B = ROOK.BASTION, SH = ROOK.SHAFT;
      const tex = rookMasonry(this.color, L);

      const brick = pbr('brick', '#ffffff', 0, 0.92);
      brick.albedoTexture = makeCanvasTexture(`brickTex_${id}`, 512, 512, scene, (c) => c.drawImage(tex.albedo, 0, 0));
      brick.bumpTexture = makeCanvasTexture(`brickNrm_${id}`, 512, 512, scene, (c) => c.drawImage(tex.normal, 0, 0));
      const ashlar = pbr('ashlar', L.trim, 0, 0.85);     // corbels, cornices, arch frames
      const shade = pbr('shade', L.dark, 0, 0.95);        // recesses and the parapet's inside
      const rockMat = pbr('rock', '#ffffff', 0, 0.95);
      rockMat.albedoTexture = makeCanvasTexture(`rockTex_${id}`, 128, 128, scene, (c) => c.drawImage(tex.grit, 0, 0));
      const iron = pbr('iron', L.iron, 0.7, 0.55);
      const moss = pbr('moss', L.moss, 0, 1);
      // Light behind the gate and windows: a dim glow in the keep, blazing
      // in the golem. Its eyes, rune and joints use m.magic.
      const glow = new BABYLON.StandardMaterial(`keepGlow_${id}`, scene);
      glow.disableLighting = true; glow.diffuseColor = BABYLON.Color3.Black();
      // The golem's inner core, seen through the gaps between its blocks.
      const ember = new BABYLON.StandardMaterial(`ember_${id}`, scene);
      ember.disableLighting = true; ember.diffuseColor = BABYLON.Color3.Black(); ember.emissiveColor = BABYLON.Color3.Black();
      this.materials.push(glow, ember);
      // The golem's bricks: the same masonry with mortar that glows as the
      // keep cracks; one material per tier (bastion, tower, parapet) so the
      // cracks can climb it.
      const mortar = makeCanvasTexture(`brickMortar_${id}`, 512, 512, scene, (c) => c.drawImage(tex.mortar, 0, 0));
      const tiers = [0, 1, 2].map((i) => {
        const mat = pbr(`brickTier${i}`, '#ffffff', 0, 0.92);
        mat.albedoTexture = brick.albedoTexture; mat.bumpTexture = brick.bumpTexture;
        mat.emissiveTexture = mortar; mat.emissiveColor = BABYLON.Color3.Black();
        return mat;
      });
      const lit = hex(team.glow);
      this._rookGlow = { mat: glow, dim: lit.scale(0.3), lit, ember, tiers, magic: m.magic, magicLit: m.magic.emissiveColor.clone() };

      const uv = (w, h) => new BABYLON.Vector4(0, 0, w / T, h / T);
      const bricks = (name, w, h, d, parent, pos, mat) => {
        const box = MB.CreateBox(`${name}_${id}`, { width: w, height: h, depth: d, wrap: true,
          faceUV: [uv(w, h), uv(w, h), uv(d, h), uv(d, h), uv(w, d), uv(w, d)] }, scene);
        box.position = pos;
        return this._add(box, parent, mat || brick);
      };
      const slab = (name, w, h, d, parent, pos, mat, rotY) => {
        const box = MB.CreateBox(`${name}_${id}`, { width: w, height: h, depth: d }, scene);
        box.position = pos;
        if (rotY) box.rotation.y = rotY;
        return this._add(box, parent, mat);
      };
      // Brick drum; `around` = masonry tiles round the circumference (an
      // integer, so the courses meet at the seam).
      const drum = (name, dTop, dBot, h, around, parent, y, mat, side) => {
        const cyl = MB.CreateCylinder(`${name}_${id}`, { diameterTop: dTop, diameterBottom: dBot, height: h, tessellation: 40,
          cap: BABYLON.Mesh.NO_CAP, sideOrientation: side, faceUV: [uv(0, 0), new BABYLON.Vector4(0, 0, around, h / T), uv(0, 0)] }, scene);
        cyl.position.y = y;
        return this._add(cyl, parent, mat || brick);
      };
      const rock = (name, parent, p, size, seed, detail, mat) => {
        const mesh = new BABYLON.Mesh(`${name}_${id}`, scene);
        rockVertexData(seed, size, detail).applyToMesh(mesh);
        mesh.position = p;
        return this._add(mesh, parent, mat || rockMat);
      };
      const seed0 = this.color === 'w' ? 101 : 202;
      // Barred arch opening in `node` space: straight jambs from y = 0 up to
      // `spring`, then a round head; the node's +z faces out of the wall.
      const archway = (name, node, w, spring, bars, sill) => {
        const r = w / 2;
        const pane = MB.CreatePlane(`${name}Pane_${id}`, { width: w, height: spring, sideOrientation: DOUBLE }, scene);
        pane.position.y = spring / 2;
        this._add(pane, node, glow);
        const head = MB.CreateDisc(`${name}Head_${id}`, { radius: r, arc: 0.5, tessellation: 16, sideOrientation: DOUBLE }, scene);
        head.position.y = spring;
        this._add(head, node, glow);
        const frame = [V3(-r, 0, 0)];
        for (let i = 0; i <= 12; i++) {
          const a = Math.PI * (1 - i / 12);
          frame.push(V3(r * Math.cos(a), spring + r * Math.sin(a), 0));
        }
        frame.push(V3(r, 0, 0));
        tube(`${name}Frame`, frame, w * 0.13, ashlar, node);
        slab(`${name}Key`, w * 0.2, w * 0.26, w * 0.2, node, V3(0, spring + r + w * 0.04, 0.002), ashlar);
        for (let i = 1; i < bars; i++) {
          const x = -r + (w * i) / bars, bh = spring + Math.sqrt(r * r - x * x);
          const bar = MB.CreateCylinder(`${name}Bar${i}_${id}`, { diameter: w * 0.07, height: bh, tessellation: 6 }, scene);
          bar.position.set(x, bh / 2, 0.004);
          this._add(bar, node, iron);
        }
        [0.35, 0.8].forEach((f, i) => {
          const bar = MB.CreateCylinder(`${name}Rail${i}_${id}`, { diameter: w * 0.06, height: w, tessellation: 6 }, scene);
          bar.position.set(0, spring * f, 0.006);
          bar.rotation.z = Math.PI / 2;
          this._add(bar, node, iron);
        });
        if (sill) slab(`${name}Sill`, w * 1.6, w * 0.22, w * 0.55, node, V3(0, -w * 0.11, w * 0.18), ashlar);
      };
      const pivots = [];   // every sub-node, so build() merges its meshes too
      const opening = (name, parent, pos, rotY) => {
        const node = new BABYLON.TransformNode(`${name}_${id}`, scene);
        node.parent = parent; node.position = pos; node.rotation.y = rotY || 0;
        pivots.push(node);
        return node;
      };

      // Custom solids: quads wound like Babylon's own (clockwise seen from
      // the face's normal side), with per-vertex normals and UVs.
      const solid = () => {
        const g = { pos: [], nrm: [], uvs: [], idx: [] };
        g.quad = (pts, ns, uvs) => {
          const b = g.pos.length / 3;
          pts.forEach((p, i) => { g.pos.push(p[0], p[1], p[2]); g.nrm.push(ns[i][0], ns[i][1], ns[i][2]); g.uvs.push(uvs[i][0], uvs[i][1]); });
          const e1 = [0, 1, 2].map((k) => pts[1][k] - pts[0][k]), e2 = [0, 1, 2].map((k) => pts[2][k] - pts[0][k]), n = ns[0];
          const c = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          if (c[0] * n[0] + c[1] * n[1] + c[2] * n[2] < 0) g.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
          else g.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
        };
        g.mesh = (name, mat, parent) => {
          const vd = new BABYLON.VertexData();
          vd.positions = g.pos; vd.normals = g.nrm; vd.uvs = g.uvs; vd.indices = g.idx;
          return surface(name, vd, mat, parent);
        };
        return g;
      };
      // Cut [x0,x1]x[y0,y1]x[z0,z1] of a masonry box `full` ({ w, h, d, c }),
      // textured exactly like Babylon's wrapped box so the cut faces carry on
      // the full box's courses.
      const sliceBox = (name, full, x0, x1, y0, y1, z0, z1, mat, parent) => {
        const { w, h, d, c } = full, g = solid();
        const U = (p, n) => {
          const X = p[0] - c.x, Y = p[1] - c.y, Z = p[2] - c.z;
          const t = n[2] > 0.5 ? [w / 2 - X, Y + h / 2] : n[2] < -0.5 ? [X + w / 2, Y + h / 2]
            : n[0] > 0.5 ? [Z + d / 2, Y + h / 2] : n[0] < -0.5 ? [d / 2 - Z, Y + h / 2]
              : n[1] > 0.5 ? [X + w / 2, Z + d / 2] : [X + w / 2, d / 2 - Z];
          return [t[0] / T, t[1] / T];
        };
        const F = (n, pts) => g.quad(pts, pts.map(() => n), pts.map((p) => U(p, n)));
        F([0, 0, 1], [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]]);
        F([0, 0, -1], [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]]);
        F([1, 0, 0], [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]]);
        F([-1, 0, 0], [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]]);
        F([0, 1, 0], [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]]);
        F([0, -1, 0], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
        return g.mesh(name, mat, parent);
      };
      // Wedge of the brick tower over tessellation steps k0..k1 (Babylon's
      // cylinder angle runs from +x towards -z) and heights y0..y1: the
      // drum's own outer surface and UVs, backed by a solid wall.
      const shaftR = (y) => SH.r0 + (SH.r1 - SH.r0) * (y - SH.y0) / (SH.y1 - SH.y0);
      const slope = (SH.r0 - SH.r1) / (SH.y1 - SH.y0);
      const wedge = (name, k0, k1, y0, y1, mat, parent) => {
        const g = solid(), A = (k) => (k / SH.tess) * Math.PI * 2;
        const at = (k, y, inset) => { const a = A(k), r = shaftR(y) - inset; return [r * Math.cos(a), y, -r * Math.sin(a)]; };
        const v = (y) => (y - SH.y0) / T, u = (k) => SH.around * k / SH.tess;
        for (let k = k0; k < k1; k++) {
          const o = [k, k + 1].map((j) => [Math.cos(A(j)), slope, -Math.sin(A(j))]);
          const i = o.map((n) => [-n[0], 0, -n[2]]);
          g.quad([at(k, y0, 0), at(k + 1, y0, 0), at(k + 1, y1, 0), at(k, y1, 0)], [o[0], o[1], o[1], o[0]],
            [[u(k), v(y0)], [u(k + 1), v(y0)], [u(k + 1), v(y1)], [u(k), v(y1)]]);
          g.quad([at(k, y0, SH.wall), at(k, y1, SH.wall), at(k + 1, y1, SH.wall), at(k + 1, y0, SH.wall)], [i[0], i[0], i[1], i[1]],
            [[u(k), v(y0)], [u(k), v(y1)], [u(k + 1), v(y1)], [u(k + 1), v(y0)]]);
          [[y1, 1], [y0, -1]].forEach(([y, s]) => {
            const pts = [at(k, y, 0), at(k + 1, y, 0), at(k + 1, y, SH.wall), at(k, y, SH.wall)];
            g.quad(pts, pts.map(() => [0, s, 0]), pts.map((p) => [p[0] / T, p[2] / T]));
          });
        }
        [[k0, 1], [k1, -1]].forEach(([k, s]) => {
          const a = A(k), n = [s * Math.sin(a), 0, s * Math.cos(a)];
          const pts = [at(k, y0, 0), at(k, y1, 0), at(k, y1, SH.wall), at(k, y0, SH.wall)];
          g.quad(pts, pts.map(() => n), pts.map((p, j) => [(j < 2 ? 0 : SH.wall) / T, v(p[1])]));
        });
        return g.mesh(name, mat, parent);
      };

      // --- the keep's parts, shared by the keep and the golem's blocks ---
      const crenels = (parent, keep, mat) => {
        const crenel = (x, z, rotY) => {
          if (keep(x, z)) bricks('bMerlon', 0.05, 0.035, 0.03, parent, V3(x, 0.3475, z), mat).rotation.y = rotY;
        };
        for (let i = 0; i < 7; i++) {
          const x = -0.27 + i * 0.09;
          crenel(x, B.d / 2 + 0.005, 0); crenel(x, -B.d / 2 - 0.005, 0);
        }
        for (let i = 1; i < 5; i++) {
          const z = -B.d / 2 + i * (B.d / 5);
          crenel(B.w / 2 + 0.005, z, Math.PI / 2); crenel(-B.w / 2 - 0.005, z, Math.PI / 2);
        }
      };
      const gate = (parent) => archway('gate', opening('gateNode', parent, V3(0, 0.105, B.d / 2 + 0.002)), 0.12, 0.095, 6);
      // Boulders piled at the front corners (the golem's fists).
      const pile = (side, parent) => {
        const s = side === 'R' ? 1 : -1, node = opening(`pile${side}`, parent, V3(s * 0.26, 0.07, 0.2));
        const stones = side === 'R'
          ? [[0.03, 0.045, 0.02, 0.13], [-0.07, 0.035, 0.05, 0.1], [0.07, 0.03, -0.08, 0.1], [-0.01, 0.1, -0.01, 0.09]]
          : [[0.04, 0.04, 0.03, 0.12], [-0.06, 0.04, 0.06, 0.11], [0.08, 0.03, -0.06, 0.09], [0.0, 0.1, 0.0, 0.1], [-0.1, 0.025, -0.05, 0.08]];
        stones.forEach(([x, y, z, d], i) => rock(`pile${side}${i}`, node, V3(s * x * 1.2, y * 1.3, z * 1.2), [d * 1.5, d * 1.1, d * 1.3],
          seed0 + (side === 'R' ? 0 : 4) + i));
        return node;
      };
      const windows = (parent, which) => {
        if (which !== 'lo') archway('winHi', opening('winHiNode', parent, V3(0, 0.54, shaftR(0.57))), 0.075, 0.06, 5, true);
        const th = -0.55;
        if (which !== 'hi') {
          archway('winLo', opening('winLoNode', parent, V3(shaftR(0.4) * Math.sin(th), 0.37, shaftR(0.4) * Math.cos(th)), th), 0.066, 0.055, 4);
        }
      };
      // Parapet in head space (the keep's top at y = HEAD_Y): `parts` picks
      // the skull (corbelled flare and ring), merlons by index (0 = front,
      // 2 = +x) and the spike.
      const parapet = (head, parts, mat) => {
        if (parts.skull) {
          const neck = MB.CreateCylinder(`neck_${id}`, { diameter: 0.28, height: 0.1, tessellation: 20 }, scene);
          neck.position.y = -0.02;
          this._add(neck, head, shade);
          const molding = (name, d, t, y) => {
            const tor = MB.CreateTorus(`${name}_${id}`, { diameter: d, thickness: t, tessellation: 40 }, scene);
            tor.position.y = y;
            return this._add(tor, head, ashlar);
          };
          molding('moldLo', 0.33, 0.028, 0);
          const flare = MB.CreateCylinder(`flare_${id}`, { diameterTop: 0.39, diameterBottom: 0.31, height: 0.075, tessellation: 40 }, scene);
          flare.position.y = 0.045;
          this._add(flare, head, shade);
          for (let i = 0; i < 12; i++) {           // stepped corbels; the front one reads as a nose
            const a = (i / 12) * Math.PI * 2, sn = Math.sin(a), cs = Math.cos(a);
            slab(`corbel${i}`, 0.036, 0.045, 0.055, head, V3(0.18 * sn, 0.055, 0.18 * cs), ashlar, a);
            slab(`corbelFoot${i}`, 0.03, 0.03, 0.035, head, V3(0.172 * sn, 0.02, 0.172 * cs), ashlar, a);
          }
          molding('moldHi', 0.405, 0.024, 0.085);
          drum('parapet', 0.41, 0.41, 0.085, 5, head, 0.1275, mat);
          drum('parapetIn', 0.34, 0.34, 0.05, 1, head, 0.145, shade, BABYLON.Mesh.BACKSIDE);
          const rim = (r) => {
            const path = [];
            for (let i = 0; i <= 40; i++) { const a = (i / 40) * Math.PI * 2; path.push(V3(r * Math.sin(a), 0.17, r * Math.cos(a))); }
            return path;
          };
          this._add(MB.CreateRibbon(`lip_${id}`, { pathArray: [rim(0.168), rim(0.206)], sideOrientation: DOUBLE }, scene), head, ashlar);
          const floor = MB.CreateDisc(`floor_${id}`, { radius: 0.172, tessellation: 32, sideOrientation: DOUBLE }, scene);
          floor.position.y = 0.12; floor.rotation.x = Math.PI / 2;
          this._add(floor, head, shade);
        }
        (parts.merlons || []).forEach((i) => {
          const a = (i / 8) * Math.PI * 2, sn = Math.sin(a), cs = Math.cos(a);
          bricks(`merlon${i}`, 0.08, 0.055, 0.034, head, V3(0.188 * sn, 0.1975, 0.188 * cs), mat).rotation.y = a;
          slab(`merlonCap${i}`, 0.088, 0.012, 0.042, head, V3(0.188 * sn, 0.231, 0.188 * cs), ashlar, a);
        });
        if (parts.spike) {
          const spike = MB.CreateCylinder(`spike_${id}`, { diameter: 0.012, height: 0.3, tessellation: 8 }, scene);
          spike.position.y = 0.27;
          this._add(spike, head, iron);
          const tip = MB.CreateCylinder(`spikeTip_${id}`, { diameterTop: 0, diameterBottom: 0.026, height: 0.055, tessellation: 8 }, scene);
          tip.position.y = 0.447;
          this._add(tip, head, iron);
          ball('spikeKnob', V3(0, 0.395, 0), 0.024, iron, head);
          slab('spikeBar', 0.045, 0.007, 0.007, head, V3(0, 0.375, 0), iron);
        }
      };

      // --- the keep, whole: what stands on the board ---
      const keep = new BABYLON.TransformNode(`keep_${id}`, scene);
      keep.parent = this.visual;
      pivots.push(keep);
      this._keep = keep;
      slab('plinth', B.w + 0.04, 0.035, B.d + 0.04, keep, V3(0, 0.0875, 0), ashlar);
      bricks('bastion', B.w, B.h, B.d, keep, V3(0, B.y, 0));
      slab('cornice', B.w + 0.04, 0.025, B.d + 0.04, keep, V3(0, 0.3175, 0), ashlar);
      crenels(keep, () => true);
      gate(keep);
      pile('R', keep); pile('L', keep);
      drum('shaft', SH.r1 * 2, SH.r0 * 2, SH.y1 - SH.y0, SH.around, keep, (SH.y0 + SH.y1) / 2);
      windows(keep);
      parapet(opening('parapet', keep, V3(0, ROOK.HEAD_Y, 0)), { skull: true, merlons: [0, 1, 2, 3, 4, 5, 6, 7], spike: true });

      // --- the golem's skeleton ---
      const H = ROOK.HIP, S = ROOK.SHOULDER;
      const bone = (name, parent, pos) => {
        const n = new BABYLON.TransformNode(`${name}_${id}`, scene);
        n.parent = parent; n.position = pos;
        return n;
      };
      const golem = bone('golem', this.visual, V3(0, 0, 0));
      this._golemRoot = golem;
      P.pelvis = bone('pelvis', golem, V3(0, H.y, 0));
      P.torso = bone('torso', P.pelvis, V3(0, ROOK.WAIST, 0));
      P.head = bone('head', P.torso, V3(0, ROOK.NECK.y, ROOK.NECK.z));
      this._bones = [golem, P.pelvis, P.torso, P.head];
      [['R', 1], ['L', -1]].forEach(([side, s]) => {
        P['arm' + side] = bone(`arm${side}`, P.torso, V3(s * S.x, S.y, 0));
        P['fore' + side] = bone(`fore${side}`, P['arm' + side], V3(0, -ROOK.UPPER, 0));
        P['leg' + side] = bone(`leg${side}`, golem, V3(s * H.x, H.y, 0));
        P['knee' + side] = bone(`knee${side}`, P['leg' + side], V3(0, -ROOK.THIGH, 0));
        P['ankle' + side] = bone(`ankle${side}`, P['knee' + side], V3(0, -(ROOK.SHIN - 0.028), 0));
        this._bones.push(P['arm' + side], P['fore' + side], P['leg' + side], P['knee' + side], P['ankle' + side]);
      });

      // --- the golem's blocks: built in keep space, re-centred on `c`, then
      // hung off a bone with their golem transform (bone space) ---
      const rand = rng(this.color === 'w' ? 7 : 9);
      const ax = { x: BABYLON.Axis.X, y: BABYLON.Axis.Y, z: BABYLON.Axis.Z };
      const Q = (...ops) => ops.reduce((q, [a, r]) => BABYLON.Quaternion.RotationAxis(ax[a], r).multiply(q), BABYLON.Quaternion.Identity());
      const blocks = [];
      const block = (name, c, bn, delay, build, pos, rot, scl) => {
        const node = new BABYLON.TransformNode(`${name}_${id}`, scene);
        node.parent = this.visual;
        pivots.push(node);
        build(node);
        node.getChildren().forEach((ch) => ch.position.subtractInPlace(c));
        node.parent = bn;
        node.rotationQuaternion = BABYLON.Quaternion.Identity();
        const out = V3(c.x, 0, c.z);
        if (out.length() < 0.03) out.set(rand() - 0.5, 0, rand() - 0.5);
        out.normalize().scaleInPlace(0.05 + 0.07 * rand());
        const axis = V3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
        blocks.push({ node, c, bone: bn, delay: delay + 0.03 * rand(), hover: out.add(V3(0, 0.05 + 0.09 * rand(), 0)), axis,
          spin: (0.3 + 0.5 * rand()) * (rand() < 0.5 ? -1 : 1),
          gPos: pos, gRot: rot || BABYLON.Quaternion.Identity(), gScale: typeof scl === 'number' ? V3(scl, scl, scl) : (scl || V3(1, 1, 1)) });
      };
      const BOX = { w: B.w, h: B.h, d: B.d, c: V3(0, B.y, 0) };
      const CORNICE = { w: B.w + 0.04, h: 0.025, d: B.d + 0.04, c: V3(0, 0.3175, 0) };
      const PLINTH = { w: B.w + 0.04, h: 0.035, d: B.d + 0.04, c: V3(0, 0.0875, 0) };
      const X = B.cut, XO = B.w / 2, ZO = B.d / 2;
      const bastionCut = (node, x0, x1, z0, z1) => {
        const ex = (v) => (Math.abs(Math.abs(v) - XO) < 1e-6 || Math.abs(Math.abs(v) - ZO) < 1e-6 ? v + Math.sign(v) * 0.02 : v);
        sliceBox('bastion', BOX, x0, x1, B.y - B.h / 2, B.y + B.h / 2, z0, z1, tiers[0], node);
        sliceBox('cornice', CORNICE, ex(x0), ex(x1), 0.305, 0.33, ex(z0), ex(z1), ashlar, node);
        crenels(node, (x, z) => x >= x0 - 0.03 && x <= x1 + 0.03 && z >= z0 - 0.03 && z <= z1 + 0.03, tiers[0]);
      };

      // Hips: the bastion's middle with its gate, turned crosswise.
      block('hips', V3(0, B.y, 0), P.pelvis, 0.06, (n) => {
        bastionCut(n, -X, X, -ZO, ZO);
        sliceBox('plinth', PLINTH, -X, X, 0.07, 0.105, -ZO - 0.02, ZO + 0.02, ashlar, n);
        gate(n);
      }, V3(0, -0.035, -0.01), Q(['y', Math.PI / 2]), V3(1, 1, 0.85));
      [['R', 1], ['L', -1]].forEach(([side, s]) => {
        const x0 = s > 0 ? X : -XO, x1 = s > 0 ? XO : -X, cx = s * (X + XO) / 2;
        // Thighs and shins: the bastion's flanks, back half and front half.
        block(`thigh${side}`, V3(cx, B.y, -ZO / 2), P['leg' + side], 0, (n) => bastionCut(n, x0, x1, -ZO, 0),
          V3(0, -0.09, 0), null, V3(1, 0.85, 0.9));
        block(`shin${side}`, V3(cx, B.y, ZO / 2), P['knee' + side], 0.02, (n) => bastionCut(n, x0, x1, 0, ZO),
          V3(0, -0.07, 0.01), null, V3(0.95, 0.7, 0.85));
        // Feet: the plinth's ends.
        block(`foot${side}`, V3(s * (X + XO + 0.02) / 2, 0.0875, 0), P['ankle' + side], 0, (n) => {
          sliceBox('plinth', PLINTH, s > 0 ? X : -XO - 0.02, s > 0 ? XO + 0.02 : -X, 0.07, 0.105, -ZO - 0.02, ZO + 0.02, ashlar, n);
        }, V3(0, 0, 0.04), null, V3(0.95, 1.6, 0.6));
        // Fists: the boulder piles.
        block(`fist${side}`, V3(s * 0.26, 0.13, 0.2), P['fore' + side], 0.22, (n) => pile(side, n),
          V3(0, -ROOK.FORE - 0.05, 0.03), Q(['x', 0.5]), 1.15);
      });

      // The tower in twelve wedges: rings bottom to top, segments centred
      // on +x, -z, -x, +z (Babylon's cylinder angle).
      const ring = (SH.y1 - SH.y0) / SH.rings, segK = SH.tess / SH.segs;
      const wedgeBlock = (name, r, seg, bn, delay, pos, rot, scl, win) => {
        const y0 = SH.y0 + r * ring, y1 = y0 + ring, ym = (y0 + y1) / 2, a = seg * Math.PI / 2, rm = shaftR(ym) - 0.045;
        const k0 = Math.round(seg * segK - segK / 2);
        block(name, V3(rm * Math.cos(a), ym, -rm * Math.sin(a)), bn, delay, (n) => {
          wedge('wedge', k0, k0 + segK, y0, y1, tiers[1], n);
          if (win) windows(n, win);
        }, pos, rot, scl);
      };
      const PI = Math.PI;
      // Middle ring: the chest's pectorals (tilted outward), belly (the high window) and back.
      wedgeBlock('pecR', 1, 0, P.torso, 0.12, V3(0.105, 0.24, 0.08), Q(['y', -PI / 2 + 0.3], ['x', -0.35]), 1.25);
      wedgeBlock('pecL', 1, 2, P.torso, 0.13, V3(-0.105, 0.24, 0.08), Q(['y', PI / 2 - 0.3], ['x', -0.35]), 1.25);
      wedgeBlock('belly', 1, 3, P.torso, 0.1, V3(0, 0.05, 0.075), Q(['x', -0.2]), 0.85, 'hi');
      wedgeBlock('back', 1, 1, P.torso, 0.1, V3(0, 0.13, -0.1), Q(['x', 0.15]), 1);
      // Top ring: shoulder caps and the hump.
      wedgeBlock('shoulderR', 2, 0, P.torso, 0.18, V3(0.25, 0.33, -0.01), Q(['z', 0.75]), 1.15);
      wedgeBlock('shoulderL', 2, 2, P.torso, 0.19, V3(-0.25, 0.33, -0.01), Q(['z', -0.75]), 1.15);
      wedgeBlock('hump', 2, 1, P.torso, 0.2, V3(0, 0.35, -0.08), Q(['x', 0.9]), 1.1);
      wedgeBlock('humpLo', 2, 3, P.torso, 0.17, V3(0, 0.24, -0.15), Q(['y', PI], ['x', 0.45]), 1);
      // Bottom ring: arm plates, chord along the limb (the low window rides the left forearm).
      // (turned a little forward so the plates also read from the front)
      wedgeBlock('upperArmR', 0, 0, P.armR, 0.22, V3(0.03, -0.12, 0.01), Q(['x', PI / 2], ['y', -0.6]), V3(1.2, 1.2, 1.15));
      wedgeBlock('upperArmL', 0, 2, P.armL, 0.23, V3(-0.03, -0.12, 0.01), Q(['x', PI / 2], ['y', 0.6]), V3(1.2, 1.2, 1.15));
      wedgeBlock('foreR', 0, 1, P.foreR, 0.24, V3(0.025, -0.11, 0.01), Q(['y', -PI / 2], ['x', PI / 2], ['y', -0.6]), V3(1.1, 1.2, 1.2));
      wedgeBlock('foreL', 0, 3, P.foreL, 0.25, V3(-0.025, -0.11, 0.01), Q(['y', -PI / 2], ['x', PI / 2], ['y', 0.6]), V3(1.1, 1.2, 1.2), 'lo');

      // Parapet: tipped onto its back into a small head sunk between the
      // shoulders, its open ring now a deep-set face with the eyes burning
      // inside; the front merlons pulled down into a brow, the side ones
      // swept up into horns, the back ones folded over the nape, the spike
      // a stub.
      const HY = ROOK.HEAD_Y;
      const head = (parts) => (n) => parapet(opening('parapet', n, V3(0, HY, 0)), parts, tiers[2]);
      block('skull', V3(0, HY + 0.08, 0), P.head, 0.28, head({ skull: true }), V3(0, 0, 0), Q(['x', PI / 2]), 0.46);
      block('brow', V3(0, HY + 0.21, 0.151), P.head, 0.32, head({ merlons: [7, 0, 1] }), V3(0, 0.085, 0.03), Q(['x', 0.35]), 0.62);
      block('hornR', V3(0.188, HY + 0.21, 0), P.head, 0.33, head({ merlons: [2] }), V3(0.09, 0.065, -0.02), Q(['z', -0.6]), V3(0.7, 2, 0.8));
      block('hornL', V3(-0.188, HY + 0.21, 0), P.head, 0.34, head({ merlons: [6] }), V3(-0.09, 0.065, -0.02), Q(['z', 0.6]), V3(0.7, 2, 0.8));
      block('nape', V3(0, HY + 0.21, -0.151), P.head, 0.3, head({ merlons: [3, 4, 5] }), V3(0, 0.04, -0.06), Q(['x', -0.9]), 0.62);
      block('spike', V3(0, HY + 0.3, 0), P.head, 0.35, head({ spike: true }), V3(0, 0.1, -0.03), Q(['x', -0.7]), 0.26);
      this._blocks = blocks;

      // --- the core: ember flesh between the blocks, glowing joints, the
      // chest rune and eyes, mossy patches; grows in as the golem wakes ---
      const cores = [];
      const core = (bn) => { const n = opening('core', bn, V3(0, 0, 0)); cores.push(n); return n; };
      const chest = core(P.torso);
      ball('chestCore', V3(0, 0.2, -0.03), 0.28, ember, chest, [1, 1, 0.6]);
      limb('waist', V3(0, -0.07, 0), V3(0, 0.08, 0), 0.2, 0.24, ember, chest);
      rock('rune', chest, V3(0, 0.2, 0.105), [0.075, 0.105, 0.05], seed0 + 40, 1, m.magic);
      [-1, 1].forEach((s) => {
        ball(`shoulderJoint${s}`, V3(s * S.x, S.y, 0), 0.09, m.magic, chest);
        rock(`moss${s}`, chest, V3(s * 0.27, 0.355, -0.02), [0.1, 0.03, 0.09], seed0 + 41 + s, 1, moss);
      });
      rock('mossHump', chest, V3(0.04, 0.4, -0.11), [0.12, 0.03, 0.09], seed0 + 44, 1, moss);
      const hips = core(P.pelvis);
      ball('hipCore', V3(0, 0.0, 0), 0.22, ember, hips, [1.4, 0.8, 0.8]);
      [-1, 1].forEach((s) => ball(`hipJoint${s}`, V3(s * H.x, -0.01, 0), 0.08, m.magic, hips));
      const brain = core(P.head);
      [-1, 1].forEach((s) => ball(`eye${s}`, V3(s * 0.029, 0.01, 0.038), 0.026, m.magic, brain, [1.3, 0.6, 0.6]));
      rock('jaw', brain, V3(0, -0.07, 0.03), [0.13, 0.05, 0.1], seed0 + 45, 1);
      rock('mossCap', brain, V3(-0.02, 0.105, -0.03), [0.09, 0.022, 0.08], seed0 + 46, 1, moss);
      [['R', 1], ['L', -1]].forEach(([side, s]) => {
        const arm = core(P['arm' + side]), fore = core(P['fore' + side]), knee = core(P['knee' + side]);
        limb(`armCore${side}`, V3(-s * 0.02, -0.03, 0), V3(-s * 0.02, -ROOK.UPPER + 0.03, 0), 0.12, 0.105, rockMat, arm);
        ball(`elbow${side}`, V3(0, 0, 0), 0.085, m.magic, fore);
        limb(`foreCore${side}`, V3(-s * 0.015, -0.03, 0), V3(-s * 0.015, -ROOK.FORE + 0.01, 0), 0.11, 0.1, rockMat, fore);
        ball(`fistCore${side}`, V3(0, -ROOK.FORE - 0.05, 0.03), 0.13, ember, fore);
        ball(`knee${side}`, V3(0, 0, 0.01), 0.075, m.magic, knee);
      });
      this._cores = cores;

      P.extraPivots = pivots;
      this._morph = 1;
      this._setTowerMorph(1);
    }

    // Draw calls: the golem's blocks move independently, so instead of one
    // mesh per block and material it becomes one skinned mesh per material.
    // Every skeleton node, block and core node gets a bone linked to it
    // (Babylon copies the node's local transform each frame), and each
    // vertex rides on the bone of the node it hangs from.
    _skinGolem() {
      const scene = this.scene, id = this.id, golem = this._golemRoot, VB = BABYLON.VertexBuffer;
      const rigid = new Set([...this._bones, ...this._blocks.map((b) => b.node), ...this._cores]);
      rigid.delete(golem);
      [this.root, ...this.root.getDescendants(false)].forEach((n) => n.computeWorldMatrix(true));
      const skeleton = new BABYLON.Skeleton(`golemSkel_${id}`, `golemSkel_${id}`, scene);
      const boneOf = new Map();
      const addBones = (node, parentBone) => node.getChildren((n) => !(n instanceof BABYLON.AbstractMesh), true).forEach((n) => {
        if (!rigid.has(n)) return;
        const q = n.rotationQuaternion || BABYLON.Quaternion.RotationYawPitchRoll(n.rotation.y, n.rotation.x, n.rotation.z);
        const bone = new BABYLON.Bone(`${n.name}Bone`, skeleton, parentBone, BABYLON.Matrix.Compose(n.scaling, q, n.position));
        bone.linkTransformNode(n);
        boneOf.set(n, skeleton.bones.indexOf(bone));
        addBones(n, bone);
      });
      addBones(golem, null);
      const gInv = golem.getWorldMatrix().clone().invert(), groups = new Map();
      golem.getChildMeshes(false).forEach((mesh) => {
        if (!mesh.material || !mesh.getTotalVertices()) return;
        let n = mesh.parent;
        while (n && !boneOf.has(n)) n = n.parent;
        if (!groups.has(mesh.material)) groups.set(mesh.material, []);
        groups.get(mesh.material).push([mesh, boneOf.get(n)]);
      });
      const merged = [], gone = new Set();
      groups.forEach((list, mat) => {
        const pos = [], nrm = [], uvs = [], idx = [], mi = [], mw = [];
        list.forEach(([mesh, bi]) => {
          const M = mesh.getWorldMatrix().multiply(gInv), N = M.clone().invert().transpose(), flip = M.determinant() < 0;
          const p = mesh.getVerticesData(VB.PositionKind), n = mesh.getVerticesData(VB.NormalKind), u = mesh.getVerticesData(VB.UVKind);
          const ind = mesh.getIndices(), base = pos.length / 3, v = new BABYLON.Vector3();
          for (let i = 0; i < p.length / 3; i++) {
            BABYLON.Vector3.TransformCoordinatesFromFloatsToRef(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], M, v);
            pos.push(v.x, v.y, v.z);
            BABYLON.Vector3.TransformNormalFromFloatsToRef(n[i * 3], n[i * 3 + 1], n[i * 3 + 2], N, v);
            v.normalize();
            nrm.push(v.x, v.y, v.z);
            uvs.push(u ? u[i * 2] : 0, u ? u[i * 2 + 1] : 0);
            mi.push(bi, 0, 0, 0); mw.push(1, 0, 0, 0);
          }
          for (let i = 0; i < ind.length; i += 3) {
            idx.push(base + ind[i], base + (flip ? ind[i + 2] : ind[i + 1]), base + (flip ? ind[i + 1] : ind[i + 2]));
          }
          gone.add(mesh);
        });
        const mesh = new BABYLON.Mesh(`golem_${mat.name}`, scene), vd = new BABYLON.VertexData();
        vd.positions = pos; vd.normals = nrm; vd.uvs = uvs; vd.indices = idx;
        vd.applyToMesh(mesh);
        mesh.setVerticesData(VB.MatricesIndicesKind, mi, false, 4);
        mesh.setVerticesData(VB.MatricesWeightsKind, mw, false, 4);
        mesh.skeleton = skeleton;
        mesh.numBoneInfluencers = 1;
        mesh.alwaysSelectAsActiveMesh = true;   // bounds are the bind pose's
        mesh.parent = golem; mesh.material = mat; mesh.receiveShadows = true;
        mesh.isPickable = true; mesh.metadata = { characterId: id };
        merged.push(mesh);
      });
      gone.forEach((mesh) => mesh.dispose());
      this._meshes = this._meshes.filter((m) => !gone.has(m)).concat(merged);
      this._golemSkeleton = skeleton;
    }

    dispose() {
      if (this._golemSkeleton) this._golemSkeleton.dispose();
      super.dispose();
    }

    // Each bone's transform relative to the visual node (the frame the keep
    // is built in), from the bones' current local transforms.
    _boneMatrices() {
      const rel = new Map();
      this._bones.forEach((b) => {
        const q = b.rotationQuaternion || BABYLON.Quaternion.RotationYawPitchRoll(b.rotation.y, b.rotation.x, b.rotation.z);
        const local = BABYLON.Matrix.Compose(b.scaling, q, b.position);
        const parent = rel.get(b.parent);
        rel.set(b, parent ? local.multiply(parent) : local);
      });
      rel.forEach((mat, b) => rel.set(b, mat.invert()));
      return rel;   // inverted: visual space -> bone space
    }

    // Puts a block at pos/rot/scl given in keep (visual) space, blended by
    // t towards its place in the golem.
    _placeBlock(b, inv, pos, rot, scl, t) {
      const n = b.node, s = new BABYLON.Vector3(), q = new BABYLON.Quaternion(), p = new BABYLON.Vector3();
      BABYLON.Matrix.Compose(scl, rot, pos).multiply(inv.get(b.bone)).decompose(s, q, p);
      n.position.copyFrom(BABYLON.Vector3.Lerp(p, b.gPos, t));
      n.rotationQuaternion.copyFrom(BABYLON.Quaternion.Slerp(q, b.gRot, t));
      n.scaling.copyFrom(BABYLON.Vector3.Lerp(s, b.gScale, t));
    }

    // Keep <-> golem blend, m = 0 (keep) .. 1 (golem). Staged: the keep
    // trembles and its mortar cracks with light climbing tier by tier, the
    // blocks lift loose and drift apart, then fly one after another to their
    // places on the crouching golem; last the core, eyes and rune ignite
    // and it rises. At m = 0 the merged keep stands in for the blocks.
    _setTowerMorph(m) {
      const G = this._rookGlow, St = ROOK.STAGE, one = new BABYLON.Vector3(1, 1, 1);
      this._morph = m;
      const on = m > 0, wake = smoothstep(St.wake0, 1, m);
      this._keep.setEnabled(!on);
      this._golemRoot.setEnabled(on);
      const g = BABYLON.Color3.Lerp(G.dim, G.lit, wake);
      G.mat.__baseEmissive = g;
      G.mat.emissiveColor = g.clone();
      if (!on) return;
      this._applyPose(blendPose(ROOK_POSE.crouch, ROOK_POSE.rest, wake));
      G.tiers.forEach((mat, i) => {
        const k = smoothstep(i * 0.05, St.crack + i * 0.05, m) * (1 - 0.88 * wake);
        mat.__baseEmissive = G.lit.scale(1.15 * k);
        mat.emissiveColor = mat.__baseEmissive.clone();
      });
      const grow = smoothstep(0.42, 0.9, m);
      this._cores.forEach((n) => { n.scaling.setAll(Math.max(0.001, grow)); n.setEnabled(grow > 0.001); });
      G.ember.__baseEmissive = G.lit.scale(0.45 * grow);
      G.ember.emissiveColor = G.ember.__baseEmissive.clone();
      G.magic.__baseEmissive = G.magicLit.scale(0.2 + 0.8 * wake);
      G.magic.emissiveColor = G.magic.__baseEmissive.clone();
      const u = Math.min(1, Math.max(0, (m - St.fly0) / (St.fly1 - St.fly0)));
      const tremble = 0.006 * smoothstep(0, St.crack, m) * (1 - smoothstep(St.fly0, St.fly0 + 0.2, m)), now = performance.now() / 160;
      const inv = this._boneMatrices();
      this._blocks.forEach((b, i) => {
        const s = Math.min(1, Math.max(0, (u - b.delay) / (1 - ROOK.STAGGER)));
        const lift = smoothstep(0, 0.4, s), fly = smoothstep(0.3, 1, s);
        if (fly >= 1) {
          b.node.position.copyFrom(b.gPos); b.node.rotationQuaternion.copyFrom(b.gRot); b.node.scaling.copyFrom(b.gScale);
          return;
        }
        const pos = b.c.add(b.hover.scale(lift));
        pos.x += tremble * Math.sin(now * 7 + i * 2.1); pos.z += tremble * Math.cos(now * 9 + i * 1.3);
        this._placeBlock(b, inv, pos, BABYLON.Quaternion.RotationAxis(b.axis, b.spin * lift), one, fly);
      });
    }

    // Sets the golem's bones from a pose (see ROOK_POSE); the legs reach for
    // their soles on the board by two-bone IK.
    _applyPose(p) {
      const P = this.parts, hy = ROOK.HIP.y + p.hipY;
      this._golemPose = p;
      P.pelvis.position.set(0, hy, p.hipZ);
      P.torso.rotation.set(p.lean, p.twist, p.roll);
      P.head.rotation.x = p.headX;
      P.armR.rotation.set(p.armRX, 0, p.armRZ); P.armL.rotation.set(p.armLX, 0, -p.armLZ);
      P.foreR.rotation.x = p.foreRX; P.foreL.rotation.x = p.foreLX;
      this._legIK('R', hy, p.hipZ, p.footRZ, p.footRY);
      this._legIK('L', hy, p.hipZ, p.footLZ, p.footLY);
    }

    // Thigh/knee angles that put the sole at (footZ, SOLE + lift) under a hip
    // at (hipY, hipZ); a foot out of reach is drawn in along the board
    // rather than lifted off it. The ankle keeps the foot flat.
    _legIK(side, hipY, hipZ, footZ, lift) {
      const P = this.parts, Tl = ROOK.THIGH, Sl = ROOK.SHIN, reach = Tl + Sl - 1e-4;
      P['leg' + side].position.set((side === 'R' ? 1 : -1) * ROOK.HIP.x, hipY, hipZ);
      const dy = ROOK.SOLE + (lift || 0) - hipY;
      let dz = footZ - hipZ;
      if (dz * dz + dy * dy > reach * reach) dz = Math.sign(dz) * Math.sqrt(Math.max(0, reach * reach - dy * dy));
      const d = Math.max(1e-4, Math.min(reach, Math.hypot(dz, dy)));
      const phi = Math.atan2(-dz, -dy);
      const a = phi - Math.acos(Math.min(1, Math.max(-1, (Tl * Tl + d * d - Sl * Sl) / (2 * Tl * d))));
      const b = Math.PI - Math.acos(Math.min(1, Math.max(-1, (Tl * Tl + Sl * Sl - d * d) / (2 * Tl * Sl))));
      P['leg' + side].rotation.x = a;
      P['knee' + side].rotation.x = b;
      P['ankle' + side].rotation.x = -(a + b);
    }

    _golemRestPose() { return Object.assign({}, ROOK_POSE.rest); }

    // Tweens the golem from its current pose to `target`, plus any
    // [object, property, value] triples alongside.
    _poseTo(target, ms, ease, extra) {
      const from = this._golemPose || this._golemRestPose(), list = extra || [], start = list.map(([o, k]) => o[k]);
      return Tween.run(ms, (t) => {
        this._applyPose(blendPose(from, target, t));
        list.forEach(([o, k, v], i) => { o[k] = start[i] + (v - start[i]) * t; });
      }, ease);
    }

    // Wakes the keep into the golem (target 1) or settles it back (0). Up:
    // the keep shudders as its cracks light, chips and sparks burst off as
    // the blocks break loose, and once assembled the golem roars. Down: the blocks fly home, the keep hangs a moment and
    // drops onto its base in a puff of dust.
    async _morphTo(target) {
      const from = this._morph;
      if (from === target) return;
      const fx = this.ctx.effects, L = ROOK_LIVERY[this.color] || ROOK_LIVERY.w, up = target > from, St = ROOK.STAGE;
      const team = Config.TEAM[this.color], pos = this.root.position.clone(), V3 = (x, y, z) => new BABYLON.Vector3(x, y, z);
      let broke = false;
      await Tween.run(up ? ROOK.MORPH_IN : ROOK.MORPH_OUT, (t, raw) => {
        const m = from + (target - from) * t;
        this._setTowerMorph(m);
        const shake = up ? smoothstep(0, St.crack * 0.6, m) * (1 - smoothstep(St.fly0, St.fly0 + 0.15, m)) : 0.4 * smoothstep(0.2, 0, m);
        this.visual.position.x = 0.012 * shake * Math.sin(raw * 110);
        if (!up) this.visual.position.y = this.selectLift + 0.05 * smoothstep(0.32, 0.08, m);
        if (up && !broke && m > St.fly0 && fx && fx.burst) {
          broke = true;
          fx.burst({ pos: pos.add(V3(0, 0.45, 0)), color1: L.brick, color2: L.dark, count: 26,
            speed: { min: 0.8, max: 2.2 }, life: 0.7, size: 0.06, gravity: [0, -6, 0], blend: 'STANDARD' });
          fx.burst({ pos: pos.add(V3(0, 0.5, 0)), color1: team.glow, color2: '#ffffff', count: 20,
            speed: { min: 0.5, max: 1.6 }, life: 0.5, size: 0.05 });
          if (fx.dustPuff) fx.dustPuff(pos);
        }
      }, Ease.linear);
      this.visual.position.x = 0;
      if (up) {
        // The roar: it rears up, arms flung wide, eyes and rune flaring.
        const G = this._rookGlow;
        if (fx && fx.burst) {
          fx.burst({ pos: pos.add(V3(0, 0.6, 0)), color1: team.glow, color2: '#ffffff', count: 24, speed: { min: 0.8, max: 2 }, life: 0.45, size: 0.06 });
        }
        await this._poseTo(ROOK_POSE.roar, ROOK.ROAR * 0.45, Ease.outCubic);
        await this._poseTo(this._golemRestPose(), ROOK.ROAR * 0.55, Ease.inOutCubic);
        G.magic.emissiveColor = G.magic.__baseEmissive.clone();
      } else {
        await Tween.run(120, (t) => { this.visual.position.y = this.selectLift + 0.05 * (1 - t); }, Ease.inCubic);
        this.visual.position.y = this.selectLift;
        if (fx && fx.dustPuff) fx.dustPuff(pos);
        if (fx && fx.burst) {
          fx.burst({ pos: pos.add(V3(0, 0.08, 0)), color1: L.rock, color2: L.dark, count: 16,
            speed: { min: 0.6, max: 1.4 }, life: 0.5, size: 0.05, gravity: [0, -5, 0], blend: 'STANDARD' });
        }
      }
    }

    // The golem's stride: heavy, lurching steps, each foot planted on the
    // board (IK) while the body heaves over it, shoulders rolling and the
    // long arms swinging against the legs; dust and grit at each footfall.
    async _golemWalk(pos) {
      const fx = this.ctx.effects, R = ROOK_POSE.rest, L = ROOK_LIVERY[this.color] || ROOK_LIVERY.w;
      const from = this.root.position.clone(), dx = pos.x - from.x, dz = pos.z - from.z, D = Math.hypot(dx, dz);
      if (D < 1e-3) return;
      // n strides, then the trailing foot closes up; soles in path distance.
      const n = Math.max(2, Math.ceil(D / ROOK.STRIDE)), N = n + 1, feet = { R: 0, L: 0 }, steps = [];
      for (let k = 1; k <= N; k++) {
        const side = k % 2 ? 'R' : 'L', other = side === 'R' ? 'L' : 'R', to = Math.min(D, k * D / n);
        steps.push({ side, from: feet[side], to, other: feet[other] });
        feet[side] = to;
      }
      const ms = Math.max(800, Math.min(2400, N * ROOK.STEP));
      let landed = -1;
      const footfall = (st) => {
        if (!fx) return;
        const foot = this.parts['ankle' + st.side].getAbsolutePosition().clone();
        foot.y = Config.BOARD_Y + 0.05;
        if (fx.dustPuff) fx.dustPuff(foot);
        if (fx.burst) {
          fx.burst({ pos: foot, color1: L.rock, color2: L.dark, count: 8, speed: { min: 0.4, max: 1 }, life: 0.4, size: 0.04,
            gravity: [0, -5, 0], blend: 'STANDARD' });
        }
      };
      await Tween.run(ms, (_, raw) => {
        const x = raw * N, k = Math.min(N - 1, Math.floor(x)), f = Math.min(1, x - k), st = steps[k];
        if (k > landed + 1) { footfall(steps[k - 1]); landed = k - 1; }
        const e = f * f * (3 - 2 * f), swing = st.from + (st.to - st.from) * e, s = (swing + st.other) / 2;
        this.root.position.x = from.x + dx * s / D;
        this.root.position.z = from.z + dz * s / D;
        const sg = st.side === 'R' ? 1 : -1, arc = Math.sin(Math.PI * f), lift = (k === N - 1 ? 0.04 : 0.075) * arc;
        const fR = (st.side === 'R' ? swing : st.other) - s, fL = (st.side === 'L' ? swing : st.other) - s, d = fL - fR;
        this._applyPose(Object.assign({}, R, {
          hipY: R.hipY - 0.04 + 0.03 * arc,      // heaves up over the stance leg, drops at the footfall
          lean: R.lean + 0.06,
          twist: -sg * 0.13 * arc, roll: sg * 0.07 * arc,
          headX: R.headX - 0.05,
          armRX: R.armRX - 1.2 * d, armLX: R.armLX + 1.2 * d,
          foreRX: R.foreRX - 0.35 * Math.max(0, d), foreLX: R.foreLX - 0.35 * Math.max(0, -d),
          footRZ: fR, footLZ: fL,
          footRY: st.side === 'R' ? lift : 0, footLY: st.side === 'L' ? lift : 0
        }));
      }, Ease.linear);
      footfall(steps[N - 1]);
      this.root.position.x = pos.x;
      this.root.position.z = pos.z;
    }

    // Rook: the keep wakes into the golem, strides over and — unless it is
    // closing in for a capture — turns home and settles back into a keep.
    async _rookMoveTo(pos, opts) {
      opts = opts || {};
      this.busy = true;
      if (this._morph < 1) await this._morphTo(1);
      await this.faceTowards(pos, TIMING.turn * 1.6);
      await this._golemWalk(pos);
      await this._poseTo(this._golemRestPose(), 180, Ease.outCubic);
      if (!opts.keepFacing) {
        await this.faceHome(TIMING.turn * 1.6);
        await this._morphTo(0);
      }
      this.busy = false;
    }

    // Death: the keep bursts into its blocks, which are flung out, tumble
    // and come to rest in a heap of rubble as the light in the cracks dies.
    async _crumble() {
      const fx = this.ctx.effects, L = ROOK_LIVERY[this.color] || ROOK_LIVERY.w, G = this._rookGlow;
      const pos = this.root.position.clone(), team = Config.TEAM[this.color];
      if (this._morph === 0) this._setTowerMorph(1e-4);
      this._cores.forEach((n) => n.setEnabled(false));
      if (fx && fx.burst) {
        fx.burst({ pos: pos.add(new BABYLON.Vector3(0, 0.5, 0)), color1: L.brick, color2: L.rock, count: 34,
          speed: { min: 0.8, max: 2.2 }, life: 0.8, size: 0.08, gravity: [0, -6, 0], blend: 'STANDARD' });
        fx.burst({ pos: pos.add(new BABYLON.Vector3(0, 0.5, 0)), color1: team.glow, color2: '#ffffff', count: 16,
          speed: { min: 0.5, max: 1.5 }, life: 0.5, size: 0.05 });
      }
      const rand = rng(this.id.length * 31 + 7), g = 5.5, one = new BABYLON.Vector3(1, 1, 1);
      const inv = this._boneMatrices();
      const fall = this._blocks.map((b) => {
        const out = new BABYLON.Vector3(b.c.x, 0, b.c.z);
        if (out.length() < 0.03) out.set(rand() - 0.5, 0, rand() - 0.5);
        out.normalize().scaleInPlace(0.25 + 0.45 * rand());
        const vy = 0.3 + 0.9 * rand(), rest = ROOK.SOLE + 0.03 + 0.12 * rand() * Math.min(1, b.c.y);
        // time to land: rest = c.y + vy t - g t^2 / 2
        const land = (vy + Math.sqrt(vy * vy + 2 * g * Math.max(0, b.c.y - rest))) / g;
        return { b, out, vy, rest, land, axis: b.axis, spin: (2 + 4 * rand()) * Math.sign(b.spin) };
      });
      const dur = TIMING.death * 1.6, dust = new Set();
      await Tween.run(dur, (_, raw) => {
        const t = raw * dur / 1000;
        fall.forEach((f, i) => {
          const tt = Math.min(t, f.land), p = f.b.c.add(f.out.scale(tt));
          p.y = t >= f.land ? f.rest : f.b.c.y + f.vy * tt - g * tt * tt / 2;
          if (t >= f.land && !dust.has(i) && fx && fx.dustPuff && i % 4 === 0) {
            dust.add(i);
            fx.dustPuff(BABYLON.Vector3.TransformCoordinates(p, this.visual.getWorldMatrix()));
          }
          this._placeBlock(f.b, inv, p, BABYLON.Quaternion.RotationAxis(f.axis, f.spin * tt), one, 0);
        });
        const k = 1.2 * (1 - raw) * (1 - raw);
        G.tiers.forEach((mat) => { mat.__baseEmissive = G.lit.scale(k); });
        this.setFlash(0.8 * Math.max(0, 1 - raw * 4));   // the death flash fades off the rubble
      }, Ease.linear);
    }

    // Queen: a court queen after the painted reference — an ivory mermaid
    // gown with a lace hem under a V-necked bodice traced in gold filigree,
    // curling gold pauldrons, long satin gloves with gold vambraces, auburn
    // hair under a tall splayed crown, a floor-length cape with braided gold
    // trim, and a gold staff whose flame-shaped cage holds a crystal shard.
    _buildQueen(team) {
      const scene = this.scene, m = this.mats, id = this.id;
      const MB = BABYLON.MeshBuilder;
      const { V3, P3, UP, pbr, surface, tube, limb, ball, scroll, ring } = this._kit();
      const L = QUEEN_LIVERY[this.color] || QUEEN_LIVERY.w;
      const gold = m.accent;

      const gown = pbr('gown', '#ffffff', 0, 0.5);
      gown.albedoTexture = makeCanvasTexture(`gownTex_${id}`, 1024, 512, scene, (c, w, h) => drawGownLace(c, w, h, L));
      const satin = pbr('satin', L.satin, 0, 0.45);
      // Deep shade of the team cloth colour: navy for white, wine for black.
      const capeMat = pbr('cape', '#000000', 0, 0.7);
      capeMat.albedoColor = hex(team.cloth).scale(this.color === 'w' ? 0.45 : 0.6);
      capeMat.backFaceCulling = false; capeMat.twoSidedLighting = true;
      const braidTex = makeCanvasTexture(`braidTex_${id}`, 64, 64, scene,
        (c, w, h) => drawStripes(c, w, h, team.accent, hex(team.accent).scale(0.5).toHexString()));
      braidTex.uScale = 2; braidTex.vScale = 60;
      const braid = pbr('braid', '#ffffff', 1, 0.35);
      braid.albedoTexture = braidTex;
      const collarMat = pbr('collar', L.collar, 0.2, 0.5);
      collarMat.backFaceCulling = false; collarMat.twoSidedLighting = true;
      const hairMat = pbr('hair', L.hair, 0, 0.55);
      const eyeMat = pbr('eye', L.eye, 0, 0.3);
      const lipMat = pbr('lips', L.lips, 0, 0.5);
      // Decorative jewels glow like the staff crystal but on their own
      // material: sharing m.magic would merge them into the crystal (parts.orb).
      const gem = new BABYLON.StandardMaterial(`gem_${id}`, scene);
      gem.emissiveColor = hex(L.gem).scale(0.75); gem.disableLighting = true; gem.diffuseColor = BABYLON.Color3.Black();
      this.materials.push(gem);


      const torso = new BABYLON.TransformNode(`torso_${id}`, scene);
      torso.parent = this.visual;
      this.parts.torso = torso;

      // --- gown, bodice, and the skin showing through the neckline ---
      surface('gown', gridVertexData(64, 48, (u, v) => queenGownPoint(Math.PI * (2 * u - 1), v)), gown, torso);
      surface('bodice', gridVertexData(48, 20, (u, v) => {
        const th = Math.PI * (2 * u - 1), top = queenNeckline(th);
        return queenTorsoPoint(th, top - v * (top - QUEEN_TORSO.Y0));
      }), satin, torso);
      surface('chest', gridVertexData(32, 14, (u, v) => queenTorsoPoint(Math.PI * (2 * u - 1), 0.84 - v * 0.24, 0.965)), m.skin, torso);
      const neck = MB.CreateCylinder(`neck_${id}`, { diameterTop: 0.036, diameterBottom: 0.042, height: 0.1, tessellation: 16 }, scene);
      neck.position.set(0, 0.84, 0.002);
      this._add(neck, torso, m.skin);

      // --- gold: neckline trim, belt over the waist seam, filigree, jewels ---
      tube('neckTrim', ring((th) => queenTorsoPoint(th, queenNeckline(th), 1.03), 72), 0.0035, gold, torso);
      tube('belt', ring((th) => queenGownPoint(th, 0, 0.003), 48), 0.005, gold, torso);
      ball('sternumGem', P3(queenTorsoPoint(0, queenNeckline(0) - 0.014, 1.05)), 0.02, gem, torso, [0.7, 1.3, 0.5]);
      const medal = P3(queenGownPoint(0, 0.03, 0.006));
      const medallion = MB.CreateTorus(`medallion_${id}`, { diameter: 0.032, thickness: 0.006, tessellation: 16 }, scene);
      medallion.position = medal; medallion.rotation.x = Math.PI / 2;
      this._add(medallion, torso, gold);
      ball('medallionGem', medal.add(V3(0, 0, 0.003)), 0.018, gem, torso, [1, 1, 0.6]);
      [-1, 1].forEach((s) => {
        scroll(`medalCurl${s}`, medal.add(V3(s * 0.026, 0.004, -0.004)), V3(s, 0, 0), UP, 0.013, 1.1, 0.003, torso, Math.PI);
        // under-bust filigree sweeping out from the V
        const bust = [];
        for (let i = 0; i <= 12; i++) {
          const th = s * 1.1 * i / 12;
          bust.push(P3(queenTorsoPoint(th, 0.622 + 0.03 * Math.abs(th), 1.03)));
        }
        tube(`bustLine${s}`, bust, 0.003, gold, torso, 0.5);
        // two lines down the skirt front, converging toward the knee
        const skirt = [];
        for (let i = 0; i <= 14; i++) {
          const v = 0.05 + 0.4 * i / 14;
          skirt.push(P3(queenGownPoint(s * (0.36 - 0.3 * i / 14), v, 0.003)));
        }
        tube(`skirtLine${s}`, skirt, 0.003, gold, torso, 0.6);
        // leaf-shaped gold plates at the hips, lower edges flared out
        [[1.3, 0.16, 1], [0.95, 0.21, 0.75]].forEach(([th, v, k], i) => {
          const plate = ball(`hipPlate${s}_${i}`, P3(queenGownPoint(s * th, v, 0.006)), 0.07, gold, torso, [0.08, 1.8 * k, 0.6 * k]);
          plate.rotation.set(0, s * th - Math.PI / 2, 0.22);
        });
        ball(`hipGem${s}`, P3(queenGownPoint(s * 1.3, 0.1, 0.014)), 0.013, gem, torso);
      });
      [0.12, 0.2, 0.28].forEach((v, i) => ball(`dropGem${i}`, P3(queenGownPoint(0, v, 0.004)), 0.012 - i * 0.002, gem, torso));

      // --- pauldrons: layered gold domes with upswept curls ---
      [-1, 1].forEach((s) => {
        const dome = MB.CreateSphere(`pauldron_${id}_${s}`, { diameter: 0.085, slice: 0.5, segments: 14, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        dome.position.set(s * 0.1, 0.752, 0);
        dome.scaling.set(1, 0.75, 1.15);
        dome.rotation.z = -s * 0.5;
        this._add(dome, torso, gold);
        const lame = MB.CreateSphere(`pauldronLame_${id}_${s}`, { diameter: 0.074, slice: 0.5, segments: 12, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        lame.position.set(s * 0.122, 0.722, 0);
        lame.scaling.set(1, 0.7, 1.05);
        lame.rotation.z = -s * 0.95;
        this._add(lame, torso, gold);
        scroll(`pauldronCurl${s}`, V3(s * 0.108, 0.8, -0.01), V3(s, 0, 0), UP, 0.03, 1.3, 0.005, torso);
        scroll(`pauldronCurlF${s}`, V3(s * 0.1, 0.775, 0.035), V3(s, 0, 0), UP, 0.016, 1.2, 0.0035, torso);
        ball(`pauldronGem${s}`, V3(s * 0.1, 0.762, 0.046), 0.014, gem, torso);
      });

      // --- standing collar behind the neck ---
      const collarPt = (u, v) => {
        const th = Math.PI + (2 * u - 1) * 1.45, r = 0.044 + 0.03 * (1 - v);
        return [r * 1.2 * Math.sin(th), 0.875 - 0.1 * v, r * Math.cos(th) - 0.004];
      };
      surface('collar', gridVertexData(24, 6, collarPt), collarMat, torso);
      const collarRim = [];
      for (let i = 0; i <= 24; i++) collarRim.push(P3(collarPt(i / 24, 0)));
      tube('collarRim', collarRim, 0.003, gold, torso);

      // --- cape with braided gold trim down both edges and round the hem ---
      surface('cape', gridVertexData(48, 40, (u, v) => queenCapePoint(u, v)), capeMat, torso);
      const capeEdge = (u) => {
        const path = [];
        for (let j = 0; j <= 40; j++) path.push(P3(queenCapePoint(u, j / 40)));
        return path;
      };
      tube('capeEdgeR', capeEdge(0), 0.0055, braid, torso);
      tube('capeEdgeL', capeEdge(1), 0.0055, braid, torso);
      const capeHem = [];
      for (let i = 0; i <= 60; i++) capeHem.push(P3(queenCapePoint(i / 60, 1)).add(V3(0, 0.004, 0)));
      tube('capeHem', capeHem, 0.0055, braid, torso);

      // --- head: face, auburn hair, tall splayed crown ---
      const head = new BABYLON.TransformNode(`head_${id}`, scene);
      head.parent = torso; head.position.y = 0.9;
      this.parts.head = head;
      ball('face', V3(0, 0, 0), 0.115, m.skin, head, [0.88, 1.12, 1]);
      ball('nose', V3(0, -0.006, 0.055), 0.016, m.skin, head, [0.7, 1.3, 0.8]);
      ball('lips', V3(0, -0.03, 0.049), 0.014, lipMat, head, [1.5, 0.55, 0.6]);
      [-1, 1].forEach((s) => {
        ball(`eye${s}`, V3(s * 0.02, 0.008, 0.05), 0.013, eyeMat, head, [1.3, 0.55, 0.5]);
        // locks framing the face, falling behind the shoulders
        tube(`lock${s}`, [V3(s * 0.048, 0.03, 0.02), V3(s * 0.058, -0.03, 0.012), V3(s * 0.062, -0.08, -0.005),
          V3(s * 0.072, -0.14, -0.03), V3(s * 0.08, -0.2, -0.045)], 0.02, hairMat, head, 0.5);
      });
      ball('hairCap', V3(0, 0.014, -0.012), 0.124, hairMat, head, [0.95, 1.08, 1.02]);
      const fall = tube('hairFall', [V3(0, 0.03, -0.04), V3(0, -0.03, -0.07), V3(0, -0.09, -0.095), V3(0, -0.15, -0.108),
        V3(0, -0.21, -0.116), V3(0, -0.27, -0.12)], 0.04, hairMat, head, 0.8);
      fall.scaling.x = 1.35;

      const CROWN_Y = 0.05, CROWN_Z = -0.008, CROWN_R = 0.061, CROWN_D = 0.92;
      const band = MB.CreateCylinder(`crownBand_${id}`, { diameterTop: 0.124, diameterBottom: 0.116, height: 0.026, tessellation: 32, cap: BABYLON.Mesh.NO_CAP, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
      band.position.set(0, CROWN_Y, CROWN_Z); band.scaling.z = CROWN_D;
      this._add(band, head, gold);
      [[0.126, CROWN_Y + 0.013], [0.118, CROWN_Y - 0.013]].forEach(([d, y], i) => {
        const rim = MB.CreateTorus(`crownRim${i}_${id}`, { diameter: d, thickness: 0.005, tessellation: 32 }, scene);
        rim.position.set(0, y, CROWN_Z); rim.scaling.z = CROWN_D;
        this._add(rim, head, gold);
      });
      // [angle from front, height, outward tilt, width]; the tall centre
      // point and the splayed pair beside it read as the reference's crown.
      const SPIKES = [[0, 0.13, 0.04, 0.026], [0.42, 0.06, 0.2, 0.02], [0.85, 0.115, 0.42, 0.024], [1.35, 0.05, 0.3, 0.018],
        [2.0, 0.07, 0.35, 0.02], [2.6, 0.05, 0.3, 0.018], [Math.PI, 0.075, 0.25, 0.02]];
      SPIKES.forEach(([a0, h, tilt, w], i) => [-1, 1].forEach((s) => {
        if (s < 0 && (a0 === 0 || a0 === Math.PI)) return;
        const a = s * a0;
        const dir = V3(Math.sin(tilt) * Math.sin(a), Math.cos(tilt), Math.sin(tilt) * Math.cos(a));
        const base = V3(Math.sin(a) * CROWN_R, CROWN_Y + 0.012, Math.cos(a) * CROWN_R * CROWN_D + CROWN_Z);
        const spike = MB.CreateCylinder(`crownSpike${i}_${id}_${s}`, { diameterTop: 0, diameterBottom: w, height: h, tessellation: 4 }, scene);
        spike.position = base.add(dir.scale(h / 2));
        spike.rotation.set(tilt, a, 0);
        spike.scaling.z = 0.35;
        this._add(spike, head, gold);
      }));
      ball('crownGem', V3(0, CROWN_Y, CROWN_R * CROWN_D + CROWN_Z + 0.002), 0.022, gem, head, [1, 1.25, 0.5]);
      [-1, 1].forEach((s) => ball(`crownGem${s}`, V3(Math.sin(s * 0.85) * CROWN_R, CROWN_Y, Math.cos(0.85) * CROWN_R * CROWN_D + CROWN_Z + 0.003), 0.013, gem, head, [1, 1, 0.5]));

      // --- arms: long satin gloves, gold vambraces with a pointed elbow cop ---
      const makeArm = (side, elbow, hand) => {
        const s = side === 'R' ? 1 : -1;
        const arm = new BABYLON.TransformNode(`arm${side}_${id}`, scene);
        arm.parent = torso; arm.position.set(s * 0.1, 0.742, 0);
        limb(`upperArm${side}`, V3(0, 0, 0), elbow, 0.046, 0.038, satin, arm);
        ball(`elbow${side}`, elbow, 0.038, satin, arm);
        limb(`forearm${side}`, elbow, hand, 0.036, 0.028, satin, arm);
        const dir = hand.subtract(elbow);
        limb(`vambrace${side}`, elbow.add(dir.scale(0.18)), elbow.add(dir.scale(0.78)), 0.046, 0.036, gold, arm);
        limb(`elbowCop${side}`, elbow.add(dir.scale(0.2)), elbow.subtract(dir.normalizeToNew().scale(0.035)), 0.036, 0, gold, arm);
        ball(`hand${side}`, hand, 0.034, satin, arm, [0.9, 1.15, 1.1]);
        return arm;
      };
      const handR = V3(0.055, -0.215, 0.12);
      const armR = makeArm('R', V3(0.03, -0.165, 0), handR);
      this.parts.armR = armR;
      const handL = V3(-0.05, -0.31, 0.035);
      this.parts.armL = makeArm('L', V3(-0.03, -0.165, 0), handL);
      ball('fingersL', handL.add(V3(0, -0.022, 0.004)), 0.028, satin, this.parts.armL, [0.7, 1.3, 0.9]);

      // --- staff: gold shaft, flame-bladed cage, crystal shard ---
      const staff = new BABYLON.TransformNode(`weapon_${id}`, scene);
      staff.parent = armR; staff.position.copyFrom(handR);
      staff.rotation.set(0.05, 0, -0.32);          // top leans out to her right
      this.parts.weapon = staff;
      const shaft = MB.CreateCylinder(`staffShaft_${id}`, { diameterTop: 0.013, diameterBottom: 0.016, height: 0.74, tessellation: 12 }, scene);
      shaft.position.y = 0.06;
      this._add(shaft, staff, gold);
      const foot = MB.CreateCylinder(`staffFoot_${id}`, { diameterTop: 0.016, diameterBottom: 0, height: 0.045, tessellation: 12 }, scene);
      foot.position.y = -0.3325;
      this._add(foot, staff, gold);
      [-0.045, 0.045, 0.3].forEach((y, i) => {
        const band = MB.CreateTorus(`staffRing${i}_${id}`, { diameter: 0.022, thickness: 0.006, tessellation: 14 }, scene);
        band.position.y = y;
        this._add(band, staff, gold);
      });
      ball('staffKnot', V3(0, 0.3, 0), 0.024, gold, staff);
      [-1, 1].forEach((s) => scroll(`staffCurl${s}`, V3(s * 0.02, 0.3, 0), V3(s, 0, 0), UP, 0.012, 1.1, 0.0028, staff));
      const cup = MB.CreateCylinder(`staffCup_${id}`, { diameterTop: 0.04, diameterBottom: 0.014, height: 0.04, tessellation: 14 }, scene);
      cup.position.y = 0.45;
      this._add(cup, staff, gold);
      [0.15, 0.12, 0.17, 0.11, 0.14].forEach((hh, i) => {
        const a0 = i * Math.PI * 2 / 5 + 0.3, blade = [];
        for (let k = 0; k <= 10; k++) {
          const t = k / 10, r = 0.018 + 0.035 * Math.sin(Math.PI * t) - 0.012 * t, a = a0 + 0.6 * t;
          blade.push(V3(r * Math.cos(a), 0.46 + hh * t, r * Math.sin(a)));
        }
        tube(`staffBlade${i}`, blade, 0.0055, gold, staff, 0.8);
        const mid = blade[4], out = V3(mid.x, 0, mid.z).normalize();
        scroll(`staffBladeCurl${i}`, mid.add(out.scale(0.012)), out, UP, 0.012, 1.1, 0.0028, staff);
      });
      // sizeY (baked into the geometry, not a transform scale) so the idle
      // pulse's uniform scaling.set(s,s,s) keeps the shard's elongation.
      const crystal = MB.CreatePolyhedron(`crystal_${id}`, { type: 1, size: 0.03, sizeY: 0.075 }, scene);
      crystal.position.y = 0.56;
      this._add(crystal, staff, m.magic);
      this.parts.orb = crystal;
    }

    // King: a stout storybook king after the painted reference — an ivory
    // coat with gold bands down the front and round the hem, studded along
    // the opening, a gold belt with a round buckle, flared gold cuffs, gold
    // shoes under blue hose, a floor-length red cape bordered in ermine
    // beneath an ermine shoulder cape, a full beard, and a gold crown with
    // crossed arches over a red velvet cap. Unarmed: his hands rest on the belt.
    _buildKing(team) {
      const scene = this.scene, m = this.mats, id = this.id;
      const MB = BABYLON.MeshBuilder;
      const { V3, P3, pbr, surface, tube, limb, ball, ring } = this._kit();
      const L = KING_LIVERY[this.color] || KING_LIVERY.w;
      const gold = m.accent;
      const line = (fn, n) => {
        const path = [];
        for (let i = 0; i <= n; i++) path.push(P3(fn(i / n)));
        return path;
      };

      const coat = pbr('coat', L.coat, 0, 0.55);
      const trim = pbr('trim', '#ffffff', 1, 0.3);
      trim.albedoTexture = makeCanvasTexture(`trimTex_${id}`, 64, 64, scene,
        (c, w, h) => drawTrim(c, w, h, team.accent, hex(team.accent).scale(0.55).toHexString()));
      const fur = pbr('fur', '#ffffff', 0, 0.85);
      fur.albedoTexture = makeCanvasTexture(`furTex_${id}`, 128, 128, scene, (c, w, h) => drawErmine(c, w, h, L));
      fur.backFaceCulling = false; fur.twoSidedLighting = true;
      const velvet = pbr('cape', L.cape, 0, 0.7);
      velvet.backFaceCulling = false; velvet.twoSidedLighting = true;
      const hose = pbr('hose', L.hose, 0, 0.7);
      const hairMat = pbr('hair', L.hair, 0, 0.65);
      const beardMat = pbr('beard', L.beard, 0, 0.7);
      const eyeMat = pbr('eye', L.eye, 0, 0.3);
      const cheekMat = pbr('cheek', L.cheek, 0, 0.6);
      // Jewels glow on their own materials (see the queen's note on m.magic).
      const jewel = (name, color) => {
        const mat = new BABYLON.StandardMaterial(`${name}_${id}`, scene);
        mat.emissiveColor = hex(color).scale(0.6); mat.disableLighting = true; mat.diffuseColor = BABYLON.Color3.Black();
        this.materials.push(mat);
        return mat;
      };
      const ruby = jewel('ruby', L.gem), sapphire = jewel('sapphire', L.gem2);

      const torso = new BABYLON.TransformNode(`torso_${id}`, scene);
      torso.parent = this.visual;
      this.parts.torso = torso;

      // --- legs: hose and gold shoes below the coat hem ---
      [['R', 1], ['L', -1]].forEach(([side, s]) => {
        const leg = new BABYLON.TransformNode(`leg${side}_${id}`, scene);
        leg.parent = torso; leg.position.set(s * 0.045, 0.24, 0);
        this.parts['leg' + side] = leg;
        limb(`shin${side}`, V3(0, 0, 0), V3(0, -0.14, 0.005), 0.046, 0.04, hose, leg);
        ball(`shoe${side}`, V3(0, -0.148, 0.022), 0.056, gold, leg, [0.95, 0.6, 1.5]);
      });

      // --- coat, gold bands down the front opening and round the hem ---
      const TOP = 0.82, HEM = 0.215, BAND = 0.26;
      surface('coat', gridVertexData(56, 40, (u, v) => kingCoatPoint(Math.PI * (2 * u - 1), TOP - v * (TOP - KING_COAT.Y0))), coat, torso);
      surface('hemBand', tileUVs(gridVertexData(56, 3, (u, v) => kingCoatPoint(Math.PI * (2 * u - 1), HEM - v * (HEM - KING_COAT.Y0), 0.002)), 14, 1), trim, torso);
      [HEM, KING_COAT.Y0 + 0.002].forEach((y, i) => tube(`hemPiping${i}`, ring((th) => kingCoatPoint(th, y, 0.003), 56), 0.0028, gold, torso));
      [-1, 1].forEach((s) => {
        const th0 = s > 0 ? 0.02 : -0.02 - BAND;     // keep theta increasing with u
        surface(`frontBand${s}`, tileUVs(gridVertexData(4, 30, (u, v) => kingCoatPoint(th0 + BAND * u, 0.8 - v * (0.8 - HEM), 0.002)), 1, 19), trim, torso);
        [0.02, 0.02 + BAND].forEach((th, i) => tube(`bandPiping${s}_${i}`, line((t) => kingCoatPoint(s * th, 0.8 - t * (0.8 - HEM), 0.003), 30), 0.0025, gold, torso));
        for (let i = 0, y = 0.255; y < 0.78; i++, y += 0.048) {
          if (y > KING_BELT[0] - 0.02 && y < KING_BELT[1] + 0.02) continue;
          ball(`stud${s}_${i}`, P3(kingCoatPoint(s * 0.34, y, 0.004)), 0.014, gold, torso);
        }
      });
      const neck = MB.CreateCylinder(`neck_${id}`, { diameter: 0.052, height: 0.09, tessellation: 16 }, scene);
      neck.position.set(0, 0.845, 0);
      this._add(neck, torso, m.skin);

      // --- belt with a round buckle ---
      const [B0, B1] = KING_BELT, BY = (B0 + B1) / 2;
      surface('belt', tileUVs(gridVertexData(48, 3, (u, v) => kingCoatPoint(Math.PI * (2 * u - 1), B1 - v * (B1 - B0), 0.006)), 20, 1), trim, torso);
      KING_BELT.forEach((y, i) => tube(`beltEdge${i}`, ring((th) => kingCoatPoint(th, y, 0.007), 48), 0.003, gold, torso));
      const bz = kingCoatPoint(0, BY, 0.006)[2];
      [[0.05, 0.011, 0.006], [0.026, 0.005, 0.012]].forEach(([d, t, z], i) => {
        const r = MB.CreateTorus(`buckle${i}_${id}`, { diameter: d, thickness: t, tessellation: 20 }, scene);
        r.position.set(0, BY, bz + z); r.rotation.x = Math.PI / 2;
        this._add(r, torso, gold);
      });
      ball('buckleBoss', V3(0, BY, bz + 0.008), 0.026, gold, torso, [1, 1, 0.45]);

      // --- ermine shoulder cape, gold-edged and studded ---
      surface('mantle', tileUVs(gridVertexData(64, 12, (u, v) => kingMantlePoint(u, v)), 14, 3), fur, torso);
      tube('mantleRim', line((u) => kingMantlePoint(u, 1, 0.002), 64), 0.0045, gold, torso);
      [0, 1].forEach((u) => tube(`mantleEdge${u}`, line((v) => kingMantlePoint(u, v, 0.002), 12), 0.0045, gold, torso));
      for (let i = 0; i <= 20; i++) ball(`mantleStud${i}`, P3(kingMantlePoint(i / 20, 0.93, 0.006)), 0.012, gold, torso);

      // --- red cape with an ermine border down both edges and round the hem ---
      surface('cape', gridVertexData(56, 40, (u, v) => kingCapePoint(u, v)), velvet, torso);
      const FUR_W = 0.055;
      // Fraction of u spanning FUR_W at height v, so the border keeps its width.
      const furU = (v) => FUR_W * 0.01 / P3(kingCapePoint(0.01, v)).subtract(P3(kingCapePoint(0, v))).length();
      surface('capeFurR', tileUVs(gridVertexData(3, 36, (u, v) => kingCapePoint(u * furU(v), v, 0.005)), 1, 12), fur, torso);
      surface('capeFurL', tileUVs(gridVertexData(3, 36, (u, v) => kingCapePoint(1 - (1 - u) * furU(v), v, 0.005)), 1, 12), fur, torso);
      surface('capeFurHem', tileUVs(gridVertexData(60, 3, (u, v) => kingCapePoint(u, 1 - (FUR_W / 0.7) * (1 - v), 0.003)), 24, 1), fur, torso);
      tube('capeEdgeR', line((v) => kingCapePoint(0, v, 0.005), 40), 0.005, gold, torso);
      tube('capeEdgeL', line((v) => kingCapePoint(1, v, 0.005), 40), 0.005, gold, torso);
      tube('capeHem', line((u) => kingCapePoint(u, 1, 0.005), 60).map((p) => p.add(V3(0, 0.004, 0))), 0.005, gold, torso);

      // --- arms: ivory sleeves, flared gold cuffs, hands resting on the belt ---
      const makeArm = (side, elbow, hand) => {
        const s = side === 'R' ? 1 : -1;
        const arm = new BABYLON.TransformNode(`arm${side}_${id}`, scene);
        arm.parent = torso; arm.position.set(s * 0.118, 0.715, 0);
        ball(`shoulder${side}`, V3(0, 0, 0), 0.05, coat, arm);
        limb(`upperArm${side}`, V3(0, 0, 0), elbow, 0.05, 0.044, coat, arm);
        ball(`elbow${side}`, elbow, 0.044, coat, arm);
        const dir = hand.subtract(elbow);
        limb(`cuff${side}`, elbow, elbow.add(dir.scale(0.82)), 0.046, 0.054, gold, arm);
        limb(`cuffLip${side}`, elbow.add(dir.scale(0.8)), elbow.add(dir.scale(0.86)), 0.058, 0.05, gold, arm);
        ball(`cuffStud${side}`, elbow.add(dir.scale(0.45)).add(V3(0, 0.024, 0)), 0.011, ruby, arm);
        ball(`hand${side}`, hand, 0.036, m.skin, arm, [1, 0.85, 1.1]);
        ball(`thumb${side}`, hand.add(V3(-s * 0.013, 0.011, 0.006)), 0.016, m.skin, arm);
        return arm;
      };
      this.parts.armR = makeArm('R', V3(0.02, -0.15, -0.005), V3(-0.063, -0.215, 0.125));
      this.parts.armL = makeArm('L', V3(-0.02, -0.15, -0.005), V3(0.063, -0.215, 0.125));

      // --- head: rosy face, wavy hair, moustache and full beard ---
      const head = new BABYLON.TransformNode(`head_${id}`, scene);
      head.parent = torso; head.position.set(0, 0.92, 0.005);
      this.parts.head = head;
      ball('face', V3(0, 0, 0), 0.13, m.skin, head, [0.92, 1.05, 0.95]);
      ball('nose', V3(0, -0.002, 0.063), 0.026, m.skin, head, [0.9, 1, 0.85]);
      [-1, 1].forEach((s) => {
        ball(`eye${s}`, V3(s * 0.022, 0.013, 0.056), 0.014, eyeMat, head, [1, 1.15, 0.5]);
        ball(`cheek${s}`, V3(s * 0.034, -0.008, 0.048), 0.028, cheekMat, head, [1, 0.8, 0.5]);
        tube(`brow${s}`, [V3(s * 0.01, 0.032, 0.059), V3(s * 0.023, 0.036, 0.057), V3(s * 0.036, 0.03, 0.05)], 0.0055, hairMat, head, 0.4);
        tube(`moustache${s}`, [V3(s * 0.003, -0.02, 0.068), V3(s * 0.02, -0.023, 0.066), V3(s * 0.035, -0.031, 0.058),
          V3(s * 0.046, -0.044, 0.047)], 0.0095, beardMat, head, 0.65);
        ball(`hairSide${s}`, V3(s * 0.057, -0.012, -0.012), 0.056, hairMat, head, [0.75, 1.15, 1]);
        ball(`hairCurl${s}`, V3(s * 0.054, -0.048, -0.022), 0.046, hairMat, head, [0.85, 1, 1]);
        ball(`sideburn${s}`, V3(s * 0.052, -0.03, 0.018), 0.036, beardMat, head, [0.7, 1.3, 0.9]);
      });
      ball('hairCap', V3(0, 0.012, -0.02), 0.13, hairMat, head, [0.98, 1, 0.95]);
      ball('beard', V3(0, -0.05, 0.022), 0.122, beardMat, head, [0.98, 0.95, 0.72]);
      ball('beardTip', V3(0, -0.095, 0.045), 0.07, beardMat, head, [1, 1.1, 0.75]);

      // --- crown: gold circlet with pearl-tipped points and crossed arches
      // over a red velvet cap, topped by an orb and cross ---
      const CY = 0.058, CR = 0.064;
      const band = MB.CreateCylinder(`crownBand_${id}`, { diameterTop: 0.132, diameterBottom: 0.124, height: 0.032, tessellation: 32,
        cap: BABYLON.Mesh.NO_CAP, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
      band.position.y = CY;
      this._add(band, head, gold);
      [[0.134, CY + 0.016], [0.126, CY - 0.016]].forEach(([d, y], i) => {
        const rim = MB.CreateTorus(`crownRim${i}_${id}`, { diameter: d, thickness: 0.006, tessellation: 32 }, scene);
        rim.position.y = y;
        this._add(rim, head, gold);
      });
      const cap = MB.CreateSphere(`crownCap_${id}`, { diameter: 0.122, slice: 0.5, segments: 16 }, scene);
      cap.position.y = CY + 0.008; cap.scaling.y = 0.95;
      this._add(cap, head, velvet);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4, tall = i % 2 === 0, h = tall ? 0.05 : 0.032, tilt = 0.12;
        const dir = V3(Math.sin(tilt) * Math.sin(a), Math.cos(tilt), Math.sin(tilt) * Math.cos(a));
        const base = V3(Math.sin(a) * CR, CY + 0.014, Math.cos(a) * CR);
        const pt = MB.CreateCylinder(`crownPoint${i}_${id}`, { diameterTop: 0, diameterBottom: tall ? 0.034 : 0.026, height: h, tessellation: 4 }, scene);
        pt.position = base.add(dir.scale(h / 2));
        pt.rotation.set(tilt, a, 0);
        pt.scaling.z = 0.35;
        this._add(pt, head, gold);
        ball(`crownPearl${i}`, base.add(dir.scale(h + 0.004)), tall ? 0.014 : 0.011, gold, head);
        const gem = ball(`crownGem${i}`, V3(Math.sin(a) * 0.067, CY, Math.cos(a) * 0.067), i === 0 ? 0.019 : 0.012,
          tall ? ruby : sapphire, head, i === 0 ? [1, 1.2, 0.5] : [1, 1, 0.5]);
        gem.rotation.y = a;
      }
      [0, Math.PI / 2].forEach((phi, i) => tube(`crownArch${i}`, line((t) => {
        const a = Math.PI * 0.95 * (t - 0.5), r = 0.062 * Math.sin(a);
        return [r * Math.sin(phi), CY + 0.014 + 0.062 * Math.cos(a), r * Math.cos(phi)];
      }, 20), 0.005, gold, head));
      ball('crownOrb', V3(0, 0.142, 0), 0.022, gold, head);
      [[0.006, 0.032, 0.006, 0.165], [0.022, 0.006, 0.006, 0.168]].forEach(([w, hh, d, y], i) => {
        const bar = MB.CreateBox(`crownCross${i}_${id}`, { width: w, height: hh, depth: d }, scene);
        bar.position.y = y;
        this._add(bar, head, gold);
      });
    }

    // --- animation ---------------------------------------------------------
    updateIdle(t) {
      if (this.busy) return;
      const ph = this.idlePhase;
      if (this.type === 'r') {
        // The keep stands still (the giant's poses are tweened); only the
        // light behind its gate and windows flickers like torchlight.
        if (this._morph > 0) return;
        this.visual.position.y = this.selectLift;
        const g = this._rookGlow, f = 0.85 + 0.1 * Math.sin(t * 7.3 + ph) + 0.05 * Math.sin(t * 17.1 + ph * 2);
        g.mat.emissiveColor = g.mat.__baseEmissive.scale(f);
        return;
      }
      this.visual.position.y = this.selectLift + Math.sin(t * 2 + ph) * 0.015;
      if (this.parts.torso) this.parts.torso.rotation.z = Math.sin(t * 1.3 + ph) * 0.02;
      if (this.parts.orb) {
        const s = 1 + Math.sin(t * 4 + ph) * 0.08;
        this.parts.orb.scaling.set(s, s, s);
      }
    }

    setWalking(on) {
      if (on) {
        if (this._walkObserver) return;
        this._walkObserver = this.scene.onBeforeRenderObservable.add(() => {
          const t = performance.now() / 1000;
          this.visual.position.y = this.selectLift + Math.abs(Math.sin(t * 9)) * 0.05;
          if (this.parts.torso) this.parts.torso.rotation.x = 0.12;
          if (this.parts.armL) this.parts.armL.rotation.x = Math.sin(t * 9) * 0.4;
          if (this.parts.armR) this.parts.armR.rotation.x = -Math.sin(t * 9) * 0.4;
          if (this.parts.legL) this.parts.legL.rotation.x = -Math.sin(t * 9) * 0.45;
          if (this.parts.legR) this.parts.legR.rotation.x = Math.sin(t * 9) * 0.45;
        });
      } else if (this._walkObserver) {
        this.scene.onBeforeRenderObservable.remove(this._walkObserver);
        this._walkObserver = null;
        const startTorso = this.parts.torso ? this.parts.torso.rotation.x : 0;
        const startArmL = this.parts.armL ? this.parts.armL.rotation.x : 0;
        const startArmR = this.parts.armR ? this.parts.armR.rotation.x : 0;
        const startLegL = this.parts.legL ? this.parts.legL.rotation.x : 0;
        const startLegR = this.parts.legR ? this.parts.legR.rotation.x : 0;
        Tween.run(120, (t) => {
          if (this.parts.legL) this.parts.legL.rotation.x = startLegL * (1 - t);
          if (this.parts.legR) this.parts.legR.rotation.x = startLegR * (1 - t);
          if (this.parts.torso) this.parts.torso.rotation.x = startTorso * (1 - t);
          if (this.parts.armL) this.parts.armL.rotation.x = startArmL * (1 - t);
          if (this.parts.armR) this.parts.armR.rotation.x = startArmR * (1 - t);
        });
      }
    }

    async playRecover() {
      if (this.type === 'r') {
        return this._poseTo(this._golemRestPose(), TIMING.attackRecover * 1.5, Ease.outCubic,
          [[this.visual.position, 'z', 0], [this.visual.position, 'y', this.selectLift]]);
      }
      const pose = this._pose;
      const startTorso = this.parts.torso ? this.parts.torso.rotation.clone() : null;
      const startArmR = this.parts.armR ? this.parts.armR.rotation.clone() : null;
      const startArmL = this.parts.armL ? this.parts.armL.rotation.clone() : null;
      const startWeapon = this.parts.weapon ? this.parts.weapon.rotation.clone() : null;
      // Lunges/rears offset the whole visual; ease it back onto the square.
      const startVisZ = this.visual.position.z;
      const startVisRotX = this.visual.rotation.x;
      await Tween.run(TIMING.attackRecover, (t) => {
        if (this.parts.torso && pose.torso) this.parts.torso.rotation = BABYLON.Vector3.Lerp(startTorso, pose.torso, t);
        if (this.parts.armR && pose.armR) this.parts.armR.rotation = BABYLON.Vector3.Lerp(startArmR, pose.armR, t);
        if (this.parts.armL && pose.armL) this.parts.armL.rotation = BABYLON.Vector3.Lerp(startArmL, pose.armL, t);
        if (this.parts.weapon && pose.weapon) this.parts.weapon.rotation = BABYLON.Vector3.Lerp(startWeapon, pose.weapon, t);
        this.visual.position.z = startVisZ * (1 - t);
        this.visual.rotation.x = startVisRotX * (1 - t);
      }, Ease.outCubic);
    }

    async playHit() {
      this.busy = true;
      const baseZ = this.visual.position.z;
      if (this.type === 'r') {
        // The keep shudders and sheds chips from the blow.
        const fx = this.ctx.effects, L = ROOK_LIVERY[this.color] || ROOK_LIVERY.w;
        if (fx && fx.burst) {
          fx.burst({ pos: this.root.position.add(new BABYLON.Vector3(0, 0.55, 0)), color1: L.brick, color2: L.dark, count: 14,
            speed: { min: 0.6, max: 1.6 }, life: 0.5, size: 0.05, gravity: [0, -6, 0], blend: 'STANDARD' });
        }
        await Promise.all([
          Tween.run(220, (t) => { this.setFlash(1 - t * t); }, Ease.linear),
          Tween.run(300, (t, raw) => {
            this.visual.position.x = 0.022 * Math.sin(raw * 60) * (1 - t);
            this.visual.position.z = baseZ - 0.08 * Math.sin(t * Math.PI);
          }, Ease.linear)
        ]);
        this.visual.position.x = 0;
        this.visual.position.z = baseZ;
        this.busy = false;
        return;
      }
      await Promise.all([
        Tween.run(220, (t) => { this.setFlash(1 - t * t); }, Ease.linear),
        Tween.run(220, (t) => { this.visual.position.z = baseZ - 0.18 * Math.sin(t * Math.PI); }, Ease.outCubic)
      ]);
      this.visual.position.z = baseZ;
      this.busy = false;
    }

    async playDeath() {
      this.busy = true;
      this.setFlash(0.8);
      if (this.type === 'r') return this._crumble();   // the keep bursts into a heap of rubble
      const baseY = this.visual.position.y;
      await Tween.run(TIMING.death, (t) => {
        this.visual.rotation.x = -Math.PI / 2 * 0.9 * t;
        this.visual.position.y = baseY - 0.1 * t;
      }, Ease.inCubic);
    }

    async playVictory() {
      if (this.type === 'r') {
        // The keep wakes, the golem throws both fists up twice, then settles.
        this.busy = true;
        await this._morphTo(1);
        for (let i = 0; i < 2; i++) {
          await this._poseTo(ROOK_POSE.cheer, 260, Ease.outCubic);
          await this._poseTo(this._golemRestPose(), 260, Ease.inCubic);
        }
        await this._morphTo(0);
        this.busy = false;
        return;
      }
      if (this.parts.armR) this.parts.armR.rotation.x = -2.6;
      // Queen: keep the staff upright while it is held aloft.
      if (this.type === 'q' && this.parts.weapon) this.parts.weapon.rotation.x = this._pose.weapon.x + 2.6;
      const baseY = this.visual.position.y;
      for (let i = 0; i < 2; i++) {
        await Tween.run(160, (t) => { this.visual.position.y = baseY + 0.25 * t; }, Ease.outCubic);
        await Tween.run(160, (t) => { this.visual.position.y = baseY + 0.25 * (1 - t); }, Ease.inCubic);
      }
    }

    async playAttack(targetPos) {
      this.busy = true;
      const fx = this.ctx.effects;
      const team = Config.TEAM[this.color];
      const armR = this.parts.armR;
      const torso = this.parts.torso;
      switch (this.type) {
        case 'p': {
          // Raise the sword overhead behind the shield, then lunge and cut down.
          const armL = this.parts.armL;
          await Tween.run(TIMING.attackWindup, (t) => {
            armR.rotation.x = -2.2 * t;
            if (armL) armL.rotation.x = -0.35 * t;
            this.visual.position.z = -0.08 * t;
          }, Ease.outCubic);
          await Tween.run(TIMING.attackStrike, (t) => {
            armR.rotation.x = -2.2 + 2.7 * t;
            torso.rotation.x = 0.18 * t;
            this.visual.position.z = -0.08 + 0.36 * t;
          }, Ease.inCubic);
          break;
        }
        case 'b': {
          // Raise the staff and stir the sky while a tornado spins up in
          // front of him, then thrust the staff to send it at the target.
          const orb = this.parts.orb;
          const arm = this.parts.armL, staff = this.parts.weapon;
          const arm0 = arm.rotation.x, sx0 = staff.rotation.x, sz0 = staff.rotation.z;
          const vortex = this.castTornado(targetPos);
          await Tween.run(TIMING.tornadoForm, (t, raw) => {
            arm.rotation.x = arm0 - 1.0 * t;
            staff.rotation.x = sx0 + 1.0 * t + 0.3 * Math.sin(raw * Math.PI * 4) * t;
            staff.rotation.z = sz0 + 0.3 * Math.cos(raw * Math.PI * 4) * t - 0.3 * t;
            const s = 1 + 0.8 * t;
            if (orb) { orb.scaling.set(s, s, s); this.setFlash(t * 0.5); }
          }, Ease.outCubic);
          const ax = arm.rotation.x, bx = staff.rotation.x, bz = staff.rotation.z;
          await Tween.run(TIMING.attackStrike, (t) => {
            arm.rotation.x = ax + (arm0 - 0.9 - ax) * t;
            staff.rotation.x = bx + (sx0 + 1.45 - bx) * t;
            staff.rotation.z = bz + (sz0 - bz) * t;
            torso.rotation.x = 0.06 * t;
          }, Ease.inCubic);
          // The windup ramps the orb glow/scale up — bring it back down, or
          // the bishop stays lit up like a torch for the rest of the game.
          if (orb) orb.scaling.set(1, 1, 1);
          this.setFlash(0);
          if (vortex) await vortex.arrived;
          else await Tween.wait(TIMING.projectile);
          break;
        }
        case 'r': {
          // The golem rears back with both fists high overhead, then steps
          // in and hammers them down together onto the target.
          if (this._morph < 1) await this._morphTo(1);
          const y0 = this.selectLift;
          await this._poseTo(ROOK_POSE.windup, TIMING.attackWindup * 1.6, Ease.outCubic, [[this.visual.position, 'y', y0 + 0.03]]);
          await Tween.wait(90);
          await this._poseTo(ROOK_POSE.smash, TIMING.attackStrike * 1.1, Ease.inCubic,
            [[this.visual.position, 'y', y0], [this.visual.position, 'z', 0.08]]);
          const L = ROOK_LIVERY[this.color] || ROOK_LIVERY.w;
          if (fx && fx.burst) {
            fx.burst({ pos: targetPos.add(new BABYLON.Vector3(0, 0.15, 0)), color1: L.rock, color2: L.dark, count: 36,
              speed: { min: 1.5, max: 3.5 }, life: 0.8, size: 0.08, gravity: [0, -7, 0], blend: 'STANDARD' });
          }
          if (fx && fx.dustPuff) fx.dustPuff(targetPos.clone());
          break;
        }
        case 'q': {
          // Raise the staff overhead, counter-rotating it so the crystal
          // tips forward toward the target instead of swinging down behind.
          const orb = this.parts.orb;
          const staff = this.parts.weapon, staff0 = staff ? staff.rotation.x : 0;
          await Tween.run(TIMING.attackWindup, (t) => {
            armR.rotation.x = -2.4 * t;
            if (staff) staff.rotation.x = staff0 + 3.0 * t;
            if (orb) this.setFlash(t * 0.6);
          }, Ease.outCubic);
          if (fx && fx.lightning) {
            const from = orb ? orb.getAbsolutePosition() : this.root.position.clone();
            await fx.lightning(from, targetPos.add(new BABYLON.Vector3(0, 0.5, 0)), team.glow);
          } else {
            await Tween.wait(TIMING.projectile);
          }
          this.setFlash(0); // same leftover-glow issue as the bishop above
          break;
        }
        case 'k': {
          await Tween.run(TIMING.attackWindup, (t) => {
            torso.rotation.y = 0.6 * t;
            armR.rotation.x = -2.4 * t;
          }, Ease.outCubic);
          await Tween.run(TIMING.attackStrike, (t) => {
            torso.rotation.y = 0.6 - 1.1 * t;
            armR.rotation.x = -2.4 + 3.2 * t;
          }, Ease.inCubic);
          if (fx && fx.shockwave) fx.shockwave(targetPos.clone(), team.accent);
          break;
        }
        default:
          await Tween.wait(TIMING.attackWindup + TIMING.attackStrike);
      }
      this.busy = false;
    }
  }

  window.Chess3D.ProceduralCharacter = ProceduralCharacter;
})();
