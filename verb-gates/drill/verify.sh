#!/usr/bin/env bash
# verb-gate: drill — synchronous in-thread while-loop driver across N target
# contract ids. Delegates per-id to drive-watch.
# Proves:
#   1. usage prints to stderr and exits 2 when called with no ids
#   2. drill on a single already-satisfied id is a no-op (carve-out) and exits 0
#   3. drill on multiple cells with --auto-mark-cells settles all and exits 0
#   4. drill on an unknown id exits 2 with a clear error
#   5. drill on a pending-only id (no LLM, no auto-mark) leaves it pending and exits 1
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
LIB="$HOME/.claude/skills/contract/scripts/lib"   # capture BEFORE HOME swap
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME/.contracts" "$HOME/proj"
GLOBAL="$HOME/.contracts/contracts.jsonl"
touch "$GLOBAL"
export CONTRACTS_STORE="$GLOBAL"
# Ensure Λ1 path is off so --auto-judge doesn't fire in the gate (no codex shim, no URL).
# The gate never passes --auto-judge so this is belt-and-suspenders; PATH stays inherited
# (contract_core requires Python ≥3.10 PEP-604 syntax — system /usr/bin/python3 is 3.9 on mac).
unset CONTRACT_LLM_URL CONTRACT_LLM_KEY CONTRACT_LLM_VIA

# 1. usage on no ids
OUT=$(bash "$C" drill 2>&1) && { echo "FAIL: drill with no ids should exit non-zero"; exit 1; }
RC=$?
[ "$RC" -eq 2 ] || { echo "FAIL: drill no-ids expected exit 2, got $RC"; exit 1; }
echo "$OUT" | grep -q "usage: contract drill" || { echo "FAIL: no usage in stderr"; echo "$OUT"; exit 1; }
echo "evidence: drill no-args → usage + exit 2  OK"

# 2. carve-out: already-satisfied id is a no-op, exit 0
ID1=$(bash "$C" declare "drill_gate already-satisfied cell" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID1" ] || { echo "FAIL: declare returned no id"; exit 1; }
bash "$C" _mark "$ID1" satisfied --proof "gate pre-fill" >/dev/null 2>&1
bash "$C" drill "$ID1" >/dev/null 2>&1
RC=$?
[ "$RC" -eq 0 ] || { echo "FAIL: drill on satisfied id expected exit 0, got $RC"; exit 1; }
echo "evidence: drill on already-satisfied id is a no-op exit 0  OK"

# 3. drill on multiple mechanical cells with --auto-mark-cells settles all
ID2=$(bash "$C" declare "drill_gate cell A" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
ID3=$(bash "$C" declare "drill_gate cell B" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID2" ] && [ -n "$ID3" ] || { echo "FAIL: declare returned no id"; exit 1; }
bash "$C" drill "$ID2" "$ID3" --auto-mark-cells --max-waves 5 >/dev/null 2>&1
RC=$?
[ "$RC" -eq 0 ] || { echo "FAIL: drill cells with --auto-mark-cells expected exit 0, got $RC"; exit 1; }
# Confirm both got marked satisfied
for id in "$ID2" "$ID3"; do
  STATUS=$(PYTHONPATH="$LIB" python3 -c "from contract_core import get; r = get('$id'); print(r['status'] if r else 'MISSING')")
  [ "$STATUS" = "satisfied" ] || { echo "FAIL: $id expected satisfied, got $STATUS"; exit 1; }
done
echo "evidence: drill --auto-mark-cells settled both cells, exit 0  OK"

# 4. drill on unknown id
OUT=$(bash "$C" drill "deadbeef" 2>&1)
RC=$?
[ "$RC" -eq 2 ] || { echo "FAIL: drill unknown id expected exit 2, got $RC"; exit 1; }
echo "$OUT" | grep -q "not found in ledger" || { echo "FAIL: drill unknown id missing 'not found' message"; echo "$OUT"; exit 1; }
echo "evidence: drill on unknown id → exit 2 + clear error  OK"

# 5. drill on a pending cell WITHOUT --auto-mark-cells: stays pending, exit 1
ID4=$(bash "$C" declare "drill_gate pending without automark" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ID4" ] || { echo "FAIL: declare returned no id"; exit 1; }
bash "$C" drill "$ID4" --max-waves 3 >/dev/null 2>&1
RC=$?
STATUS=$(PYTHONPATH="$LIB" python3 -c "from contract_core import get; r = get('$id4' if False else '$ID4'); print(r['status'] if r else 'MISSING')")
# Without --auto-mark-cells, drive-watch HALTS after cell PASS waiting for KEY 2.
# So $ID4 stays in pending/active state, drill exits 1 (any-pending).
[ "$RC" -eq 1 ] || { echo "FAIL: drill pending-no-automark expected exit 1, got $RC"; exit 1; }
case "$STATUS" in
  satisfied|merged|rejected)
    echo "FAIL: drill pending-no-automark should NOT have settled $ID4 (status=$STATUS)"; exit 1 ;;
esac
echo "evidence: drill without --auto-mark-cells leaves cell pending, exit 1  OK"

echo "PASS: verb-gates/drill"
