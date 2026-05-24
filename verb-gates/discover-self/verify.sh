#!/bin/bash
# Δ1 self-discovery gate:
#   `contract discover --self` surfaces FOUR dimensions (verbs, shapes,
#   verb-gates, doctrine refs) as a composed organism — proving /contract
#   discovers itself programmatically.
set -e
C=~/.claude/skills/contract/scripts/contract
OUT=$($C discover --self 2>&1)
echo "$OUT" | grep -q "Δ1 SELF-DISCOVERY" || { echo "FAIL: no Δ1 header"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "\[1\] verbs" || { echo "FAIL: dimension 1 missing"; exit 1; }
echo "$OUT" | grep -q "\[2\] shapes" || { echo "FAIL: dimension 2 missing"; exit 1; }
echo "$OUT" | grep -q "\[3\] verb-gates" || { echo "FAIL: dimension 3 missing"; exit 1; }
echo "$OUT" | grep -q "\[4\] doctrine refs" || { echo "FAIL: dimension 4 missing"; exit 1; }
echo "$OUT" | grep -q "composed-organism iterate" || { echo "FAIL: composition hint missing"; exit 1; }
echo "PASS: Δ1 self-discovery surfaces 4 dimensions"
