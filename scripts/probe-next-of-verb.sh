#!/usr/bin/env bash
# probe-next-of-verb.sh — child A of c1bdb2b0.
# Asserts: verb wired in CLI; orchestrator script executable; satisfied
# carve-out returns no proposals; unknown id refused.
set -e

CLI="$HOME/.claude/skills/contract/scripts/contract"
ORCH="$HOME/.claude/skills/contract/scripts/contract-next-of.py"
[ -x "$ORCH" ] || { echo "FAIL: orchestrator missing/not exec"; exit 1; }
grep -q '^  next-of)' "$CLI" || { echo "FAIL: next-of verb not wired"; exit 1; }
echo "PASS: verb wired + orchestrator present"

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
export CONTRACTS_STORE="$TMPDIR_/ledger.jsonl"

# Unknown id refused
if "$CLI" next-of cafebabe </dev/null >/dev/null 2>&1; then
  echo "FAIL: unknown id should exit non-zero"; exit 1
fi
echo "PASS: unknown id refused"

# Declare + satisfy a cell → carve-out returns no proposals
DECL=$("$CLI" declare "probe next-of carve-out" --action "true" --no-drive 2>&1)
CID=$(printf '%s' "$DECL" | grep -oE '^declared: [0-9a-f]+' | head -1 | awk '{print $2}')
"$CLI" iterate "$CID" >/dev/null 2>&1
"$CLI" _mark "$CID" satisfied --proof "probe" >/dev/null 2>&1
OUT=$("$CLI" next-of "$CID" </dev/null 2>&1)
echo "$OUT" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
assert d["status"] == "satisfied", "carve-out missed: " + str(d["status"])
assert d["proposals"] == [], "carve-out returned proposals when it should not"
' || { echo "FAIL: satisfied carve-out broken"; echo "$OUT"; exit 1; }
echo "PASS: satisfied carve-out returns no proposals"

echo
echo "probe-next-of-verb: PASS"
exit 0
