// Pawn idle fidgets: now and then a pawn that has stood still for a while
// does something to pass the time (PieceManager picks who and when, see
// tickFidgets in pieces3d.js):
//   footScratch  stands on one leg and rubs the calf with the other foot
//   headScratch  takes the left hand off the shield and scratches the helm
//   sit          puts the sword and shield down, sits on the floor, hands on
//                his knees, bored, looking about
//   polish       lifts the sword and wipes the blade with a cloth, then
//                holds it up to catch the light
//   lookAround   glances left and right, then up, then shrugs
//   poke         (two pawns side by side) prods the neighbour with his sword
//                tip; the neighbour turns round and slaps him on the helm
//
// A fidget is a script of pose keyframes on the pawn's rig (the same pose
// system as walking and attacking). While it runs the pawn is `_fid` (a token
// shared with the neighbour in a poke): it draws live instead of in the
// instance pool and the idle sway is paused. Anything a game animation does
// to the pawn (busy = true) aborts the token; the neighbour then settles back
// to its stance by itself.
(function () {
  const Config = window.Chess3D.Config;
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const PawnCharacter = window.Chess3D.PawnCharacter;
  const { TAU, hex, V3, lerp, clamp, smoothstep, curve } = window.Chess3D.SurfaceKit;
  const { restPose, marchPose, withPose, clonePose, mixPose, flat, unflat, swordAt, STAND_Y, ANK, S, SWORD } = PawnCharacter.kit;
  const Vec = BABYLON.Vector3;
  const proto = PawnCharacter.prototype;

  // minDelay/maxDelay: how long a pawn stands idle before its fidget is due
  // (ms, at animSpeed 1); maxConcurrent / gap: how many run at once and the
  // least time between two starts.
  const FIDGET = { minDelay: 14000, maxDelay: 40000, maxConcurrent: 2, gap: 2500 };
  PawnCharacter.FIDGET = FIDGET;

  const BLADE_REACH = SWORD.blade - SWORD.grip;   // hand to tip
  const shortest = (d) => { d %= TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };
  const nowSec = () => performance.now() / 1000;
  const sound = (name, ...args) => { const s = window.ChessSound; if (s && s[name]) s[name](...args); };

  // ------------------------------------------------------------ lifecycle
  // Is he free to start something?
  proto.canFidget = function () {
    return this.alive && !this._busy && !this._fid && !this._selectedOn && !this._shattered && this._stance === 'rest' &&
      !!this._cur && this.root.scaling.x > 0.99;
  };

  // True once he has been idle for his own random wait (re-rolled every time
  // he goes idle again).
  proto.fidgetDue = function (now) {
    if (this._fidgetFor !== this._idleSince) {
      this._fidgetFor = this._idleSince;
      this._fidgetAt = this._idleSince + FIDGET.minDelay + Math.random() * (FIDGET.maxDelay - FIDGET.minDelay);
    }
    return now >= this._fidgetAt;
  };

  // Picks a fidget (`neighbours`: idle pawns standing orthogonally next to
  // him, for the poke) and plays it. Resolves when it is over or cut short.
  proto.startFidget = function (neighbours) {
    const kinds = ['footScratch', 'headScratch', 'sit', 'polish', 'lookAround'];
    let partner = null;
    if (neighbours && neighbours.length && Math.random() < 0.3) {
      partner = neighbours[Math.floor(Math.random() * neighbours.length)];
      return this.playFidget('poke', partner);
    }
    return this.playFidget(kinds[Math.floor(Math.random() * kinds.length)]);
  };

  proto.playFidget = async function (kind, partner) {
    const tok = this._fidBegin(partner);
    try {
      await SCRIPTS[kind].call(this, tok, partner);
    } catch (e) {
      console.warn('[Chess3D] pawn fidget failed:', e);
      this._endFidget(true);
      return;
    }
    if (tok.abort) return;
    await Promise.all(tok.members.map((m) => m._fidReturn(tok, kind === 'sit' ? 1000 : 480)));
    this._fidEnd(tok);
  };

  proto._fidBegin = function (partner) {
    const tok = { abort: false, members: partner ? [this, partner] : [this] };
    tok.members.forEach((m) => { m._fid = tok; m._showLive(); });
    return tok;
  };

  // Back to plain idling: the instance pool takes him again after a moment.
  proto._fidEnd = function (tok) {
    tok.members.forEach((m) => {
      if (m._fid !== tok) return;
      m._fid = null;
      m._idleStance = undefined;          // updateIdle re-poses at once
      m._idleSince = performance.now();
      m.visual.position.x = 0; m.visual.position.z = 0;
      m._fClean();
    });
  };

  // Cut short. `settle`: also bring this pawn gently back to its stance (a
  // game animation taking him over does that itself); the neighbour in a poke
  // always settles.
  proto._endFidget = function (settle) {
    const tok = this._fid;
    if (!tok) return;
    tok.abort = true;
    tok.members.forEach((m) => {
      if (m._fid !== tok) return;
      m._fid = null;
      m._fClean();
      if (!m.alive) return;
      if (m !== this || settle) m._fSettle();
      else { m.visual.position.x = 0; m.visual.position.z = 0; }
    });
  };

  proto._fClean = function () {
    this._fCloth(false);
    if (this._fFlash) { this._fFlash = false; if (this.alive) this.setFlash(0); }
  };

  proto._fSettle = function () {
    if (this._busy) { this.visual.position.x = 0; this.visual.position.z = 0; return; }
    const tok = this._fid = { abort: false, members: [this] };
    this._fidReturn(tok, 420).then(() => this._fidEnd(tok));
  };

  // Blend to the resting stance: pose, facing and any lean-out together.
  proto._fidReturn = function (tok, ms) {
    const from = clonePose(this._cur), rest = restPose();
    const yaw0 = this.root.rotation.y, dy = shortest(this.baseFacing - yaw0);
    const vx = this.visual.position.x, vz = this.visual.position.z;
    return this._fseq(tok, ms, (t, raw) => {
      const e = Ease.inOutCubic(raw);
      this.root.rotation.y = yaw0 + dy * e;
      this.visual.position.x = vx * (1 - e); this.visual.position.z = vz * (1 - e);
      this._applyPose(mixPose(from, rest, e));
    });
  };

  // ------------------------------------------------------------ script helpers
  // A tween that stops doing anything once the token is aborted. fn(ms, 0..1).
  proto._fseq = function (tok, ms, fn) {
    return Tween.run(ms, (_, raw) => {
      if (tok.abort || !this.alive) return;
      this.visual.position.y = this.selectLift;
      fn(raw * ms, raw);
    }, Ease.linear);
  };

  // Keyframes [[ms, pose], ...] (the first is the pose to start from). The
  // optional `frame(ms, P, raw)` may adjust each frame's pose before it is applied.
  proto._fkeys = function (tok, keys, frame) {
    const like = keys[0][1], total = keys[keys.length - 1][0];
    const fk = keys.map(([t, P]) => [t, ...flat(P)]);
    return this._fseq(tok, total, (t, raw) => {
      const P = unflat(curve(fk, t), like);
      if (frame) frame(t, P, raw);
      this._applyPose(P);
    });
  };

  // The standing sway of updateIdle, for poses held for a while.
  proto._fSway = function (P, t) {
    const ph = this.idlePhase;
    P.chest[0] += 0.012 * Math.sin(t * 1.4 + ph);
    P.spine[0] += 0.004 * Math.sin(t * 1.4 + ph + 0.4);
    P.head[1] += 0.14 * Math.sin(t * 0.3 + ph) + 0.04 * Math.sin(t * 0.8 + ph * 2);
    P.head[0] += 0.02 * Math.sin(t * 0.45 + ph);
  };

  // Stand still (swaying) in `base`, easing there from the current pose.
  proto._fHold = function (tok, ms, base, frame) {
    const from = clonePose(this._cur);
    return this._fseq(tok, ms, (t, raw) => {
      const P = clonePose(base || restPose());
      this._fSway(P, nowSec());
      if (frame) frame(t, P, raw);
      this._applyPose(mixPose(from, P, smoothstep(0, 0.25, raw)));
    });
  };

  // Turn on the spot, stepping from foot to foot.
  proto._fTurn = function (tok, yaw, ms) {
    const start = this.root.rotation.y, diff = shortest(yaw - start), from = clonePose(this._cur);
    const steps = Math.max(1, Math.round(Math.abs(diff) / 0.9));
    return this._fseq(tok, ms, (t, raw) => {
      this.root.rotation.y = start + diff * Ease.inOutCubic(raw);
      const P = restPose(), ph = raw * steps * Math.PI;
      P.footR[1] += 0.035 * Math.max(0, Math.sin(ph * 2));
      P.footL[1] += 0.035 * Math.max(0, -Math.sin(ph * 2));
      P.hips[0] = 0.01 * Math.sin(ph * 2);
      this._fSway(P, nowSec());
      this._applyPose(mixPose(from, P, smoothstep(0, 0.2, raw)));
    });
  };

  // World direction -> this pawn's root-local (visual offsets live there).
  proto._fLocal = function (w) {
    const th = this.root.rotation.y, c = Math.cos(th), s = Math.sin(th);
    return { x: w.x * c - w.z * s, z: w.x * s + w.z * c };
  };
  // World point -> body space (where pose targets are given).
  proto._fInv = function () {
    this.root.computeWorldMatrix(true); this.visual.computeWorldMatrix(true); this.rig.base.computeWorldMatrix(true);
    return this.rig.base.getWorldMatrix().clone().invert();
  };
  proto._fBody = function (p, inv) { return Vec.TransformCoordinates(p, inv || this._fInv()); };
  proto._fFlashTo = function (a) { this._fFlash = a > 0; this.setFlash(a); };

  // A cloth wrapped round the left fist, for polishing.
  proto._fCloth = function (on) {
    if (on && !this._cloth) {
      const team = Config.TEAM[this.color];
      const m = new BABYLON.StandardMaterial(`cloth_${this.id}`, this.scene);
      m.diffuseColor = hex(team.cloth); m.specularColor = BABYLON.Color3.Black(); m.emissiveColor = hex(team.cloth).scale(0.2);
      const c = BABYLON.MeshBuilder.CreateSphere(`cloth_${this.id}`, { diameter: 0.07, segments: 8 }, this.scene);
      c.material = m; c.parent = this.rig.handL; c.position.set(0.012, -0.062, 0); c.scaling.set(1.35, 1.1, 1.35);
      c.isPickable = false;
      this._cloth = c;
      this._ownMats.push(m);
    }
    if (this._cloth && this._cloth.isEnabled() !== on) {
      this._cloth.setEnabled(on);
      if (this.scene._activeMeshesFrozen) this.scene.unfreezeActiveMeshes();
    }
  };

  // ------------------------------------------------------------ scripts
  const SCRIPTS = {};

  // Weight on the left leg, the right foot crossed behind it, rubbing the calf.
  SCRIPTS.footScratch = async function (tok) {
    const R0 = restPose(), cur = clonePose(this._cur);
    const up = withPose(R0, {
      hips: [-0.055, STAND_Y - 0.008, 0], spine: [0.05, 0, 0], chest: [0.06, 0.1, 0], head: [0.3, 0.12, 0],
      footR: [-0.085, ANK + 0.19, -0.085, -0.3, -0.5], kneeOut: 0.1, elbowR: [1, -0.4, -0.5]
    });
    const T0 = 480, RUB = 1700, END = T0 + RUB + 500;
    await this._fkeys(tok, [[0, cur], [T0, up], [T0 + RUB, up], [END, withPose(up, { head: [0.1, -0.1, 0] })]], (t, P) => {
      const w = smoothstep(T0, T0 + 180, t) * (1 - smoothstep(T0 + RUB - 150, T0 + RUB, t));
      const ph = (t - T0) / 1000 * TAU * 2.8;
      P.footR[1] += 0.05 * Math.sin(ph) * w;
      P.footR[2] -= 0.012 * Math.sin(ph + 1.2) * w;
      P.head[0] += 0.03 * Math.sin(ph * 0.5) * w;
    });
  };

  // The left hand leaves the shield rim and scratches the side of the helm.
  SCRIPTS.headScratch = async function (tok) {
    const R0 = restPose(), cur = clonePose(this._cur);
    const away = withPose(R0, { free: 0.5, handL: [-0.2, 0.86, 0.05], thumbL: [0.1, 0.3, 1], elbowL: [-1, 0.1, -0.3] });
    const up = withPose(R0, {
      free: 1, handL: [-0.094, 1.045, 0.012], thumbL: [0.1, 0.25, 1], elbowL: [-1, 0.25, -0.35],
      head: [0.04, 0.14, 0.1], chest: [-0.02, 0.04, 0.02]
    });
    const T0 = 520, SCR = 1700, END = T0 + SCR + 550;
    const clinks = [T0 + 250, T0 + 600, T0 + 950, T0 + 1300];
    let next = 0;
    await this._fkeys(tok, [[0, cur], [300, away], [T0, up], [T0 + SCR, up], [END, withPose(up, { head: [0.0, -0.1, 0.0] })]], (t, P) => {
      const w = smoothstep(T0, T0 + 150, t) * (1 - smoothstep(T0 + SCR - 150, T0 + SCR, t));
      const ph = (t - T0) / 1000 * TAU * 3.4;
      P.handL[2] += 0.032 * Math.sin(ph) * w;
      P.handL[1] += 0.012 * Math.sin(ph * 2 + 0.6) * w;
      P.handL[0] += 0.006 * Math.sin(ph) * w;
      P.head[2] += 0.02 * Math.sin(ph) * w;
      while (next < clinks.length && t >= clinks[next]) { sound('playClink', 0.1, 1.1 + 0.25 * Math.random()); next++; }
    });
  };

  // Lays the sword and shield down on the floor, sits on the ground with his
  // knees up and both hands resting on them, looking about for something to do.
  SCRIPTS.sit = async function (tok) {
    const R0 = restPose(), cur = clonePose(this._cur);
    const lying = {
      sword: swordAt([0.4, 0.016, -0.3], [0.04, 0, 1], 0),
      shield: [-0.5, 0.014, 0.0, 0.3, -Math.PI / 2, 0]
    };
    const crouch = withPose(R0, {
      hips: [0, 0.3, -0.05], spine: [0.3, 0, 0], chest: [0.1, 0, 0], head: [0.1, 0, 0],
      footR: [0.14, ANK, 0.08, 0, 0.3], footL: [-0.14, ANK, 0.08, 0, -0.3], kneeOut: 0.6,
      sword: swordAt([0.24, 0.32, 0.22], [0.5, -1, 0.1], 0)
    });
    const drop = withPose(crouch, Object.assign({
      hips: [0, 0.2, -0.1], spine: [0.34, 0, 0], free: 1, freeR: 1, handL: [-0.17, 0.3, 0.1], handR: [0.17, 0.3, 0.1],
      thumbL: [0, 0.3, 1], thumbR: [0, 0.3, 1], elbowL: [-1, 0.3, -0.5], elbowR: [1, 0.3, -0.5]
    }, lying));
    const sat = withPose(drop, {
      // leaning well forward, elbows on his knees, the fists clasped under his chin
      hips: [0, 0.075, -0.13], spine: [0.42, 0, 0], chest: [0.4, 0, 0], head: [-0.62, 0, 0],
      footR: [0.12, ANK, 0.2, 0, 0.25], footL: [-0.12, ANK, 0.2, 0, -0.25], kneeOut: 0.3,
      handL: [-0.025, 0.33, 0.27], handR: [0.025, 0.33, 0.27], thumbL: [0.3, 0.2, 1], thumbR: [-0.3, 0.2, 1],
      elbowL: [-1, -1, 0.3], elbowR: [1, -1, 0.3]
    });
    const T0 = 500, T1 = 1000, T2 = 1700, HOLD = 3600;
    let clanged = false;
    await this._fkeys(tok, [[0, cur], [T0, crouch], [T1, drop], [T2, sat], [T2 + HOLD, sat]], (t, P) => {
      const s = (t - T2) / 1000, w = smoothstep(T2 - 150, T2 + 250, t);
      P.head[1] += (0.85 * Math.sin(s * 1.5) + 0.2 * Math.sin(s * 3.1)) * w;
      P.head[0] += 0.1 * Math.sin(s * 0.9 + 1) * w;
      P.chest[0] += 0.012 * Math.sin(s * 1.6) * w;
      if (!clanged && t >= T1 - 150) {
        clanged = true;
        sound('playClang', 0.45, 0.6);
        sound('playClink', 0.4, 0.7);
      }
    });
  };

  // Lifts the sword across his chest, wipes it from guard to point with a
  // cloth three times, then holds it up and it catches the light.
  SCRIPTS.polish = async function (tok) {
    const R0 = restPose(), cur = clonePose(this._cur);
    // the blade across his chest, the left hand sliding along it within reach
    const held = withPose(R0, {
      sword: swordAt([0.2, 0.84, 0.27], [-1, 0.1, 0.1], 0), glow: 0.2, free: 1, thumbL: [-1, 0.1, 0.1], elbowL: [-1, -0.5, -0.2],
      elbowR: [1, -0.6, 0.1], spine: [0.05, 0, 0], chest: [0.08, 0.1, 0], head: [0.32, -0.15, 0]
    });
    const raised = withPose(held, {
      sword: swordAt([0.2, 0.9, 0.25], [0.05, 1, 0.2], 0), glow: 1.15, free: 0, head: [-0.25, 0.1, 0.05], chest: [-0.03, 0.05, 0]
    });
    const T0 = 560, WIPE = 2500, T1 = T0 + WIPE, UP = 450, END = T1 + UP + 800;
    let shone = false;
    this._fCloth(true);
    await this._fkeys(tok, [[0, cur], [T0, held], [T1, held], [T1 + UP, raised], [END, raised]], (t, P) => {
      const D = V3(P.sword[3], P.sword[4], P.sword[5]);
      let s = 0.14;
      if (t > T0 && t < T1) s = 0.14 + 0.4 * (0.5 - 0.5 * Math.cos((t - T0) / WIPE * 3 * TAU));
      P.handL = [P.sword[0] + D.x * s, P.sword[1] + D.y * s, P.sword[2] + D.z * s];
      P.thumbL = [D.x, D.y, D.z];
      if (!shone && t >= T1 + UP) {
        shone = true;
        this._fCloth(false);
        sound('playClink', 0.35, 1.7);
        sound('playMagic', 0.08);
        if (this._glint) this._glint.wait = 0;
      }
    });
    this._fCloth(false);
  };

  // A glance right, a long look left, a look up, a shrug.
  SCRIPTS.lookAround = async function (tok) {
    const R0 = restPose(), cur = clonePose(this._cur);
    const look = (yaw, pitch, turn) => withPose(R0, { head: [pitch, yaw, 0], chest: [0.0, turn, 0], hipsRot: [0, turn * 0.5, 0], neck: [0, yaw * 0.15, 0] });
    const shrug = withPose(R0, { chest: [0.05, 0, 0], head: [0.12, 0, 0.06], hips: [0, STAND_Y - 0.012, 0], spine: [0.03, 0, 0] });
    const keys = [[0, cur], [380, look(0.95, -0.04, 0.25)], [1150, look(0.95, -0.04, 0.25)], [1550, look(-1.05, 0.0, -0.28)],
      [2450, look(-1.05, 0.0, -0.28)], [2800, look(0.5, 0.0, 0.1)], [3050, look(0.0, -0.3, 0.0)], [3750, look(0.0, -0.3, 0.0)],
      [4050, shrug], [4500, shrug]];
    await this._fkeys(tok, keys, (t, P) => {
      P.head[1] += 0.03 * Math.sin(t * 0.011);
    });
  };

  // Two pawns side by side. A prods B with his sword tip three times; B
  // turns round and slaps A on the helm with his left hand, then shakes the
  // hand, which hurts. A, caught whistling, rubs his helm.
  SCRIPTS.poke = async function (tok, B) {
    const A = this, R0 = restPose(), M0 = marchPose();
    const team = Config.TEAM[A.color], fx = A.ctx && A.ctx.effects;
    const d = B.root.position.subtract(A.root.position); d.y = 0;
    const dist = d.length();
    d.scaleInPlace(1 / dist);
    const yawAB = Math.atan2(d.x, d.z), yawBA = yawAB + Math.PI;
    const headToA = clamp(shortest(yawBA - B.root.rotation.y), -1.15, 1.15);
    const ADV_A = 0.2;
    const alive = () => !tok.abort && A.alive && B.alive;
    const hit = { n: 0, last: -1e9 };

    // --- A's sword: the tip on B's side, the hand on the grip within reach
    const toA = d.scale(-1);
    const aim = (P, gap, w) => {
      const inv = A._fInv();
      const T = Vec.TransformCoordinates(B.rig.chest.getAbsolutePosition().add(toA.scale(0.085)).add(V3(0, 0.03, 0)), inv);
      const Hs = Vec.TransformCoordinates(A.rig.armR.getAbsolutePosition(), inv);
      const toT = T.subtract(Hs), L = Math.max(toT.length(), 1e-3);
      const D = T.subtract(Hs.add(toT.scale(0.28 / L))).normalize();
      let H = T.subtract(D.scale(BLADE_REACH + gap));
      const off = H.subtract(Hs), ol = off.length();
      if (ol > 0.37) H = Hs.add(off.scale(0.37 / ol));
      const q = swordAt([H.x, H.y, H.z], [D.x, D.y, D.z], 0);
      P.sword = P.sword.map((v, i) => lerp(v, q[i], w));
      P.elbowR = [1, -0.35, -0.15];
      return T;
    };
    const lunge = withPose(M0, {
      hips: [0, 0.41, -0.12], spine: [0.1, 0, 0], chest: [0.12, -0.08, 0], head: [0.0, 0, 0],
      footR: [0.12, ANK, 0.05, 0, 0.1], footL: [-0.12, ANK, -0.4, 0.3, -0.3], kneeOut: 0.2, glow: 0.4,
      handL: [0.0, 0.7, 0.26], shieldN: [0.25, 0, 1], strap: 1
    });

    // 1. A turns to B, who goes on standing.
    await Promise.all([A._fTurn(tok, yawAB, 520), B._fHold(tok, 520)]);
    if (!alive()) return;

    // 2. A lunges out over the rim of his base, B starts to look.
    const T2 = 460, CYC = 560, HITAT = 0.4, POKES = 3, T3 = POKES * CYC + 260;
    const turnHead = (t0, t1) => (t) => smoothstep(t0, t1, t);
    const bLook = turnHead(0, T2 + 500);
    const bFrame = (offset) => (t, P) => {
      const look = bLook(t + offset);
      const j = Math.max(0, 1 - (performance.now() - hit.last) / (230 / Tween.speed)) * (hit.n === POKES ? 1.5 : 1);
      P.head[1] = headToA * look + 0.05 * Math.sin(nowSec() * 5) * j;
      P.head[0] -= 0.12 * j;
      P.chest[0] -= 0.1 * j;
      P.chest[1] += 0.1 * j * Math.sign(headToA || 1);
      const away = B._fLocal(d), push = 0.04 * j * (hit.n === POKES ? 1.5 : 1);
      B.visual.position.x = away.x * push; B.visual.position.z = away.z * push;
    };
    const aFrame2 = (t, P, raw) => {
      A.visual.position.z = ADV_A * Ease.inOutCubic(raw);
      P.footR[1] += 0.05 * Math.sin(Math.PI * raw);
      aim(P, 0.2, smoothstep(0.3, 1, raw));
    };
    const bHold = clonePose(R0);
    const bFrameHold = (offset) => (t, P) => { B._fSway(P, nowSec()); bFrame(offset)(t, P); };
    await Promise.all([
      A._fkeys(tok, [[0, clonePose(A._cur)], [T2, lunge]], aFrame2),
      B._fseq(tok, T2, (t, raw) => { const P = clonePose(bHold); bFrameHold(0)(t, P); B._applyPose(P); })
    ]);
    if (!alive()) return;

    // 3. Three prods; B flinches each time and looks round.
    let fired = 0;
    await Promise.all([
      A._fkeys(tok, [[0, lunge], [T3, lunge]], (t, P) => {
        A.visual.position.z = ADV_A;
        const k = Math.floor(t / CYC), ph = (t - k * CYC) / CYC;
        const pulse = k >= POKES ? 0 : smoothstep(0, HITAT, ph) * (1 - smoothstep(HITAT + 0.04, 1, ph));
        const T = aim(P, 0.19 - 0.18 * pulse, 1);
        P.chest[0] += 0.04 * pulse;
        P.glow = 0.4 + 0.8 * pulse;
        while (fired < POKES && t >= fired * CYC + HITAT * CYC) {
          fired++;
          hit.n = fired; hit.last = performance.now();
          sound('playClink', 0.6, 1.0 + 0.06 * fired);
          if (fx && fx.burst) {
            const w = Vec.TransformCoordinates(T, A.rig.base.getWorldMatrix());
            fx.burst({ pos: w, color1: '#ffffff', color2: team.accent, count: 8, speed: { min: 0.3, max: 1 }, life: 0.25, size: 0.04, gravity: [0, -3, 0] });
          }
        }
      }),
      B._fseq(tok, T3, (t, raw) => { const P = clonePose(bHold); bFrameHold(T2)(t, P); B._applyPose(P); })
    ]);
    if (!alive()) return;

    // 4. A, caught: sword up, eyes elsewhere, whistling. B turns round, then
    // steps up to him and winds up his left hand.
    const innocent = withPose(R0, {
      hips: [0, 0.41, -0.12], footR: [0.12, ANK, 0.05, 0, 0.1], footL: [-0.12, ANK, -0.4, 0.3, -0.3], kneeOut: 0.2,
      sword: swordAt([0.2, 0.84, 0.1], [0.05, 1, 0.15], 0), glow: 0, head: [-0.2, -0.85, 0], chest: [-0.04, -0.15, 0],
      elbowR: [1, -0.5, -0.4]
    });
    const T4 = 600, T5 = 430, T6 = 150;
    sound('playWhistle', 0.9, 0.2);
    const aKeep = [[0, clonePose(A._cur)], [300, innocent], [T4 + T5 + T6 + 20, innocent]];
    const advB = clamp(dist - ADV_A - 0.42, 0.2, 0.5);
    const base = withPose(M0, {
      strap: 0, free: 1, hips: [0, 0.47, 0.0], spine: [0.12, 0, 0], chest: [0.1, 0, 0], head: [0.0, 0, 0],
      footR: [0.12, ANK, 0.22, 0, 0.1], footL: [-0.12, ANK, -0.2, 0.25, -0.2], kneeOut: 0.2, glow: 0.15,
      thumbL: [0, 1, 0.4], elbowL: [-1, 0.25, -0.3], handL: [-0.4, 0.98, 0.05]
    });
    const slapPath = (u) => {
      const inv = B._fInv();
      const C = Vec.TransformCoordinates(A.rig.face.getAbsolutePosition(), inv);
      C.z -= 0.085;
      const W = V3(-0.4, 0.98, 0.05), K = V3(-0.22, 1.04, C.z * 0.9);
      const a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
      return [a * W.x + b * K.x + c * C.x, a * W.y + b * K.y + c * C.y, a * W.z + b * K.z + c * C.z];
    };
    const plantShield = (P) => { const vz = B.visual.position.z / S; P.shield[2] -= vz; };
    let struck = false;
    const bScript = (async () => {
      await B._fTurn(tok, yawBA, T4 - 150);
      if (!alive()) return;
      await B._fHold(tok, 150);
      if (!alive()) return;
      // wind up
      const wind = withPose(base, { handL: [-0.4, 0.98, 0.05] });
      const cur = clonePose(B._cur);
      await B._fkeys(tok, [[0, cur], [T5, wind]], (t, P, raw) => {
        B.visual.position.z = advB * Ease.inOutCubic(raw);
        P.footR[1] += 0.05 * Math.sin(Math.PI * raw);
        plantShield(P);
      });
      if (!alive()) return;
      // swing
      await B._fseq(tok, T6, (t, raw) => {
        const P = clonePose(wind), u = Ease.inCubic(raw);
        P.handL = slapPath(u);
        P.chest[1] = lerp(-0.2, 0.2, u);
        P.spine[1] = lerp(-0.1, 0.1, u);
        plantShield(P);
        B._applyPose(P);
      });
    })();
    await Promise.all([A._fkeys(tok, aKeep, (t, P) => { A.visual.position.z = ADV_A; }), bScript]);
    if (!alive()) return;

    // 5. Smack. A's head whips round, his helm rings, he staggers; B follows
    // through and shakes his stinging hand.
    const Bx = V3(Math.cos(B.root.rotation.y), 0, -Math.sin(B.root.rotation.y));
    const Ax = V3(Math.cos(A.root.rotation.y), 0, -Math.sin(A.root.rotation.y));
    const side = Math.sign(Vec.Dot(Bx, Ax)) || 1;
    const headPos = A.rig.face.getAbsolutePosition().clone();
    sound('playClang', 0.9, 1.6);
    sound('playClink', 0.5, 0.8);
    if (fx && fx.burst) fx.burst({ pos: headPos, color1: '#ffffff', color2: team.accent, count: 26, speed: { min: 0.8, max: 2.4 }, life: 0.4, size: 0.07, gravity: [0, -4, 0] });
    if (fx && fx.sparks) fx.sparks(headPos, team.glow);
    const knock = A._fLocal(Bx.scale(0.12));
    const T7 = 2300, TH = 120;
    const stunned = withPose(innocent, {
      head: [0.15, side * 1.0, side * 0.25], chest: [0.06, side * 0.4, 0], spine: [0.08, 0, 0], free: 1,
      handL: [-0.094, 1.0, 0.0], thumbL: [0.1, 0.25, 1], elbowL: [-1, 0.25, -0.35]
    });
    const glare = withPose(innocent, {
      head: [0.2, 0, 0.0], chest: [0.12, 0, 0], spine: [0.1, 0, 0], free: 1,
      handL: [-0.094, 1.0, 0.0], thumbL: [0.1, 0.25, 1], elbowL: [-1, 0.25, -0.35]
    });
    A._fFlashTo(0.8);
    const aKeys = [[0, clonePose(A._cur)], [TH, stunned], [900, stunned], [1300, glare], [T7, glare]];
    const rub = withPose(base, { handL: slapPath(1) });
    const through = withPose(base, { handL: [0.28, 0.92, 0.5], chest: [0.1, 0.35, 0], head: [0.2, 0.0, 0] });
    const sting = withPose(through, { handL: [0.22, 0.72, 0.42], head: [0.4, 0, 0.05] });
    const bKeys = [[0, rub], [200, through], [420, sting], [T7, sting]];
    await Promise.all([
      A._fkeys(tok, aKeys, (t, P) => {
        const stag = Math.max(0, 1 - t / 700);
        A.visual.position.x = knock.x * (1 - Math.pow(1 - Math.min(1, t / 90), 2)) * smoothstep(0, 1, stag);
        A.visual.position.z = ADV_A + knock.z * smoothstep(0, 1, stag) - 0.04 * (1 - stag);
        const fl = Math.max(0, 0.8 * (1 - t / 260));
        if (fl > 0 || A._fFlash) A._fFlashTo(fl);
        if (t > 1300) A.visual.position.z = ADV_A * (1 - smoothstep(1300, 1900, t)) + A.visual.position.z * smoothstep(1300, 1900, t);
      }),
      B._fkeys(tok, bKeys, (t, P) => {
        B.visual.position.z = advB;
        plantShield(P);
        if (t > 450 && t < 1500) {
          const w = smoothstep(450, 550, t) * (1 - smoothstep(1300, 1500, t)), ph = (t - 450) / 1000 * TAU * 7;
          P.handL[1] += 0.06 * Math.sin(ph) * w;
          P.handL[2] += 0.03 * Math.sin(ph + 1) * w;
        }
      })
    ]);
    A._fFlashTo(0);
  };
})();
