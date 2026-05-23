#!/usr/bin/env bash
# verb-gates/render/verify.sh — binds `contract render <id>`.
#
# Phases:
#   1. Missing id AND no --from-stdin → exit 2
#   2. Unknown --surface → exit 2
#   3. Default --surface stdout passes substrate iterate output through
#   4. --humanize strips em-dashes + section markers before reaching renderer
#   5. --surface aiko-notch emits JSON card with required fields
#   6. --to <file> writes to file instead of stdout
set -e

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
export CONTRACTS_STORE="$TMPDIR_/ledger.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# Phase 1
if "$CLI" render </dev/null 2>/dev/null; then
  echo "FAIL(1): missing id + no --from-stdin should exit non-zero"; exit 1
fi
echo "PASS(1): missing id refused"

# Phase 2
if echo "x" | "$CLI" render --from-stdin --surface phantom-xyz >/dev/null 2>&1; then
  echo "FAIL(2): unknown --surface should exit non-zero"; exit 1
fi
echo "PASS(2): unknown --surface refused"

# Phase 3 — iterate a real contract, render its output via stdout
CID=$("$CLI" declare "render verb-gate probe" --action "true" --no-drive 2>&1 | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
[ -n "$CID" ] || { echo "FAIL(3): could not declare probe contract"; exit 1; }
OUT=$("$CLI" render "$CID" --surface stdout 2>&1)
echo "$OUT" | grep -q 'render verb-gate probe' || { echo "FAIL(3): iterate plan not visible in stdout"; echo "$OUT"; exit 1; }
echo "PASS(3): default surface stdout passes iterate output through"

# Phase 4 — --humanize strips em-dash + section marker
HUMAN_OUT=$(printf '=== TWO-KEY EXIT ===\nI shipped — yes.\n' | "$CLI" render --from-stdin --surface stdout --humanize 2>&1)
echo "$HUMAN_OUT" | grep -qE '^=== ' && { echo "FAIL(4): em-dash or section marker not stripped"; echo "$HUMAN_OUT"; exit 1; }
echo "$HUMAN_OUT" | grep -q '—' && { echo "FAIL(4): em-dash present"; echo "$HUMAN_OUT"; exit 1; }
echo "PASS(4): --humanize strips em-dash + section markers"

# Phase 5 — aiko-notch JSON card
OUT=$(printf '=== STATUS ===\n  body: I am sending the invite now.\n' | "$CLI" render --from-stdin --surface aiko-notch 2>&1)
echo "$OUT" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
for k in ("kind","title","body","actions"):
    assert k in d, "missing " + k
' || { echo "FAIL(5): aiko-notch JSON malformed"; echo "$OUT"; exit 1; }
echo "PASS(5): aiko-notch emits JSON card"

# Phase 6 — --to <file>
OUTFILE="$TMPDIR_/render-out.txt"
echo "to-file probe" | "$CLI" render --from-stdin --surface stdout --to "$OUTFILE" >/dev/null
[ -f "$OUTFILE" ] && grep -q 'to-file probe' "$OUTFILE" || { echo "FAIL(6): --to <file> did not write"; exit 1; }
echo "PASS(6): --to <file> writes to file instead of stdout"

echo
echo "verb-gates/render: PASS"
exit 0
