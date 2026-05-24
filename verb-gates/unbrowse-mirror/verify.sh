#!/usr/bin/env bash
# verb-gate: unbrowse-mirror (Π4) — tail-and-forward hook + raw-row mirror endpoint.
#
# Catches regressions where:
#   - hook doesn't fire on iterate/mark events (bus integration broken)
#   - missing UNBROWSE_API_KEY raises a traceback (silent-skip discipline broken)
#   - cursor advances on 5xx (loses retry guarantee on transient failure)
#   - cursor doesn't advance on 4xx (would deadlock on one malformed row)
#   - duplicate POSTs create multiple mirror rows (server-side idempotency broken)
#   - any event type would be skipped (the trunk is the source, not the bus event)
#
# Mock unbrowse server replicates the production mirror endpoint
# (auth + content-hash dedup + force-status injection).
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
HOOK="$REAL_HOME/.contracts/hooks/unbrowse-mirror.py"
MOCK="$REAL_HOME/.claude/skills/contract/verb-gates/unbrowse-mirror/mock-unbrowse.py"
[ -f "$CLI" ]  || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }
[ -f "$HOOK" ] || { echo "FAIL: cannot locate hook at $HOOK"; exit 1; }
[ -f "$MOCK" ] || { echo "FAIL: cannot locate mock at $MOCK"; exit 1; }

TD=$(mktemp -d)
MOCK_PID=""
ORIG_HOOK_DIR="$REAL_HOME/.contracts/hooks"
SANDBOX_HOOK_DIR="$TD/.contracts/hooks"
trap '
  if [ -n "$MOCK_PID" ]; then kill "$MOCK_PID" 2>/dev/null || true; fi
  rm -rf "$TD"
' EXIT

# Sandbox HOME so the hook reads/writes to TD ledger + cursor + errors.log,
# not the real ~/.contracts/. Symlink the hook + the bundled hooks the bus
# needs (drive-advance, watch-tick) so the bus has the same shape.
export HOME="$TD"
export CONTRACTS_STORE="$TD/.contracts/contracts.jsonl"
mkdir -p "$SANDBOX_HOOK_DIR" "$TD/.contracts/inbox" "$TD/.config/contract"
# Copy the hook under test directly (so we read the latest source, not a stale link)
cp "$HOOK" "$SANDBOX_HOOK_DIR/unbrowse-mirror.py"
chmod +x "$SANDBOX_HOOK_DIR/unbrowse-mirror.py"
# Bus needs drive-advance so iterate doesn't fail with missing-hook; symlink
# the real one (drives don't write outside their own state files in TD).
ln -sf "$ORIG_HOOK_DIR/drive-advance.sh" "$SANDBOX_HOOK_DIR/drive-advance.sh" 2>/dev/null || true

# === Spin up mock unbrowse on a free port ===
MOCK_LOG="$TD/mock.log"
python3 "$MOCK" 0 > "$MOCK_LOG" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 20); do
  grep -q "^PORT=" "$MOCK_LOG" 2>/dev/null && break
  sleep 0.15
done
MOCK_PORT=$(grep -oE "^PORT=[0-9]+" "$MOCK_LOG" | head -1 | cut -d= -f2)
[ -n "$MOCK_PORT" ] || { echo "FAIL: mock didn't bind. log=$(cat $MOCK_LOG)"; exit 1; }
export UNBROWSE_BASE="http://127.0.0.1:$MOCK_PORT"

