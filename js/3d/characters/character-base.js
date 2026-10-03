// CharacterBase: shared skeleton (root/visual transform nodes), shared animations
// (facing, moveTo, selection highlight, flash, fade, dissolve) and the team base
// (armored disc) used by every character, procedural or GLB.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;

  function shortestAngleDiff(from, to) {
    let diff = (to - from) % (Math.PI * 2);
    if (diff > Math.PI) diff -= Math.PI * 2;
    if (diff < -Math.PI) diff += Math.PI * 2;
    return diff;
  }

  class CharacterBase {
    constructor({ scene, type, color, id, ctx }) {
      // ctx = { shadowGen, highlight, glow, effects, config }
      this.scene = scene;
      this.type = type;
      this.color = color;
      this.id = id;
      this.ctx = ctx;
      this.root = new BABYLON.TransformNode(`char_${id}`, scene);    // board position + facing
      this.visual = new BABYLON.TransformNode(`vis_${id}`, scene);   // bob/lean/lunge offsets
      this.visual.parent = this.root;
      this.idlePhase = Math.random() * Math.PI * 2;
      this.alive = true;
      this._proxy = null;          // idle stand-in meshes, see _enterProxy()
      this._pooled = null;         // idle: drawn as InstancePool thin instances (instance-pool.js)
      this._idleSince = 0;
      this._selectedOn = false;
      this.busy = false;           // true while animating: idle loop skips this character
      this.selectLift = 0;         // additive y offset while selected (added on top of idle bob)
      this.baseFacing = color === 'w' ? 0 : Math.PI;
      this.root.rotation.y = this.baseFacing;
      this.materials = [];         // every material owned by this character (for setFlash)
      this._meshes = [];           // every mesh owned by this character (for highlight/shadows/picking)
      this._glowExcluded = [];     // meshes kept out of the glow pass unless flashing
      this._flashGlow = false;
      this.activeVortex = null;    // bishop's tornado handle while it is out (see castTornado)
    }

    // --- Subclasses MUST implement ---
    async build() {}                         // create meshes, called once by factory
    updateIdle(timeSec) {}                   // called every frame while not busy
    async playAttack(targetPos) {}           // resolves at IMPACT moment
    async playRecover() {}                   // return to neutral after attack
    async playHit() {}
    async playDeath() {}                     // fall over; does NOT dispose
    async playVictory() {}
    setWalking(bool) {}                      // walk cycle on/off (called by moveTo)

    // --- Shared implementations ---
    getMeshes() { return this._proxy ? this._meshes.concat(this._proxy.meshes) : this._meshes; }

    // Every subclass flags its animations with `busy`; going busy swaps the
    // rigged meshes back in before the first animated frame.
    get busy() { return this._busy; }
    set busy(v) {
      this._busy = !!v;
      if (this._busy) this._showLive();
      else this._idleSince = performance.now();
    }

    // Idle update while drawn by the InstancePool: the rig is hidden, so only
    // what the instance shows matters (visual bob, select lift, material
    // flicker). Models whose updateIdle is mostly rig posing override this.
    updateIdlePooled(t) { this.updateIdle(t); }

    // Idle pose state that changes the merged geometry (see InstancePool):
    // the pawn's stance, the king seated or standing, the rook's tower morph.
    proxyPoseKey() {
      return [this._stance, this._seated, this._morph, this._dz].map((v) => (v == null ? '' : String(v))).join(',');
    }

    // Leave the instance pool / drop the idle proxy: the rig meshes draw again.
    _showLive() {
      if (this._pooled && window.Chess3D.InstancePool) window.Chess3D.InstancePool.leave(this);
      this._exitProxy();
    }

    // --- Idle proxy (perf) ---
    // A rigged character is 20-75 meshes (one per pivot and material), and
    // Babylon spends ~20 us of CPU per mesh per frame no matter how small it
    // is: 32 pieces cost ~25 ms a frame, the whole budget. While a piece just
    // stands there, its meshes are merged in their current pose into one mesh
    // per material (parented to `visual`, so idle bob / select lift / dissolve
    // still apply) and the originals are disabled. Going busy restores them.
    // Pivot-level idle motion (breathing, head turns) pauses meanwhile.
    _proxyCandidates() {
      return this.root.getChildMeshes(false).filter((m) =>
        m instanceof BABYLON.Mesh && !(m instanceof BABYLON.LinesMesh) && m.isEnabled() && m.isVisible &&
        m.material && !m.skeleton && !m.morphTargetManager && m.getTotalVertices() > 0 &&
        m.visibility === 1 && !m.billboardMode && !(m.metadata && m.metadata.noProxy) &&
        // Mirrored parts are fine (merging flips their faces); parts scaled
        // to ~0 (the folded rook's limbs) stay out.
        Math.abs(m.getWorldMatrix().determinant()) > 1e-9);
    }

    _enterProxy() {
      if (this._proxy || !this.alive || this._busy) return false;
      const scene = this.scene;
      [this.root, ...this.root.getDescendants(false)].forEach((n) => n.computeWorldMatrix(true));
      const underVisual = (m) => { for (let p = m.parent; p; p = p.parent) if (p === this.visual) return true; return false; };
      const groups = new Map();
      this._proxyCandidates().forEach((m) => {
        const key = m.material.uniqueId + '|' + (underVisual(m) ? 'v' : 'r') + '|' + m.getVerticesDataKinds().sort().join(',');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m);
      });
      const meshes = [], hidden = [];
      const shadowGen = this.ctx && this.ctx.shadowGen;
      groups.forEach((list, key) => {
        if (list.length < 2) return;
        let merged = null;
        try {
          merged = BABYLON.Mesh.MergeMeshes(list, false, true, undefined, false, false);
        } catch (e) { merged = null; }
        if (!merged) return;
        const parent = key.indexOf('|v|') !== -1 ? this.visual : this.root;
        merged.bakeTransformIntoVertices(parent.getWorldMatrix().clone().invert());
        merged.parent = parent;
        merged.name = `proxy_${this.id}`;
        merged.isPickable = true;
        merged.metadata = { characterId: this.id };
        merged.receiveShadows = true;
        if (shadowGen && list.some((m) => shadowGen.getShadowMap().renderList.indexOf(m) !== -1)) shadowGen.addShadowCaster(merged, false);
        meshes.push(merged);
        list.forEach((m) => { m.setEnabled(false); hidden.push(m); });
      });
      if (!meshes.length) return false;
      this._proxy = { meshes, hidden, reflection: null };
      CharacterBase.proxyEpoch++;
      if (this._selectedOn) this._applyHighlight(meshes, true);
      if (scene._activeMeshesFrozen) scene.unfreezeActiveMeshes();
      return true;
    }

    _exitProxy() {
      const p = this._proxy;
      if (!p) return;
      this._proxy = null;
      CharacterBase.proxyEpoch++;
      if (this.scene._activeMeshesFrozen) this.scene.unfreezeActiveMeshes();
      p.hidden.forEach((m) => { if (!m.isDisposed()) m.setEnabled(true); });
      p.meshes.forEach((m) => m.dispose());
      if (p.reflection) p.reflection.dispose();
    }

    // Called every frame by PieceManager. Once the piece has been idle for a
    // moment it joins the InstancePool (shared GPU instances, see
    // instance-pool.js); a piece that can't be pooled gets its own merged
    // proxy instead, plus its board reflection while the glossy board is on.
    // The selected piece always draws live (the highlight outlines its own
    // meshes). Returns true when it did heavy work (merging, ~5-25 ms), so the
    // caller can spread that over several frames.
    tickProxy(now, allowHeavy) {
      if (this._busy || !this.alive) return false;
      if (this._selectedOn) {
        if (this._pooled || this._proxy) this._showLive();
        return false;
      }
      if (this._pooled) return false;
      if (this._proxy) {
        const want = CharacterBase.reflections;
        if (want && allowHeavy && !this._proxy.reflection && !this._proxy.reflectionFailed) return this._buildReflection();
        if (!want && this._proxy.reflection) { this._proxy.reflection.dispose(); this._proxy.reflection = null; CharacterBase.proxyEpoch++; }
        return false;
      }
      if (now - this._idleSince < 600) return false;
      const pool = window.Chess3D.InstancePool;
      if (pool && !this._noPool) {
        // Joining an existing source set is cheap; building one is not.
        const res = pool.join(this, allowHeavy);
        if (res === 'later') return false;
        if (res) return res === 'built';
        this._noPool = true;   // mesh layout doesn't match its type's sources
      }
      if (!allowHeavy) return false;
      if (!this._enterProxy()) this._idleSince = now + 5000; // nothing to merge: retry later
      return true;
    }

    getReflectionMeshes() {
      if (this._pooled) return [];   // drawn by InstancePool.reflectionMeshes()
      if (this._proxy) return this._proxy.reflection ? [this._proxy.reflection] : [];
      return this.root.getChildMeshes(false).filter((m) => m.isEnabled() && m.isVisible && m.material);
    }

    // Glossy board (see board-gloss.js): the mirror pass draws each idle piece
    // as ONE mesh with its colours baked into vertex colours and one shared
    // unlit material, instead of its 10-25 PBR proxies. A PBR mesh drawn into
    // the mirror recomputes its shader defines on every pass switch, which is
    // what made a naive mirror cost ~30 ms a frame.
    _buildReflection() {
      const p = this._proxy;
      const merged = CharacterBase._bakeReflection(p.meshes, (m) => m.material);
      if (merged === false) return false;   // texture pixels still loading
      if (!merged) { p.reflectionFailed = true; return true; }
      merged.bakeTransformIntoVertices(this.root.getWorldMatrix().clone().invert());
      merged.parent = this.root;
      merged.name = `refl_${this.id}`;
      p.reflection = merged;
      CharacterBase.proxyEpoch++;
      return true;
    }

    // Clones `meshes`, bakes each one's material colour (albedo x texture at
    // the vertex UV, + emissive) into vertex colours and merges them in world
    // space into one mesh with the shared unlit reflection material, on the
    // mirror-only layer. `prepare(part, index)` may transform a clone first.
    // Returns false while a texture's pixels are still being read back, null
    // if the merge failed.
    static _bakeReflection(meshes, materialOf, prepare) {
      const texOf = (mat) => mat.albedoTexture || mat.diffuseTexture || null;
      // Texture pixels are read back asynchronously once; until then, wait.
      if (meshes.some((m) => { const t = texOf(materialOf(m)); return t && !CharacterBase._texPixels(t); })) return false;
      const parts = [];
      let scene = null;
      meshes.forEach((src, k) => {
        const mat = materialOf(src);
        scene = src.getScene();
        const part = src.clone(`refl_part`, null, true, false);
        part.makeGeometryUnique();
        if (prepare) prepare(part, k);
        part.computeWorldMatrix(true);
        const n = part.getTotalVertices();
        const base = mat.albedoColor || mat.diffuseColor || BABYLON.Color3.Gray();
        const em = mat.emissiveColor || BABYLON.Color3.Black();
        const tex = texOf(mat), px = tex ? CharacterBase._texPixels(tex) : null;
        const uv = px ? part.getVerticesData(BABYLON.VertexBuffer.UVKind) : null;
        const cols = new Float32Array(n * 4);
        for (let i = 0; i < n; i++) {
          let r = 1, g = 1, b = 1;
          if (uv) {
            const x = Math.min(px.w - 1, Math.max(0, Math.floor((uv[i * 2] % 1 + 1) % 1 * px.w)));
            const y = Math.min(px.h - 1, Math.max(0, Math.floor((uv[i * 2 + 1] % 1 + 1) % 1 * px.h)));
            const o = (y * px.w + x) * 4;
            r = px.data[o] * px.k; g = px.data[o + 1] * px.k; b = px.data[o + 2] * px.k;
          }
          cols[i * 4] = Math.min(1, base.r * r + em.r);
          cols[i * 4 + 1] = Math.min(1, base.g * g + em.g);
          cols[i * 4 + 2] = Math.min(1, base.b * b + em.b);
          cols[i * 4 + 3] = 1;
        }
        part.setVerticesData(BABYLON.VertexBuffer.ColorKind, cols, false);
        parts.push(part);
      });
      let merged = null;
      try {
        merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
      } catch (e) { merged = null; }
      if (!merged) { parts.forEach((m) => { if (!m.isDisposed()) m.dispose(); }); return null; }
      merged.material = CharacterBase._reflectionMaterial(scene);
      merged.layerMask = CharacterBase.REFLECTION_LAYER;  // mirror only, never the main camera
      merged.isPickable = false;
      const glowLayer = scene.effectLayers && scene.effectLayers.find((l) => l.getClassName() === 'GlowLayer');
      if (glowLayer) glowLayer.addExcludedMesh(merged);
      return merged;
    }

    static _reflectionMaterial(scene) {
      if (!CharacterBase._reflMat || CharacterBase._reflMat.getScene() !== scene) {
        const m = new BABYLON.StandardMaterial('pieceReflection', scene);
        m.disableLighting = true;
        m.diffuseColor = BABYLON.Color3.Black();
        m.specularColor = BABYLON.Color3.Black();
        m.emissiveColor = BABYLON.Color3.White();   // x vertex colour
        m.backFaceCulling = false;
        CharacterBase._reflMat = m;
      }
      return CharacterBase._reflMat;
    }

    // Cached CPU copy of a texture's pixels ({w, h, data, k}); null until the
    // async read-back lands.
    static _texPixels(tex) {
      const cache = CharacterBase._texCache;
      const entry = cache.get(tex.uniqueId);
      if (entry) return entry.ready ? entry : null;
      const pending = { ready: false };
      cache.set(tex.uniqueId, pending);
      const size = tex.getSize();
      const read = tex.isReady() ? tex.readPixels() : null;
      Promise.resolve(read).then((data) => {
        if (!data) { cache.delete(tex.uniqueId); return; }
        Object.assign(pending, { ready: true, w: size.width, h: size.height, data, k: data instanceof Uint8Array ? 1 / 255 : 1 });
      }, () => {
        // Unreadable texture: fall back to the material colour alone.
        Object.assign(pending, { ready: true, w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]), k: 1 / 255 });
      });
      return null;
    }

    // Registers a mesh so it is pickable back to this character and included
    // in getMeshes() (highlight/shadow casters/picking metadata).
    _registerMesh(mesh) {
      mesh.isPickable = true;
      mesh.metadata = { characterId: this.id };
      this._meshes.push(mesh);
      return mesh;
    }

    // Team base: armored disc, child of root (not visual)
    // so it never inherits idle bob / lunge offsets. Shared by procedural + GLB.
    buildTeamBase(team) {
      const scene = this.scene;
      const discMat = new BABYLON.PBRMaterial(`baseDisc_${this.id}`, scene);
      discMat.albedoColor = BABYLON.Color3.FromHexString(team.armor);
      discMat.metallic = 0.6;
      discMat.roughness = 0.4;
      const disc = BABYLON.MeshBuilder.CreateCylinder(`base_${this.id}`, { diameter: 0.78, height: 0.07 }, scene);
      disc.position.y = Config.BOARD_Y + 0.035;
      disc.material = discMat;
      disc.parent = this.root;
      disc.receiveShadows = true;
      this._registerMesh(disc);
      this.materials.push(discMat);
    }

    // Perf: merges sibling meshes that share the same material and the same
    // rigid pivot (torso/head/armR/armL/weapon/root) into one draw call each.
    // Safe because MergeMeshes bakes each mesh's offset relative to the first
    // mesh in the group and the result keeps that pivot as its parent, so
    // animations driven by the pivot (rotation/position) still apply correctly.
    // Called once after build(); see plan §9 FPS criterion.
    optimizeStaticMeshes(pivots) {
      const removed = new Set();
      const added = [];
      // MergeMeshes bakes WORLD matrices into the vertices, so the merged mesh
      // must be moved back into its pivot's local space before re-parenting,
      // otherwise any pivot that isn't at the origin gets its offset twice.
      [this.root, ...this.root.getDescendants(false)].forEach((n) => n.computeWorldMatrix(true));
      pivots.filter(Boolean).forEach((node) => {
        const children = node.getChildMeshes(true).filter((m) => m instanceof BABYLON.Mesh && m.material);
        const groups = new Map();
        children.forEach((m) => {
          const key = m.material.uniqueId;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(m);
        });
        groups.forEach((meshes) => {
          if (meshes.length < 2) return;
          const merged = BABYLON.Mesh.MergeMeshes(meshes, true, true, undefined, false, false);
          if (!merged) return;
          merged.bakeTransformIntoVertices(node.getWorldMatrix().clone().invert());
          merged.parent = node;
          merged.isPickable = true;
          merged.metadata = { characterId: this.id };
          merged.receiveShadows = true;
          added.push(merged);
          meshes.forEach((m) => removed.add(m));
        });
      });
      if (removed.size) {
        this._meshes = this._meshes.filter((m) => !removed.has(m)).concat(added);
      }
    }

    // Perf: registers shadow casters and glow-pass exclusions. Called once by the
    // factory right after build(), while root is still at scale 1.
    //  - Tiny parts (world bounding radius < quality.smallMeshRadius) cast no
    //    shadow and skip the glow pass: invisible at play distance.
    //  - The team base disc sits flat on the board; its shadow is negligible.
    //  - Non-emissive meshes only occlude in the glow pass; the small ones are
    //    dropped from it (setFlash re-adds them while the character flashes).
    applyRenderBudget(quality) {
      const minR = quality.smallMeshRadius || 0;
      const shadowGen = this.ctx && this.ctx.shadowGen;
      const glow = this.ctx && this.ctx.glow;
      [this.root, ...this.root.getDescendants(false)].forEach((n) => n.computeWorldMatrix(true));
      this._meshes.forEach((mesh) => {
        const small = minR > 0 && mesh.getBoundingInfo().boundingSphere.radiusWorld < minR;
        const isBase = mesh.name === `base_${this.id}`;
        if (shadowGen && !small && !isBase) shadowGen.addShadowCaster(mesh);
        const mat = mesh.material;
        const emissive = mat && (mat.emissiveTexture || (mat.emissiveColor && (mat.emissiveColor.r + mat.emissiveColor.g + mat.emissiveColor.b) > 0));
        if (glow && small && !emissive) {
          glow.addExcludedMesh(mesh);
          this._glowExcluded.push(mesh);
        }
      });
    }

    setPosition(vec3) { this.root.position.copyFrom(vec3); }

    async faceTowards(pos, ms) {
      const dx = pos.x - this.root.position.x;
      const dz = pos.z - this.root.position.z;
      if (Math.abs(dx) < 1e-4 && Math.abs(dz) < 1e-4) return;
      const target = Math.atan2(dx, dz);
      const start = this.root.rotation.y;
      const diff = shortestAngleDiff(start, target);
      if (Math.abs(diff) < 1e-4) return;
      await Tween.run(ms, (t) => { this.root.rotation.y = start + diff * t; }, Ease.inOutCubic);
    }

    async faceHome(ms) {
      const start = this.root.rotation.y;
      const diff = shortestAngleDiff(start, this.baseFacing);
      if (Math.abs(diff) < 1e-4) return;
      await Tween.run(ms, (t) => { this.root.rotation.y = start + diff * t; }, Ease.inOutCubic);
    }

    // style: 'walk' | 'leap'. opts.keepFacing (default false) skips the final
    // faceHome() call, used by capture choreography while the attacker still
    // faces the square it just attacked.
    async moveTo(pos, style, opts) {
      opts = opts || { keepFacing: false };
      const from = this.root.position.clone();
      const dx = pos.x - from.x;
      const dz = pos.z - from.z;
      const dist = Math.sqrt(dx * dx + dz * dz) / Config.SQUARE;
      const fx = this.ctx.effects;
      const team = Config.TEAM[this.color];
      this.busy = true;
      await this.faceTowards(pos, TIMING.turn);
      if (style === 'leap') {
        const h = 1.1;
        await Tween.run(TIMING.leap, (t) => {
          this.root.position.x = from.x + dx * t;
          this.root.position.z = from.z + dz * t;
          this.root.position.y = Config.BOARD_Y + 4 * h * t * (1 - t);
          this.visual.rotation.x = -0.3 * Math.sin(Math.PI * t);
        }, Ease.linear);
        this.root.position.y = Config.BOARD_Y;
        this.visual.rotation.x = 0;
        if (fx && fx.dustPuff) fx.dustPuff(pos);
        if (fx && fx.sparks) fx.sparks(pos, team.glow);
      } else {
        const duration = Math.max(TIMING.walkMin, Math.min(TIMING.walkMax, dist * TIMING.walkPerSquare));
        this.setWalking(true);
        await Tween.run(duration, (t) => {
          this.root.position.x = from.x + dx * t;
          this.root.position.z = from.z + dz * t;
        }, Ease.inOutCubic);
        this.setWalking(false);
        if (fx && fx.dustPuff) fx.dustPuff(pos);
      }
      if (!opts.keepFacing) await this.faceHome(TIMING.turn);
      this.busy = false;
    }

    setSelected(on) {
      this._selectedOn = !!on;
      // The highlight outlines the piece's own meshes: draw it live while selected.
      if (on) this._showLive();
      else this._idleSince = performance.now();
      this._applyHighlight(this.getMeshes(), on);
      this.selectLift = on ? 0.12 : 0;
    }

    _applyHighlight(meshes, on) {
      const hl = this.ctx.highlight;
      if (!hl) return;
      const color = BABYLON.Color3.FromHexString(Config.HIGHLIGHT.selected);
      meshes.forEach((m) => {
        if (on) hl.addMesh(m, color); else hl.removeMesh(m);
      });
    }

    // Blends every owned material's emissive toward white*amount, on top of
    // its own base emissive (magic materials keep their glow color at amount=0).
    setFlash(amount) {
      const glow = this.ctx && this.ctx.glow;
      const flashing = amount > 0;
      // Pooled pieces draw with shared materials: flash on the piece's own.
      if (flashing && this._pooled) this._showLive();
      if (glow && flashing !== this._flashGlow) {
        this._flashGlow = flashing;
        this._glowExcluded.forEach((m) => {
          if (flashing) glow.removeExcludedMesh(m); else glow.addExcludedMesh(m);
        });
      }
      this.materials.forEach((m) => {
        if (!m.__baseEmissive) m.__baseEmissive = (m.emissiveColor || BABYLON.Color3.Black()).clone();
        m.emissiveColor = BABYLON.Color3.Lerp(m.__baseEmissive, BABYLON.Color3.White(), amount);
      });
    }

    async fadeIn(ms) {
      this.root.scaling.set(0.001, 0.001, 0.001);
      await Tween.run(ms, (t) => {
        const s = Math.max(0.001, Ease.outBack(t));
        this.root.scaling.set(s, s, s);
      });
      this.root.scaling.set(1, 1, 1);
    }

    // Bishop attack: raise a tornado just in front of this piece and send it
    // at targetPos. The handle is kept on `activeVortex` so the capture
    // choreography can whirl the victim inside it and dissipate it afterwards.
    // Returns null when no effects module is available.
    castTornado(targetPos) {
      const fx = this.ctx && this.ctx.effects;
      if (!fx || !fx.tornado) return null;
      let dir = targetPos.subtract(this.root.position);
      dir.y = 0;
      dir = (dir.lengthSquared() > 1e-8) ? dir.normalize() : new BABYLON.Vector3(0, 0, 1);
      this.activeVortex = fx.tornado(this.root.position.add(dir.scale(0.55)), targetPos, Config.TEAM[this.color]);
      return this.activeVortex;
    }

    // Caught in a tornado: spun faster and faster while lifted off the base
    // and tumbling, flickering as the lightning hits. Does NOT dispose.
    async playSwept(ms) {
      this.busy = true;
      const rot0 = this.root.rotation.y, y0 = this.visual.position.y;
      await Tween.run(ms || TIMING.swept, (t) => {
        this.root.rotation.y = rot0 + 18 * t * t;
        this.visual.position.y = y0 + 0.9 * t * t;
        this.visual.rotation.z = 0.5 * Math.sin(t * Math.PI * 3) * t;
        this.setFlash(Math.random() < 0.25 ? 0.8 : 0.2);
      }, Ease.linear);
      this.setFlash(0.3);
    }

    async dissolve() {
      const fx = this.ctx.effects;
      const team = Config.TEAM[this.color];
      if (fx && fx.dissolve) fx.dissolve(this.root.position.clone(), team.glow, Config.PIECE_HEIGHT[this.type] || 1);
      await Tween.run(TIMING.dissolve, (t) => {
        const s = Math.max(0, 1 - t);
        this.visual.scaling.set(s, s, s);
      }, Ease.inCubic);
    }

    dispose() {
      this._showLive();
      if (window.Chess3D.InstancePool) window.Chess3D.InstancePool.forget(this);
      this.alive = false;
      const glow = this.ctx && this.ctx.glow;
      if (glow) this._glowExcluded.forEach((m) => glow.removeExcludedMesh(m));
      this._glowExcluded = [];
      this.root.dispose(false, true);
    }
  }

  CharacterBase.proxyEpoch = 0;          // bumped whenever proxy/reflection meshes change
  CharacterBase.reflections = false;     // glossy board on: build reflection meshes
  CharacterBase.REFLECTION_LAYER = 0x10000000;
  CharacterBase._texCache = new Map();
  CharacterBase._reflMat = null;

  window.Chess3D.CharacterBase = CharacterBase;
})();
