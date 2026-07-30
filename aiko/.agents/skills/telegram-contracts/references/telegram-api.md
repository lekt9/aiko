# Telegram Bot API contract mapping

Use `https://api.telegram.org/bot<TOKEN>/<method>` locally. Supply `<TOKEN>` at
execution time from a secret provider; it must never enter a descriptor or row.

| Contract | Method | Effect | Typical dependency |
|---|---|---|---|
| observe updates | `getUpdates` or webhook delivery | network read | bot identity |
| resolve bot | `getMe` | network read | token available |
| send text | `sendMessage` | message send | approved actor/chat |
| send voice | `sendVoice` | message send | approved actor/chat, local media |
| edit text | `editMessageText` | message send | approved actor/chat, message id |
| acknowledge callback | `answerCallbackQuery` | message send | approved actor |
| retrieve metadata | `getFile` | network read | approved media observation |

Normalize all results to `{ok, result_shape, telegram_error_code}`. Retain only
the fields needed to prove the child outcome. Treat HTTP 429 as retryable using
`parameters.retry_after`; treat malformed inputs as terminal child failures.

For long polling, advance the cursor only after the update observation contract
is durable. This gives at-least-once processing; use `(bot_id, update_id)` as the
deduplication key.
