#!/usr/bin/env bash
# probe-next-sources.sh — child B of c1bdb2b0.
# Asserts the 5 source helpers exist + executable; child-gap returns
# proposals for unsatisfied children; stdin source accepts piped envelope;
# unrelated source skips silently (no fake-green).
set -e

SRC_DIR="$HOME/.claude/skills/contract/scripts/next-sources"
for s in judge-says child-gap failure-pattern search-bm25 stdin; do
  [ -x "$SRC_DIR/$s.sh" ] || { echo "FAIL: source missing/not-executable: $s.sh"; exit 1; }
done
echo "PASS: 5 source scripts present + executable"

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
export CONTRACTS_STORE="$TMPDIR_/ledger.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# stdin source: pipe a list of proposals → echo back with source=stdin tagged
OUT=$(bash "$SRC_DIR/stdin.sh" anyid <<<'[{"plan":"do x","action":"true"}]' 2>&1)
echo "$OUT" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
assert isinstance(d, list) and d[0]["source"]=="stdin" and d[0]["plan"]=="do x"
' || { echo "FAIL: stdin source did not echo proposals"; echo "$OUT"; exit 1; }
echo "PASS: stdin source accepts piped envelope"

# stdin source: empty → exit 1
if bash "$SRC_DIR/stdin.sh" anyid </dev/null >/dev/null 2>&1; then
  echo "FAIL: stdin source should exit 1 on empty"; exit 1
fi
echo "PASS: stdin source skips silently on empty"

# child-gap: build a funnel with 2 unsatisfied children, ensure 2 proposals
PARENT=$("$CLI" declare "probe parent" --action funnel --no-drive 2>&1 | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
C1=$("$CLI" declare "probe child 1" --action "true" --parent "$PARENT" --no-drive 2>&1 | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
C2=$("$CLI" declare "probe child 2" --action "true" --parent "$PARENT" --no-drive 2>&1 | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
DATA=$("$CLI" context "$PARENT" 2>&1 | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
# context envelope doesnt carry children — fetch directly
print("ok")
')
# Use direct get via Python
GET_OUT=$(PARENT_ID="$PARENT" python3 <<'PY'
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/scripts/lib"))
from contract_core import get
c = get(os.environ["PARENT_ID"])
print(json.dumps(c))
PY
)
PROP=$(CONTEXT_CONTRACT_DATA="$GET_OUT" bash "$SRC_DIR/child-gap.sh" "$PARENT" </dev/null 2>&1)
echo "$PROP" | python3 -c '
import json,sys
d = json.loads(sys.stdin.read())
assert isinstance(d, list) and len(d) == 2, "expected 2 proposals, got " + str(len(d))
ids = sorted(p["child_id"] for p in d)
assert all(len(i)==8 for i in ids), "bad child ids: " + str(ids)
' || { echo "FAIL: child-gap did not return 2 proposals"; echo "$PROP"; exit 1; }
echo "PASS: child-gap returns proposals for unsatisfied children"

# Mark one child satisfied → child-gap should now return only 1
"$CLI" iterate "$C1" >/dev/null 2>&1
"$CLI" _mark "$C1" satisfied --proof "probe" >/dev/null 2>&1
GET_OUT=$(PARENT_ID="$PARENT" python3 <<'PY'
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/scripts/lib"))
from contract_core import get
print(json.dumps(get(os.environ["PARENT_ID"])))
PY
)
PROP=$(CONTEXT_CONTRACT_DATA="$GET_OUT" bash "$SRC_DIR/child-gap.sh" "$PARENT" </dev/null 2>&1)
N=$(echo "$PROP" | python3 -c 'import json,sys; print(len(json.loads(sys.stdin.read())))')
[ "$N" = "1" ] || { echo "FAIL: child-gap should return 1 after one child satisfied, got $N"; exit 1; }
echo "PASS: child-gap filters out satisfied children"

# child-gap on a cell (not a composition) → exit 1 silently
LEAF=$("$CLI" declare "probe leaf cell" --action "true" --no-drive 2>&1 | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
GET_OUT=$(LEAF_ID="$LEAF" python3 <<'PY'
import json, os, sys
sys.path.insert(0, os.path.expanduser("~/.claude/skills/contract/scripts/lib"))
from contract_core import get
print(json.dumps(get(os.environ["LEAF_ID"])))
PY
)
if CONTEXT_CONTRACT_DATA="$GET_OUT" bash "$SRC_DIR/child-gap.sh" "$LEAF" </dev/null >/dev/null 2>&1; then
  echo "FAIL: child-gap should skip silently on a non-composition cell"; exit 1
fi
echo "PASS: child-gap skips silently on non-composition shapes"

echo
echo "probe-next-sources: PASS"
exit 0
