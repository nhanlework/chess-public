// The "AI Server (LLM)" opponent: builds a prompt describing the board,
// calls the configured provider, parses the reply, and falls back to a
// random legal move when the reply can't be parsed or the provider fails
// twice in a row. Runs both in the browser (window.LlmOpponent) and in
// Node (module.exports), so tests can exercise buildPrompt/parseAiMove
// without a DOM.

const DIFFICULTY_PROMPTS = {
  easy: 'You are role-playing as a 6-year-old child who just learned how to play chess. You play intuitively, making simple and obvious moves, rarely calculating ahead, and often missing clear captures or better options. You are not deliberately playing badly to lose on purpose — you are simply at a true beginner\'s skill level.',
  medium: 'You are role-playing as a 10-year-old child who has been playing chess for 2 years. You understand the rules and basic principles (piece development, controlling the center, king safety, reasonable trades), can calculate 1-2 moves ahead, but sometimes miss more complex tactics or multi-piece combinations.',
  hard: 'You are role-playing as a 15-year-old who has played chess seriously for 5 years, at a solid club-level strength. You calculate a few moves ahead, know how to use tactics (forks, pins, short mating attacks), and play with a clear strategy, but you are still a strong amateur, not a grandmaster.'
};

function buildPrompt(game, difficulty) {
  const pieces = game.listPieces();
  const describe = (list) => list.map(p => `${PIECE_NAMES[p.type]}(${p.type}) at ${p.square}`).join(', ') || '(no pieces)';
  const capturedList = (arr) => arr.map(t => PIECE_NAMES[t]).join(', ') || '(no pieces captured yet)';
  const describeMoves = (color) => {
    const moves = game.lastMoves(color, 5);
    if (!moves.length) return '(no moves yet)';
    return moves.map(m => `${PIECE_NAMES[m.piece]} (${m.color === 'w' ? 'White' : 'Black'}) from ${m.from} to ${m.to}${m.captured ? ', capturing ' + PIECE_NAMES[m.captured] : ''}`).join('; ');
  };

  return `You are playing a game of chess as BLACK, against a human player playing WHITE.
${DIFFICULTY_PROMPTS[difficulty]}

BOARD STATE (coordinates in a1-h8 format; rank 1 is White's side, rank 8 is Black's side):
- White pieces: ${describe(pieces.w)}
- Black pieces: ${describe(pieces.b)}

CAPTURED PIECES:
- White has lost: ${capturedList(game.captured.w)}
- Black has lost: ${capturedList(game.captured.b)}

LAST 5 MOVES BY WHITE: ${describeMoves('w')}
LAST 5 MOVES BY BLACK: ${describeMoves('b')}

Choose ONE legal move for Black. Move exactly one piece, following standard chess rules (no jumping over other pieces except for the Knight, no moving onto a square occupied by your own piece, etc).
Reply with ONLY a JSON block in exactly this format, with no other explanation outside the JSON block:

\`\`\`json
{"piece": "<piece letter: p, n, b, r, q, or k>", "from": "<origin square, e.g. e7>", "to": "<destination square, e.g. e5>", "promotion": null}
\`\`\`

If the move is a pawn promotion, set "promotion" to "q", "r", "b", or "n". Otherwise leave "promotion": null.`;
}

function parseAiMove(text) {
  // Try to find a JSON object in the text.
  const jsonMatch = text.match(/\{[\s\S]*?\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.from && obj.to) {
        return { from: String(obj.from).toLowerCase(), to: String(obj.to).toLowerCase(), promotion: obj.promotion || null };
      }
    } catch (e) { /* fall through to regex fallback */ }
  }
  // Fallback: look for a pattern like e7e5, e7-e5, e7 to e5.
  const m = text.match(/([a-h][1-8])\s*(?:-|to|→|>)?\s*([a-h][1-8])/i);
  if (m) return { from: m[1].toLowerCase(), to: m[2].toLowerCase(), promotion: null };
  return null;
}

function pickRandomMove(game, aiColor) {
  const options = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = game.board[r][c];
      if (p && p.color === aiColor) {
        const sq = rcToSq(r, c);
        for (const mv of game.generateMoves(sq)) {
          options.push({ from: sq, to: mv.to, promotion: null });
        }
      }
    }
  }
  if (!options.length) return null;
  return options[Math.floor(Math.random() * options.length)];
}

const LlmOpponent = {
  kind: 'llm',
  isReady: () => AiSettings.providerConfigured(),
  notReadyMessage: 'AI is not configured yet. Please open "AI Settings" to enter connection details.',
  thinkingText: () => (AiSettings.getSettings().provider === 'lmstudio'
    ? 'AI is thinking... (local models can take a while)'
    : 'AI is thinking...'),
  async requestMove(game, { difficulty, aiColor }) {
    const settings = AiSettings.getSettings();
    const prompt = buildPrompt(game, difficulty);
    let moveInfo = null;
    for (let attempt = 0; attempt < 2 && !moveInfo; attempt++) {
      // Network/auth errors propagate to the caller (it shows the Retry button).
      const text = await callAiProvider(settings.provider, AiSettings.currentProviderConfig(), prompt);
      AiSettings.updateConnIndicator('ok', 'Connected');
      AiSettings.markVerified();
      const parsed = parseAiMove(text);
      if (parsed) {
        const found = game.generateMoves(parsed.from).find(m => m.to === parsed.to);
        const piece = game.getPiece(parsed.from);
        if (found && piece && piece.color === aiColor) {
          moveInfo = { from: parsed.from, to: parsed.to, promotion: parsed.promotion, usedFallback: false };
        }
      }
    }
    if (moveInfo) return moveInfo;
    const rnd = pickRandomMove(game, aiColor);
    return rnd ? { ...rnd, usedFallback: true } : null;
  }
};

if (typeof module !== 'undefined') module.exports = { DIFFICULTY_PROMPTS, buildPrompt, parseAiMove, pickRandomMove };
if (typeof window !== 'undefined') window.LlmOpponent = LlmOpponent;
