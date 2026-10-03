// GlbCharacter: drives an instantiated GLB model instead of procedural meshes,
// while implementing the exact same CharacterBase contract (moveTo, playAttack,
// playRecover, playHit, playDeath, playVictory, setWalking, updateIdle,
// setSelected, setFlash, fadeIn, dissolve, dispose) so PieceManager/game3d never
// need to know which kind of character they're driving. See plan §12.2.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const CharacterBase = window.Chess3D.CharacterBase;

  // AnimationGroup duration in ms, at the clip's own authored frame rate
  // (independent of Tween.speed — see the Deviations note in the WP-09 handoff).
  function frameRateOf(group) {
    const ta = group.targetedAnimations && group.targetedAnimations[0];
    return (ta && ta.animation && ta.animation.framePerSecond) || 30;
  }
  function groupDurationMs(group) {
    return Math.max(1, ((group.to - group.from) / frameRateOf(group)) * 1000);
  }

  class GlbCharacter extends CharacterBase {
    constructor(opts) {
      super(opts);
      this.container = opts.container;   // BABYLON.AssetContainer, shared across instances of this file
      this.entry = opts.entry || {};      // manifest entry: height/rotationY/yOffset/tint/animations/impactAt
      this.groups = {};                   // action name -> AnimationGroup | null (missing -> procedural fallback)
      this._recoverMs = 0;
    }

    async build() {
      const team = Config.TEAM[this.color];
      this.buildTeamBase(team);

      // cloneMaterials=true (2nd arg) + doNotInstantiate (3rd arg) so every character
      // gets its own real mesh + material clones (required for setFlash/tint to affect
      // only this piece, and for skeleton animation to run independently per instance).
      const inst = this.container.instantiateModelsToScene((n) => `${n}_${this.id}`, true, { doNotInstantiate: true });
      this._instantiated = inst;
      const modelRoot = inst.rootNodes[0];
      modelRoot.parent = this.visual;

      modelRoot.getChildMeshes(false).forEach((mesh) => {
        this._registerMesh(mesh);
        mesh.receiveShadows = true;
        if (mesh.material) this.materials.push(mesh.material);
      });

      if (this.entry.tint) {
        const teamColor = BABYLON.Color3.FromHexString(team.cloth);
        this.materials.forEach((mat) => {
          if (mat.albedoColor) mat.albedoColor = mat.albedoColor.multiply(teamColor);
          else if (mat.diffuseColor) mat.diffuseColor = mat.diffuseColor.multiply(teamColor);
        });
      }

      // Auto-scale to the configured (or default) target height, then plant the feet
      // on top of the team base disc (see CharacterBase.buildTeamBase, top at +0.07).
      const targetHeight = this.entry.height || Config.PIECE_HEIGHT[this.type] || 1;
      const rawBox = this.visual.getHierarchyBoundingVectors(true);
      const rawHeight = Math.max(1e-4, rawBox.max.y - rawBox.min.y);
      const scale = targetHeight / rawHeight;
      this.visual.scaling.setAll(scale);
      const scaledBox = this.visual.getHierarchyBoundingVectors(true);
      const yOffset = this.entry.yOffset || 0;
      this.visual.position.y += (Config.BOARD_Y + 0.07 + yOffset) - scaledBox.min.y;
      this.visual.rotation.y = ((this.entry.rotationY || 0) * Math.PI) / 180;
      this._baseVisualY = this.visual.position.y;

      // instantiateModelsToScene's nameFunction (above) renames animation groups too, not
      // just nodes, so a group authored as "Idle" comes back named "Idle_<id>" here. Strip
      // that known suffix back off before matching against the manifest's plain clip names.
      const suffix = `_${this.id}`;
      const byName = new Map(inst.animationGroups.map((g) => {
        const original = g.name.endsWith(suffix) ? g.name.slice(0, -suffix.length) : g.name;
        return [original, g];
      }));
      const names = this.entry.animations || {};
      ['idle', 'walk', 'attack', 'hit', 'death', 'victory'].forEach((action) => {
        this.groups[action] = (names[action] && byName.get(names[action])) || null;
      });

      inst.animationGroups.forEach((g) => g.stop());
      this._playIdle();
    }

    _stopAllGroups() {
      (this._instantiated.animationGroups || []).forEach((g) => g.stop());
    }

    _playIdle() {
      this._stopAllGroups();
      if (this.groups.idle) this.groups.idle.play(true);
    }

    // Only used as a fallback when the GLB has no idle clip — the model just gets the
    // same gentle bob procedural characters use. When an idle clip exists it plays on
    // its own via Babylon's animation system and needs no per-frame driving here.
    // GLB clips animate their own nodes outside `busy`; never pool or proxy them.
    tickProxy() { return false; }

    updateIdle(t) {
      if (this.busy || this.groups.idle) return;
      this.visual.position.y = this._baseVisualY + this.selectLift + Math.sin(t * 2 + this.idlePhase) * 0.015;
    }

    setWalking(on) {
      if (on) {
        if (this.groups.walk) {
          this._stopAllGroups();
          this.groups.walk.play(true);
          return;
        }
        if (this._walkObserver) return;
        this._walkObserver = this.scene.onBeforeRenderObservable.add(() => {
          const t = performance.now() / 1000;
          this.visual.position.y = this._baseVisualY + this.selectLift + Math.abs(Math.sin(t * 9)) * 0.05;
        });
      } else {
        if (this._walkObserver) {
          this.scene.onBeforeRenderObservable.remove(this._walkObserver);
          this._walkObserver = null;
          this.visual.position.y = this._baseVisualY + this.selectLift;
        }
        this._playIdle();
      }
    }

    async playAttack(targetPos) {
      this.busy = true;
      const fx = this.ctx.effects;
      const team = Config.TEAM[this.color];
      const group = this.groups.attack;
      const impactAt = (this.entry.impactAt != null) ? this.entry.impactAt : 0.5;

      if (group) {
        this._stopAllGroups();
        group.play(false);
        const total = groupDurationMs(group);
        this._recoverMs = Math.max(0, total * (1 - impactAt));
        await Tween.wait(total * impactAt);
      } else {
        this._recoverMs = 0;
        await Tween.wait(TIMING.attackWindup);
      }

      // Ranged pieces still use the shared particle effects after impact, same as the
      // procedural characters (plan §12.2: "vị trí xuất phát = đầu model + (0, height*0.8, 0)").
      if (this.type === 'b' || this.type === 'q') {
        const height = this.entry.height || Config.PIECE_HEIGHT[this.type] || 1;
        const from = this.root.position.add(new BABYLON.Vector3(0, height * 0.8, 0));
        const to = targetPos.add(new BABYLON.Vector3(0, 0.5, 0));
        const vortex = this.type === 'b' ? this.castTornado(targetPos) : null;
        if (vortex) await vortex.arrived;
        else if (this.type === 'q' && fx && fx.lightning) await fx.lightning(from, to, team.glow);
        else await Tween.wait(TIMING.projectile);
      }
      this.busy = false;
    }

    async playRecover() {
      if (this._recoverMs) {
        await Tween.wait(this._recoverMs);
        this._recoverMs = 0;
      }
      this._playIdle();
    }

    async playHit() {
      this.busy = true;
      const group = this.groups.hit;
      if (group) {
        this._stopAllGroups();
        group.play(false);
        await Tween.wait(groupDurationMs(group));
      } else {
        const baseZ = this.visual.position.z;
        await Promise.all([
          Tween.run(220, (t) => { this.setFlash(1 - t * t); }, Ease.linear),
          Tween.run(220, (t) => { this.visual.position.z = baseZ - 0.18 * Math.sin(t * Math.PI); }, Ease.outCubic)
        ]);
        this.visual.position.z = baseZ;
      }
      this._playIdle();
      this.busy = false;
    }

    // Does NOT dispose (per CharacterBase contract) and does NOT resume idle: the
    // character is left posed at the death frame until PieceManager disposes it.
    async playDeath() {
      this.busy = true;
      const group = this.groups.death;
      if (group) {
        this._stopAllGroups();
        group.play(false);
        await Tween.wait(groupDurationMs(group));
      } else {
        this.setFlash(0.8);
        const baseY = this.visual.position.y;
        await Tween.run(TIMING.death, (t) => {
          this.visual.rotation.x = -Math.PI / 2 * 0.9 * t;
          this.visual.position.y = baseY - 0.1 * t;
        }, Ease.inCubic);
      }
    }

    async playVictory() {
      const group = this.groups.victory;
      if (group) {
        this._stopAllGroups();
        group.play(false);
        await Tween.wait(groupDurationMs(group));
        this._playIdle();
      } else {
        const baseY = this.visual.position.y;
        for (let i = 0; i < 2; i++) {
          await Tween.run(160, (t) => { this.visual.position.y = baseY + 0.25 * t; }, Ease.outCubic);
          await Tween.run(160, (t) => { this.visual.position.y = baseY + 0.25 * (1 - t); }, Ease.inCubic);
        }
      }
    }

    dispose() {
      if (this._walkObserver) {
        this.scene.onBeforeRenderObservable.remove(this._walkObserver);
        this._walkObserver = null;
      }
      // AnimationGroups created by instantiateModelsToScene live on the scene, not under
      // this.root, so node disposal below wouldn't free them on its own.
      if (this._instantiated) {
        (this._instantiated.animationGroups || []).forEach((g) => g.dispose());
      }
      super.dispose();
    }
  }

  window.Chess3D.GlbCharacter = GlbCharacter;
})();
