(function () {
  const Config = window.Chess3D.Config;

  // Pick a default quality preset when the caller didn't ask for one:
  // touch devices get 'medium', everything else gets 'high'.
  function resolveQuality(quality) {
    if (quality && Config.QUALITY[quality]) return quality;
    return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 'medium' : 'high';
  }

  function applyHardwareScaling(engine, scaling, maxDpr) {
    if (scaling === 'dpr') {
      engine.setHardwareScalingLevel(1 / Math.min(window.devicePixelRatio || 1, maxDpr || 2));
    } else {
      engine.setHardwareScalingLevel(scaling);
    }
  }

  // Mouse-wheel zoom heads towards whatever is under the cursor instead of
  // the screen centre. Babylon's stock zoomToMouseLocation slides the target
  // across a plane facing the camera, which lifts it off the board when the
  // camera is tilted; swapping in a horizontal plane through the target keeps
  // it gliding flat over the board, same as the on-screen pan buttons.
  function enableZoomToCursor(camera) {
    const wheel = camera.inputs.attached.mousewheel;
    if (!wheel || !('zoomToMouseLocation' in wheel)) return;
    wheel.zoomToMouseLocation = true;
    wheel._updateHitPlane = function () {
      this._hitPlane = BABYLON.Plane.FromPositionAndNormal(camera.target, BABYLON.Vector3.Up());
    };
  }

  function buildPipeline(scene, camera, q) {
    const pipeline = new BABYLON.DefaultRenderingPipeline('default', true, scene, [camera]);
    pipeline.fxaaEnabled = !!q.fxaa;
    pipeline.bloomEnabled = !!q.bloom;
    // The pipeline is HDR, so a sunlit light square is already ~1.7 bright:
    // a lower threshold bloomed the whole board into a milky haze. Only real
    // hot spots (specular glints, stacked additive particles) pass this one.
    pipeline.bloomThreshold = 2.2;
    pipeline.bloomWeight = 0.25;
    pipeline.bloomKernel = 64;
    pipeline.bloomScale = 0.5;
    pipeline.imageProcessingEnabled = true;
    pipeline.imageProcessing.toneMappingEnabled = true;
    pipeline.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES;
    pipeline.imageProcessing.exposure = 1.0;
    pipeline.imageProcessing.contrast = 1.15;
    pipeline.imageProcessing.vignetteEnabled = true;
    pipeline.imageProcessing.vignetteWeight = 1.6;
    pipeline.depthOfFieldEnabled = false; // Cinematic (later WP) turns this on temporarily if quality.dof
    pipeline.sharpenEnabled = false;
    pipeline.grainEnabled = false;
    return pipeline;
  }

  function buildSsao(scene, camera, q) {
    if (!q.ssao || !BABYLON.SSAO2RenderingPipeline || !BABYLON.SSAO2RenderingPipeline.IsSupported) return null;
    const ssao = new BABYLON.SSAO2RenderingPipeline('ssao', scene, { ssaoRatio: 0.5, blurRatio: 1 }, [camera]);
    ssao.radius = 1.2;
    ssao.totalStrength = 1.0;
    ssao.samples = q.ssaoSamples || 16;
    ssao.expensiveBlur = !!q.ssaoExpensiveBlur;
    return ssao;
  }

  function buildShadowGenerator(sun, q) {
    if (!q.shadows) return null;
    const shadowGen = new BABYLON.ShadowGenerator(q.shadows, sun);
    if (shadowGen.useCloseExponentialShadowMap !== undefined) {
      shadowGen.usePercentageCloserFiltering = true;
    } else {
      shadowGen.useBlurExponentialShadowMap = true;
    }
    shadowGen.bias = 0.0005;
    shadowGen.normalBias = 0.02;
    return shadowGen;
  }

  function hasEmissive(mat) {
    if (!mat) return false;
    if (mat.emissiveTexture) return true;
    const c = mat.emissiveColor;
    return !!c && (c.r + c.g + c.b) > 0.001;
  }

  // By default the glow layer re-renders every visible mesh (black, just to
  // occlude) into its own texture each frame: ~800 extra draw calls for the
  // ~1300 character parts, of which <100 actually glow. Only draw the ones
  // whose material is emissive right now (checked per frame, so a character
  // flashing white or a gem lighting up joins in on its own).
  function glowEmissiveOnly(glow) {
    const layer = glow._thinEffectLayer || glow;
    const base = layer._canRenderMesh;
    if (typeof base !== 'function') return;
    layer._canRenderMesh = function (mesh, material) {
      return hasEmissive(material) && base.call(this, mesh, material);
    };
  }

  // Frame pacing. The cap is user-selectable (30 / 60 / 90 / 120). With the
  // "power saving when idle" pref on, it drops to 30 fps while nothing moves
  // and nobody interacts; otherwise the selected cap always applies.
  const FPS_IDLE = 30, INTERACT_HOLD_MS = 1500;
  // Babylon's maxFPS skips a frame whenever less than 1000/maxFPS ms has passed
  // since the last one. With maxFPS equal to the display rate, ordinary rAF timing
  // jitter makes it skip frames and the result lands well under target, so give the
  // cap some headroom.
  const FPS_HEADROOM = 1.1;
  // The active-mesh list is frozen (see updateFreeze) only after this long
  // without pointer/keyboard input, so hover and selection markers get in.
  const FREEZE_QUIET_MS = 300;
  function createFramePacer(engine, scene, camera, shadowGen, initialFps, initialPowerSave) {
    let fpsActive = initialFps || 60;
    let powerSave = !!initialPowerSave;
    const shadowMap = shadowGen ? shadowGen.getShadowMap() : null;
    let activeUntil = 0;
    let isBusy = () => false;
    let last = null;
    function cameraMoved() {
      const t = camera.target;
      const cur = [camera.alpha, camera.beta, camera.radius, t.x, t.y, t.z];
      const moved = !last || cur.some((v, i) => Math.abs(v - last[i]) > 1e-5);
      last = cur;
      return moved;
    }
    let isActive = true;
    function setActive(active) {
      isActive = active;
      const fps = (active || !powerSave) ? fpsActive : Math.min(FPS_IDLE, fpsActive);
      engine.maxFPS = Math.round(fps * FPS_HEADROOM);
    }
    // The sun's shadow map doesn't depend on the camera: while nothing
    // animates it is drawn once and reused (RENDER_ONCE), and redrawn when the
    // scene changes (invalidate(), a piece's proxy swap). Every other frame
    // while something animates (a full redraw costs a few ms of CPU; a moving
    // shadow updating at half the frame rate isn't noticeable).
    let shadowBusy = null;
    function updateShadow(busy, changed) {
      if (!shadowMap) return;
      if (busy !== shadowBusy) {
        shadowBusy = busy;
        shadowMap.refreshRate = busy ? 2 : BABYLON.RenderTargetTexture.REFRESHRATE_RENDER_ONCE;
        changed = true;
      }
      if (changed && !busy) shadowMap.resetRefreshCounter();
    }
    function poke() {
      activeUntil = performance.now() + INTERACT_HOLD_MS;
      setActive(true);
    }
    const canvas = engine.getRenderingCanvas();
    ['pointerdown', 'pointermove', 'wheel'].forEach((type) => canvas.addEventListener(type, poke, { passive: true }));
    window.addEventListener('keydown', poke);
    setActive(true);

    // Freeze the active-mesh list whenever nothing animates and no input is
    // coming in (and throughout a camera drag): Babylon then skips frustum
    // culling and per-mesh material readiness checks (~25-30% of the frame).
    // Anything that can change what is drawn unfreezes it: meshes added or
    // removed, a piece's proxy swap (CharacterBase.proxyEpoch), board markers
    // (game3d.js calls invalidate()), pointer/keyboard input, animations.
    let dragging = false, lastInput = 0, freezing = false, lastEpoch = -1, pendingChange = true;
    canvas.addEventListener('pointerdown', () => { dragging = true; markInput(); });
    canvas.addEventListener('pointermove', () => { if (!dragging) markInput(); }, { passive: true });
    window.addEventListener('pointerup', () => { dragging = false; markInput(); });
    window.addEventListener('keydown', markInput);
    function markInput() { lastInput = performance.now(); unfreeze(); }
    function unfreeze() {
      freezing = false;
      if (scene._activeMeshesFrozen) scene.unfreezeActiveMeshes();
    }
    function invalidate() { pendingChange = true; unfreeze(); }
    scene.onNewMeshAddedObservable.add(invalidate);
    scene.onMeshRemovedObservable.add(invalidate);
    function proxyEpoch() {
      const CB = window.Chess3D.CharacterBase;
      return CB ? CB.proxyEpoch : 0;
    }
    function updateFreeze(busy, changed) {
      const want = !busy && !changed && (dragging || performance.now() - lastInput > FREEZE_QUIET_MS);
      if (want && !freezing && !scene._activeMeshesFrozen) {
        freezing = true;
        scene.freezeActiveMeshes(false, () => { if (!freezing) scene.unfreezeActiveMeshes(); });
      } else if (!want && (freezing || scene._activeMeshesFrozen)) {
        unfreeze();
      }
    }

    // FPS overlay (toggle with the F key): frames actually rendered per second,
    // the current cap, CPU time spent in scene.render() (avg / worst) and the
    // worst gap between two frames, which is what a stutter feels like.
    const hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:50;padding:4px 8px;border-radius:4px;' +
      'background:rgba(0,0,0,.6);color:#9f9;font:12px/1.4 monospace;white-space:pre;pointer-events:none;';
    document.body.appendChild(hud);
    // Shift+F: detailed breakdown (draw calls, ms per phase); its
    // instrumentation only runs while that view is on.
    const detail = createRenderProfiler(scene);
    window.addEventListener('keydown', (e) => {
      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey &&
          !/^(INPUT|SELECT|TEXTAREA)$/.test((e.target && e.target.tagName) || '')) {
        if (e.shiftKey) {
          detail.setEnabled(!detail.enabled);
          if (detail.enabled) hud.style.display = '';
          return;
        }
        // Go through the settings checkbox so it stays in sync and the pref is saved.
        const chk = document.getElementById('prefShowFps');
        if (chk) chk.click();
        else hud.style.display = hud.style.display === 'none' ? '' : 'none';
      }
    });
    let frames = 0, cpuSum = 0, cpuMax = 0, gapMax = 0, prevT = 0, hudT = performance.now();
    function updateHud(now) {
      const dt = now - hudT;
      if (dt < 500) return;
      const fps = frames * 1000 / dt;
      hud.style.color = fps >= fpsActive * 0.9 ? '#9f9' : fps >= fpsActive * 0.6 ? '#ff9' : '#f99';
      hud.textContent =
        fps.toFixed(0) + ' fps  (cap ' + Math.round(engine.maxFPS / FPS_HEADROOM) + ', ' + (isActive ? 'active' : 'idle') +
        (scene._activeMeshesFrozen ? ', frozen' : '') + ')\n' +
        'cpu ' + (frames ? (cpuSum / frames).toFixed(1) : '0') + ' ms avg / ' + cpuMax.toFixed(1) + ' max\n' +
        'worst gap ' + gapMax.toFixed(0) + ' ms  |  ' + engine.getRenderWidth() + 'x' + engine.getRenderHeight() +
        '  |  F: hide' + (detail.enabled ? '\n' + detail.report(frames) : '  Shift+F: details');
      frames = 0; cpuSum = 0; cpuMax = 0; gapMax = 0; hudT = now;
    }

    return {
      setBusyProbe(fn) { isBusy = fn || (() => false); },
      setTargetFps(fps) { fpsActive = fps || 60; setActive(isActive); },
      setPowerSave(on) { powerSave = !!on; setActive(isActive); },
      setShowFps(on) { hud.style.display = on ? '' : 'none'; },
      invalidate,
      render() {
        // cameraMoved() first: it must sample the camera every frame.
        const moving = cameraMoved();
        const busy = isBusy();
        const epoch = proxyEpoch();
        const changed = pendingChange || epoch !== lastEpoch;
        pendingChange = false;
        lastEpoch = epoch;
        if (changed) unfreeze();
        setActive(moving || performance.now() < activeUntil || busy);
        updateShadow(busy, changed);
        updateFreeze(busy, changed);
        const t0 = performance.now();
        scene.render();
        const t1 = performance.now();
        frames++;
        cpuSum += t1 - t0;
        cpuMax = Math.max(cpuMax, t1 - t0);
        if (prevT) gapMax = Math.max(gapMax, t0 - prevT);
        prevT = t0;
        updateHud(t1);
      }
    };
  }

  // Per-phase CPU breakdown for the detailed HUD: draw calls, active meshes,
  // live particles, and ms in active-mesh evaluation, before-render observers
  // (idle animation, effects), each render target by name (shadow map, glow,
  // highlight, mirror, DOF depth) and the whole render.
  function createRenderProfiler(scene) {
    let inst = null;
    const rt = new Map();
    let obsMs = 0, evalMs = 0;
    const RTT = BABYLON.RenderTargetTexture.prototype;
    const baseRttRender = RTT.render;
    const baseNotify = scene.onBeforeRenderObservable.notifyObservers;
    const baseEval = scene._evaluateActiveMeshes;
    function timed(fn, add) {
      return function () {
        const a = performance.now();
        try { return fn.apply(this, arguments); } finally { add.call(this, performance.now() - a); }
      };
    }
    const wrappedRtt = timed(baseRttRender, function (ms) {
      const key = /shadow/i.test(this.name) ? 'shadow' : this.name;
      rt.set(key, (rt.get(key) || 0) + ms);
    });
    const wrappedNotify = timed(baseNotify, (ms) => { obsMs += ms; });
    const wrappedEval = timed(baseEval, (ms) => { evalMs += ms; });
    const api = {
      enabled: false,
      setEnabled(on) {
        if (on === api.enabled) return;
        api.enabled = on;
        RTT.render = on ? wrappedRtt : baseRttRender;
        scene.onBeforeRenderObservable.notifyObservers = on ? wrappedNotify : baseNotify;
        scene._evaluateActiveMeshes = on ? wrappedEval : baseEval;
        if (on) {
          inst = new BABYLON.SceneInstrumentation(scene);
          inst.captureDrawCalls = true;
        } else if (inst) {
          inst.dispose();
          inst = null;
        }
        rt.clear(); obsMs = 0; evalMs = 0;
      },
      report(frames) {
        if (!api.enabled || !frames) return '';
        const f = (v) => (v / frames).toFixed(1);
        let rtSum = 0;
        const rts = [...rt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
          .map(([k, v]) => { rtSum += v; return k + ' ' + f(v); });
        const particles = scene.particleSystems.reduce((n, ps) => n + (ps.getActiveCount ? ps.getActiveCount() : 0), 0);
        const out = 'draws ' + inst.drawCallsCounter.current + '  active ' + scene.getActiveMeshes().length +
          '  particles ' + particles + '\n' +
          'eval ' + f(evalMs) + '  before ' + f(obsMs) + '  rtt ' + f(rtSum) + ' ms\n' +
          (rts.length ? 'rtt: ' + rts.join('  ') : '');
        rt.clear(); obsMs = 0; evalMs = 0;
        return out;
      }
    };
    return api;
  }

  function create(canvas, quality, targetFps, powerSaveIdle) {
    if (!BABYLON.Engine.isSupported()) {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;' +
        'flex-direction:column;gap:12px;background:#0b0d17;color:#f2f2f2;font-family:sans-serif;z-index:9999;';
      overlay.innerHTML = '<p>WebGL is not supported in this browser.</p><a href="2d.html" style="color:#5b8def;">' +
        'Go back to the 2D version</a>';
      document.body.appendChild(overlay);
      throw new Error('WebGL not supported');
    }

    // Keep compiled shaders cached even after the last material/particle system
    // using them is disposed: effects come and go, and recompiling a shader the
    // next time one plays is exactly the hitch Effects.prewarm() is there to avoid.
    BABYLON.Effect.PersistentMode = true;

    const engine = new BABYLON.Engine(canvas, true, {
      stencil: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    }, true);

    const scene = new BABYLON.Scene(engine);
    scene.clearColor = BABYLON.Color4.FromHexString('#0b0d17ff');
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogDensity = 0.018;
    scene.fogColor = BABYLON.Color3.FromHexString('#0b0d17');
    scene.environmentTexture = BABYLON.CubeTexture.CreateFromPrefilteredData('assets/env/environmentSpecular.env', scene);
    scene.environmentIntensity = 0.6;

    const camCfg = Config.CAMERA;
    const camera = new BABYLON.ArcRotateCamera('cam', camCfg.alpha, camCfg.beta, camCfg.radius,
      new BABYLON.Vector3(camCfg.target[0], camCfg.target[1], camCfg.target[2]), scene);
    camera.lowerRadiusLimit = camCfg.lowerRadius;
    camera.upperRadiusLimit = camCfg.upperRadius;
    camera.lowerBetaLimit = camCfg.lowerBeta;
    camera.upperBetaLimit = camCfg.upperBeta;
    camera.wheelDeltaPercentage = 0.01;
    camera.pinchDeltaPercentage = 0.01;
    camera.panningSensibility = 0; // no panning: keep the board centered
    camera.inertia = 0.85;
    camera.minZ = 0.1;
    // No `true` here: that arg is Babylon's legacy "noPreventDefault" flag, and
    // passing it stopped the camera's wheel handler from calling
    // preventDefault() — so Ctrl+scroll / trackpad pinch fell through to the
    // browser's own page-zoom instead of just zooming the 3D camera.
    camera.attachControl();
    // Babylon's own keyboard input orbits on the arrow keys while the canvas
    // has focus; ui3d.js maps them to panning instead, so drop it.
    camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
    enableZoomToCursor(camera);

    const hemi = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.35;
    hemi.groundColor = BABYLON.Color3.FromHexString('#1a1420');

    const sun = new BABYLON.DirectionalLight('sun', new BABYLON.Vector3(-0.5, -1, 0.4), scene);
    sun.position = new BABYLON.Vector3(6, 12, -6);
    sun.intensity = 2.2;
    sun.diffuse = BABYLON.Color3.FromHexString('#fff1dc');

    const q = Config.QUALITY[resolveQuality(quality)];

    const shadowGen = buildShadowGenerator(sun, q);

    const glow = new BABYLON.GlowLayer('glow', scene, { mainTextureRatio: q.glowRatio });
    glow.intensity = 0.7;
    glowEmissiveOnly(glow);

    const highlight = new BABYLON.HighlightLayer('hl', scene);
    highlight.innerGlow = false;
    highlight.outerGlow = true;
    highlight.blurHorizontalSize = 0.8;
    highlight.blurVerticalSize = 0.8;

    const pipeline = buildPipeline(scene, camera, q);
    const ssao = buildSsao(scene, camera, q);

    applyHardwareScaling(engine, q.scaling, q.maxDpr);

    // Hover picking is done by game3d.js on its own throttled schedule, so skip
    // Babylon's per-pointer-move pick over ~700 meshes (taps still pick).
    scene.skipPointerMovePicking = true;

    window.addEventListener('resize', () => engine.resize());

    const pacer = createFramePacer(engine, scene, camera, shadowGen, targetFps, powerSaveIdle);

    let currentQualityKey = resolveQuality(quality);
    const ctx = {
      engine, scene, camera, shadowGen, pipeline, glow, highlight,
      // renderFrame is the render-loop body (pass it to engine.runRenderLoop
      // when restarting the loop); setBusyProbe(fn) keeps the frame rate at
      // 60 while fn() is true.
      renderFrame: pacer.render,
      setBusyProbe: pacer.setBusyProbe,
      setTargetFps: pacer.setTargetFps,
      setShowFps: pacer.setShowFps,
      setPowerSave: pacer.setPowerSave,
      // Call after changing anything drawn while nothing animates (markers,
      // labels, ...): unfreezes the active-mesh list and redraws the shadows.
      invalidate: pacer.invalidate,
      onShadowGenRecreated: null, // later WPs may set this to re-add shadow casters
      applyQuality(qKey) {
        const nq = Config.QUALITY[qKey] || Config.QUALITY[resolveQuality(qKey)];
        currentQualityKey = qKey;
        ctx.pipeline.bloomEnabled = !!nq.bloom;
        ctx.pipeline.fxaaEnabled = !!nq.fxaa;
        applyHardwareScaling(engine, nq.scaling, nq.maxDpr);
        // Glow ratio, SSAO and shadow map size are baked in at creation time in Babylon;
        // simplest correct behavior per plan §8.6.12 is to ask for a reload. Recorded as a deviation.
        console.log('[Chess3D] Quality changed to ' + qKey + '. Reload to fully apply.');
      }
    };

    engine.runRenderLoop(pacer.render);

    return ctx;
  }

  window.Chess3D.SceneSetup = { create };
})();
