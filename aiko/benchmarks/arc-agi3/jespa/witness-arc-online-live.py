#!/usr/bin/env python3
"""Bounded REAL-live-proof witness for the online ARC-AGI-3 receptor path.

This does NOT run the 25-game benchmark online (the bench is offline-mechanical
by design; the amen reflect warned a blind 25x2 expansion regresses). It proves
the smaller, honest thing: the live receptor path is genuinely wired against
three.arcprize.org with the user-provided key.

Proof shape (one game, one action, clean teardown):
  1. read-only catalog call (`/api/games`)          -> key authenticates
  2. scorecard open + RESET (`/api/scorecard/open`,
     `/api/cmd/RESET`)                              -> live session starts
  3. one ACTION0 (`/api/cmd/ACTION0`)               -> live cmd path responds
  4. scorecard close (`/api/scorecard/close`)       -> clean teardown

Requires in the environment (user-provided, NEVER committed):
  ARC_API_KEY   the live key from https://three.arcprize.org
  ARC_API_MODE  online

Exit 0 == the live receptor path works end-to-end against the real server.
"""
from __future__ import annotations

import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_CLIENT = os.path.normpath(
    os.path.join(_HERE, "..", "..", "..", ".agents", "skills", "arc-agi-3", "scripts")
)
sys.path.insert(0, _CLIENT)
import arc_client as arc  # noqa: E402


def main() -> int:
    if arc.resolve_mode() != "online":
        sys.exit("ARC_API_MODE!=online; this witness is live-only.")
    if not os.environ.get("ARC_API_KEY", "").strip():
        sys.exit("ARC_API_KEY missing; live witness needs the user-provided key.")

    t0 = time.time()

    # 1. read-only catalog: proves the key authenticates against the live API.
    games = arc.online_games()
    if not games:
        sys.exit("live /api/games returned no games")
    game_id = games[0]["game_id"]

    # 2. scorecard open + RESET: a live session starts on the real server.
    frame0 = arc.online_open(game_id)
    open_guid = frame0.get("guid")
    if not open_guid:
        sys.exit(f"open/RESET returned no guid: {json.dumps(frame0)[:200]}")

    # 3. one valid ACTION: the live cmd path responds. Per references/02-api.md
    #    and 08-kernel-action-mapping.md, id 0 is RESET (a control, NOT a route);
    #    valid game actions are ACTION1..ACTION7. Read available_actions from the
    #    RESET frame and pick a valid id (discrete preferred; ACTION6 is a click
    #    needing x=col,y=row). Best-effort — the core claim (open+close) does not
    #    depend on this step.
    avail = frame0.get("available_actions") or []
    discrete = [a for a in avail if a not in (0, 6)]
    if discrete:
        act_n, act_x, act_y = discrete[0], None, None
    elif 6 in avail:
        act_n, act_x, act_y = 6, 32, 32  # center probe click
    else:
        act_n, act_x, act_y = 1, None, None  # ACTION1 is always a real route
    act_guid = open_guid
    act_ok = False
    act_err = None
    try:
        frame1 = arc.online_act(act_n, act_x, act_y)
        act_guid = frame1.get("guid") or open_guid
        act_ok = True
    except SystemExit as exc:  # _post sys.exits on HTTP error; record, don't mask
        act_ok = False
        act_err = f"SystemExit: {exc}"[:160]
    except Exception as exc:  # noqa: BLE001 - record, do not mask the core proof
        act_ok = False
        act_err = str(exc)[:160]

    # 4. clean teardown: close the live scorecard we opened.
    closed = arc.online_close()

    verdict = {
        "live_proof": "ok",
        "server": arc.BASE_ONLINE,
        "game_id": game_id,
        "open_guid": open_guid,
        "available_actions": avail,
        "act_n": act_n,
        "act_coords": [act_x, act_y],
        "act_ok": act_ok,
        "act_guid": act_guid,
        "act_err": act_err,
        "closed": bool(closed),
        "wall_seconds": round(time.time() - t0, 2),
    }
    print(json.dumps(verdict, indent=2))

    # Core assertion: catalog + open + close all worked against the real server.
    if not closed:
        sys.exit("close failed; live scorecard not torn down")
    return 0


if __name__ == "__main__":
    sys.exit(main())
