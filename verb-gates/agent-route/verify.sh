#!/usr/bin/env bash
# verb-gate: agent-route (Σ4) — `agent:<identity>` pointer-type.
#
# Catches regressions where:
#   - matched agent doesn't get AGENT-JUDGES (the in-thread path)
#   - mismatched agent gets PASS (permission leak — anyone can act!)
#   - inbox row missing or malformed
#   - Σ3 alias resolution skipped (lekt8 should iterate cleanly when aliased
#     to the routed identity)
#   - pointer-type detection drops (action mistyped as 'cli')
set -euo pipefail

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT

# Capture the REAL contract skill path BEFORE swapping HOME — the gate runs
# under host-specific ~ ($HOME → /Users/lekt9 on mac, /home/ubuntu on tencent).
# The skill always sits at $HOME/.claude/skills/contract on every host.
REAL_HOME="$HOME"
SKILL_DIR="$REAL_HOME/.claude/skills/contract"
SKILL_LIB="$SKILL_DIR/scripts/lib"
CLI="$SKILL_DIR/scripts/contract"

# Isolate inbox + ledger into the tempdir so the gate doesn't litter real ~/.contracts/.
# HOME-swap is the right primitive — the CLI resolves both ledger and inbox via $HOME.
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# Phase 0: pointer-type sanity — use the captured real lib path, not the swapped HOME.
PTYPE=$(MH_LIB="$SKILL_LIB" python3 -c "
import os, sys
sys.path.insert(0, os.environ['MH_LIB'])
from contract_core import _infer_pointer_type
print(_infer_pointer_type('agent:alice@example.com'))
")
[ "$PTYPE" = "agent" ] || { echo "FAIL: pointer_type for 'agent:...' is '$PTYPE', expected 'agent'"; exit 1; }

# Phase 1: declare a contract routed to alice
ROUTED=$(CONTRACT_AGENT="bob@example.com" "$CLI" declare \
  "alice please fix the thing" --action "agent:alice@example.com" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$ROUTED" ] || { echo "FAIL: declare empty"; exit 1; }

# Phase 2: bob iterates → REFUSED, inbox row written
OUT_BOB=$(CONTRACT_AGENT="bob@example.com" "$CLI" iterate "$ROUTED" 2>&1)
echo "$OUT_BOB" | grep -q "result: FAIL (ROUTED" || { echo "FAIL: bob iterate did not show ROUTED refusal"; echo "$OUT_BOB" | head -20; exit 1; }
echo "$OUT_BOB" | grep -q "inbox row appended"   || { echo "FAIL: inbox row not appended"; exit 1; }
[ -f "$TD/.contracts/inbox/agent/alice@example.com.jsonl" ] || { echo "FAIL: inbox file not created"; exit 1; }
ROW=$(cat "$TD/.contracts/inbox/agent/alice@example.com.jsonl" | head -1)
echo "$ROW" | grep -q '"event":"agent-routed"' || { echo "FAIL: inbox row missing event field. ROW=$ROW"; exit 1; }
echo "$ROW" | grep -q "\"contract_id\":\"$ROUTED\"" || { echo "FAIL: inbox row missing contract_id"; exit 1; }
echo "$ROW" | grep -q '"target_canonical":"alice@example.com"' || { echo "FAIL: inbox row missing target_canonical"; exit 1; }

# Phase 3: alice iterates → AGENT-JUDGES (in-thread)
OUT_ALICE=$(CONTRACT_AGENT="alice@example.com" "$CLI" iterate "$ROUTED" 2>&1)
echo "$OUT_ALICE" | grep -q "result: AGENT-JUDGES" || { echo "FAIL: alice iterate did not show AGENT-JUDGES"; echo "$OUT_ALICE" | head -20; exit 1; }
if echo "$OUT_ALICE" | grep -q "result: FAIL"; then
  echo "FAIL: alice iterate showed FAIL (should be AGENT-JUDGES)"; exit 1
fi

# Phase 4: Σ3 alias — alice has an alias 'alice-handle'; iterating as the alias should ALSO work
"$CLI" alias "alice@example.com" "alice-handle" >/dev/null 2>&1 || { echo "FAIL: alias declare errored"; exit 1; }
OUT_ALIAS=$(CONTRACT_AGENT="alice-handle" "$CLI" iterate "$ROUTED" 2>&1)
echo "$OUT_ALIAS" | grep -q "result: AGENT-JUDGES" || { echo "FAIL: aliased identity not resolved to canonical (alice-handle should match alice@example.com)"; echo "$OUT_ALIAS" | head -10; exit 1; }

# Phase 5: ensure a stranger STILL can't iterate (and writes an inbox row)
BEFORE=$(wc -l < "$TD/.contracts/inbox/agent/alice@example.com.jsonl")
OUT_STR=$(CONTRACT_AGENT="stranger@nowhere" "$CLI" iterate "$ROUTED" 2>&1)
echo "$OUT_STR" | grep -q "result: FAIL (ROUTED" || { echo "FAIL: stranger iterate did not refuse"; exit 1; }
AFTER=$(wc -l < "$TD/.contracts/inbox/agent/alice@example.com.jsonl")
[ "$AFTER" -gt "$BEFORE" ] || { echo "FAIL: stranger's routed iterate did not append a new inbox row"; exit 1; }

echo "PASS: agent-route gate (Σ4) — routed agent gets AGENT-JUDGES, non-routed gets REFUSED + inbox row appended, Σ3 aliases resolve correctly"
