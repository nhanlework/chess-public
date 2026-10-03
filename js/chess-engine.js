// Simplified chess rules engine.
// Deliberately does NOT forbid moving into/leaving your king in check (no
// legal-move filtering during normal generateMoves/rawMovesRC). End-of-game
// is decided by literal king capture, by a side having zero legal moves at
// all, or by real checkmate (see isCheckmate()) — never by a bare check that
// the checked side hasn't had a turn to respond to (see app.js).

const FILES = 'abcdefgh';

function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function rcToSq(r, c) {
  return FILES[c] + (8 - r);
}

function sqToRc(sq) {
  const c = FILES.indexOf(sq[0]);
  const r = 8 - parseInt(sq[1], 10);
  return [r, c];
}

const PIECE_NAMES = {
  p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King'
};

class ChessGame {
  constructor() {
    this.board = ChessGame.initialBoard();
    this.turn = 'w';
    this.castling = { wK: true, wQ: true, bK: true, bQ: true };
    this.enPassant = null; // {r,c} square that can be captured to
    this.captured = { w: [], b: [] }; // pieces captured, keyed by the color that WAS captured
    this.history = []; // {piece,color,from,to,captured,castle,enPassant,promotion}
    this.moveCount = 0;
  }

  static initialBoard() {
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    for (let c = 0; c < 8; c++) {
      board[0][c] = { type: back[c], color: 'b', moved: false };
      board[1][c] = { type: 'p', color: 'b', moved: false };
      board[6][c] = { type: 'p', color: 'w', moved: false };
      board[7][c] = { type: back[c], color: 'w', moved: false };
    }
    return board;
  }

  clone() {
    const g = new ChessGame();
    g.board = this.board.map(row => row.map(p => (p ? { ...p } : null)));
    g.turn = this.turn;
    g.castling = { ...this.castling };
    g.enPassant = this.enPassant ? { ...this.enPassant } : null;
    g.captured = { w: [...this.captured.w], b: [...this.captured.b] };
    g.history = this.history.map(h => ({ ...h }));
    g.moveCount = this.moveCount;
    return g;
  }

  getPiece(sq) {
    const [r, c] = sqToRc(sq);
    return this.board[r][c];
  }

