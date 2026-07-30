#!/bin/bash
# ARC-AGI-3 Phase-1 E2E: an approved pointer surfaces its target's value.
#
# Claim under test: a consumer whose action is contract:<producer> adopts the
# producer's action_result once the producer is terminal.
#
# The assertion is on the CONSUMER's own rows. Bytes appended to the producer
# by this script are never accepted as evidence for the consumer — that was the
# defect that kept the old validator green while the path was untested.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

BYTES="ARC_OK_42"

echo "=== ARC-AGI-3 Phase 1: value surfacing over contract:<id> ==="
arc_init

prod=$(arc_declare 'arc-prod: grid producer' 'neuron')
arc_satisfy "$prod" "$BYTES"
echo "producer  $prod  satisfied with $BYTES"

cons=$(arc_declare "contract:$prod")
echo "consumer  $cons  action=contract:$prod"
grep -E 'result:' "$ARC_EV" | head -3 || true

got=$(arc_result_of "$cons")
if [ "$got" != "$BYTES" ]; then
  echo "FAIL: consumer $cons carries result=${got:-<none>}, expected $BYTES"
  exit 1
fi
if ! arc_is_satisfied "$cons"; then
  echo "FAIL: consumer $cons surfaced the value but never reached satisfied"
  exit 1
fi

echo "PASS: consumer adopted the producer's bytes ($got) and resolved satisfied"
