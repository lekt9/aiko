#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Negative: different digests must not confirm
cat > "$tmp/in_bad.json" << 'JSON'
{"claim": {"data": {"x": 1}, "source": "a"}, "evidence": {"data": {"x": 2}, "source": "b", "fetched_at": "now"}}
JSON
out=$(python3 "$CELL/run.py" run "$CELL/patterns/confirm/confirm.cell.yaml" --inputs "$tmp/in_bad.json" --out "$tmp/out_bad" 2>&1)
bad=$(cat "$tmp/out_bad/confirmed.json" 2>/dev/null | tr -d '"[:space:]')
if [ "$bad" = "true" ]; then echo "FAIL confirm: mismatched digests confirmed true"; exit 1; fi
# Positive: same digest + independent source -> confirmed
cat > "$tmp/in_good.json" << 'JSON'
{"claim": {"data": {"x": 1}, "source": "a"}, "evidence": {"data": {"x": 1}, "source": "b", "fetched_at": "now"}}
JSON
python3 "$CELL/run.py" run "$CELL/patterns/confirm/confirm.cell.yaml" --inputs "$tmp/in_good.json" --out "$tmp/out_good" > /dev/null
good=$(cat "$tmp/out_good/confirmed.json" 2>/dev/null | tr -d '",[:space:]' | tr '[:upper:]' '[:lower:]')
diff=$(cat "$tmp/out_good/diff.json" 2>/dev/null || echo "missing")
if [ "$good" != "true" ]; then echo "FAIL confirm: same digest independent not confirmed: $good $diff"; exit 1; fi
if ! echo "$diff" | grep -q "claim_digest"; then echo "FAIL confirm: diff missing digests: $diff"; exit 1; fi
echo "PASS confirm: refused bad, confirmed good with diff"
