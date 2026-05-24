#!/usr/bin/env bash
# verb-gate: sandbox (Χ6) — turbobox remote-container pointer-type.
#
# Catches regressions where:
#   - pointer_type isn't "sandbox" on the declared row (downstream queries break)
#   - missing TURBOBOX_API_KEY silently passes instead of emitting SANDBOX UNAVAILABLE
#   - upstream HTTP errors (404/500) get treated as success
#   - exec exit_code is ignored (non-zero falsely PASSes)
#   - DELETE cleanup is skipped (box leak)
#   - intent containing ":" gets truncated by greedy split
#
# Uses a local Python http.server mock so the gate has no network dependency.
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
MOCK="$REAL_HOME/.claude/skills/contract/verb-gates/sandbox/mock-turbobox.py"
[ -f "$CLI" ]  || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }
[ -f "$MOCK" ] || { echo "FAIL: cannot locate mock turbobox at $MOCK"; exit 1; }

TD=$(mktemp -d)
MOCK_PID=""
trap 'if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; fi; rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# === Phase 1: pointer_type inference is "sandbox" ===
PTYPE=$(MH_ACTION="sandbox:python:echo hi" python3 -c "
import sys, os
sys.path.insert(0, '$REAL_HOME/.claude/skills/contract/scripts/lib')
from contract_core import _infer_pointer_type, _infer_layer
print(_infer_pointer_type(os.environ['MH_ACTION']), _infer_layer(os.environ['MH_ACTION']))
")
[ "$PTYPE" = "sandbox 1" ] || { echo "FAIL: pointer_type/layer for sandbox: action is '$PTYPE', expected 'sandbox 1'"; exit 1; }

# === Phase 2: missing TURBOBOX_API_KEY emits SANDBOX UNAVAILABLE block ===
unset TURBOBOX_API_KEY
CID_NOAUTH=$("$CLI" declare "sandbox no-auth" --action "sandbox:python:echo hi" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$CID_NOAUTH" ] || { echo "FAIL: declare for sandbox: returned no id"; exit 1; }
OUT_NOAUTH=$("$CLI" iterate "$CID_NOAUTH" 2>&1 || true)
echo "$OUT_NOAUTH" | grep -q "SANDBOX UNAVAILABLE"      || { echo "FAIL: missing API key didn't emit SANDBOX UNAVAILABLE block. OUT=$OUT_NOAUTH"; exit 1; }
echo "$OUT_NOAUTH" | grep -q "TURBOBOX_API_KEY"         || { echo "FAIL: SANDBOX UNAVAILABLE block doesn't name the env var. OUT=$OUT_NOAUTH"; exit 1; }
echo "$OUT_NOAUTH" | grep -q "result: FAIL"             || { echo "FAIL: missing auth didn't surface FAIL line. OUT=$OUT_NOAUTH"; exit 1; }

# === Spin up mock turbobox on a free ephemeral port ===
MOCK_LOG="$TD/mock.log"
python3 "$MOCK" 0 > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
# wait for PORT= line (max ~3s)
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if grep -q "^PORT=" "$MOCK_LOG" 2>/dev/null; then break; fi
  sleep 0.2
done
MOCK_PORT=$(grep -oE "^PORT=[0-9]+" "$MOCK_LOG" | head -1 | cut -d= -f2)
[ -n "$MOCK_PORT" ] || { echo "FAIL: mock turbobox didn't bind a port. log=$(cat $MOCK_LOG)"; exit 1; }

export TURBOBOX_URL="http://127.0.0.1:$MOCK_PORT"
export TURBOBOX_API_KEY="test-key-not-real"

# === Phase 3: happy path — exec succeeds with exit_code 0 ===
CID_OK=$("$CLI" declare "sandbox happy path" --action "sandbox:python:echo hello-from-sandbox" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_OK=$("$CLI" iterate "$CID_OK" 2>&1)
echo "$OUT_OK" | grep -q "pointer(sandbox):"             || { echo "FAIL: iterate missing pointer(sandbox): trace. OUT=$OUT_OK"; exit 1; }
echo "$OUT_OK" | grep -q "echo-back: echo hello-from-sandbox" || { echo "FAIL: mock's exec output not surfaced. OUT=$OUT_OK"; exit 1; }
echo "$OUT_OK" | grep -q "result: PASS"                  || { echo "FAIL: happy path didn't PASS. OUT=$OUT_OK"; exit 1; }

# === Phase 4: exec non-zero exit_code surfaces as FAIL (not swallowed) ===
CID_FAIL=$("$CLI" declare "sandbox exec fails" --action "sandbox:python:FAILME intentionally" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_FAIL=$("$CLI" iterate "$CID_FAIL" 2>&1 || true)
echo "$OUT_FAIL" | grep -qE "result: FAIL.*exit=7"       || { echo "FAIL: non-zero exec exit_code didn't propagate. OUT=$OUT_FAIL"; exit 1; }

# === Phase 5: cleanup — every successful exec triggers DELETE ===
STATE=$(curl -s "http://127.0.0.1:$MOCK_PORT/__state")
CREATED=$(printf '%s' "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['created'])")
DESTROYED=$(printf '%s' "$STATE" | python3 -c "import sys,json; print(json.load(sys.stdin)['destroyed'])")
LIVE=$(printf '%s' "$STATE" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['live_boxes']))")
[ "$CREATED" = "2" ]   || { echo "FAIL: expected 2 create calls (happy + failme), got $CREATED. STATE=$STATE"; exit 1; }
[ "$DESTROYED" = "2" ] || { echo "FAIL: expected 2 DELETE cleanups, got $DESTROYED. STATE=$STATE"; exit 1; }
[ "$LIVE" = "0" ]      || { echo "FAIL: expected 0 live boxes after cleanup, got $LIVE. STATE=$STATE"; exit 1; }

# === Phase 6: intent containing ':' is preserved (image:intent split is first-only) ===
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__reset" > /dev/null
CID_COLON=$("$CLI" declare "sandbox colon in intent" \
  --action "sandbox:python:python3 -c 'import sys; print(\":\".join([\"a\",\"b\",\"c\"]))'" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_COLON=$("$CLI" iterate "$CID_COLON" 2>&1)
echo "$OUT_COLON" | grep -q 'a":"b' && { echo "FAIL: colon-split happened too early (intent was truncated at first ':'). OUT=$OUT_COLON"; exit 1; }
echo "$OUT_COLON" | grep -q 'python3 -c'                    || { echo "FAIL: full intent not preserved through to mock. OUT=$OUT_COLON"; exit 1; }
echo "$OUT_COLON" | grep -q "result: PASS"                  || { echo "FAIL: colon-intent didn't PASS. OUT=$OUT_COLON"; exit 1; }

# === Phase 7: malformed action (no intent after image) errors cleanly ===
CID_BAD=$("$CLI" declare "sandbox malformed" --action "sandbox:python" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
OUT_BAD=$("$CLI" iterate "$CID_BAD" 2>&1 || true)
echo "$OUT_BAD" | grep -qE "ERROR.*sandbox:.*image.*intent" || { echo "FAIL: malformed sandbox: action didn't emit a clear ERROR. OUT=$OUT_BAD"; exit 1; }

echo "PASS: sandbox gate (Χ6) — pointer_type/layer inferred, missing-auth structured block, happy path round-trips through mock, non-zero exec FAILs honestly, DELETE cleanup verified, colon-in-intent preserved, malformed action errors cleanly"
