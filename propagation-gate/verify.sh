#!/usr/bin/env bash
# verify.sh — proves that marking a contract satisfied propagates the signal:
# the wavefront (parent organ, contract:<id> referrers, corroborated
# synapses) is surfaced, so a state change is no longer inert.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
LIB="$HOME/.claude/skills/contract/scripts/lib"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
N="propgate_selftest_$$"

P=$(bash "$C" declare "$N parent organ" --action funnel 2>/dev/null | awk '/^declared:/{print $2}')
CH=$(bash "$C" declare "$N child leaf" --parent "$P" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$P" ] && [ -n "$CH" ] || { echo "FAIL: could not declare parent/child"; exit 1; }
REF=$(bash "$C" declare "$N referrer that depends on the leaf" --action "contract:$CH" 2>/dev/null | awk '/^declared:/{print $2}')
SYN=$(bash "$C" declare "$N synapse partner" --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$REF" ] && [ -n "$SYN" ] || { echo "FAIL: could not declare referrer/synapse"; exit 1; }

# wire the synapse directly via core (corroborate has no CLI verb)
MH_A="$CH" MH_B="$SYN" PYTHONPATH="$LIB" python3 -c \
  "import os; from contract_core import corroborate; corroborate(os.environ['MH_A'], os.environ['MH_B'])" \
  || { echo "FAIL: could not wire the synapse"; exit 1; }
echo "evidence: parent=$P child=$CH referrer=$REF synapse=$SYN wired"

# mark the leaf satisfied — the action potential. The wavefront must surface.
OUT=$(bash "$C" _mark "$CH" satisfied 2>/dev/null)
case "$OUT" in
  *"PROPAGATION (signal)"*) echo "evidence: _mark satisfied emitted the PROPAGATION block  OK" ;;
  *) echo "FAIL: no PROPAGATION block"; echo "$OUT"; exit 1 ;;
esac
case "$OUT" in *"$P"*) echo "evidence: wavefront carries the parent organ $P  OK" ;;
  *) echo "FAIL: parent $P absent from wavefront"; echo "$OUT"; exit 1 ;; esac
case "$OUT" in *"$REF"*) echo "evidence: wavefront carries the unblocked referrer $REF  OK" ;;
  *) echo "FAIL: referrer $REF absent from wavefront"; echo "$OUT"; exit 1 ;; esac
case "$OUT" in *"$SYN"*) echo "evidence: wavefront carries the corroborated synapse $SYN  OK" ;;
  *) echo "FAIL: synapse $SYN absent from wavefront"; echo "$OUT"; exit 1 ;; esac

echo "PASS: marking satisfied propagates the signal — parent, referrers, synapses all surface."
exit 0
