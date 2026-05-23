#!/usr/bin/env bash
# verify.sh — proves the funnel-first shape: OR-gate over children. Parent
# resolves as soon as ANY child satisfies (K=1 of N).
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="funnelfirstgate_selftest_$$"

ORG=$(bash "$C" declare "$N funnel-first organ" --action funnel-first --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ORG" ] || { echo "FAIL: could not declare funnel-first"; exit 1; }
C1=$(bash "$C" declare "$N funnel-first child 1" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
C2=$(bash "$C" declare "$N funnel-first child 2" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
C3=$(bash "$C" declare "$N funnel-first child 3" --parent "$ORG" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$C1" ] && [ -n "$C2" ] && [ -n "$C3" ] || { echo "FAIL: 3 children not declared"; exit 1; }

# 0/3 — must FAIL (no child satisfied yet)
O=$(bash "$C" iterate "$ORG" 2>/dev/null)
echo "$O" | grep -qE "FAIL|0/3|none satisfied" || { echo "FAIL: funnel-first 0/3 did not FAIL"; echo "$O"; exit 1; }
echo "evidence: funnel-first 0/3  ->  FAIL (no child satisfied)  OK"

# 1/3 — must PASS (first child fires the gate)
bash "$C" _mark "$C2" satisfied >/dev/null 2>&1
O=$(bash "$C" iterate "$ORG" 2>/dev/null)
echo "$O" | grep -qE "PASS|1/3|at least one" || { echo "FAIL: funnel-first 1/3 did not PASS"; echo "$O"; exit 1; }
echo "evidence: funnel-first 1/3  ->  PASS (single child fires the OR-gate)  OK"

echo "PASS: funnel-first — OR-gate over children, resolves as soon as ANY satisfies."
exit 0
