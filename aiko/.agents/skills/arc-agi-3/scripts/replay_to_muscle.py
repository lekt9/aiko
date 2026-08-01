#!/usr/bin/env python3
"""replay_to_muscle.py - learn the memory muscle by REPLAYING recorded games through /contract.

This is NOT supervised training on traces (the user's rule: "dont train on the traces"). Each
replayed WINNING transition is fired through select_sign.fire_reward - the native EBM train-on-fire
(C.train folds the frame into the per-action prototype; the jepa predictor learns frame->winner).
So the muscle learns the proper /contract way, by FIRING, not by gradient on raw bytes.

The recordings carry frames + levels_completed + state, but NOT the action taken (action_input.id is
always 0). The games that WON did so via the DETERMINISTIC planner (a pure function of the frame), so
we re-derive the winning action by replaying each winning-span frame back through the planner and fire
THAT. The resulting ledger ($HOME/.contracts/contracts.jsonl) IS the weights -> bundle it into the
dataset (kaggle_seal/muscle.jsonl) so the submitted notebook starts WARM with learned instinct.

Run:  HOME=<staging> python3 replay_to_muscle.py <server_recording_dir> [more_dirs...]
"""
import glob
import json
import os
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/bindings/python"))
import arc_skill as A  # noqa: E402
import select_sign as S  # noqa: E402


def cleared_spans(rows):
    """Indices that are WINNING frames - every frame in a span that ended in a level being cleared."""
    win, prev, start = set(), 0, 0
    for i, d in enumerate(rows):
        lc = d.get("levels_completed", 0) or 0
        if lc > prev:
            win.update(range(start, i + 1))
            prev, start = lc, i + 1
    return win


def _derive(grid, avail):
    """Re-derive the deterministic planner's next winning action for this frame (the organ that won
    it). Returns the action-json string, or None when no deterministic action applies (skip - never
    fire a guess)."""
    arch = A.classify(avail)
    plan = None
    try:
        if arch == "paint-to-match" and A._paint_plan is not None:
            plan = A._paint_plan(grid)
        elif arch == "region-control" and A._region_plan is not None:
            plan = A._region_plan(grid)
    except Exception:
        return None
    if plan and len(plan) > 0:
        a, x, y = plan[0]
        return ('{"a":%d,"x":%d,"y":%d}' % (a, x, y)) if a == 6 else ('{"a":%d}' % a)
    return None


def replay_game(path):
    rows = [json.loads(line)["data"] for line in open(path)]
    if not rows or (rows[-1].get("levels_completed", 0) or 0) < 1:
        return 0, 0  # nothing won here -> nothing to learn (the LLM-driven 0-level games are skipped)
    win = cleared_spans(rows)
    good = bad = 0
    for i, d in enumerate(rows):
        fo = SimpleNamespace(frame=d.get("frame"), available_actions=d.get("available_actions") or [],
                             levels_completed=d.get("levels_completed", 0), state=d.get("state", ""))
        grid = A.rows_of(fo)
        if grid is None:
            continue
        a = _derive(grid, fo.available_actions)
        if a is None:
            continue
        ft = A.frame_text(fo)
        if i in win:
            S.fire_reward(a, 1.0, good=True, frame=ft)
            good += 1
        elif d.get("state") == "GAME_OVER":
            S.fire_reward(a, 1.0, good=False, frame=ft)
            bad += 1
    return good, bad


def main():
    if not S._NATIVE:
        print("FAIL: native /contract engine not reachable - fire_reward would be a SILENT no-op "
              "(set PYTHONPATH to the real bindings dir; ~ is overridden when HOME is staged).")
        return 1
    dirs = sys.argv[1:] or ["."]
    files = []
    for d in dirs:
        files += sorted(glob.glob(os.path.join(d, "*.recording.jsonl")))
    games = tg = tb = 0
    for f in files:
        g, b = replay_game(f)
        if g or b:
            games += 1
            tg += g
            tb += b
            print(f"  replayed {os.path.basename(f)[:26]}: +{g} good / {b} bad fires")
    S.persist("arc")  # persist the jepa predictor head (EBM prototypes already in the ledger)
    led = os.path.expanduser("~/.contracts/contracts.jsonl")
    sz = os.path.getsize(led) if os.path.exists(led) else 0
    print(f"REPLAY_MUSCLE: {games} winning games -> {tg} good + {tb} bad fires; "
          f"muscle ledger {sz} bytes at {led}")
    print("REPLAY_MUSCLE_OK" if tg > 0 else "FAIL: no winning transitions learned")
    return 0 if tg > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
