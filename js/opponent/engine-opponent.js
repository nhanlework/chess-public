(function () {
  // Resolve the worker URL relative to THIS script, so it works from index.html and 2d.html alike.
  const BASE = new URL('.', document.currentScript.src);
  const MIN_THINK_MS = 350;   // an instant reply feels robotic
  let worker = null;
  let workerBroken = false;
  let nextId = 1;
  const pending = new Map();  // id -> { resolve }

  function getWorker() {
    if (workerBroken) return null;
    if (worker) return worker;
    try {
      worker = new Worker(new URL('engine-worker.js', BASE));
      worker.onmessage = (e) => {
        const { id, type, move, message } = e.data || {};
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (type === 'result') p.resolve(move);
        else { console.warn('Engine worker error:', message); p.fallback(); }
      };
      worker.onerror = (e) => {
        console.warn('Engine worker failed, falling back to main thread:', e.message);
        workerBroken = true;
        worker = null;
        for (const p of pending.values()) p.fallback();
        pending.clear();
      };
    } catch (e) {
      workerBroken = true;
      worker = null;
    }
    return worker;
  }

  function stateOf(game) {
    return { board: game.board, turn: game.turn, castling: game.castling, enPassant: game.enPassant };
  }

  // Main-thread fallback with a short budget so the UI never freezes for long.
  function searchOnMainThread(state, opts) {
    try {
      return ChessEngineSearch.searchBestMove(state, { ...opts, timeMsOverride: 600 });
    } catch (e) {
      console.error('Engine search failed:', e);
      return null;
    }
  }

  function requestRaw(state, opts) {
    return new Promise((resolve) => {
      const w = getWorker();
      const fallback = () => setTimeout(() => resolve(searchOnMainThread(state, opts)), 0);
      if (!w) { fallback(); return; }
      const id = nextId++;
      pending.set(id, { resolve, fallback });
      w.postMessage({ type: 'search', id, state, aiColor: opts.aiColor, difficulty: opts.difficulty });
    });
  }

  window.EngineOpponent = {
    kind: 'engine',
    isReady: () => true,
    notReadyMessage: '',
    thinkingText: () => 'Engine is thinking...',
    async requestMove(game, { difficulty, aiColor }) {
      const t0 = Date.now();
      let move = await requestRaw(stateOf(game), { difficulty, aiColor });
      // Final safety net: if the engine produced nothing usable, pick any legal move.
      if (move && !game.generateMoves(move.from).some(m => m.to === move.to)) move = null;
      let usedFallback = false;
      if (!move) {
        // Deliberately not using LlmOpponent's pickRandomMove to keep the two opponents independent.
        const options = ChessEngineSearch.allMoves(ChessEngineSearch.fromState(stateOf(game)));
        if (!options.length) return null;
        const pick = options[Math.floor(Math.random() * options.length)];
        move = { from: pick.from, to: pick.to, promotion: pick.promotion ? 'q' : null };
        usedFallback = true;
      }
      const elapsed = Date.now() - t0;
      if (elapsed < MIN_THINK_MS) await new Promise(r => setTimeout(r, MIN_THINK_MS - elapsed));
      return { from: move.from, to: move.to, promotion: move.promotion || null, usedFallback };
    },
    // Extra debug hook (not part of the shared Opponent interface): lets the
    // browser check page and manual QA confirm whether the Worker path is used.
    _debug: () => ({ workerBroken })
  };
})();
