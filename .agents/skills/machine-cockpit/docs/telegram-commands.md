# Telegram slash commands (BotFather + setMyCommands)

## BotFather (human, one-time)

```
@BotFather → /setcommands → pick @ianchampion_bot → paste:
start - Start with Aiko
help - What I can do
status - Where this bot stands
login - Sign in Aiko on this Mac
clear - Clear pairing (admin)
```

## Runtime (cockpit does this)

Every start, cockpit calls `setMyCommands` so autocomplete actually appears (BotFather text alone is not enough for clients to show it):

```sh
TOKEN=$(jq -r '.telegram.botToken' ~/.aiko/user-settings.json)
curl -s -X POST "https://api.telegram.org/bot$TOKEN/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands":[
    {"command":"start","description":"Start with Aiko"},
    {"command":"help","description":"What I can do"},
    {"command":"status","description":"Where this bot stands"},
    {"command":"login","description":"Sign in Aiko on this Mac"}
  ]}' | jq .
```

Remove stale webhook if polling: `curl .../deleteWebhook`.

## Contract wiring

| slash | contract | effect |
|---|---|---|
| `/start` `/help` | `telegram.commands.handle` (read) + `telegram.message.send` (write) | observe → self-aware status (hint/action) + inline keyboard `[Help][Status][Login]` |
| `/status` | `telegram.message.send` | `hint` + `pendingChats` + `approvedUserIds` + `auth` |
| `/login` | `telegram.message.send` | device-code instructions (`aiko login --device-code`) |
| unknown `/foo` | same | help text, not silence |

Every receive is `telegram.updates.observe` (Cursor `update_id+1` only after observe durable). Every send is `telegram.message.send` gated on `approved` (or FIRST_CONTACT auto-approve).
