# Channel API — provider-generic cockpit

Telegram as one provider (`provider=telegram`). The contract table is generic; each provider fills one row.

## Setup pattern (per provider)

| provider | credential source | command to set | verify |
|---|---|---|---|
| **telegram** | `@BotFather /newbot` → `TOKEN` | `aiko native telegram set-token` (POST `/api/telegram/set-token`, `getMe` checked, masked) | `getMe` → username |
| **slack** | `xoxb-…` bot token + `app-level` token (future) | `aiko native slack set-token` | `auth.test` |
| **discord** | Bot token | `DISCORD_BOT_TOKEN` env | `get /users/@me` |
| **webhook/IMAP/SAP** | per `self-integrate` (env var name in workflow input, never in row) | `SMITHERS_<SVC>_TOKEN` env | `GET /ping` |

Never paste raw token into chat transcript — export in shell, pass via `POST` body (cockpit masks `XXXX…YYYY`).

## Generic contract table

Token **never** enters a contract row, log, or prompt — only `Authorization`/env at effect time.

| Contract | Method (telegram example) | Generic method | Effect | Needs |
|---|---|---|---|---|
| observe | `getUpdates?offset=&timeout=` | provider poll/webhook | `network_read` | token, cursor |
| identity | `getMe` | `auth.test` / `GET /me` | `network_read` | token |
| send text | `sendMessage` + `sendChatAction:typing` | `chat.postMessage` / `create_message` | `message_send` | `approved` |
| presence | `sendChatAction` (leased) | `typing` indicator | `network_write` | `approved` |
| media in | `getFile` + download | `files.info` | `network_read` | `file_id` |
| media out | `sendPhoto/Document/Voice/Audio/Video` multipart | `files.upload` | `message_send` | `approved`, local media ref |
| edit | `editMessageText` | `chat.update` | `message_send` | `message_id` |
| delete | `deleteMessage` | `chat.delete` | `message_send` | `message_id` |
| callback | `answerCallbackQuery` | interaction ack | `message_send` | `callback_id` |
| commands | `setMyCommands` / `getMyCommands` | `commands` register | `network_write` | token |

Cursor: advance only after `observe` durable (`update_id+1` / `ts` / `UID` per service). Dedupe `(bot_id, update_id)`. 429 with `retry_after` → Contract retry, not inline sleep.

## Self-aware wiring (generic)

Every provider's `/api/<provider>/self-aware` returns `{hasToken, username, running, approvedUserIds, pendingChats, bridgeLog, auth, hint, action}` with `hint ∈ {not_signed_in, no_token, bridge_stopped, needs_pairing, waiting_first_message, ready}`. `hint` drives chat.html statusBar for that provider's tab. `wiring[]` in `self.json` is generic: `{id, channel: "telegram"|"slack", host, bridge:{hint, pendingChats}, artifacts}`.

Adding a provider = fill one row above + add `docs/<provider>-api.md` + `scripts` case + `channel.register` entry. No changes to self-model schema, hint enum, or gate.
