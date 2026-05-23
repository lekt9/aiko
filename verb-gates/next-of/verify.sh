#!/usr/bin/env bash
# verb-gates/next-of/verify.sh — binds `contract next-of <id>`.
#
# Phases:
#   1. Missing id → exit 2
#   2. Satisfied id → carve-out, exit 0, no proposals
#   3. Funnel with 2 unsatisfied children → child-gap returns 2 proposals
#   4. --from-stdin → stdin source proposals end up in envelope
#   5. --auto-declare → top proposal is declared as a child of <id>
set -e

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
export CONTRACTS_STORE="$TMPDIR_/ledger.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# Phase 1
if "$CLI" next-of </dev/null 2>/dev/null; then
  echo "FAIL(1): missing id should exit non-zero"; exit 1
fi
echo "PASS(1): missing id refused"

# Phase 2 — satisfied carve-out
SAT=$("$CLI" declare "verb-gate satisfied carve" --action "true" --no-drive 2>&1 | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
"$CLI" iterate "$SAT" >/dev/null 2>&1
"$CLI" _mark "$SAT" satisfied --proof "gate" >/dev/null 2>&1
OUT=$("$CLI" next-of "$SAT" </dev/null 2>&1)
echo "$OUT" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
assert d["status"] == "satisfied"
assert d["proposals"] == []
' || { echo "FAIL(2): satisfied carve-out broken"; echo "$OUT"; exit 1; }
echo "PASS(2): satisfied carve-out returns no proposals"

# Phase 3 — child-gap proposals
PARENT=$("$CLI" declare "verb-gate parent funnel" --action funnel --no-drive 2>&1 | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
"$CLI" declare "verb-gate child 1" --action "true" --parent "$PARENT" --no-drive >/dev/null 2>&1
"$CLI" declare "verb-gate child 2" --action "true" --parent "$PARENT" --no-drive >/dev/null 2>&1
OUT=$("$CLI" next-of "$PARENT" </dev/null 2>&1)
N=$(echo "$OUT" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
gap = [p for p in d["proposals"] if p["source"]=="child-gap"]
print(len(gap))
')
[ "$N" = "2" ] || { echo "FAIL(3): expected 2 child-gap proposals, got $N"; echo "$OUT"; exit 1; }
echo "PASS(3): child-gap returns 2 proposals for funnel with 2 unsatisfied children"

# Phase 4 — --from-stdin source
OUT=$("$CLI" next-of "$PARENT" --from-stdin <<<'[{"plan":"manual proposal","action":"agent-judges"}]' 2>&1)
HAS_STDIN=$(echo "$OUT" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
print(any(p["source"]=="stdin" and p["plan"]=="manual proposal" for p in d["proposals"]))
')
[ "$HAS_STDIN" = "True" ] || { echo "FAIL(4): stdin proposal missing from envelope"; echo "$OUT"; exit 1; }
echo "PASS(4): stdin proposal flows into envelope"

# Phase 5 — --auto-declare
OUT=$("$CLI" next-of "$PARENT" --auto-declare </dev/null 2>&1)
NEW=$(echo "$OUT" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
print(d.get("auto_declared",""))
')
[ -n "$NEW" ] || { echo "FAIL(5): --auto-declare did not produce auto_declared id"; echo "$OUT"; exit 1; }
# Verify the new contract exists and is a child of PARENT
EXPECTED_PARENT="$PARENT" NEW_ID="$NEW" python3 <<'PY'
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/scripts/lib"))
from contract_core import get
new = get(os.environ["NEW_ID"])
assert new, "auto-declared contract not found in ledger"
assert new.get("parent_id") == os.environ["EXPECTED_PARENT"], "auto-declared contract parent mismatch"
PY
echo "PASS(5): --auto-declare created child contract $NEW under $PARENT"

echo
echo "verb-gates/next-of: PASS"
exit 0
