# Operate Aiko on Cloudflare

This operator reference separates the deployed Cloudflare sandbox-native profile from the earlier local-polling profile. The guarded cutover completed on 2026-09-06 at 06:48:51 UTC: all three existing accounts passed native-history and memory readback verification, Telegram's webhook points to Cloudflare, and the old polling service is inactive and disabled. The original source and private backup are retained. Do not restart the legacy service.

The production control panel is [aiko-agent.lewis-6d8.workers.dev/control](https://aiko-agent.lewis-6d8.workers.dev/control); Telegram is [@aikospillstea_bot](https://t.me/aikospillstea_bot). Operator or account credentials are required for the panel. Private cutover evidence is `artifacts/aiko-cloudflare/migration.json`, with recovery material under `/home/deck/.local/share/unbrowse/aiko/cloudflare-cutover-20260906/`.

Live query-first Eatigo browsing, pending-observation indexing/reflection, sandbox media processing, and desktop/mobile control-panel checks have passed. Final contract acceptance remains open until an authorized recipient completes the real Telegram photo/video/voice and outbound-media test. Provider probes and deployment success do not replace that test.

## Cloudflare sandbox-native profile

### Connection onboarding — implementation in progress

The existing web app drawer is a preview, not a deployed connection manager. The
vault service has tenant-scoped encrypted credentials and verified sessions, but
there is currently no production bridge from Telegram identity to that vault or
from its sessions to the owner's Codegraff browser. Do not collect real passwords
in the preview or describe an app as connected on the strength of saved metadata.

The Telegram transport now supports native inline `web_app` buttons, restricted
to an exact host-configured HTTPS Mini App URL. This transport support alone does
not install a Mini App, configure the bot menu, or enable connection onboarding.

Required rollout sequence:

1. Serve the connection frontend over HTTPS. Authenticate its requests using
   server-verified Telegram `initData`; never trust `initDataUnsafe`, a submitted
   account ID, or an operator-selected account as end-user login authority.
2. Offer DuckDuckGo-backed domain discovery and explicit domain confirmation.
   Suggestions are untrusted discovery results, not verified login destinations
   or proof of an integration. Show an honest empty/error state on search failure.
3. Link the authenticated Telegram owner to a separate vault tenant. Send password
   entry only over the private credential path, never through chat, Mini App
   `sendData`, native actor messages, tool arguments, telemetry, or model prompts.
   Reuse the vault's encryption and authorization rather than creating a parallel
   plaintext store. A user-controlled browser login is an alternative for MFA,
   SSO, and sites that cannot use a supported credential adapter.
4. Install and verify the session in that owner's persistent sandbox. Serialize
   interactive sign-in against agent browser work and exclude credential inputs
   from browser observation/learning. A saved credential remains unverified until
   an authenticated identity check succeeds; redirect completion is insufficient.
5. Track required onboarding and per-app states separately: not connected,
   signing in, needs user action, verified, expired, and disconnected. Gate
   connected-app actions on verified owner-scoped access. Keep cancellation and
   help available during onboarding; do not fabricate access to bypass the gate.
6. Emit credential-free connection state events into the owner's native hook
   flow and expose them in the control panel. The model receives only access
   metadata and verified capabilities. Disconnection must revoke future use and
   remove the corresponding browser session, not merely hide a UI card.

Acceptance requires a real Telegram Mini App launch, query-only domain discovery,
successful sign-in and authenticated app read in the same owner browser, MFA/error
recovery, cross-owner denial, disconnect verification, and checks that credentials
never reached actor logs or learning. None of these onboarding gates is currently
claimed as passed.

The current implementation runs native Tardigrade actors in Cloudflare Durable Objects and browser/media work in persistent, owner-isolated Codegraff VMs. A Worker deployment or a healthy `/ready` response does not prove Telegram cutover or end-to-end delivery.

| Surface | Cloudflare target | Earlier local profile |
| --- | --- | --- |
| Telegram ingress | Verified webhook after guarded handoff | `unlock-aiko.service` polling with a durable inbox/cursor |
| Runtime and memory | Native Tardie host; per-owner Durable Object SQLite and `entity-learn/cloudflare` | Native Bun host; private per-account local SQLite stores |
| Web access | Query-first `web_search`, then browser navigation across public sites in the owner's VM | Explicit-URL `web_read`; separately enabled local browser with interaction approvals |
| Inference policy | `toolCallLimit: null`; no daily inference allowances or legacy 30-second request override | Optional tool budget plus the local daily/concurrency allowances documented below |

### One foreground conversation and hidden actors

#### Owner schedules and listeners (deployed and live-verified)

The foreground actor can call `automation_list`, `automation_set`, and
`automation_change` to create, inspect, replace, pause, resume, or remove its own
rules. `automation_list` also returns the current UTC time for relative reminders.
One-shot schedules require an ISO timestamp with an explicit timezone;
interval schedules additionally take `everySeconds` (minimum 60). These are
absolute/interval schedules, not timezone-aware calendar cron rules. Listeners
currently support external `AikoHookReceived` signals and `AikoApiObserved`, with
a minimum 60-second cooldown. Unsupported event types are rejected. External
providers must use the existing authenticated, owner-scoped hook ingress; an
agent cannot install arbitrary unauthenticated webhook endpoints.

Definitions, changes and firings are native Tardigrade events. Cloudflare wake
alarms share the earliest deadline with native work and sandbox retirement.
Missed intervals coalesce rather than burst, and at most one firing per rule
waits behind active foreground work. Up to 32 retained rules are allowed per
owner. Pause/removal cancels undispatched work, not already-dispatched actions.
Due times are not a real-time delivery guarantee: active turns, alarm scheduling,
and model/provider latency can defer completion.
The native append transaction rechecks dispatch state after awaited host I/O,
preventing a concurrently paused rule from firing or an automation from starting
ahead of an active user turn. Historical import bypasses this live execution
guard and preserves full native history.

External hooks arrive on the indexer and are forwarded through the native router
as keyed, body-free signals. Only newly admitted, server-marked external hooks
are forwarded; legacy logs remain resting. Pre-registration history and synthesized browser
learning hooks cannot trigger a newly registered external-hook listener. Runs
enter `user-OWNER` with `source=automation`; they do not create another Telegram
conversation or grant new authority. Established Telegram owners use the same
owner-bound outbox, media tools and configured ThinkFeel path. API-only accounts
remain API-only. Prompt instructions restrict self-wiring to requested ongoing
tasks; they are not a proof against all prompt injection.

Read current rules at authenticated `GET /v1/automations` or
`GET /api/control/automations?account=OWNER`. Existing control event inspection
shows configuration, forwarded signals, firings and resulting native turns.
There is not yet a dedicated schedule editor in the control panel.

Regression suite: `bun test apps/agent/test/automations.test.ts`. It exercises the
real native tool/actor/Cloudflare-host adapter against SQLite, including indexer
routing, recovery, history import, cooldowns, owner isolation, and injected
pause/user races during alarm I/O and strict-provider nullable field compatibility.

Live verification on 2026-09-06 passed against Worker version
`32ebe8ea-c393-4a5d-bb3e-8755588fc315`. The isolated API canary agent created both
rules, a real external hook and its duplicate retry produced one listener firing,
a real Cloudflare alarm produced one scheduled firing, both foreground turns
completed, and the agent removed both rules. The canary required a retry after
fixing provider null-field compatibility. Evidence:
`artifacts/aiko-cloudflare/automations-live.json`; repeat with
`bun scripts/verify-aiko-cloudflare.ts --automations-test`. Live anonymous and
cross-owner rule reads returned 401 and 403 respectively. This API-only canary
does not witness a real Telegram delivery; that path is covered by local tests.

Each owner has one Telegram-facing thread, `user-${owner}`, plus hidden indexer and reflection threads. The account's native logs share its Durable Object storage, while `Memory` and `cloudflareStorage` from `entity-learn/cloudflare` enforce the same owner scope. Foreground and background actors can use that owner's learned evidence; another owner cannot read or cite it.

Hooks drive background work without a second agent loop. The native browser observer records bodyless network facts, validates endpoint evidence, and compiles eligible read-route definitions using the reused playground library. Prepared drafts and explicit pending observations trigger the foreground hook, hidden indexer, and semantic Merkle comparison. Pending observations retain their native compiler blockers and are facts, not approved or executable skills. The playground does not supply a live session adapter: unresolved ambient/session headers remain blocked, with browser fallback available. Changed knowledge can trigger reflection; an unchanged root does not repeat the notification. Only a valid decision supported by the current owner's changed evidence reaches the foreground outbox.

The authenticated [background control panel](aiko-background.md) at `/control` exposes roles, status, event history, learning roots, reflection decisions, browser/sandbox activity, and media outcomes. Account credentials see their own actors; the operator can inspect accounts across tenants and pause or resume hooks. Pause state and pending hook work survive recovery.

### Search, browser, and model behavior

Ask for a task or a search query; an exact URL is not a prerequisite. Native `web_search` calls Codegraff search, and the browser can inspect discovered public sites. The Cloudflare profile has no site allowlist or blanket denial of browsing. Its filtering proxy still blocks private-network and metadata destinations, credentials in URLs, and unsafe redirects.

The VM retains its owner's browser profile across stops. Stock Chromium and the pinned playground agent-browser client perform real navigation and interactions; they do not require CloakBrowser licensing. Public interactions do not require the legacy per-click approval panel. Website login, access controls, CAPTCHA, and authorization for sensitive account actions still apply. No shared cookie import, custody bridge, or generic model shell tool is implied.

GLM 5.3 Flash uses the native Tardie OpenAI-compatible streaming adapter through Codegraff. Native stream bounds handle provider stalls; the Cloudflare binding does not impose the earlier 30-second request override. Native compaction manages model context, with `toolCallLimit: null`, no repeated-observation stop, and no local daily inference-usage caps. Provider context/output limits, bounded transport payloads, explicit cancellation, and storage/resource safety limits remain. Set and monitor provider-side spending controls separately; unlimited tool turns are not free inference.

Production answers retain the model's redacted, source-based text. Recent browser evidence stays transient and remains available to inference above the legacy 96 KB history guard. A missing read selector yields a blocked read while preserving earlier evidence and the usable page. A started side effect with an uncertain outcome remains unknown and must not be replayed automatically.

Durable Object alarms recover native work and retire idle VMs after approximately two idle minutes when no active work blocks retirement. The provider also has an idle-stop fallback. A stopped VM is not deleted, and an uncertain allocation requires operator reconciliation before another allocation attempt.

### Telegram media capabilities and limits

The foreground tools inspect owner-bound attachments, preserve captions/replies/album metadata, send rich messages, capture actual browser screenshots, transcribe audio, and produce voice replies. Typing/upload activity, reactions, and progress updates use the Telegram transport. Native send receipts prevent replay of ambiguous sends and suppress duplicate text after a final media reply.

These are implementation limits, not claims of unrestricted media understanding:

- The hosted Telegram Bot API adapter admits downloads up to 20 MiB, photos up to 10 MiB, and supported uploads up to 50 MiB. Oversized or unsupported media fails explicitly; no local Bot API server is configured.
- Video processing samples up to six frames and transcribes available audio. Vision receives sampled frames, not every frame; unsampled content remains unverified.
- Audio transcription uses CPU `faster-whisper` with the `small` model. Language, noise, and compute latency affect results; a failed transcript is not evidence of silence.
- PDF extraction reads the text layer with `pdftotext`, not OCR. Office extraction reads supported XML text/cell values without macros or external links. Extraction can be truncated and must be reported as such.
- Voice synthesis uses CPU `espeak-ng` and Opus encoding. It is not a cloned voice or a natural-speech quality guarantee. ThinkFeel persona generation remains disabled in the current deployment configuration; this does not disable `telegram_voice`.
- Screenshots are real PNG bytes from the owner's browser. ASCII-safe transfer and SHA-256 verification protect the provider download path from binary-to-text corruption. Screenshot pixels and token-bearing download URLs do not enter durable actor logs.

See the current [media adapter](../apps/agent/src/telegram-media.ts), [native Telegram tools](../apps/agent/src/telegram-tools.ts), and [VM processors](../apps/agent/assets/media.py) for exact supported formats and bounds. Capability availability is not proof that a real recipient received or understood a media reply.

### Verify and complete the Cloudflare rollout

Keep Worker secrets in Cloudflare's secret store and local operator credentials in the private `aiko-cloudflare.env`. Never put them in source, frontend variables, command arguments, or published artifacts. Preserve actor `aiko`, instance `demo`, exact owner bindings, and complete native histories during this installation's migration.

Use the existing [deployment script](../scripts/deploy-aiko-cloudflare.ts), [Cloudflare canary and contract verifier](../scripts/verify-aiko-cloudflare.ts), and [Codegraff capability probes](../scripts/probe-codegraff.ts). Provider probes incur real usage and can wake the dedicated probe VM; they are not offline tests. With private test credentials configured, the focused canary modes are:

```sh
bun scripts/verify-aiko-cloudflare.ts --probe
bun scripts/verify-aiko-cloudflare.ts --learning
```

The learning probe uses live public sample data and requires actual native browser evidence (a prepared draft or an explicitly blocked pending observation), hook delivery, native indexing, and a changed-root reflection decision or unchanged-root suppression. Its witness reports which state was observed; pending evidence is never counted as an executable route. The provider probe offers `--search`, `--browse`, `--screenshot`, `--speech`, `--video`, and `--document`; those results do not substitute for a Telegram recipient test. After a real recipient has sent a photo, video and voice note and received rich-media/voice replies, `--telegram-check --account=TELEGRAM_ID` verifies post-handoff native receipts without sending messages. Keep witnesses under private `artifacts/aiko-cloudflare/`, separate from historical local-release artifacts.

Complete these gates before declaring production handoff:

1. Verify live query-first search/browser answers, native passive learning, and the deployed media path against the intended Worker version. Inspect failures instead of treating deployment success or offline tests as live proof.
2. Follow the [cutover runbook](aiko-cloudflare-cutover.md). Its default preflight is read-only, including deployed bot/secret attestation. The explicit `--execute` path backs up and exports settled native logs plus complete memory archives, imports without driving old turns, verifies readback, and transfers the exact Telegram cursor without dropping pending updates.
3. Confirm the Cloudflare webhook and disable the old local poller. Never run both ingress owners. An ambiguous webhook result requires reconciliation, not an automatic retry or restart of polling.
4. Complete the real Telegram test-chat media run with an authorized recipient. SDK replies, synthetic fixtures, provider media processing, and historical local Telegram deliveries do not satisfy this gate.
5. Run `bun scripts/verify-aiko-cloudflare.ts --contract` after the required live, learning, media-processing, migration, and Telegram-media witnesses exist. Keep the current test/build reports and witness timestamps; completed cutover alone is not final contract acceptance.

Do not restart the legacy service from the commands below after a successful Cloudflare handoff. A rollback must preserve new Cloudflare history and Telegram's ingress position; restarting an old snapshot is not a rollback.

## Legacy local-polling profile

The following instructions describe the earlier verified local release and its fallback storage. They do not configure the Cloudflare Worker and do not establish which ingress currently owns Telegram. Check the cutover receipts and webhook state before operating this profile.

### Earlier local capabilities

The earlier `unlock-aiko.service` profile used GLM 5.3 Flash through Codegraff, not deterministic demo inference. It ran native Tardie, real entity-learn memory, the account-scoped SDK/API, and Telegram polling for [@aikospillstea_bot](https://t.me/aikospillstea_bot).

- Real model answers are delivered, redacted and bounded; they are not discarded for a fixed demo reply.
- `web_read` reads public HTTP(S) pages that the user explicitly names. It has no cookies, login, JavaScript or mutation support. Every redirect and DNS answer is validated; connections are pinned to validated public IPv4 addresses. Responses are bounded, parsed with HTMLRewriter and saved as cited observations.
- Fixture app tools are not mounted in live mode. Historical fixture observations remain historical demo data, not connected accounts.
- `/start`, `/help`, `/status` and `/cancel` are durable host controls and do not call a model. Cancellation prioritizes the owner's command, drops earlier unadmitted Telegram requests and requests cancellation of their active turns. Already completed effects cannot be undone.
- Telegram stores a minimal **redacted durable inbox before acknowledging updates**. An independent drain admits one oldest request per account, so a busy account cannot block everyone behind it. The inbox holds 1,000 normal requests, with up to 100 reserved cancellation slots. Rejections are recorded before best-effort notification; ambiguous sends are not replayed.
- Production frontend builds render the Telegram gateway, never the sample vault. Demo HTTP routes return 404. The historical fixture UI/API requires **both** a development server and `VITE_AIKO_DEMO=true`; a production build cannot enable it.

That local release did not certify the entire Unlock custody/browser product. Its unavailable private-account integrations, authenticated custody bridge, and arbitrary-code VMs describe the legacy profile, not a blanket restriction on the Cloudflare browser and media VMs above.

### Local configuration and cost controls

Keep local credentials in `~/.config/unbrowse/aiko.env` (0600), not source, frontend variables, command arguments or artifacts. The earlier local installation requires explicit paid-inference consent:

```dotenv
AIKO_MODE=live
AIKO_ALLOW_PAID_INFERENCE=true
AIKO_MODEL=glm-5.3-flash
AIKO_PUBLIC_WEB=true
AIKO_MODEL_GLOBAL_CALLS_PER_DAY=200
AIKO_MODEL_ACCOUNT_CALLS_PER_DAY=40
AIKO_MODEL_CONCURRENCY=4
AIKO_ALLOW_THINKFEEL=false
# CODEGRAFF_API_KEY is set privately, never in this example.
```

Each actual outbound inference request, including compaction and failed/uncertain requests, reserves one allowance in `model-budget.sqlite` **before network I/O**. Restart does not reset it. UTC days are used. Each request is limited to 262,144 request bytes, at most 2,048 output tokens (the mounted model currently requests 1,024), and a 65-second transport deadline. Aborts and stream completion release concurrency slots. These are **request/token bounds, not a verified dollar spending cap**; set an independent provider-side monetary limit and verify pricing.

Native per-turn tool execution still has no fixed ceiling unless explicitly configured. The durable model allowance now bounds paid inference across those turns. Message admission retains 10/minute, 100/day and 1,000 lifetime inbound-message limits per account, with at most two unfinished admitted turns. Establish an archival/deletion policy before that lifetime cap is reached; the service will not silently erase history.

ThinkFeel remains disabled. Live answers are not sent to a second persona provider.

### Preserve the local source identity

This installation intentionally keeps:

```dotenv
AIKO_STATE_DIR=/home/deck/.local/share/unbrowse/aiko/demo
AIKO_INSTANCE_ID=demo
```

The directory and instance names are **stable storage identities**, not the inference mode. Changing them just because inference becomes live would strand history or change memory provenance. Fresh installs can select their own stable instance name. Never edit an existing thread's actor identity or merge unrelated account stores.

The pre-cutover offline backup is private at `~/.local/share/unbrowse/aiko/backups/pre-live-20260906/`. Previous configuration is private at `~/.config/unbrowse/aiko-before-live-20260906.env`. Neither belongs in a repository or web deployment.

### Operate and recover the local source

Run these commands only while the local service remains the authoritative ingress owner, or during an explicitly reviewed fallback.

```sh
systemctl --user status unlock-aiko.service
systemctl --user restart unlock-aiko.service
# /health is liveness; /ready returns 503 for stale/stopped/erroring polling.
curl --fail http://127.0.0.1:4242/ready

# Offline, all-store backup. Destination must be new, absolute, private and outside state.
systemctl --user stop unlock-aiko.service
pnpm aiko:backup /absolute/private/backups/aiko-YYYYMMDD
systemctl --user start unlock-aiko.service  # restart even if the backup failed
```

The backup command acquires the same exclusive host lock, rejects symlinks/special files and copies actor indexes, thread databases, account memory, usage reservations and Telegram inbox/cursor together. It writes a SHA-256 manifest and removes an incomplete destination on failure. It does **not** copy credentials or the host lock. A test verifies checksums, restoration of conversation history and pinned memory, and refusal while the host is running.

To restore: stop the host; preserve the current state separately; verify the backup manifest and every file hash; copy the complete snapshot into a **new** private state directory; restore its stable instance ID and point `AIKO_STATE_DIR` there. Keep directories 0700 and files 0600. Start exactly one host. Verify scoped history, pinned observations, model usage and readiness before accepting traffic. Do not restore only the memory DB or only the Telegram cursor. Restoring an old snapshot can lose newer messages or resurrect already-consumed quota; reconcile the provider budget and ingress position before reconnecting it. Do not reset quota databases to work around limits.

`GET /v1/status` reports account inference usage, fixture/public-web flags and memory catch-up. `/status` in Telegram reports account limits and capabilities without inference. Alert externally on `/ready` failures, stale polling, persistent inbox growth, repeated model failures, disk usage and approaching quotas. Logging deliberately avoids raw provider exceptions and secrets.

The earlier installation enabled the user service and user lingering. That preserves operation after logout, not through host sleep, power loss or disk failure. Its frontend was a local built preview at `http://127.0.0.1:4174`, not an Internet production deployment. Do not expose Vite preview publicly. Local Telegram polling needs no public HTTP listener; the Cloudflare webhook does. Remote access to the local SDK needs a reviewed TLS ingress or SSH tunnel; Host/Origin checks remain enabled.

### Historical local verification and evidence

Offline suite (no paid requests or real Telegram sends):

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm aiko:build
UNLOCK_BASE_URL=http://127.0.0.1:4174 BU_CDP_URL=http://127.0.0.1:9339 pnpm test:e2e:aiko
```

Explicit real-provider probes, separate from CI:

```sh
# Isolated temporary native state, eight-call hard allowance, no Telegram sends.
bun scripts/verify-aiko-live.ts --staging --allow-paid
# Provisioned integration account against the running service, subject to host allowances.
bun scripts/verify-aiko-live.ts --allow-paid
```

Evidence: `artifacts/aiko-production/verification/`, `staging.json`, `live.json`, `restart.json` and `browser/`. The first live attempt correctly refused an unversioned overwrite of an existing memory subject (`head_conflict`); the revised probe used an explicitly fresh subject. Existing notes were not overwritten. Browser checks cover seven widths, accessibility, real Telegram navigation, disabled demo endpoints, SDK disclosure controls and legacy deep links.

Users open the bot and press **Start** to begin. Successful polling and SDK replies alone do not prove Telegram delivery. The earlier local release's metadata-only check confirmed three live model replies through Telegram; `telegram-delivery.json` contains aggregate counts, without account IDs or message content. This historical evidence does not verify Cloudflare delivery or media acceptance. Delivery confirmation is not a human read receipt.

## Still required for the whole product

Public browsing and background learning do not certify private-account custody or complete the operational release. Track these remaining gates separately:

1. **Rotate the shared Telegram token** in BotFather and replace credentials in the authoritative backend through a coordinated rollout. Do not reactivate a retired local poller. Automated code cannot perform the BotFather ownership step.
2. **Complete the Cloudflare rollout and operational safeguards.** The deployment target and per-owner VM adapter are implemented. Finish the gates above, then configure monitoring/alerts, encrypted off-host backups, restore drills, retention/deletion policies and capacity testing. A local backup alone is not disaster recovery.
3. **Configure real Unlock custody:** production Postgres, owner identity and agent authorization, key custody, and destination recipes. Verify ownership before binding a Telegram account to an Unlock account. No automatic trust bridge or fake authentication fallback was added. Database-dependent backend verification still requires its dedicated configuration.
4. **Review private-account browser authorization separately.** Public browser and media tools are implemented; secure human sign-in relay, custody access, revocation, and private-account recovery still require their own proofs. Stock Chromium needs no CloakBrowser OEM license. Obtain vendor rights before adopting a separately licensed browser product; that is not a blocker for the implemented Chromium path.
5. **Complete independent security/privacy review and provider spending controls.** Cloudflare uses per-owner Durable Objects and Codegraff VMs; the legacy local profile shares a host OS identity. Neither topology proves encrypted custody, safe arbitrary code execution, or resistance to every tenant escape. Treat exports and backups as private plaintext unless separately encrypted. External content and model prose remain untrusted; reply filtering is defense-in-depth, not semantic proof.