  findKing(color) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (p && p.type === 'k' && p.color === color) return rcToSq(r, c);
      }
    }
    return null;
  }

  // Raw destination squares a piece on (r,c) could move/capture to,
  // ignoring whose turn it is. Used both for move generation and for
  // "is this square attacked" checks.
  rawMovesRC(r, c, opts) {
    const piece = this.board[r][c];
    if (!piece) return [];
    const { color, type } = piece;
    const moves = [];
    const attackOnly = opts && opts.attackOnly;

    const pushIfOk = (nr, nc, captureRequired) => {
      if (!inBounds(nr, nc)) return false;
      const target = this.board[nr][nc];
      if (!target) {
        if (!captureRequired) moves.push({ r: nr, c: nc, capture: false });
        return true; // empty, sliding can continue
      }
      if (target.color !== color) {
        moves.push({ r: nr, c: nc, capture: true });
      }
      return false; // blocked, sliding stops
    };

    if (type === 'p') {
      const dir = color === 'w' ? -1 : 1;
      const startRow = color === 'w' ? 6 : 1;
      const promRow = color === 'w' ? 0 : 7;
      if (!attackOnly) {
        const oneR = r + dir;
        if (inBounds(oneR, c) && !this.board[oneR][c]) {
          moves.push({ r: oneR, c, capture: false, promotion: oneR === promRow });
          const twoR = r + 2 * dir;
          if (r === startRow && !this.board[twoR][c]) {
            moves.push({ r: twoR, c, capture: false, doubleStep: true });
          }
        }
      }
      for (const dc of [-1, 1]) {
        const nr = r + dir, nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const target = this.board[nr][nc];
        if (attackOnly) {
          moves.push({ r: nr, c: nc, capture: true });
        } else if (target && target.color !== color) {
          moves.push({ r: nr, c: nc, capture: true, promotion: nr === promRow });
        } else if (!target && this.enPassant && this.enPassant.r === nr && this.enPassant.c === nc) {
          moves.push({ r: nr, c: nc, capture: true, enPassant: true });
        }
      }
      return moves;
    }

    if (type === 'n') {
      const offsets = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
      for (const [dr, dc] of offsets) {
        const nr = r + dr, nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const target = this.board[nr][nc];
        if (!target || target.color !== color) moves.push({ r: nr, c: nc, capture: !!target });
      }
      return moves;
    }

    if (type === 'k') {
      const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      for (const [dr, dc] of offsets) {
        const nr = r + dr, nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const target = this.board[nr][nc];
        if (!target || target.color !== color) moves.push({ r: nr, c: nc, capture: !!target });
      }
      if (!attackOnly && !piece.moved) {
        // Castling: king & rook unmoved, squares between empty.
        // (Simplified: does not forbid castling through/into attack.)
        const row = color === 'w' ? 7 : 0;
        const kingSide = this.castling[color + 'K'];
        const queenSide = this.castling[color + 'Q'];
        if (kingSide && !this.board[row][5] && !this.board[row][6]) {
          const rook = this.board[row][7];
          if (rook && rook.type === 'r' && !rook.moved) {
            moves.push({ r: row, c: 6, capture: false, castle: 'K' });
          }
        }
        if (queenSide && !this.board[row][1] && !this.board[row][2] && !this.board[row][3]) {
          const rook = this.board[row][0];
          if (rook && rook.type === 'r' && !rook.moved) {
            moves.push({ r: row, c: 2, capture: false, castle: 'Q' });
          }
        }
      }
      return moves;
    }

    // Sliding pieces
    let dirs = [];
    if (type === 'b') dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    if (type === 'r') dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    if (type === 'q') dirs = [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (inBounds(nr, nc)) {
        const target = this.board[nr][nc];
        if (!target) {
          moves.push({ r: nr, c: nc, capture: false });
        } else {
          if (target.color !== color) moves.push({ r: nr, c: nc, capture: true });
          break;
        }
        nr += dr; nc += dc;
      }
    }
    return moves;
  }

  // Legal (pseudo-legal, per simplified ruleset) destination moves for the
  // piece on `sq`, respecting whose turn it is.
  generateMoves(sq) {
    const [r, c] = sqToRc(sq);
    const piece = this.board[r][c];
    if (!piece || piece.color !== this.turn) return [];
    return this.rawMovesRC(r, c).map(m => ({ ...m, to: rcToSq(m.r, m.c) }));
  }

  // Set of squares attacked by `color`, ignoring turn.
  attackedSquares(color) {
    const set = new Set();
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (p && p.color === color) {
          for (const m of this.rawMovesRC(r, c, { attackOnly: true })) {
            set.add(rcToSq(m.r, m.c));
          }
        }
      }
    }
    return set;
  }

  canCaptureKing(byColor) {
    const oppColor = byColor === 'w' ? 'b' : 'w';
    const kingSq = this.findKing(oppColor);
    if (!kingSq) return true; // king already gone
    return this.attackedSquares(byColor).has(kingSq);
  }

  // Is `color`'s king currently attacked by the opponent?
  inCheck(color) {
    const oppColor = color === 'w' ? 'b' : 'w';
    const kingSq = this.findKing(color);
    if (!kingSq) return false;
    return this.attackedSquares(oppColor).has(kingSq);
  }

  // Does `color` have at least one move that gets its own king out of attack?
  // (Simulates every pseudo-legal move for `color`; this engine otherwise
  // allows moving into/staying in check, so this is only used to decide
  // checkmate, not to restrict normal move generation.)
  hasLegalEscape(color) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (!p || p.color !== color) continue;
        const fromSq = rcToSq(r, c);
        for (const m of this.rawMovesRC(r, c)) {
          const clone = this.clone();
          clone.turn = color;
          const res = clone.makeMove(fromSq, rcToSq(m.r, m.c), 'q');
          if (res && !clone.inCheck(color)) return true;
        }
      }
    }
    return false;
  }

  // Real checkmate: `color`'s king is in check right now AND no move escapes it.
  // A mere check (opponent could capture the king next turn but hasn't been
  // given the chance to respond) is NOT checkmate.
  isCheckmate(color) {
    return this.inCheck(color) && !this.hasLegalEscape(color);
  }

  makeMove(fromSq, toSq, promotion) {
    const moves = this.generateMoves(fromSq);
    const move = moves.find(m => m.to === toSq);
    if (!move) return null;

    const [fr, fc] = sqToRc(fromSq);
    const [tr, tc] = sqToRc(toSq);
    const piece = this.board[fr][fc];
    const color = piece.color;
    let capturedPiece = null;

    if (move.enPassant) {
      const capR = fr; // captured pawn sits on the same row as the mover, target column
      capturedPiece = this.board[capR][tc];
      this.board[capR][tc] = null;
    } else if (this.board[tr][tc]) {
      capturedPiece = this.board[tr][tc];
    }

    if (capturedPiece) {
      this.captured[capturedPiece.color].push(capturedPiece.type);
    }

    this.board[tr][tc] = piece;
    this.board[fr][fc] = null;
    piece.moved = true;

    if (move.castle) {
      const row = fr;
      if (move.castle === 'K') {
        const rook = this.board[row][7];
        this.board[row][5] = rook;
        this.board[row][7] = null;
        if (rook) rook.moved = true;
      } else {
        const rook = this.board[row][0];
        this.board[row][3] = rook;
        this.board[row][0] = null;
        if (rook) rook.moved = true;
      }
    }

    let didPromote = false;
    if (move.promotion) {
      const promoType = ['q', 'r', 'b', 'n'].includes(promotion) ? promotion : 'q';
      piece.type = promoType;
      didPromote = true;
    }

    if (piece.type === 'k') {
      this.castling[color + 'K'] = false;
      this.castling[color + 'Q'] = false;
    }
    if (piece.type === 'r') {
      if (fr === (color === 'w' ? 7 : 0) && fc === 0) this.castling[color + 'Q'] = false;
      if (fr === (color === 'w' ? 7 : 0) && fc === 7) this.castling[color + 'K'] = false;
    }
    // If a rook gets captured on its home square, lose that castling right too.
    if (capturedPiece && capturedPiece.type === 'r') {
      const oppColor = color === 'w' ? 'b' : 'w';
      const homeRow = oppColor === 'w' ? 7 : 0;
      if (tr === homeRow && tc === 0) this.castling[oppColor + 'Q'] = false;
      if (tr === homeRow && tc === 7) this.castling[oppColor + 'K'] = false;
    }

    this.enPassant = move.doubleStep ? { r: (fr + tr) / 2, c: fc } : null;

    const histEntry = {
      piece: piece.type,
      color,
      from: fromSq,
      to: toSq,
      captured: capturedPiece ? capturedPiece.type : null,
      castle: move.castle || null,
      enPassant: !!move.enPassant,
      promotion: didPromote ? piece.type : null
    };
    this.history.push(histEntry);
    this.moveCount++;

    this.turn = this.turn === 'w' ? 'b' : 'w';

    return {
      captured: capturedPiece,
      castle: move.castle || null,
      enPassant: !!move.enPassant,
      promotion: didPromote,
      history: histEntry
    };
  }

  // Snapshot of all pieces on the board, for prompting the AI.
  listPieces() {
    const list = { w: [], b: [] };
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const p = this.board[r][c];
        if (p) list[p.color].push({ type: p.type, square: rcToSq(r, c) });
      }
    }
    return list;
  }

  lastMoves(color, n) {
    return this.history.filter(h => h.color === color).slice(-n);
  }
}

if (typeof module !== 'undefined') module.exports = { ChessGame, PIECE_NAMES, sqToRc, rcToSq };
