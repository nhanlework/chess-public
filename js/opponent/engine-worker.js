// Runs the engine search off the main thread so the UI/3D scene stays smooth.
importScripts('../chess-engine.js', 'engine-search.js');

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'search') return;
  const t0 = Date.now();
  try {
    const move = ChessEngineSearch.searchBestMove(msg.state, { aiColor: msg.aiColor, difficulty: msg.difficulty });
    self.postMessage({ type: 'result', id: msg.id, move, info: { timeMs: Date.now() - t0 } });
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message || String(err) });
  }
};
