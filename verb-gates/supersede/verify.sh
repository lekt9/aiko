#!/usr/bin/env bash
# verb-gate: supersede (alias merge) — fossilizes loser, preserves lineage.
# Proves:
#   1. supersede writes a merged row with loser id + merged_into = winner id
#   2. the loser drops out of `list` (fossil hidden by default)
#   3. the loser is still IN the ledger (append-only, never deleted)
#   4. supersede on unknown id errors cleanly
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CONTRACTS_STORE="$TMP/ledger.jsonl"

LOSER=$(bash "$C" declare "supersede_gate loser" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
WINNER=$(bash "$C" declare "supersede_gate winner" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$LOSER" ] && [ -n "$WINNER" ] || { echo "FAIL: could not declare both contracts"; exit 1; }

bash "$C" supersede "$LOSER" "$WINNER" --reason "verb-gate test" >/dev/null 2>&1

# 1. merged row written, with merged_into pointing at winner
grep -q "\"event\": \"merged\", \"id\": \"$LOSER\".*\"merged_into\": \"$WINNER\"" "$CONTRACTS_STORE" \
  || grep -q "\"id\": \"$LOSER\".*\"merged_into\": \"$WINNER\".*\"event\": \"merged\"" "$CONTRACTS_STORE" \
  || { echo "FAIL: no merged row pointing at winner"; cat "$CONTRACTS_STORE"; exit 1; }
echo "evidence: merged row written with merged_into=$WINNER  OK"

# 2. loser does NOT appear in default list output
LIST=$(bash "$C" list 2>/dev/null)
if echo "$LIST" | grep -qE "\b$LOSER\b"; then
  echo "FAIL: superseded loser still visible in default list"
  echo "$LIST"
  exit 1
fi
echo "evidence: superseded loser hidden from default list  OK"

# 3. loser IS still in the raw ledger
grep -q "\"id\": \"$LOSER\"" "$CONTRACTS_STORE" \
  || { echo "FAIL: loser deleted from ledger (substrate principle violated)"; exit 1; }
echo "evidence: loser still present in append-only ledger  OK"

# 4. supersede on unknown id must error
set +e
OUT=$(bash "$C" supersede "doesnt_exist" "$WINNER" 2>&1)
EC=$?
set -e
echo "$OUT" | grep -qiE "not found|error|ERROR" || [ "$EC" -ne 0 ] \
  || { echo "FAIL: supersede on unknown id did not error"; echo "$OUT"; exit 1; }
echo "evidence: supersede on unknown id errors  OK"

echo "PASS: supersede — fossilizes via merged event, hides from list, keeps lineage."
exit 0
