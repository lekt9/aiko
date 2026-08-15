#!/bin/sh
set -eu
# Hermetic gate for machine-cockpit self-aware
# Checks self.json + cockpit /api/self + /api/telegram/self-aware + chat banner
# Passes locally; --live also checks Gbear

LIVE=0
if [ "${1:-}" = "--live" ]; then LIVE=1; fi

fail() { echo "GATE FAIL: $1" >&2; exit 1; }
pass() { echo "GATE PASS: $1"; }

echo "=== machine-cockpit self-aware gate ==="

# 1. self.json exists and valid
test -s ~/.aiko/self.json || fail "self.json missing"
python3 -c "import json,pathlib; d=json.loads(pathlib.Path.home().joinpath('.aiko/self.json').read_text()); assert d['aiko']['abi']==13, d['aiko']; assert 'version' in d['aiko']; assert 'signed_in' in d['auth']; assert d['schema']=='aiko.self.v1'" || fail "self.json schema"
pass "self.json schema + ABI 13"

# 2. artifacts include package
python3 -c "import json,pathlib; d=json.loads(pathlib.Path.home().joinpath('.aiko/self.json').read_text()); assert any(a.get('kind')=='package' for a in d.get('artifacts',[]))" || fail "artifacts missing package"
pass "artifacts has package"

# 3. No raw token in self.json (masked only)
if grep -qE ":[A-Za-z0-9_-]{30,}" ~/.aiko/self.json 2>/dev/null; then
  # Allow known commit SHAs, but not bot tokens (which are digit:long)
  if grep -qE "[0-9]{8,}:[A-Za-z0-9_-]{30,}" ~/.aiko/self.json; then fail "raw bot token in self.json"; fi
fi
pass "no raw token in self.json"

# 4. cockpit /api/self returns self.json live
if curl -s http://127.0.0.1:8787/api/health >/dev/null 2>&1; then
  curl -s http://127.0.0.1:8787/api/self 2>&1 | python3 -c "import json,sys; j=json.load(sys.stdin); assert j.get('schema')=='aiko.self.v1'; assert 'auth' in j; print('self ok', j['aiko']['version'])" || fail "/api/self"
  pass "GET /api/self"
  curl -s http://127.0.0.1:8787/api/telegram/self-aware 2>&1 | python3 -c "import json,sys; j=json.load(sys.stdin); assert 'hint' in j; assert 'pendingChats' in j; print('self-aware', j['hint'])" || fail "/api/telegram/self-aware"
  pass "GET /api/telegram/self-aware"
  curl -s http://127.0.0.1:8787/ 2>&1 | grep -q "statusBar" || fail "chat.html no statusBar"
  pass "chat.html statusBar"
else
  echo "SKIP: cockpit not running (no :8787)"
fi

# 5. chat.html has self-aware JS
grep -q "cachedAuth" .agents/skills/machine-cockpit/assets/chat.html || fail "chat.html no cachedAuth"
grep -q "Not signed in" .agents/skills/machine-cockpit/assets/chat.html || fail "chat.html no login prompt"
pass "chat.html self-aware JS"

# 6. build-self helper exists
test -f .agents/skills/machine-cockpit/scripts/build-self.py || fail "build-self.py missing"
python3 -m py_compile .agents/skills/machine-cockpit/scripts/build-self.py || fail "build-self.py compile"
pass "build-self.py"

if [ "$LIVE" = "1" ]; then
  echo "--- live vs Gbear ---"
  sshpass -p 'Sim1Ru1Qian1' ssh -F /dev/null -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive gbear@100.104.34.103 'curl -s http://127.0.0.1:8787/api/telegram/self-aware 2>&1 | python3 -c "import json,sys; j=json.load(sys.stdin); assert j.get(\"hint\") in (\"not_signed_in\",\"needs_pairing\",\"waiting_first_message\",\"ready\",\"bridge_stopped\",\"no_telegram_token\"); print(\"live hint\", j.get(\"hint\"))"' 2>&1 | grep -q "live hint" || fail "live Gbear hint"
  pass "live Gbear self-aware"
fi

echo "=== ALL PASS ==="
