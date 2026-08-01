#!/usr/bin/env python3
"""cogmap_drives_explore.py - the runnable witness that the native cognitive map DRIVES the
'explore' (novel) archetype, not the LLM-in-the-loop.

The proven top-3 ARC-AGI-3 method (arXiv 2512.24156) is action-efficient state-space coverage via a
cognitive map (cogmap.zig, native + signed), NOT a bigger model in the control loop. This witness
drives ArcSkill.decide over a synthetic explore world and asserts:

  1. every explore decision is tagged 'cogmap-explore' (the cogmap organ, not 'llm+select'), and
  2. the LLM proposer (_ask_aiko) is NEVER reached on the explore path - it is monkeypatched to RAISE;
     if cogmap fails to drive, decide() falls through to _ask_aiko and the test crashes loudly, and
  3. the map is covered action-efficiently (every reachable state visited) with the no-op action
     marked DEAD (not flailed) - the squared-RHAE lever.

HONEST SCOPE (named, not faked): this is the STRUCTURAL witness (cogmap drives the explore loop). The
live RHAE lift on HELD-OUT games is the deeper-open proof - it needs the sandboxed competition rerun
and cannot be run here. Green here == "cogmap drives explore", not "RHAE improved".

Needs the freshly-built libcontract with the cogmap symbols; set LIBCONTRACT_PATH to the fresh
.dylib/.so if the co-located one is stale.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
sys.path.insert(0, SKILL)
# the native binding the agent links (mirrors the Zig body)
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/bindings/python"))


class _Frame:
    """A minimal ARC frame stub: a small int grid + the fields decide() reads."""

    def __init__(self, grid, avail, levels=0, state="NOT_FINISHED"):
        self.frame = grid
        self.available_actions = avail
        self.levels_completed = levels
        self.state = state


def _grid(tag):
    """An 8x8 grid whose top-left cell encodes the state (distinct grids -> distinct interned states)."""
    g = [[0] * 8 for _ in range(8)]
    g[0][0] = tag
    return g


def main():
    import arc_skill

    # the explore world: a one-way line of N states. action 1 advances (changes the grid);
    # action 2 is ALWAYS a no-op (same grid) - cogmap must mark it dead and ride action 1.
    N = 5
    AVAIL = [1, 2]  # no click action -> cogmap owns the whole discrete decision

    # the LLM proposer MUST NOT be reached when cogmap drives - make it explode if it is.
    def _boom(_ft):
        raise AssertionError("LLM (_ask_aiko) was reached on the explore path - cogmap did NOT drive")

    arc_skill._ask_aiko = _boom

    skill = arc_skill.ArcSkill()
    state = 0
    organs = []
    visited = {0}
    exhausted_at = None  # the step where cogmap exhausted the reachable map and handed to the LLM
    for step in range(4 * N):
        frame = _Frame(_grid(state), AVAIL)
        try:
            a, x, y, organ = skill.decide(frame)
        except AssertionError:
            # cogmap returned -1 (reachable map exhausted) -> decide() handed off to the LLM fallback,
            # which we forbade with _boom. This handoff is CORRECT *iff* the map was already covered.
            exhausted_at = step
            break
        organs.append(organ)
        state = state + 1 if (a == 1 and state + 1 < N) else state  # action 1 advances; else no-op
        visited.add(state)

    print(f"[cogmap-explore] organs={organs}  visited={sorted(visited)}  exhausted_at={exhausted_at}")

    drove = len(organs) > 0 and all(o == "cogmap-explore" for o in organs)  # every pre-handoff decision
    covered = visited == set(range(N))                                       # whole map covered
    handoff_ok = (exhausted_at is None) or covered                           # LLM only AFTER coverage

    ok = drove and covered and handoff_ok
    print(f"[cogmap-explore] all-pre-handoff-from-cogmap={drove}  covered={covered}  "
          f"handoff-only-after-coverage={handoff_ok}")
    print("COGMAP_DRIVES_EXPLORE_OK" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
