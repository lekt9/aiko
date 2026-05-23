#!/usr/bin/env bash
# probe-outbound-tag.sh — gate for child 93bc4314 of b2d15246.
#
# Asserts: tag-outbound.py exists + executable; appended row has the right
# fields; refuses missing required args; --reply-to + --extra-json round-trip.
set -e

TAGGER="$HOME/.claude/skills/contract/scripts/tag-outbound.py"
[ -x "$TAGGER" ] || { echo "FAIL: $TAGGER missing or not executable"; exit 1; }

TMPHOME=$(mktemp -d)
trap 'rm -rf "$TMPHOME"' EXIT
HOME="$TMPHOME"
export HOME

# Happy path
OUT=$(python3 "$TAGGER" --channel telegram --message-id 12345 --origin-contract-id abc12345 --reply-to 999 --extra-json '{"thread_id":2738}' 2>&1)
echo "$OUT" | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
assert d["ok"] is True, f"not ok: {d}"
r=d["row"]
assert r["channel"]=="telegram"
assert r["message_id"]=="12345"
assert r["origin_contract_id"]=="abc12345"
assert r["reply_to"]=="999"
assert r["thread_id"]==2738
assert r["sent_at"].endswith("Z")
' || { echo "FAIL: happy-path row malformed"; echo "  out: $OUT"; exit 1; }
echo "PASS: happy-path row written with all fields"

# Idempotent append (call again, file should have 2 lines)
python3 "$TAGGER" --channel telegram --message-id 12345 --origin-contract-id abc12345 >/dev/null
NLINES=$(wc -l < "$TMPHOME/.contracts/outbox/telegram/12345.jsonl" | tr -d ' ')
[ "$NLINES" = "2" ] || { echo "FAIL: expected 2 appended rows, got $NLINES"; exit 1; }
echo "PASS: append is idempotent (file grows by 1 per call)"

# Refuses missing required arg
if python3 "$TAGGER" --channel telegram --message-id 12345 2>/dev/null; then
  echo "FAIL: should have refused missing --origin-contract-id"; exit 1
fi
echo "PASS: missing required arg refused"

# Refuses bad --extra-json
if python3 "$TAGGER" --channel x --message-id 1 --origin-contract-id deadbeef --extra-json 'not json' 2>/dev/null; then
  echo "FAIL: should have refused bad --extra-json"; exit 1
fi
echo "PASS: malformed --extra-json refused"

echo
echo "probe-outbound-tag: PASS"
exit 0
