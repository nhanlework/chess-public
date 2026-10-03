// PieceManager: maps board squares to CharacterBase instances, keeps them in
// sync with ChessGame's board (reconcile), and runs the shared idle loop.
// See plan §9.6-§9.7.
(function () {
  const Config = window.Chess3D.Config;
  const TIMING = Config.TIMING;
  const Tween = window.Chess3D.Tween;

  function squareDistance(a, b) {
    const [ar, ac] = sqToRc(a);
    const [br, bc] = sqToRc(b);
    return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
  }

  // Plan §13.1: a rotating rune disc hovering over the thinking side's King,
  // drawn from code onto a DynamicTexture (ring + runic glyphs), fading in/out.
  const RUNE_GLYPHS = 'ᚠᚢᚦᚨᚱᚲ';
  function buildThinkingRune(scene, color) {
    const team = Config.TEAM[color];
    const size = 256;
    const dt = new BABYLON.DynamicTexture('runeTex_' + color + '_' + Date.now(), size, scene, true);
    dt.hasAlpha = true;
    const ctx2d = dt.getContext();
    ctx2d.clearRect(0, 0, size, size);
    ctx2d.strokeStyle = team.glow;
    ctx2d.lineWidth = 5;
    ctx2d.beginPath();
    ctx2d.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
    ctx2d.stroke();
    ctx2d.fillStyle = team.glow;
    ctx2d.font = 'bold 42px sans-serif';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    const n = RUNE_GLYPHS.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 - Math.PI / 2;
      const x = size / 2 + Math.cos(a) * (size / 2 - 36);
      const y = size / 2 + Math.sin(a) * (size / 2 - 36);
      ctx2d.fillText(RUNE_GLYPHS[i], x, y);
    }
    dt.update();

    const mat = new BABYLON.StandardMaterial('runeMat_' + color, scene);
    mat.diffuseTexture = dt;
    mat.diffuseTexture.hasAlpha = true;
    mat.useAlphaFromDiffuseTexture = true;
    mat.emissiveColor = BABYLON.Color3.FromHexString(team.glow);
    mat.diffuseColor = BABYLON.Color3.Black();
    mat.specularColor = BABYLON.Color3.Black();
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 0;

    const disc = BABYLON.MeshBuilder.CreateDisc('thinkingRune', { radius: 0.45, tessellation: 48 }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.material = mat;
    disc.isPickable = false;
    return { disc, mat };
  }

  class PieceManager {
    constructor({ scene, board, factory, effects, ctx }) {
      this.scene = scene;
      this.board = board;
      this.factory = factory;
      this.effects = effects;
      this.ctx = ctx;
      this.bySquare = new Map();   // sq -> CharacterBase
      this.byId = new Map();       // id -> CharacterBase
      this._nextId = 1;
      this._idleObserver = null;
      this._fidgetCheckAt = 0;
      this._fidgetLast = 0;
      this.fidgetGate = null;
      this._selectedChar = null;
      this._thinking = null; // { disc, mat, observer, color } while a rune is shown/fading
    }

    _desiredFromBoard(gameBoard) {
      const list = [];
      for (let r = 0; r < 8; r++) {
        for (let c = 0; c < 8; c++) {
          const p = gameBoard[r][c];
          if (p) list.push({ sq: rcToSq(r, c), type: p.type, color: p.color });
        }
      }
      return list;
    }

    // Wipes every character and rebuilds from scratch. Used at start/new game.
    async syncInstant(gameBoard) {
      for (const ch of this.byId.values()) ch.dispose();
      this.byId.clear();
      this.bySquare.clear();
      const desired = this._desiredFromBoard(gameBoard);
      await Promise.all(desired.map(async (d) => {
        const id = 'c' + (this._nextId++);
        const ch = await this.factory.create(d.type, d.color, id);
        ch.setPosition(this.board.squareToWorld(d.sq));
        this.byId.set(id, ch);
        this.bySquare.set(d.sq, ch);
      }));
    }

    // Makes the 3D board match gameBoard with the minimum amount of churn:
    // keep pieces that didn't move, slide the nearest matching piece onto any
    // new occupied square, dissolve leftovers, spawn any still-missing piece.
    async reconcile(gameBoard, opts) {
      opts = opts || {};
      const animate = opts.animate !== false;
      const desired = this._desiredFromBoard(gameBoard);
      const matchedChars = new Set();
      const matchedDesired = new Array(desired.length).fill(false);
      const newBySquare = new Map();
      const jobs = [];

      // 1. Keep in place: same square, same type & color.
      desired.forEach((d, i) => {
        const ch = this.bySquare.get(d.sq);
        if (ch && ch.alive && ch.type === d.type && ch.color === d.color && !matchedChars.has(ch)) {
          matchedChars.add(ch);
          matchedDesired[i] = true;
          newBySquare.set(d.sq, ch);
        }
      });

      // 2. Move: nearest unmatched character of the same type & color.
      const candidates = [...this.byId.values()];
      desired.forEach((d, i) => {
        if (matchedDesired[i]) return;
        let best = null;
        let bestDist = Infinity;
        for (const ch of candidates) {
          if (matchedChars.has(ch) || !ch.alive || ch.type !== d.type || ch.color !== d.color) continue;
          const fromSq = this.squareOfCharacter(ch.id);
          const dist = fromSq ? squareDistance(fromSq, d.sq) : 0;
          if (dist < bestDist) { bestDist = dist; best = ch; }
        }
        if (!best) return;
        matchedChars.add(best);
        matchedDesired[i] = true;
        newBySquare.set(d.sq, best);
        const toPos = this.board.squareToWorld(d.sq);
        if (animate) {
          const from = best.root.position.clone();
          jobs.push(Tween.run(TIMING.reconcileFade * 1.5, (t) => {
            best.root.position = BABYLON.Vector3.Lerp(from, toPos, t);
          }, Tween.Ease.inOutCubic));
        } else {
          best.setPosition(toPos);
        }
      });

      // 3. Remove: characters still unmatched.
      for (const ch of candidates) {
        if (matchedChars.has(ch)) continue;
        this.byId.delete(ch.id);
        if (animate) {
          jobs.push(Tween.run(TIMING.reconcileFade, (t) => {
            const s = Math.max(0.001, 1 - t);
            ch.root.scaling.set(s, s, s);
          }).then(() => ch.dispose()));
        } else {
          ch.dispose();
        }
      }

      // 4. Create: desired entries still without a character.
      desired.forEach((d, i) => {
        if (matchedDesired[i]) return;
        jobs.push((async () => {
          const id = 'c' + (this._nextId++);
          const ch = await this.factory.create(d.type, d.color, id);
          ch.setPosition(this.board.squareToWorld(d.sq));
          this.byId.set(id, ch);
          newBySquare.set(d.sq, ch);
          if (animate) await ch.fadeIn(TIMING.reconcileFade);
        })());
      });

      await Promise.all(jobs);
      this.bySquare = newBySquare;
    }

    // Phase 6 version (plan §10.3 + §11.2/§11.4): capture cinematic + promotion
    // sequence. input: { from, to, result, moving, mover, cinematic }. `result`
    // is the object returned by ChessGame#makeMove; `moving` is a copy of the
    // piece taken BEFORE makeMove ran (so its .type is the pre-promotion type).
    async animateMove({ from, to, result, moving, mover, cinematic }) {
      const char = this.bySquare.get(from);
      if (!char) return; // reconcile() (called right after) fixes the scene

      if (result.castle) {
        const rank = from[1];
        const rookFrom = (result.castle === 'K' ? 'h' : 'a') + rank;
        const rookTo = (result.castle === 'K' ? 'f' : 'd') + rank;
        const rookChar = this.bySquare.get(rookFrom);
        await Promise.all([
          char.moveTo(this.board.squareToWorld(to), 'walk'),
          rookChar ? rookChar.moveTo(this.board.squareToWorld(rookTo), 'walk') : Promise.resolve()
        ]);
        this.bySquare.delete(from);
        this.bySquare.set(to, char);
        if (rookChar) {
          this.bySquare.delete(rookFrom);
          this.bySquare.set(rookTo, rookChar);
        }
        return;
      }

      const style = moving.type === 'n' ? 'leap' : 'walk';
      let captureSq = null;
      if (result.captured) {
        captureSq = result.enPassant ? rcToSq(sqToRc(from)[0], sqToRc(to)[1]) : to;
        const victim = this.bySquare.get(captureSq);
        if (victim) {
          await this.captureChoreography(char, victim, from, to, captureSq, moving.type, mover, cinematic);
        } else {
          // Scene already out of sync (shouldn't normally happen); reconcile() fixes it after.
          ChessSound.playCapture();
          await char.moveTo(this.board.squareToWorld(to), style);
        }
      } else {
        await char.moveTo(this.board.squareToWorld(to), style);
      }

      this.bySquare.delete(from);
      if (captureSq) this.bySquare.delete(captureSq); // captureChoreography already removed it; harmless no-op
      this.bySquare.set(to, char);

      if (result.promotion) {
        await this.promotionSequence(to, char, result.history.promotion);
      }
    }

    // Capture choreography (plan §11.2): camera focuses in (if cinematic),
    // attacker turns/closes in and strikes, victim reacts/dies/dissolves,
    // attacker then walks on to the destination square and the camera restores.
    // `movingType` is the ATTACKER's pre-move piece type (e.g. still 'p' even
    // if this capture also promotes it).
    async captureChoreography(attacker, victim, from, to, captureSq, movingType, mover, cinematic) {
      const isRanged = movingType === 'b' || movingType === 'q';
      const victimPos = this.board.squareToWorld(captureSq);
      const toPos = this.board.squareToWorld(to);
      const attackerTeam = Config.TEAM[attacker.color];
      const fx = this.effects;

      if (cinematic) await window.Chess3D.Cinematic.focusOnCapture(attacker.root.position.clone(), victimPos);
      victim.faceTowards(attacker.root.position, TIMING.turn); // not awaited: happens alongside the attacker's approach

      if (isRanged) {
        await attacker.faceTowards(victimPos, TIMING.turn);
        await attacker.playAttack(victimPos); // resolves at the moment the projectile/lightning lands
      } else if (typeof attacker.playCharge === 'function') {
        // Knight: gallops from its own square straight at the victim and
        // runs it through; resolves at impact.
        await attacker.playCharge(victimPos);
      } else {
        const attackerPos = attacker.root.position;
        let dir = victimPos.subtract(attackerPos);
        dir.y = 0;
        dir = (dir.lengthSquared() > 1e-8) ? dir.normalize() : new BABYLON.Vector3(0, 0, 1);
        const approach = victimPos.subtract(dir.scale(0.62)); // stop just short of the victim's square
        await attacker.moveTo(approach, movingType === 'n' ? 'leap' : 'walk', { keepFacing: true });
        await attacker.playAttack(victimPos); // resolves at impact
      }

      // Impact instant: sound, camera punch and a burst all fire together here
      // (instead of at move-issue time) so the clash actually reads as two pieces
      // fighting rather than a silent swing that's over before you notice it.
      ChessSound.playCapture();
      if (window.Chess3D.Cinematic.impactShake) window.Chess3D.Cinematic.impactShake();
      if (fx && fx.sparks) fx.sparks(victimPos.add(new BABYLON.Vector3(0, 0.5, 0)), attackerTeam.glow);
      if (fx && fx.shockwave) fx.shockwave(victimPos.clone(), attackerTeam.glow);
      // A brief mutual flash on BOTH fighters (not just the victim later) so the
      // clash reads as two pieces colliding, not just the attacker's arm moving.
      attacker.setFlash(0.7);
      Tween.run(260, (t) => attacker.setFlash(0.7 * (1 - t)), Tween.Ease.outCubic).then(() => attacker.setFlash(0));
      // A held beat right on impact (a hit-stop) gives the eye time to register the
      // clash before the death/dissolve rush takes over — without this, the strike
      // and the burst are gone in the same frame they appear.
      await Tween.wait(260);
      attacker.playRecover(); // not awaited: recovers while the victim reacts

      const vortex = attacker.activeVortex; // bishop: the tornado is still churning over the victim
      if (vortex) {
        attacker.activeVortex = null;
        await victim.playSwept();
        vortex.dissipate(); // not awaited: lifts away while the victim is torn apart
        await victim.dissolve();
      } else {
        await victim.playHit();
        // King: swing the camera onto him so his death and rising soul fill the frame.
        const closeUp = cinematic && victim.type === 'k' && window.Chess3D.Cinematic.focusOnPoint
          ? window.Chess3D.Cinematic.focusOnPoint(victimPos, { facing: victim.root.rotation.y, lift: 1.3, radius: 5.5, beta: 1.02 }) : null;
        await victim.playDeath();
        if (closeUp) await closeUp;
        await victim.dissolve();
      }
      // King: keep the camera on the square until its soul has risen out of sight.
      if (victim.soulDone) await victim.soulDone;
      victim.dispose();
      this.bySquare.delete(captureSq);

      await attacker.moveTo(toPos, 'walk', { keepFacing: false });
      if (cinematic) await window.Chess3D.Cinematic.restore();
    }

    // Promotion sequence (plan §11.4): the pawn dissolves in a pillar of light
    // and a freshly-built character of the new type fades in on the same square.
    async promotionSequence(sq, pawnChar, newType) {
      const pos = this.board.squareToWorld(sq);
      const team = Config.TEAM[pawnChar.color];
      const fx = this.effects;
      if (fx && fx.promotionPillar) fx.promotionPillar(pos, team.accent); // not awaited

      await pawnChar.dissolve();
      pawnChar.dispose();
      this.byId.delete(pawnChar.id);

      const id = 'c' + (this._nextId++);
      const newChar = await this.factory.create(newType, pawnChar.color, id);
      newChar.setPosition(pos);
      await newChar.fadeIn(400);
      newChar.playVictory(); // not awaited

      this.byId.set(id, newChar);
      this.bySquare.set(sq, newChar);
    }

    squareOfCharacter(id) {
      for (const [sq, ch] of this.bySquare) {
        if (ch.id === id) return sq;
      }
      return null;
    }

    characterAt(sq) {
      return this.bySquare.get(sq) || null;
    }

    setSelected(sq) {
      if (this._selectedChar) this._selectedChar.setSelected(false);
      this._selectedChar = sq ? this.characterAt(sq) : null;
      if (this._selectedChar) this._selectedChar.setSelected(true);
    }

    // Plan §13.1: spinning rune above the thinking side's King, fading in/out.
    setThinking(color, on) {
      if (on) {
        if (this._thinking) return; // already showing (e.g. re-entrant call)
        let kingChar = null;
        for (const ch of this.byId.values()) {
          if (ch.alive && ch.color === color && ch.type === 'k') { kingChar = ch; break; }
        }
        if (!kingChar) return; // King already off the board (shouldn't happen while it can still move)
        const { disc, mat } = buildThinkingRune(this.scene, color);
        const yOffset = (Config.PIECE_HEIGHT.k || 1.2) + 0.4;
        disc.position.set(kingChar.root.position.x, kingChar.root.position.y + yOffset, kingChar.root.position.z);
        const observer = this.scene.onBeforeRenderObservable.add(() => {
          const dt = this.scene.getEngine().getDeltaTime() / 1000;
          disc.rotation.y += 1.5 * dt;
          disc.position.x = kingChar.root.position.x;
          disc.position.z = kingChar.root.position.z;
          disc.position.y = kingChar.root.position.y + yOffset;
        });
        this._thinking = { disc, mat, observer, color };
        Tween.run(200, (t) => { mat.alpha = t; });
      } else {
        if (!this._thinking || this._thinking.color !== color) return;
        const { disc, mat, observer } = this._thinking;
        this._thinking = null;
        Tween.run(200, (t) => { mat.alpha = 1 - t; }).then(() => {
          this.scene.onBeforeRenderObservable.remove(observer);
          disc.dispose();
          mat.dispose();
        });
      }
    }

    // Perf: Babylon walks every mesh in the scene each frame to find what to
    // draw, including the ~1300 rig meshes that the instance pool and idle
    // proxies keep disabled (~2.5 us each, ~4 ms a frame). Give it a list
    // without them; rebuilt only when a piece's proxy state changes
    // (CharacterBase.proxyEpoch) or meshes are added/removed. Only meshes this
    // code itself disabled are left out, so anything else toggling a mesh
    // still works as before.
    _installCandidateFilter() {
      const scene = this.scene, CB = window.Chess3D.CharacterBase;
      const list = { data: [], length: 0 };
      let epoch = -1, stale = true;
      const markStale = () => { stale = true; };
      scene.onNewMeshAddedObservable.add(markStale);
      scene.onMeshRemovedObservable.add(markStale);
      scene.getActiveMeshCandidates = () => {
        if (stale || CB.proxyEpoch !== epoch) {
          epoch = CB.proxyEpoch;
          stale = false;
          const hidden = new Set();
          for (const ch of this.byId.values()) {
            if (ch._pooled) ch._pooled.hidden.forEach((m) => hidden.add(m));
            if (ch._proxy) ch._proxy.hidden.forEach((m) => hidden.add(m));
          }
          list.data = hidden.size ? scene.meshes.filter((m) => !hidden.has(m)) : scene.meshes;
          list.length = list.data.length;
        }
        return list;
      };
    }

    startIdleLoop() {
      if (this._idleObserver) return;
      this._installCandidateFilter();
      this._idleObserver = this.scene.onBeforeRenderObservable.add(() => {
        const now = performance.now(), t = now / 1000;
        const pool = window.Chess3D.InstancePool;
        // At most one heavy merge per frame (InstancePool source set, idle
        // proxy or reflection mesh); cheap pool joins are always allowed.
        let heavy = false;
        for (const ch of this.byId.values()) {
          if (!ch.busy) {
            if (ch._pooled) ch.updateIdlePooled(t);
            else ch.updateIdle(t);
          }
          if (ch.tickProxy && ch.tickProxy(now, !heavy)) heavy = true;
        }
        this.tickFidgets(now);
        // After updateIdle so instance matrices pick up this frame's bob.
        if (pool) pool.update(!heavy);
      });
    }

    // Idle fidgets (pawn-fidgets.js, king-fidgets.js): a pawn or king that has
    // stood still for its own random wait does something to pass the time, a
    // couple at a time at most. `fidgetGate()` (set by game3d) says whether the
    // scene may play them now.
    tickFidgets(now) {
      const Pawn = window.Chess3D.PawnCharacter, F = Pawn && Pawn.FIDGET;
      if (!F || now < this._fidgetCheckAt) return;
      this._fidgetCheckAt = now + 400;
      if (document.hidden || (this.fidgetGate && !this.fidgetGate()) || now - this._fidgetLast < F.gap) return;
      let running = 0;
      const due = [];
      for (const ch of this.byId.values()) {
        if (ch instanceof Pawn) {
          if (ch._fid) running++;
          else if (ch.canFidget() && ch.fidgetDue(now)) due.push(ch);
        } else if (ch.canKingFidget) {
          if (ch._kfid) running++;
          else if (ch.canKingFidget() && ch.kingFidgetDue(now)) due.push(ch);
        }
      }
      if (!due.length || running >= F.maxConcurrent) return;
      const ch = due[Math.floor(Math.random() * due.length)];
      this._fidgetLast = now;
      if (ch instanceof Pawn) ch.startFidget(this.idleNeighbours(ch));
      else ch.startKingFidget();
    }

    // Idle pawns standing on the squares next to `ch` (not diagonally).
    idleNeighbours(ch) {
      const sq = this.squareOfCharacter(ch.id);
      if (!sq) return [];
      const [r, c] = sqToRc(sq), out = [];
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dr, dc]) => {
        if (r + dr < 0 || r + dr > 7 || c + dc < 0 || c + dc > 7) return;
        const n = this.bySquare.get(rcToSq(r + dr, c + dc));
        if (n && n !== ch && n instanceof ch.constructor && n.canFidget()) out.push(n);
      });
      return out;
    }
  }

  window.Chess3D.PieceManager = PieceManager;
})();
