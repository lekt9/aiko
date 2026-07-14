#!/bin/bash
# ARC-AGI-3 Phase-2 E2E: self-fulfilling return over fulfil:<id>.
#
# Claims under test:
#   1. A consumer whose action is fulfil:<producer> HOLDs while the producer is
#      unsettled — it does not fail, and it does not pass early.
#   2. Once the producer is terminal, the same claim adopts the producer's bytes
#      and resolves satisfied.
#
# (1) is the half the old validator never checked: a fulfil that passed
# unconditionally would have looked identical to a correct one.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

BYTES="ARC_OK_42"

echo "=== ARC-AGI-3 Phase 2: fulfilment (HOLD until terminal, then adopt) ==="
arc_init

# --- 1. the waiter must HOLD on an unsettled producer -----------------------
pending=$(arc_declare 'arc-prod: unsettled producer' 'neuron')
waiter=$(arc_declare "fulfil:$pending")
echo "producer  $pending  (declared, NOT satisfied)"
echo "waiter    $waiter   action=fulfil:$pending"

if arc_is_satisfied "$waiter"; then
  echo "FAIL: waiter $waiter resolved satisfied while its producer was unsettled"
  exit 1
fi
if ! grep -q "fulfil waiting on" "$ARC_EV"; then
  echo "FAIL: expected a HOLD on the unsettled producer; evidence was:"
  grep -E 'result:' "$ARC_EV" | head -3
  exit 1
fi
echo "  -> HOLD as required (waiter is blocked, not failed)"

# --- 2. settle a producer; the waiter must adopt its bytes ------------------
prod=$(arc_declare 'arc-prod: grid producer' 'neuron')
arc_satisfy "$prod" "$BYTES"
echo "producer  $prod  satisfied with $BYTES"

cons=$(arc_declare "fulfil:$prod")
echo "waiter    $cons   action=fulfil:$prod"
grep -E 'result:' "$ARC_EV" | head -3 || true

got=$(arc_result_of "$cons")
if [ "$got" != "$BYTES" ]; then
  echo "FAIL: waiter $cons carries result=${got:-<none>}, expected $BYTES"
  exit 1
fi
if ! arc_is_satisfied "$cons"; then
  echo "FAIL: waiter $cons surfaced the value but never reached satisfied"
  exit 1
fi

echo "PASS: fulfil HELD on an unsettled producer, then adopted $got and resolved satisfied"
