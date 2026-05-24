#!/usr/bin/env bash
# verb-gate: organism — the agent-facing default invocation primitive.
#
# Reduce + inflate: one verb that converges funnel+loop+harness in one call.
# No more drill/iterate/_mark per leaf. Realises invocation-organism doctrine
# (55e60ce8) as the agent's front-door primitive.
#
# Catches regressions where:
#   - single-claim cell doesn't auto-mark on PASS (would leave root pending)
#   - funnel root marks satisfied while a leaf failed (fake-green)
#   - leaves-PASS-then-FAIL doesn't surface failing leaf id (un-debuggable)
#   - judgment form (no --action, no --child) doesn't declare agent-judges
#   - missing plan exits silently (must usage+exit 2)
#   - children aren't real ledger rows with parent_id wiring intact
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks"  # silence hook-dir warnings

# === Phase 1: single-claim cell — true → PASS auto-mark ===
OUT1=$("$CLI" organism "p1 single cell passes" --action "true" 2>&1)
echo "$OUT1" | grep -q "=== ORGANISM CONVERGED ==="  || { echo "FAIL P1: no CONVERGED block. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "leaves:    1/1 passed"        || { echo "FAIL P1: leaves line wrong. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "result:    PASS"              || { echo "FAIL P1: no PASS result. OUT=$OUT1"; exit 1; }
ROOT_P1=$(echo "$OUT1" | grep -oE 'ORGANISM [a-f0-9]{8}' | head -1 | awk '{print $2}')
[ -n "$ROOT_P1" ] || { echo "FAIL P1: no root id surfaced"; exit 1; }
# Verify root is satisfied in ledger
STATUS_P1=$("$CLI" status "$ROOT_P1" 2>&1)
echo "$STATUS_P1" | grep -q "^\[satisfied\] $ROOT_P1"  || { echo "FAIL P1: root not satisfied in ledger. STATUS=$STATUS_P1"; exit 1; }

# === Phase 2: funnel with all-PASS children — root + leaves auto-mark ===
OUT2=$("$CLI" organism "p2 funnel all pass" \
  --child "leaf-a|true" \
  --child "leaf-b|true" 2>&1)
echo "$OUT2" | grep -q "leaf 1/2"                    || { echo "FAIL P2: missing leaf trace. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "leaf 2/2"                    || { echo "FAIL P2: missing leaf 2 trace. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "leaves:    2/2 passed"       || { echo "FAIL P2: leaves count wrong. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "result:    PASS"             || { echo "FAIL P2: funnel didn't converge to PASS. OUT=$OUT2"; exit 1; }
ROOT_P2=$(echo "$OUT2" | grep -oE 'ORGANISM [a-f0-9]{8}' | head -1 | awk '{print $2}')
STATUS_P2=$("$CLI" status "$ROOT_P2" 2>&1)
echo "$STATUS_P2" | grep -q "action: funnel"         || { echo "FAIL P2: root action not funnel. STATUS=$STATUS_P2"; exit 1; }
# Both children visible + satisfied
SATCNT=$(echo "$STATUS_P2" | grep -cE "^\s*\[satisfied\] [a-f0-9]{8} \(cell\)")
[ "$SATCNT" = "2" ] || { echo "FAIL P2: expected 2 satisfied child cells, got $SATCNT. STATUS=$STATUS_P2"; exit 1; }

# === Phase 3: one leaf FAILs — root stays PENDING, failing leaf named ===
set +e
OUT3=$("$CLI" organism "p3 one leaf fails" \
  --child "leaf-pass|true" \
  --child "leaf-fail|false" 2>&1)
RC3=$?
set -e
[ "$RC3" = "1" ]                                     || { echo "FAIL P3: expected exit 1 on leaf fail, got $RC3"; exit 1; }
echo "$OUT3" | grep -q "=== ORGANISM PENDING ==="    || { echo "FAIL P3: no PENDING block. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "leaves:    1 passed, 1 failed" || { echo "FAIL P3: leaves count wrong. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "leaf-fail"                   || { echo "FAIL P3: failing leaf plan not surfaced. OUT=$OUT3"; exit 1; }
ROOT_P3=$(echo "$OUT3" | grep -oE 'ORGANISM [a-f0-9]{8}' | head -1 | awk '{print $2}')
# Root MUST NOT be satisfied (no fake-green)
STATUS_P3=$("$CLI" status "$ROOT_P3" 2>&1)
echo "$STATUS_P3" | grep -q "^\[satisfied\] $ROOT_P3" && { echo "FAIL P3: root fake-green satisfied despite leaf fail"; exit 1; }

# === Phase 4: judgment form (no --action, no --child) → agent-judges + auto-mark ===
OUT4=$("$CLI" organism "p4 pure judgment claim" 2>&1)
echo "$OUT4" | grep -q "shape: agent-judges"         || { echo "FAIL P4: judgment shape not surfaced. OUT=$OUT4"; exit 1; }
echo "$OUT4" | grep -q "result:    PASS"             || { echo "FAIL P4: judgment didn't auto-converge. OUT=$OUT4"; exit 1; }
ROOT_P4=$(echo "$OUT4" | grep -oE 'ORGANISM [a-f0-9]{8}' | head -1 | awk '{print $2}')
STATUS_P4=$("$CLI" status "$ROOT_P4" 2>&1)
echo "$STATUS_P4" | grep -q "action: agent-judges"   || { echo "FAIL P4: ledger row not agent-judges. STATUS=$STATUS_P4"; exit 1; }
echo "$STATUS_P4" | grep -q "^\[satisfied\] $ROOT_P4" || { echo "FAIL P4: judgment root not satisfied. STATUS=$STATUS_P4"; exit 1; }

# === Phase 5: missing args — usage + exit 2 ===
set +e
OUT5=$("$CLI" organism 2>&1)
RC5=$?
set -e
[ "$RC5" = "2" ]                                     || { echo "FAIL P5: empty organism didn't exit 2 (got $RC5). OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "usage: contract organism"    || { echo "FAIL P5: no usage line. OUT=$OUT5"; exit 1; }

# === Phase 6: proof-skip carries 'organism' marker (auditable via contract honest) ===
# Phase-1's root must carry a proof_skip_reason naming 'organism'
PROOF_REASON=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$CONTRACTS_STORE')]
sat = [r for r in rows if r.get('id') == '$ROOT_P1' and r.get('event') == 'satisfied']
print(sat[-1].get('proof_skip_reason', '') if sat else '')
")
echo "$PROOF_REASON" | grep -qi "organism"           || { echo "FAIL P6: proof_skip_reason doesn't name 'organism' (got: $PROOF_REASON)"; exit 1; }

echo "PASS: organism gate — single-claim auto-marks on PASS, funnel converges + marks root+leaves, leaf-FAIL leaves root pending (no fake-green) + names failing leaf, judgment form auto-marks via agent-judges, missing args → usage+exit 2, proof-skip carries 'organism' marker (audit-detectable)"
