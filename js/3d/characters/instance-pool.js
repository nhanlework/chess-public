// InstancePool: idle pieces drawn as GPU thin instances.
//
// The renderer is CPU-bound: Babylon spends ~20 us of main-thread time per
// mesh per pass, so the GPU (an RTX 4060 in testing) idles at ~33% while the
// frame rate is capped by draw-call count. Pieces of the same type, colour and
// pose state (8 white pawns, 2 black knights...) look identical while they
// stand still, so they share ONE set of merged meshes ("sources", one per
// distinct material) and each piece is just a matrix in the sources' instance
// buffer: 8 pawns cost the draw calls of one.
//
// A piece joins once it has been idle for a moment (CharacterBase.tickProxy),
// in a canonical pose (idlePhase 0, t = 0), and leaves the moment it goes busy,
// gets selected or flashes; its own rig meshes are then shown again. Pivot-level
// idle motion (breathing, head turns) is not visible while pooled; the whole-body
// bob and the select lift still are (instance matrix = the piece's world matrix).
(function () {
  const CharacterBase = window.Chess3D.CharacterBase;
  const INITIAL_CAPACITY = 8;

  // --- material signature -------------------------------------------------
  // Two materials with the same signature render identically, so their meshes
  // can share one source. Emissive uses the material's base value (setFlash /
  // flicker effects animate around it). Shader/node materials, or anything with
  // custom (non built-in) plugins or bind hooks, never equal another material.
  const BUILTIN_PLUGINS = /^(PBRBRDF|PBRClearCoat|PBRIridescence|PBRAnisotropic|PBRSheen|Sheen|PBRSubSurface|DetailMap|.*Configuration)$/;
  const sigCache = new Map();
  const PROPS = ['albedoColor', 'diffuseColor', 'specularColor', 'reflectivityColor', 'ambientColor',
    'metallic', 'roughness', 'microSurface', 'alpha', 'alphaMode', 'transparencyMode', 'backFaceCulling',
    'twoSidedLighting', 'disableLighting', 'unlit', 'environmentIntensity', 'directIntensity', 'specularIntensity',
    'emissiveIntensity', 'indexOfRefraction', 'metallicF0Factor', 'maxSimultaneousLights', 'wireframe',
    'useAlphaFromAlbedoTexture', 'useAlphaFromDiffuseTexture', 'useRoughnessFromMetallicTextureGreen',
    'useMetallnessFromMetallicTextureBlue', 'useAmbientOcclusionFromMetallicTextureRed', 'specularPower',
    'useSpecularOverAlpha', 'useReflectionOverAlpha', 'forceIrradianceInFragment', 'invertNormalMapX', 'invertNormalMapY'];
  const TEXTURES = ['albedoTexture', 'diffuseTexture', 'bumpTexture', 'metallicTexture', 'emissiveTexture',
    'opacityTexture', 'ambientTexture', 'reflectionTexture', 'lightmapTexture', 'specularTexture', 'reflectivityTexture',
    'microSurfaceTexture', 'refractionTexture'];
  function val(v) {
    if (v == null) return '';
    if (typeof v === 'number') return v.toFixed(4);
    if (typeof v === 'object' && 'r' in v) return v.r.toFixed(4) + ',' + v.g.toFixed(4) + ',' + v.b.toFixed(4);
    return String(v);
  }
  // Textures and special materials are named by their order of first use in
  // the piece (`ids`, one map per piece), not by uniqueId: some models build
  // their textures per piece, so two pawns' textures differ in id but not in
  // content, while two different textures within one piece stay distinct.
  function materialSignature(mat, ids) {
    const local = (key) => {
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key);
    };
    const base = baseSignature(mat);
    if (base === null) return 'u' + local('m' + mat.uniqueId);
    return base + '|' + TEXTURES.map((t) => (mat[t] ? 't' + local('t' + mat[t].uniqueId) : '')).join(',');
  }

  function baseSignature(mat) {
    let sig = sigCache.get(mat.uniqueId);
    if (sig !== undefined) return sig;
    const cls = mat.getClassName();
    const plugins = (mat.pluginManager && mat.pluginManager._plugins) || [];
    const special = (cls !== 'PBRMaterial' && cls !== 'StandardMaterial') ||
      plugins.some((p) => !BUILTIN_PLUGINS.test(p.name || p.getClassName())) ||
      (mat._onBindObservable && mat._onBindObservable.hasObservers()) ||
      (mat.detailMap && mat.detailMap.isEnabled);
    if (special) {
      sig = null;
    } else {
      const parts = [cls];
      PROPS.forEach((p) => parts.push(val(mat[p])));
      parts.push(val(mat.__baseEmissive || mat.emissiveColor));
      ['clearCoat', 'sheen', 'iridescence', 'anisotropy'].forEach((k) => {
        const sub = mat[k];
        if (sub && sub.isEnabled) parts.push(k + val(sub.intensity) + val(sub.roughness));
      });
      if (mat.subSurface && (mat.subSurface.isTranslucencyEnabled || mat.subSurface.isRefractionEnabled)) sig = null;
      else sig = parts.join('|');
    }
    sigCache.set(mat.uniqueId, sig);
    return sig;
  }

  // --- pool -----------------------------------------------------------------
  const entries = new Map();   // poseKey -> entry
  let reflectionsWanted = false;

  function underVisual(ch, m) {
    for (let p = m.parent; p; p = p.parent) if (p === ch.visual) return true;
    return false;
  }

  // Puts the piece in its canonical pose and groups its visible meshes by
  // material signature + parent kind (visual/root) + vertex layout.
  function collectGroups(ch) {
    const saved = ch.idlePhase;
    ch.idlePhase = 0;
    // Twice: some models (the pawn) only re-pose on every other call.
    ch.updateIdle(0);
    ch.updateIdle(0);
    ch.idlePhase = saved;
    [ch.root, ...ch.root.getDescendants(false)].forEach((n) => n.computeWorldMatrix(true));
    const groups = new Map();
    const ids = new Map();
    ch._proxyCandidates().forEach((m) => {
      const key = materialSignature(m.material, ids) + '#' + (underVisual(ch, m) ? 'v' : 'r') + '#' +
        m.getVerticesDataKinds().sort().join(',');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    });
    return groups;
  }

  function buildEntry(ch, poseKey, groups) {
    const scene = ch.scene;
    const shadowGen = ch.ctx && ch.ctx.shadowGen;
    const casterSet = shadowGen ? new Set(shadowGen.getShadowMap().renderList) : null;
    // `template`: the piece whose materials were cloned. The clones share its
    // textures, so the entry goes away with it (see InstancePool.forget).
    const entry = { poseKey, template: ch, groupKeys: [...groups.keys()].sort(), sources: [], owners: [], capacity: INITIAL_CAPACITY, reflection: null };
    for (const key of entry.groupKeys) {
      const list = groups.get(key);
      const kind = key.split('#')[1];
      let mesh = null;
      try {
        mesh = BABYLON.Mesh.MergeMeshes(list, false, true, undefined, false, false);
      } catch (e) { mesh = null; }
      if (!mesh) { disposeEntry(entry); return null; }
      const parent = kind === 'v' ? ch.visual : ch.root;
      mesh.bakeTransformIntoVertices(parent.getWorldMatrix().clone().invert());
      mesh.parent = null;
      mesh.name = `pool_${poseKey}`;
      mesh.material = cloneSharingTextures(list[0].material, `pool_${list[0].material.name}`);
      mesh.isPickable = true;
      mesh.thinInstanceEnablePicking = true;
      mesh.metadata = { instanceOwners: entry.owners };
      mesh.receiveShadows = true;
      mesh.alwaysSelectAsActiveMesh = true;   // instances span the board; skip culling
      mesh.doNotSyncBoundingInfo = true;
      const buf = new Float32Array(16 * entry.capacity);   // handed to Babylon by syncBuffers()
      mesh.setEnabled(false);
      if (shadowGen && list.some((m) => casterSet.has(m))) shadowGen.addShadowCaster(mesh, false);
      // Per-draw CPU cost of a PBR material is mostly binding its uniforms and
      // lights (~33 us with 6 lights). Idle pieces skip the 4 effect flash
      // lights (an attacking or hit piece is live, not pooled, so it still
      // catches them), and the material is frozen: its uniforms are uploaded
      // once instead of every frame. update() unfreezes one whose emissive
      // turns out to animate (the rook's flickering windows).
      scene.lights.forEach((l) => { if (/^fxLight/.test(l.name)) l.excludedMeshes.push(mesh); });
      mesh.material.freeze();
      entry.sources.push({ mesh, kind, buf, key });
    }
    entries.set(poseKey, entry);
    return entry;
  }

  // Material.clone() also clones its textures, and a cloned DynamicTexture has
  // no canvas content, so it never becomes ready. Point the clone back at the
  // original textures and drop the copies.
  function cloneSharingTextures(src, name) {
    const mat = src.clone(name);
    TEXTURES.forEach((slot) => {
      if (mat[slot] && mat[slot] !== src[slot]) {
        const copy = mat[slot];
        mat[slot] = src[slot];
        if (copy !== src[slot] && !TEXTURES.some((s) => src[s] === copy)) copy.dispose();
      }
    });
    mat.__baseEmissive = src.__baseEmissive;
    return mat;
  }

  function disposeEntry(entry) {
    entry.sources.forEach((s) => {
      const lights = s.mesh.getScene().lights;
      lights.forEach((l) => {
        const i = l.excludedMeshes.indexOf(s.mesh);
        if (i !== -1) l.excludedMeshes.splice(i, 1);
      });
      s.mesh.material.dispose();
      s.mesh.dispose();
    });
    if (entry.reflection) entry.reflection.dispose();
    entries.delete(entry.poseKey);
  }

  function grow(entry) {
    entry.capacity *= 2;
    entry.sources.forEach((s) => {
      const buf = new Float32Array(16 * entry.capacity);
      buf.set(s.buf);
      s.buf = buf;
    });
    if (entry.reflection) {
      const buf = new Float32Array(16 * entry.capacity);
      buf.set(entry.reflection._poolBuf);
      entry.reflection._poolBuf = buf;
    }
  }

  function writeMatrices(entry, i, ch) {
    const vis = ch.visual.computeWorldMatrix(true), root = ch.root.computeWorldMatrix(true);
    entry.sources.forEach((s) => (s.kind === 'v' ? vis : root).copyToArray(s.buf, i * 16));
    if (entry.reflection) root.copyToArray(entry.reflection._poolBuf, i * 16);
  }

  // Babylon (8.x) picks thin instances through thinInstanceGetWorldMatrices(),
  // which caches one matrix per instance of the buffer it was given and only
  // rebuilds that cache in thinInstanceSetBuffer(), not on
  // thinInstanceBufferUpdated(). So whenever the owner count changes, hand it
  // a view of exactly n matrices (no stale "ghost" slots past the last owner),
  // and after matrices move in place, drop the cache so picking sees the
  // current positions. Without this, clicks hit a piece where it used to be.
  function setBuffer(mesh, buf, n) {
    if (n > 0) mesh.thinInstanceSetBuffer('matrix', buf.subarray(0, n * 16), 16, false);
    mesh.setEnabled(n > 0);
  }
  function matricesMoved(mesh) {
    mesh.thinInstanceBufferUpdated('matrix');
    if (mesh._thinInstanceDataStorage) mesh._thinInstanceDataStorage.worldMatrices = null;
  }

  // Picking tests the source's bounding info first, so it must cover every
  // instance (rendering doesn't care: sources are alwaysSelectAsActiveMesh).
  function refreshBounds(entry) {
    if (entry.owners.length) entry.sources.forEach((s) => s.mesh.thinInstanceRefreshBoundingInfo(false));
  }

  function setCount(entry) {
    const n = entry.owners.length;
    entry.sources.forEach((s) => setBuffer(s.mesh, s.buf, n));
    if (entry.reflection) setBuffer(entry.reflection, entry.reflection._poolBuf, n);
    refreshBounds(entry);
  }

  const InstancePool = {
    // Tries to draw `ch` through the pool. Returns 'joined', 'built' (a new
    // source set was merged this call: heavy), 'later' (a build is needed but
    // allowBuild is false this frame) or null when the piece can't be pooled
    // (its mesh layout doesn't match its type's sources).
    join(ch, allowBuild) {
      if (ch._pooled) return 'joined';
      const poseKey = ch.type + ch.color + '|' + ch.proxyPoseKey();
      let entry = entries.get(poseKey);
      if (!entry && !allowBuild) return 'later';
      const groups = collectGroups(ch);
      if (!groups.size) return null;
      let built = false;
      if (!entry) {
        entry = buildEntry(ch, poseKey, groups);
        if (!entry) return null;
        built = true;
      } else {
        const keys = [...groups.keys()].sort();
        if (keys.length !== entry.groupKeys.length || keys.some((k, i) => k !== entry.groupKeys[i])) return null;
      }
      if (entry.owners.length >= entry.capacity) grow(entry);
      const i = entry.owners.length;
      entry.owners.push(ch);
      const hidden = [];
      const mats = entry.sources.map((s) => groups.get(s.key)[0].material);
      groups.forEach((list) => list.forEach((m) => { m.setEnabled(false); hidden.push(m); }));
      ch._pooled = { entry, hidden, mats, flags: [-1, -1] };
      writeMatrices(entry, i, ch);
      setCount(entry);
      CharacterBase.proxyEpoch++;
      return built ? 'built' : 'joined';
    },

    leave(ch) {
      const p = ch._pooled;
      if (!p) return;
      ch._pooled = null;
      const entry = p.entry;
      const i = entry.owners.indexOf(ch);
      const last = entry.owners.length - 1;
      if (i !== -1) {
        if (i !== last) {
          const moved = entry.owners[last];
          entry.owners[i] = moved;
          entry.sources.forEach((s) => s.buf.copyWithin(i * 16, last * 16, last * 16 + 16));
          if (entry.reflection) entry.reflection._poolBuf.copyWithin(i * 16, last * 16, last * 16 + 16);
        }
        entry.owners.pop();
        setCount(entry);
      }
      p.hidden.forEach((m) => { if (!m.isDisposed()) m.setEnabled(true); });
      CharacterBase.proxyEpoch++;
    },

    // A piece is being disposed: drop the source sets cloned from it (their
    // materials use its textures). Their other owners show live and rejoin a
    // rebuilt set on a later frame.
    forget(ch) {
      [...entries.values()].forEach((entry) => {
        if (entry.template !== ch) return;
        entry.owners.slice().forEach((o) => { if (o._showLive) o._showLive(); else InstancePool.leave(o); });
        disposeEntry(entry);
      });
    },

    // Every frame: follow each pooled piece's bob / position, keep animated
    // material values (e.g. the rook's flickering windows) in sync with the
    // first owner, and build reflection sources while the glossy board is on.
    // Builds at most one reflection source, and only when allowHeavy.
    update(allowHeavy) {
      let heavy = !allowHeavy;
      entries.forEach((entry) => {
        const owners = entry.owners;
        if (!owners.length) return;
        // Only the parts that follow what moved: 'v' sources the visual (bob,
        // select lift), 'r' sources and the reflection the root (position).
        let visDirty = false, rootDirty = false;
        for (let i = 0; i < owners.length; i++) {
          const ch = owners[i], p = ch._pooled;
          const vis = ch.visual.computeWorldMatrix(), root = ch.root.computeWorldMatrix();
          const v = vis.updateFlag !== p.flags[0], r = root.updateFlag !== p.flags[1];
          if (v || r) {
            p.flags[0] = vis.updateFlag; p.flags[1] = root.updateFlag;
            writeMatrices(entry, i, ch);
            visDirty = visDirty || v || r;
            rootDirty = rootDirty || r;
          }
        }
        if (visDirty || rootDirty) {
          entry.sources.forEach((s) => {
            if (s.kind === 'v' ? visDirty : rootDirty) matricesMoved(s.mesh);
          });
          if (rootDirty && entry.reflection) entry.reflection.thinInstanceBufferUpdated('matrix');
          if (rootDirty) refreshBounds(entry);
        }
        const mats = owners[0]._pooled.mats;
        entry.sources.forEach((s, k) => {
          const src = mats[k].emissiveColor, mat = s.mesh.material, dst = mat.emissiveColor;
          if (src && dst && !src.equals(dst)) {
            if (mat.isFrozen) mat.unfreeze();   // an animated emissive: keep it live
            dst.copyFrom(src);
          }
        });
        if (reflectionsWanted && !entry.reflection && !entry.reflectionFailed && !heavy) {
          heavy = InstancePool._buildReflection(entry);
        }
      });
    },

    // One vertex-coloured, unlit, thin-instanced mesh per pose key, drawn only
    // by the board mirror (see board-gloss.js). Root-relative: the visual bob
    // (a centimetre at most) is ignored in the reflection.
    _buildReflection(entry) {
      const ch = entry.owners[0];
      const meshes = entry.sources.map((s) => s.mesh);
      const merged = CharacterBase._bakeReflection(meshes, (m) => m.material, (part, k) => {
        // Sources hold visual-relative vertices for 'v' groups: bring them into root space.
        if (entry.sources[k].kind === 'v') {
          const rel = ch.visual.computeWorldMatrix(true).multiply(ch.root.computeWorldMatrix(true).clone().invert());
          part.bakeTransformIntoVertices(rel);
        }
      });
      if (merged === false) return false;               // texture pixels still loading
      if (!merged) { entry.reflectionFailed = true; return true; }
      merged.name = `poolRefl_${entry.poseKey}`;
      merged.parent = null;
      merged.thinInstanceEnablePicking = false;
      merged.alwaysSelectAsActiveMesh = true;
      merged.doNotSyncBoundingInfo = true;
      merged._poolBuf = new Float32Array(16 * entry.capacity);
      entry.owners.forEach((o, i) => o.root.computeWorldMatrix(true).copyToArray(merged._poolBuf, i * 16));
      setBuffer(merged, merged._poolBuf, entry.owners.length);
      entry.reflection = merged;
      CharacterBase.proxyEpoch++;
      return true;
    },

    setReflections(on) {
      reflectionsWanted = !!on;
      if (!on) {
        entries.forEach((e) => { if (e.reflection) { e.reflection.dispose(); e.reflection = null; } e.reflectionFailed = false; });
        CharacterBase.proxyEpoch++;
      }
    },

    reflectionMeshes() {
      const out = [];
      entries.forEach((e) => { if (e.reflection && e.owners.length) out.push(e.reflection); });
      return out;
    },

    // Resolves a pick on a pooled source to the character id it hit.
    characterIdFromPick(mesh, thinInstanceIndex) {
      const owners = mesh && mesh.metadata && mesh.metadata.instanceOwners;
      if (!owners || thinInstanceIndex == null || thinInstanceIndex < 0) return null;
      const ch = owners[thinInstanceIndex];
      return ch ? ch.id : null;
    },


    stats() {
      let sources = 0, owners = 0;
      entries.forEach((e) => { sources += e.sources.length; owners += e.owners.length; });
      return { keys: entries.size, sources, owners };
    }
  };

  window.Chess3D.InstancePool = InstancePool;
})();
