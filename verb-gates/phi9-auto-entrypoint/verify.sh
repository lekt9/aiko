#!/bin/bash
# Φ9 gate: declare with a resource-bearing plan emits an ENTRYPOINT HINTS
# block to stderr, listing each detected resource with a paste-ready
# `contract declare ... --resource <type> --parent <id>` command.
# Negative case: a plan with no resource keywords emits no block.
set -e
TMP=$(mktemp -d)
export CONTRACTS_STORE="$TMP/s.jsonl"
export CONTRACT_AGENT="gate-phi9@example.com"
C=~/.claude/skills/contract/scripts/contract

# --- positive: telegram plan should emit hints with --resource telegram ---
OUT=$($C declare "watch the telegram chat for new pings" --action agent-judges --no-drive 2>&1 || true)
# wait briefly for backgrounded hooks to flush their stderr to our captured stream
sleep 1
# Re-capture: the hook is fired with `&` so its stderr may have raced past
# our capture above. Re-run capture more deterministically by inlining.
OUT2=$(
  CONTRACTS_STORE="$TMP/s.jsonl" \
  CONTRACT_AGENT="$CONTRACT_AGENT" \
  bash -c '
    $0 declare "watch the telegram chat for incoming pings" --action agent-judges --no-drive 2>&1
    # give hooks time to write to stderr before the shell exits
    sleep 1
    wait 2>/dev/null || true
  ' "$C" 2>&1
)

echo "--- captured output (positive) ---"
echo "$OUT2"
echo "--- end captured ---"

echo "$OUT2" | grep -q "=== ENTRYPOINT HINTS ===" || {
  echo "FAIL: missing '=== ENTRYPOINT HINTS ===' block on telegram plan"
  exit 1
}
echo "$OUT2" | grep -q -- "--resource telegram" || {
  echo "FAIL: missing '--resource telegram' hint"
  exit 1
}
echo "$OUT2" | grep -Eq "contract declare .* --resource telegram --parent [a-f0-9]{8}" || {
  echo "FAIL: missing paste-ready 'contract declare ... --resource telegram --parent <id>' line"
  exit 1
}
echo "PASS positive: telegram plan emitted ENTRYPOINT HINTS block with paste-ready declare"

# --- negative: a plan with no resource keywords emits NO block ---
NEG_OUT=$(
  CONTRACTS_STORE="$TMP/s2.jsonl" \
  CONTRACT_AGENT="$CONTRACT_AGENT" \
  bash -c '
    $0 declare "refactor the math module for clarity" --action agent-judges --no-drive 2>&1
    sleep 1
    wait 2>/dev/null || true
  ' "$C" 2>&1
)
echo "--- captured output (negative) ---"
echo "$NEG_OUT"
echo "--- end captured ---"
if echo "$NEG_OUT" | grep -q "=== ENTRYPOINT HINTS ==="; then
  echo "FAIL: negative case emitted hints block for keyword-free plan"
  exit 1
fi
echo "PASS negative: keyword-free plan emitted no hints block"

echo "PASS: Φ9 auto-entrypoint hints fire on resource-bearing plans, silent otherwise"
