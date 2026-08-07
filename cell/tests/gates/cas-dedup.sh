#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo '{"data": {"hello": "world"}}' > "$tmp/in.json"
out1="$tmp/out1"
out2="$tmp/out2"
python3 "$CELL/run.py" run "$CELL/primitives/cas.cell.yaml" --inputs "$tmp/in.json" --out "$out1" > /dev/null
python3 "$CELL/run.py" run "$CELL/primitives/cas.cell.yaml" --inputs "$tmp/in.json" --out "$out2" > /dev/null
k1=$(cat "$out1/key.json" | tr -d '"[:space:]' | head -c 64)
k2=$(cat "$out2/key.json" | tr -d '"[:space:]' | head -c 64)
d2=$(cat "$out2/deduped.json" 2>/dev/null || echo "missing")
if [ "$k1" != "$k2" ]; then echo "FAIL cas-dedup: keys differ $k1 vs $k2"; exit 1; fi
if ! echo "$d2" | grep -q "true"; then echo "FAIL cas-dedup: second write not deduped (expected true): $d2"; exit 1; fi
echo "PASS cas-dedup: $k1 deduped on second put"
