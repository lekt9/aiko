#!/usr/bin/env bash
# verb-gate: depth — walks the resolution graph; HARD-BREAKS _mark on cycle.
# Proves:
#   1. happy path: a leaf cell reports depth_up=0/depth_down=0/dims=0/cycles=[]
#   2. parent chain: a child reports depth_up>=1 to its parent
#   3. dims: a contract whose action is contract:<id> reports dims>=1
#   4. CYCLE DETECTION: two contracts referencing each other are detected
#   5. HARD-BREAK: _mark satisfied on a cycle-participant is refused (exit nonzero)
#   6. depth --strict-cycles exits 1 when a cycle exists
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
DEPTH="$HOME/.claude/skills/contract/scripts/contract-depth.py"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CONTRACTS_STORE="$TMP/ledger.jsonl"

# 1. happy path — leaf cell
LEAF=$(bash "$C" declare "depthgate leaf" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$LEAF" ] || { echo "FAIL: declare leaf"; exit 1; }
J=$(python3 "$DEPTH" "$LEAF" --json 2>/dev/null)
echo "$J" | python3 -c "import sys,json; r=json.load(sys.stdin); assert r['depth_up']==0 and r['depth_down']==0 and r['dims']==0 and r['cycles']==[], r" \
  || { echo "FAIL: leaf cell depth not {0,0,0,[]}"; echo "$J"; exit 1; }
echo "evidence: leaf cell -> depth_up=0 depth_down=0 dims=0 cycles=[]  OK"

# 2. parent chain — child reports depth_up>=1
ROOT=$(bash "$C" declare "depthgate parent" --action funnel --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
KID=$(bash "$C" declare "depthgate child" --action true --parent "$ROOT" --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$ROOT" ] && [ -n "$KID" ] || { echo "FAIL: declare parent/child"; exit 1; }
J=$(python3 "$DEPTH" "$KID" --json 2>/dev/null)
echo "$J" | python3 -c "import sys,json; r=json.load(sys.stdin); assert r['depth_up']>=1, r" \
  || { echo "FAIL: child depth_up<1"; echo "$J"; exit 1; }
echo "evidence: child cell -> depth_up>=1  OK"

# 3. dims — contract whose action is contract:<id>
GATED=$(bash "$C" declare "depthgate gated" --action "contract:$LEAF" --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$GATED" ] || { echo "FAIL: declare gated"; exit 1; }
J=$(python3 "$DEPTH" "$GATED" --json 2>/dev/null)
echo "$J" | python3 -c "import sys,json; r=json.load(sys.stdin); assert r['dims']>=1 and r['cycles']==[], r" \
  || { echo "FAIL: gated dims<1 or false cycle"; echo "$J"; exit 1; }
echo "evidence: contract-ref -> dims>=1, no cycles  OK"

# 4. cycle — two contracts referencing each other (must declare first, then revise actions)
# We can't reference an id that doesn't exist yet, so: declare both with placeholder
# actions, then use `revise` to make them point at each other.
A=$(bash "$C" declare "depthgate cycle A" --action "agent-judges" --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
B=$(bash "$C" declare "depthgate cycle B" --action "agent-judges" --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$A" ] && [ -n "$B" ] || { echo "FAIL: declare cycle endpoints"; exit 1; }
bash "$C" revise "$A" --action "contract:$B" --reason "form cycle for gate test" >/dev/null 2>&1
bash "$C" revise "$B" --action "contract:$A" --reason "form cycle for gate test" >/dev/null 2>&1
J=$(python3 "$DEPTH" "$A" --json 2>/dev/null)
echo "$J" | python3 -c "import sys,json; r=json.load(sys.stdin); assert r['cycles'], 'no cycle detected'; print('cycle found:', r['cycles'])" \
  || { echo "FAIL: cycle not detected by analyzer"; echo "$J"; exit 1; }
echo "evidence: cycle A↔B -> analyzer reports cycles  OK"

# 5. --strict-cycles exits nonzero on cycle
set +e
python3 "$DEPTH" "$A" --strict-cycles >/dev/null 2>&1
SC=$?
set -e
[ "$SC" -ne 0 ] || { echo "FAIL: --strict-cycles did not exit nonzero"; exit 1; }
echo "evidence: depth --strict-cycles exits nonzero on cycle  OK"

# 6. HARD-BREAK: _mark satisfied on cycle participant is REFUSED
set +e
OUT=$(bash "$C" _mark "$A" satisfied 2>&1)
MEC=$?
set -e
[ "$MEC" -ne 0 ] || { echo "FAIL: _mark on cycle-participant did not exit nonzero"; echo "$OUT"; exit 1; }
echo "$OUT" | grep -qi "HARD BREAK\|cycle\|refuse" || { echo "FAIL: _mark refused but no cycle explanation in output"; echo "$OUT"; exit 1; }
# Also confirm NO satisfied row was written
if grep -q "\"event\": \"satisfied\", \"id\": \"$A\"" "$CONTRACTS_STORE"; then
  echo "FAIL: satisfied row appeared in ledger despite cycle hard-break"
  exit 1
fi
echo "evidence: _mark $A satisfied -> REFUSED, no row written  OK"

echo "PASS: depth — happy path + parent chain + dims + cycle detection + --strict-cycles exit + _mark hard-break."
exit 0
