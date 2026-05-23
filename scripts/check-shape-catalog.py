#!/usr/bin/env python3
# check-shape-catalog.py — every shape named in SKILL.md's "shape gates"
# table must have a corresponding `<shape>-gate/verify.sh` on disk. And
# every `*-gate/verify.sh` on disk that names a shape must appear in the
# table. Catalogue and file-system must agree both directions.

import sys
import re
import os
from pathlib import Path

SKILL_DIR = Path(os.environ.get("SKILL_DIR", Path.home() / ".claude/skills/contract"))
SKILL = SKILL_DIR / "SKILL.md"

m = re.search(
    r"### The shape gates[\s\S]*?\| Shape \| Gate proves[\s\S]*?\n((?:\|[^\n]*\n)+)",
    text,
)
if not m:
    print("could not find 'shape gates' table under Self-modeling in SKILL.md", file=sys.stderr)
    sys.exit(2)
table = m.group(1)

shapes_in_docs = sorted(set(re.findall(r"\|\s*`([a-z][a-z0-9-]+)`\s*\|", table)))
if not shapes_in_docs:
    print("shape-gates table has no `shape` entries", file=sys.stderr)
    sys.exit(2)

# All shapes documented elsewhere too — restrict to the gate column.
gates_on_disk = sorted(
    p.parent.name.removesuffix("-gate")
    for p in SKILL_DIR.glob("*-gate/verify.sh")
)

missing_gate = [s for s in shapes_in_docs if s not in gates_on_disk]
missing_doc = [
    g for g in gates_on_disk
    if g not in shapes_in_docs
    and g not in {"audit", "bm25", "budget", "lifecycle", "propagation"}
    # the orthogonal-feature gates listed separately in the doc
]

if missing_gate or missing_doc:
    print("shape-catalog drift detected:", file=sys.stderr)
    for s in missing_gate:
        print(f"  docs claim '{s}-gate' exists but no {s}-gate/verify.sh on disk", file=sys.stderr)
    for g in missing_doc:
        print(f"  {g}-gate/verify.sh exists but '{g}' is not in the SKILL.md shape table", file=sys.stderr)
    sys.exit(1)

print(f"shape-catalog clean: {len(shapes_in_docs)} shapes in docs, {len(gates_on_disk)} gates on disk, all aligned.")
sys.exit(0)
