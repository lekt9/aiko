#!/usr/bin/env bash
# verb-gate: openai-render (Φ1) — substrate output → OpenAI streaming chunks.
#
# Catches regressions where:
#   - SSE chunks aren't `data: <json>\n\n` shaped (any OpenAI SDK chokes)
#   - the four requirement blocks don't become OpenAI tool_calls (transports
#     lose the generative-UI handoff at the API boundary)
#   - tool_call arguments aren't valid JSON (caller's JSON.parse explodes)
#   - substrate-internal `=== X ===` blocks (PROPAGATION, iterate · wave) leak
#     as spurious tool_calls (the public surface gets substrate noise)
#   - finish_reason isn't 'tool_calls' when blocks present / 'stop' when not
#   - the final `data: [DONE]` is missing (clients hang waiting)
#   - empty stdin doesn't exit 2 (silent fail on misuse)
set -euo pipefail

REAL_HOME="$HOME"
RENDER="$REAL_HOME/.claude/skills/contract/scripts/openai-render.py"
[ -f "$RENDER" ] || { echo "FAIL: openai-render.py not found at $RENDER"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT

# === Phase 1: empty input exits 2 ===
if echo -n "" | python3 "$RENDER" 2>/dev/null; then
  echo "FAIL: empty stdin should exit 2"; exit 1
fi

# === Phase 2: PASS-shape iterate (no requirement block) → finish_reason=stop ===
OUT_PASS=$(cat <<'EOF' | python3 "$RENDER"
  result: PASS (HTTP 200 — paid or free-tier covered)
  body:   {"ok":true,"balance_uc":42}
EOF
)
# Every line starts with data: or is blank
echo "$OUT_PASS" | grep -E "^data: " >/dev/null || { echo "FAIL: PASS output missing data: chunks"; exit 1; }
echo "$OUT_PASS" | grep -q "\"finish_reason\":\"stop\"" || { echo "FAIL: PASS finish_reason should be 'stop'. OUT=$OUT_PASS"; exit 1; }
echo "$OUT_PASS" | grep -q "data: \[DONE\]" || { echo "FAIL: missing final [DONE] sentinel"; exit 1; }
echo "$OUT_PASS" | grep -q "tool_calls" && { echo "FAIL: PASS output should not contain tool_calls"; exit 1; } || true

# === Phase 3: all four requirement blocks → four tool_calls ===
OUT_ALL=$(cat <<'EOF' | python3 "$RENDER"
  result: FAIL (multiple)

  === PAYMENT REQUIRED ===
  upstream: https://beta-api.unbrowse.ai/v1/credits/debit
  status:   402
  body:     {"pay_url":"https://x.example/pay","amount":"$0.10","asset":"USDC"}

  === SIGN-IN REQUIRED ===
  upstream: https://beta-api.unbrowse.ai/v1/billing/me
  status:   401

  === ROUTED ===
  target_canonical: lewis@getfoundry.app
  inbox_path:       /home/lewis/.contracts/inbox/agent/lewis@getfoundry.app.jsonl

  === INHIBITION REFUSAL ===
  inhibitor_ids: abc1234,def5678
EOF
)
for tool in payment_required sign_in_required agent_routed inhibition_refusal; do
  echo "$OUT_ALL" | grep -q "\"name\":\"$tool\"" || { echo "FAIL: tool_call '$tool' missing from output"; exit 1; }
done
echo "$OUT_ALL" | grep -q "\"finish_reason\":\"tool_calls\"" || { echo "FAIL: blocks-present finish_reason should be 'tool_calls'"; exit 1; }

# === Phase 4: each chunk is valid JSON, each tool_call's arguments is valid JSON ===
echo "$OUT_ALL" | grep "^data: {" | while read -r line; do
  payload="${line#data: }"
  echo "$payload" | python3 -c "import sys,json; json.loads(sys.stdin.read())" 2>/dev/null \
    || { echo "FAIL: SSE chunk not valid JSON: $line"; exit 1; }
done

# Validate tool_call.function.arguments is itself parseable JSON
echo "$OUT_ALL" | python3 -c "
import sys, json
for line in sys.stdin:
  line=line.strip()
  if not line.startswith('data: {'): continue
  obj=json.loads(line[6:])
  for ch in obj.get('choices',[]):
    for tc in ch.get('delta',{}).get('tool_calls',[]):
      args=tc['function']['arguments']
      try: json.loads(args)
      except Exception as e:
        print(f'FAIL: tool_call arguments not valid JSON: name={tc[\"function\"][\"name\"]} args={args!r} err={e}')
        sys.exit(1)
" || exit 1

# === Phase 5: substrate-internal blocks do NOT become tool_calls ===
OUT_INTERNAL=$(cat <<'EOF' | python3 "$RENDER"
  result: PASS

  === PROPAGATION (signal) ===
  abc1234 satisfied. wavefront — judge KEY 2 on each.

  === BREAK ON RESOLUTION (refractory) ===
  abc1234 just fired. KEY 3 (agent): pause and judge.
EOF
)
echo "$OUT_INTERNAL" | grep -q "tool_calls" && { echo "FAIL: substrate-internal blocks leaked as tool_calls"; exit 1; } || true
# But the text SHOULD contain the propagation header (preserved in content delta)
echo "$OUT_INTERNAL" | grep -q "PROPAGATION" || { echo "FAIL: internal block content lost"; exit 1; }

# === Phase 6: SSE shape — `data: ` prefix + blank-line separator ===
echo "$OUT_ALL" | python3 -c "
import sys
lines = sys.stdin.read().split('\n')
saw_data = False
for i, line in enumerate(lines):
  if line.startswith('data: '):
    saw_data = True
    # next line should be blank (SSE chunk separator)
    if i + 1 < len(lines) and lines[i+1] != '':
      print(f'FAIL: data: chunk at line {i} not followed by blank line: next={lines[i+1]!r}')
      sys.exit(1)
if not saw_data:
  print('FAIL: no data: chunks at all'); sys.exit(1)
" || exit 1

echo "PASS: openai-render gate (Φ1) — empty-stdin refused, PASS shape emits stop, four requirement-blocks emit tool_calls with valid JSON args, substrate-internal blocks stay in content, SSE format intact"
