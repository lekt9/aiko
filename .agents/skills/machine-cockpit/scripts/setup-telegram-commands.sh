#!/bin/sh
set -eu
# setMyCommands — makes slash commands autocomplete. Idempotent. Token never in logs.
# Usage: setup-telegram-commands.sh [--token "$TOKEN"]  (reads ~/.aiko/user-settings.json by default)

TOKEN="${1:-}"
if [ -z "$TOKEN" ] && [ -f "$HOME/.aiko/user-settings.json" ]; then
  TOKEN="$(python3 -c "import json,pathlib; print((json.loads(pathlib.Path.home().joinpath('.aiko/user-settings.json').read_text()).get('telegram') or {}).get('botToken',''))")"
fi
# allow --token flag
if [ "${1:-}" = "--token" ]; then TOKEN="${2:-}"; fi
if [ -z "$TOKEN" ]; then echo "no token found" >&2; exit 1; fi

# verify getMe first (contract: identity)
curl -s "https://api.telegram.org/bot$TOKEN/getMe" | python3 -c "import json,sys; j=json.load(sys.stdin); assert j.get('ok'), j; print('bot', j['result'].get('username'))" 2>&1 | head -5

# delete webhook if polling (we use getUpdates)
curl -s -X POST "https://api.telegram.org/bot$TOKEN/deleteWebhook" -H "Content-Type: application/json" -d '{}' 2>&1 | head -5 || true

# register commands (contract: telegram.commands.set)
curl -s -X POST "https://api.telegram.org/bot$TOKEN/setMyCommands" -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"start","description":"Start with Aiko"},
    {"command":"help","description":"What I can do"},
    {"command":"status","description":"Where this bot stands"},
    {"command":"login","description":"Sign in Aiko on this Mac"}
  ]}' | python3 -c "import json,sys; j=json.load(sys.stdin); print('setMyCommands', j.get('ok'), j.get('result'))" 2>&1 | head -10

# verify
curl -s "https://api.telegram.org/bot$TOKEN/getMyCommands" | python3 -c "import json,sys; j=json.load(sys.stdin); print('getMyCommands', [c['command'] for c in j.get('result',[])])" 2>&1 | head -10
echo "done — commands visible in Telegram autocomplete after a restart"
