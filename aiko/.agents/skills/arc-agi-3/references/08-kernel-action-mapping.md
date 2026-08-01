# 08 - Kernel action mapping (our own, verified)

The one canonical mapping the Kaggle kernel marshals against. Synthesized from `/arc-agi-3`
(`references/02-api.md`, `03-gotchas.md`), `/arc-solve` (`aiko arc act <N> [x y]`), and `/aiko-arc`
(the glyph `center(x=col,y=row)` read), then verified against the official `ARC-AGI-3-Agents` tree
(`agents/templates/llm_agents.py` ACTION6 schema; `langgraph_thinking/tools.py` action Literals) and
the arcengine surface (`agents_stub/arcengine.py` mirrors the Kaggle-image `GameAction.from_id`).

The kernel's marshaller is `kaggle_seal/my_agent_aiko.py:_mk`. It is gated by
`scripts/witness_kernel_mapping.py` (exit 0 == this mapping holds). All three skills agree on every
fact below; there is no contradiction to reconcile.

## Action id space

The skill decides a neutral `(a, x, y)` tuple; `a` is the action id, marshalled by
`GameAction.from_id(a)`:

| id | GameAction | kind | coords | typical meaning (game-specific) |
|----|-----------|------|--------|---------------------------------|
| 0  | RESET     | control | none | start over / new level (the harness/Swarm owns RESET; the agent rarely emits it) |
| 1  | ACTION1   | discrete | none | often move up |
| 2  | ACTION2   | discrete | none | often move down |
| 3  | ACTION3   | discrete | none | often move left |
| 4  | ACTION4   | discrete | none | often move right |
| 5  | ACTION5   | discrete | none | game-specific (often select / submit) |
| 6  | ACTION6   | CLICK | x=col, y=row | click a cell at (column, row) |
| 7  | ACTION7   | discrete | none | game-specific (some games only) |

Discrete meanings are per-game and must be inferred, never assumed. Only emit an id present in the
frame's `available_actions`.

## The click convention (the most error-prone fact)

ACTION6 is the only coordinate action. Coordinates ride on `act.set_data({"x": col, "y": row})`:

- `x` is the COLUMN (horizontal, 0..63, left to right).
- `y` is the ROW (vertical, 0..63, top to bottom).
- Grid access is `frame[row][col]`, equivalently `frame[y][x]`.
- Both are 0-indexed and clamped to 0..63; a missing coord defaults to board-center 32.

x and y must never be transposed. The skill's `(a, x, y)` already carries x=col, y=row (the same
convention `arc_client.py` renders with), so `_mk` passes them straight through.

## Frame mapping

- `frame` is a list of 64x64 layers; unwrap to the LAST layer (`grid[-1]`) before reading cells.
- A transient non-64x64 frame (for example a `(0,)` frame mid-game, witnessed on `cn04`) is
  tolerated: keep emitting the in-flight action, do NOT reset (gotcha #4).
- Progress is `levels_completed`, NOT `score` (17/25 games never expose `score`). Never bail a
  replay or gate logic on a missing `score` (gotcha #2, #3).
- `state` is one of `NOT_FINISHED` | `WIN` | `GAME_OVER`.

## Harness contract

```
class MyAgent(Agent):
    def choose_action(self, frames, latest_frame) -> GameAction   # required; returns _mk(a,x,y)
    def is_done(self, frames, latest_frame) -> bool               # WIN/GAME_OVER, global deadline, stall-slice
```

`GameAction` and `GameState` import from `arcengine` (the Kaggle image), NOT `agents.structs`. The
agent never crashes a game: any organ error in `choose_action` degrades to a safe available action.

## What this mapping refuses

- A transposed click (y under "x"): the witness asserts x=col, y=row are not swapped.
- A coord that escapes 0..63: clamped, witnessed for both out-of-range and None.
- Coords on a non-ACTION6 action: only ACTION6 carries `.data`.
- Gating on `score`: read `levels_completed`.
- Resetting on a transient odd frame: keep the in-flight action.
