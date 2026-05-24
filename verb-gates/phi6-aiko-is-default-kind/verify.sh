#!/bin/bash
# Φ6+Φ7 gate: mirror payload carries {silo, kind=aiko_cell-by-default, node, edges}
# Identity siloed via CONTRACT_AGENT; ref edges extracted from contract:<id> actions.
set -e
TMP=$(mktemp -d); export CONTRACTS_STORE="$TMP/s.jsonl"
export CONTRACT_AGENT="gate-phi6@example.com"
export CONTRACT_MIRROR=1
C=~/.claude/skills/contract/scripts/contract
TAG="phi6-gate-$$"
PARENT=$($C declare "$TAG parent" --action funnel --no-drive 2>&1 | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
CHILD=$($C declare "$TAG child" --action "contract:$PARENT" --parent "$PARENT" --no-drive 2>&1 | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
sleep 2
TODAY=$(date -u +%Y-%m-%d)
FAIL=~/.contracts/inbox/mirror-failures/$TODAY.jsonl
[ -f "$FAIL" ] || { echo "FAIL: no mirror-failures log"; exit 1; }
# the child row should carry silo + kind=aiko_cell + node.id + edges.parent_id + edges.refs
python3 << PY
import json, sys
hit = None
for line in reversed(open("$FAIL").read().splitlines()):
    try: r = json.loads(line)
    except: continue
    row = r.get("row", {})
    if row.get("node", {}).get("plan", "").startswith("$TAG child"):
        hit = r; break
assert hit, "no $TAG child found in mirror-failures"
row = hit["row"]
assert row["silo"] == "gate-phi6@example.com", f"silo wrong: {row.get('silo')}"
assert row["kind"] == "aiko_cell", f"kind wrong: {row.get('kind')}"
assert row["node"]["id"] == "$CHILD", f"node.id wrong: {row['node'].get('id')}"
assert row["edges"]["parent_id"] == "$PARENT", f"parent_id wrong: {row['edges'].get('parent_id')}"
assert "$PARENT" in row["edges"]["refs"], f"refs missing parent: {row['edges'].get('refs')}"
print("payload shape verified: silo + kind=aiko_cell + node + edges with refs[]")
PY
echo "PASS: Φ6+Φ7 — node+edge envelope, identity-siloed, aiko_cell default"
