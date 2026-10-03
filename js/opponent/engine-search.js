// Offline chess engine search (negamax + alpha-beta + quiescence).
// No DOM, no `window` dependency: works in a Worker, in Node (tests), or on
// the main thread. Uses the global `ChessGame`, `rcToSq`, `sqToRc` from
// chess-engine.js (loaded via importScripts/<script>/require before this file).
(function (root) {
  'use strict';

  // --- 7.1.1 Piece values & piece-square tables (Simplified Evaluation Function). ---
  // Tables are written from White's point of view, index r*8+c with r=0 = rank 8
  // (matches board[r][c]). White pieces use PST[type][r*8+c]; Black pieces use
  // PST[type][(7-r)*8+c].
  const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
  const PST = {
    p: [
       0,  0,  0,  0,  0,  0,  0,  0,
      50, 50, 50, 50, 50, 50, 50, 50,
      10, 10, 20, 30, 30, 20, 10, 10,
       5,  5, 10, 25, 25, 10,  5,  5,
       0,  0,  0, 20, 20,  0,  0,  0,
       5, -5,-10,  0,  0,-10, -5,  5,
       5, 10, 10,-20,-20, 10, 10,  5,
       0,  0,  0,  0,  0,  0,  0,  0],
    n: [
     -50,-40,-30,-30,-30,-30,-40,-50,
     -40,-20,  0,  0,  0,  0,-20,-40,
     -30,  0, 10, 15, 15, 10,  0,-30,
     -30,  5, 15, 20, 20, 15,  5,-30,
     -30,  0, 15, 20, 20, 15,  0,-30,
     -30,  5, 10, 15, 15, 10,  5,-30,
     -40,-20,  0,  5,  5,  0,-20,-40,
     -50,-40,-30,-30,-30,-30,-40,-50],
    b: [
     -20,-10,-10,-10,-10,-10,-10,-20,
     -10,  0,  0,  0,  0,  0,  0,-10,
     -10,  0,  5, 10, 10,  5,  0,-10,
     -10,  5,  5, 10, 10,  5,  5,-10,
     -10,  0, 10, 10, 10, 10,  0,-10,
     -10, 10, 10, 10, 10, 10, 10,-10,
     -10,  5,  0,  0,  0,  0,  5,-10,
     -20,-10,-10,-10,-10,-10,-10,-20],
    r: [
       0,  0,  0,  0,  0,  0,  0,  0,
       5, 10, 10, 10, 10, 10, 10,  5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
      -5,  0,  0,  0,  0,  0,  0, -5,
       0,  0,  0,  5,  5,  0,  0,  0],
    q: [
     -20,-10,-10, -5, -5,-10,-10,-20,
     -10,  0,  0,  0,  0,  0,  0,-10,
     -10,  0,  5,  5,  5,  5,  0,-10,
      -5,  0,  5,  5,  5,  5,  0, -5,
       0,  0,  5,  5,  5,  5,  0, -5,
     -10,  5,  5,  5,  5,  5,  0,-10,
     -10,  0,  5,  0,  0,  0,  0,-10,
     -20,-10,-10, -5, -5,-10,-10,-20],
    k: [
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -30,-40,-40,-50,-50,-40,-40,-30,
     -20,-30,-30,-40,-40,-30,-30,-20,
     -10,-20,-20,-20,-20,-20,-20,-10,
      20, 20,  0,  0,  0,  0, 20, 20,
      20, 30, 10,  0,  0, 10, 30, 20]
  };

  // --- 7.1.2 Difficulty configuration. ---
  const DIFFICULTY = {
    //            maxDepth  timeMs  rootNoise  randomMoveChance  quiescence  knowsCheckRule
    easy:   { maxDepth: 1, timeMs: 300,  rootNoise: 120, randomMoveChance: 0.25, quiescence: false, knowsCheckRule: false },
    medium: { maxDepth: 3, timeMs: 1200, rootNoise: 25,  randomMoveChance: 0.05, quiescence: true,  knowsCheckRule: true  },
    hard:   { maxDepth: 5, timeMs: 3000, rootNoise: 0,   randomMoveChance: 0,    quiescence: true,  knowsCheckRule: true  }
  };

  // --- 7.1.3 Helper functions. ---
  const WIN = 1000000;
  const TIMEOUT = { timeout: true };

  // Fast copy without history (ChessGame.clone() copies history and is too slow for search).
  function fromState(s) {
    const g = Object.create(ChessGame.prototype);
    g.board = s.board.map(row => row.map(p => (p ? { type: p.type, color: p.color, moved: p.moved } : null)));
    g.turn = s.turn;
    g.castling = { ...s.castling };
    g.enPassant = s.enPassant ? { ...s.enPassant } : null;
    g.captured = { w: [], b: [] };
    g.history = [];
    g.moveCount = 0;
    return g;
  }

  function allMoves(g) {
    const out = [];
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = g.board[r][c];
        if (!p || p.color !== g.turn) continue;
        for (const m of g.rawMovesRC(r, c)) {
          const victim = m.capture ? (m.enPassant ? 'p' : g.board[m.r][m.c].type) : null;
          out.push({ from: rcToSq(r, c), to: rcToSq(m.r, m.c), piece: p.type, victim, promotion: !!m.promotion });
        }
      }
    }
    return out;
  }

  // MVV-LVA: most valuable victim first, then cheapest attacker; promotions early.
  function orderScore(m) {
    let s = 0;
    if (m.victim) s += 100000 + 10 * VALUE[m.victim] - VALUE[m.piece];
    if (m.promotion) s += 80000;
    return s;
  }
  function orderMoves(moves, firstMove) {
    return moves
      .map(m => ({ m, s: (firstMove && m.from === firstMove.from && m.to === firstMove.to) ? 1e9 : orderScore(m) }))
      .sort((a, b) => b.s - a.s)
      .map(x => x.m);
  }

  function applyMove(g, m) {
    const next = fromState(g);
    const res = next.makeMove(m.from, m.to, m.promotion ? 'q' : null);
    return { next, res };
  }

  // Asymmetric game-end rules copied from app.js:
  //  - capturing a king wins for whoever captured it
  //  - after the AI's move, if that move checkmates the human (real
  //    checkmate: king in check with no escape, not just a bare check the
  //    human hasn't had a turn to answer yet), the AI wins
  function moverWins(res, next, mover, ctx) {
    if (res.captured && res.captured.type === 'k') return true;
    if (ctx.knowsCheckRule && mover === ctx.aiColor && next.isCheckmate(next.turn)) return true;
    return false;
  }

  // Static eval from the side-to-move's perspective.
  function evaluate(g) {
    let s = 0;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = g.board[r][c];
        if (!p) continue;
        const idx = p.color === 'w' ? r * 8 + c : (7 - r) * 8 + c;
        const v = VALUE[p.type] + PST[p.type][idx];
        s += p.color === 'w' ? v : -v;
      }
    }
    return g.turn === 'w' ? s : -s;
  }

  // --- 7.1.4 Search. ---
  function checkTime(ctx) {
    ctx.nodes++;
    if (ctx.canAbort && (ctx.nodes & 1023) === 0 && Date.now() > ctx.deadline) throw TIMEOUT;
  }

  function negamax(g, depth, alpha, beta, ply, ctx) {
    checkTime(ctx);
    if (depth <= 0) return ctx.quiescence ? quiesce(g, alpha, beta, ply, 0, ctx) : evaluate(g);
    const moves = orderMoves(allMoves(g));
    if (!moves.length) return -(WIN - ply);            // side to move is stuck → loses
    let best = -Infinity;
    for (const m of moves) {
      const { next, res } = applyMove(g, m);
      if (!res) continue;
      const score = moverWins(res, next, g.turn, ctx)
        ? WIN - ply - 1
        : -negamax(next, depth - 1, -beta, -alpha, ply + 1, ctx);
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  const MAX_QDEPTH = 6;
  function quiesce(g, alpha, beta, ply, qd, ctx) {
    checkTime(ctx);
    const stand = evaluate(g);
    if (stand >= beta || qd >= MAX_QDEPTH) return stand;
    if (stand > alpha) alpha = stand;
    const moves = orderMoves(allMoves(g).filter(m => m.victim || m.promotion));
    for (const m of moves) {
      const { next, res } = applyMove(g, m);
      if (!res) continue;
      const score = moverWins(res, next, g.turn, ctx)
        ? WIN - ply - 1
        : -quiesce(next, -beta, -alpha, ply + 1, qd + 1, ctx);
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  // opts: { aiColor, difficulty, rng?: () => number, timeMsOverride?: number }
  // returns { from, to, promotion, score, depth, nodes } or null if no moves.
  function searchBestMove(state, opts) {
    const cfg = DIFFICULTY[opts.difficulty] || DIFFICULTY.medium;
    const rng = opts.rng || Math.random;
    const g = fromState(state);
    const rootMoves = allMoves(g).filter(m => applyMove(g, m).res);
    if (!rootMoves.length) return null;

    const toResult = (m, extra) => ({ from: m.from, to: m.to, promotion: m.promotion ? 'q' : null, ...extra });

    if (rng() < cfg.randomMoveChance) {
      return toResult(rootMoves[Math.floor(rng() * rootMoves.length)], { score: 0, depth: 0, nodes: 0, random: true });
    }

    const ctx = {
      aiColor: opts.aiColor,
      knowsCheckRule: cfg.knowsCheckRule,
      quiescence: cfg.quiescence,
      deadline: Date.now() + (opts.timeMsOverride || cfg.timeMs),
      nodes: 0,
      canAbort: false
    };

    let bestMove = orderMoves(rootMoves)[0];
    let bestScore = -Infinity;
    let completedDepth = 0;

    for (let depth = 1; depth <= cfg.maxDepth; depth++) {
      ctx.canAbort = depth > 1;                         // depth 1 always completes
      try {
        const ordered = orderMoves(rootMoves, bestMove);
        let alpha = -Infinity;
        let iterBest = null, iterBestScore = -Infinity;
        for (const m of ordered) {
          const { next, res } = applyMove(g, m);
          let score;
          if (moverWins(res, next, g.turn, ctx)) {
            score = WIN - 1;
          } else {
            // With noise we need real scores for every root move → full window.
            const a = cfg.rootNoise > 0 ? -Infinity : alpha;
            score = -negamax(next, depth - 1, -Infinity, -a, 1, ctx);
          }
          const isDecisive = Math.abs(score) >= WIN - 1000;
          const noisy = isDecisive ? score : score + (rng() * 2 - 1) * cfg.rootNoise;
          if (noisy > iterBestScore) { iterBestScore = noisy; iterBest = m; }
          if (score > alpha) alpha = score;
        }
        bestMove = iterBest;
        bestScore = iterBestScore;
        completedDepth = depth;
        if (bestScore >= WIN - 1000) break;             // found a forced win
      } catch (e) {
        if (e !== TIMEOUT) throw e;
        break;                                          // keep result of last completed depth
      }
    }
    return toResult(bestMove, { score: bestScore, depth: completedDepth, nodes: ctx.nodes });
  }

  const api = { searchBestMove, evaluate, allMoves, DIFFICULTY, VALUE, fromState };
  root.ChessEngineSearch = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
