(function () {
  const Ease = {
    linear: t => t,
    inOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    outCubic: t => 1 - Math.pow(1 - t, 3),
    inCubic: t => t * t * t,
    outBack: t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outElastic: t => (t === 0 || t === 1) ? t : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1
  };

  const active = new Set();
  const Tween = {
    speed: 1,               // user animSpeed pref
    fastForward: false,     // set by Skip; every running/new tween completes immediately
    init(scene) {
      scene.onBeforeRenderObservable.add(() => {
        const dt = scene.getEngine().getDeltaTime();
        for (const tw of [...active]) tw.step(dt);
      });
    },
    run(durationMs, onUpdate, easing = Ease.inOutCubic) {
      return new Promise((resolve) => {
        const total = Math.max(1, durationMs / Tween.speed);
        let elapsed = 0;
        const tw = {
          step(dt) {
            elapsed = Tween.fastForward ? total : elapsed + dt;
            const t = Math.min(1, elapsed / total);
            onUpdate(easing(t), t);
            if (t >= 1) { active.delete(tw); resolve(); }
          }
        };
        active.add(tw);
        if (Tween.fastForward) tw.step(0);
      });
    },
    wait(ms) { return Tween.run(ms, () => {}, Ease.linear); },
    isActive() { return active.size > 0; },
    skipAll() { Tween.fastForward = true; },
    // Fast-forwards every running tween to its end, and the ones their promise
    // chains start in turn, without waiting for frames (a hidden tab renders
    // none). Leaves fastForward on; the caller ends it with endSkip().
    async drain(maxRounds = 40) {
      Tween.fastForward = true;
      for (let i = 0; i < maxRounds && active.size; i++) {
        for (const tw of [...active]) tw.step(0);
        for (let k = 0; k < 10; k++) await null; // let the .then() chains run
      }
    },
    endSkip() { Tween.fastForward = false; },
    Ease
  };
  window.Chess3D.Tween = Tween;
})();
