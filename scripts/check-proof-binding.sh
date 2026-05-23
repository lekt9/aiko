#!/usr/bin/env bash
# check-proof-binding.sh — guard the plan-fulfillment proof binding.
#
# Properties:
#   1. scripts/contract _mark verb refuses bare 'satisfied' marks (exit 2)
#      with a 'PROOF REQUIRED' structured prompt
#   2. _mark accepts --proof <text> and stores it on the satisfied row
#   3. _mark accepts --proof-skip <reason> and stores it on the row
#   4. contract_core.mark_satisfied accepts proof/proof_skip_reason params
#
# Runtime check against a tempdir-scoped ledger — never touches the global.
set -uo pipefail
CLI="$HOME/.claude/skills/contract/scripts/contract"
CORE="$HOME/.claude/skills/contract/scripts/lib/contract_core.py"

# (4) static: core function accepts the params
if ! grep -q 'def mark_satisfied(id: str, wave: int, proof' "$CORE"; then
  echo "FAIL: contract_core.mark_satisfied does not accept proof param" >&2
  exit 1
fi

# (1) bare mark refused
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT
CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" declare "proof-binding probe" --action true --no-drive >/dev/null 2>&1
TID=$(CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" list 2>&1 | grep -oE '[a-f0-9]{8}' | head -1)
CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" iterate "$TID" >/dev/null 2>&1

bare_out=$(CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" _mark "$TID" satisfied 2>&1)
bare_ec=$?
if [ "$bare_ec" -ne 2 ]; then
  echo "FAIL: bare _mark satisfied exited $bare_ec (expected 2)" >&2
  echo "  output: $bare_out" >&2
  exit 1
fi
if ! echo "$bare_out" | grep -q 'PROOF REQUIRED'; then
  echo "FAIL: bare _mark did not emit 'PROOF REQUIRED' prompt" >&2
  exit 1
fi

# (2) --proof mark accepted and stored
CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" _mark "$TID" satisfied --proof "the action ran and the plan demanded that exact triviality" >/dev/null 2>&1
proof_ec=$?
if [ "$proof_ec" -ne 0 ]; then
  echo "FAIL: --proof mark exited $proof_ec (expected 0)" >&2
  exit 1
fi
if ! grep '"event": "satisfied"' "$TMP/c.jsonl" | grep -q 'the action ran and the plan demanded'; then
  echo "FAIL: proof text not stored on satisfied row" >&2
  exit 1
fi

TID2=$(CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" declare "proof-skip probe" --action true --no-drive 2>&1 | grep -oE 'declared: [a-f0-9]{8}' | awk '{print $2}')
CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" declare "proof-skip probe" --action true --no-drive >/dev/null 2>&1
TID2=$(CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" list 2>&1 | grep -oE '\[active\] [a-f0-9]{8}' | grep -oE '[a-f0-9]{8}' | head -1)
CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" iterate "$TID2" >/dev/null 2>&1
CONTRACTS_STORE="$TMP/c.jsonl" bash "$CLI" _mark "$TID2" satisfied --proof-skip "in-thread KEY 2 — autonomous drive context" >/dev/null 2>&1
skip_ec=$?
if [ "$skip_ec" -ne 0 ]; then
  echo "FAIL: --proof-skip mark exited $skip_ec (expected 0)" >&2
  exit 1
fi
if ! grep "\"id\": \"$TID2\"" "$TMP/c.jsonl" | grep '"event": "satisfied"' | grep -q 'proof_skip_reason'; then
  echo "FAIL: proof_skip_reason not stored on satisfied row" >&2
  exit 1
fi

echo "proof-binding clean: bare refused, --proof stored, --proof-skip stored"
exit 0
