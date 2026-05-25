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

# Phase A — missing channel returns count=0, empty events, no error
MISSING=$("$CLI" context "$CHAN" --limit 5 2>&1)
echo "$MISSING" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
assert d["channel"] == "'"$CHAN"'", f"channel mismatch: {d}"
assert d["count"] == 0, f"expected count=0 for missing channel, got {d[\"count\"]}"
assert d["events"] == [], f"expected empty events for missing channel, got {d[\"events\"]}"
' || { echo "FAIL(A): missing-channel envelope wrong shape"; echo "$MISSING"; exit 1; }
echo "PASS(A): missing channel returns count=0 empty-events shape"

# Phase B — seed 3 rows, --limit 2 returns the LAST 2 in chronological order
mkdir -p "$CHANDIR"
LEDGER="$CHANDIR/contracts.jsonl"
printf '%s\n' '{"event":"inbound","seq":1,"ts":"2026-05-25T00:00:01Z","msg":"first"}' >> "$LEDGER"
printf '%s\n' '{"event":"poll_delta","seq":2,"ts":"2026-05-25T00:00:02Z","msg":"second"}' >> "$LEDGER"
printf '%s\n' '{"event":"claim","seq":3,"ts":"2026-05-25T00:00:03Z","msg":"third"}' >> "$LEDGER"

OUT=$("$CLI" context "$CHAN" --limit 2 2>&1)
echo "$OUT" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
assert d["channel"] == "'"$CHAN"'", f"channel mismatch: {d}"
assert d["count"] == 2, f"expected count=2, got {d[\"count\"]}"
assert isinstance(d["events"], list) and len(d["events"]) == 2, f"events not 2-element list: {d}"
# Chronological order: last 2 are seq 2 then seq 3
assert d["events"][0]["seq"] == 2, f"events[0].seq expected 2, got {d[\"events\"][0]}"
assert d["events"][1]["seq"] == 3, f"events[1].seq expected 3, got {d[\"events\"][1]}"
' || { echo "FAIL(B): channel envelope wrong shape/order"; echo "$OUT"; exit 1; }
echo "PASS(B): channel returns last 2 rows in chronological order"

# Phase C — no --limit defaults to a sane window (still returns all 3 here)
OUT_ALL=$("$CLI" context "$CHAN" 2>&1)
echo "$OUT_ALL" | python3 -c '
import json, sys
d = json.loads(sys.stdin.read())
assert d["channel"] == "'"$CHAN"'", f"channel mismatch: {d}"
assert d["count"] == 3, f"expected count=3 (all rows), got {d[\"count\"]}"
assert d["events"][0]["seq"] == 1 and d["events"][-1]["seq"] == 3, f"order wrong: {d[\"events\"]}"
' || { echo "FAIL(C): default-limit envelope wrong"; echo "$OUT_ALL"; exit 1; }
echo "PASS(C): default limit returns all 3 rows in chronological order"

echo
echo "verb-gates/context: PASS (R8 channel-context)"
exit 0
