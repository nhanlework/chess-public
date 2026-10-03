# Chess vs AI

A browser chess game with a simplified rule set, playable against either a remote LLM
("AI Server") or an offline JS chess engine. Two front ends share the same game logic and
save format:

- **2D** (`2d.html`) — the original flat-board UI.
- **3D** (`index.html`, the default page) — a Babylon.js scene with animated procedural characters standing in
  for the pieces, capture cinematics, camera controls, and a drop-in `.glb` model pipeline.

Saves are cross-compatible: a game saved from 2D can be loaded in 3D and vice versa.

## Running it

No build step. Serve the repo root with any static file server, for example:

```sh
python3 -m http.server 8743
```

Then open:
- 3D (default): http://localhost:8743/ (or `/index.html`)
- 2D: http://localhost:8743/2d.html

Each page also links to the other ("🧊 3D Version" / "▦ 2D Version").

## Opponent modes

Both versions share the same opponent dropdown (`chessOpponentMode` in `localStorage`):

- **AI Server (LLM)** — sends the board state to a configured LLM endpoint (OpenAI-compatible,
  Gemini, or LM Studio) and parses its move. Configure this under "AI Settings" in either
  version (API key/base URL, model, or a linked `ai-config.json` file). Default mode, for
  backward compatibility with existing users.
- **Chess Engine (offline)** — a JS minimax/alpha-beta engine (with quiescence search and
  iterative deepening) that runs in a Web Worker, no network or API key required. Three
  difficulties: Easy, Medium, Hard. Easy intentionally doesn't "know" the checkmate rule
  described below, so newer players can still win.

Both the 2D and 3D UIs use the same simplified end-game rule: a side wins by literally capturing
the opponent's king, by delivering real checkmate (opponent's king is attacked and has no move —
of its own king or a piece — that gets it out of attack), or when the opponent has no legal move
at all. A bare check does **not** end the game — the checked side always gets its turn to respond
(move the king, block, or capture the attacker) before anything is decided. There is no draw/
stalemate concept: a side with zero legal moves loses (even if its king isn't in check).

## Adding your own 3D character models

The 3D version can replace any of the 6 built-in procedural characters (Soldier, Knight,
Bishop, Golem, Queen, King) with your own animated `.glb` model. See
[`assets/models/README.md`](assets/models/README.md) for the file requirements and the
`assets/models/models.json` manifest schema. Leaving an entry `null` keeps the built-in
procedural character; a broken or missing model file falls back to it automatically.

## Tests

```sh
node tests/run-all.js
```

Runs the offline-engine test suite (`tests/engine-search.test.js`) and the LLM-prompt golden
test (`tests/llm-prompt.test.js`, byte-identical prompt output vs. the pre-refactor baseline).

Dev/manual test pages under `tests/browser/` (open directly against the same static server,
no auto-run):
- `tests/browser/engine-check.html` — exercises the offline engine at each difficulty and
  reports whether the Worker or main-thread fallback path was used.
- `tests/browser/effects-sandbox.html` — triggers each 3D particle effect and camera
  cinematic preset in isolation.
- `tests/browser/king-sandbox.html` — close-up of the king: throne, rise/walk/sit, the triple
  sword slash with light trails, and the slump + rising-soul death.
- `tests/browser/queen-sandbox.html` — close-up of the queen: face/hair views, the slow
  flight in her aura, the meteor-shower + volcano attack, and the shadow-dragon death.
- `tests/browser/glb-sandbox.html` — loads a custom/temporary GLB manifest (via a `?manifest=`
  query param) to test drop-in models without touching the real `assets/models/models.json`.

## Debug inspector

Append `?debug=1` to `index.html`'s URL to load the Babylon.js inspector bundle and enable a
`window.__chess3d` debug hook (piece counts, `forceMove`, `autoplay(n)` for scripted
self-play, FPS reporting). Press **F9** to toggle the inspector panel once loaded.

## Project docs

- [`docs/PLAN-3D-CHESS.md`](docs/PLAN-3D-CHESS.md) — the original build plan (architecture,
  phases, decisions).
- [`docs/IMPLEMENTATION-NOTES.md`](docs/IMPLEMENTATION-NOTES.md) — deviations from the plan,
  measured performance, known issues, and possible next steps, consolidated from every work
  package's handoff.
