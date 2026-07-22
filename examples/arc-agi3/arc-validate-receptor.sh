#!/bin/bash
# ARC-AGI-3 F1: opt-in receptor — value adoption is OPEN by default, but a
# producer may declare a signed adoption grant to restrict WHO may adopt its
# value. Biology: a cell responds to a ligand only through a receptor it
# expresses; an undifferentiated cell is public until it declares specificity.
#
# Three properties, each a real failure mode of the gate:
#   A. restricted producer REFUSES a stranger (the receptor actually gates).
#   B. restricted producer ADMITS its grantee (specificity, not a blanket block).
#   C. a FORGED grant (authority_pubkey != producer's env_pubkey) confers
#      nothing — an attacker cannot mint their own grant to adopt a restricted
#      producer's value. This is the authority-binding security property.
#
# Default-open is covered by the other adoption validators (they adopt with no
# grants present); here every case has an opted-in producer.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

BYTES="RECEPTOR_ONLY_VALUE"
echo "=== ARC-AGI-3 F1: opt-in receptor gates value adoption ==="
arc_init

# Producer via a REAL declare so its row carries a genuine env_pubkey (the
# authority the grant binds to). Then satisfy it with concrete bytes.
# Both producers are declared FIRST (real declares → genuine env_pubkeys), and
# BOTH grants are written, BEFORE any consumer exists. Ordering is load-bearing:
# if a consumer resolved before the forged grant was present it would HOLD for
# the wrong reason (nothing to bind against), turning case C green regardless of
# the binding — a false pass. Every consumer must face the full grant set at its
# first and only resolution.
prod=$(arc_declare 'receptor producer' 'neuron')
arc_satisfy "$prod" "$BYTES"
prod2=$(arc_declare 'second producer' 'neuron')
echo "producer $prod satisfied with $BYTES; second authority $prod2 declared"

# Chosen consumer ids so grants can name a known grantee (real declares mint
# random ids we could not name in a grant issued beforehand).
friend=aa11bb22    # the grantee
stranger=cc33dd44  # not granted
attacker=ee55ff66  # tries to self-authorize via a forged cross-authority grant

# grant-adopt goes through the `contract` persona: the `contract-goal` persona compiles
# every non-declare arg as an LLM goal. Same root/HOME → same derived key, so
# authority binding matches each producer's declared env_pubkey.
ARC_CONTRACT="$ARC_ROOT/scripts/contract"
# Legit opt-in: only $friend may adopt $prod.
"$ARC_CONTRACT" grant-adopt "$prod" "$friend" >/dev/null 2>"$ARC_EV" || { echo "FAIL: grant-adopt errored"; cat "$ARC_EV"; exit 1; }
# Cross-authority forgery (isolates the binding, not just the signature): prod2
# VALIDLY signs a grant naming the attacker, scoped to prod. The signature
# verifies (prod2 really signed it), so signature-check alone would admit it —
# only authority binding (authority_pubkey must equal prod's env_pubkey) rejects.
"$ARC_CONTRACT" grant-adopt "$prod2" "$attacker" "$prod" >/dev/null 2>"$ARC_EV" || { echo "FAIL: prod2 grant-adopt errored"; cat "$ARC_EV"; exit 1; }
echo "opted in: grantee=$friend; forged cross-authority grant: prod2 signed one for attacker scoped to $prod"

# NOW declare the consumers (both grants already present).
{
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$friend\",\"plan\":\"grantee consumer\",\"action\":\"contract:$prod\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:02Z\"}"
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$stranger\",\"plan\":\"stranger consumer\",\"action\":\"contract:$prod\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:03Z\"}"
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$attacker\",\"plan\":\"attacker consumer\",\"action\":\"contract:$prod\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:04Z\"}"
} >> "$ARC_LEDGER"

# Single sweep resolves all three consumers with the full grant set present.
"$ARC_AIKO" 'trigger receptor sweep' --private >/dev/null 2>"$ARC_EV" || true

# A. stranger must NOT adopt.
if [ "$(arc_result_of "$stranger")" = "$BYTES" ]; then
  echo "FAIL(A): stranger $stranger adopted a receptor-restricted producer's bytes"
  exit 1
fi
if arc_is_satisfied "$stranger"; then
  echo "FAIL(A): stranger $stranger resolved satisfied over a restricted producer"
  exit 1
fi
echo "PASS(A): stranger refused"

# B. grantee MUST adopt.
if [ "$(arc_result_of "$friend")" != "$BYTES" ]; then
  echo "FAIL(B): grantee $friend did NOT adopt (got '$(arc_result_of "$friend")') — over-gated"
  exit 1
fi
echo "PASS(B): grantee adopted"

# C. attacker's forged grant confers nothing.
if [ "$(arc_result_of "$attacker")" = "$BYTES" ]; then
  echo "FAIL(C): attacker $attacker adopted via a FORGED grant — authority binding broken"
  exit 1
fi
echo "PASS(C): forged grant rejected"

echo "PASS: opt-in receptor gates adoption (stranger refused, grantee admitted, forgery rejected)"
