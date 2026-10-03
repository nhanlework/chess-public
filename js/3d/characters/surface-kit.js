// SurfaceKit: math shared by the parametric characters (knight, king) —
// smooth key curves, Bezier points, (u, v) grids turned into vertex data and
// tubes swept along a curve with a parallel-transported frame.
(function () {
  const TAU = Math.PI * 2;
  function hex(c) { return BABYLON.Color3.FromHexString(c); }
  const V3 = (x, y, z) => new BABYLON.Vector3(x, y, z);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  function smoothstep(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function spow(x, p) { return Math.sign(x) * Math.pow(Math.abs(x), p); }

  // Smooth curve through keys [[t, v0, v1, ...], ...] with any spacing in t
  // (cubic Hermite, Catmull-Rom tangents); returns [v0, v1, ...] at t.
  function curve(keys, t) {
    const n = keys.length - 1;
    if (t <= keys[0][0]) return keys[0].slice(1);
    if (t >= keys[n][0]) return keys[n].slice(1);
    let i = 0;
    while (i < n - 1 && t > keys[i + 1][0]) i++;
    const k0 = keys[i], k1 = keys[i + 1], h = k1[0] - k0[0], s = (t - k0[0]) / h;
    const tan = (j, c) => {
      const a = keys[Math.max(0, j - 1)], b = keys[Math.min(n, j + 1)];
      return (b[c] - a[c]) / (b[0] - a[0]);
    };
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    const out = [];
    for (let c = 1; c < k0.length; c++) out.push(h00 * k0[c] + h10 * h * tan(i, c) + h01 * k1[c] + h11 * h * tan(i + 1, c));
    return out;
  }

  // Point on the Bezier curve with control points `pts` ([x, y, z] arrays).
  function bezier(pts, t) {
    let p = pts;
    while (p.length > 1) p = p.slice(1).map((q, i) => q.map((c, k) => lerp(p[i][k], c, t)));
    return p[0];
  }

  // Parametric surface over a (u, v) grid; fn(u, v) -> [x, y, z] or
  // [x, y, z, texU, texV]. Faces are wound outward (away from the centroid
  // of the middle row) unless opts.inward. opts.closed welds the u seam;
  // capStart/capEnd close the first/last row onto its centroid. Rows that
  // collapse to a point (poles) get one shared normal.
  function grid(nu, nv, fn, opts) {
    opts = opts || {};
    const rows = [];
    for (let j = 0; j <= nv; j++) {
      const row = [];
      for (let i = 0; i <= nu; i++) row.push(fn(i / nu, j / nv));
      rows.push(row);
    }
    const centroid = (row) => {
      const n = opts.closed ? nu : nu + 1, c = [0, 0, 0];
      for (let i = 0; i < n; i++) { c[0] += row[i][0]; c[1] += row[i][1]; c[2] += row[i][2]; }
      return c.map((x) => x / n);
    };
    if (opts.capStart) { const c = centroid(rows[0]); rows.unshift(rows[0].map((p) => [c[0], c[1], c[2], p[3], p[4]])); }
    if (opts.capEnd) { const c = centroid(rows[rows.length - 1]); rows.push(rows[rows.length - 1].map((p) => [c[0], c[1], c[2], p[3], p[4]])); }
    const positions = [], uvs = [], indices = [], W = nu + 1, R = rows.length;
    rows.forEach((row, j) => row.forEach((p, i) => {
      positions.push(p[0], p[1], p[2]);
      uvs.push(p.length > 3 && p[3] !== undefined ? p[3] : i / nu, p.length > 4 && p[4] !== undefined ? p[4] : 1 - j / (R - 1));
    }));
    for (let j = 0; j < R - 1; j++) {
      for (let i = 0; i < nu; i++) {
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    let normals = [];
    BABYLON.VertexData.ComputeNormals(positions, indices, normals);
    const m = Math.floor(R / 2), cen = centroid(rows[m]);
    let facing = 0;
    for (let i = 0; i <= nu; i++) {
      const k = (m * W + i) * 3;
      facing += normals[k] * (positions[k] - cen[0]) + normals[k + 1] * (positions[k + 1] - cen[1]) + normals[k + 2] * (positions[k + 2] - cen[2]);
    }
    if (opts.flip !== undefined ? opts.flip : ((facing < 0) !== !!opts.inward)) {
      for (let k = 0; k < indices.length; k += 3) { const t = indices[k + 1]; indices[k + 1] = indices[k + 2]; indices[k + 2] = t; }
      normals = normals.map((x) => -x);
    }
    const avg = (ids) => {
      let x = 0, y = 0, z = 0;
      ids.forEach((v) => { x += normals[v * 3]; y += normals[v * 3 + 1]; z += normals[v * 3 + 2]; });
      const l = Math.hypot(x, y, z) || 1;
      ids.forEach((v) => { normals[v * 3] = x / l; normals[v * 3 + 1] = y / l; normals[v * 3 + 2] = z / l; });
    };
    for (let j = 0; j < R; j++) {
      const row = rows[j], p0 = row[0];
      const pole = row.every((p) => Math.abs(p[0] - p0[0]) + Math.abs(p[1] - p0[1]) + Math.abs(p[2] - p0[2]) < 1e-7);
      if (pole) avg(row.map((_, i) => j * W + i));
      else if (opts.closed) avg([j * W, j * W + nu]);
    }
    const vd = new BABYLON.VertexData();
    vd.positions = positions; vd.indices = indices; vd.normals = normals; vd.uvs = uvs;
    return vd;
  }

  // Tube swept along centre(t) -> [x, y, z]. section(t, a) -> [dn, db] gives
  // the offset in the (N, B) frame around the tangent: N starts along
  // opts.side and is parallel-transported down the tube, B = T x N.
  function sweep(nu, nv, centre, section, opts) {
    opts = opts || {};
    const C = [], T = [], F = [];
    for (let j = 0; j <= nv; j++) C.push(V3(...centre(j / nv)));
    for (let j = 0; j <= nv; j++) T.push(C[Math.min(nv, j + 1)].subtract(C[Math.max(0, j - 1)]).normalize());
    let N = V3(...(opts.side || [1, 0, 0]));
    for (let j = 0; j <= nv; j++) {
      N = N.subtract(T[j].scale(BABYLON.Vector3.Dot(N, T[j])));
      if (N.lengthSquared() < 1e-10) N = BABYLON.Vector3.Cross(T[j], V3(0.3, 1, 0.2));
      N.normalize();
      F.push([N.clone(), BABYLON.Vector3.Cross(T[j], N)]);
    }
    return grid(nu, nv, (u, v) => {
      const j = Math.round(v * nv), [n, b] = F[j], c = C[j];
      const [dn, db] = section(v, u * TAU);
      return [c.x + n.x * dn + b.x * db, c.y + n.y * dn + b.y * db, c.z + n.z * dn + b.z * db];
    }, Object.assign({ closed: true }, opts));
  }

  window.Chess3D.SurfaceKit = { TAU, hex, V3, lerp, clamp, smoothstep, spow, curve, bezier, grid, sweep };
})();
