#!/usr/bin/env bash
# verb-gate: runpod — alternative-backend serverless pointer-type.
#
# Plank 1 of DEFERRED-MEGA-VISION 386497eb. Symmetric to sandbox-gate;
# different upstream (RunPod /v2/<endpoint>/runsync vs turbobox /v1/boxes).
#
# Catches regressions where:
#   - pointer_type isn't "runpod" / layer != 1 (downstream queries break)
#   - missing RUNPOD_API_KEY silently passes instead of RUNPOD UNAVAILABLE
#   - COMPLETED status with non-zero exit_code is silently swallowed
#   - FAILED status doesn't surface the error message
#   - upstream 5xx is treated as success
#   - colon-in-intent gets truncated by greedy split
#   - malformed action passes through to the layer module without an ERROR
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
MOCK="$REAL_HOME/.claude/skills/contract/verb-gates/runpod/mock-runpod.py"
[ -f "$CLI" ]  || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }
[ -f "$MOCK" ] || { echo "FAIL: cannot locate mock runpod at $MOCK"; exit 1; }

TD=$(mktemp -d)
MOCK_PID=""
trap 'if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; fi; rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# === Phase 1: pointer_type inference is "runpod" + layer 1 ===
PTYPE=$(MH_ACTION="runpod:abc123:python3 -c 'print(1)'" python3 -c "
import sys, os
sys.path.insert(0, '$REAL_HOME/.claude/skills/contract/scripts/lib')
from contract_core import _infer_pointer_type, _infer_layer
print(_infer_pointer_type(os.environ['MH_ACTION']), _infer_layer(os.environ['MH_ACTION']))
")
[ "$PTYPE" = "runpod 1" ] || { echo "FAIL: pointer_type/layer for runpod: action is '$PTYPE', expected 'runpod 1'"; exit 1; }

# === Phase 2: missing RUNPOD_API_KEY emits RUNPOD UNAVAILABLE block ===
unset RUNPOD_API_KEY
CID_NOAUTH=$("$CLI" declare "runpod no-auth" --action "runpod:abc-xyz:echo hi" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$CID_NOAUTH" ] || { echo "FAIL: declare for runpod: returned no id"; exit 1; }
OUT_NOAUTH=$("$CLI" iterate "$CID_NOAUTH" 2>&1 || true)
echo "$OUT_NOAUTH" | grep -q "RUNPOD UNAVAILABLE"   || { echo "FAIL: missing key didn't emit block. OUT=$OUT_NOAUTH"; exit 1; }
echo "$OUT_NOAUTH" | grep -q "RUNPOD_API_KEY"       || { echo "FAIL: block doesn't name env var. OUT=$OUT_NOAUTH"; exit 1; }
echo "$OUT_NOAUTH" | grep -q "result: FAIL"         || { echo "FAIL: missing auth didn't FAIL. OUT=$OUT_NOAUTH"; exit 1; }

# === Spin up mock RunPod ===
MOCK_LOG="$TD/mock.log"
python3 "$MOCK" 0 > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 20); do
  grep -q "^PORT=" "$MOCK_LOG" 2>/dev/null && break
  sleep 0.15
done
MOCK_PORT=$(grep -oE "^PORT=[0-9]+" "$MOCK_LOG" | head -1 | cut -d= -f2)
[ -n "$MOCK_PORT" ] || { echo "FAIL: mock didn't bind. log=$(cat $MOCK_LOG)"; exit 1; }
export RUNPOD_BASE="http://127.0.0.1:$MOCK_PORT"
export RUNPOD_API_KEY="test-key-not-real"

# === Phase 3: happy path — COMPLETED + exit_code 0 ===
CID_OK=$("$CLI" declare "runpod happy" --action "runpod:ok-endpoint:echo hello-from-runpod" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_OK=$("$CLI" iterate "$CID_OK" 2>&1)
echo "$OUT_OK" | grep -q "pointer(runpod):"             || { echo "FAIL: iterate missing pointer(runpod): trace. OUT=$OUT_OK"; exit 1; }
echo "$OUT_OK" | grep -q "echo-back: echo hello-from-runpod" || { echo "FAIL: mock's stdout not surfaced. OUT=$OUT_OK"; exit 1; }
echo "$OUT_OK" | grep -q "result: PASS"                 || { echo "FAIL: happy path didn't PASS. OUT=$OUT_OK"; exit 1; }
echo "$OUT_OK" | grep -q "status=COMPLETED exit=0"      || { echo "FAIL: PASS line missing status/exit detail. OUT=$OUT_OK"; exit 1; }

# === Phase 4: COMPLETED with non-zero exit_code surfaces as FAIL (not swallowed) ===
CID_NZERO=$("$CLI" declare "runpod completed-nonzero" --action "runpod:fail-endpoint:any" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_NZERO=$("$CLI" iterate "$CID_NZERO" 2>&1 || true)
echo "$OUT_NZERO" | grep -qE "result: FAIL.*COMPLETED exit=7" || { echo "FAIL: COMPLETED+nonzero-exit didn't surface as FAIL with exit=7. OUT=$OUT_NZERO"; exit 1; }
echo "$OUT_NZERO" | grep -q "ran-then-failed: any"           || { echo "FAIL: stdout of failing handler not surfaced. OUT=$OUT_NZERO"; exit 1; }

# === Phase 5: FAILED status surfaces error name + propagates exit_code ===
CID_FAILED=$("$CLI" declare "runpod failed status" --action "runpod:errored-endpoint:any" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_FAILED=$("$CLI" iterate "$CID_FAILED" 2>&1 || true)
echo "$OUT_FAILED" | grep -qE "result: FAIL.*FAILED.*OOMKilled" || { echo "FAIL: FAILED-status didn't name error. OUT=$OUT_FAILED"; exit 1; }

# === Phase 6: upstream 5xx becomes RUNPOD UNAVAILABLE + FAIL (not silent) ===
CID_5XX=$("$CLI" declare "runpod 5xx" --action "runpod:broken-endpoint:any" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_5XX=$("$CLI" iterate "$CID_5XX" 2>&1 || true)
echo "$OUT_5XX" | grep -q "RUNPOD UNAVAILABLE"    || { echo "FAIL: 5xx didn't emit unavailable block. OUT=$OUT_5XX"; exit 1; }
echo "$OUT_5XX" | grep -qE "HTTP 502"             || { echo "FAIL: 5xx block doesn't name the HTTP code. OUT=$OUT_5XX"; exit 1; }
echo "$OUT_5XX" | grep -q "result: FAIL"          || { echo "FAIL: 5xx didn't FAIL. OUT=$OUT_5XX"; exit 1; }

# === Phase 7: colon-in-intent preserved (first-':' split only) ===
CID_COLON=$("$CLI" declare "runpod colon-intent" \
  --action "runpod:ok-endpoint:python3 -c 'import sys; print(\":\".join([\"a\",\"b\",\"c\"]))'" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_COLON=$("$CLI" iterate "$CID_COLON" 2>&1)
echo "$OUT_COLON" | grep -q "result: PASS"                          || { echo "FAIL: colon-intent didn't PASS. OUT=$OUT_COLON"; exit 1; }
echo "$OUT_COLON" | grep -q "python3 -c"                            || { echo "FAIL: full intent not preserved. OUT=$OUT_COLON"; exit 1; }
LAST_CMD=$(curl -s "http://127.0.0.1:$MOCK_PORT/__state" | python3 -c "import sys,json; print(json.load(sys.stdin)['last_cmd'])")
[[ "$LAST_CMD" == python3* && "$LAST_CMD" == *':'* ]] || { echo "FAIL: mock received truncated cmd: '$LAST_CMD'"; exit 1; }

# === Phase 8: malformed action (no intent) errors cleanly ===
CID_BAD=$("$CLI" declare "runpod malformed" --action "runpod:ok-endpoint" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_BAD=$("$CLI" iterate "$CID_BAD" 2>&1 || true)
echo "$OUT_BAD" | grep -qE "ERROR.*runpod:.*endpoint_id.*intent" || { echo "FAIL: malformed runpod: didn't emit clean ERROR. OUT=$OUT_BAD"; exit 1; }

echo "PASS: runpod gate — pointer_type/layer inferred, no-auth structured block, happy COMPLETED+0, COMPLETED+nonzero FAILs honestly, FAILED-status surfaces error, 5xx → UNAVAILABLE, colon-in-intent preserved, malformed action errors cleanly"
