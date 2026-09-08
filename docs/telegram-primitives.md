# Telegram primitives and reply delivery

Reviewed against the official [Bot API](https://core.telegram.org/bots/api), [bot features](https://core.telegram.org/bots/features), and [Mini Apps](https://core.telegram.org/bots/webapps) documentation on 2026-09-06. The checked method inventory contains 185 methods. `telegram_capabilities` searches that inventory and distinguishes mounted tools from methods requiring more integration work. Source metadata and the retrieved inventory are in `artifacts/telegram-audit/catalog.json`.

## The typing-without-a-reply failure

Production histories showed completed turns whose persona preparation failed validation or was unavailable. Their final delivery was rejected with `thinkfeel_required`, leaving the user without a message. Other real sends were rejected because optional arguments arrived as `null`. Queued inference could also run before the previous outbox delivery. Slow repeated model calls were visible in a separate account; the evidence does not establish a single cause for every delay.

The fix uses the persona rewrite operation, keeps protected facts and code anchored, normalizes optional tool arguments, and reconciles the durable outbox before further inference. If safe wording cannot be prepared, the same outbox sends one fixed service notice. It does not send the invalid draft. A lost send receipt remains unknown and is not automatically retried.

Cloudflare ingress now schedules a durable alarm and that alarm awaits the native actor driver. This follows the [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/api/state/) and [alarm execution](https://developers.cloudflare.com/durable-objects/api/alarms/) model rather than treating an RPC's background promise as a durable work queue.

## Entrypoint and early replies

Source trace (2026-09-08):

1. Hosted requests enter `POST /telegram/webhook` in [cloudflare.ts](../apps/agent/src/cloudflare.ts). [telegram.ts](../apps/agent/src/telegram.ts) verifies the webhook secret and private-chat/account boundary, then normalizes the update.
2. The Worker calls the owner's `AikoAccountDO.acceptTelegram` → `accept`. The best-effort reaction happens **before** `MessageReceived` is committed and `kick` arms the durable alarm. A reaction proves neither durable acceptance nor a running model. [telegram-webhook.ts](../apps/agent/src/telegram-webhook.ts) acknowledges the webhook only after acceptance or a matching duplicate.
3. `AikoAccountDO.alarm` awaits [the account host's native driver](../apps/agent/src/cloudflare-host.ts). The foreground actor is [createAikoActor](../apps/agent/src/actor.ts), with progress and outbox components mounted before inference/tool execution.
4. Working `TextReturned` goes through [channelProgress](../apps/agent/src/channel-progress.ts). Final `respond` → `AikoResponseRequested` → `voiceAndOutbox` → `AikoReplyPrepared` → Telegram send → `AikoDeliverySettled` is separate. A settled progress message never completes a request.

The local path is [main.ts](../apps/agent/src/main.ts) → [server.ts](../apps/agent/src/server.ts), either its webhook handler or [the durable poller](../apps/agent/src/telegram-polling.ts). Both feed the same foreground actor.

The model is instructed to include a short, task-specific update with its first tool action. Previously, silent tool calls could leave only reactions/typing until completion. The native progress component now attempts one neutral message—“I’m looking into your request now.”—before silent tool work executes. Model commentary or an explicit message takes precedence; quick final answers remain a single message. This adds no inference call or separate sender, and does not interpolate private tool arguments.

The `AikoProgressActivated` version-2 marker keeps the new fallback from replaying pre-upgrade tool calls. Its once-per-epoch state uses the durable history, not compacted model context. Started sends are uncertain after a crash and are never retried; terminal/cancelled and stale-epoch work cannot produce late feedback. Existing redaction, persona policy and destination checks still apply.

Verification: [progress tests](../apps/agent/test/channel-progress.test.ts) exercise a held-open native tool, parallel calls, explicit commentary, failed/unknown delivery, migration and restart. [response tests](../apps/agent/test/channel-response.test.ts) preserve the final-response obligation; [AccountStorage tests](../apps/agent/test/cloudflare-host.test.ts) exercise alarm-driven progress followed by final delivery across host recreation. These are local checks with injected providers, not deployed or live Telegram evidence. The fallback still waits for the first model action: it cannot repair an unarmed alarm, blocked inference, or an unavailable transport. For a live stall, inspect `MessageReceived`, `ModelCalled`, `ToolCalled`/`ToolReturned`, `AikoProgressSettled`, and final preparation/delivery receipts before considering [the operator wake procedure](aiko-hosted.md).

## Chat primitives used by Aiko

| Primitive | Aiko behavior |
| --- | --- |
| Final text and rich messages | `respond`, `send_message` and `telegram_send`; the host binds the destination. Long text uses one rich message rather than several sends with partially known outcomes. |
| Thinking, drafts and progress | Renewable typing plus temporary drafts containing bounded activity labels. A draft never stands in for a final answer. |
| Native Stop | Host drafts request Stop support. Verified `stopped_message_generation` updates cancel only the matching owner's turn, topic and resume epoch through native Tardigrade cancellation. |
| Replies and topics | Incoming message IDs and topic IDs propagate to final delivery. Deleted reply targets can fall back to a normal send in the same topic. Control responses retain the topic too. |
| Inline buttons and callbacks | Bounded callback data, prompt callback acknowledgment, secure connection buttons, status and cancellation controls. Arbitrary callback text is user input. |
| Reactions | Owner-scoped reaction input and output, with provider delivery receipts. |
| Photos, video, audio, voice, documents, stickers and albums | Owned file descriptors, bounded download/inspection, transcription/vision where configured, media replies and voice synthesis. Albums can arrive in separate updates. |
| Locations, venues, contacts and polls | Bounded native outbound cards. Shared inbound cards become readable user context; unneeded raw contact vCards are omitted. |
| Commands | Ten commands installed for private chats: start, apps, connect, connections, discover, status, cancel, secretary, disconnect and help. |
| Mini App navigation | Connect apps opens the deployed connection page from Telegram's menu. Telegram provides the surrounding account session. |
| Delivery errors | Sanitized reason codes distinguish rejection, rate limiting, provider failure and an unknown transport outcome. Credentials and raw provider errors are excluded. |
| Business/secretary updates | Existing owner-approved secretary mode receives business connections/messages/edits/deletions and uses its separate connection and authority checks. |

Telegram typing indicators expire quickly; drafts are temporary previews. Both require a final send to become a normal chat reply. The deployed subscriptions explicitly include Stop updates. See the current [draft API](https://core.telegram.org/bots/api#sendmessagedraft) and [Stop update contract](https://core.telegram.org/bots/api#stoppedmessagegeneration).

## Reply formatting

Verified in source on 2026-09-08: [the shared formatter](../apps/agent/src/telegram-format.ts) converts `*bold*` and `**bold**` to bold, `_italic_` to italic, and backtick code to Telegram HTML. Ordinary replies, progress edits, drafts, media captions, album captions, and secretary responses use `parse_mode: "HTML"`. Long replies use `rich_message.html` through the existing single-message delivery path.

Callers supply reply text, not pre-rendered HTML. The formatter escapes literal `<`, `>`, and `&`; raw HTML remains visible text. This is a small formatting subset, not a full Markdown renderer: links, headings, and nested emphasis are not converted. Redaction in the outbound adapter happens before formatting. Keep that order when changing delivery so secrets cannot be hidden from redaction by encoded markup. [Regression coverage](../apps/agent/test/telegram-format.test.ts) checks request payloads with an injected transport; it does not prove live Telegram rendering or deployment.

## Full API coverage versus mounted capabilities

The reviewed catalog also covers forwarding/copying; live locations; forum administration; memberships and join requests; inline/guest queries; managed bots; profile settings; stories; gifts and Stars; paid media; payments/subscriptions; checklists; games; sticker-set administration; Passport errors; and ephemeral messages. These names are discoverable, but most do not yet have Aiko execution adapters. Many require a group administrator role, business rights, a payment flow or a user-selected target that the private-chat owner binding does not provide.

The catalog is not an unrestricted Bot API proxy. Aiko cannot claim that a method is executable merely because it appears in the official API. The currently mounted catalog has 28 entries; business/secretary operations additionally use their existing dedicated adapter. Further primitives should be mounted as typed native tools with explicit destination authority, bounded inputs and durable receipts.

## Verification and deployment

`bun scripts/configure-aiko-connectors-telegram.ts` configures and reads back commands, the Mini App menu, and webhook update subscriptions. It only refreshes the already deployed Aiko webhook and preserves pending updates. `artifacts/telegram-audit/bot-configuration.json` records successful verification and zero chat messages sent.

The final regression run passed 524 tests, skipped 5 environment-dependent live tests, and failed none. TypeScript passed for both host targets. The native CLI witness and live account-API canary are documented in [the native audit](tardigrade-native-audit.md). Telegram accepted validation probes for the new rich-message and draft methods; those empty-payload probes prove endpoint recognition, not successful message rendering.

Deployment version: `e4981dd9-e49a-4c1a-bb9d-51a1c615c688`. The final live account-API canary prepared a validated ThinkFeel reply in 13.749 seconds after a native `respond` call; its receipt is `artifacts/telegram-audit/deployed-canary.json`. It sent no test Telegram messages. A real post-deployment Telegram reply receipt must be observed separately before claiming that end-to-end transport witness.
