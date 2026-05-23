#!/usr/bin/env bash
# verify.sh — proves the natural-selection lifecycle end to end:
#   1. declare surfaces a contradicting past contract
#   2. supersede retires the loser to a `merged` fossil
#   3. the fossil never resurfaces in habit surfacing
#   4. the append-only ledger still holds the fossil's rows
# Uses the REAL global ledger with nonce-tagged test contracts. The agent
# renders KEY 2.
set -uo pipefail

CONTRACT="$HOME/.claude/skills/contract/scripts/contract"
LIB="$HOME/.claude/skills/contract/scripts/lib"
DETECT="$HOME/.claude/skills/contract/scripts/contract-habit-detect.py"
export CONTRACTS_STORE="${CONTRACTS_STORE:-$HOME/.contracts/contracts.jsonl}"
NONCE="lifecyclegate_selftest_$$"

# 1. declare contract A on a unique claim.
AID=$(bash "$CONTRACT" declare "$NONCE always prefer the alpha approach for the probe" \
        --action agent-judges 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$AID" ] || { echo "FAIL: could not declare contract A"; exit 1; }
echo "evidence: declared A=$AID"

# 2. declare contract B on the contradicting claim — declare MUST surface A.
OUT=$(bash "$CONTRACT" declare "$NONCE never prefer the alpha approach for the probe" \
        --action agent-judges 2>/dev/null)
BID=$(echo "$OUT" | awk '/^declared:/{print $2}')
[ -n "$BID" ] || { echo "FAIL: could not declare contract B"; exit 1; }
case "$OUT" in
  *"lifecycle check (natural selection)"*) ;;
  *) echo "FAIL: declare did not surface the lifecycle check"; echo "$OUT"; exit 1 ;;
esac
case "$OUT" in
  *"$AID"*) echo "evidence: B's declare surfaced contradiction candidate A=$AID  OK" ;;
  *) echo "FAIL: declare surfacing did not name the contradicting contract A"; exit 1 ;;
esac

# 3. supersede A by B — A becomes a merged fossil.
bash "$CONTRACT" supersede "$AID" "$BID" --reason "self-test: B wins" >/dev/null 2>&1 \
  || { echo "FAIL: supersede verb errored"; exit 1; }
STATUS=$(MH_ID="$AID" PYTHONPATH="$LIB" python3 -c \
  "import os; from contract_core import get; print((get(os.environ['MH_ID']) or {}).get('status','?'))")
[ "$STATUS" = "merged" ] || { echo "FAIL: A status='$STATUS', expected 'merged'"; exit 1; }
echo "evidence: supersede retired A -> status=merged  OK"

# 4. the merged fossil must NOT resurface in habit surfacing.
HAB=$(PYTHONPATH="$LIB" python3 "$DETECT" \
  --context "$NONCE always prefer the alpha approach for the probe" --threshold 0.3 2>/dev/null)
case "$HAB" in
  *"$AID"*) echo "FAIL: superseded fossil A=$AID still surfaces in habit"; exit 1 ;;
  *) echo "evidence: merged fossil A excluded from habit surfacing  OK" ;;
esac

# 5. the ledger still HOLDS A's rows — a fossil is kept, never deleted.
if ! grep -q "\"$AID\"" "$CONTRACTS_STORE" 2>/dev/null; then
  echo "FAIL: A's rows missing from the ledger — fossil was deleted"; exit 1
fi
echo "evidence: A's rows still in the append-only ledger (fossil kept)  OK"

echo "PASS: declare surfaces contradictions; supersede retires the loser to a merged fossil that never resurfaces; the ledger keeps the fossil."
exit 0
