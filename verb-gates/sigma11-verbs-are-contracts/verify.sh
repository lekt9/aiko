#!/bin/bash
# Σ11 verbs-are-contracts gate
set -e
C=~/.claude/skills/contract/scripts/contract
SELF=$($C self 2>&1)
# declare/iterate/self visible in self-introspection; _mark intentionally hidden
for v in declare iterate self; do
  echo "$SELF" | grep -q "\\b$v\\b" || { echo "FAIL: bootstrap verb '$v' missing from self"; exit 1; }
done
# _mark works (proves bootstrap even though hidden)
$C _mark deadbeef satisfied 2>&1 | grep -qE "PROOF|not found" || { echo "FAIL: _mark bootstrap broken"; exit 1; }
# governing contracts exist
$C search --context "verb:declare bootstrap-floor" 2>&1 | grep -q "verb:declare" || { echo "FAIL: no verb:declare contract"; exit 1; }
$C search --context "verb:layer Ω5" 2>&1 | grep -q "verb:layer" || { echo "FAIL: no verb:layer contract"; exit 1; }
# migrated verbs still function
$C layer "test claim must hold" 2>&1 | grep -q "primary:" || { echo "FAIL: verb:layer broken"; exit 1; }
$C face 2>&1 | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['identity']['public_face']=='Aiko'" || { echo "FAIL: verb:face broken"; exit 1; }
echo "PASS: Σ11 — bootstrap floor (4) + migrated verbs (2) governed by contract rows"
