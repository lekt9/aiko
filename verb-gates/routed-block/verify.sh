#!/usr/bin/env bash
# verb-gate: routed-block — Σ4 ROUTED emission has the structured KV-block
# shape that openai-render.py can lift into an `agent_routed` tool_call.
#
# Where verb-gates/agent-route binds the SEMANTIC behaviour (matched gets
# AGENT-JUDGES, mismatched gets refused + inbox row), this gate binds the
# STRUCTURED SHAPE of the refusal block so transports rendering the
# /chat/completions stream get a proper tool_call, not a content-only line.
#
# Catches regressions where:
#   - the === ROUTED === header disappears (block degrades to prose)
#   - load-bearing KV fields go missing (contract_id, target_canonical, inbox_path, wait_cmd)
#   - openai-render fails to lift the block to a tool_call named agent_routed
#   - the tool_call's arguments aren't valid JSON
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
RENDER="$REAL_HOME/.claude/skills/contract/scripts/openai-render.py"
[ -f "$CLI" ]    || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }
[ -f "$RENDER" ] || { echo "FAIL: cannot locate openai-render.py at $RENDER"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# Declare a contract routed to alice
ROUTED=$(CONTRACT_AGENT="bob@example.com" "$CLI" declare \
  "alice please fix the thing" --action "agent:alice@example.com" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$ROUTED" ] || { echo "FAIL: declare empty"; exit 1; }

# Bob iterates — should emit the ROUTED block
OUT=$(CONTRACT_AGENT="bob@example.com" "$CLI" iterate "$ROUTED" 2>&1)

# === Phase 1: structured block header is present ===
echo "$OUT" | grep -qE "^=== ROUTED ===$" \
  || { echo "FAIL: === ROUTED === header missing. OUT="; echo "$OUT"; exit 1; }

# === Phase 2: load-bearing KV fields are present and KV-shaped ===
for field in contract_id target_canonical target_raw routed_by inbox_path wait_cmd; do
  echo "$OUT" | grep -qE "^  ${field}:" \
    || { echo "FAIL: ROUTED block missing KV field '$field'. OUT="; echo "$OUT"; exit 1; }
done

# target_canonical must actually be alice (not empty, not bob)
TC=$(echo "$OUT" | sed -nE 's/^  target_canonical:[[:space:]]+(.+)$/\1/p' | head -1)
[ "$TC" = "alice@example.com" ] || { echo "FAIL: target_canonical='$TC', expected alice@example.com"; exit 1; }

# === Phase 3: openai-render.py lifts the block to an agent_routed tool_call ===
SSE=$(echo "$OUT" | python3 "$RENDER" 2>&1)
echo "$SSE" | grep -q '"agent_routed"' \
  || { echo "FAIL: openai-render did not emit agent_routed tool_call. SSE="; echo "$SSE" | head -40; exit 1; }

# Every data: chunk parses as JSON, every tool_call.arguments parses as JSON
python3 - <<PY
import json, sys, re
sse = """$SSE"""
got_agent_routed = False
args_parseable = False
for line in sse.splitlines():
    line = line.strip()
    if not line.startswith("data:"):
        continue
    payload = line[len("data:"):].strip()
    if payload == "[DONE]":
        continue
    try:
        obj = json.loads(payload)
    except Exception as e:
        print(f"FAIL: data chunk not valid JSON: {payload!r} → {e}")
        sys.exit(1)
    for ch in obj.get("choices", []):
        delta = ch.get("delta") or {}
        for tc in delta.get("tool_calls") or []:
            fn = (tc.get("function") or {}).get("name")
            if fn == "agent_routed":
                got_agent_routed = True
                a = (tc.get("function") or {}).get("arguments") or "{}"
                try:
                    parsed = json.loads(a)
                except Exception as e:
                    print(f"FAIL: agent_routed arguments not parseable JSON: {a!r} → {e}")
                    sys.exit(1)
                # Load-bearing keys should survive into the tool_call args
                for k in ("contract_id", "target_canonical", "inbox_path", "wait_cmd"):
                    if k not in parsed:
                        print(f"FAIL: agent_routed args missing key '{k}'. got={list(parsed.keys())}")
                        sys.exit(1)
                if parsed.get("target_canonical") != "alice@example.com":
                    print(f"FAIL: target_canonical in args is {parsed.get('target_canonical')!r}, expected alice@example.com")
                    sys.exit(1)
                args_parseable = True
if not got_agent_routed:
    print("FAIL: no agent_routed tool_call in SSE stream")
    sys.exit(1)
if not args_parseable:
    print("FAIL: agent_routed tool_call had no parseable args")
    sys.exit(1)
PY

# === Phase 4: SSE ends with data: [DONE] ===
echo "$SSE" | grep -q "^data: \[DONE\]$" \
  || { echo "FAIL: SSE stream missing terminal data: [DONE]"; exit 1; }

echo "PASS: routed-block gate — Σ4 emits === ROUTED === with all KV fields, openai-render lifts to agent_routed tool_call with parseable JSON args, SSE terminates cleanly"
