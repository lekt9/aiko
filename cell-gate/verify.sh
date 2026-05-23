#!/usr/bin/env bash
# verify.sh — proves the cell shape: action is a shell command, iterate runs
# it, exit 0 -> KEY 1 PASS, non-zero -> KEY 1 FAIL. _mark records satisfied
# regardless of action's exit (KEY 2 is the agent, not the script).
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="cellgate_selftest_$$"

# 1. cell with action 'true' -> PASS on iterate
GREEN=$(bash "$C" declare "$N cell green" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$GREEN" ] || { echo "FAIL: could not declare green cell"; exit 1; }
O=$(bash "$C" iterate "$GREEN" 2>/dev/null)
echo "$O" | grep -q "result: PASS" || { echo "FAIL: green cell did not PASS"; echo "$O"; exit 1; }
echo "evidence: cell --action true  ->  result: PASS  OK"

# 2. cell with action 'false' -> FAIL on iterate
RED=$(bash "$C" declare "$N cell red" --action false --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$RED" ] || { echo "FAIL: could not declare red cell"; exit 1; }
O=$(bash "$C" iterate "$RED" 2>/dev/null)
echo "$O" | grep -q "result: FAIL" || { echo "FAIL: red cell did not FAIL"; echo "$O"; exit 1; }
echo "evidence: cell --action false  ->  result: FAIL  OK"

# 3. _mark satisfied appends a satisfied row (substrate principle: only agent satisfies)
bash "$C" _mark "$GREEN" satisfied --proof-skip "shape-gate self-test" >/dev/null 2>&1
grep -c "\"event\": *\"satisfied\".*\"id\": *\"$GREEN\"\|\"id\": *\"$GREEN\".*\"event\": *\"satisfied\"" "$CONTRACTS_STORE" \
  | grep -qE '^[1-9]' || { echo "FAIL: no satisfied row for $GREEN"; exit 1; }
echo "evidence: _mark satisfied  ->  ledger row written  OK"

echo "PASS: cell — action is a shell command; iterate exits drive KEY 1; _mark drives KEY 2."
exit 0
