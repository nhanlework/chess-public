// Chess3D.Cinematic — capture-camera choreography + camera presets (Plan §11.3).
(function () {
  const Config = window.Chess3D.Config;
  const Tween = window.Chess3D.Tween;

  const presets = {
    white: { alpha: -Math.PI / 2, beta: 0.82, radius: 13, target: [0, 0.3, 0] },
    black: { alpha: Math.PI / 2, beta: 0.82, radius: 13, target: [0, 0.3, 0] },
    top: { alpha: -Math.PI / 2, beta: 0.15, radius: 15, target: [0, 0.3, 0] },
    side: { alpha: 0, beta: 1.1, radius: 14, target: [0, 0.3, 0] }
  };

  let _scene = null;
  let _camera = null;
  let _pipeline = null;
  let _depthRenderer = null;
  let _prefsGetter = null;
  let _skipBound = false;
  let _inCinematic = false;
  // The click that makes a capture move fires its DOM `click` AFTER Babylon's
  // POINTERTAP has already started the cinematic, so a bare "click = skip" rule
  // skipped every player capture instantly. Only a press that STARTS after the
  // cinematic began may skip it.
  let _skipArmed = false;
  let _saved = null;
  let _prevLowerLimit = null;
  let _prevAutoRotate = false;

  function toVec3(v) {
    if (v instanceof BABYLON.Vector3) return v;
    return new BABYLON.Vector3(v[0], v[1], v[2]);
  }

  // Angle delta in (-PI, PI], so interpolation always takes the shortest way round.
  function shortestAngleDiff(from, to) {
    return (((to - from + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
  }

  function tweenCamera(to, ms) {
    const from = { alpha: _camera.alpha, beta: _camera.beta, radius: _camera.radius, target: _camera.target.clone() };
    const toTarget = to.target ? toVec3(to.target) : from.target;
    const alphaDelta = (to.alpha != null) ? shortestAngleDiff(from.alpha, to.alpha) : 0;
    const toAlpha = from.alpha + alphaDelta;
    const toBeta = (to.beta != null) ? to.beta : from.beta;
    const toRadius = (to.radius != null) ? to.radius : from.radius;
    return Tween.run(ms, (t) => {
      // Setting `.target` on an ArcRotateCamera rebuilds alpha/beta/radius from the camera's
      // (still-stale, previous-frame) position vs. the new target — so it must happen BEFORE we
      // set alpha/beta/radius below, or it would silently clobber the values we just computed.
      _camera.target = BABYLON.Vector3.Lerp(from.target, toTarget, t);
      _camera.alpha = from.alpha + (toAlpha - from.alpha) * t;
      _camera.beta = from.beta + (toBeta - from.beta) * t;
      _camera.radius = from.radius + (toRadius - from.radius) * t;
    }, Tween.Ease.inOutCubic);
  }

  function setSkipVisible(visible) {
    const skipBtn = document.getElementById('skipBtn');
    if (!skipBtn) return; // only show/hide it when the page actually has one
    skipBtn.classList.toggle('hidden', !visible);
    skipBtn.style.display = visible ? '' : 'none';
  }

  function bindSkipHandlers() {
    if (_skipBound) return;
    _skipBound = true;
    const skipBtn = document.getElementById('skipBtn');
    if (skipBtn) {
      skipBtn.addEventListener('click', () => { if (_inCinematic) Tween.skipAll(); });
    }
    document.addEventListener('keydown', (e) => {
      if (!_inCinematic) return;
      if (e.key === ' ' || e.code === 'Space' || e.key === 'Escape' || e.code === 'Escape') {
        e.preventDefault();
        Tween.skipAll();
      }
    });
    if (_scene) {
      const canvas = _scene.getEngine().getRenderingCanvas();
      if (canvas) {
        canvas.addEventListener('pointerdown', () => { if (_inCinematic) _skipArmed = true; });
        canvas.addEventListener('click', () => { if (_inCinematic && _skipArmed) Tween.skipAll(); });
      }
    }
  }

  function currentQuality() {
    const prefs = (_prefsGetter ? _prefsGetter() : null) || Config.DEFAULT_PREFS;
    const key = prefs.quality;
    return (key && Config.QUALITY[key]) || Config.QUALITY.high;
  }

  // Safari turns a trackpad pinch into non-standard `gesture*` events (on top
  // of the `wheel` events every other browser uses) and zooms the whole page
  // by default; preventDefault() on our wheel handler doesn't stop that, so
  // it needs its own listener.
  function suppressSafariGestureZoom() {
    ['gesturestart', 'gesturechange', 'gestureend'].forEach((evt) => {
      document.addEventListener(evt, (e) => e.preventDefault());
    });
  }

  function init(scene, camera, pipeline, prefsGetter) {
    _scene = scene;
    _camera = camera;
    _pipeline = pipeline;
    _prefsGetter = prefsGetter || null;
    bindSkipHandlers();
    suppressSafariGestureZoom();
  }

  async function goTo(preset, ms) {
    ms = (ms != null) ? ms : 700;
    const p = (typeof preset === 'string') ? presets[preset] : preset;
    if (!p) return;
    await tweenCamera(p, ms);
  }

  async function focusOnCapture(attackerPos, victimPos) {
    _saved = { alpha: _camera.alpha, beta: _camera.beta, radius: _camera.radius, target: _camera.target.clone() };
    _inCinematic = true;
    _skipArmed = false;
    setUserControl(false);

    const a = toVec3(attackerPos);
    const v = toVec3(victimPos);
    const mid = a.add(v).scale(0.5).add(new BABYLON.Vector3(0, 0.5, 0));
    const dir = v.subtract(a);
    let alphaSide = Math.atan2(dir.z, dir.x) + Math.PI / 2;
    const alt = alphaSide + Math.PI;
    const dSide = Math.abs(shortestAngleDiff(_saved.alpha, alphaSide));
    const dAlt = Math.abs(shortestAngleDiff(_saved.alpha, alt));
    if (dAlt < dSide) alphaSide = alt;

    _prevLowerLimit = _camera.lowerRadiusLimit;
    _camera.lowerRadiusLimit = 3;
    _prevAutoRotate = _camera.useAutoRotationBehavior;
    setAutoRotate(false); // no auto-rotate during cinematic; restore() reinstates the prior state

    await tweenCamera({ alpha: alphaSide, beta: 1.2, radius: 5.5, target: mid }, Config.TIMING.cameraIn);

    const q = currentQuality();
    if (q.dof && _pipeline) {
      setDepthOfField(true);
      _pipeline.depthOfField.focusDistance = _camera.radius * 1000;
      _pipeline.depthOfField.fStop = 2.8;
      _pipeline.depthOfField.focalLength = 50;
    }
    setSkipVisible(true);
  }

  // Close-up on one spot (the losing king at game over): the camera swings
  // round to a three-quarter view of the side `facing` (a yaw) looks toward,
  // aiming `lift` above the board. restore() puts it back.
  async function focusOnPoint(pos, opts) {
    opts = opts || {};
    if (!_inCinematic) {
      _saved = { alpha: _camera.alpha, beta: _camera.beta, radius: _camera.radius, target: _camera.target.clone() };
      _prevLowerLimit = _camera.lowerRadiusLimit;
      _prevAutoRotate = _camera.useAutoRotationBehavior;
    }
    _inCinematic = true;
    _skipArmed = false;
    setUserControl(false);
    setAutoRotate(false);
    const radius = opts.radius || 5;
    _camera.lowerRadiusLimit = Math.min(_camera.lowerRadiusLimit || radius, radius);
    let alpha = _camera.alpha;
    if (opts.facing != null) alpha = Math.atan2(Math.cos(opts.facing), Math.sin(opts.facing)) + (opts.side || 0.55);
    const target = toVec3(pos).add(new BABYLON.Vector3(0, opts.lift || 1, 0));
    await tweenCamera({ alpha, beta: opts.beta || 1.2, radius, target }, opts.ms || Config.TIMING.cameraIn);
    setSkipVisible(true);
  }

  // Depth of field needs the scene's depth renderer, i.e. one more pass over
  // every mesh each frame. Babylon leaves that renderer running when DOF is
  // switched off, so after the first capture close-up every idle frame kept
  // paying for it; switch it with the effect.
  function setDepthOfField(on) {
    if (!_pipeline) return;
    _pipeline.depthOfFieldEnabled = !!on;
    if (on) _depthRenderer = _scene.enableDepthRenderer(_camera);
    if (_depthRenderer) _depthRenderer.enabled = !!on;
  }

  async function restore() {
    setDepthOfField(false);
    const target = _saved || { alpha: _camera.alpha, beta: _camera.beta, radius: _camera.radius, target: _camera.target.clone() };
    await tweenCamera(target, Config.TIMING.cameraOut);
    if (_prevLowerLimit != null) {
      _camera.lowerRadiusLimit = _prevLowerLimit;
      _prevLowerLimit = null;
    }
    setAutoRotate(_prevAutoRotate);
    setUserControl(true);
    setSkipVisible(false);
    _inCinematic = false;
    _saved = null;
  }

  // A quick, small camera punch at the moment of impact (plan §11.2 follow-up):
  // sells the hit as an actual collision instead of a silent, easy-to-miss swing.
  // Runs whether or not the cinematic close-up is active, and isn't awaited by
  // callers — it just rides along on top of whatever the camera is doing.
  async function impactShake() {
    if (!_camera) return;
    const baseAlpha = _camera.alpha;
    const baseBeta = _camera.beta;
    const baseRadius = _camera.radius;
    const kick = 0.035;
    await Tween.run(180, (t) => {
      const decay = 1 - t;
      const wobble = Math.sin(t * Math.PI * 3) * decay;
      _camera.alpha = baseAlpha + wobble * kick;
      _camera.beta = baseBeta + wobble * kick * 0.6;
      _camera.radius = baseRadius - Math.abs(wobble) * kick * 4;
    }, Tween.Ease.linear);
    _camera.alpha = baseAlpha;
    _camera.beta = baseBeta;
    _camera.radius = baseRadius;
  }

  function setAutoRotate(on) {
    _camera.useAutoRotationBehavior = !!on;
    if (on && _camera.autoRotationBehavior) {
      _camera.autoRotationBehavior.idleRotationSpeed = 0.08;
      _camera.autoRotationBehavior.idleRotationWaitTime = 6000;
      _camera.autoRotationBehavior.idleRotationSpinupTime = 2000;
    }
  }

  function setUserControl(on) {
    if (on) _camera.attachControl(); // no noPreventDefault=true — see scene-setup.js
    else _camera.detachControl();
  }

  // On-screen zoom/rotate buttons (plan-adjacent HUD controls): nudge the
  // camera's own inertial offsets rather than tweening, so a click/hold feels
  // exactly like a mouse-wheel or drag input and respects the existing
  // radius/beta limits automatically. `dir` is +1/-1.
  //
  // ArcRotateCamera doesn't apply an inertial offset in one shot: each frame
  // it does `value += offset; offset *= inertia`, so one call's TOTAL effect
  // converges to offset / (1 - inertia), not to `offset` itself. These
  // constants are the desired total nudge per click; the actual per-call
  // offset is derived from them below so the nudge stays the same size no
  // matter what camera.inertia is set to.
  const NUDGE_RADIUS_TOTAL = 1.0;
  const NUDGE_ALPHA_TOTAL = 0.12;
  const NUDGE_BETA_TOTAL = 0.08;
  const NUDGE_PAN_TOTAL = 0.6;

  function inertialStep(totalDelta, inertia) {
    return totalDelta * (1 - ((inertia != null && inertia < 1) ? inertia : 0));
  }

  function nudgeZoom(dir) {
    if (!_camera) return;
    // ArcRotateCamera applies `radius -= inertialRadiusOffset`, so a negative
    // dir (zoom in) needs a POSITIVE offset here.
    _camera.inertialRadiusOffset -= dir * inertialStep(NUDGE_RADIUS_TOTAL, _camera.inertia);
  }

  function nudgeRotate(dAlpha, dBeta) {
    if (!_camera) return;
    _camera.inertialAlphaOffset += dAlpha * inertialStep(NUDGE_ALPHA_TOTAL, _camera.inertia);
    _camera.inertialBetaOffset += dBeta * inertialStep(NUDGE_BETA_TOTAL, _camera.inertia);
  }

  // Pan (translate) the look-at target sideways (dx: -1 left / +1 right) and
  // forward/back (dy: +1 forward / -1 back), staying flat on the board's
  // ground plane regardless of how tilted or rotated the camera currently
  // is. Deliberately NOT Babylon's built-in inertialPanningX/Y: that pans
  // along the camera's local up/right axes, which — for a camera tilted
  // down at the board — drags the target upward off the board plane on
  // every "forward" press instead of sliding it across the board.
  function nudgePan(dx, dy) {
    if (!_camera) return;
    const alpha = _camera.alpha;
    // Ground-plane direction from the camera towards its target (forward).
    const fx = -Math.cos(alpha);
    const fz = -Math.sin(alpha);
    // Right = forward rotated +90° around the vertical (Y) axis.
    const rx = fz;
    const rz = -fx;
    _camera.target.x += (fx * dy + rx * dx) * NUDGE_PAN_TOTAL;
    _camera.target.z += (fz * dy + rz * dx) * NUDGE_PAN_TOTAL;
  }

  window.Chess3D.Cinematic = {
    init, presets, goTo, focusOnCapture, focusOnPoint, restore, setAutoRotate, setUserControl, impactShake, setDepthOfField,
    nudgeZoom, nudgeRotate, nudgePan
  };
})();
