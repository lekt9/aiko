#!/usr/bin/env python3
"""witness_muscle_alive.py - COLD-execute witness that the sealed EBM muscle is real, not a no-op.

Restores the dataset's muscle.jsonl into a FRESH temp HOME/.contracts (exactly as the kernel does
before play), imports select_sign (which load_brain()s the ledger), then routes a sample of the
winners' OWN frames through recall_action. A live muscle returns a non-null action for most of them;
a dead/empty ledger returns None for all. This re-executes the sealed artifact (two witnesses: the
fire report AND this cold reload), so a stale or silently-empty muscle.jsonl cannot pass.

Run: python3 witness_muscle_alive.py <muscle.jsonl> <archive_root> [threshold=0.5] [n=200]
Exit 0 when non-null recall fraction >= threshold over n sampled winning frames.
"""
import glob
import json
import os
import sys
import tempfile
from types import SimpleNamespace


def main():
    muscle = sys.argv[1]
    root = sys.argv[2] if len(sys.argv) > 2 else "."
    thr = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 200
    if not os.path.exists(muscle):
        print(f"FAIL: muscle {muscle} missing")
        return 1
    home = tempfile.mkdtemp(prefix="muscle_alive_")
    os.makedirs(home + "/.contracts", exist_ok=True)
    import shutil
    shutil.copy(muscle, home + "/.contracts/contracts.jsonl")
    os.environ["HOME"] = home   # the bindings + select_sign read ~/.contracts from HOME
    HERE = os.path.dirname(os.path.abspath(__file__))
    sys.path.insert(0, HERE)
    sys.path.insert(0, os.path.join(home, ".claude/skills/contract/bindings/python"))
    sys.path.insert(0, os.path.expanduser("/Users/lekt9/.claude/skills/contract/bindings/python"))
    import arc_skill as A
    import select_sign as S
    from extract_winning_replays import _winning_steps, _action_obj
    if not S._NATIVE:
        print("FAIL: native binding unreachable")
        return 1
    S.load_brain("arc")
    files = sorted(glob.glob(os.path.join(root, "environment_files", "*", "replays", "*.json")))
    frames = []
    for f in files:
        rows = [json.loads(l)["data"] for l in open(f) if l.strip()]
        for i in sorted(_winning_steps(rows)):
            if i < 1 or i >= len(rows):
                continue
            if _action_obj(rows[i]) is None:
                continue
            prev = rows[i - 1]
            fo = SimpleNamespace(frame=prev.get("frame"),
                                 available_actions=prev.get("available_actions") or [])
            if A.rows_of(fo) is None or not fo.available_actions:
                continue
            frames.append((A.frame_text(fo), list(fo.available_actions)))
    # even stride sample across all games
    step = max(1, len(frames) // n)
    sample = frames[::step][:n]
    nonnull = sum(1 for ft, av in sample if S.recall_action(ft, av) is not None)
    frac = nonnull / len(sample) if sample else 0.0
    print(f"MUSCLE_ALIVE: {nonnull}/{len(sample)} winning frames recall a non-null action ({frac*100:.0f}%)")
    ok = frac >= thr
    print("MUSCLE_ALIVE_OK" if ok else f"FAIL: live recall {frac*100:.0f}% < {thr*100:.0f}% (muscle dead/empty)")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
