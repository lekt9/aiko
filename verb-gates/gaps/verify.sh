#!/bin/bash
# Β1 enforcement gate: contract gap shorthand declares DEFERRED-* row;
# contract gaps surfaces them. Assert both round-trip.
set -e
TMP=$(mktemp -d)
export CONTRACTS_STORE="$TMP/store.jsonl"
C=~/.claude/skills/contract/scripts/contract
TAG="GATE-TEST-$$"
ID=$($C gap "$TAG" "synthetic gap row for verify.sh" 2>&1 | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
[ -n "$ID" ] || { echo "FAIL: gap declare didn't return id"; exit 1; }
OUT=$($C gaps 2>&1)
echo "$OUT" | grep -q "Β1 OPEN GAPS" || { echo "FAIL: no header"; exit 1; }
echo "$OUT" | grep -q "$TAG" || { echo "FAIL: gap $TAG not surfaced"; echo "$OUT"; exit 1; }
echo "PASS: gap → row → gaps round-trip works"
