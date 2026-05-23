#!/usr/bin/env bash
# verb-gate: inhibits — biology negative regulation. Proves:
#   1. happy path: declare --inhibits <id> stores the field on the declared row
#   2. when inhibitor is unsatisfied, target CAN satisfy normally
#   3. when inhibitor is satisfied, _mark satisfied on target REFUSES (exit nonzero, no row)
#   4. refusal output names the inhibitor id + plan (substrate is honest, not silent)
#   5. multiple inhibitors all surface in the refusal
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CONTRACTS_STORE="$TMP/ledger.jsonl"

# 1. declare target + two inhibitors. inhibitors must be declared first since they reference target.
# Actually: --inhibits points FROM inhibitor TO target, so target id must exist first.
TARGET=$(bash "$C" declare "inhibitsgate target contract" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$TARGET" ] || { echo "FAIL: declare target"; exit 1; }
INH1=$(bash "$C" declare "inhibitsgate suppressor 1" --action true --no-drive --inhibits "$TARGET" 2>/dev/null | awk '/^declared:/{print $2}')
INH2=$(bash "$C" declare "inhibitsgate suppressor 2" --action true --no-drive --inhibits "$TARGET" 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$INH1" ] && [ -n "$INH2" ] || { echo "FAIL: declare inhibitors"; exit 1; }

# verify inhibits field is on the declared row
grep -q "\"inhibits\": \[\"$TARGET\"\]" "$CONTRACTS_STORE" \
  || { echo "FAIL: --inhibits field not stored on declared row"; head "$CONTRACTS_STORE"; exit 1; }
echo "evidence: --inhibits stored on declared row  OK"

# 2. with inhibitors UNSATISFIED, target should mark satisfied normally
bash "$C" iterate "$TARGET" >/dev/null 2>&1
set +e
OUT=$(bash "$C" _mark "$TARGET" satisfied --proof "test: no inhibitors firing" 2>&1)
EC=$?
set -e
[ "$EC" -eq 0 ] || { echo "FAIL: target refused even though no inhibitor is satisfied"; echo "$OUT"; exit 1; }
grep -q "\"event\": \"satisfied\", \"id\": \"$TARGET\"" "$CONTRACTS_STORE" \
  || { echo "FAIL: satisfied row not written for $TARGET (no active inhibition)"; exit 1; }
echo "evidence: target satisfies normally when no inhibitor is active  OK"

# Reset for next test: new target + inhibitors
TMP2=$(mktemp -d)
export CONTRACTS_STORE="$TMP2/ledger.jsonl"
trap 'rm -rf "$TMP" "$TMP2"' EXIT

TARGET2=$(bash "$C" declare "inhibitsgate target 2" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
INH3=$(bash "$C" declare "inhibitsgate active suppressor" --action true --no-drive --inhibits "$TARGET2" 2>/dev/null | awk '/^declared:/{print $2}')
INH4=$(bash "$C" declare "inhibitsgate second active suppressor" --action true --no-drive --inhibits "$TARGET2" 2>/dev/null | awk '/^declared:/{print $2}')

# satisfy both inhibitors
bash "$C" iterate "$INH3" >/dev/null 2>&1
bash "$C" _mark "$INH3" satisfied --proof "inh3 fires" >/dev/null 2>&1
bash "$C" iterate "$INH4" >/dev/null 2>&1
bash "$C" _mark "$INH4" satisfied --proof "inh4 fires" >/dev/null 2>&1

# 3. now target should REFUSE
bash "$C" iterate "$TARGET2" >/dev/null 2>&1
set +e
REFUSE_OUT=$(bash "$C" _mark "$TARGET2" satisfied --proof "test: should be refused" 2>&1)
REFUSE_EC=$?
set -e
[ "$REFUSE_EC" -ne 0 ] || { echo "FAIL: target was satisfied despite 2 active inhibitors"; echo "$REFUSE_OUT"; exit 1; }
echo "$REFUSE_OUT" | grep -qi "INHIBITION REFUSAL\|inhibitor" \
  || { echo "FAIL: refusal output missing INHIBITION REFUSAL banner"; echo "$REFUSE_OUT"; exit 1; }
# no satisfied row appended for target
if grep -q "\"event\": \"satisfied\", \"id\": \"$TARGET2\"" "$CONTRACTS_STORE"; then
  echo "FAIL: satisfied row written for $TARGET2 despite refusal"
  exit 1
fi
echo "evidence: _mark refused with INHIBITION REFUSAL output, no row written  OK"

# 4. refusal names BOTH inhibitor ids
echo "$REFUSE_OUT" | grep -q "$INH3" || { echo "FAIL: $INH3 not named in refusal output"; echo "$REFUSE_OUT"; exit 1; }
echo "$REFUSE_OUT" | grep -q "$INH4" || { echo "FAIL: $INH4 not named in refusal output"; echo "$REFUSE_OUT"; exit 1; }
echo "evidence: refusal names both active inhibitors  OK"

# 5. supersede one inhibitor; target should STILL be refused (the other is active)
# Then supersede the second; target should now satisfy.
WINNER=$(bash "$C" declare "inhibitsgate winner" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
bash "$C" iterate "$WINNER" >/dev/null 2>&1
bash "$C" _mark "$WINNER" satisfied --proof "ok" >/dev/null 2>&1
bash "$C" supersede "$INH3" "$WINNER" --reason "test release" >/dev/null 2>&1

set +e
STILL=$(bash "$C" _mark "$TARGET2" satisfied --proof "one inhibitor released, one remains" 2>&1)
STILL_EC=$?
set -e
[ "$STILL_EC" -ne 0 ] || { echo "FAIL: target satisfied after only 1 of 2 inhibitors released"; echo "$STILL"; exit 1; }
echo "evidence: still refused with 1 of 2 inhibitors released  OK"

bash "$C" supersede "$INH4" "$WINNER" --reason "test release 2" >/dev/null 2>&1
RELEASED=$(bash "$C" _mark "$TARGET2" satisfied --proof "all inhibitors released" 2>&1)
RELEASED_EC=$?
[ "$RELEASED_EC" -eq 0 ] || { echo "FAIL: target STILL refused after all inhibitors released"; echo "$RELEASED"; exit 1; }
grep -q "\"event\": \"satisfied\", \"id\": \"$TARGET2\"" "$CONTRACTS_STORE" \
  || { echo "FAIL: satisfied row not appended after release"; exit 1; }
echo "evidence: target satisfies once all inhibitors released  OK"

echo "PASS: inhibits — field stored, fires-when-clear, refuses-when-blocked, names inhibitors, lifts on supersede."
exit 0
