#!/usr/bin/env bash
# verb-gates/context/verify.sh — binds the `contract context` verb.
#
# R8 channel-context mode (gap 91d78419, 2026-05-25):
#   `contract context <channel-id> [--limit N]` resolves a channel ledger
#   at ~/.contracts/channels/<channel-id>/contracts.jsonl, walks it, and
#   returns {channel, limit, events, count} as JSON. Last N rows in
#   chronological order. Missing channel returns count == 0 with empty
#   events shape (genuine empty case, not a stub per Γ1).
#
# Substrate-enables (5b9574ee): verb returns rows; agent judges.
# Locality (79c2d656): channel ledger stays scoped; promotion is explicit.
set -e

CLI="$HOME/.claude/skills/contract/scripts/contract"
CHAN="test-r8-channel-$$"
CHANDIR="$HOME/.contracts/channels/$CHAN"
cleanup() { rm -rf "$CHANDIR"; }
trap cleanup EXIT

assert_shape() {
  local phase="$1" expected_count="$2" expected_first_seq="$3" expected_last_seq="$4" json="$5"
  CHANNEL_ID="$CHAN" EXP_COUNT="$expected_count" EXP_FIRST="$expected_first_seq" EXP_LAST="$expected_last_seq" \
    python3 - <<'PY' <<<"$json"
import json, os, sys
d = json.loads(sys.stdin.read())
chan = os.environ["CHANNEL_ID"]
exp_count = int(os.environ["EXP_COUNT"])
exp_first = os.environ["EXP_FIRST"]
exp_last  = os.environ["EXP_LAST"]
assert d["channel"] == chan, f"channel mismatch: got {d.get('channel')!r}, expected {chan!r}"
assert d["count"] == exp_count, f"count mismatch: got {d['count']}, expected {exp_count}"
assert isinstance(d["events"], list), f"events not a list: {type(d['events']).__name__}"
assert len(d["events"]) == exp_count, f"events length {len(d['events'])} != count {exp_count}"
if exp_count == 0:
    assert d["events"] == [], f"expected empty list, got {d['events']!r}"
else:
    got_first = d["events"][0].get("seq")
    got_last  = d["events"][-1].get("seq")
    assert str(got_first) == exp_first, f"first.seq mismatch: got {got_first!r}, expected {exp_first!r}"
    assert str(got_last)  == exp_last,  f"last.seq mismatch: got {got_last!r}, expected {exp_last!r}"
print("OK", flush=True)
PY
}

# Phase A — missing channel returns count=0, empty events, no error
MISSING=$("$CLI" context "$CHAN" --limit 5 2>&1)
assert_shape "A" 0 "" "" "$MISSING" >/dev/null || { echo "FAIL(A): missing-channel envelope wrong"; echo "$MISSING"; exit 1; }
echo "PASS(A): missing channel returns count=0 empty-events shape"

# Phase B — seed 3 rows, --limit 2 returns the LAST 2 in chronological order
mkdir -p "$CHANDIR"
LEDGER="$CHANDIR/contracts.jsonl"
printf '%s\n' '{"event":"inbound","seq":1,"ts":"2026-05-25T00:00:01Z","msg":"first"}' >> "$LEDGER"
printf '%s\n' '{"event":"poll_delta","seq":2,"ts":"2026-05-25T00:00:02Z","msg":"second"}' >> "$LEDGER"
printf '%s\n' '{"event":"claim","seq":3,"ts":"2026-05-25T00:00:03Z","msg":"third"}' >> "$LEDGER"

OUT=$("$CLI" context "$CHAN" --limit 2 2>&1)
assert_shape "B" 2 "2" "3" "$OUT" >/dev/null || { echo "FAIL(B): channel envelope wrong shape/order"; echo "$OUT"; exit 1; }
echo "PASS(B): channel returns last 2 rows in chronological order (seq 2 then seq 3)"

# Phase C — no --limit uses the default window (5) — still returns all 3 here
OUT_ALL=$("$CLI" context "$CHAN" 2>&1)
assert_shape "C" 3 "1" "3" "$OUT_ALL" >/dev/null || { echo "FAIL(C): default-limit envelope wrong"; echo "$OUT_ALL"; exit 1; }
echo "PASS(C): default limit returns all 3 rows in chronological order (seq 1..3)"

echo
echo "verb-gates/context: PASS (R8 channel-context)"
exit 0
