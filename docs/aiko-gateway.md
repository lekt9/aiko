# Aiko account plane and Telegram gateway

Telegram is a transport. Tardie remains the agent runtime; `entity-learn` remains the memory engine. Other agents use the same account through an authenticated HTTP API and the portable `@unlock/sdk/aiko` client. The production frontend links to `https://t.me/aikospillstea_bot?start=web` rather than exposing a sample workspace, in-app chat or the operator console. See [live operation and remaining production gates](aiko-production.md).

## Local operation

```sh
pnpm install --frozen-lockfile
pnpm aiko:init
pnpm aiko:dev
```

Private configuration: `~/.config/unbrowse/aiko.env`, regular, owner-only 0600. Never commit it or place it in a browser/agent workspace. The supplied bot credential was verified with Telegram's read-only `getMe`; only the public bot identity is saved in `artifacts/aiko-gateway/telegram-identity.json`. Rotate a token shared in chat through BotFather and replace `TELEGRAM_BOT_TOKEN` in this private file.

Relevant configuration (credential **names**, not values):

| Setting | Meaning |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Host-only bot credential |
| `TELEGRAM_WEBHOOK_SECRET` | Random 32–256-character secret; also protects internal polling normalization |
| `AIKO_TELEGRAM_MODE=polling` | Outbound long polling; no public listener, tunnel or webhook registration needed |
| `AIKO_TELEGRAM_PUBLIC=true` | Explicitly allow new private-chat users, within the account cap |
| `AIKO_TELEGRAM_ALLOWED_USERS` | Alternatively, comma-separated numeric Telegram IDs; deny new users by default |
| `AIKO_MAX_ACCOUNTS=100` | Total registered-thread admission cap, including operator/SDK accounts |
| `AIKO_PLANE_CREDENTIALS` | JSON array of `{account,digest,scopes}` grants; SHA-256 digests, not client tokens |
| `AIKO_STATE_DIR` | Absolute persistent local disk directory; this installation retains `~/.local/share/unbrowse/aiko/demo/` |
| `AIKO_INSTANCE_ID` | Stable actor identity, independent of inference mode; this installation retains `demo` |
| `AIKO_MODE=live`, `AIKO_ALLOW_PAID_INFERENCE=true` | Explicit live-inference activation |
| `AIKO_MODEL_GLOBAL_CALLS_PER_DAY`, `AIKO_MODEL_ACCOUNT_CALLS_PER_DAY` | Durable daily outbound-request limits; defaults 200 and 40 |

This installation uses polling, capped public onboarding and **live GLM inference** with durable global/account allowances. Fresh installs still require explicit live-mode consent and a model key. Live tools include cited public-page reads and memory, not sample apps or private account integrations. Request allowances are not a verified dollar cap; set a provider-side monetary limit.

`GET http://127.0.0.1:4242/health` reports mode and polling; `/ready` returns 503 when polling is stopped, stale or repeatedly failing. A verified identity or running poll loop is not proof of an end-to-end conversation: a user must open the bot and press **Start**. `/start` explains capabilities and reports their numeric account ID. No SDK keys are issued through chat.

A persistent user service can run `bun src/main.ts` with `WorkingDirectory` set to `apps/agent`, `UMask=0077`, and `Restart=on-failure`. It reads private configuration itself; do not put credentials in `ExecStart`, process arguments, or unit files. Only one service may own a state directory. A desktop user service normally stops at logout unless the operator separately enables lingering.

Webhook mode remains available at `POST /telegram/webhook`, authenticated with `X-Telegram-Bot-Api-Secret-Token`. Polling refuses to start if an existing webhook is registered; it never silently deletes or replaces it. The HTTP webhook route is disabled in polling mode. For remote agents/webhooks, use a reviewed TLS reverse proxy that preserves authorization and forwards with the loopback upstream Host, or an SSH tunnel. The runtime deliberately binds only to loopback, checks Host and Origin, and does not trust forwarded identity headers.

