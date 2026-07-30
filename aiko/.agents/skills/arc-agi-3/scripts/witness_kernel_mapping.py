#!/usr/bin/env python3
"""witness_kernel_mapping.py - prove the Kaggle kernel maps (a,x,y) to a GameAction correctly.

The canonical ARC-AGI-3 action mapping (synthesized from /arc-agi-3, /arc-solve, /aiko-arc and
verified against the official ARC-AGI-3-Agents tree) is in references/08-kernel-action-mapping.md.
This is its runnable witness: it exercises the kernel's own marshaller (my_agent_aiko._mk) against
the arcengine surface and asserts every load-bearing mapping fact, so "the kernel maps correctly"
is a green exit code, never a prose claim.

Asserted:
  1. action id n in 1..7  -> GameAction whose .name == "ACTION{n}" (from_id is the canonical map).
  2. ACTION6 carries click coords on .set_data as {"x": col, "y": row} - x is COLUMN, y is ROW.
  3. x/y are NOT transposed: _mk(6, x=COL, y=ROW).data["x"] == COL and ["y"] == ROW.
  4. coords clamp to 0..63 (a None or out-of-range coord never escapes the board).
  5. a non-click action carries NO coords (.data is empty) - only ACTION6 is a coordinate action.

Run: PYTHONPATH=<agents_stub>:<contract-bindings> python3 witness_kernel_mapping.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SEAL = os.path.normpath(os.path.join(HERE, "..", "..", "..", "kaggle_seal"))
# resolve imports the way the seal/gate does: the arcengine + agents stubs, the skill organs,
# the contract bindings, and the kernel dir that holds my_agent_aiko.py.
for p in (os.path.join(SEAL, "agents_stub"), SEAL, HERE,
          os.path.expanduser("/Users/lekt9/.claude/skills/contract/bindings/python")):
    if p not in sys.path:
        sys.path.insert(0, p)

try:
    from my_agent_aiko import _mk
except Exception as e:
    print(f"FAIL: cannot import the kernel marshaller my_agent_aiko._mk ({e})")
    sys.exit(1)


def main():
    fails = []

    # 1. id -> ACTION{n}
    for n in range(1, 8):
        got = _mk(n).name
        if got != f"ACTION{n}":
            fails.append(f"id {n} -> {got!r}, expected ACTION{n}")

    # 2/3. ACTION6 click: x=col, y=row, no transposition
    COL, ROW = 12, 58
    act6 = _mk(6, x=COL, y=ROW)
    if act6.name != "ACTION6":
        fails.append(f"id 6 -> {act6.name!r}, expected ACTION6")
    if act6.data.get("x") != COL:
        fails.append(f"ACTION6 x (column) = {act6.data.get('x')!r}, expected {COL} (transposed?)")
    if act6.data.get("y") != ROW:
        fails.append(f"ACTION6 y (row) = {act6.data.get('y')!r}, expected {ROW} (transposed?)")

    # 4. clamp 0..63 (and None -> a safe in-board default, never escapes)
    hi = _mk(6, x=99, y=-5).data
    if not (0 <= hi.get("x", -1) <= 63 and 0 <= hi.get("y", -1) <= 63):
        fails.append(f"ACTION6 coords did not clamp to 0..63: {hi}")
    none = _mk(6).data
    if not (0 <= none.get("x", -1) <= 63 and 0 <= none.get("y", -1) <= 63):
        fails.append(f"ACTION6 with no coords did not default into 0..63: {none}")

    # 5. non-click actions carry NO coords
    for n in (1, 2, 3, 4, 5, 7):
        d = _mk(n).data
        if d:
            fails.append(f"ACTION{n} (non-click) carried coords {d}, expected none")

    if fails:
        for f in fails:
            print("  FAIL " + f)
        print("FAIL: kernel action mapping is WRONG")
        return 1
    print("  ok   id 1..7 -> ACTION1..7 (from_id canonical)")
    print("  ok   ACTION6 click: x=column, y=row, not transposed")
    print("  ok   coords clamp to 0..63 (None and out-of-range)")
    print("  ok   only ACTION6 carries coords")
    print("KERNEL_MAPPING_OK: the kernel maps (a,x,y) -> GameAction correctly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
