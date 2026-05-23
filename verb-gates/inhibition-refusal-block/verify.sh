#!/usr/bin/env bash
# verb-gate: inhibition-refusal-block — biology negative-regulation refusal
# has the structured KV-block shape that openai-render.py can lift into an
# `inhibition_refusal` tool_call.
#
# Where verb-gates/inhibits binds the SEMANTIC behaviour (mark refused while
# an active inhibitor fires), this gate binds the STRUCTURED SHAPE of the
# refusal block so transports rendering the /chat/completions stream get a
# proper tool_call that can surface "supersede or release" controls.
#
# Catches regressions where:
#   - the === INHIBITION REFUSAL === header disappears
#   - load-bearing KV fields go missing (contract_id, inhibitor_ids, inhibitor_plans)
#   - inhibitor list degrades to prose that openai-render can't parse
#   - openai-render fails to lift the block to a tool_call named inhibition_refusal
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

# Declare the target T (the contract that will be inhibited)
T=$("$CLI" declare "target T — should not satisfy while inhibited" \
  --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$T" ] || { echo "FAIL: T declare empty"; exit 1; }

# Declare an inhibitor I that points at T
I=$("$CLI" declare "inhibitor I — blocks T while satisfied" \
  --action "true" --inhibits "$T" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$I" ] || { echo "FAIL: I declare empty"; exit 1; }

# Iterate + satisfy I so it becomes an active inhibitor
"$CLI" iterate "$I" >/dev/null 2>&1
"$CLI" _mark "$I" satisfied --proof "inhibitor active for block-shape gate" >/dev/null 2>&1 \
  || { echo "FAIL: could not mark inhibitor I satisfied"; exit 1; }

# Iterate T (so a wave exists) and attempt to mark — should hit INHIBITION REFUSAL
"$CLI" iterate "$T" >/dev/null 2>&1
OUT=$("$CLI" _mark "$T" satisfied --proof "trying to mark while inhibited" 2>&1 || true)

# === Phase 1: structured block header is present ===
echo "$OUT" | grep -qE "^=== INHIBITION REFUSAL ===$" \
  || { echo "FAIL: === INHIBITION REFUSAL === header missing. OUT="; echo "$OUT"; exit 1; }

# === Phase 2: load-bearing KV fields are present and KV-shaped ===
for field in contract_id inhibitor_ids inhibitor_plans release_hint doctrine; do
  echo "$OUT" | grep -qE "^  ${field}:" \
    || { echo "FAIL: INHIBITION REFUSAL block missing KV field '$field'. OUT="; echo "$OUT"; exit 1; }
done

# inhibitor_ids should contain the inhibitor id I
IIDS=$(echo "$OUT" | sed -nE 's/^  inhibitor_ids:[[:space:]]+(.+)$/\1/p' | head -1)
echo "$IIDS" | grep -q "$I" || { echo "FAIL: inhibitor_ids='$IIDS' missing $I"; exit 1; }

# contract_id field names the target T
CID=$(echo "$OUT" | sed -nE 's/^  contract_id:[[:space:]]+(.+)$/\1/p' | head -1)
[ "$CID" = "$T" ] || { echo "FAIL: contract_id='$CID', expected $T"; exit 1; }

# === Phase 3: openai-render.py lifts the block to inhibition_refusal tool_call ===
SSE=$(echo "$OUT" | python3 "$RENDER" 2>&1)
echo "$SSE" | grep -q '"inhibition_refusal"' \
  || { echo "FAIL: openai-render did not emit inhibition_refusal tool_call. SSE="; echo "$SSE" | head -40; exit 1; }

python3 - <<PY
import json, sys
sse = """$SSE"""
got_call = False
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
            if fn == "inhibition_refusal":
                got_call = True
                a = (tc.get("function") or {}).get("arguments") or "{}"
                try:
                    parsed = json.loads(a)
                except Exception as e:
                    print(f"FAIL: inhibition_refusal arguments not parseable JSON: {a!r} → {e}")
                    sys.exit(1)
                for k in ("contract_id", "inhibitor_ids", "inhibitor_plans"):
                    if k not in parsed:
                        print(f"FAIL: inhibition_refusal args missing key '{k}'. got={list(parsed.keys())}")
                        sys.exit(1)
                if "$I" not in parsed.get("inhibitor_ids", ""):
                    print(f"FAIL: inhibitor_ids in args ({parsed.get('inhibitor_ids')!r}) missing $I")
                    sys.exit(1)
if not got_call:
    print("FAIL: no inhibition_refusal tool_call in SSE stream")
    sys.exit(1)
PY

# === Phase 4: SSE terminates cleanly ===
echo "$SSE" | grep -q "^data: \[DONE\]$" \
  || { echo "FAIL: SSE stream missing terminal data: [DONE]"; exit 1; }

# === Phase 5: clearing the inhibitor (supersede) lifts the refusal ===
WINNER=$("$CLI" declare "winner that supersedes inhibitor I" \
  --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
"$CLI" iterate "$WINNER" >/dev/null 2>&1
"$CLI" _mark "$WINNER" satisfied --proof "release inhibitor for gate test" >/dev/null 2>&1
"$CLI" supersede "$I" "$WINNER" --reason "release inhibition" >/dev/null 2>&1 \
  || { echo "FAIL: could not supersede inhibitor"; exit 1; }

# Now T should be markable
OUT_RELEASED=$("$CLI" _mark "$T" satisfied --proof "released from inhibition" 2>&1)
echo "$OUT_RELEASED" | grep -q "INHIBITION REFUSAL" \
  && { echo "FAIL: T still inhibition-refused after inhibitor superseded"; exit 1; } || true

echo "PASS: inhibition-refusal-block gate — biology negative-regulation emits === INHIBITION REFUSAL === with all KV fields, openai-render lifts to inhibition_refusal tool_call with parseable JSON args, supersede on inhibitor lifts the refusal"