## Account isolation

An account is a **Telegram user** or a host-provisioned `acct_…` identity, not an app-drawer fixture login. No Telegram login is automatically linked to a saved Google/GitHub/custody account.

- Verified private sender ID selects `user-<account>`; usernames, forwarded messages, group chats, bot senders and caller-provided owner fields do not select tenants.
- HTTP credentials bind a single account and `read`/`write` scopes on the host. One credential cannot enumerate, cancel, read memory from, or approve browser operations for another account.
- Each non-operator account gets `accounts/<sha256(account)>/thread.sqlite` and its own `memory/<sha256(account)>.sqlite`, inside owner-only directories. Tardie's root `actor.sqlite` is the shared thread directory, not a shared conversation transcript.
- Optional browser tools retain their existing separate owner profiles, approvals and network restrictions. No arbitrary shell, filesystem or JavaScript execution is mounted.
- Operator auth remains scoped to `local`. Its existing logs and memory stay in their old locations for compatibility.
- The same host process/OS identity owns these files. This is **application/data isolation, not an OS sandbox or a VM guarantee**. Arbitrary adversarial code requires a separate process/container/VM boundary before it can be enabled.

State is plaintext, not encrypted Unlock custody. Back up the whole state directory while stopped, or use SQLite-consistent snapshots. Retain the central actor directory, thread stores and account memory together; don't move live WAL files or copy just one database. The account and `AIKO_INSTANCE_ID` must remain stable when restoring it; inference mode can change independently.

Older non-local stores at `actor.sqlite.threads/<base64url(user-ID)>.sqlite` cause startup to fail rather than silently lose history. For offline migration: stop every host; back up the entire state root; compute `sha256(ID)`; move that thread DB and its `-wal`/`-shm` companions into `accounts/<hash>/thread.sqlite`; move the old `memory/<hash>.sqlite` and companions into `accounts/<hash>/memory/`. Keep the actor directory unchanged, set directories to 0700 and database files to 0600, then restart and verify `/v1/messages` and memory. Never merge unrelated IDs or overwrite an existing target store. There is no automatic Telegram-to-custody account migration.

## Memory follows logs

`src/log-memory.ts` mounts a **native Tardie effect**, not a second worker or agent loop. After a prepared reply it explicitly refreshes bounded, host-approved `tardigradeLogSource` windows into the same account's actual `entity-learn` database.

- Windows have stable actor/thread/sequence references and original-event digests. The automatic view uses a `:user-messages-v1` projection-qualified actor namespace, while retaining the native actor identity in its selected metadata; this avoids collisions with existing metadata-only observations.
- Selected content is redacted user text (up to 4,000 characters); other events contribute metadata only. No generated drafts, browser dumps or complete memory-tool results are recursively copied.
- Recorded user text is evidence of a recorded message, **not verified truth or executable instructions**. Model-written notes remain agent claims.
- Each window's memory commit precedes the native cursor event. Crash recovery reuses its recorded read key; an integration test simulates loss between those commits.
- Catch-up is bounded to 32 windows of 25 events per completed reply. `GET /v1/status` exposes `memory.logFollower` (`current`, `partial`, `error`, or `not_started`) and cursor. Partial/error states resume on the next completed turn; disabled sources are never silently reapproved.
- Recall itself performs no refresh. Results retain coverage/freshness/source information. “Current” follower status means caught up to its observed window, not a claim that the underlying statements are true. Log source freshness has a one-year lifetime; retained observations remain historical records.
- Explicit “Refresh logs” still imports the metadata-only projection in a distinct projection namespace.
- Forget suppresses retrieval; it does **not** erase original transcripts, artifacts, journals, existing model context or backups.

## Agent SDK and credentials

Create a new independent account for an integration:

```sh
pnpm aiko:key new /home/deck/.config/unbrowse/my-agent.env
```

To give a trusted integration access to an existing Telegram account, use the exact numeric ID shown by `/start`, after verifying the intended owner:

