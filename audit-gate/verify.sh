#!/usr/bin/env bash
# verify.sh — proves `contract audit <id> --auditors N` declares an audit
# organ under the target and fans out N cold falsifier directives.
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
LIB="$HOME/.claude/skills/contract/scripts/lib"
export CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl"
N="auditgate_selftest_$$"

T=$(bash "$C" declare "$N target contract to be audited" --action agent-judges 2>/dev/null \
      | awk '/^declared:/{print $2}')
[ -n "$T" ] || { echo "FAIL: could not declare the audit target"; exit 1; }

OUT=$(bash "$C" audit "$T" --auditors 3 2>/dev/null)
case "$OUT" in
  *"FALSIFIER AUDIT REQUIRED"*) echo "evidence: audit emitted the AUDIT REQUIRED prompt  OK" ;;
  *) echo "FAIL: no AUDIT REQUIRED block"; echo "$OUT"; exit 1 ;;
esac

NA=$(echo "$OUT" | grep -c 'cold auditor')
[ "$NA" = "3" ] || { echo "FAIL: expected 3 cold-auditor directives, got $NA"; echo "$OUT"; exit 1; }
echo "evidence: 3 cold-auditor falsifier directives emitted  OK"

AORG=$(echo "$OUT" | awk '/audit organ:/{print $3}')
[ -n "$AORG" ] || { echo "FAIL: no audit organ id in output"; exit 1; }
PARENT=$(MH_ID="$AORG" PYTHONPATH="$LIB" python3 -c \
  "import os; from contract_core import get; print((get(os.environ['MH_ID']) or {}).get('parent_id'))")
[ "$PARENT" = "$T" ] || { echo "FAIL: audit organ parent is '$PARENT', expected $T"; exit 1; }
echo "evidence: audit organ $AORG is a funnel child of target $T  OK"

echo "PASS: audit declares an audit organ under the target and fans out N cold falsifiers."
exit 0
