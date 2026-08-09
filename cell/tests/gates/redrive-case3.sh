#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Case 1: new port b -> stale, unchanged a -> neither
cat > "$tmp/in.json" << 'JSON'
{"manifests": {"a": "abc123def456abc1", "b": "def123abc456def1"}, "prior": {"a": "abc123def456abc1"}}
JSON
python3 "$CELL/run.py" run "$CELL/system/redrive.cell.yaml" --inputs "$tmp/in.json" --out "$tmp/out" > /dev/null
stale=$(cat "$tmp/out/stale.json")
comp=$(cat "$tmp/out/compensation.json")
if ! echo "$stale" | grep -q "def123"; then echo "FAIL redrive-case3: b not stale: $stale"; exit 1; fi
if echo "$stale" | grep -q "abc123"; then echo "FAIL redrive-case3: a incorrectly stale: $stale"; exit 1; fi
# Case 2: changed -> stale
cat > "$tmp/in2.json" << 'JSON'
{"manifests": {"a": "new123abc456abc1"}, "prior": {"a": "abc123def456abc1"}}
JSON
python3 "$CELL/run.py" run "$CELL/system/redrive.cell.yaml" --inputs "$tmp/in2.json" --out "$tmp/out2" > /dev/null
stale2=$(cat "$tmp/out2/stale.json")
if ! echo "$stale2" | grep -q "changed"; then echo "FAIL redrive-case3: changed a not stale: $stale2"; exit 1; fi
# Case 3: ALREADY_SENT via prior_sent -> compensation not stale
cat > "$tmp/in3.json" << 'JSON'
{"manifests": {"b": "def123abc456def1"}, "prior": {}, "prior_sent": ["def123abc456def1"]}
JSON
python3 "$CELL/run.py" run "$CELL/system/redrive.cell.yaml" --inputs "$tmp/in3.json" --out "$tmp/out3" > /dev/null
comp3=$(cat "$tmp/out3/compensation.json")
stale3=$(cat "$tmp/out3/stale.json")
if ! echo "$comp3" | grep -q "ALREADY_SENT"; then echo "FAIL redrive-case3: ALREADY_SENT not in compensation: $comp3"; exit 1; fi
if echo "$stale3" | grep -q "def123"; then echo "FAIL redrive-case3: ALREADY_SENT should not be stale: $stale3"; exit 1; fi
# A changed product compensates when its superseded (old) digest crossed the boundary.
cat > "$tmp/in4.json" << 'JSON'
{"manifests": {"a": "new123abc456abc1"}, "prior": {"a": "old123abc456abc1"}, "prior_sent": ["old123abc456abc1"]}
JSON
python3 "$CELL/run.py" run "$CELL/system/redrive.cell.yaml" --inputs "$tmp/in4.json" --out "$tmp/out4" > /dev/null
comp4=$(cat "$tmp/out4/compensation.json")
stale4=$(cat "$tmp/out4/stale.json")
if ! echo "$comp4" | grep -q "diff_superseded_product"; then echo "FAIL redrive-case3: superseded sent product lacks compensation action: $comp4"; exit 1; fi
if echo "$stale4" | grep -q "new123"; then echo "FAIL redrive-case3: changed ALREADY_SENT product should never refire: $stale4"; exit 1; fi
echo "PASS redrive-case3: new->stale, changed->stale, ALREADY_SENT->wireable compensation"
