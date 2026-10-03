// King idle fidgets: now and then a king who has sat still on his throne for a
// while does something to pass the time (PieceManager picks who and when, see
// tickFidgets in pieces3d.js; one is chosen at random):
//   sneakPhone  gets up, crouches and lays his sword on the floor, sits down,
//               glances about shiftily, pulls a phone out of his belt and sits
//               swiping at it; hears something, pockets it and fetches the
//               sword again
//   stretch     gets up, twists his torso from side to side, swings his hips,
//               kicks a leg out to each side, then sits back down
//   yawn        yawns, a gauntlet held to his mouth that he moves in and out,
//               then lets go a long sigh and shakes his head
//
// A fidget is one timeline of pose keyframes on the king's rig (the same pose
// system as walking and attacking). While it runs the king is `_kfid`: he
// draws live instead of in the instance pool and the idle sway is paused.
// Anything a game animation does to him (move, attack, hit, ...) or selecting
// him cuts it short; he first sits back down (see the wrappers at the end).
(function () {
  const Tween = window.Chess3D.Tween;
  const Ease = Tween.Ease;
  const KingCharacter = window.Chess3D.KingCharacter;
  const MB = BABYLON.MeshBuilder;
  const { TAU, V3, lerp, clamp, smoothstep, curve } = window.Chess3D.SurfaceKit;
  const { standPose, sitPose, withPose, clonePose, mixPose, flat, unflat, PLANTED, G, LEN, FRONT } = KingCharacter.kit;
  const Vec = BABYLON.Vector3;
  const proto = KingCharacter.prototype;

  // minDelay/maxDelay: how long a king sits idle before his fidget is due (ms,
  // at animSpeed 1).
  const FIDGET = { minDelay: 14000, maxDelay: 38000 };
  KingCharacter.KING_FIDGET = FIDGET;
  const KINDS = ['sneakPhone', 'stretch', 'yawn'];

  const nowSec = () => performance.now() / 1000;
  const sound = (name, ...args) => { const s = window.ChessSound; if (s && s[name]) s[name](...args); };
  // A sword pose from its guard position and blade direction.
  const swordAt = (g, d, roll) => {
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    return [g[0], g[1], g[2], d[0] / l, d[1] / l, d[2] / l, roll || 0];
  };
  const lerpArr = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));
  // Is t in [a, b)?
  const within = (t, a, b) => t >= a && t < b;
  // Out and back in one go, holding the top for a moment.
  const hump = (t, a, b) => smoothstep(a, a + (b - a) * 0.35, t) * (1 - smoothstep(b - (b - a) * 0.4, b, t));

  // ------------------------------------------------------------ shared poses
  // Standing before the throne, the sword planted tip-down in front of him and
  // his right hand on the pommel like a cane.
  const CANE = swordAt([0.158, 0.579, 0.1255], [0.04, -0.92, 0.39], 0);       // the tip stays on the base disc
  const caneStand = () => withPose(standPose(FRONT), { sword: CANE, gripR: 1, gripL: 0, handL: [-0.21, 0.6, 0.17], thumbL: [0.25, 0, 1],
    elbowL: [-1, -0.3, -0.5], elbowR: [1, -0.5, -0.4], billow: 0.1 });
  // The sword laid on the floor beside the throne, hilt towards him, and the pose of a
  // seated king with nothing in his hands (resting them on the arms of the throne).
  const LAY = swordAt([0.18, 0.093, 0.28], [0.5, -0.05, -0.86], 0);
  const HOVER = swordAt([0.17, 0.27, 0.26], [0.5, -0.12, -0.86], 0);
  const EMPTY = { gripR: 0, gripL: 0, handR: [0.2, 0.51, -0.06], handL: [-0.2, 0.51, -0.06], thumbR: [0, 0, 1], thumbL: [0, 0, 1],
    elbowR: [0.9, -0.65, -0.3], elbowL: [-0.9, -0.65, -0.3] };

  // Keys [[ms, pose], ...] rising from the seat to `end` (the keys of _standUp);
  // `o.lean` / `o.rise` override the two poses in between.
  function riseKeys(from, end, o) {
    o = o || {};
    const S = sitPose();
    const lean = withPose(S, Object.assign({ hips: [0, 0.388, -0.05], spine: [0.22, 0, 0], chest: [0.26, 0, 0], head: [-0.24, 0, 0], sit: 0.75,
      sword: swordAt([PLANTED[0] + 0.05, PLANTED[1] + 0.04, PLANTED[2] + 0.06], [PLANTED[3], PLANTED[4], PLANTED[5]], 0) }, o.lean));
    const rise = withPose(end, Object.assign({ hips: [0, 0.54, 0.08], spine: [0.12, 0, 0], chest: [0.1, 0, 0], head: [-0.1, 0, 0], sit: 0.2,
      footR: S.footR, footL: S.footL, sword: swordAt([0.12, 0.62, 0.2], [0, -0.92, 0.38], 0), gripL: 0.3 }, o.rise));
    return [[0, from], [420, lean], [760, rise], [1150, end]];
  }

  // Keys sitting down from `from` onto `end` (the keys of _sitDown).
  function sitKeys(from, end, o, ms) {
    o = o || {}; ms = ms || 1100;
    const S = sitPose(), E = standPose(FRONT), k = ms / 1100;
    const lower = withPose(E, Object.assign({ footR: S.footR, footL: S.footL, sword: [0.03, 0.66, 0.34, 0.05, -0.55, 0.83, 0], gripR: 1, gripL: 0.6 }, o.lower));
    const lean = withPose(end, Object.assign({ hips: [0, 0.44, -0.02], spine: [0.24, 0, 0], chest: [0.24, 0, 0], head: [-0.24, 0, 0], sit: 0.6,
      sword: [PLANTED[0], PLANTED[1] + 0.04, PLANTED[2] + 0.03, PLANTED[3], PLANTED[4], PLANTED[5], 0] }, o.lean));
    return [[0, from], [330 * k, lower], [735 * k, lean], [ms, end]];
  }

  // ------------------------------------------------------------ lifecycle
  // Is he free to start something?
  proto.canKingFidget = function () {
    return this.alive && !this._busy && !this._kfid && !this._selectedOn && !!this._seated && !this._dz &&
      !this._throneGone && !this._soulReleased && !!this._cur && this.root.scaling.x > 0.99;
  };

  // True once he has been idle for his own random wait (re-rolled every time
  // he goes idle again).
  proto.kingFidgetDue = function (now) {
    if (this._kfidFor !== this._idleSince) {
      this._kfidFor = this._idleSince;
      this._kfidAt = this._idleSince + FIDGET.minDelay + Math.random() * (FIDGET.maxDelay - FIDGET.minDelay);
    }
    return now >= this._kfidAt;
  };

  // Picks one at random (never the same twice running) and plays it.
  proto.startKingFidget = function () {
    const pool = KINDS.filter((k) => k !== this._kfLast);
    const kind = pool[Math.floor(Math.random() * pool.length)];
    this._kfLast = kind;
    return this.playKingFidget(kind);
  };

  proto.playKingFidget = async function (kind) {
    const tok = { abort: false, scrub: null };
    this._kfid = tok;
    this._showLive();
    try {
      await SCRIPTS[kind].call(this, tok);
    } catch (e) {
      console.warn('[Chess3D] king fidget failed:', e);
      this._kfAbort();
      if (this.alive) this._kfSnap();
      return;
    }
    if (tok.abort) return;
    await this._kfReturn(tok, 600);
    this._kfEnd(tok);
  };

  // Debug aid for the sandbox: shows the pose `kind` has at `ms` into it, then holds.
  proto.kfScrub = async function (kind, ms) {
    if (this._kfid) this._kfAbort();
    this._kfid = { abort: false, scrub: ms };
    this._showLive();
    await SCRIPTS[kind].call(this, this._kfid);
  };

  // Back to plain idling: the instance pool takes him again after a moment.
  proto._kfEnd = function (tok) {
    if (this._kfid !== tok) return;
    this._kfClean();
    this._kfid = null;
    this._idleSince = performance.now();
    this.visual.position.x = 0; this.visual.position.z = 0;
  };

  // Drops the fidget on the spot: props away, the token dead. No posing.
  proto._kfAbort = function () {
    const tok = this._kfid;
    if (!tok) return;
    tok.abort = true;
    this._kfid = null;
    this._kfClean();
  };

  // Cut short. `settle`: sit him back down gently (a game animation taking
  // over waits for the returned promise); otherwise he snaps to his seat.
  proto._endKingFidget = function (settle) {
    const standing = this._kfStanding, swordDown = this._kfSwordDown;
    this._kfAbort();
    if (!this.alive) return Promise.resolve();
    if (!settle) { this._kfSnap(); return Promise.resolve(); }
    this._kfStanding = standing; this._kfSwordDown = swordDown;      // _kfReturn needs to know
    const tok = this._kfid = { abort: false, scrub: null };
    return this._kfReturn(tok, 520).then(() => this._kfEnd(tok));
  };

  proto._kfSnap = function () {
    this.visual.position.x = 0; this.visual.position.z = 0;
    this._applyPose(this._kfIdlePose());
  };

  proto._kfClean = function () {
    this._kfPhone(false);
    this._kfStanding = false;
    this._kfSwordDown = false;
  };

  // updateIdle's seated pose, with its sway.
  proto._kfIdlePose = function () {
    const t = nowSec(), ph = this.idlePhase, P = sitPose();
    P.chest[0] += 0.012 * Math.sin(t * 1.5 + ph);
    P.spine[0] += 0.005 * Math.sin(t * 1.5 + ph + 0.4);
    P.head[1] += 0.2 * Math.sin(t * 0.33 + ph) + 0.05 * Math.sin(t * 0.9 + ph * 2);
    P.head[0] += 0.03 * Math.sin(t * 0.47 + ph);
    return P;
  };

  // Blend back to the seat. Standing, he sits down the way he does after a move; a
  // sword left lying on the floor is called back to his hands.
  proto._kfReturn = function (tok, ms) {
    const from = clonePose(this._cur);
    const recall = this._kfSwordDown;
    this._kfSwordDown = false;
    if (recall) {
      const fx = this.ctx && this.ctx.effects, team = window.Chess3D.Config.TEAM[this.color];
      sound('playMagic', 0.12);
      const tip = this.parts.swordTip && this.parts.swordTip.getAbsolutePosition();
      if (fx && fx.sparks && tip) fx.sparks(tip, team.accent);
    }
    this._kfPhone(false);
    if (this._kfStanding) {
      this._kfStanding = false;
      return this._kfkeys(tok, sitKeys(from, this._kfIdlePose(), {}, Math.max(ms, 900)));
    }
    const vx = this.visual.position.x, vz = this.visual.position.z;
    return this._kfseq(tok, ms, (t, raw) => {
      const e = Ease.inOutCubic(raw);
      this.visual.position.x = vx * (1 - e); this.visual.position.z = vz * (1 - e);
      this._applyPose(mixPose(from, this._kfIdlePose(), e));
    });
  };

  // ------------------------------------------------------------ script helpers
  // A tween that stops doing anything once the token is aborted. fn(ms, 0..1).
  proto._kfseq = function (tok, ms, fn) {
    return Tween.run(ms, (_, raw) => {
      if (tok.abort || !this.alive) return;
      this.visual.position.y = this.selectLift;
      fn(raw * ms, raw);
    }, Ease.linear);
  };

  // Keyframes [[ms, pose], ...] (the first is the pose to start from). The
  // optional `frame(ms, P, raw)` may adjust each frame's pose before it is applied.
  proto._kfkeys = function (tok, keys, frame) {
    const like = keys[0][1], total = keys[keys.length - 1][0];
    const fk = keys.map(([t, P]) => [t, ...flat(P)]);
    if (tok.scrub != null) {
      const t = clamp(tok.scrub, 0, total), P = unflat(curve(fk, t), like);
      if (frame) frame(t, P, t / total);
      this.visual.position.y = this.selectLift;
      this._applyPose(P);
      return Promise.resolve();
    }
    return this._kfseq(tok, total, (t, raw) => {
      const P = unflat(curve(fk, t), like);
      if (frame) frame(t, P, raw);
      this._applyPose(P);
    });
  };

  // A list of [ms, fn] events fired once each, in order, as a script runs.
  const events = (list) => {
    let next = 0;
    return (t) => { while (next < list.length && t >= list[next][0]) list[next++][1](); };
  };

  // The point `p` (face space: +z out of the face) in the space poses are given
  // in. Poses the head, so P must already be complete.
  proto._kfFace = function (P, p) {
    this._applyPose(P);
    const face = this.rig.face;
    face.computeWorldMatrix(true);
    const w = Vec.TransformCoordinates(V3(p[0], p[1], p[2]), face.getWorldMatrix());
    this.visual.computeWorldMatrix(true);
    const r = Vec.TransformCoordinates(w, this.visual.getWorldMatrix().clone().invert());
    return [r.x, r.y, r.z];
  };

  // A faint wisp of breath at his mouth, for a sigh.
  proto._kfBreath = function () {
    const fx = this.ctx && this.ctx.effects;
    if (!fx || !fx.burst) return;
    const face = this.rig.face;
    face.computeWorldMatrix(true);
    fx.burst({ pos: Vec.TransformCoordinates(V3(0, -0.05, 0.075), face.getWorldMatrix()), color1: '#e6edf7', color2: '#ffffff', count: 7,
      speed: { min: 0.05, max: 0.3 }, life: 0.9, size: 0.07, gravity: [0, 0.08, 0], blend: 'STANDARD' });
  };

  // ------------------------------------------------------------ the phone
  // Held in the right fist (the fist closes round one long edge); its screen
  // scrolls a made-up feed. Built the first time he needs it. It is placed
  // from the pose each frame (_kfPhonePlace): long edge through the fist along
  // the thumb direction, the glass turned to his face.
  const PHONE = { w: 0.056, h: 0.112, d: 0.008 };
  KingCharacter.PHONE = PHONE;

  proto._kfPhone = function (on, lit) {
    if (on && !this._phone) {
      const scene = this.scene, id = this.id;
      const bodyMat = new BABYLON.StandardMaterial(`phoneBody_${id}`, scene);
      bodyMat.diffuseColor = new BABYLON.Color3(0.05, 0.05, 0.06); bodyMat.specularColor = new BABYLON.Color3(0.6, 0.6, 0.65); bodyMat.specularPower = 64;
      const tex = new BABYLON.DynamicTexture(`phoneFeed_${id}`, feedCanvas(), scene, true);
      tex.update(); tex.wrapU = BABYLON.Texture.CLAMP_ADDRESSMODE; tex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
      const scrMat = new BABYLON.StandardMaterial(`phoneScreen_${id}`, scene);
      scrMat.diffuseColor = BABYLON.Color3.Black(); scrMat.specularColor = BABYLON.Color3.Black();
      scrMat.emissiveTexture = tex; scrMat.disableLighting = true;
      const node = new BABYLON.TransformNode(`phone_${id}`, scene);
      node.parent = this.visual;
      node.rotationQuaternion = new BABYLON.Quaternion();
      const body = MB.CreateBox(`phoneBody_${id}`, { width: PHONE.w, height: PHONE.h, depth: PHONE.d }, scene);
      body.material = bodyMat; body.parent = node; body.isPickable = false;
      // the plane's visible side is -z: turned round, it faces out of the +z face of the body
      const screen = MB.CreatePlane(`phoneScreen_${id}`, { width: PHONE.w - 0.007, height: PHONE.h - 0.01 }, scene);
      screen.material = scrMat; screen.parent = node; screen.isPickable = false;
      screen.position.z = PHONE.d / 2 + 0.0004; screen.rotation.y = Math.PI;
      this._phone = { node, body, screen, tex, scrMat };
      this._phoneMat = [bodyMat, scrMat, tex];
      node.setEnabled(false);
    }
    const p = this._phone;
    if (!p) return;
    if (p.node.isEnabled() !== !!on) {
      p.node.setEnabled(!!on);
      if (this.scene._activeMeshesFrozen) this.scene.unfreezeActiveMeshes();
    }
    if (on) {
      const k = lit == null ? 1 : lit;
      p.scrMat.emissiveColor.set(k, k, k);
    }
  };

  // How far the feed has scrolled, in screens.
  proto._kfFeed = function (v) { if (this._phone) this._phone.tex.vOffset = v; };

  // Puts the phone in the right fist of pose P and returns its glass in pose
  // space: the centre c, the normal n out of it and the "up" u along it.
  proto._kfPhonePlace = function (P) {
    const face = this._kfFace(P, [0, -0.01, 0.05]);
    const hand = V3(P.handR[0], P.handR[1], P.handR[2]);
    const u = V3(P.thumbR[0], P.thumbR[1], P.thumbR[2]).normalize();
    let n = V3(face[0], face[1], face[2]).subtract(hand);
    n = n.subtract(u.scale(Vec.Dot(n, u)));
    n = n.lengthSquared() > 1e-8 ? n.normalize() : V3(0, 0, -1);
    const r = Vec.Cross(u, n);
    const toMidline = r.x < 0 ? 1 : -1;              // the body of the phone lies towards his middle
    const c = hand.add(r.scale(toMidline * (PHONE.w / 2 - 0.01)));
    const node = this._phone.node;
    node.position.copyFrom(c);
    BABYLON.Quaternion.RotationQuaternionFromAxisToRef(r, u, n, node.rotationQuaternion);
    const g = c.add(n.scale(PHONE.d / 2));
    return { c: [g.x, g.y, g.z], n: [n.x, n.y, n.z], u: [u.x, u.y, u.z] };
  };

  let feedCache = null;
  function feedCanvas() {
    if (feedCache) return feedCache;
    const w = 128, h = 512, c = document.createElement('canvas'); c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#10141c'; x.fillRect(0, 0, w, h);
    const hues = [350, 205, 42, 150, 280, 12, 190, 320];
    const card = 64;
    for (let i = 0; i < h / card; i++) {
      const y = i * card + 4, hue = hues[i % hues.length];
      x.fillStyle = `hsl(${hue},55%,${i % 2 ? 62 : 54}%)`;
      x.fillRect(5, y, w - 10, card - 8);
      x.fillStyle = 'rgba(255,255,255,0.92)';
      x.beginPath(); x.arc(20, y + 18, 9, 0, TAU); x.fill();
      x.fillRect(36, y + 11, 52 - (i % 3) * 8, 5);
      x.fillRect(36, y + 22, 30 + (i % 4) * 7, 4);
      x.fillStyle = 'rgba(255,255,255,0.55)';
      x.fillRect(12, y + 38, w - 34, 4); x.fillRect(12, y + 47, w - 58 - (i % 2) * 14, 4);
    }
    feedCache = c;
    return c;
  }

  // ------------------------------------------------------------ scripts
  const SCRIPTS = {};

  // He yawns, a fist held up to his mouth and moved to and fro, sighs, shakes his head.
  SCRIPTS.yawn = async function (tok) {
    const S = sitPose(), cur = clonePose(this._cur);
    const handUp = { gripL: 0, thumbL: [0.2, 0.9, 0.3], elbowL: [-1, -0.3, -0.3] };
    const droop = withPose(S, { spine: [0.1, 0, 0], chest: [0.05, 0, 0], head: [0.24, 0.08, 0.06] });
    const rise = withPose(S, { spine: [-0.03, 0, 0], chest: [-0.08, 0, 0], neck: [-0.03, 0, 0], head: [-0.1, 0, 0], gripL: 0.5, thumbL: [0.2, 0.9, 0.3], elbowL: [-1, -0.3, -0.3] });
    const inhale = withPose(S, Object.assign({ spine: [-0.04, 0, 0], chest: [-0.14, 0, 0], neck: [-0.06, 0, 0], head: [-0.3, 0, 0.04] }, handUp));
    const wide = withPose(inhale, { spine: [-0.06, 0, 0], chest: [-0.2, 0, 0], neck: [-0.08, 0, 0], head: [-0.38, 0, 0.05] });
    const sigh = withPose(S, { spine: [0.18, 0, 0], chest: [0.16, 0, 0], neck: [0.1, 0, 0], head: [0.34, 0.12, 0.05],
      gripL: 0.3, handL: [-0.14, 0.52, 0.1], thumbL: [0.1, 0.2, 1], elbowL: [-1, -0.5, -0.3] });
    const shake = withPose(sigh, { head: [0.22, -0.12, 0.0], chest: [0.1, 0, 0], spine: [0.1, 0, 0] });
    const T = { droop: 700, rise: 1400, inhale: 2100, wide: 3100, out: 3900, sigh: 4600, shake: 5900, back: 6900 };
    const ev = events([
      [T.rise + 200, () => sound('playYawn', 2.4, 0.9)],
      [T.out + 200, () => { sound('playSigh', 1.5, 1); this._kfBreath(); }]
    ]);
    await this._kfkeys(tok, [[0, cur], [T.droop, droop], [T.rise, rise], [T.inhale, inhale], [T.wide, wide], [T.out, inhale], [T.sigh, sigh], [T.shake, shake], [T.back, S]], (t, P) => {
      // the fist comes up to the mouth, then goes to and fro in front of it while he yawns
      const w = smoothstep(T.droop + 200, T.inhale, t) * (1 - smoothstep(T.out - 100, T.sigh - 200, t));
      if (w > 0) {
        const s = 0.5 - 0.5 * Math.cos(clamp((t - T.inhale) / 1000, 0, 2.6) * TAU * 0.8);
        const d = lerp(0.082, 0.17, smoothstep(0, 1, s)) + 0.08 * (1 - smoothstep(T.droop + 200, T.inhale, t));
        P.handL = lerpArr(P.handL, this._kfFace(P, [0, -0.05, d]), w);
      }
      if (tok.scrub == null) ev(t);
    });
  };

  // He gets up, plants his sword before him and leans a hand on it, stretches an
  // arm over his head and bends to the side, twists from side to side, swings
  // his hips, kicks out a leg to each side, takes a deep breath and sits again.
  SCRIPTS.stretch = async function (tok) {
    const E = standPose(FRONT), cur = clonePose(this._cur);
    const stand = caneStand();
    const armUp = withPose(stand, { chest: [-0.14, 0, 0], head: [-0.22, 0, 0], handL: [-0.1, 1.27, 0.12], thumbL: [0.3, 1, 0.3], elbowL: [-1, 0.1, -0.2], billow: 0.15 });
    const breath = withPose(stand, { chest: [-0.12, 0, 0], head: [-0.3, 0, 0], billow: 0.2 });
    const T = { rise: 1150, armUp: 1750, bendA: 2300, bendB: 2900, armDown: 3400, twistA: 3400, twistB: 5800, swingB: 7000, kickL: 8100, kickR: 9200, breath: 9800, sit: 10400 };
    // pelvis over the standing leg while the other kicks (a little lower, so the leg need not stretch)
    const kick = (P, k, side) => {
      if (k <= 0) return;
      const s = side === 'L' ? -1 : 1, foot = P['foot' + side];
      const to = side === 'L' ? [-0.4, G + LEN.ankle + 0.3, 0.26, 0.5, -0.4] : [0.34, G + LEN.ankle + 0.3, 0.42, 0.5, 0.4];
      for (let i = 0; i < 5; i++) foot[i] = lerp(foot[i], to[i], k);
      P.hips[0] -= s * 0.045 * k; P.hips[1] -= 0.03 * k;
      P.hipsRot[2] += s * 0.1 * k; P.chest[2] -= s * 0.1 * k; P.spine[2] += s * 0.03 * k;
    };
    const ev = events([
      [T.rise - 100, () => sound('playClink', 0.25, 0.7)],
      [T.breath + 200, () => { sound('playSigh', 1.0, 0.8); this._kfBreath(); }]
    ]);
    const keys = riseKeys(cur, stand);
    keys.push([T.armUp, armUp], [T.bendB, armUp], [T.armDown, stand], [T.twistB, stand], [T.breath, breath]);
    sitKeys(withPose(stand, { chest: [0.05, 0, 0], head: [0.1, 0, 0] }), this._kfIdlePose(), {}, 1100)
      .forEach(([t, P], i) => keys.push([T.sit + t, P]));
    await this._kfkeys(tok, keys, (t, P) => {
      this._kfStanding = within(t, 450, T.sit + 800);
      // side bends with the arm overhead
      const bend = smoothstep(T.armUp, T.bendA, t) * (1 - smoothstep(T.bendB - 100, T.armDown, t)) * (0.55 + 0.45 * Math.sin((t - T.bendA) / 1000 * TAU * 0.7));
      P.chest[2] -= 0.4 * bend; P.spine[2] -= 0.12 * bend; P.hipsRot[2] -= 0.05 * bend; P.hips[0] += 0.03 * bend;
      // torso twists, the free arm swinging round with them
      const tw = smoothstep(T.twistA, T.twistA + 300, t) * (1 - smoothstep(T.twistB - 300, T.twistB, t));
      if (tw > 0) {
        const ph = (t - T.twistA) / 1200 * TAU, psi = 0.6 * Math.sin(ph) * tw;
        P.chest[1] += psi; P.hipsRot[1] += 0.22 * Math.sin(ph - 0.6) * tw; P.spine[1] += 0.08 * Math.sin(ph) * tw;
        P.head[1] += 0.25 * Math.sin(ph + 0.4) * tw;
        P.handL = [-0.22 * Math.cos(psi), 0.78, 0.17 + 0.26 * Math.sin(psi) - 0.22 * (1 - Math.cos(psi))];
        P.elbowL = [-1, 0.3, 0];
      }
      // hip swing, a hand on the hip
      const sw = smoothstep(T.twistB, T.twistB + 200, t) * (1 - smoothstep(T.swingB - 200, T.swingB, t));
      if (sw > 0) {
        const ph = (t - T.twistB) / 600 * TAU;
        P.hips[0] += 0.05 * Math.sin(ph) * sw; P.hipsRot[1] += 0.18 * Math.sin(ph + 1.57) * sw; P.hipsRot[2] += 0.07 * Math.sin(ph) * sw;
        P.chest[2] -= 0.05 * Math.sin(ph) * sw; P.chest[1] -= 0.1 * Math.sin(ph + 1.57) * sw;
        P.handL = lerpArr(P.handL, [-0.2, 0.62, 0.12], sw);
        P.elbowL = [-1, 0.2, -0.8];
      }
      kick(P, hump(t, T.swingB, T.kickL), 'L');
      kick(P, hump(t, T.kickL, T.kickR), 'R');
      if (tok.scrub == null) ev(t);
    });
  };

  // He lays his sword on the floor, looks about to see nobody is watching, takes
  // a phone out of his belt and swipes through it; something stirs, he pockets
  // it, looks innocent, and fetches the sword again.
  SCRIPTS.sneakPhone = async function (tok) {
    const S = sitPose(), cur = clonePose(this._cur);
    const stand = caneStand();
    const Sd = withPose(S, Object.assign({ sword: LAY }, EMPTY));
    const standFree = withPose(stand, { sword: LAY, gripR: 0, handR: [0.2, 0.52, 0.16], handL: [-0.2, 0.52, 0.16], thumbR: [0, 0, 1], thumbL: [0, 0, 1],
      elbowR: [1, -0.5, -0.4], elbowL: [-1, -0.5, -0.4] });
    const crouchA = withPose(stand, { hips: [0, 0.38, 0.18], spine: [0.3, 0, 0], chest: [0.05, 0, -0.15], head: [0.3, 0.1, 0], kneeOut: 0.35, sword: HOVER, handL: [-0.19, 0.5, 0.2] });
    const crouch = withPose(stand, { hips: [0, 0.3, 0.2], spine: [0.5, 0, 0], chest: [0.1, 0, -0.3], head: [0.25, 0.2, 0], kneeOut: 0.45, sword: LAY, handL: [-0.19, 0.46, 0.22] });
    const crouchFree = withPose(crouch, { gripR: 0, handR: [0.2, 0.2, 0.34] });
    // --- the timeline: poses to be at, and the moments the frame callback cares about
    const keys = [[0, cur]], M = {};
    let T = 0;
    const push = (dt, P, name) => { T += dt; keys.push([T, P]); if (name) M[name] = T; };
    const pushKeys = (ks) => { const t0 = T; ks.slice(1).forEach(([t, P]) => keys.push([t0 + t, P])); T = t0 + ks[ks.length - 1][0]; };

    // 1. up, crouch, the sword down on the floor, a few steps back, sit down empty-handed
    pushKeys(riseKeys(cur, stand));
    M.up = T;
    push(550, crouchA); push(550, crouch, 'touch'); push(250, crouchFree, 'release'); push(550, standFree, 'upA');
    pushKeys(sitKeys(standFree, Sd, { lower: Object.assign({ sword: LAY }, EMPTY), lean: { sword: LAY } }));
    M.seatedA = T;

    // 2. the shifty looks
    const look = (yaw, pitch, cy, extra) => withPose(Sd, Object.assign({ head: [pitch, yaw, 0], chest: [0.05, cy, 0], spine: [0.07, 0, 0], neck: [0, yaw * 0.2, 0] }, extra));
    push(350, Sd);
    push(400, look(-1.0, 0, -0.3)); push(550, look(-1.0, 0, -0.3));
    push(300, look(1.1, 0, 0.3)); push(550, look(1.1, 0, 0.3));
    push(300, look(-0.5, 0.15, -0.15)); push(250, look(0, 0.3, 0));

    // 3. the phone out of his belt, up in front of his chest
    const pouch = withPose(Sd, { head: [0.35, 0.3, 0], chest: [0.12, 0.1, 0], spine: [0.1, 0, 0], handR: [0.15, 0.45, 0.0], thumbR: [0.2, 0.2, 1], elbowR: [1, -0.5, -0.2] });
    const hold = withPose(Sd, { head: [0.42, 0, 0], neck: [0.1, 0, 0], spine: [0.14, 0, 0], chest: [0.16, 0, 0], hips: [0, 0.378, -0.12],
      handR: [0.07, 0.64, 0.1], thumbR: [0, 1, 0.45], elbowR: [1, -0.5, -0.3], handL: [-0.1, 0.6, 0.15], elbowL: [-1, -0.4, -0.3] });
    push(450, pouch, 'pouch'); push(450, pouch, 'phoneOn'); push(700, hold, 'hold');

    // 4. swiping
    const SWIPES = [600, 1500, 2200, 3300, 4000, 4650, 5600].map((s) => M.hold + 200 + s), SW = 320;
    push(6500, hold, 'swipeEnd');

    // 5. caught: head up, phone away, innocent
    const alert = withPose(hold, { head: [-0.12, -0.9, 0], neck: [0, -0.2, 0], chest: [-0.04, -0.3, 0], spine: [0.02, 0, 0], hips: S.hips });
    push(250, alert, 'alert'); push(450, withPose(alert, { handR: [0.15, 0.45, 0.0], thumbR: [0.2, 0.2, 1] }), 'phoneOff');
    push(500, look(0, 0.05, 0), 'innocent'); push(450, look(0, 0.05, 0));

    // 6. fetch the sword: up, crouch, grab it, back to the cane, sit down with it
    pushKeys(riseKeys(look(0, 0.05, 0), standFree, { lean: Object.assign({ sword: LAY }, EMPTY), rise: { sword: LAY, gripL: 0, gripR: 0 } }));
    M.upB = T;
    push(550, crouchFree); push(300, crouch, 'grab'); push(500, crouchA); push(550, stand, 'upC');
    pushKeys(sitKeys(stand, this._kfIdlePose(), {}));
    M.end = T;
    tok.marks = M;     // for the sandbox's scrubbing

    const ev = events([
      [M.touch, () => { sound('playClang', 0.35, 0.6); sound('playClink', 0.4, 0.7); }],
      [M.phoneOn + 150, () => sound('playPing', 1)],
      [M.grab, () => sound('playClink', 0.4, 0.9)],
      [M.alert, () => sound('playClink', 0.15, 0.5)]
    ].concat(SWIPES.map((s) => [s, () => sound('playPing', 0.8, 'tap')])));
    const easeS = (u) => u * u * (3 - 2 * u);

    await this._kfkeys(tok, keys, (t, P) => {
      this._kfStanding = within(t, 450, M.seatedA - 300) || within(t, M.innocent + 1500, M.end - 300);
      this._kfSwordDown = within(t, M.release, M.grab);

      // the phone: in his hand from the pouch until he pockets it
      const phoneOn = within(t, M.phoneOn, M.phoneOff);
      this._kfPhone(phoneOn, smoothstep(M.pouch + 450, M.hold - 200, t) * (1 - smoothstep(M.alert - 100, M.alert + 150, t)));
      if (phoneOn) {
        let near = 0.3, y = -0.04, feed = 0;
        SWIPES.forEach((s) => {
          const u = (t - s) / SW;
          near = Math.max(near, 1 - clamp(Math.abs(t - (s + SW / 2)) / 520, 0, 1));
          if (u > 0) feed += 0.11 * easeS(clamp(u, 0, 1));
          if (u > 0 && u < 1.6) y = lerp(-0.04, 0.035, easeS(clamp(u, 0, 1)));
        });
        const settle = smoothstep(M.hold - 250, M.hold + 100, t) * (1 - smoothstep(M.alert - 120, M.alert + 80, t));
        this._kfFeed(feed);
        // the free fist swipes at the glass
        const f = this._kfPhonePlace(P);
        if (settle > 0) {
          const reach = 0.035 + 0.06 * (1 - near);
          const tgt = [0, 1, 2].map((i) => f.c[i] + f.n[i] * reach + f.u[i] * y);
          P.handL = lerpArr(P.handL, tgt, settle);
          P.thumbL = lerpArr(P.thumbL, [-f.n[0], -f.n[1], -f.n[2]], settle);
          P.elbowL = lerpArr(P.elbowL, [-1, -0.2, -0.2], settle);
        }
        // a chuckle, and a foot tapping
        const sw = smoothstep(M.hold, M.hold + 300, t) * (1 - smoothstep(M.alert - 200, M.alert, t));
        const chuckle = hump(t, M.hold + 3000, M.hold + 3900);
        P.chest[0] += 0.035 * Math.abs(Math.sin((t - M.hold) / 1000 * TAU * 2.2)) * chuckle;
        P.head[0] -= 0.05 * Math.abs(Math.sin((t - M.hold) / 1000 * TAU * 2.2)) * chuckle;
        P.footR[1] += 0.02 * Math.max(0, Math.sin((t - M.hold) / 1000 * TAU * 1.6)) * sw;
      }
      if (tok.scrub == null) ev(t);
    });
  };

  // ------------------------------------------------------------ registration
  // A game animation (or a selection) that finds him mid-fidget lets him sit
  // back down first.
  ['moveTo', 'playAttack', 'playHit', 'playRecover', 'playDeath', 'playVictory', 'dissolve'].forEach((name) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = async function (...args) {
      if (this._kfid) await this._endKingFidget(true);
      return orig.apply(this, args);
    };
  });
})();
