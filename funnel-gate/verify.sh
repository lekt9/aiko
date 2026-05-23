#!/usr/bin/env bash
# verify.sh — proves the funnel shape: AND-gate over children. Parent is
# pending while any child is unsatisfied; resolves when ALL N satisfy.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="funnelgate_selftest_$$"

ORG=$(bash "$C" declare "$N funnel organ" --action funnel --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ORG" ] || { echo "FAIL: could not declare funnel"; exit 1; }
C1=$(bash "$C" declare "$N funnel child 1" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
C2=$(bash "$C" declare "$N funnel child 2" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
C3=$(bash "$C" declare "$N funnel child 3" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$C1" ] && [ -n "$C2" ] && [ -n "$C3" ] || { echo "FAIL: 3 children not declared"; exit 1; }

# 0/3 — must FAIL
O=$(bash "$C" iterate "$ORG" 2>/dev/null)
echo "$O" | grep -qE "FAIL|0/3|not all children" || { echo "FAIL: funnel 0/3 did not FAIL"; echo "$O"; exit 1; }
echo "evidence: funnel 0/3 satisfied  ->  FAIL  OK"

# 1/3 — still FAIL
bash "$C" _mark "$C1" satisfied >/dev/null 2>&1
O=$(bash "$C" iterate "$ORG" 2>/dev/null)
echo "$O" | grep -qE "FAIL|1/3|not all children" || { echo "FAIL: funnel 1/3 did not FAIL"; echo "$O"; exit 1; }
echo "evidence: funnel 1/3  ->  still FAIL  OK"

# 3/3 — must PASS
bash "$C" _mark "$C2" satisfied >/dev/null 2>&1
bash "$C" _mark "$C3" satisfied >/dev/null 2>&1
O=$(bash "$C" iterate "$ORG" 2>/dev/null)
echo "$O" | grep -qE "PASS|3/3|all children satisfied" || { echo "FAIL: funnel 3/3 did not PASS"; echo "$O"; exit 1; }
echo "evidence: funnel 3/3  ->  PASS  OK"

echo "PASS: funnel — AND-gate over children, resolves only when ALL satisfy."
exit 0
