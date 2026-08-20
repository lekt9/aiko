# Channel API — provider-generic wiring

Every channel is one `provider=` row, not a branch. Telegram was the first
provider=`telegram` row; `provider=telegram` is one row, Slack/Discord reuse the same shape.

## Provider table

| provider | token env | user-settings key | wiring[] bridgeState | capabilities |
|---|---|---|---|---|
| `telegram` | `TELEGRAM_BOT_TOKEN` | `telegram.botToken` | Running/Stopped/Error | getMe, getUpdates poll, sendMessage + typing, getFile, sendPhoto/Document/Voice, inline keyboards, deleteWebhook |
| `slack` | `SLACK_BOT_TOKEN` | `slack.botToken` | same | Events API, chat.postMessage, files.upload, typing |
| `discord` | `DISCORD_BOT_TOKEN` | `discord.botToken` | same | Gateway, create_message, attachments |
| `webhook` | `WEBHOOK_TOKEN` | `webhook.token` | same | HTTP poll/webhook per OPENAPI |

## How to add a provider

1. `ChannelRegistry::register(Provider::Slack)` in `crates/codegen/xai-channel-core/src/lib.rs` — enum + env var + settings key.
2. `Provider` row in `docs/channel-api.md` (this file) + cockpit docs.
3. Cockpit: `wiring[]` already generic — push `{provider, bridgeState, tokenTail}`; `chat.html` renders tabs from wiring`.
4. Daemon: new `crates/codegen/xai-<provider>-daemon` or a single `xai-channel-daemon` dispatching on `provider`.

No edits to `xai-channel-core` routing, `BridgeState`, or `ChannelReply` enum beyond the provider row.

## Contracts per provider

Each provider honors: `observe` (durable task before ack) -> `approved` gate -> `send/chatAction/media/callback/commands`.
Every provider's worker returns `ChannelReply` (discriminated union `kind=text|photo|document|voice`).

## Where things live

- Crate: `crates/codegen/xai-channel-core/` (`Provider`, `ChannelRegistry`, `Wiring`, `ChannelReply`)
- Telegram impl: `crates/codegen/xai-telegram-daemon/` (wired via `xai-channel-core` types)
- Docs: `docs/channel-api.md` (this file)
- Machine cockpit docs: `.agents/skills/machine-cockpit/docs/channel-api.md` (copy)
- User settings: `~/.aiko/user-settings.json` → `{provider: {botToken, approvedUserIds}}`

Provider rows: provider=telegram, provider=slack, provider=discord, provider=webhook
