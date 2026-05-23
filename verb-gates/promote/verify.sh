#!/usr/bin/env bash
# verb-gate: promote — copies a contract's rows from the current ledger to
# the global ledger (~/.contracts/contracts.jsonl), preserving the same id.
# Proves:
#   1. promote on a known id copies declared+satisfied rows to the global
#   2. the source ledger gets a 'promoted' marker
#   3. promote is idempotent (re-running does not double-copy)
#   4. promote on unknown id errors
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Sandbox HOME so the verb's hardcoded ~/.contracts path lands in tempdir.
export HOME="$TMP/home"
mkdir -p "$HOME/.contracts" "$HOME/proj/.claude"
SRC="$HOME/proj/.claude/contracts.jsonl"
GLOBAL="$HOME/.contracts/contracts.jsonl"
touch "$SRC" "$GLOBAL"
export CONTRACTS_STORE="$SRC"   # current ledger == project ledger

# 1. declare in source, mark satisfied, promote to global
ID=$(bash "$C" declare "promote_gate target" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID" ] || { echo "FAIL: declare returned no id"; exit 1; }
bash "$C" _mark "$ID" satisfied --proof-skip "verb-gate self-test" >/dev/null 2>&1
bash "$C" promote "$ID" --reason "verb-gate test" >/dev/null 2>&1

grep -q "\"event\": \"declared\", \"id\": \"$ID\"" "$GLOBAL" \
  || { echo "FAIL: declared row not in global ledger"; echo "--global:"; cat "$GLOBAL"; exit 1; }
grep -q "\"event\": \"satisfied\", \"id\": \"$ID\"" "$GLOBAL" \
  || { echo "FAIL: satisfied row not in global ledger"; cat "$GLOBAL"; exit 1; }
echo "evidence: declared + satisfied rows copied to global  OK"

# 2. source ledger has a 'promoted' marker row
grep -q "\"event\": \"promoted\", \"id\": \"$ID\"" "$SRC" \
  || { echo "FAIL: no promoted marker in source ledger"; cat "$SRC"; exit 1; }
echo "evidence: source ledger has promoted marker  OK"

# 3. idempotent — second promote does NOT add a second declared row
bash "$C" promote "$ID" --reason "verb-gate idempotent check" >/dev/null 2>&1
N=$(grep -c "\"event\": \"declared\", \"id\": \"$ID\"" "$GLOBAL")
[ "$N" -eq 1 ] || { echo "FAIL: promote not idempotent — $N declared rows in global"; exit 1; }
echo "evidence: idempotent — global has exactly 1 declared row after 2 promotes  OK"

# 4. promote on unknown id errors
set +e
OUT=$(bash "$C" promote "nonexistent_xyz" 2>&1)
EC=$?
set -e
echo "$OUT" | grep -qiE "not found|error|ERROR" || [ "$EC" -ne 0 ] \
  || { echo "FAIL: promote on unknown id did not error"; echo "$OUT"; exit 1; }
echo "evidence: promote on unknown id errors  OK"

echo "PASS: promote — rows copied to global with same id; idempotent; source has promoted marker; unknown ids rejected."
exit 0