```sh
pnpm aiko:key TELEGRAM_NUMERIC_ID /absolute/private/integration.env read
# Omit 'read' for read + write access.
```

The host stores only the credential digest; the new 0600 client file contains `AIKO_PLANE_TOKEN` and `AIKO_ACCOUNT`. Existing client files are not overwritten. Config updates are atomic and serialized with an exclusive lock; after a provisioning-process crash, check no writer is active before removing a stale `.lock` file. Restart the service to activate or revoke grants. Revoke by removing the matching digest entry and restarting. Never give the operator key or bot token to another agent.

```ts
import { createAikoClient } from '@unlock/sdk/aiko';

const aiko = createAikoClient({
  baseUrl: 'http://127.0.0.1:4242', // HTTPS for remote access
  token: () => process.env.AIKO_PLANE_TOKEN!,
});

await aiko.discover();
await aiko.status(); // Contains the server-bound account, not a caller-selected one.
const accepted = await aiko.messages.send({
  id: 'task_20260906_001', // Keep the same ID when retrying the same text.
  text: 'Remember: Use UTC for the launch',
});
const conversation = await aiko.messages.list();
const recalled = await aiko.memory.recall('UTC');
// await aiko.memory.get(recalled.items[0].observation.id);
// await aiko.messages.cancel(accepted.id);
```

`send` acknowledges durable admission, not completed execution. Poll `messages.list()` for a matching assistant `turn`; it returns the most recent 100 messages and pending IDs, not a full-log export. All client methods accept an optional `{signal}`. Requests have deadlines, forbid credential-bearing URLs and redirect forwarding, and are not silently retried. The client uses standard `fetch`; it has no Telegram, Bun or Tardie runtime dependency.

Transport-neutral discovery: authenticated `GET /v1`. Methods cover status, message submission/results, cancellation, memory recall/pinned reads, and existing browser approvals. The old `/api/*` console routes remain compatible. No raw thread-event injection, account selector, memory path/scope selector, generic shell or credential management route is exposed.

## Delivery and limits

- Per account: 10 new messages/minute, 100/day, 1,000 retained inbound messages, at most two nonterminal admissions. These are local-foundation limits; the lifetime cap requires an operator retention policy rather than silent deletion.
- Same account + request ID + same redacted text deduplicates across restart; changed text returns HTTP 409. The same key in another account is independent.
- Polling commits normalized, redacted updates to a durable inbox before advancing the cursor. A separate drain retries busy accounts without blocking other users. The queue is bounded; overflow is durably rejected. `/cancel` is prioritized and removes that owner's earlier unadmitted requests. Model execution remains entirely in Tardie.
- Quota/conflict rejections are recorded before a best-effort notification; they remain rejected after a crash. Unknown notification sends are not repeated.
- Replies are prepared and persisted before Telegram delivery. Unknown delivery outcomes stay unknown and are not automatically resent: Telegram has no client idempotency key. Plane-originated turns do not broadcast to Telegram; they appear in the same account history for SDK retrieval.

## Verification

```sh
pnpm test:aiko
pnpm exec vitest run tests/apps.test.ts
pnpm typecheck
pnpm build
pnpm aiko:build
BU_CDP_URL=http://127.0.0.1:9339 pnpm test:e2e:aiko
```

`scripts/aiko-gateway-verify.cell.yaml` is an optional local verification harness (set `UNLOCK_ROOT` to this checkout); **Cell is not part of the deployed runtime**. Historical evidence lives under `artifacts/aiko-gateway/`; current live/build/browser evidence is in `artifacts/aiko-production/`. Tests use mock Telegram delivery and deterministic inference, including two-account separation, scoped SDK auth, cross-channel history, automatic memory, native commit-boundary recovery and durable polling cursors. The standard test suite sends no real Telegram messages and buys no inference. `scripts/verify-aiko-live.ts --allow-paid` is a separate, explicit real-provider probe.
