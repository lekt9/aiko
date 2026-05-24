#!/bin/bash
# Ω5 layer-identify gate: contract layer <text> classifies at L0..L4
set -e
C=~/.claude/skills/contract/scripts/contract
OUT_INTENT=$($C layer "i want users to feel like they're talking to a real person" 2>&1)
echo "$OUT_INTENT" | grep -q "primary: L4" || { echo "FAIL: intent not L4"; echo "$OUT_INTENT"; exit 1; }
OUT_MECH=$($C layer "exit code 1 from cwd /tmp/run.sh path missing stderr 502" 2>&1)
echo "$OUT_MECH" | grep -q "primary: L0" || { echo "FAIL: mech not L0"; echo "$OUT_MECH"; exit 1; }
OUT_SUB=$($C layer "iterate the funnel cell then mark satisfied" 2>&1)
echo "$OUT_SUB" | grep -q "primary: L1" || { echo "FAIL: substrate not L1"; echo "$OUT_SUB"; exit 1; }
OUT_CLAIM=$($C layer "this invariant must always hold and pass the proof" 2>&1)
echo "$OUT_CLAIM" | grep -q "primary: L3" || { echo "FAIL: claim not L3"; echo "$OUT_CLAIM"; exit 1; }
echo "$OUT_INTENT" | grep -q "human-replicating resolution order" || { echo "FAIL: missing ladder"; exit 1; }
echo "PASS: layer classifier across L0/L1/L3/L4"
