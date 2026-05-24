#!/bin/bash
# Ω3 root-anchored rewake check:
#   1) invocation_root() walks parent chain to topmost ancestor
#   2) wavefront() returns root field when root != self AND not satisfied
#   3) `_mark satisfied` surfaces "=== Ω3 ROOT REWAKE ===" block in that case
set -e
TMP="$(mktemp -d)"
export CONTRACTS_STORE="$TMP/store.jsonl"
C=~/.claude/skills/contract/scripts/contract
# build R -> O -> L
ROOT=$($C declare "root org for rewake test" --action funnel --no-drive 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
ORG=$($C declare "mid org" --action funnel --parent "$ROOT" 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
LEAF=$($C declare "leaf cell" --action "true" --parent "$ORG" 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
$C iterate "$LEAF" >/dev/null 2>&1
OUT=$($C _mark "$LEAF" satisfied --proof "root rewake gate test" 2>&1)
echo "$OUT" | grep -q "Ω3 ROOT REWAKE" || { echo "FAIL: no Ω3 ROOT REWAKE block in mark output"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -q "$ROOT" || { echo "FAIL: root id not surfaced"; exit 1; }
echo "PASS: Ω3 root-rewake fires"
