#!/usr/bin/env bash
# check-crystallize-consistency.sh — every satisfied contract that declared
# a --learning text MUST have either:
#   (a) a `crystallized` row (the learning landed in memory/Outline)  OR
#   (b) a `crystallize_skipped` row (the substrate tried and recorded why)
#
# A satisfied+learning contract with neither is a silent gap: the agent
# wrote a learning, the substrate said "satisfied", but nothing crystallized
# AND nothing was logged to explain the absence. That's the failure mode
# the drill loop missed on 2026-05-23 (173c8819, bbbdb533).
#
# Origin: contract 9569867c, /contract self-audit wave 2026-05-23.
set -uo pipefail

LEDGER="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
[ -f "$LEDGER" ] || { echo "  (no ledger at $LEDGER — vacuously OK)"; exit 0; }

PYTHONPATH="$HOME/.claude/skills/contract/scripts/lib:${PYTHONPATH:-}" \
python3 - "$LEDGER" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
rows = []
for line in path.read_text().splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        rows.append(json.loads(line))
    except json.JSONDecodeError:
        continue

declared_with_learning = {r["id"]: r.get("plan", "")[:60]
                          for r in rows
                          if r.get("event") == "declared" and r.get("learning")}
satisfied = {r["id"] for r in rows if r.get("event") == "satisfied"}
crystallized = {r["id"] for r in rows if r.get("event") == "crystallized"}
skipped = {r["id"] for r in rows if r.get("event") == "crystallize_skipped"}

should_have = declared_with_learning.keys() & satisfied
accounted = crystallized | skipped
gap = should_have - accounted

if gap:
    print("crystallize-consistency drift detected:", file=sys.stderr)
    for cid in sorted(gap):
        print(f"  {cid}: satisfied + learning but no crystallized / crystallize_skipped row "
              f"— {declared_with_learning[cid]!r}",
              file=sys.stderr)
    print(f"  ({len(gap)} contract(s) of {len(should_have)} satisfied+learning)",
          file=sys.stderr)
    sys.exit(1)

print(f"crystallize-consistency clean: {len(should_have)} satisfied+learning contracts, "
      f"all have crystallized or crystallize_skipped rows.")
sys.exit(0)
PY
