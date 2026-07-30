#!/usr/bin/env python3
"""winning_replay_to_muscle.py - preserve the WINNING ARCHIVE as native EBM weights (train-on-fire).

The replay cache (extract_winning_replays.py) is the @contract RECALL half - exact moves on seen
boards. This is the GENERALIZATION half: fire the winner's REAL recorded actions through
select_sign.fire_reward so the native EBM good/bad prototypes + the per-action proposer + the jepa
predictor learn "frames like this -> this winning action". The ledger ($HOME/.contracts/contracts.jsonl)
IS the EBM weights. Not gradient-on-bytes ("dont train on the traces") - learning by FIRING.

DECISIVE mode (default): fire only the last K transitions of each winning run (the decisive run-up to
the clear / WIN), not every wasted click. This keeps the muscle FOCUSED and SMALL - a bloated ledger
makes every kernel step O(n^2) on the ledger scan and threatens the 8h budget. Win signal is dual
(levels_completed increment OR state->WIN) via the shared logic in extract_winning_replays.

--warm  <muscle.jsonl>  : restore a prior ledger to $HOME/.contracts BEFORE firing (COMPOUND).
--seal-muscle <out>     : harvest the trained ledger to <out> AFTER firing (the dataset artifact).
--decisive K            : transitions per winning run to fire (default 16; 0 = all).
--report <out.json>     : write the per-game fire report.

Run: HOME=<stage> python3 winning_replay_to_muscle.py <archive_root> --warm muscle.jsonl \
        --seal-muscle muscle.jsonl --decisive 16 --report winning_muscle.report.json
"""
import glob
import json
import os
import shutil
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/bindings/python"))
import arc_skill as A  # noqa: E402
import select_sign as S  # noqa: E402
from extract_winning_replays import _winning_steps, _action_obj  # the shared dual-signal win logic


def _arg(flag, default=None):
    return sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else default


def _decisive_steps(rows, win, k):
    """Keep, per contiguous winning run, only the last k step indices (the decisive run-up). k<=0 -> all."""
    if k <= 0:
        return sorted(win)
    runs, cur = [], []
    for i in sorted(win):
        if cur and i != cur[-1] + 1:
            runs.append(cur); cur = []
        cur.append(i)
    if cur:
        runs.append(cur)
    keep = []
    for r in runs:
        keep.extend(r[-k:])
    return sorted(set(keep))


def _action_json(d):
    a = _action_obj(d)
    if a is None:
        return None
    return ('{"a":6,"x":%d,"y":%d}' % (a["x"], a["y"])) if a["a"] == 6 else ('{"a":%d}' % a["a"])


def _frame_text(rows, i):
    d = rows[i - 1]
    fo = SimpleNamespace(frame=d.get("frame"), available_actions=d.get("available_actions") or [],
                         levels_completed=d.get("levels_completed", 0) or 0, state=d.get("state", ""))
    return (A.frame_text(fo) if A.rows_of(fo) is not None else None), (d.get("available_actions") or [])


def learn_game(path, k):
    game = os.path.basename(path).split("-")[0]
    rows = [json.loads(l)["data"] for l in open(path) if l.strip()]
    if not rows:
        return game, 0, 0
    steps = _decisive_steps(rows, _winning_steps(rows), k)
    good = 0
    sample = []
    for i in steps:
        if i < 1 or i >= len(rows):
            continue
        a = _action_json(rows[i])
        if a is None:
            continue
        ft, avail = _frame_text(rows, i)
        if ft is None:
            continue
        S.fire_reward(a, 1.0, good=True, frame=ft)
        good += 1
        if len(sample) < 5:
            sample.append((ft, S._action_num(a), avail))
    # BAD: actions into GAME_OVER are inhibited
    bad = 0
    for i, d in enumerate(rows):
        if i >= 1 and d.get("state") == "GAME_OVER":
            a = _action_json(d)
            if a is None:
                continue
            ft, _ = _frame_text(rows, i)
            if ft is None:
                continue
            S.fire_reward(a, 1.0, good=False, frame=ft)
            bad += 1
    return game, good, bad, sample


def main():
    if not S._NATIVE:
        print("FAIL: native /contract engine not reachable (fire_reward would be a SILENT no-op).")
        return 1
    root = next((a for a in sys.argv[1:] if not a.startswith("--")), ".")
    k = int(_arg("--decisive", "16"))
    warm = _arg("--warm")
    seal = _arg("--seal-muscle")
    report = _arg("--report")
    mc = os.path.expanduser("~/.contracts")
    os.makedirs(mc, exist_ok=True)
    if warm and os.path.exists(warm):
        shutil.copy(warm, mc + "/contracts.jsonl")
        print(f"warm-restored {os.path.getsize(warm)} bytes from {warm} -> ~/.contracts (COMPOUND)")
    files = sorted(glob.glob(os.path.join(root, "environment_files", "*", "replays", "*.json")))
    print(f"decisive EBM fire: {len(files)} games, k={k} (last-{k} winning transitions per run)")
    rep = {"games": {}, "decisive_k": k, "total_good": 0, "total_bad": 0}
    samples = []
    for f in files:
        game, g, b, sample = learn_game(f, k)
        rep["games"][game] = {"good": g, "bad": b}
        rep["total_good"] += g; rep["total_bad"] += b
        samples.extend((game, *s) for s in sample)
        print(f"  {game}: +{g:>4} good / {b:>2} bad")
    S.persist("arc")
    # ALIVE check: cold-reload the muscle and confirm recall_action is not a silent no-op.
    alive_hits = alive_tot = 0
    for game, ft, n, avail in samples:
        if not avail:
            continue
        alive_tot += 1
        if S.recall_action(ft, avail) is not None:
            alive_hits += 1
    rep["alive_recall_nonnull"] = f"{alive_hits}/{alive_tot}"
    if seal:
        shutil.copy(mc + "/contracts.jsonl", seal)
        rep["sealed_muscle_bytes"] = os.path.getsize(seal)
        print(f"harvested muscle -> {seal} ({os.path.getsize(seal)} bytes)")
    games_fired = sum(1 for v in rep["games"].values() if v["good"] > 0)
    rep["games_fired"] = games_fired
    rep["n_games"] = len(files)
    if report:
        json.dump(rep, open(report, "w"), indent=1)
    print(f"\nEBM_MUSCLE: {games_fired}/{len(files)} games fired -> {rep['total_good']} good + "
          f"{rep['total_bad']} bad; alive recall {alive_hits}/{alive_tot} non-null")
    ok = games_fired == len(files) and rep["total_good"] > 0 and alive_hits > 0
    print("WINNING_EBM_MUSCLE_OK" if ok else "FAIL: not all games fired or muscle is a silent no-op")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
