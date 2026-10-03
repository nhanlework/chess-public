(function () {
  const Config = window.Chess3D.Config;
  const S = Config.SQUARE;
  const BOARD_Y = Config.BOARD_Y;

  // board[r][c] -> world. r=7 (rank 1, White) is nearest the default camera (at -Z).
  function squareToWorld(sq) {
    const [r, c] = sqToRc(sq);
    return new BABYLON.Vector3((c - 3.5) * S, BOARD_Y, (3.5 - r) * S);
  }

  function worldToSquare(vec3) {
    const c = Math.round(vec3.x / S + 3.5);
    const r = Math.round(3.5 - vec3.z / S);
    if (r < 0 || r > 7 || c < 0 || c > 7) return null;
    return rcToSq(r, c);
  }

  function makeEmissivePlaneMaterial(scene, name, hexColor, alpha) {
    const mat = new BABYLON.StandardMaterial(name, scene);
    mat.disableLighting = true;
    mat.emissiveColor = BABYLON.Color3.FromHexString(hexColor);
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.alpha = alpha;
    mat.backFaceCulling = false;
    return mat;
  }

  // Coordinate labels a-h / 1-8 along all four sides, as one mesh: each
  // glyph is a cell of a 4x4 atlas, and each label quad's UVs point at its cell.
  function makeLabelsMesh(scene) {
    const GLYPHS = 'abcdefgh12345678', CELL = 128, GRID = 4;
    const dt = new BABYLON.DynamicTexture('lblAtlas', CELL * GRID, scene, true);
    dt.hasAlpha = true;
    const ctx = dt.getContext();
    ctx.clearRect(0, 0, CELL * GRID, CELL * GRID);
    ctx.font = 'bold 84px sans-serif';
    ctx.fillStyle = '#e6d3a3';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    [...GLYPHS].forEach((g, i) => ctx.fillText(g, (i % GRID + 0.5) * CELL, (Math.floor(i / GRID) + 0.5) * CELL));
    dt.update(true);
    const mat = new BABYLON.StandardMaterial('lblMat', scene);
    mat.diffuseTexture = dt;
    mat.emissiveColor = BABYLON.Color3.White();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;

    const quads = [];
    const quad = (text, x, z) => {
      const i = GLYPHS.indexOf(text), col = i % GRID, row = Math.floor(i / GRID);
      const u0 = col / GRID, v0 = 1 - (row + 1) / GRID;   // canvas top is v = 1 (invertY)
      const plane = BABYLON.MeshBuilder.CreatePlane('lbl_' + text, { size: 0.4 }, scene);
      const uv = plane.getVerticesData(BABYLON.VertexBuffer.UVKind);
      for (let k = 0; k < uv.length; k += 2) { uv[k] = u0 + uv[k] / GRID; uv[k + 1] = v0 + uv[k + 1] / GRID; }
      plane.setVerticesData(BABYLON.VertexBuffer.UVKind, uv);
      plane.rotation.x = Math.PI / 2;
      plane.position.set(x, -0.045, z);
      quads.push(plane);
    };
    const FILES = 'abcdefgh';
    for (let c = 0; c < 8; c++) {
      const x = (c - 3.5) * S;
      quad(FILES[c], x, 4.3);
      quad(FILES[c], x, -4.3);
    }
    for (let r = 0; r < 8; r++) {
      const z = (3.5 - r) * S;
      quad(String(8 - r), 4.3, z);
      quad(String(8 - r), -4.3, z);
    }
    const mesh = BABYLON.Mesh.MergeMeshes(quads, true, true);
    mesh.name = 'coordLabels';
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    return mesh;
  }

  // Plan §13.1: 4 torch pillars at the plinth's corners — a stone column plus an
  // accent basin on top; the flickering flame/light itself is added by the
  // caller via Effects.torch(pos) once Effects is initialised (board3d.js has
  // no dependency on effects.js). Returns the 4 world positions for the flame;
  // the column/basin meshes are pushed onto `staticMeshes`.
  function buildTorchPillars(scene, staticMeshes) {
    const corners = [[5.2, -5.2], [-5.2, -5.2], [5.2, 5.2], [-5.2, 5.2]];

    const stoneMat = new BABYLON.PBRMaterial('torchStoneMat', scene);
    stoneMat.albedoColor = BABYLON.Color3.FromHexString('#3a3540');
    stoneMat.metallic = 0;
    stoneMat.roughness = 0.8;

    const basinMat = new BABYLON.PBRMaterial('torchBasinMat', scene);
    basinMat.albedoColor = BABYLON.Color3.FromHexString(Config.BOARD_COLORS.trim);
    basinMat.metallic = 0.7;
    basinMat.roughness = 0.3;

    const columnHeight = 1.4;
    const columnCenterY = 0.4;
    const basinY = columnCenterY + columnHeight / 2 + 0.08;
    const positions = [];

    corners.forEach(([x, z], i) => {
      const column = BABYLON.MeshBuilder.CreateCylinder('torchColumn' + i,
        { diameterTop: 0.26, diameterBottom: 0.34, height: columnHeight, tessellation: 12 }, scene);
      column.position.set(x, columnCenterY, z);
      column.material = stoneMat;
      column.receiveShadows = true;
      column.isPickable = false;

      const basin = BABYLON.MeshBuilder.CreateCylinder('torchBasin' + i,
        { diameterTop: 0.5, diameterBottom: 0.3, height: 0.18, tessellation: 12 }, scene);
      basin.position.set(x, basinY, z);
      basin.material = basinMat;
      basin.isPickable = false;
      staticMeshes.push(column, basin);

      positions.push(new BABYLON.Vector3(x, basinY + 0.14, z));
    });

    stoneMat.freeze();
    basinMat.freeze();
    return positions;
  }

  function create(scene, ctxArg) {
    const colors = Config.BOARD_COLORS;
    const squareMeshes = new Map();   // square -> null (kept for its keys; squares are merged)
    const surfaces = [];
    // Non-emissive, never-moving meshes: excluded from the glow pass and the
    // only receivers of the torch lights (see game3d.js / Config.QUALITY).
    const staticMeshes = [];

    // --- 64 squares ---------------------------------------------------
    // Low environment reflection + a satin finish: the studio env map mirrored
    // in a glossy board washed the dark squares out to a pale mauve and put a
    // milky sheen over the light ones, so pieces stood out poorly.
    const lightMat = new BABYLON.PBRMaterial('sqLight', scene);
    lightMat.albedoColor = BABYLON.Color3.FromHexString(colors.light);
    lightMat.metallic = 0;
    lightMat.roughness = 0.6;
    lightMat.environmentIntensity = 0.3;

    const darkMat = new BABYLON.PBRMaterial('sqDark', scene);
    darkMat.albedoColor = BABYLON.Color3.FromHexString(colors.dark);
    darkMat.metallic = 0;
    darkMat.roughness = 0.65;
    darkMat.environmentIntensity = 0.3;

    // Perf: the 64 squares are merged into one mesh per colour (2 draw calls
    // instead of 64). Picking resolves the square from the hit point
    // (metadata.boardSurface, see worldToSquare).
    const boxes = { light: [], dark: [] };
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = rcToSq(r, c);
        const box = BABYLON.MeshBuilder.CreateBox('sq_' + sq, { width: S * 0.98, height: 0.1, depth: S * 0.98 }, scene);
        const pos = squareToWorld(sq);
        box.position.set(pos.x, BOARD_Y - 0.05, pos.z);
        boxes[((r + c) % 2 === 1) ? 'dark' : 'light'].push(box);
      }
    }
    [['light', lightMat], ['dark', darkMat]].forEach(([kind, mat]) => {
      const surface = BABYLON.Mesh.MergeMeshes(boxes[kind], true, true);
      surface.name = 'squares_' + kind;
      surface.material = mat;
      surface.metadata = { boardSurface: true };
      surface.receiveShadows = true;
      surface.isPickable = true;
      surface.freezeWorldMatrix();
      staticMeshes.push(surface);
      surfaces.push(surface);
    });
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) squareMeshes.set(rcToSq(r, c), null);
    lightMat.freeze();
    darkMat.freeze();

    // --- frame + trim ---------------------------------------------------
    const frameMat = new BABYLON.PBRMaterial('frameMat', scene);
    frameMat.albedoColor = BABYLON.Color3.FromHexString(colors.frame);
    frameMat.metallic = 0;
    frameMat.roughness = 0.6;
    const frame = BABYLON.MeshBuilder.CreateBox('boardFrame', { width: 9.0, height: 0.3, depth: 9.0 }, scene);
    frame.position.y = -0.2;
    frame.material = frameMat;
    frame.receiveShadows = true;

    const trimMat = new BABYLON.PBRMaterial('trimMat', scene);
    trimMat.albedoColor = BABYLON.Color3.FromHexString(colors.trim);
    trimMat.metallic = 1;
    trimMat.roughness = 0.3;
    const trim = BABYLON.MeshBuilder.CreateTorus('boardTrim', { diameter: 8.6, thickness: 0.06, tessellation: 64 }, scene);
    trim.position.y = -0.045;
    trim.scaling.x = 8.9 / 8.6; // stretch the torus into a squarish ring outline
    trim.material = trimMat;
    trim.isPickable = false;

    // --- plinth + ground -------------------------------------------------
    const plinthMat = new BABYLON.PBRMaterial('plinthMat', scene);
    plinthMat.albedoColor = BABYLON.Color3.FromHexString('#2a2530');
    plinthMat.metallic = 0;
    plinthMat.roughness = 0.7;
    const plinth = BABYLON.MeshBuilder.CreateCylinder('plinth', { diameter: 14, height: 1.2, tessellation: 64 }, scene);
    plinth.position.y = -0.95;
    plinth.material = plinthMat;
    plinth.receiveShadows = true;

    const groundMat = new BABYLON.PBRMaterial('groundMat', scene);
    groundMat.albedoColor = BABYLON.Color3.FromHexString('#141019');
    groundMat.metallic = 0;
    groundMat.roughness = 0.9;
    const ground = BABYLON.MeshBuilder.CreateGround('ground', { width: 60, height: 60 }, scene);
    ground.position.y = -1.55;
    ground.material = groundMat;
    ground.receiveShadows = true;
    ground.isPickable = false;
    staticMeshes.push(frame, trim, plinth, ground);

    // --- coordinate labels -------------------------------------------------
    // Perf: all 32 labels are one mesh with one 4x4 glyph atlas (1 draw call
    // instead of 32, each with its own material and texture).
    const labels = [makeLabelsMesh(scene)];
    function setCoordsVisible(visible) {
      labels.forEach(l => { l.setEnabled(!!visible); });
    }

    // --- marker pool (tint / dot / ring per square) -------------------------
    const H = Config.HIGHLIGHT;
    const tintMats = {
      selected: makeEmissivePlaneMaterial(scene, 'tintSelected', H.selected, 0.45),
      last: makeEmissivePlaneMaterial(scene, 'tintLast', H.last, 0.4),
      hover: makeEmissivePlaneMaterial(scene, 'tintHover', H.hover, 0.35),
      check: makeEmissivePlaneMaterial(scene, 'tintCheck', H.check, 0.5)
    };
    // Move dots are two-tone — a dark rim round a bright core — so they read
    // on the light squares as well as the dark ones.
    const dotMat = makeEmissivePlaneMaterial(scene, 'dotMat', H.move, 1);
    const dotRimMat = makeEmissivePlaneMaterial(scene, 'dotRimMat', H.moveRim, 0.8);
    const ringMat = makeEmissivePlaneMaterial(scene, 'ringMat', H.capture, 0.9);

    const markerMeshes = [];      // every pooled marker mesh (kept out of the glow pass)
    const tintPool = new Map();   // sq -> { mesh, kind }
    const dotPool = new Map();    // sq -> mesh
    const ringPool = new Map();   // sq -> mesh
    let hoverSq = null;
    let checkSq = null;
    let checkPulseObserver = null;

    for (const [sq] of squareMeshes) {
      const pos = squareToWorld(sq);

      const tint = BABYLON.MeshBuilder.CreatePlane('tint_' + sq, { size: S * 0.98 }, scene);
      tint.rotation.x = Math.PI / 2;
      tint.position.set(pos.x, BOARD_Y + 0.003, pos.z);
      tint.isPickable = false;
      tint.setEnabled(false);
      tintPool.set(sq, tint);

      const dot = BABYLON.MeshBuilder.CreateDisc('dot_' + sq, { radius: 0.17, tessellation: 32 }, scene);
      dot.rotation.x = Math.PI / 2;
      dot.position.set(pos.x, BOARD_Y + 0.004, pos.z);
      dot.material = dotRimMat;
      dot.isPickable = false;
      const core = BABYLON.MeshBuilder.CreateDisc('dotCore_' + sq, { radius: 0.11, tessellation: 32 }, scene);
      core.parent = dot;
      core.position.z = -0.002; // the disc's local -z is world up once laid flat
      core.material = dotMat;
      core.isPickable = false;
      dot.setEnabled(false);
      dotPool.set(sq, dot);
      markerMeshes.push(tint, dot, core);

      const ring = BABYLON.MeshBuilder.CreateTorus('ring_' + sq, { diameter: 0.8, thickness: 0.05, tessellation: 32 }, scene);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(pos.x, BOARD_Y + 0.02, pos.z);
      ring.material = ringMat;
      ring.isPickable = false;
      ring.setEnabled(false);
      ringPool.set(sq, ring);
      markerMeshes.push(ring);
    }

    // --- last-move arc (rebuilt on demand) -------------------------------
    let lastMoveMesh = null;
    function clearLastMoveArc() {
      if (lastMoveMesh) { lastMoveMesh.dispose(); lastMoveMesh = null; }
    }
    function buildLastMoveArc(from, to) {
      clearLastMoveArc();
      const a = squareToWorld(from);
      const b = squareToWorld(to);
      const mid = new BABYLON.Vector3((a.x + b.x) / 2, 0.6, (a.z + b.z) / 2);
      const steps = 20;
      // Quadratic Bezier from a to b, lifted through mid.
      const clean = [];
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mid.x + t * t * b.x;
        const y = (1 - t) * (1 - t) * (BOARD_Y + 0.02) + 2 * (1 - t) * t * mid.y + t * t * (BOARD_Y + 0.02);
        const z = (1 - t) * (1 - t) * a.z + 2 * (1 - t) * t * mid.z + t * t * b.z;
        clean.push(new BABYLON.Vector3(x, y, z));
      }
      lastMoveMesh = BABYLON.MeshBuilder.CreateTube('lastMoveArc', { path: clean, radius: 0.03, tessellation: 8 }, scene);
      lastMoveMesh.material = tintMats.last;
      lastMoveMesh.isPickable = false;
    }

    function setMarkers(opts) {
      opts = opts || {};
      // reset per-frame pools
      for (const [, mesh] of tintPool) mesh.setEnabled(false);
      for (const [, mesh] of dotPool) mesh.setEnabled(false);
      for (const [, mesh] of ringPool) mesh.setEnabled(false);

      if (opts.lastMove && opts.lastMove.from && opts.lastMove.to) {
        buildLastMoveArc(opts.lastMove.from, opts.lastMove.to);
        const toTint = tintPool.get(opts.lastMove.to);
        const fromTint = tintPool.get(opts.lastMove.from);
        if (toTint) { toTint.material = tintMats.last; toTint.setEnabled(true); }
        if (fromTint) { fromTint.material = tintMats.last; fromTint.setEnabled(true); }
      } else {
        clearLastMoveArc();
      }

      if (opts.selected) {
        const mesh = tintPool.get(opts.selected);
        if (mesh) { mesh.material = tintMats.selected; mesh.setEnabled(true); }
      }

      (opts.moves || []).forEach(m => {
        if (m.capture) {
          const ring = ringPool.get(m.to);
          if (ring) ring.setEnabled(true);
        } else {
          const dot = dotPool.get(m.to);
          if (dot) dot.setEnabled(true);
        }
      });

      checkSq = opts.check || null;
      if (checkSq) {
        const mesh = tintPool.get(checkSq);
        if (mesh) { mesh.material = tintMats.check; mesh.setEnabled(true); }
        if (!checkPulseObserver) {
          checkPulseObserver = scene.onBeforeRenderObservable.add(() => {
            if (!checkSq) return;
            const mesh = tintPool.get(checkSq);
            if (!mesh) return;
            const t = performance.now() / 300;
            mesh.material.alpha = 0.25 + (Math.sin(t) * 0.5 + 0.5) * 0.35;
          });
        }
      }

      if (hoverSq && hoverSq !== opts.selected) {
        const mesh = tintPool.get(hoverSq);
        if (mesh && !mesh.isEnabled()) { mesh.material = tintMats.hover; mesh.setEnabled(true); }
      }
    }

    function setHover(sq) {
      if (hoverSq) {
        const prev = tintPool.get(hoverSq);
        if (prev && prev.material === tintMats.hover) prev.setEnabled(false);
      }
      hoverSq = sq || null;
      if (hoverSq) {
        const mesh = tintPool.get(hoverSq);
        if (mesh && !mesh.isEnabled()) { mesh.material = tintMats.hover; mesh.setEnabled(true); }
      }
    }

    const torchPositions = buildTorchPillars(scene, staticMeshes);

    const board = {
      squareToWorld,
      worldToSquare,
      setMarkers,
      setHover,
      setCoordsVisible,
      squareMeshes,
      staticMeshes,
      // Flat emissive overlays (markers, coordinate labels): a glow halo only
      // blurs them, so the caller keeps them out of the glow layer.
      noGlowMeshes: markerMeshes.concat(labels),
      torchPositions // 4 world positions (Vector3) for Effects.torch(), set by the caller
    };
    return board;
  }

  window.Chess3D.Board3D = { create };
})();
