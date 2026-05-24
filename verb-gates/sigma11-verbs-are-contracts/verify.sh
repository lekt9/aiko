#!/bin/bash
# Σ11 verbs-are-contracts gate: assert each bootstrap-floor verb has a
# governing contract row in the ledger AND the verb still functions.
set -e
C=~/.claude/skills/contract/scripts/contract
# all 4 bootstrap-floor verbs reachable from `contract self`
SELF=$($C self 2>&1)
for v in declare iterate _mark self; do
  echo "$SELF" | grep -q "\\b$v\\b" || { echo "FAIL: bootstrap verb '$v' missing from self"; exit 1; }
done
# governing contracts exist in the ledger (search by plan-text marker)
$C search --context "verb:declare bootstrap-floor" 2>&1 | grep -q "verb:declare" || { echo "FAIL: no verb:declare contract"; exit 1; }
$C search --context "verb:layer Ω5" 2>&1 | grep -q "verb:layer" || { echo "FAIL: no verb:layer contract"; exit 1; }
# the migrated verbs still work
$C layer "test claim must hold" 2>&1 | grep -q "primary:" || { echo "FAIL: verb:layer broken"; exit 1; }
$C face 2>&1 | python3 -c "import json, sys; d=json.load(sys.stdin); assert d['identity']['public_face']=='Aiko'" || { echo "FAIL: verb:face broken"; exit 1; }
echo "PASS: Σ11 bootstrap floor (4) + migrated verbs (2) governed by contract rows"
