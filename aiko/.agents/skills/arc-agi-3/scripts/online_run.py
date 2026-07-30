#!/usr/bin/env python3
"""online_run.py - drive the native /contract ARC organs against the LIVE ARC-AGI-3 api.

"see how far we go": opens each public game on the online API (three.arcprize.org), plays it with
the SAME ArcSkill.decide the kernel uses (perceive -> classify -> planner -> native EBM/jepa select
-> cogmap explore), and reports levels_completed per game + the total. This is the live-API witness
the offline sim cannot give (the offline 25 public games are leaderboard-excluded; the online API is
the real surface).

Honest scope: online wins here are a LIVE run against the public API, NOT a Kaggle leaderboard
placement (the leaderboard scores a held-out/private set in the sealed kernel). It shows how the
mechanical agent actually does turn-by-turn on real games.

Env: ARC_API_KEY (sourced from ~/.config/env/global.env if not set). ARC_ONLINE_CAP=actions/game
(default 100). ARC_ONLINE_GAMES=max games (default all). ARC_ONLINE_DEADLINE=total seconds (default 1800).
Run: python3 online_run.py
"""
import os
import sys
import time
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.expanduser("/Users/lekt9/.claude/skills/contract/bindings/python"))


def _load_key():
    if os.environ.get("ARC_API_KEY", "").strip():
        return
    g = os.path.expanduser("~/.config/env/global.env")
    if os.path.exists(g):
        for line in open(g):
            line = line.strip()
            if line.startswith("ARC_API_KEY="):
                os.environ["ARC_API_KEY"] = line.split("=", 1)[1].strip().strip('"').strip("'")
                return


def _ns(frame: dict) -> SimpleNamespace:
    return SimpleNamespace(
        frame=frame.get("frame"),
        available_actions=frame.get("available_actions") or [],
        levels_completed=frame.get("levels_completed"),
        state=frame.get("state", ""),
        game_id=frame.get("game_id", ""),
    )


def _retry(fn, label, tries=3, base=5.0, cap=60.0):
    """Game-level EXPONENTIAL BACKOFF on api-related failures - the second layer above
    arc_client._post's per-request backoff. When the request layer gives up (SystemExit on a
    sustained HTTP 500 burst) or any error escapes, back off base*2^n (capped) and retry the whole
    call, so a transient ALB outage is ridden out rather than killing the run. Re-raises after
    `tries` so a truly-down endpoint still skips the game (bounded, not infinite)."""
    last = None
    for n in range(tries):
        try:
            return fn()
        except BaseException as e:  # incl SystemExit from arc_client._post's give-up
            last = e
            if n == tries - 1:
                raise
            d = min(cap, base * (2 ** n))
            print(f"  [backoff] {label} api-failed ({type(e).__name__}); "
                  f"retry {n + 1}/{tries} in {d:.0f}s", flush=True)
            time.sleep(d)
    raise last


def _gid(g):
    if isinstance(g, str):
        return g
    if isinstance(g, dict):
        return g.get("game_id") or g.get("id") or g.get("game")
    return None


def main():
    _load_key()
    os.environ["ARC_API_MODE"] = "online"
    if not os.environ.get("ARC_API_KEY", "").strip():
        print("FAIL: no ARC_API_KEY (set it or add ARC_API_KEY=... to ~/.config/env/global.env)")
        return 1
    # arc_client._post already does per-request exponential backoff with jitter on
    # {408,425,429,5xx}; make it MORE patient for a sustained ALB 500 burst (read at its
    # import, so set before importing). The game-level _retry below is the second layer.
    os.environ.setdefault("ARC_HTTP_TRIES", "8")
    os.environ.setdefault("ARC_HTTP_CAP_DELAY", "45")
    import arc_client as AC
    import arc_skill as A

    cap = int(os.environ.get("ARC_ONLINE_CAP", "100"))
    deadline = float(os.environ.get("ARC_ONLINE_DEADLINE", "1800"))
    start = time.time()

    raw = AC.online_games()
    games = raw.get("games", raw) if isinstance(raw, dict) else raw
    ids = [g for g in (_gid(x) for x in games) if g]
    maxg = int(os.environ.get("ARC_ONLINE_GAMES", str(len(ids))))
    ids = ids[:maxg]
    print(f"online: {len(ids)} games, cap={cap} actions/game, deadline={deadline:.0f}s")
    print(f"games: {', '.join(g[:6] for g in ids)}", flush=True)

    total = 0
    rows = []
    for gid in ids:
        if time.time() - start > deadline:
            print(f"[deadline {deadline:.0f}s hit - stopping after {len(rows)} games]", flush=True)
            break
        try:
            frame = _retry(lambda: AC.online_open(gid), f"{gid[:6]} open")
        except BaseException as e:  # exhausted backoff -> skip this game, keep the run alive
            print(f"  {gid[:6]}: open failed ({type(e).__name__}: {str(e)[:80]}) - skipping", flush=True)
            continue
        skill = A.ArcSkill()
        best = 0
        n = 0
        state = ""
        for n in range(1, cap + 1):
            fo = _ns(frame)
            lc = fo.levels_completed
            if isinstance(lc, int):
                best = max(best, lc)
            state = str(fo.state or "")
            if "WIN" in state or "GAME_OVER" in state:
                break
            try:
                a, x, y, _organ = skill.decide(fo)
            except Exception:
                av = fo.available_actions
                nonclick = [k for k in av if int(k) != 6]
                a, x, y = (nonclick[0] if nonclick else (av[0] if av else 1)), None, None
            try:
                aa, ax, ay = a, x, y
                frame = _retry(
                    lambda: AC.online_act(aa, ax, ay) if int(aa) == 6 else AC.online_act(aa),
                    f"{gid[:6]} ACTION{a}")
            except BaseException as e:  # backoff exhausted -> end this game, keep the run alive
                print(f"  {gid[:6]}: act ACTION{a} failed ({type(e).__name__}: {str(e)[:60]}) "
                      f"after {n} actions, levels={best}", flush=True)
                break
        lc = frame.get("levels_completed") if isinstance(frame, dict) else None
        if isinstance(lc, int):
            best = max(best, lc)
        try:
            AC.online_close()
        except Exception:
            pass
        total += best
        rows.append((gid, best, n, state))
        print(f"  {gid[:6]}: levels={best}  actions={n}  state={state or '?'}", flush=True)

    print(f"\nONLINE_RESULT: {total} levels cleared across {len(rows)} games "
          f"in {time.time()-start:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
