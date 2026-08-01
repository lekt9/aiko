# ARC-AGI-3 API + Agents SDK reference

Two ways to run, selected by `ARC_API_MODE` (see scripts/arc_client.py):

- **online** -> the live HTTP API at `https://three.arcprize.org`.
- **kaggle / offline** (DEFAULT) -> the local `arc_agi` engine, no key, no internet.

## Online HTTP API

Base: `https://three.arcprize.org`. Auth: header `X-API-Key: <key>` (get a key from
the ARC-AGI-3 website). All bodies are JSON.

| Step | Request | Returns |
|---|---|---|
| list games | `GET /api/games` | array of `game_id` (e.g. `sb26-7fbdac44`) |
| open scorecard | `POST /api/scorecard/open {tags:[...]}` | `{card_id}` |
| reset / start | `POST /api/cmd/RESET {game_id, card_id}` | frame (below) |
| act | `POST /api/cmd/ACTION1..7 {game_id, guid, card_id, x?, y?}` | frame |
| close scorecard | `POST /api/scorecard/close {card_id}` | final scores |

**Frame object** (the response to RESET and every ACTION):

```
{
  "guid": "...",                 # carry into the NEXT action (session token)
  "frame": [[...64 ints...] x64],# 64x64 grid, ints 0..15 (color indices, 0 = bg)
  "state": "NOT_FINISHED" | "WIN" | "GAME_OVER",
  "levels_completed": 1,         # was "score" before SDK v0.9.3
  "win_levels": 8,               # was "win_score"
  "available_actions": [5,6,7]   # which ACTIONs are valid this frame
}
```

- **Actions:** `ACTION1..ACTION5` are discrete inputs (semantics differ per game).
  `ACTION6` is a **click**: pass `x` (column) and `y` (row), both 0..63. `ACTION7`
  exists in some games. Only send actions listed in `available_actions`.
- **Progress** is `levels_completed`, not a numeric `score`. Many games never expose
  a `score` field at all; advancement shows up only in `levels_completed` / `state`.
- The `guid` rotates each action; always send the latest one back.

## Offline / Kaggle engine (`arc_agi`)

As of the Agents SDK v0.9.3, agents run locally via the `arc_agi` tool
(`github.com/arcprize/ARC-AGI`). No API key, no internet:

```python
import arc_agi
arc = arc_agi.Arcade(operation_mode=arc_agi.OperationMode.OFFLINE,
                     environments_dir="path/to/test_environment_files")
```

The toolkit ships `test_environment_files/` with real games (e.g. `bt11`, `bt33`).
On Kaggle the engine and games are preinstalled in the scoring image. The frame /
action contract matches the online one (same `levels_completed`, `available_actions`,
ACTION1..7 + click), so an agent written against the offline engine runs online
unchanged.

## Official Agents framework (github.com/arcprize/ARC-AGI-3-Agents)

Run online: `uv run main.py --agent=random --game=ls20` with `ARC_API_KEY` in `.env`.
Force the live API even with the offline tool installed: set `ONLINE_ONLY=True`.

Core types you implement against:

- `FrameData`: `levels_completed`, `win_levels`, `available_actions`, plus the grid.
- `GameAction`: `ACTION1`..`ACTION7` + click `(x, y)`.
- `Agent` base class: override **`choose_action(frames, latest_frame) -> GameAction`**
  and **`is_done(frames, latest_frame) -> bool`**. Sessions are auto-traced via
  `@trace_agent_session`. Optional `AGENTOPS_API_KEY` for observability.

Env vars: `ARC_API_KEY` (online), `ONLINE_ONLY` (force live), `AGENTOPS_API_KEY`
(optional). This skill adds `ARC_API_MODE` (kaggle|offline|online) and
`ARC_ENVIRONMENTS_DIR` (offline game folder) as the toggle layer on top.
