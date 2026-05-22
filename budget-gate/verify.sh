#!/usr/bin/env bash
# verify.sh — proves a contract can carry an effort --budget and that
# iterate surfaces wave-vs-budget as evidence (never an auto-verdict).
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
LIB="$HOME/.claude/skills/contract/scripts/lib"
export CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl"
N="budgetgate_selftest_$$"

ID=$(bash "$C" declare "$N budget probe contract" --action agent-judges --budget 2 2>/dev/null \
       | awk '/^declared:/{print $2}')
[ -n "$ID" ] || { echo "FAIL: could not declare with --budget"; exit 1; }

B=$(MH_ID="$ID" PYTHONPATH="$LIB" python3 -c \
  "import os; from contract_core import get; print((get(os.environ['MH_ID']) or {}).get('budget'))")
[ "$B" = "2" ] || { echo "FAIL: get() budget='$B', expected 2"; exit 1; }
echo "evidence: --budget 2 stored on the row and returned by get()  OK"

O1=$(bash "$C" iterate "$ID" 2>/dev/null)
case "$O1" in
  *"budget: wave 1 of 2"*) echo "evidence: wave 1 surfaced 'wave 1 of 2'  OK" ;;
  *) echo "FAIL: wave 1 budget line missing"; echo "$O1"; exit 1 ;;
esac
case "$O1" in
  *"OVER BUDGET"*) echo "FAIL: wave 1 wrongly flagged over budget"; exit 1 ;;
esac

bash "$C" iterate "$ID" >/dev/null 2>&1   # wave 2 — at budget

O3=$(bash "$C" iterate "$ID" 2>/dev/null) # wave 3 — over budget
case "$O3" in
  *"wave 3 of 2 — OVER BUDGET"*) echo "evidence: wave 3 surfaced OVER BUDGET  OK" ;;
  *) echo "FAIL: wave 3 not flagged over budget"; echo "$O3"; exit 1 ;;
esac

echo "PASS: --budget stores an effort budget; iterate surfaces wave-vs-budget as evidence only."
exit 0
