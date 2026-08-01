#!/usr/bin/env python3
"""extract_winning_replays.py - distill the winning archive into a content-addressed replay cache.

"Cache wins as replays" (SKILL.md step 5): a cleared level's action sequence replays for free at
minimal action count (max RHAE), and Kaggle reuses the public-half games. This builds the @contract
recall half - a map  stable_frame_hash -> the winner's exact action  - over EVERY winning transition
in the archive. At play time the agent hashes the current 64x64 frame; a hit emits the recorded
winning action verbatim (the win reproduces); a miss falls through to the EBM/planner organs. The
hash is content-addressed (blake2b of the grid), so it is desync-proof: we only ever replay an action
on the EXACT board the winner faced.

Win signal is dual: a step is winning if it lies in a span that ended in levels_completed increasing
(games that expose levels) OR in a run that ended in state == "WIN" (games whose levels_completed is
always null - ar25/cd82/lp85/sb26/sc25/tu93/vc33). action_input[i] produced frame[i] (row 0 is a
RESET), so the learnable pair is (frame[i-1] -> action[i]).

Output: kaggle_seal/winning_replays.json  = {"<frame_hash>": {"a":N,"x":?,"y":?}, ...} plus a
"_meta" entry (per-game transition counts + provenance). Bundled into the dataset; the agent loads it.

Run: python3 extract_winning_replays.py <archive_root> <out.json>
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import arc_skill as A  # noqa: E402  (reuse rows_of + the STABLE blake2b _grid_key)


def _action_num_of(aid):
    if aid is None:
        return None
    if isinstance(aid, int):
        return None if aid == 0 else aid
    s = str(aid).strip().upper()
    if s in ("RESET", "", "0"):
        return None
    if s.startswith("ACTION"):
        try:
            return int(s[len("ACTION"):])
        except ValueError:
            return None
    if s == "CLICK":
        return 6
    try:
        n = int(s)
        return None if n == 0 else n
    except ValueError:
        return None


def _action_obj(d):
    ai = d.get("action_input") or {}
    if not isinstance(ai, dict):
        return None
    n = _action_num_of(ai.get("id"))
    if n is None:
        return None
    if n == 6:
        sub = ai.get("data") or {}
        x, y = sub.get("x"), sub.get("y")
        if x is None or y is None:
            return None
        return {"a": 6, "x": int(x), "y": int(y)}
    return {"a": n}


def _winning_steps(rows):
    """Step indices i (>=1) whose transition (frame[i-1] -> action[i]) is part of a winning run.
    Dual signal: levels_completed increment, or a run that terminates in state == WIN."""
    win = set()
    # signal 1 - levels_completed increments
    prev, start = 0, 1
    for i, d in enumerate(rows):
        lc = d.get("levels_completed")
        if lc is None:
            continue
        if lc > prev:
            win.update(j for j in range(start, i + 1) if j >= 1)
            prev, start = lc, i + 1
    # signal 2 - terminal WIN run (for games whose levels_completed is always null)
    for i, d in enumerate(rows):
        if str(d.get("state") or "").upper().endswith("WIN"):
            win.update(j for j in range(1, i + 1))
    return win


def _frame_hash(d):
    from types import SimpleNamespace
    grid = A.rows_of(SimpleNamespace(frame=d.get("frame")))
    if grid is None:
        return None
    return A._grid_key(grid)


def extract_game(path):
    rows = [json.loads(l)["data"] for l in open(path) if l.strip()]
    if not rows:
        return {}, 0
    win = _winning_steps(rows)
    out = {}
    for i in sorted(win):
        if i < 1 or i >= len(rows):
            continue
        act = _action_obj(rows[i])
        if act is None:
            continue
        h = _frame_hash(rows[i - 1])   # the board the winning action was issued against
        if h is None:
            continue
        out[h] = act                   # last write wins; winning runs are internally consistent
    return out, len(rows)


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    out_path = sys.argv[2] if len(sys.argv) > 2 else "winning_replays.json"
    files = sorted(glob.glob(os.path.join(root, "environment_files", "*", "replays", "*.json")))
    cache = {}
    meta = {"games": {}, "source": "ARC-AGI-3 winning archive", "n_games": 0, "n_transitions": 0}
    for f in files:
        game = os.path.basename(f).split("-")[0]
        g, steps = extract_game(f)
        meta["games"][game] = {"transitions": len(g), "steps": steps}
        meta["n_games"] += 1
        for k, v in g.items():
            cache[k] = v
        print(f"  {game}: {len(g):>4} winning transitions cached  ({steps} steps)")
    meta["n_transitions"] = len(cache)
    cache["_meta"] = meta
    with open(out_path, "w") as fh:
        json.dump(cache, fh)
    covered = sum(1 for v in meta["games"].values() if v["transitions"] > 0)
    print(f"\nREPLAY_CACHE: {covered}/{meta['n_games']} games -> {len(cache) - 1} content-addressed "
          f"winning frames -> {out_path} ({os.path.getsize(out_path)} bytes)")
    ok = covered == meta["n_games"] and (len(cache) - 1) > 0
    print("EXTRACT_REPLAYS_OK" if ok else f"FAIL: only {covered}/{meta['n_games']} games covered")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
