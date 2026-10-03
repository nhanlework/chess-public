// game3d.js: the 3D game controller (Plan Phase 5, §10). Mirrors js/app.js's
// logic (state machine, opponent/difficulty, undo, pause, save/load, timers,
// game over) but drives Babylon.js characters/board instead of DOM squares.
(function () {
  const PLAYER_COLOR = 'w';
  const AI_COLOR = 'b';
  const SAVE_FORMAT_VERSION = 1;
  const DIFF_KEY = 'chessAiDifficulty';

  let Config, Tween, Board3D, UI3D, Cinematic;

  // ---------- Prefs (plan §13.3) ----------
  function readPrefs() {
    let prefs = Object.assign({}, Config.DEFAULT_PREFS);
    try {
      const raw = localStorage.getItem('chess3dPrefs');
      if (raw) prefs = Object.assign(prefs, JSON.parse(raw));
    } catch (e) {
      // malformed prefs: fall back to defaults
    }
    return prefs;
  }

  function savePrefs() {
    try {
      localStorage.setItem('chess3dPrefs', JSON.stringify(prefs));
    } catch (e) {
      // storage unavailable/full: prefs just won't persist across reloads
    }
  }

  // Central auto-rotate setter so the camAutoBtn and the prefs-modal checkbox
  // (plan §13.3: "đồng bộ với nút camAutoBtn") always agree with each other.
  function setAutoRotate(on) {
    prefs.autoRotate = !!on;
    savePrefs();
    Cinematic.setAutoRotate(prefs.autoRotate);
    UI3D.setAutoRotateButtonState(prefs.autoRotate);
    if (prefsModalApi) prefsModalApi.setAutoRotateChecked(prefs.autoRotate);
  }

  // Duplicates scene-setup.js's own (unexported) quality resolution so Effects
  // can be initialised with the same resolved quality object it used. Kept
  // tiny and local rather than exporting a new API from scene-setup.js (not
  // owned by this WP). See handoff Deviations.
  function resolveQualityKey(quality) {
    if (quality && Config.QUALITY[quality]) return quality;
    return (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 'medium' : 'high';
  }

  // ---------- Game state (mirrors js/app.js) ----------
  let game = new ChessGame();
  let selectedSquare = null;
  let legalMoves = [];
  let difficulty = localStorage.getItem(DIFF_KEY) || 'medium';
  let aiThinking = false;
  let gameOver = false;
  let gameStarted = false;
  let paused = false;
  let ignoreNextAiResult = false;
  let snapshots = []; // {mover:'player'|'ai', state}
  let busy = false;   // an animation is running: blocks input/undo/save/pause

  let totalSeconds = 0, whiteSeconds = 0, blackSeconds = 0;
  let timerInterval = null;

  let prefs = null;
  let sceneCtx = null; // { engine, scene, camera, ... } from SceneSetup
  let board = null;
  let pieces = null;
  let prefsModalApi = null;

  // ---------- Rendering helpers ----------
  function setStatus(text) { UI3D.setStatus(text); }

  function renderCaptured() { UI3D.renderCaptured(game.captured); }

  function renderTimers() {
    UI3D.renderTimers({ totalSeconds, whiteSeconds, blackSeconds, turn: game.turn, gameOver });
  }

  function turnStatusText() {
    return game.turn === PLAYER_COLOR ? 'Your turn (White).' : "AI's turn.";
  }

  function lastMoveSquares() {
    const h = game.history;
    if (!h.length) return null;
    const last = h[h.length - 1];
    return { from: last.from, to: last.to };
  }

  function refreshMarkers() {
    board.setMarkers({
      selected: selectedSquare,
      moves: legalMoves.map(m => ({ to: m.to, capture: m.capture })),
      lastMove: lastMoveSquares(),
      check: game.canCaptureKing(PLAYER_COLOR) ? game.findKing(AI_COLOR) : null
    });
  }

  function startTimerLoop() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      if (!gameStarted || paused || gameOver) return;
      totalSeconds++;
      if (game.turn === 'w') whiteSeconds++; else blackSeconds++;
      renderTimers();
    }, 1000);
  }

  // ---------- Busy watchdog (plan §15) ----------
  // A Promise that never resolves (a bug in some animation chain) would lock
  // input forever since `busy` gates picking/undo/save/pause. If `busy` stays
  // true for more than 15s (at 1x speed), force every in-flight Tween to its end value so
  // whatever is stuck resolves and the game recovers.
  let busySince = null;
  function startBusyWatchdog() {
    setInterval(() => {
      if (!busy) { busySince = null; return; }
      if (busySince == null) { busySince = Date.now(); return; }
      // Scaled by the animation speed pref: at 0.5x a long capture (the rook's
      // wake-walk-slam-settle) legitimately runs past 20s; a pawn's five cuts
      // and shattering armour come close to 15s even at 1x.
      if (Date.now() - busySince > 20000 / Math.min(1, Tween.speed || 1)) {
        console.warn('[Chess3D] busy for over 20s; forcing Tween.skipAll() to recover.');
        Tween.skipAll();
        busySince = Date.now(); // avoid warning again every tick until it clears or hits 20s once more
      }
    }, 1000);
  }

  // ---------- Undo ----------
  function pushSnapshot(mover) {
    snapshots.push({ mover, state: game.clone() });
  }

  async function undo() {
    if (!gameStarted || paused || busy) return;
    if (aiThinking) {
      // Cancel the in-flight AI response and just undo the player's move.
      ignoreNextAiResult = true;
      aiThinking = false;
      setOpponentSelectLocked(false);
      pieces.setThinking(AI_COLOR, false);
    }
    let idx = -1;
    for (let i = snapshots.length - 1; i >= 0; i--) {
      if (snapshots[i].mover === 'player') { idx = i; break; }
    }
    if (idx === -1) return;
    game = snapshots[idx].state.clone();
    snapshots = snapshots.slice(0, idx);
    selectedSquare = null;
    legalMoves = [];
    gameOver = false;
    UI3D.hideGameOverModal();
    UI3D.hideRetryButton();

    busy = true;
    await pieces.reconcile(game.board, { animate: true });
    busy = false;

    pieces.setSelected(null);
    refreshMarkers();
    renderCaptured();
    setStatus('Move undone. Your turn (White).');
    renderTimers();
  }

  // ---------- Move animation ----------
  async function applyMoveAnimated(from, to, promotion, mover) {
    const moving = { ...game.getPiece(from) };
    pushSnapshot(mover);
    const result = game.makeMove(from, to, promotion);
    // Capture's clash sound plays from inside captureChoreography, synced to the
    // actual impact frame (which lands well after this point) instead of here.
    if (!result.captured) ChessSound.playMove();
    busy = true;
    selectedSquare = null; legalMoves = [];
    refreshMarkers(); // clears move dots immediately
    pieces.setSelected(null);
    // `busy` gates undo/pause/save/new-move, so it must always be reset even if an
    // awaited step below throws (Q3-1: previously `busy = false` sat after these
    // calls with no finally, so a thrown error left it stuck true forever).
    try {
      try {
        await pieces.animateMove({ from, to, result, moving, mover, cinematic: prefs.cinematic });
      } catch (err) {
        console.error('Move animation failed', err); // reconcile below fixes the scene
      } finally {
        Tween.endSkip();
      }
      await pieces.reconcile(game.board, { animate: true });
      refreshMarkers(); // last-move arc/tints, check ring
      renderCaptured(); renderTimers();
    } finally {
      busy = false;
    }
    return result;
  }

  // ---------- Game over ----------
  function endGame(winner, reason) {
    gameOver = true;
    const text = winner === 'player' ? `You win! ${reason}` : `AI wins! ${reason}`;
    setStatus(text);
    renderTimers();
    runGameOverChoreography(winner, text);
  }

  // Plan §11.5: the losing King (if it's still on the board, i.e. it wasn't
  // the literal piece captured) falls and its soul rises, then the winning
  // King celebrates (+ a victory burst). With cinematics on, the camera closes
  // in on the fallen King for the death and is put back afterwards; the
  // game-over modal waits until the soul has gone (a captured King's soul was
  // already seen out by the capture choreography). `busy` is held for the
  // duration so undo/pause/save can't race the animation.
  async function runGameOverChoreography(winner, text) {
    busy = true;
    const winnerColor = winner === 'player' ? PLAYER_COLOR : AI_COLOR;
    const loserColor = winnerColor === PLAYER_COLOR ? AI_COLOR : PLAYER_COLOR;
    const winnerKingSq = game.findKing(winnerColor);
    const loserKingSq = game.findKing(loserColor);
    const winnerKingChar = winnerKingSq ? pieces.characterAt(winnerKingSq) : null;
    const loserKingChar = loserKingSq ? pieces.characterAt(loserKingSq) : null;

    const focus = !!(loserKingChar && prefs.cinematic);
    if (focus) {
      await Cinematic.focusOnPoint(loserKingChar.root.position.clone(),
        { facing: loserKingChar.root.rotation.y, lift: 1.3, radius: 5, beta: 1.22 });
    }
    if (loserKingChar) await loserKingChar.playDeath(); // slump; resolves once the soul has left the body
    if (winnerKingChar) {
      winnerKingChar.playVictory(); // not awaited
      window.Chess3D.Effects.victoryBurst(winnerKingChar.root.position.clone(), Config.TEAM[winnerColor].glow);
    }
    const soul = loserKingChar && loserKingChar.soulDone;
    await (soul || Tween.wait(1500));
    if (focus) await Cinematic.restore();
    // Respect the user's "Auto-rotate when idle" preference — don't force it on.
    Cinematic.setAutoRotate(prefs.autoRotate);

    await Tween.wait(400);
    Tween.endSkip();
    busy = false;
    UI3D.showGameOverModal(text);
  }

  // ---------- Player move ----------
  async function onSquareClick(sq) {
    if (!gameStarted || paused || gameOver || aiThinking || busy || game.turn !== PLAYER_COLOR) return;

    if (selectedSquare) {
      const move = legalMoves.find(m => m.to === sq);
      if (move) {
        await doPlayerMove(selectedSquare, sq, move);
        return;
      }
    }

    const piece = game.getPiece(sq);
    if (piece && piece.color === PLAYER_COLOR) {
      selectedSquare = sq;
      legalMoves = game.generateMoves(sq);
    } else {
      selectedSquare = null;
      legalMoves = [];
    }
    refreshMarkers();
    pieces.setSelected(selectedSquare);
  }

  async function doPlayerMove(from, to, move) {
    let promotion = null;
    if (move.promotion) {
      promotion = await UI3D.askPromotion(PLAYER_COLOR);
    }
    const result = await applyMoveAnimated(from, to, promotion, 'player');

    if (result.captured && result.captured.type === 'k') {
      endGame('player', "You captured the AI's king.");
      return;
    }

    requestAiMove();
  }

  // ---------- AI move ----------
  const opponentSelect = document.getElementById('opponentSelect');

  function setOpponentSelectLocked(locked) {
    opponentSelect.disabled = locked;
  }

  function renderOpponentSelect() {
    opponentSelect.value = ChessOpponents.getMode();
  }

  opponentSelect.addEventListener('change', () => {
    ChessOpponents.setMode(opponentSelect.value);
    AiSettings.refreshConnIndicator();
    // If the AI was waiting for a move (e.g. LLM not configured), let the new opponent play now.
    if (gameStarted && !gameOver && !paused && !busy && !aiThinking && game.turn === AI_COLOR) {
      requestAiMove();
    } else if (!aiThinking && !gameOver) {
      setStatus(gameStarted ? turnStatusText() : 'Press "Start Game" to begin.');
    }
  });

  async function requestAiMove() {
    UI3D.hideRetryButton();
    const opponent = ChessOpponents.current();

    if (!opponent.isReady()) {
      setStatus(opponent.notReadyMessage);
      return;
    }

    aiThinking = true;
    setOpponentSelectLocked(true);
    pieces.setThinking(AI_COLOR, true);
    setStatus(opponent.thinkingText());
    if (opponent.kind === 'llm') AiSettings.updateConnIndicator('pending', 'Calling AI...');

    let moveInfo;
    try {
      moveInfo = await opponent.requestMove(game, { difficulty, aiColor: AI_COLOR });
    } catch (err) {
      AiSettings.updateConnIndicator('error', 'Connection error: ' + err.message);
      setStatus(`AI call failed: ${err.message} — check your connection and API key in "AI Settings", then retry.`);
      aiThinking = false;
      setOpponentSelectLocked(false);
      pieces.setThinking(AI_COLOR, false);
      UI3D.showRetryButton();
      return;
    }

    if (ignoreNextAiResult) {
      ignoreNextAiResult = false;
      aiThinking = false;
      setOpponentSelectLocked(false);
      pieces.setThinking(AI_COLOR, false);
      return;
    }

    if (!moveInfo) {
      aiThinking = false;
      setOpponentSelectLocked(false);
      pieces.setThinking(AI_COLOR, false);
      endGame('player', 'The AI has no legal moves left.');
      return;
    }

    const usedFallback = moveInfo.usedFallback;
    const meta = game.generateMoves(moveInfo.from).find(m => m.to === moveInfo.to);
    let promotion = moveInfo.promotion;
    if (meta.promotion && !['q', 'r', 'b', 'n'].includes(promotion)) {
      promotion = 'q';
    }

    // Input is blocked by `busy` (set inside applyMoveAnimated) for the rest of this turn.
    aiThinking = false;
    setOpponentSelectLocked(false);
    pieces.setThinking(AI_COLOR, false);

    const result = await applyMoveAnimated(moveInfo.from, moveInfo.to, promotion, 'ai');

    if (usedFallback) {
      setStatus(opponent.kind === 'engine'
        ? 'Engine fallback: played a random legal move.'
        : 'AI returned an invalid move; used a random legal move instead.');
    }

    if (result.captured && result.captured.type === 'k') {
      endGame('ai', 'Your king was captured by the AI.');
      return;
    }

    if (game.isCheckmate(PLAYER_COLOR)) {
      endGame('ai', 'Checkmate — your king has no way out.');
      return;
    }

    if (!usedFallback) setStatus(game.inCheck(PLAYER_COLOR) ? 'Check! Your turn (White).' : 'Your turn (White).');
  }

  // ---------- Difficulty buttons ----------
  // Scoped to [data-diff] (not just .diff-btn) so it never touches the 3D
  // Settings modal's .quality-btn buttons, which use their own class/dataset.
  function renderDifficultyButtons() {
    document.querySelectorAll('.diff-btn[data-diff]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.diff === difficulty);
    });
  }
  document.querySelectorAll('.diff-btn[data-diff]').forEach(btn => {
    btn.addEventListener('click', () => {
      difficulty = btn.dataset.diff;
      localStorage.setItem(DIFF_KEY, difficulty);
      renderDifficultyButtons();
    });
  });

  // ---------- Pause ----------
  function pauseGame() {
    if (!gameStarted || gameOver || paused || busy) return;
    paused = true;
    UI3D.showPauseModal();
    setStatus('Game paused.');
    sceneCtx.engine.stopRenderLoop();
  }

  function resumeGame() {
    if (!paused) return;
    paused = false;
    UI3D.hidePauseModal();
    setStatus(gameOver ? UI3D.getStatus() : turnStatusText());
    sceneCtx.engine.runRenderLoop(sceneCtx.renderFrame);
  }

  document.getElementById('pauseBtn').addEventListener('click', pauseGame);
  document.getElementById('resumeBtn').addEventListener('click', resumeGame);
  document.getElementById('restartFromPauseBtn').addEventListener('click', () => {
    UI3D.hidePauseModal();
    newGame();
  });

  // ---------- Save / Load ----------
  function serializeGame() {
    return {
      format: 'chess-vs-ai-save',
      version: SAVE_FORMAT_VERSION,
      savedAt: new Date().toISOString(),
      difficulty,
      aiProvider: AiSettings.getSettings().provider,
      opponent: ChessOpponents.getMode(),
      gameOver,
      timers: { totalSeconds, whiteSeconds, blackSeconds },
      state: {
        board: game.board,
        turn: game.turn,
        castling: game.castling,
        enPassant: game.enPassant,
        captured: game.captured,
        history: game.history,
        moveCount: game.moveCount
      }
    };
  }

  function saveGameToFile() {
    if (busy) return;
    const data = serializeGame();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const ts = data.savedAt.replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `chess-game-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function loadGameFromData(data) {
    if (!data || !data.state || !data.state.board) {
      alert('This file does not look like a valid chess save.');
      return;
    }
    const g = new ChessGame();
    Object.assign(g, data.state);
    game = g;

    if (['easy', 'medium', 'hard'].includes(data.difficulty)) {
      difficulty = data.difficulty;
      localStorage.setItem(DIFF_KEY, difficulty);
    }
    if (ChessOpponents.MODES.includes(data.opponent)) {
      ChessOpponents.setMode(data.opponent);
      renderOpponentSelect();
      AiSettings.refreshConnIndicator();
    }
    if (data.timers) {
      totalSeconds = data.timers.totalSeconds || 0;
      whiteSeconds = data.timers.whiteSeconds || 0;
      blackSeconds = data.timers.blackSeconds || 0;
    } else {
      totalSeconds = whiteSeconds = blackSeconds = 0;
    }
    gameOver = !!data.gameOver;

    selectedSquare = null;
    legalMoves = [];
    snapshots = [];
    aiThinking = false;
    ignoreNextAiResult = false;
    paused = false;
    gameStarted = true;

    UI3D.hideStartModal();
    UI3D.hidePauseModal();
    UI3D.hideGameOverModal();
    UI3D.hideRetryButton();

    busy = true;
    await pieces.syncInstant(game.board);
    busy = false;
    pieces.setSelected(null);

    renderDifficultyButtons();
    refreshMarkers();
    renderCaptured();
    renderTimers();
    setStatus(gameOver ? 'Loaded a finished game.' : `Game loaded. ${turnStatusText()}`);
    Cinematic.goTo('white');

    if (!gameOver && game.turn === AI_COLOR) {
      requestAiMove();
    }
  }

  document.getElementById('saveGameBtn').addEventListener('click', saveGameToFile);

  const loadGameInput = document.getElementById('loadGameInput');
  function triggerLoadDialog() {
    loadGameInput.value = '';
    loadGameInput.click();
  }
  document.getElementById('loadGameBtn').addEventListener('click', triggerLoadDialog);
  document.getElementById('loadGameBtnStart').addEventListener('click', triggerLoadDialog);

  loadGameInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        loadGameFromData(data);
      } catch (err) {
        alert('Could not read this save file: ' + err.message);
      }
    };
    reader.readAsText(file);
  });

  // ---------- Start / New game ----------
  document.getElementById('undoBtn').addEventListener('click', undo);
  document.getElementById('newGameBtn').addEventListener('click', newGame);
  document.getElementById('newGameBtn2').addEventListener('click', newGame);
  document.getElementById('startBtn').addEventListener('click', newGame);

  async function resetGameState() {
    game = new ChessGame();
    selectedSquare = null;
    legalMoves = [];
    snapshots = [];
    aiThinking = false;
    gameOver = false;
    ignoreNextAiResult = false;
    paused = false;
    totalSeconds = 0; whiteSeconds = 0; blackSeconds = 0;
    UI3D.hideGameOverModal();
    UI3D.hidePauseModal();
    UI3D.hideRetryButton();
    pieces.setThinking(AI_COLOR, false);

    busy = true;
    await pieces.syncInstant(game.board);
    busy = false;
    pieces.setSelected(null);

    refreshMarkers();
    renderCaptured();
    renderTimers();
  }

  async function newGame() {
    ChessSound.unlock(); // must run inside this click handler (user gesture) to allow audio later
    await resetGameState();
    gameStarted = true;
    UI3D.hideStartModal();
    Cinematic.goTo('white');
    setStatus('Your turn (White).');
  }

  // ---------- Picking (§10.1) ----------
  // `pickInfo` resolves hits on merged meshes: the board surface (all squares
  // of a colour, square from the hit point) and idle pieces drawn as
  // InstancePool thin instances (one mesh, many pieces).
  function squareFromMesh(mesh, pickInfo) {
    let m = mesh;
    let depth = 0;
    while (m && depth < 6) {
      if (m.metadata) {
        if (m.metadata.square) return m.metadata.square;
        if (m.metadata.boardSurface) return pickInfo && pickInfo.pickedPoint ? board.worldToSquare(pickInfo.pickedPoint) : null;
        if (m.metadata.characterId) return pieces.squareOfCharacter(m.metadata.characterId);
        if (m.metadata.instanceOwners) {
          const id = window.Chess3D.InstancePool.characterIdFromPick(m, pickInfo && pickInfo.thinInstanceIndex);
          return id ? pieces.squareOfCharacter(id) : null;
        }
      }
      m = m.parent;
      depth++;
    }
    // Any other part of a live piece: its root node is named char_<id>.
    const id = characterIdOf(mesh);
    return id ? pieces.squareOfCharacter(id) : null;
  }

  function characterIdOf(mesh) {
    for (let n = mesh; n; n = n.parent) {
      if (n.name && n.name.startsWith('char_') && !n.parent) return n.name.slice(5);
    }
    return null;
  }

  // Hover, click and double-click all resolve the square under the pointer
  // the same way: only meshes that are drawn (enabled, pickable) and mean a
  // square or a piece. Hidden rig meshes of pooled pieces (disabled, with
  // stale world matrices) and flat overlays (markers, gloss sheet) never
  // intercept the ray.
  function pickSquare(scene, x, y) {
    const pick = scene.pick(x, y, (m) => m.isEnabled() && m.isPickable && (m.metadata ?
      !!(m.metadata.square || m.metadata.boardSurface || m.metadata.characterId || m.metadata.instanceOwners) :
      !!characterIdOf(m)));
    return (pick && pick.hit) ? squareFromMesh(pick.pickedMesh, pick) : null;
  }

  function setupPicking(scene) {
    const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    let hoverScheduled = false;

    function scheduleHover() {
      if (isTouch || hoverScheduled) return;
      hoverScheduled = true;
      requestAnimationFrame(() => {
        hoverScheduled = false;
        // Camera drag in progress (active meshes frozen): hover markers can't change now.
        if (scene._activeMeshesFrozen) return;
        if (!gameStarted || paused || gameOver || busy || aiThinking || game.turn !== PLAYER_COLOR) {
          board.setHover(null);
          return;
        }
        board.setHover(pickSquare(scene, scene.pointerX, scene.pointerY));
      });
    }

    scene.onPointerObservable.add((pi) => {
      if (pi.type === BABYLON.PointerEventTypes.POINTERTAP) {
        const sq = pickSquare(scene, scene.pointerX, scene.pointerY);
        if (sq) onSquareClick(sq);
      }
      if (pi.type === BABYLON.PointerEventTypes.POINTERMOVE) scheduleHover();
      // Plan §13.4: double-click/double-tap on a piece gently focuses the camera
      // on it (held until a preset button/shortcut is used); doesn't touch selection.
      if (pi.type === BABYLON.PointerEventTypes.POINTERDOUBLETAP) {
        const sq = pickSquare(scene, scene.pointerX, scene.pointerY);
        const ch = sq ? pieces.characterAt(sq) : null;
        if (ch) Cinematic.goTo({ target: ch.root.position.clone(), radius: 8 });
      }
    });
  }

  // ---------- Boot ----------
  async function boot() {
    Config = window.Chess3D.Config;
    Tween = window.Chess3D.Tween;
    Board3D = window.Chess3D.Board3D;
    Cinematic = window.Chess3D.Cinematic;
    UI3D = window.Chess3D.UI3D;

    const canvas = document.getElementById('renderCanvas');
    prefs = readPrefs();

    sceneCtx = window.Chess3D.SceneSetup.create(canvas, prefs.quality, prefs.fps, !!prefs.powerSaveIdle);
    Tween.init(sceneCtx.scene);
    Tween.speed = prefs.animSpeed || 1;

    board = Board3D.create(sceneCtx.scene, sceneCtx);
    // Markers and labels change what is drawn while nothing animates: tell the
    // frame pacer so it unfreezes the active-mesh list and redraws shadows.
    ['setMarkers', 'setHover', 'setCoordsVisible'].forEach((name) => {
      const fn = board[name];
      board[name] = function () { sceneCtx.invalidate(); return fn.apply(this, arguments); };
    });
    board.setCoordsVisible(prefs.showCoords !== false);

    const qualityKey = resolveQualityKey(prefs.quality);
    window.Chess3D.Effects.init(sceneCtx.scene, {
      glow: sceneCtx.glow,
      quality: Config.QUALITY[qualityKey],
      qualityKey
    });
    Cinematic.init(sceneCtx.scene, sceneCtx.camera, sceneCtx.pipeline, () => prefs);

    // Ambience (plan §13.1): torches at the 4 plinth corners + floating dust motes.
    // Both effects are quality-aware internally (Effects.torch skips the flicker
    // PointLight at 'low'; Effects.ambientMotes() is a no-op at 'low').
    const quality = Config.QUALITY[qualityKey];
    const torchOpts = quality.torchLitPieces ? null : { litMeshes: board.staticMeshes };
    board.torchPositions.forEach((pos) => window.Chess3D.Effects.torch(pos, torchOpts));
    // Board meshes have no emissive, so rendering them into the glow texture is pure cost;
    // markers and coordinate labels are emissive but a glow halo only smears them.
    board.staticMeshes.concat(board.noGlowMeshes).forEach((m) => sceneCtx.glow.addExcludedMesh(m));
    window.Chess3D.Effects.ambientMotes();
    // Effect flash lights come from a fixed pool created before any character
    // material compiles (see Effects.initLightPool); the board keeps its torches.
    window.Chess3D.Effects.initLightPool({ exclude: board.staticMeshes });
    // Anything animating: full frame rate, shadows redrawn every frame, active meshes unfrozen.
    sceneCtx.setBusyProbe(() => busy || Tween.isActive());

    const charCtx = {
      scene: sceneCtx.scene,
      shadowGen: sceneCtx.shadowGen,
      highlight: sceneCtx.highlight,
      glow: sceneCtx.glow,
      effects: window.Chess3D.Effects || null,
      config: Config,
      quality
    };
    const factory = window.Chess3D.CharacterFactory;
    await factory.init(sceneCtx.scene, charCtx);
    pieces = new window.Chess3D.PieceManager({
      scene: sceneCtx.scene, board, factory, effects: charCtx.effects, ctx: charCtx
    });
    await pieces.syncInstant(game.board);
    // Pawns fidget while the board is quiet (and not in power-saving mode, which
    // would otherwise be kept at full frame rate by the animation).
    pieces.fidgetGate = () => gameStarted && !busy && !prefs.powerSaveIdle;
    pieces.startIdleLoop();
    window.Chess3D.BoardGloss.init(sceneCtx.scene, { pieces, glow: sceneCtx.glow });
    window.Chess3D.BoardGloss.setEnabled(!!prefs.glossBoard);
    sceneCtx.setShowFps(prefs.showFps !== false);

    // Compile every effect's shaders behind the loading overlay so their first
    // play doesn't stutter (the queen's attack and the king's death did).
    // Capture close-ups switch depth of field on; compile that pass here too.
    if (quality.dof) Cinematic.setDepthOfField(true);
    await window.Chess3D.Effects.prewarm({ king: pieces.characterAt('e1'), queen: pieces.characterAt('d1') });
    Cinematic.setDepthOfField(false);

    setupPicking(sceneCtx.scene);

    // Plan §13.4: camera preset buttons + keyboard shortcuts (1/2/3/R/A).
    UI3D.initCameraControls({
      goTo: (preset) => Cinematic.goTo(preset),
      toggleAutoRotate: () => setAutoRotate(!prefs.autoRotate),
      zoom: (dir) => Cinematic.nudgeZoom(dir),
      rotate: (dAlpha, dBeta) => Cinematic.nudgeRotate(dAlpha, dBeta),
      pan: (dx, dy) => Cinematic.nudgePan(dx, dy)
    });
    if (prefs.autoRotate) setAutoRotate(true); // sync button/checkbox with the loaded pref

    // Plan §13.3: 3D settings modal (quality / cinematic / auto-rotate / coords / speed).
    prefsModalApi = UI3D.initPrefsModal(prefs, qualityKey, {
      onQuality: (key) => {
        prefs.quality = key;
        savePrefs();
        sceneCtx.applyQuality(key);
        window.Chess3D.Effects.setQuality(Config.QUALITY[key], key);
      },
      onCinematic: (v) => { prefs.cinematic = v; savePrefs(); },
      onAutoRotate: (v) => setAutoRotate(v),
      onShowCoords: (v) => { prefs.showCoords = v; savePrefs(); board.setCoordsVisible(v); },
      onAnimSpeed: (v) => { prefs.animSpeed = v; savePrefs(); Tween.speed = v; },
      onFps: (v) => { prefs.fps = v; savePrefs(); sceneCtx.setTargetFps(v); },
      onShowFps: (v) => { prefs.showFps = v; savePrefs(); sceneCtx.setShowFps(v); },
      onPowerSave: (v) => { prefs.powerSaveIdle = v; savePrefs(); sceneCtx.setPowerSave(v); },
      onGlossBoard: (v) => { prefs.glossBoard = v; savePrefs(); window.Chess3D.BoardGloss.setEnabled(v); }
    });

    UI3D.onRetryClick(requestAiMove);

    // Exposed for browser verification (javascript_tool) and the debug inspector.
    window.__chess3dBoot = { engine: sceneCtx.engine, scene: sceneCtx.scene, camera: sceneCtx.camera, board, pieces, game: () => game };

    // Full debug hook (plan §13.2), only wired with ?debug=1 in the URL.
    if (location.search.indexOf('debug=1') !== -1) {
      window.__chess3d = {
        game: () => game,
        pieces, board, scene: sceneCtx.scene, camera: sceneCtx.camera,
        countCharacters: () => pieces.byId.size,
        // The square a click at canvas CSS pixel (x, y) would resolve to.
        pickSquare: (x, y) => pickSquare(sceneCtx.scene, x, y),
        // Plays a move exactly like a player click would, ignoring whose turn it
        // actually is (useful for staging any capture/promotion on demand).
        forceMove: async (from, to, promo) => {
          if (busy) { console.warn('[Chess3D] forceMove: busy, try again shortly.'); return null; }
          const move = game.generateMoves(from).find(m => m.to === to);
          if (!move) { console.warn(`[Chess3D] forceMove: ${from}-${to} is not a legal move.`); return null; }
          let promotion = promo || null;
          if (move.promotion && !['q', 'r', 'b', 'n'].includes(promotion)) promotion = 'q';
          const moverColor = game.getPiece(from).color;
          return applyMoveAnimated(from, to, promotion, moverColor === PLAYER_COLOR ? 'player' : 'ai');
        },
        // Lets the built-in engine play both sides for n plies, for stress-testing
        // captures/cinematics/reconcile without needing real clicks.
        autoplay: async (n) => {
          for (let i = 0; i < n; i++) {
            if (gameOver) { console.warn('[Chess3D] autoplay: stopped, game is over.'); break; }
            if (busy) { console.warn('[Chess3D] autoplay: stopped, still busy.'); break; }
            const moverColor = game.turn;
            const moveInfo = await window.EngineOpponent.requestMove(game, { difficulty, aiColor: moverColor });
            if (!moveInfo) {
              endGame(moverColor === PLAYER_COLOR ? 'ai' : 'player', `${moverColor === 'w' ? 'White' : 'Black'} has no legal moves left.`);
              break;
            }
            const mover = moverColor === PLAYER_COLOR ? 'player' : 'ai';
            const result = await applyMoveAnimated(moveInfo.from, moveInfo.to, moveInfo.promotion, mover);
            if (result.captured && result.captured.type === 'k') {
              endGame(moverColor === PLAYER_COLOR ? 'player' : 'ai', `${moverColor === 'w' ? 'White' : 'Black'} captured the King.`);
              break;
            }
            if (game.isCheckmate(game.turn)) {
              endGame(moverColor === PLAYER_COLOR ? 'player' : 'ai', `${game.turn === 'w' ? 'White' : 'Black'} is checkmated.`);
              break;
            }
          }
        },
        endGame: (winner, reason) => endGame(winner, reason || 'debug'),
        fps: () => sceneCtx.engine.getFps()
      };
    }

    UI3D.hideLoadingOverlay();

    renderDifficultyButtons();
    renderOpponentSelect();
    if (window.AiSettings && typeof window.AiSettings.init === 'function') {
      window.AiSettings.init();
    }

    gameStarted = false;
    setStatus('Press "Start Game" to begin.');
    UI3D.showStartModal();
    startTimerLoop();
    startBusyWatchdog();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
