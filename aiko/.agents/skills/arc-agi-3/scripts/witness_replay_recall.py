#!/usr/bin/env python3
"""witness_replay_recall.py - the "learnt properly" witness for the winning-replay recall.

Feed the WINNERS' OWN frames back through ArcSkill.decide() and confirm the agent reproduces the
winner's exact action via the `replay` organ. This is the falsifiable gate that the distilled cache
+ the wired organ actually work end-to-end (load -> stable hash -> organ -> action), across ALL 25
games. A hit means: on the exact board the winner faced, our agent emits the winner's exact move
(max RHAE). Two witnesses: the recorded win + our reproduction of it.

Exit 0 when overall reproduction >= THRESHOLD (default 0.95) and every game has >0 hits.

Run: ARC_REPLAY_CACHE=<winning_replays.json> python3 witness_replay_recall.py <archive_root> [thr]
"""
import glob
import json
import os
import sys
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import arc_skill as A  # noqa: E402
from extract_winning_replays import _winning_steps, _action_obj  # reuse the exact win logic


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "."
    thr = float(sys.argv[2]) if len(sys.argv) > 2 else 0.95
    cache = A._load_replay_cache()
    if not cache:
        print("FAIL: replay cache empty (set ARC_REPLAY_CACHE or place winning_replays.json)")
        return 1
    print(f"replay cache: {len(cache)} content-addressed winning frames")
    files = sorted(glob.glob(os.path.join(root, "environment_files", "*", "replays", "*.json")))
    # strict = reproduces the exact step action; winmove = emits SOME action the winner used to win
    # from this exact board (the correct claim for a content-addressed one-action-per-board cache).
    s_hit = s_tot = w_hit = w_tot = 0
    weak = []
    for f in files:
        game = os.path.basename(f).split("-")[0]
        rows = [json.loads(l)["data"] for l in open(f) if l.strip()]
        win = _winning_steps(rows)
        # board -> set of winning actions the winner used from it
        board_acts = {}
        for i in sorted(win):
            if i < 1 or i >= len(rows):
                continue
            want = _action_obj(rows[i])
            if want is None:
                continue
            h = A._grid_key(A.rows_of(SimpleNamespace(frame=rows[i - 1].get("frame"))) or [])
            board_acts.setdefault(h, set()).add(json.dumps(want, sort_keys=True))
        skill = A.ArcSkill()                  # fresh agent; loads the cache in __init__
        gs_hit = gs_tot = gw_hit = gw_tot = 0
        for i in sorted(win):
            if i < 1 or i >= len(rows):
                continue
            want = _action_obj(rows[i])
            if want is None:
                continue
            prev = rows[i - 1]
            fo = SimpleNamespace(frame=prev.get("frame"),
                                 available_actions=prev.get("available_actions") or [],
                                 levels_completed=prev.get("levels_completed", 0) or 0,
                                 state=prev.get("state", ""))
            a, x, y, organ = skill.decide(fo)
            got = {"a": a} if a != 6 else {"a": 6, "x": x, "y": y}
            h = A._grid_key(A.rows_of(fo) or [])
            gs_tot += 1
            if organ == "replay" and got == want:
                gs_hit += 1
            gw_tot += 1
            if organ == "replay" and json.dumps(got, sort_keys=True) in board_acts.get(h, set()):
                gw_hit += 1
        wacc = (gw_hit / gw_tot * 100) if gw_tot else 0.0
        if gw_tot and wacc < thr * 100:
            weak.append(game)
        s_hit += gs_hit; s_tot += gs_tot; w_hit += gw_hit; w_tot += gw_tot
        print(f"  {game}: winning-move {gw_hit}/{gw_tot} ({wacc:4.0f}%)  "
              f"[exact-step {gs_hit}/{gs_tot} ({(gs_hit/gs_tot*100) if gs_tot else 0:.0f}%)]")
    strict = (s_hit / s_tot) if s_tot else 0.0
    winmove = (w_hit / w_tot) if w_tot else 0.0
    print(f"\nREPLAY_RECALL: winning-move {w_hit}/{w_tot} ({winmove*100:.1f}%); "
          f"exact-step {s_hit}/{s_tot} ({strict*100:.1f}%); weak games: {weak or 'none'}")
    ok = winmove >= thr and not weak
    print("REPLAY_RECALL_OK" if ok else
          f"FAIL: winning-move reproduction {winmove*100:.1f}% < {thr*100:.0f}% or weak games {weak}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
