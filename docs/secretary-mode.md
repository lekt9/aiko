# Secretary Mode

Aiko can receive Telegram business/secretary updates and reply on behalf of a connected account. The owner approves each private contact once. Future eligible messages use that permission without approval-queue entries or approval notifications. Pausing the contact stops pending and future replies that have not been dispatched.

## Connect and use

1. Enable **Secretary Mode** for the Aiko bot in BotFather. This is a bot-owner setting; signing in to the Aiko Mini App does not enable it.
2. In Telegram settings, open Secretary Mode (or Telegram Business → Chatbots), select Aiko, grant reply permission, and choose accessible private chats.
3. Open Aiko's **Connect apps** Mini App. Telegram signs the owner in natively; **Use my Telegram account** also starts that sign-in. Outside Telegram, the existing account credential still works.
4. In **Secretary Mode**, refresh. Contacts appear after an observed message. Optionally import a single-chat Telegram Desktop JSON export (up to 2,000 messages, under 950 KB).
5. Enable **Always reply** for a contact. Use **Pause automatic replies** to stop it. Telegram's own connection and chat access controls remain authoritative.

In the bot chat, `/secretary` explains setup; `/secretary approve CHAT_ID` and `/secretary pause CHAT_ID` manage a contact when exactly one active connection exists. Telegram's `/start bizChatCHAT_ID` management link explains how to approve that contact. Messages from contacts cannot invoke owner commands.

## Telegram boundaries

- Account-level replies work in eligible private chats, with `rights.can_reply`, an enabled connection, and an incoming message less than 24 hours old. Groups cannot be enabled through this connection.
- Telegram delivers new business messages, edits and deletions. The Bot API does not expose a complete old-chat download; historical context requires the owner's export.
- This implementation auto-replies to text. Media and forwarded content are not interpreted, and do not trigger replies. An owner-authored reply supersedes pending work in that chat.
- `can_read_messages` controls marking a successfully answered message read. It is not treated as the permission to receive business messages.

References: [Telegram Secretary Mode](https://core.telegram.org/bots/features#secretary-bots), [BusinessConnection](https://core.telegram.org/bots/api#businessconnection), [BusinessBotRights](https://core.telegram.org/bots/api#businessbotrights).

## Deployment

Both the Bun service and Cloudflare account host mount the new lane. Build the Mini App with `pnpm --filter @unlock/web exec vite build --config vite.connectors.config.ts`. Deploy using the existing reviewed deployment workflow.

An existing webhook must subscribe to the new update types as well as the existing ones. Register `message`, `callback_query`, `message_reaction`, `business_connection`, `business_message`, `edited_business_message`, and `deleted_business_messages` with `setWebhook`, preserving the existing webhook URL and secret, and **`drop_pending_updates: false`**. The canonical list is `TELEGRAM_ALLOWED_UPDATES`; polling and the existing cutover workflow consume it. Deploying a Worker alone does not change an already-registered webhook's update filter.

No live deployment, BotFather change, webhook reconfiguration, or real contact send was performed as part of local verification.

## Durable execution and voice

The stable actor name remains `aiko`. Each owner gets `secretary-OWNER`, separate from their foreground conversation and memory. Tardigrade owns inference, effects, recovery and delivery records; there is no additional model loop or queue worker.

Connection snapshots, contact permissions, incoming messages and imports are native events. Grants are bound to the owner, connection and chat. Dispatch checks the current grant, edits/deletions, owner takeover, message age, and a fresh `getBusinessConnection` response. Delivery includes `business_connection_id` and the observed chat ID. A persisted dispatch marker prevents resending an uncertain or interrupted attempt after recovery.

Every prompt contains only the current contact's context: recent messages, relevant older messages, and up to 40 owner-authored voice examples with length/casing statistics. Imported sender IDs and chat identity are validated; bot echoes and forwarded/media content cannot become owner voice examples. The model has no tools and sees no other contact's trajectory. Secretary replies use the owner's voice directly; the ordinary Aiko conversation keeps its existing ThinkFeel behavior.

History is retained in the private native log, including prior versions and prompt snapshots. Deletion updates remove messages from future context but do not erase earlier durable records or backups. Pausing is not data deletion. Style fidelity is model-dependent; deterministic tests establish context isolation and delivery behavior, not subjective writing quality.

Authenticated endpoints (owner derived from Telegram init data or scoped account credentials):

| Endpoint                      | Behavior                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/secretary`          | Connection rights, contacts, owner example counts and recent delivery statuses |
| `POST /api/secretary/contact` | `{connectionId, chat, enabled}`; persists or pauses approval                   |
| `POST /api/secretary/history` | `{connectionId, chat, history}`; validates a single-chat Telegram JSON export  |

`/v1/secretary` aliases are available directly on the agent runtime. Reads require read scope; changes require write scope. The web proxy forwards only end-user authentication.

## Verification

- Real Bun and Cloudflare native host tests cover connection handling, persistent approval, restart recovery, history isolation, revoked rights, pause, expiry, edits/deletions, owner takeover, echoes, unsupported media, group rejection, uncertain delivery and account-scoped API access.
- The full agent suite passed: 459 passed, 5 skipped. Agent, web, and Cloudflare TypeScript checks passed; Mini App and Bun builds and the Worker deployment dry run passed.
- Browser-harness exercised the real React controls with a mock API in an isolated Chrome session: Telegram sign-in, contact display, enable/pause request payloads, sign-out clearing, JSON file selection/import feedback, and 390px mobile overflow check.
- The repository-pinned `tdg build` validated a fixture binding of the Secretary actor. The global CLI differs from the repository version; use `pnpm --filter @unlock/agent exec tdg` here.
- Live voice-quality metrics, model tokens/cost/latency and a hosted Voyager trace are unavailable; verification used deterministic inference and no real contact sends.
