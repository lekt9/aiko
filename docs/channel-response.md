# Foreground channel responses

Aiko's foreground actor mounts the native `respond` tool. The Node and Cloudflare hosts wrap foreground inference with `withRequiredResponse`, outside browser and workflow inference. Plain model completion becomes a real native `ToolCalled` / `ToolReturned` pair for `respond`, preserving model usage and serving metadata. A model failure produces an honest blocked response.

`respond` records an owner-, turn-, and epoch-bound `AikoResponseRequested`. The existing persona and durable outbox consume that intent and route the reply to the original channel. The model cannot select another recipient. `queued` acknowledges the durable intent; it does not claim external delivery.

A final text, voice, or screenshot send with a delivered or unknown receipt also ends the foreground turn without an extra model call or duplicate response. Progress messages, failed sends, foreign-owner receipts, and previous turns or epochs do not satisfy the obligation. Unknown sends are not retried, including after host restart. Background actors retain their existing behavior.

Verification: the agent suite passed 484 tests with 5 skips and no failures. After adding usage-accounting coverage, all 12 focused channel-response tests passed. Tests exercise the actual native host with controlled transports, including API replies, Telegram outbox routing, provider failure, explicit final sends, redaction, and restart deduplication. No real Telegram messages were sent by these tests.
