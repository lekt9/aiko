# Telegram Bot API — local docs (for machine-cockpit contracts)

Source: https://core.telegram.org/bots/api + https://core.telegram.org/bots/tutorial + https://core.telegram.org/bots/features
Read this before wiring a contract that touches Telegram. Skim once, then use the contract table.

## Setup via @BotFather (the only way to get a token)

In Telegram, message **@BotFather**:

- `/newbot` → name + username (must end `bot`) → returns `TOKEN` like `123:AA…`
- `/setdescription` `/setabouttext` `/setuserpic` — optional polish
- `/setcommands` — register slash commands so Telegram shows autocomplete. Format:
  ```
  start - Start with Aiko
  help - What I can do
  login - Sign in Aiko on this Mac
  status - Where this bot stands (auth, bridge, pairing)
  clear - Clear pending approval (admin)
  ```
  The client also needs `setMyCommands` after `getMe` so commands are actually registered (not just in BotFather notes).

## Bot API contract table (wiring-relevant subset)

All over `https://api.telegram.org/bot<TOKEN>/<method>` (POST JSON or multipart for files). Token **never** enters a contract row, log, or prompt — only `Authorization`/env at effect time.

| Contract method | What it does | Typical contract id | Needs |
|---|---|---|---|
| `getMe` | Verify token, returns `{id, username, first_name}` | `telegram.identity.getMe` | token |
| `getUpdates?offset=&limit=&timeout=` | Long-poll inbox, returns `Update[]` with `{update_id, message|callback_query|...}`. Advance cursor only after `observe` contract is durable (`update_id+1`). | `telegram.updates.observe` | token, cursor |
| `sendMessage` | Text (with `parse_mode: MarkdownV2` or `HTML`, `reply_markup`, `reply_to_message_id`) | `telegram.message.send` | `chat_id`, `text`, `approved` |
| `sendChatAction` | Typing/upload indicators (`typing`, `upload_photo`, `record_voice`, `upload_document`, …) | `telegram.presence.set` | `chat_id`, `action` |
| `sendPhoto` / `sendDocument` / `sendAudio` / `sendVideo` / `sendVoice` / `sendVideoNote` / `sendSticker` / `sendMediaGroup` | Media from file_id or multipart upload | `telegram.media.send.*` | `chat_id`, `media_ref` (file path under `~/.aiko/telegram/outputs`), `approved` |
| `getFile` + `GET /file/bot<TOKEN>/<file_path>` | Resolve `file_id` → download inbound media (photos, docs, voice) | `telegram.media.observe` | `file_id` |
| `editMessageText` / `editMessageCaption` / `editMessageMedia` | Edit own messages (bounded window, not all messages) | `telegram.message.edit` | `chat_id`, `message_id` |
| `deleteMessage` | Delete own message | `telegram.message.delete` | `chat_id`, `message_id` |
| `answerCallbackQuery` | Ack inline button (removes spinner, optional toast) | `telegram.callback.answer` | `callback_query_id` |
| `setMyCommands` / `getMyCommands` / `deleteMyCommands` | Register slash commands (`{command, description}[]`, optional `scope`/`language_code`) | `telegram.commands.set` | token |
| `setWebhook` / `deleteWebhook` / `getWebhookInfo` | Webhook vs polling (we use `getUpdates` polling, so setWebhook should be deleted if present) | `telegram.webhook.*` | token |
| `getChat` / `getChatMember` | Introspection (title, member status) | `telegram.chat.inspect` | `chat_id` |

Retry: HTTP 429 with `parameters.retry_after` → Contract settlement retry, not inline sleep.

## Update shape (what getUpdates returns)

```json
{"update_id": 123, "message": {"message_id": 1, "from": {"id": 108611440, "first_name": "Lewis"}, "chat": {"id": 108611440, "type": "private"}, "text": "yo", "entities": [{"type": "bot_command", "offset": 0, "length": 6}]}, "callback_query": {"id": "abc", "from": {"id": 108611440}, "data": "btn:status"}}
```

Message kinds to observe: `text`, `photo[]`, `document`, `voice`, `audio`, `video`, `sticker`, `caption`. Use `caption` as prompt fallback when `text` is absent. Bot commands are `entities[0].type == "bot_command"` — strip the `@botname` suffix.

## UX by default (what this skill wires)

Every bot should, by default:

1. **On Start** (`/start` from any chat): observe, then if `approvedUserIds` is empty and `auth.signed_in` → auto-approve that chat (FIRST_CONTACT), else reply with pairing code or “you’re pending”. No silent drop.
2. **Self-aware replies** (every message): if `auth.signed_in==false` → reply `Not signed in — run aiko login --device-code on <hostname>` (don't dispatch to Aiko). Else dispatch via `agent_mail` (the Aiko host), with typing indicator.
3. **Slash commands** (registered via `setMyCommands`, attached as `reply_markup` inline keyboard too): `/help`, `/status` (self-aware hint + wiring), `/login` (device-code instructions), plus any domain commands the host adds. Unknown `/cmd` replies with help, not silence.
4. **Media round-trip**: inbound `photo/document/voice` → `getFile` + download → prompt includes local path → outbound `sendPhoto/sendDocument/sendVoice` from approved outputs dir.
5. **Callbacks**: `answerCallbackQuery` within TTL, then handle `data` (e.g., `status`, `login`).
6. **Contracts for everything**: `observe` (read), `identity approved` (gate), `send/edit/delete/presence/media` (write) — each `contract task begin --check "test -s evidence/…"`, `verify` after provider ack, date ≤8 hex ids, no token in rows/logs.
