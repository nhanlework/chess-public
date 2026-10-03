// UI3D: HUD DOM rendering + modals for the 3D game (status, timers, captured
// pieces, promotion modal, pause/game-over/start modals, camera preset
// buttons, 3D settings modal placeholder). game3d.js owns game state/logic
// and calls into this module to reflect it on screen. See plan §10, §4.1.
(function () {
  const Config = window.Chess3D.Config;

  const UNICODE = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
  };

  const statusBar = document.getElementById('statusBar');
  const capturedWhiteEl = document.getElementById('capturedWhite');
  const capturedBlackEl = document.getElementById('capturedBlack');
  const totalTimerEl = document.getElementById('totalTimer');
  const whiteTimerEl = document.getElementById('whiteTimer');
  const blackTimerEl = document.getElementById('blackTimer');
  const retryAiBtn = document.getElementById('retryAiBtn');

  const startModal = document.getElementById('startModal');
  const pauseModal = document.getElementById('pauseModal');
  const gameOverModal = document.getElementById('gameOverModal');
  const gameOverText = document.getElementById('gameOverText');
  const promotionModal = document.getElementById('promotionModal');
  const promotionOptions = document.getElementById('promotionOptions');
  const prefs3dModal = document.getElementById('prefs3dModal');
  const loadingOverlay = document.getElementById('loadingOverlay');

  function setStatus(text) {
    statusBar.textContent = text;
  }

  function getStatus() {
    return statusBar.textContent;
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  // opts = { totalSeconds, whiteSeconds, blackSeconds, turn, gameOver }
  function renderTimers(opts) {
    totalTimerEl.textContent = 'Total: ' + fmtTime(opts.totalSeconds);
    whiteTimerEl.textContent = 'You: ' + fmtTime(opts.whiteSeconds);
    blackTimerEl.textContent = 'AI: ' + fmtTime(opts.blackSeconds);
    whiteTimerEl.classList.toggle('active', opts.turn === 'w' && !opts.gameOver);
    blackTimerEl.classList.toggle('active', opts.turn === 'b' && !opts.gameOver);
  }

  // captured = game.captured ({ w: [...], b: [...] }); captured.w = white
  // pieces captured (i.e. captured BY the AI), captured.b = captured BY the player.
  function renderCaptured(captured) {
    capturedWhiteEl.innerHTML = captured.w.map(t => UNICODE.w[t]).join(' ');
    capturedBlackEl.innerHTML = captured.b.map(t => UNICODE.b[t]).join(' ');
  }

  function showRetryButton() { retryAiBtn.style.display = 'inline-block'; }
  function hideRetryButton() { retryAiBtn.style.display = 'none'; }
  function onRetryClick(fn) { retryAiBtn.addEventListener('click', fn); }

  function showStartModal() { startModal.classList.remove('hidden'); }
  function hideStartModal() { startModal.classList.add('hidden'); }
  function showPauseModal() { pauseModal.classList.remove('hidden'); }
  function hidePauseModal() { pauseModal.classList.add('hidden'); }
  function hideGameOverModal() { gameOverModal.classList.add('hidden'); }
  function showGameOverModal(text) {
    gameOverText.textContent = text;
    gameOverModal.classList.remove('hidden');
  }
  function hideLoadingOverlay() {
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
  }

  // Promotion modal: each option shows the unicode icon plus the character
  // name (e.g. "♕ Queen") per plan task — uses Config.CHARACTER_NAMES.
  function askPromotion(color) {
    return new Promise((resolve) => {
      promotionOptions.innerHTML = '';
      ['q', 'r', 'b', 'n'].forEach((type) => {
        const btn = document.createElement('button');
        btn.innerHTML = `<span class="promo-icon">${UNICODE[color][type]}</span>` +
          `<span class="promo-name">${Config.CHARACTER_NAMES[type]}</span>`;
        btn.addEventListener('click', () => {
          promotionModal.classList.add('hidden');
          resolve(type);
        });
        promotionOptions.appendChild(btn);
      });
      promotionModal.classList.remove('hidden');
    });
  }

  // --- Camera presets + keyboard shortcuts (plan §13.4). `handlers` = {
  // goTo(presetNameOrObject), toggleAutoRotate() } — game3d.js owns the actual
  // camera/prefs state, this module only wires the DOM/keyboard to it.
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function anyModalOpen() {
    return !!document.querySelector('.modal:not(.hidden)');
  }

  // Held down (mouse or touch), a button repeats its action every 90ms until
  // released, so zoom/rotate feel continuous instead of one nudge per click.
  function bindHoldable(btn, fn) {
    if (!btn) return;
    let timer = null;
    const start = (e) => {
      if (e) e.preventDefault();
      if (timer) return;
      fn();
      timer = setInterval(fn, 90);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    btn.addEventListener('mousedown', start);
    btn.addEventListener('touchstart', start, { passive: false });
    ['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach((evt) => btn.addEventListener(evt, stop));
  }

  function initCameraControls(handlers) {
    const camWhiteBtn = document.getElementById('camWhiteBtn');
    const camTopBtn = document.getElementById('camTopBtn');
    const camSideBtn = document.getElementById('camSideBtn');
    const camAutoBtn = document.getElementById('camAutoBtn');
    if (camWhiteBtn) camWhiteBtn.addEventListener('click', () => handlers.goTo('white'));
    if (camTopBtn) camTopBtn.addEventListener('click', () => handlers.goTo('top'));
    if (camSideBtn) camSideBtn.addEventListener('click', () => handlers.goTo('side'));
    if (camAutoBtn) camAutoBtn.addEventListener('click', () => handlers.toggleAutoRotate());

    // Zoom + rotate nudge buttons: Ctrl+scroll / trackpad pinch already zoom
    // the camera directly (see scene-setup.js), these are the explicit,
    // discoverable on-screen equivalent.
    bindHoldable(document.getElementById('zoomInBtn'), () => handlers.zoom(-1));
    bindHoldable(document.getElementById('zoomOutBtn'), () => handlers.zoom(1));
    bindHoldable(document.getElementById('camRotateLeftBtn'), () => handlers.rotate(-1, 0));
    bindHoldable(document.getElementById('camRotateRightBtn'), () => handlers.rotate(1, 0));
    bindHoldable(document.getElementById('camRotateUpBtn'), () => handlers.rotate(0, -1));
    bindHoldable(document.getElementById('camRotateDownBtn'), () => handlers.rotate(0, 1));

    // Pan (translate) nudge buttons: slide the look-at point itself, rather
    // than orbiting around it. The arrow keys do the same (see below).
    bindHoldable(document.getElementById('panForwardBtn'), () => handlers.pan(0, 1));
    bindHoldable(document.getElementById('panBackBtn'), () => handlers.pan(0, -1));
    bindHoldable(document.getElementById('panLeftBtn'), () => handlers.pan(-1, 0));
    bindHoldable(document.getElementById('panRightBtn'), () => handlers.pan(1, 0));

    // 1 White, 2 Top, 3 Side, R reset (= White), A toggle auto-rotate,
    // arrow keys pan (translate), +/- zoom. Ignored while typing in a field or while
    // any modal is open.
    document.addEventListener('keydown', (e) => {
      if (isTypingTarget(document.activeElement) || anyModalOpen()) return;
      if (e.key === '1') handlers.goTo('white');
      else if (e.key === '2') handlers.goTo('top');
      else if (e.key === '3') handlers.goTo('side');
      else if (e.key === 'r' || e.key === 'R') handlers.goTo('white');
      else if (e.key === 'a' || e.key === 'A') handlers.toggleAutoRotate();
      else if (e.key === 'ArrowLeft') handlers.pan(-1, 0);
      else if (e.key === 'ArrowRight') handlers.pan(1, 0);
      else if (e.key === 'ArrowUp') handlers.pan(0, 1);
      else if (e.key === 'ArrowDown') handlers.pan(0, -1);
      else if (e.key === '+' || e.key === '=') handlers.zoom(-1);
      else if (e.key === '-' || e.key === '_') handlers.zoom(1);
      else return;
      e.preventDefault();
    });
  }

  function setAutoRotateButtonState(on) {
    const camAutoBtn = document.getElementById('camAutoBtn');
    if (camAutoBtn) camAutoBtn.classList.toggle('active', !!on);
  }

  // 3D settings modal (plan §13.3). `prefs` is the current (already-merged)
  // prefs object, `effectiveQuality` the resolved key to highlight when
  // prefs.quality is null (auto). `handlers` = { onQuality(key), onCinematic
  // (bool), onAutoRotate(bool), onShowCoords(bool), onAnimSpeed(number) }.
  // Returns { setAutoRotateChecked(bool) } so game3d.js can keep the checkbox
  // in sync with the camAutoBtn toggle and vice versa.
  function initPrefsModal(prefs, effectiveQuality, handlers) {
    const fullscreenBtn = document.getElementById('fullscreenBtn');
    if (fullscreenBtn) {
      const syncFullscreenLabel = () => {
        fullscreenBtn.textContent = document.fullscreenElement ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
      };
      fullscreenBtn.addEventListener('click', () => {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      });
      document.addEventListener('fullscreenchange', syncFullscreenLabel);
    }
    const prefs3dBtn = document.getElementById('prefs3dBtn');
    const closePrefs3dBtn = document.getElementById('closePrefs3dBtn');
    if (prefs3dBtn) prefs3dBtn.addEventListener('click', () => prefs3dModal.classList.remove('hidden'));
    if (closePrefs3dBtn) closePrefs3dBtn.addEventListener('click', () => prefs3dModal.classList.add('hidden'));

    const qualityBtns = Array.from(document.querySelectorAll('#prefs3dModal .quality-btn'));
    const activeQuality = prefs.quality || effectiveQuality;
    qualityBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.quality === activeQuality);
      btn.addEventListener('click', () => {
        qualityBtns.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        handlers.onQuality(btn.dataset.quality);
      });
    });

    const cinematicChk = document.getElementById('prefCinematic');
    if (cinematicChk) {
      cinematicChk.checked = prefs.cinematic !== false;
      cinematicChk.addEventListener('change', () => handlers.onCinematic(cinematicChk.checked));
    }

    const autoRotateChk = document.getElementById('prefAutoRotate');
    if (autoRotateChk) {
      autoRotateChk.checked = !!prefs.autoRotate;
      autoRotateChk.addEventListener('change', () => handlers.onAutoRotate(autoRotateChk.checked));
    }

    const showCoordsChk = document.getElementById('prefShowCoords');
    if (showCoordsChk) {
      showCoordsChk.checked = prefs.showCoords !== false;
      showCoordsChk.addEventListener('change', () => handlers.onShowCoords(showCoordsChk.checked));
    }

    const glossChk = document.getElementById('prefGlossBoard');
    if (glossChk) {
      glossChk.checked = !!prefs.glossBoard;
      glossChk.addEventListener('change', () => handlers.onGlossBoard(glossChk.checked));
    }

    const showFpsChk = document.getElementById('prefShowFps');
    if (showFpsChk) {
      showFpsChk.checked = prefs.showFps !== false;
      showFpsChk.addEventListener('change', () => handlers.onShowFps(showFpsChk.checked));
    }

    const powerSaveChk = document.getElementById('prefPowerSave');
    if (powerSaveChk) {
      powerSaveChk.checked = !!prefs.powerSaveIdle;
      powerSaveChk.addEventListener('change', () => handlers.onPowerSave(powerSaveChk.checked));
    }

    const animSpeedSel =document.getElementById('prefAnimSpeed');
    if (animSpeedSel) {
      animSpeedSel.value = String(prefs.animSpeed || 1);
      animSpeedSel.addEventListener('change', () => handlers.onAnimSpeed(parseFloat(animSpeedSel.value)));
    }

    const fpsSel = document.getElementById('prefFps');
    if (fpsSel) {
      fpsSel.value = String(prefs.fps || 60);
      fpsSel.addEventListener('change', () => handlers.onFps(parseInt(fpsSel.value, 10)));
    }

    return {
      setAutoRotateChecked(on) { if (autoRotateChk) autoRotateChk.checked = !!on; }
    };
  }

  window.Chess3D.UI3D = {
    setStatus, getStatus, fmtTime, renderTimers, renderCaptured,
    showRetryButton, hideRetryButton, onRetryClick,
    showStartModal, hideStartModal, showPauseModal, hidePauseModal,
    hideGameOverModal, showGameOverModal, hideLoadingOverlay,
    askPromotion, initCameraControls, setAutoRotateButtonState, initPrefsModal
  };
})();
