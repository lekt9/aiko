#!/usr/bin/env bash
# probe-render-verb.sh — child A of d26df94c.
set -e

CLI="$HOME/.claude/skills/contract/scripts/contract"
ORCH="$HOME/.claude/skills/contract/scripts/contract-render.py"
[ -x "$ORCH" ] || { echo "FAIL: orchestrator missing/not-executable"; exit 1; }
grep -q '^  render)' "$CLI" || { echo "FAIL: render verb not wired in CLI"; exit 1; }
echo "PASS: verb wired + orchestrator present"

# Default stdout passthrough
OUT=$(echo "hello probe" | "$CLI" render --from-stdin --surface stdout 2>&1)
[ "$OUT" = "hello probe" ] || { echo "FAIL: stdout passthrough expected 'hello probe', got: $OUT"; exit 1; }
echo "PASS: stdout passthrough"

# Unknown surface refused
if echo "x" | "$CLI" render --from-stdin --surface phantom-surface-xyz >/dev/null 2>&1; then
  echo "FAIL: unknown --surface should exit non-zero"; exit 1
fi
echo "PASS: unknown --surface refused"

# Empty stdin → exit 1
if "$CLI" render --from-stdin --surface stdout </dev/null >/dev/null 2>&1; then
  echo "FAIL: empty stdin should exit non-zero"; exit 1
fi
echo "PASS: empty stdin refused"

echo
echo "probe-render-verb: PASS"
exit 0
