(function () {
  const PLAYER_COLOR = 'w';
  const AI_COLOR = 'b';
  const SAVE_FORMAT_VERSION = 1;

  const UNICODE = {
    w: { p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' },
    b: { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }
  };

  const DIFF_KEY = 'chessAiDifficulty';

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

  let totalSeconds = 0, whiteSeconds = 0, blackSeconds = 0;
  let timerInterval = null;

  // ---------- DOM refs ----------
  const boardEl = document.getElementById('board');
  const statusBar = document.getElementById('statusBar');
  const capturedWhiteEl = document.getElementById('capturedWhite'); // player's pieces AI captured
  const capturedBlackEl = document.getElementById('capturedBlack'); // AI's pieces player captured
  const totalTimerEl = document.getElementById('totalTimer');
  const whiteTimerEl = document.getElementById('whiteTimer');
  const blackTimerEl = document.getElementById('blackTimer');
  const undoBtn = document.getElementById('undoBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const startModal = document.getElementById('startModal');
  const pauseModal = document.getElementById('pauseModal');
  const gameOverModal = document.getElementById('gameOverModal');
  const retryAiBtn = document.getElementById('retryAiBtn');

  // ---------- Rendering ----------
  const lastMoveOverlay = document.getElementById('lastMoveOverlay');

  function getLastMoveSquares() {
    const h = game.history;
    if (!h.length) return null;
    const last = h[h.length - 1];
    return { from: last.from, to: last.to };
  }

  function drawLastMoveArrow(move) {
    if (!move) {
      lastMoveOverlay.innerHTML = '';
      return;
    }
    const [fr, fc] = sqToRc(move.from);
    const [tr, tc] = sqToRc(move.to);
    const x1 = fc + 0.5, y1 = fr + 0.5, x2 = tc + 0.5, y2 = tr + 0.5;
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const shorten = 0.3; // stop short of the destination center so the arrowhead doesn't bury itself under the piece
    const ex = x2 - (dx / len) * shorten;
    const ey = y2 - (dy / len) * shorten;
    lastMoveOverlay.innerHTML = `
      <defs>
        <marker id="lastMoveArrowHead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="rgba(255,170,0,0.9)" />
        </marker>
      </defs>
      <line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke="rgba(255,170,0,0.9)" stroke-width="0.12" stroke-linecap="round" marker-end="url(#lastMoveArrowHead)" />
    `;
  }

  function renderBoard() {
    boardEl.innerHTML = '';
    const lastMove = getLastMoveSquares();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const sq = rcToSq(r, c);
        const div = document.createElement('div');
        div.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
        div.dataset.sq = sq;

        const piece = game.board[r][c];
        if (piece) {
          const span = document.createElement('span');
          span.className = 'piece piece-' + piece.color;
          span.textContent = UNICODE[piece.color][piece.type];
          div.appendChild(span);
        }

        if (selectedSquare === sq) div.classList.add('selected');
        const move = legalMoves.find(m => m.to === sq);
        if (move) div.classList.add(move.capture ? 'legal-capture' : 'legal-move');
        if (lastMove && (sq === lastMove.from || sq === lastMove.to)) div.classList.add('last-move');

        div.addEventListener('click', () => onSquareClick(sq));
        boardEl.appendChild(div);
      }
    }
    drawLastMoveArrow(lastMove);
  }

  function renderCaptured() {
    // captured.w = white pieces that were captured (i.e. captured BY the AI)
    capturedWhiteEl.innerHTML = game.captured.w.map(t => UNICODE.w[t]).join(' ');
    capturedBlackEl.innerHTML = game.captured.b.map(t => UNICODE.b[t]).join(' ');
  }

  function setStatus(text) {
    statusBar.textContent = text;
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60).toString().padStart(2, '0');
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function renderTimers() {
    totalTimerEl.textContent = 'Total: ' + fmtTime(totalSeconds);
    whiteTimerEl.textContent = 'You: ' + fmtTime(whiteSeconds);
    blackTimerEl.textContent = 'AI: ' + fmtTime(blackSeconds);
    whiteTimerEl.classList.toggle('active', game.turn === 'w' && !gameOver);
    blackTimerEl.classList.toggle('active', game.turn === 'b' && !gameOver);
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

  function turnStatusText() {
    return game.turn === PLAYER_COLOR ? 'Your turn (White).' : "AI's turn.";
  }

  // ---------- Undo ----------
  function pushSnapshot(mover) {
    snapshots.push({ mover, state: game.clone() });
  }

  function undo() {
    if (!gameStarted || paused) return;
    if (aiThinking) {
      // Cancel the in-flight AI response and just undo the player's move.
      ignoreNextAiResult = true;
      aiThinking = false;
      setOpponentSelectLocked(false);
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
    gameOverModal.classList.add('hidden');
    retryAiBtn.style.display = 'none';
    renderBoard();
    renderCaptured();
    setStatus('Move undone. Your turn (White).');
    renderTimers();
  }

  // ---------- Promotion modal ----------
  function askPromotion(color) {
    return new Promise((resolve) => {
      const modal = document.getElementById('promotionModal');
      const opts = document.getElementById('promotionOptions');
      opts.innerHTML = '';
      ['q', 'r', 'b', 'n'].forEach(type => {
        const btn = document.createElement('button');
        btn.textContent = UNICODE[color][type];
        btn.addEventListener('click', () => {
          modal.classList.add('hidden');
          resolve(type);
        });
        opts.appendChild(btn);
      });
      modal.classList.remove('hidden');
    });
  }

  // ---------- Capture video popup ----------
  function showCaptureVideo() {
    return new Promise((resolve) => {
      const modal = document.getElementById('captureVideoModal');
      const video = document.getElementById('captureVideo');
      const skipBtn = document.getElementById('skipVideoBtn');
      let done = false;

      const finish = () => {
        if (done) return;
        done = true;
        video.pause();
        video.currentTime = 0;
        video.removeEventListener('ended', finish);
        skipBtn.removeEventListener('click', finish);
        video.removeEventListener('error', onError);
        modal.classList.add('hidden');
        resolve();
      };
      const onError = () => finish();

      video.addEventListener('ended', finish);
      skipBtn.addEventListener('click', finish);
      video.addEventListener('error', onError);

      modal.classList.remove('hidden');
      video.currentTime = 0;
      video.play().catch(() => { /* autoplay might be blocked; skip button still works */ });
    });
  }

  // ---------- Piece slide animation (FLIP technique) ----------
  function squareRect(sq) {
    const el = document.querySelector(`.square[data-sq="${sq}"]`);
    return el ? el.getBoundingClientRect() : null;
  }

  function animateSlide(toSq, fromRect) {
    return new Promise((resolve) => {
      if (!fromRect) { resolve(); return; }
      const toEl = document.querySelector(`.square[data-sq="${toSq}"]`);
      const piece = toEl && toEl.querySelector('.piece');
      if (!piece) { resolve(); return; }
      const toRect = toEl.getBoundingClientRect();
      const dx = fromRect.left - toRect.left;
      const dy = fromRect.top - toRect.top;
      if (!dx && !dy) { resolve(); return; }

      piece.style.transition = 'none';
      piece.style.transform = `translate(${dx}px, ${dy}px)`;
      void piece.offsetWidth; // force reflow so the transform above applies before transitioning
      piece.style.transition = 'transform 220ms ease-out';
      piece.style.transform = 'translate(0, 0)';

      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        piece.style.transition = '';
        piece.style.transform = '';
        resolve();
      };
      piece.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 300);
    });
  }

  // ---------- Capture effect (plays on the board before the capture video) ----------
  function captureEffectSquare(fromSq, toSq, wasEnPassant) {
    if (!wasEnPassant) return toSq;
    const [fr] = sqToRc(fromSq);
    const [, tc] = sqToRc(toSq);
    return rcToSq(fr, tc);
  }

  function playCaptureEffect(square) {
    return new Promise((resolve) => {
      const sqEl = document.querySelector(`.square[data-sq="${square}"]`);
      if (!sqEl) { resolve(); return; }
      const fx = document.createElement('div');
      fx.className = 'capture-effect';
      fx.textContent = '💥';
      sqEl.appendChild(fx);
      setTimeout(() => {
        fx.remove();
        resolve();
      }, 500);
    });
  }

  // ---------- Game over ----------
  function endGame(winner, reason) {
    gameOver = true;
    const text = winner === 'player'
      ? `You win! ${reason}`
      : `AI wins! ${reason}`;
    document.getElementById('gameOverText').textContent = text;
    gameOverModal.classList.remove('hidden');
    setStatus(text);
    renderTimers();
  }

  // ---------- Player move ----------
  async function onSquareClick(sq) {
    if (!gameStarted || paused || gameOver || aiThinking || game.turn !== PLAYER_COLOR) return;

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
    renderBoard();
  }

  async function doPlayerMove(from, to, move) {
    let promotion = null;
    if (move.promotion) {
      promotion = await askPromotion(PLAYER_COLOR);
    }
    const fromRect = squareRect(from);
    pushSnapshot('player');
    const result = game.makeMove(from, to, promotion);
    result.captured ? ChessSound.playCapture() : ChessSound.playMove();
    selectedSquare = null;
    legalMoves = [];
    renderBoard();
    renderCaptured();
    await animateSlide(to, fromRect);

    if (result.captured) {
      await playCaptureEffect(captureEffectSquare(from, to, result.enPassant));
      await showCaptureVideo();
    }

    if (result.captured && result.captured.type === 'k') {
      endGame('player', "You captured the AI's king.");
      return;
    }

    renderTimers();
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
    if (gameStarted && !gameOver && !paused && !aiThinking && game.turn === AI_COLOR) {
      requestAiMove();
    } else if (!aiThinking && !gameOver) {
      setStatus(gameStarted ? turnStatusText() : 'Press "Start Game" to begin.');
    }
  });

  async function requestAiMove() {
    retryAiBtn.style.display = 'none';
    const opponent = ChessOpponents.current();

    if (!opponent.isReady()) {
      setStatus(opponent.notReadyMessage);
      return;
    }

    aiThinking = true;
    setOpponentSelectLocked(true);
    boardEl.style.pointerEvents = 'none';
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
      boardEl.style.pointerEvents = '';
      retryAiBtn.style.display = 'inline-block';
      return;
    }

    if (ignoreNextAiResult) {
      ignoreNextAiResult = false;
      aiThinking = false;
      setOpponentSelectLocked(false);
      boardEl.style.pointerEvents = '';
      return;
    }

    if (!moveInfo) {
      aiThinking = false;
      setOpponentSelectLocked(false);
      boardEl.style.pointerEvents = '';
      endGame('player', 'The AI has no legal moves left.');
      return;
    }

    const usedFallback = moveInfo.usedFallback;
    const meta = game.generateMoves(moveInfo.from).find(m => m.to === moveInfo.to);
    let promotion = moveInfo.promotion;
    if (meta.promotion && !['q', 'r', 'b', 'n'].includes(promotion)) {
      promotion = 'q';
    }

    const fromRect = squareRect(moveInfo.from);
    pushSnapshot('ai');
    const result = game.makeMove(moveInfo.from, moveInfo.to, promotion);
    result.captured ? ChessSound.playCapture() : ChessSound.playMove();
    aiThinking = false;
    setOpponentSelectLocked(false);
    renderBoard();
    renderCaptured();
    await animateSlide(moveInfo.to, fromRect);

    if (usedFallback) {
      setStatus('AI returned an invalid move; used a random legal move instead.');
    }

    if (result.captured) {
      await playCaptureEffect(captureEffectSquare(moveInfo.from, moveInfo.to, result.enPassant));
      await showCaptureVideo();
    }

    boardEl.style.pointerEvents = '';

    if (result.captured && result.captured.type === 'k') {
      endGame('ai', 'Your king was captured by the AI.');
      return;
    }

    if (game.isCheckmate(PLAYER_COLOR)) {
      endGame('ai', 'Checkmate — your king has no way out.');
      return;
    }

    if (!usedFallback) setStatus(game.inCheck(PLAYER_COLOR) ? 'Check! Your turn (White).' : 'Your turn (White).');
    renderTimers();
  }

  retryAiBtn.addEventListener('click', requestAiMove);

  // ---------- Difficulty buttons ----------
  function renderDifficultyButtons() {
    document.querySelectorAll('.diff-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.diff === difficulty);
    });
  }
  document.querySelectorAll('.diff-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      difficulty = btn.dataset.diff;
      localStorage.setItem(DIFF_KEY, difficulty);
      renderDifficultyButtons();
    });
  });

  // ---------- Pause ----------
  function pauseGame() {
    if (!gameStarted || gameOver || paused) return;
    paused = true;
    pauseModal.classList.remove('hidden');
    setStatus('Game paused.');
  }

  function resumeGame() {
    if (!paused) return;
    paused = false;
    pauseModal.classList.add('hidden');
    setStatus(gameOver ? statusBar.textContent : turnStatusText());
  }

  pauseBtn.addEventListener('click', pauseGame);
  document.getElementById('resumeBtn').addEventListener('click', resumeGame);
  document.getElementById('restartFromPauseBtn').addEventListener('click', () => {
    pauseModal.classList.add('hidden');
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

  function loadGameFromData(data) {
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

    startModal.classList.add('hidden');
    pauseModal.classList.add('hidden');
    gameOverModal.classList.add('hidden');
    retryAiBtn.style.display = 'none';

    renderDifficultyButtons();
    renderBoard();
    renderCaptured();
    renderTimers();
    setStatus(gameOver ? 'Loaded a finished game.' : `Game loaded. ${turnStatusText()}`);

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
  undoBtn.addEventListener('click', undo);
  document.getElementById('newGameBtn').addEventListener('click', newGame);
  document.getElementById('newGameBtn2').addEventListener('click', newGame);
  document.getElementById('startBtn').addEventListener('click', newGame);

  function resetGameState() {
    game = new ChessGame();
    selectedSquare = null;
    legalMoves = [];
    snapshots = [];
    aiThinking = false;
    gameOver = false;
    ignoreNextAiResult = false;
    paused = false;
    totalSeconds = 0; whiteSeconds = 0; blackSeconds = 0;
    gameOverModal.classList.add('hidden');
    pauseModal.classList.add('hidden');
    retryAiBtn.style.display = 'none';
    renderBoard();
    renderCaptured();
    renderTimers();
  }

  function newGame() {
    ChessSound.unlock(); // must run inside this click handler (user gesture) to allow audio later
    resetGameState();
    gameStarted = true;
    startModal.classList.add('hidden');
    setStatus('Your turn (White).');
  }

  // ---------- Init ----------
  renderDifficultyButtons();
  renderOpponentSelect();
  AiSettings.init();
  resetGameState();
  gameStarted = false;
  setStatus('Press "Start Game" to begin.');
  startModal.classList.remove('hidden');
  startTimerLoop();
})();
