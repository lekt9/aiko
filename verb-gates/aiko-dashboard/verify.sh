#!/bin/bash
# aiko dashboard gate: `aiko dashboard --once` renders valid HTML; live
# server serves /, /api/state.json, and 404s on bogus paths.
set -e
AIKO=~/.claude/skills/aiko/scripts/aiko

# --once mode
OUT=$($AIKO dashboard --once 2>&1)
echo "$OUT" | grep -q "<!doctype html>" || { echo "FAIL: dashboard --once didn't render HTML"; exit 1; }
echo "$OUT" | grep -q "aiko cells" || { echo "FAIL: dashboard missing aiko cells section"; exit 1; }
echo "$OUT" | grep -q "dogfeed inboxes" || { echo "FAIL: dashboard missing dogfeed section"; exit 1; }
echo "$OUT" | grep -q "recent activity" || { echo "FAIL: dashboard missing activity section"; exit 1; }

# pick a free port and run live for 1.5s
PORT=$((9000 + RANDOM % 1000))
$AIKO dashboard --no-browser --port $PORT >/tmp/aiko-dash-gate.log 2>&1 &
PID=$!
trap "kill $PID 2>/dev/null; wait 2>/dev/null; true" EXIT
sleep 1
HTML_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" 2>&1)
[ "$HTML_CODE" = "200" ] || { echo "FAIL: /  returned $HTML_CODE"; exit 1; }
JSON_BODY=$(curl -sS "http://127.0.0.1:$PORT/api/state.json")
echo "$JSON_BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'cells' in d and 'activity' in d and 'dogfeed' in d" || { echo "FAIL: /api/state.json schema"; exit 1; }
NF_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/bogus")
[ "$NF_CODE" = "404" ] || { echo "FAIL: /bogus returned $NF_CODE (expected 404)"; exit 1; }
echo "PASS: aiko dashboard serves HTML+JSON+404 on port $PORT"
