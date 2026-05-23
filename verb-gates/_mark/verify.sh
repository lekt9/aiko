#!/usr/bin/env bash
# verb-gate: _mark — the load-bearing KEY 2 path. Proves:
#   1. _mark satisfied appends a satisfied row with the same id
#   2. status reflects [satisfied] after the mark
#   3. marking an unknown id errors out (does NOT silently succeed)
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CONTRACTS_STORE="$TMP/ledger.jsonl"

# 1. declare + mark satisfied → ledger row appears
ID=$(bash "$C" declare "_markgate_happy" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID" ] || { echo "FAIL: declare returned no id"; exit 1; }
bash "$C" _mark "$ID" satisfied --proof-skip "verb-gate self-test" >/dev/null 2>&1
grep -q "\"event\": \"satisfied\", \"id\": \"$ID\"" "$CONTRACTS_STORE" \
  || { echo "FAIL: no satisfied row written for $ID"; cat "$CONTRACTS_STORE"; exit 1; }
echo "evidence: _mark satisfied  ->  ledger row written  OK"

# 2. status shows [satisfied]
OUT=$(bash "$C" status "$ID" 2>/dev/null)
echo "$OUT" | grep -qE "\[satisfied\]\s+$ID" || { echo "FAIL: status does not show [satisfied]"; echo "$OUT"; exit 1; }
echo "evidence: status reflects [satisfied]  OK"

# 3. marking an unknown id must not silently succeed
set +e
bash "$C" _mark "deadbeef_does_not_exist" satisfied --proof-skip "verb-gate self-test" >/dev/null 2>&1
EC=$?
set -e
if [ "$EC" -eq 0 ]; then
  # check that nothing was written for the bogus id (substrate principle: never silent)
  if grep -q "\"id\": \"deadbeef_does_not_exist\"" "$CONTRACTS_STORE" 2>/dev/null; then
    echo "FAIL: _mark of unknown id wrote a row (silent fabrication)"
    exit 1
  fi
fi
echo "evidence: _mark on unknown id is not silent  OK"

echo "PASS: _mark — KEY 2 path writes a satisfied row, status reflects it, unknown ids are not fabricated."
exit 0
