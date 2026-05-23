#!/usr/bin/env bash
# verb-gate: layer (Π5 + Ψ5) — layered-by-default contract data structure.
#
# Π5 = layer inference + cross-layer reach enforcement.
# Ψ5 = row read partitioned into public (WHAT) and internal (HOW) via `show`.
#
# Together: contracts are tagged by layer at declare time (inferred from
# pointer-type or explicit --layer N), legacy rows infer at read time;
# cross-layer reach beyond ±1 emits a soft warning by default and refuses
# under CONTRACT_LAYER_STRICT=1 unless --pierce <target-layer> authorizes;
# `contract show <id>` defaults to the public face, --internals surfaces
# the HOW block. Binary access at L1 is one hop below L2 (the catch-all
# cell layer), so machine: pointers don't need pierce for typical use.
#
# Catches regressions where:
#   - layer inference breaks for any of the 7 pointer types
#   - --layer explicit override doesn't take precedence
#   - --pierce silently fails to authorize
#   - cross-layer reach passes silently when STRICT (false-witness)
#   - cross-layer reach refuses even with pierce (over-enforcement)
#   - legacy rows (no layer field) fail to infer at read time
#   - contract show leaks HOW lines in default output (Ψ5 layer-bleed)
#   - --internals omits the HOW block
#   - --json output isn't parseable
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
REAL_LIB="$REAL_HOME/.claude/skills/contract/scripts/lib"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# === Phase 1: layer inference for all 7 mapped pointer types ===
declare -A EXPECT_LAYER=(
  ["agent:alice@example.com"]=6
  ["x402:https://example.com/charge"]=5
  ["python3 $REAL_HOME/.claude/skills/contract/scripts/wait-for-event.py --inbox tg"]=4
  ["funnel"]=3
  ["agent-judges"]=3
  ["true"]=2
  ["machine:graff --status"]=1
)
for ACTION in "${!EXPECT_LAYER[@]}"; do
  EXP="${EXPECT_LAYER[$ACTION]}"
  CID=$("$CLI" declare "infer test L$EXP" --action "$ACTION" --no-drive 2>&1 \
    | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
  GOT=$(REAL_LIB="$REAL_LIB" CS="$CONTRACTS_STORE" CID="$CID" python3 -c "
import os, sys
sys.path.insert(0, os.environ['REAL_LIB'])
os.environ['CONTRACTS_STORE']=os.environ['CS']
from contract_core import get
print(get(os.environ['CID'])['layer'])
")
  [ "$GOT" = "$EXP" ] || { echo "FAIL: inference for '$ACTION' got L$GOT, expected L$EXP"; exit 1; }
done

# === Phase 2: --layer explicit override ===
CID=$("$CLI" declare "explicit L5 override" --action "true" --layer 5 --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
GOT=$(REAL_LIB="$REAL_LIB" CS="$CONTRACTS_STORE" CID="$CID" python3 -c "
import os, sys
sys.path.insert(0, os.environ['REAL_LIB'])
os.environ['CONTRACTS_STORE']=os.environ['CS']
from contract_core import get
print(get(os.environ['CID'])['layer'])
")
[ "$GOT" = "5" ] || { echo "FAIL: --layer 5 override got L$GOT, expected L5"; exit 1; }

# === Phase 3: cross-layer reach — L3 → L1 emits soft warning by default ===
L1=$("$CLI" declare "L1 binary target" --action "machine:graff --status" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_WARN=$("$CLI" declare "L3 reaches L1 without pierce" --action "contract:$L1" --no-drive 2>&1)
echo "$OUT_WARN" | grep -q "Π5 cross-layer reach" \
  || { echo "FAIL: cross-layer reach didn't emit soft warning. OUT="; echo "$OUT_WARN"; exit 1; }
echo "$OUT_WARN" | grep -q "L3(graph) → L1(system)" \
  || { echo "FAIL: warning didn't name the layer delta. OUT="; echo "$OUT_WARN"; exit 1; }
echo "$OUT_WARN" | grep -q "^declared:" \
  || { echo "FAIL: soft warning blocked declare (should still succeed)"; exit 1; }

# === Phase 4: --pierce 1 silences the warning + writes pierced_layers ===
OUT_PIERCE=$("$CLI" declare "L3 pierces to L1" --action "contract:$L1" --pierce 1 --no-drive 2>&1)
echo "$OUT_PIERCE" | grep -q "Π5 cross-layer reach" \
  && { echo "FAIL: --pierce 1 didn't silence the warning"; exit 1; } || true
PIERCED_CID=$(echo "$OUT_PIERCE" | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
PIERCED_LAYERS=$(REAL_LIB="$REAL_LIB" CS="$CONTRACTS_STORE" CID="$PIERCED_CID" python3 -c "
import os, sys
sys.path.insert(0, os.environ['REAL_LIB'])
os.environ['CONTRACTS_STORE']=os.environ['CS']
from contract_core import get
print(get(os.environ['CID']).get('pierced_layers'))
")
[ "$PIERCED_LAYERS" = "[1]" ] || { echo "FAIL: pierced_layers on row = $PIERCED_LAYERS, expected [1]"; exit 1; }

# === Phase 5: STRICT mode refuses without pierce ===
OUT_STRICT=$(CONTRACT_LAYER_STRICT=1 "$CLI" declare "STRICT reach without pierce" --action "contract:$L1" --no-drive 2>&1 || true)
echo "$OUT_STRICT" | grep -q "LAYER VIOLATION" \
  || { echo "FAIL: STRICT mode didn't emit LAYER VIOLATION block. OUT="; echo "$OUT_STRICT"; exit 1; }
echo "$OUT_STRICT" | grep -q "^declared:" \
  && { echo "FAIL: STRICT mode still wrote a declared row (should have refused with exit 2)"; exit 1; } || true

# === Phase 6: STRICT + --pierce passes cleanly ===
OUT_STRICT_OK=$(CONTRACT_LAYER_STRICT=1 "$CLI" declare "STRICT pierced reach" --action "contract:$L1" --pierce 1 --no-drive 2>&1)
echo "$OUT_STRICT_OK" | grep -q "LAYER VIOLATION" \
  && { echo "FAIL: STRICT + --pierce refused (should have passed)"; exit 1; } || true
echo "$OUT_STRICT_OK" | grep -q "^declared:" \
  || { echo "FAIL: STRICT + --pierce didn't write declared row"; exit 1; }

# === Phase 7: adjacent layers (delta=1) pass silently — no warning ===
OUT_ADJ=$("$CLI" declare "L2 cell wraps L1 binary" --action "contract:$L1" --layer 2 --no-drive 2>&1)
echo "$OUT_ADJ" | grep -q "Π5 cross-layer reach" \
  && { echo "FAIL: L2 → L1 (delta=1) emitted spurious warning"; exit 1; } || true

# === Phase 8: Ψ5 — contract show defaults to public face (no HOW leak) ===
PROVEN=$("$CLI" declare "show test target" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
"$CLI" iterate "$PROVEN" >/dev/null 2>&1
"$CLI" _mark "$PROVEN" satisfied --proof "Ψ5 show test proof — verified action exited 0" >/dev/null 2>&1
OUT_SHOW=$("$CLI" show "$PROVEN" 2>&1)
echo "$OUT_SHOW" | grep -q "WHAT must hold:"        || { echo "FAIL: show missing WHAT block"; exit 1; }
echo "$OUT_SHOW" | grep -q "LATEST PROOF:"           || { echo "FAIL: show missing PROOF block"; exit 1; }
echo "$OUT_SHOW" | grep -qE "L[0-9] (system|cell|graph|transport|value|operator)" \
  || { echo "FAIL: show missing LAYER tag in header"; exit 1; }
# HOW lines must NOT appear in default view
echo "$OUT_SHOW" | grep -qE "^  cwd:|^  pointer_type:|^  last_exit:" \
  && { echo "FAIL: show leaked HOW lines in default view (Ψ5 violation)"; exit 1; } || true

# === Phase 9: --internals surfaces HOW block ===
OUT_HOW=$("$CLI" show "$PROVEN" --internals 2>&1)
echo "$OUT_HOW" | grep -q "Ψ5 internals" || { echo "FAIL: --internals missing HOW block header"; exit 1; }
echo "$OUT_HOW" | grep -qE "^  action:"   || { echo "FAIL: --internals missing action line"; exit 1; }
echo "$OUT_HOW" | grep -qE "^  cwd:"      || { echo "FAIL: --internals missing cwd line"; exit 1; }
echo "$OUT_HOW" | grep -qE "^  wave:"     || { echo "FAIL: --internals missing wave line"; exit 1; }

# === Phase 10: --json output is parseable + has public + internals shape ===
OUT_JSON=$("$CLI" show "$PROVEN" --internals --json 2>&1)
echo "$OUT_JSON" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
assert 'public' in d and 'internals' in d, f'shape: {list(d.keys())}'
p = d['public']; i = d['internals']
assert p['layer'] in (1,2,3,4,5,6), f'layer not int: {p[\"layer\"]}'
assert p['layer_name'] in ('system','cell','graph','transport','value','operator'), f'name: {p[\"layer_name\"]}'
assert 'action' in i and 'cwd' in i and 'agent' in i, f'internals: {list(i.keys())}'
# Cross-check Ψ5: action MUST be in internals, NOT in public
assert 'action' not in p, 'FAIL: action leaked into public block'
" || { echo "FAIL: --json shape wrong"; exit 1; }

# === Phase 11: legacy row (no layer field) infers at read time ===
# Append a hand-crafted row without `layer` field
CID_LEGACY="leg00001"
python3 -c "
import json
row = {'event':'declared','id':'$CID_LEGACY','plan':'legacy row pre-Π5','action':'machine:somebin','pointer_type':'machine','cwd':'/tmp','parent_id':None,'pointers':[],'ts':'2026-05-23T00:00:00Z','agent':'legacy'}
with open('$CONTRACTS_STORE','a') as f:
    f.write(json.dumps(row) + '\n')
"
LEG_LAYER=$(REAL_LIB="$REAL_LIB" CS="$CONTRACTS_STORE" python3 -c "
import os, sys
sys.path.insert(0, os.environ['REAL_LIB'])
os.environ['CONTRACTS_STORE']=os.environ['CS']
from contract_core import get
print(get('$CID_LEGACY')['layer'])
")
[ "$LEG_LAYER" = "1" ] || { echo "FAIL: legacy row inference: machine: action got L$LEG_LAYER, expected L1"; exit 1; }

echo "PASS: layer gate (Π5 + Ψ5) — inference across 7 pointer-types, --layer override, --pierce authorization (writes pierced_layers), cross-layer reach soft-warns by default (still declares), STRICT mode refuses with LAYER VIOLATION block, STRICT+--pierce passes, adjacent layers (delta=1) pass silently. Ψ5: show defaults to public face (no HOW leak), --internals surfaces HOW block, --json shape preserves public/internals partition, legacy rows infer layer at read time"
