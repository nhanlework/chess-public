// Registry for "who plays Black": the LLM (AI server) or the built-in engine.
// Shared by the 2D and 3D apps; mode persists in localStorage.
(function () {
  const MODE_KEY = 'chessOpponentMode';
  const MODES = ['llm', 'engine'];
  const LABELS = { llm: 'AI Server (LLM)', engine: 'Chess Engine (offline)' };

  function getMode() {
    const m = localStorage.getItem(MODE_KEY);
    return MODES.includes(m) ? m : 'llm';
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) return;
    localStorage.setItem(MODE_KEY, mode);
  }

  // Resolved lazily so script order between opponent files does not matter.
  function current() {
    return getMode() === 'engine' ? window.EngineOpponent : window.LlmOpponent;
  }

  window.ChessOpponents = { MODES, LABELS, getMode, setMode, current, label: (m) => LABELS[m] || m };
})();
