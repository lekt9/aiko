# Telegram contracts (full surface)

Every Telegram touchpoint is a contract. No silent paths.

## Observe (read)

- `telegram.updates.observe` — `getUpdates?offset+1` only after prior `observe` durable. Dedupe `(bot_id, update_id)`. Child: `telegram.identity.getMe` to prove token valid; treat 429 as retryable.
- `telegram.media.observe` — `getFile` + download to `/tmp/telegram_daemon_*` for inbound `photo/document/voice/audio/video/sticker`. Caption fallback.

## Gate

- `telegram.identity.approved` — `chat_id ∈ approvedUserIds` OR FIRST_CONTACT auto-approve (cockpit, when `auth.signed_in`). Bridge log `Unauthorized chat X` is evidence for `pendingChats`.

## Respond (write, all require approved)

| kind | verb | contract |
|---|---|---|
| text | `sendMessage` (with `MarkdownV2`, `reply_markup`) + `sendChatAction:typing` | `telegram.message.send` |
| photo/document/voice/audio/video | multipart upload from `~/.aiko/telegram/outputs` (bounded 50MB, path-jailed) | `telegram.media.send.*` |
| edit | `editMessageText/Caption/Media` | `telegram.message.edit` |
| delete | `deleteMessage` | `telegram.message.delete` |
| presence | `sendChatAction` (typing, upload_*) leased, refresh every 4s while agent runs | `telegram.presence.set` |
| callback | `answerCallbackQuery` within TTL, then handle `data` | `telegram.callback.answer` |
| commands | `setMyCommands` / `getMyCommands` / `deleteMyCommands` + `deleteWebhook` (polling) | `telegram.commands.set` |

## Slash / button UX (by default)

Commands registered via `setMyCommands`: `/start /help /status /login`. Also rendered as inline keyboard `[Help][Status][Login]`. Every `message.entities[bot_command]` and `callback_query.data` is observed before gating; unknown `/foo` replies with help, not silence. `handle_message` strips `@botname`, routes `/start`→welcome, `/help`→capabilities, `/status`→self-aware `hint/action`, `/login`→`aiko login --device-code` instructions.

## Evidence

Each child writes `{source:"telegram", update_id, kind, provider_message_id|acknowledged}` to `~/.aiko/telegram/evidence/<key>.json` and `contract task verify <id>` after provider ack. Token never in rows/logs — only `bot_id`/`username`.

## Capability gaps (closed)

- `getFile`/`downloadFile` now wired for inbound media (photo→caption, voice→transcribe).
- `sendPhoto/sendDocument/sendVoice/sendAudio/sendVideo` present for outbound media.
- `setMyCommands`/`getMyCommands` added for completeness.
- `sendChatAction` leased (typing every 4s in `run_aiko_with_typing`).

If a new Telegram verb is needed, add it to `api.rs` first, then to `bot.rs` dispatch, then to this doc — never promise a verb the code lacks.
