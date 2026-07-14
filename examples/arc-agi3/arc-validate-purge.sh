#!/bin/bash
# ARC-AGI-3 temporal-coherence E2E: a PURGED producer must not surface bytes.
#
# Claim under test: a producer that was satisfied and then purged (the Decalogue
# nulling terminal) is NOT satisfied now. A fulfil:<producer> consumer must
# therefore HOLD, not adopt the dead producer's bytes.
#
# This is the lost sheep from Step 5: isSatisfied walked only satisfied/died and
# stepped past a later `purged`, hitting the older `satisfied` and returning true
# — surfacing stale bytes. cache.zig:terminalClass already knew purged nullifies;
# isSatisfied was the one blind read surface. Without the fix this exits 1.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

BYTES="SECRET_PURGED_BYTES"

echo "=== ARC-AGI-3: satisfied-then-purged producer must not surface ==="
arc_init

prod=$(arc_declare 'arc-prod: soon-purged producer' 'neuron')
arc_satisfy "$prod" "$BYTES"
# Later purged terminal — the Decalogue nulling event. Append AFTER satisfied.
printf '%s\n' "{\"event\":\"purged\",\"id\":\"$prod\",\"wave\":2,\"commandment\":1,\"ts\":\"2026-07-14T00:00:01Z\"}" >> "$ARC_LEDGER"
echo "producer  $prod  satisfied then PURGED"

cons=$(arc_declare "fulfil:$prod")
echo "waiter    $cons   action=fulfil:$prod"
grep -E 'result:' "$ARC_EV" | head -3 || true

# The consumer must NOT carry the purged producer's bytes, and must NOT satisfy.
got=$(arc_result_of "$cons")
if [ "$got" = "$BYTES" ]; then
  echo "FAIL: waiter $cons adopted PURGED producer's bytes ($got) — stale truth surfaced"
  exit 1
fi
if arc_is_satisfied "$cons"; then
  echo "FAIL: waiter $cons resolved satisfied on a purged producer"
  exit 1
fi

echo "PASS: purged producer nullified — waiter held, no stale bytes surfaced"
