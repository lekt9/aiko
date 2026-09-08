# Secretary Mode

Aiko can receive Telegram business/secretary updates and reply on behalf of a connected account. The owner approves each private contact once. Future eligible messages use that permission without approval-queue entries or approval notifications. Pausing the contact stops pending and future replies that have not been dispatched.

## Connect and use

1. Enable **Secretary Mode** for the Aiko bot in BotFather. This is a bot-owner setting; signing in to the Aiko Mini App does not enable it.
2. In Telegram settings, open Secretary Mode (or Telegram Business → Chatbots), select Aiko, grant reply permission, and choose accessible private chats.
3. Open Aiko's **Connect apps** Mini App. Telegram signs the owner in natively; **Use my Telegram account** also starts that sign-in. Outside Telegram, the existing account credential still works.
4. In **Secretary Mode**, refresh. Contacts appear after an observed message. Optionally import a single-chat Telegram Desktop JSON export (up to 2,000 messages, under 950 KB).
5. Enable **Always reply** for a contact. Use **Pause automatic replies** to stop it. Telegram's own connection and chat access controls remain authoritative.

In the bot chat, `/secretary` explains setup; `/secretary approve CHAT_ID` and `/secretary pause CHAT_ID` manage a contact when exactly one active connection exists. Telegram's `/start bizChatCHAT_ID` management link explains how to approve that contact. Messages from contacts cannot invoke owner commands.

## Track and delegate work

In **Your work**, use **Add work** to track an obligation or collect meeting agenda items. A tracked commitment records the outcome, accountable person, next step, and evidence needed for completion. Leave an unknown deadline blank; the next review is separate and defaults to tomorrow. Already overdue obligations can also be recorded.

For agenda collection, choose an observed contact and specify the request, one reminder, reminder time, escalation time, and deadline. **Prepare for review** creates a decision without sending. **Authorize request and reminder** grants that exact proposal while its dates and contact permissions remain valid. The existing contact reply grant alone does not authorize this workflow.

A qualifying numbered reply becomes a source-linked preparation note. Missing or incomplete items remain outstanding; Aiko prepares an owner decision before the deadline. Source edits or deletion invalidate a completed note when its evidence changes. Unknown delivery remains visible and holds additional sending for owner review.

Use **Pause**, **Resume with Aiko**, **I'll handle this**, or **Withdraw** to control execution. **Adjust this work** supports proposal edits, later review, owner-confirmed completion, and reopening. Editing before execution creates a fresh authorization; once an execution receipt exists, withdraw the old workflow and create new work to change its payload. **Contact handoffs** persists owner handling across later messages until explicit hand-back.

**When Aiko updates you** edits the existing proactive update preference, daily limit, and quiet hours. Decisions remain in **Needs you** even when notifications are deferred or disabled. `/secretary work`, `/secretary brief`, `/secretary waiting`, “what needs me?”, and “what are we waiting on?” report recorded commitments. Briefings are on demand in this release.

The first autonomous workflow supports numbered text agenda items. Calendar booking, media interpretation, automatic obligation extraction from arbitrary correspondence, and cross-channel deduplication remain later work in the [operating model](secretary-operating-model.md).

## How Aiko talks

Aiko acknowledges recorded changes specifically, asks one consequential clarification at a time, and distinguishes preparing, authorization, delivery and completion. Decisions name the required choice, timing and what happens without an answer. Normal waiting stays quiet. “What needs me?” shows the decision queue; “what are we waiting on?” names the outstanding dependencies.

With the owner she speaks as Aiko. With a contact she follows that conversation's established language and tone, using only its own context. Closing acknowledgments can receive no reply; questions still get attention. If directly asked about automation, she must answer truthfully. The owner/contact inference policies are separate, and contact context never receives owner work tools.

The model can resolve “I'll handle Maya” and invoke `commitment_contact_takeover`; this persists owner handling and cannot resume the contact. Ambiguous names require clarification. Fixed work notices are currently English; the inference policy follows the owner's current language. See the [conversation design and example exchange](secretary-operating-model.md#the-language-of-the-relationship).

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
| `GET /api/secretary/work` | Owner commitments, decision lanes, receipts, coverage, contacts and update preferences |
| `POST /api/secretary/work` | Versioned owner commands: `capture`, `decide`, `change`, `contact`, `attention` |

`/v1/secretary` aliases are available directly on the agent runtime. Reads require read scope; changes require write scope. The web proxy forwards only end-user authentication.

Work mutations require a stable `operationId`. Changes and decisions require `expectedVersion`; decisions also require their current `decisionId` and `planDigest`. Contact and attention changes use their returned revision. Retries with the same operation and payload are idempotent; conflicting payloads or stale versions are rejected. The model tools `commitment_list`, `commitment_capture`, `commitment_change`, and `commitment_contact_takeover` are scoped to the owner thread and cannot approve execution.

## Work coordination verification

Run the local regression checks:

```sh
bun test apps/agent/test/secretary-language.test.ts apps/agent/test/secretary-work.test.ts apps/agent/test/secretary.test.ts apps/agent/test/background.test.ts apps/agent/test/proactive-outbox-host.test.ts apps/agent/test/cloudflare-host.test.ts
bun test apps/agent/test/channel-response.test.ts
pnpm --dir apps/web exec vitest run test/connector-proxy.test.ts --maxWorkers=2
```

The latest language iteration passes 108 agent tests across these suites; the prior web proxy check passed 10 tests. Eight browser scenarios and the Mini App build pass. Web and protocol TypeScript checks pass. Full agent and Cloudflare checks encounter concurrent errors outside this change in coding-workspace and database code, and the focused host check encounters a background event mutability error. These results are local, with provider transport simulated; they do not attest a deployed account.

For an interactive local witness, start:

```sh
bun apps/agent/scripts/secretary-work-preview.ts
```

Open `http://127.0.0.1:4129/`. The preview uses the actual work UI, API, native event log, and coordinator, with one synthetic contact and simulated sending. Its temporary state is isolated from accounts. The browser scenario runs through browser-harness with an isolated CDP endpoint:

```sh
UNLOCK_ROOT="$PWD" BU_NAME=aiko-secretary-work-qa BU_CDP_URL=http://127.0.0.1:9349 BH_NO_BROWSER_COOKIES=1 BH_RECORD=0 browser-harness < apps/web/test/secretary-work.browser.py
```

Screenshots, accessibility results and the scenario report are written to `artifacts/secretary-work/browser/`.

## Verification

- Real Bun and Cloudflare native host tests cover connection handling, persistent approval, restart recovery, history isolation, revoked rights, pause, expiry, edits/deletions, owner takeover, echoes, unsupported media, group rejection, uncertain delivery and account-scoped API access.
- The full agent suite passed: 459 passed, 5 skipped. Agent, web, and Cloudflare TypeScript checks passed; Mini App and Bun builds and the Worker deployment dry run passed.
- Browser-harness exercised the real React controls with a mock API in an isolated Chrome session: Telegram sign-in, contact display, enable/pause request payloads, sign-out clearing, JSON file selection/import feedback, and 390px mobile overflow check.
- The repository-pinned `tdg build` validated a fixture binding of the Secretary actor. The global CLI differs from the repository version; use `pnpm --filter @unlock/agent exec tdg` here.
- Live voice-quality metrics, model tokens/cost/latency and a hosted Voyager trace are unavailable; verification used deterministic inference and no real contact sends.