# === Phase 1: hook silent-skips when UNBROWSE_API_KEY is unset ===
unset UNBROWSE_API_KEY
CID1=$("$CLI" declare "phase1 silent skip" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
"$CLI" iterate "$CID1" > /dev/null 2>&1 || true
# Drain background hook execution
sleep 0.5
STATE_AFTER_NOAUTH=$(curl -s "http://127.0.0.1:$MOCK_PORT/__state")
CALLS_NOAUTH=$(printf '%s' "$STATE_AFTER_NOAUTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['call_count'])")
[ "$CALLS_NOAUTH" = "0" ] || { echo "FAIL: hook called mirror with no API key set (count=$CALLS_NOAUTH)"; exit 1; }
# errors.log should be empty or non-existent (silent skip, no traceback)
if [ -s "$SANDBOX_HOOK_DIR/errors.log" ]; then
  if grep -q "Traceback\|unbrowse-mirror" "$SANDBOX_HOOK_DIR/errors.log"; then
    echo "FAIL: silent-skip leaked traceback to errors.log:"
    cat "$SANDBOX_HOOK_DIR/errors.log"
    exit 1
  fi
fi

# === Phase 2: with API key, hook fires on iterate and POSTs the rows to the mirror ===
export UNBROWSE_API_KEY="test-bearer-not-real"
# Reset mock state to count only phase 2's POSTs
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__reset" > /dev/null
# Reset cursor — phase 1 may have already established one in TD
rm -f "$TD/.contracts/.unbrowse-mirror-cursor"

CID2=$("$CLI" declare "phase2 mirror reaches mock" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$CID2" ] || { echo "FAIL: phase 2 declare returned no id"; exit 1; }
"$CLI" iterate "$CID2" > /dev/null 2>&1
sleep 0.6
# Mark satisfied with proof — this fires another bus event
"$CLI" _mark "$CID2" satisfied --proof "phase 2 mark" > /dev/null 2>&1
sleep 0.6

STATE_P2=$(curl -s "http://127.0.0.1:$MOCK_PORT/__state")
RECEIVED_P2=$(printf '%s' "$STATE_P2" | python3 -c "
import sys, json
s = json.load(sys.stdin)
rows = s['received_rows']
events = sorted({r['row'].get('event') for r in rows})
ids = sorted({r['row'].get('id') for r in rows})
print('events:', ','.join(filter(None, events)))
print('ids:', ','.join(filter(None, ids)))
print('count:', len(rows))
print('contains_cid2:', '$CID2' in ids)
")
echo "$RECEIVED_P2" | grep -q "contains_cid2: True" || {
  echo "FAIL: mock did not receive the phase-2 contract's rows. STATE=$STATE_P2"; exit 1; }
# Must include at least declared + iterated + satisfied for CID2
echo "$RECEIVED_P2" | grep -q "events:.*declared" || { echo "FAIL: declared row not mirrored. $RECEIVED_P2"; exit 1; }
echo "$RECEIVED_P2" | grep -q "events:.*iterated" || { echo "FAIL: iterated row not mirrored. $RECEIVED_P2"; exit 1; }
echo "$RECEIVED_P2" | grep -q "events:.*satisfied" || { echo "FAIL: satisfied row not mirrored. $RECEIVED_P2"; exit 1; }

# === Phase 3: double-fire is idempotent on the server ===
COUNT_BEFORE=$(printf '%s' "$STATE_P2" | python3 -c "import sys,json; print(json.load(sys.stdin)['call_count'])")
UNIQUE_BEFORE=$(printf '%s' "$STATE_P2" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['unique_event_ids']))")
# Run the hook again manually — should hit the cursor at end-of-trunk, POST nothing
python3 "$SANDBOX_HOOK_DIR/unbrowse-mirror.py" "iterate" "noop" "0" 2>&1
sleep 0.3
STATE_P3=$(curl -s "http://127.0.0.1:$MOCK_PORT/__state")
COUNT_AFTER=$(printf '%s' "$STATE_P3" | python3 -c "import sys,json; print(json.load(sys.stdin)['call_count'])")
UNIQUE_AFTER=$(printf '%s' "$STATE_P3" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['unique_event_ids']))")
[ "$COUNT_AFTER" = "$COUNT_BEFORE" ] || { echo "FAIL: re-fire POSTed past end-of-trunk (calls $COUNT_BEFORE → $COUNT_AFTER)"; exit 1; }
[ "$UNIQUE_AFTER" = "$UNIQUE_BEFORE" ] || { echo "FAIL: unique event_ids drifted on re-fire ($UNIQUE_BEFORE → $UNIQUE_AFTER)"; exit 1; }

# === Phase 4: 5xx does NOT advance the cursor (transient retry semantics) ===
curl -s -X POST "http://127.0.0.1:$MOCK_PORT/__reset" > /dev/null
rm -f "$TD/.contracts/.unbrowse-mirror-cursor"
CID4=$("$CLI" declare "phase4 5xx retry" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
# Force the next POST to return 503
curl -s -X POST -d '{"status":503,"message":"transient"}' "http://127.0.0.1:$MOCK_PORT/__force-status" > /dev/null
# Fire the hook manually so we can read the cursor state right after
CURSOR_BEFORE=$(cat "$TD/.contracts/.unbrowse-mirror-cursor" 2>/dev/null || echo 0)
python3 "$SANDBOX_HOOK_DIR/unbrowse-mirror.py" "iterate" "$CID4" "0" 2>&1 || true
sleep 0.2
CURSOR_AFTER_5XX=$(cat "$TD/.contracts/.unbrowse-mirror-cursor" 2>/dev/null || echo 0)
# Now fire again — 503 force was one-shot so this should succeed and advance
python3 "$SANDBOX_HOOK_DIR/unbrowse-mirror.py" "iterate" "$CID4" "0" 2>&1
sleep 0.2
CURSOR_AFTER_RETRY=$(cat "$TD/.contracts/.unbrowse-mirror-cursor" 2>/dev/null || echo 0)
# The cursor MAY have advanced past rows that came before the 503'd row, but
# NOT past the 503'd row itself — so the retry must move it further forward.
[ "$CURSOR_AFTER_RETRY" -gt "$CURSOR_AFTER_5XX" ] || {
  echo "FAIL: 5xx didn't gate cursor advancement (before=$CURSOR_BEFORE after_5xx=$CURSOR_AFTER_5XX retry=$CURSOR_AFTER_RETRY)"
  echo "errors.log:"; cat "$SANDBOX_HOOK_DIR/errors.log" 2>/dev/null || true
  exit 1
}
# Verify a 5xx line landed in the error log
grep -q "5xx" "$SANDBOX_HOOK_DIR/errors.log" || { echo "FAIL: 5xx wasn't logged. errors.log=$(cat $SANDBOX_HOOK_DIR/errors.log 2>/dev/null)"; exit 1; }

# === Phase 5: 4xx DOES advance (malformed unretryable, don't deadlock the cursor) ===
curl -s -X POST -d '{"status":400,"message":"row malformed"}' "http://127.0.0.1:$MOCK_PORT/__force-status" > /dev/null
CURSOR_PRE_4XX=$(cat "$TD/.contracts/.unbrowse-mirror-cursor" 2>/dev/null || echo 0)
# Append a synthetic row to the ledger to give the hook something past the cursor
LEDGER_FILE="$TD/.contracts/contracts.jsonl"
python3 -c "
import json
row = {'event':'iterated','id':'fake0000','wave':99,'ts':'2026-05-24T12:00:00Z','action_exit':0,'action_result':'pass'}
print(json.dumps(row))
" >> "$LEDGER_FILE"
python3 "$SANDBOX_HOOK_DIR/unbrowse-mirror.py" "iterate" "fake0000" "0" 2>&1
sleep 0.2
CURSOR_POST_4XX=$(cat "$TD/.contracts/.unbrowse-mirror-cursor" 2>/dev/null || echo 0)
[ "$CURSOR_POST_4XX" -gt "$CURSOR_PRE_4XX" ] || {
  echo "FAIL: 4xx didn't advance cursor (would deadlock on malformed row). pre=$CURSOR_PRE_4XX post=$CURSOR_POST_4XX"
  exit 1
}
grep -q "4xx" "$SANDBOX_HOOK_DIR/errors.log" || { echo "FAIL: 4xx wasn't logged"; exit 1; }

# === Phase 6: hook never raises uncaught — outermost catch-all works ===
# Point at a deliberately-bad URL to provoke a connection error; hook must return 0
export UNBROWSE_BASE="http://127.0.0.1:1"  # nothing listening
CURSOR_PRE_TRANSPORT=$(cat "$TD/.contracts/.unbrowse-mirror-cursor" 2>/dev/null || echo 0)
# Append another fake row
python3 -c "
import json
row = {'event':'iterated','id':'fake0001','wave':100,'ts':'2026-05-24T12:00:01Z','action_exit':0}
print(json.dumps(row))
" >> "$LEDGER_FILE"
python3 "$SANDBOX_HOOK_DIR/unbrowse-mirror.py" "iterate" "fake0001" "0" 2>&1
TRANSPORT_EXIT=$?
[ "$TRANSPORT_EXIT" = "0" ] || { echo "FAIL: hook exited $TRANSPORT_EXIT on transport error (must be 0)"; exit 1; }
CURSOR_POST_TRANSPORT=$(cat "$TD/.contracts/.unbrowse-mirror-cursor" 2>/dev/null || echo 0)
[ "$CURSOR_POST_TRANSPORT" = "$CURSOR_PRE_TRANSPORT" ] || {
  echo "FAIL: cursor advanced on transport error (lost retry guarantee). pre=$CURSOR_PRE_TRANSPORT post=$CURSOR_POST_TRANSPORT"; exit 1; }
grep -q "transport error" "$SANDBOX_HOOK_DIR/errors.log" || { echo "FAIL: transport error wasn't logged"; exit 1; }

echo "PASS: unbrowse-mirror gate (Π4) — silent-skip without API key, mirrors declared+iterated+satisfied via bus, double-fire idempotent end-of-trunk, 5xx gates cursor (retry semantics), 4xx advances cursor (no malformed-row deadlock), transport error returns exit 0 + doesn't advance cursor"
