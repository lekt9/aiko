#!/bin/bash
# ARC-AGI-3 F5: contract:/value-of: must NOT surface a DEAD producer's bytes.
#
# Fork F5 (value-surface death-blindness). contract:X and value-of:X surfaced
# latestActionResult BEFORE any terminal check, so a producer that was satisfied
# and then DIED still leaked its stale bytes to the consumer as PASS. The fix
# gates surfacing behind isSatisfied(target) — a dead/purged producer's latest
# terminal nullifies, so its value is no longer adopted (matches fulfil:, which
# already gated first). Biology: adopt a value only from a signal that holds NOW.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

BYTES="STALE_DEAD_BYTES"

echo "=== ARC-AGI-3 F5: contract:/value-of: don't surface a dead producer ==="
arc_init

# Producer satisfied with bytes, then DIED (nulling terminal after satisfaction).
prod=$(arc_declare 'arc-prod: soon-dead producer' 'neuron')
arc_satisfy "$prod" "$BYTES"
printf '%s\n' "{\"event\":\"died\",\"id\":\"$prod\",\"wave\":2,\"cause\":\"apoptosed\",\"ts\":\"2026-07-14T00:00:02Z\"}" >> "$ARC_LEDGER"
echo "producer  $prod  satisfied then DIED"

for verb in contract value-of; do
  cons=$(arc_declare "$verb:$prod")
  echo "$verb consumer $cons"
  got=$(arc_result_of "$cons")
  if [ "$got" = "$BYTES" ]; then
    echo "FAIL: $verb:$prod surfaced the DEAD producer's stale bytes ($got)"
    exit 1
  fi
  if arc_is_satisfied "$cons"; then
    echo "FAIL: $verb consumer $cons resolved satisfied over a dead producer"
    exit 1
  fi
done

echo "PASS: neither contract: nor value-of: surfaced a dead producer's bytes"
