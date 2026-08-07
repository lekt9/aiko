#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Bounded search: no transform reads gap's expect. Gap with no matching probe must be refused.
echo '{"gap":{"need":"zzzz-no-real-transform-produces-this"}}' > "$tmp/in.json"
set +e
out=$(python3 "$CELL/run.py" run "$CELL/primitives/author.cell.yaml" --inputs "$tmp/in.json" --out "$tmp/out" 2>&1)
rc=$?
set -e
if [ $rc -eq 0 ]; then echo "FAIL authored-gap: expected refusal for unmatchable gap, rc=0 $out"; exit 1; fi
if ! echo "$out" | grep -q "no transform fits\|refused"; then
  # stderr path
  if ! grep -qr "no transform fits" "$tmp/out" 2>/dev/null && ! echo "$out" | grep -qi "refused\|no transform"; then
    echo "WARN authored-gap: refused but message missing expected text: $out"
  fi
fi
# Positive: seedance gap must succeed
echo '{"gap":{"need":"seedance realistic video"}}' > "$tmp/in2.json"
rm -rf "$tmp/out2"
mkdir -p "$tmp/out2"
out2=$(python3 "$CELL/run.py" run "$CELL/primitives/author.cell.yaml" --inputs "$tmp/in2.json" --out "$tmp/out2" 2>&1)
if ! echo "$out2" | grep -q "seedance-realistic"; then
  if ! cat "$tmp/out2/cell_yaml.json" 2>/dev/null | grep -q "seedance" && ! cat "$tmp/out2/cell.json" 2>/dev/null | grep -q "seedance"; then
    echo "FAIL authored-gap: seedance transform did not produce expected cell: $out2"
    exit 1
  fi
fi
echo "PASS authored-gap: refused unmatchable, succeeded seedance"
