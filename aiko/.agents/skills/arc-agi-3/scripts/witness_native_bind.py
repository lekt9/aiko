#!/usr/bin/env python3
"""Witness: arc_skill binds its deterministic planners to the ENGINE (native @contract over
libcontract), so a plan RECALLS cross-process from the ledger without re-executing its body --
durable instinct, not a per-process throwaway dict.

Falsifiable: a bound function writes a marker line ONLY when its body actually runs. Call it in
proc1 (computes -> 1 mark), then in a FRESH proc2 against the same ledger. Native engine recall =>
proc2 skips the body => still 1 mark. A per-process dict (or a dead engine) => proc2 recomputes
=> 2 marks. Exit 0 (NATIVE_BIND_OK) iff exactly 1. Fail-closed."""
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
# Resolve the real bindings dir NOW, before the child resets HOME to a temp ledger (which would
# make ~/.claude unresolvable). In-kernel the seal bundles contract.py on an absolute path, so this
# local-only HOME juggling does not exist there.
BIND = os.path.expanduser("~/.claude/skills/contract/bindings/python")

CHILD = r'''
import sys, os
sys.path.insert(0, %r)
sys.path.insert(0, %r)
import arc_skill as A
if A._native_contract is None:
    print("ENGINE_ABSENT"); sys.exit(2)
MARK = os.environ["MARK"]
@A._bind_planner
def plan(rows):
    open(MARK, "a").write("COMPUTE\n")          # side effect ONLY on a real compute
    return [[1, int(rows[0][0]), 2]]
print("OUT", plan([[7, 7], [7, 7]]))
'''


def run(home, mark, tag):
    env = dict(os.environ, HOME=home, MARK=mark)
    r = subprocess.run([sys.executable, "-c", CHILD % (HERE, BIND)], capture_output=True, text=True, env=env)
    tail = (r.stdout.strip().splitlines() or [""])[-1]
    print(f"  [{tag}] rc={r.returncode} {tail}")
    if r.returncode not in (0, 2):
        print(r.stderr[-400:])
    return r


def main():
    home = tempfile.mkdtemp(prefix="natbind_")
    mark = os.path.join(home, "marks.txt")
    r1 = run(home, mark, "proc1")
    if r1.returncode == 2:
        print("FAIL: native engine absent - cannot witness the binding (set LIBCONTRACT_PATH)")
        return 1
    r2 = run(home, mark, "proc2-fresh")
    n = sum(1 for _ in open(mark)) if os.path.exists(mark) else -1
    print(f"  compute count across 2 processes: {n}  (engine recall => 1, dict/recompute => 2)")
    ok = r1.returncode == 0 and r2.returncode == 0 and n == 1
    print("NATIVE_BIND_OK: planner bound to the engine; recalls cross-process, no recompute"
          if ok else "FAIL: planner did not recall from the engine cross-process")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
