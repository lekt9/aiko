# Aiko by Unbrowse — live account runtime

One foreground conversation per account now has private native learning and reflection actors behind it. Open the operator panel at **http://127.0.0.1:4242/control** to inspect threads, event causality, Merkle changes, decisions, memory and delivery. The **Node graph** tab now inspects scoped knowledge and browser request/index receipts; see [graph inspection](../../docs/aiko-memory-graph.md). See [background actors and hooks](../../docs/aiko-background.md) for the SDK/Unbrowse hook contracts, isolation, recovery and rollout evidence.

A Telegram-first personal-agent foundation using **native Tardie 0.22.0**, with a transport-neutral account plane and SDK. Telegram polling is configured locally; real app/custody access remains unmounted. No Smithers or Cell runtime orchestration is used.

This installation now uses **live GLM inference**, durable per-account/global request allowances and real cited public-page reads. Fixture app tools are unmounted in live mode; private apps remain disconnected. See [production operation and remaining release gates](../../docs/aiko-production.md), and [gateway setup and SDK usage](../../docs/aiko-gateway.md).

## Run locally

Requires Bun **1.4+**, Node and pnpm 10.12.1.

```sh
pnpm install --frozen-lockfile
pnpm aiko:init
pnpm aiko:dev
# In another terminal:
pnpm dev
```

- Telegram gateway frontend: <http://127.0.0.1:4173>
- Native agent console: <http://127.0.0.1:4242>
- Operator token: `~/.config/unbrowse/aiko-operator.env` (0600). Open this private file locally to unlock the console. The token is never printed by initialization and is held in tab memory only.
- ThinkFeel configuration: `~/.config/unbrowse/aiko.env` (0600). Existing contents are preserved. Do not commit, paste, or export this file into a user VM.
- Durable state: `~/.local/share/unbrowse/aiko/demo/` (0700). Native actor/thread SQLite logs survive restarts. Each non-local account has a private `accounts/<hash>/` log and `entity-learn@0.2.0` memory database; operator state remains in place. A SQLite exclusive lock prevents two hosts from racing the same state directory.

A fresh installation defaults to **demo**, even if provider keys exist; this host is explicitly configured **live**. Demo mode performs deterministic native-model tool calls against synthetic reads and uses safe reply templates. Live mode delivers real model answers; it does not implicitly provision VMs, connect private apps or register Telegram webhooks.

In demo mode only, try “Show sample apps” or “Show sample GitHub issues”. In live mode, ask a question or provide a public page URL. For actual persistent notes, try “Remember: Use UTC for the launch”, restart, then “Search memory for UTC”. User-message excerpts automatically become cited log episodes after replies. “Refresh logs” separately observes a bounded metadata-only thread window. The historical app drawer is development-only. Production web builds expose neither its controls nor its fixture API. No authenticated custody bridge is enabled.

## Public-web browser

The actual 29-tool playground browser client is now mounted through native Tardie tools when explicitly enabled. It can browse multiple public sites and has no default tool-call ceiling or repeated-observation stop. A finite native budget is now opt-in; see [unlimited execution](../../docs/aiko-unlimited.md). Approvals, isolation, truthful receipts and ambiguous-action recovery remain in place.

See [setup, privacy boundaries and real-browser verification](../../docs/aiko-browser.md). This uses a separately supplied stock Chromium executable; it does not activate CloakBrowser, account login, HAR-to-API learning or VMs.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/actor.ts` | Native actor, inference composition, unlimited-by-default tools with opt-in budget, mounted tools, bounded truthful replies and durable outbox |
| `src/inference.ts` | Prior model-visible speech uses the accepted wording; original evidence stays immutable |
| `src/server.ts` | Loopback HTTP, operator/Mini App authorization, bounded admission, native Bun host and recovery |
| `src/telegram.ts`, `src/telegram-polling.ts` | Private sender verification, allowlist/explicit public onboarding, durable polling cursor, bounded delivery |
| `src/accounts.ts`, `src/plane.ts`, `src/plane-auth.ts` | Private account storage, transport-neutral discovery/memory reads, account-bound credential grants |
| `src/log-memory.ts` | Native, replay-safe follower from each account's selected logs into entity-learn |
| `src/model-budget.ts`, `src/reply-policy.ts` | Durable paid-request reservations, bounded live answers and receipt-qualified citations |
| `src/public-web.ts` | Read-only, SSRF-filtered, exact-user-URL public page tool with cited observations |
| `src/telegram-control.ts`, `src/backup.ts` | Model-free Telegram commands and exclusive offline state snapshots |
| `src/voice.ts` | Cancellation-aware ThinkFeel transport, shared limiter, circuit breaker, strict non-factual wording allowlist |
| `src/capabilities.ts` | Explicitly synthetic source data and cited read receipt types; no independent memory/search engine |
| `src/memory.ts` | Tardie 0.22 native bindings to actual entity-learn recall/get/history/sources/remember/forget/refresh; host-owned scope, approval and idempotency |
| `src/browser.ts` | Native tool/inference binding, transient evidence, owner-scoped approvals and ambiguous-action recovery |
| `src/browser-driver.ts`, `src/browser-proxy.ts` | Actual playground client lifecycle and bounded public IPv4 forwarding |
| `src/vm.ts` | **Unmounted** native lifecycle component/provider contract; no concrete VM provisioning or authenticated browser adapter |
| `src/config.ts`, `src/security.ts` | Private configuration, signature verification, body bounds and credential redaction |

Tardie owns execution and effect recovery. There is no separate OpenAI SDK loop, entity-learn scheduler, generic shell, credential loader or arbitrary JavaScript tool. Optional public browsing uses the reviewed browser schemas; interactions require approval. This does not grant authenticated app access. Memory writes are local agent claims, not changes to connected apps. The native OpenAI-compatible adapter binds `glm-5.3-flash` to `https://gateway.codegraff.com/v1`; tests exercise that adapter with a mocked stream.

Pinned package: `tardie@0.22.0`, package source-tree identifier `80e14bed22778b9846b3d364864f8ac6fd4b7c4d`; `effect@4.0.0-rc.110`. This deliberately supersedes the older installed-skill examples and planning snapshot. Current assembly APIs are tested; incompatible older `actorOf` examples are not mixed in.

### Replies, privacy and recovery

- GLM output is not evidence of a successful action. Tool-generated receipts are authoritative and never rewritten by ThinkFeel.
- ThinkFeel receives only a neutral intro or fixed greeting, **not receipts, account identities, full transcripts or secrets**. A small literal wording allowlist prevents added facts. This is intentionally conservative, not unrestricted personification.
- Voice-start is persisted before a billable expression request. Recovery uses a template instead of rebilling an uncertain request.
- Accepted text is persisted before Telegram delivery. A send-start record without a confirmed result becomes **unknown**; it is not blindly retried. Telegram does not offer exactly-once delivery. A message can be lost after send-start and before transmission; operator handling is still needed.
- Only the private-chat sender can select their own actor thread. Operator auth accesses the local console thread, not arbitrary Telegram histories. Mini App auth has a five-minute signature lifetime and follows the configured allowlist/public-onboarding policy. SDK bearer grants select exactly one account and read/write scopes.
- Known platform credentials and recognizable credential syntax are redacted before logging. This is not a guarantee that arbitrary user prose contains no secrets. Never ask users to put passwords or cookies in chat.
- Tardie transcripts and entity-learn memory are private filesystem data, **not encrypted Unlock custody records**. Real credentials remain in the existing encrypted backend; that bridge is not implemented here.

### Live inference and disabled private integrations

Live model mode requires all of:

- `AIKO_MODE=live`
- `AIKO_ALLOW_PAID_INFERENCE=true`
- `CODEGRAFF_API_KEY`

ThinkFeel additionally requires `AIKO_ALLOW_THINKFEEL=true` and `THINKFEEL_API_KEY`. Default persona: `3c36e929-50ac-4971-919f-70e6fc6273b7` (the supplied Unreel persona). Entitlement, product suitability, pricing and retention terms have **not** been verified with a live call. Rotate the key previously shared in chat before live use.

Telegram requires `TELEGRAM_BOT_TOKEN`, a 32–256 character `TELEGRAM_WEBHOOK_SECRET`, and either numeric `AIKO_TELEGRAM_ALLOWED_USERS` or explicit `AIKO_TELEGRAM_PUBLIC=true`. This host is configured for outbound polling of `@aikospillstea_bot`, capped at 100 registered accounts. Its token stays in private configuration. No public tunnel or webhook is registered. Alternative webhook mode and remote-agent ingress require a reviewed TLS proxy; the server remains loopback-only with Host/Origin checks. See [the gateway runbook](../../docs/aiko-gateway.md).

Live mode enables the separate read-only `web_read` tool by default (`AIKO_PUBLIC_WEB=false` disables it). Model flags do not enable the optional interactive public-web browser. Authenticated browser/VM execution remains unmounted; its separate release gates are:

1. Recover and pin the actual `Unbrowse/contract` classic branch (the supplied URL returned 404).
2. Obtain CloakBrowser OEM/SaaS rights for customer-facing use.
3. Independently enforce browser network isolation; agent-browser CDP flags alone are insufficient.
4. Verify secure human sign-in relay and per-user identity binding to Unlock custody.
5. Prove Codegraff disk/browser compatibility and persistent stop/start recovery in an explicitly authorized sandbox.
6. Approve provisioning spend and implement provider adapters, revocation, reconciliation and operational recovery.

### Actual entity-learn integration

The old application-owned pointer/BM25 implementation has been removed. `vendor/entity-learn-0.2.0.tgz` is built from the actual `/home/deck/work/entity-learn` working tree; its source and artifact hashes are retained in the adjacent provenance file. Core normalization, immutable observations, search, corrections, dependencies, source refresh and journaling now come from that package.

Its supplied `memoryPackage` targets Tardie **0.5**, so Aiko does **not** import that adapter or downgrade its runtime. `src/memory.ts` mounts the real core through **0.22 native tools**, and uses the upstream framework-neutral `tardigradeLogSource` export. The optional legacy peer warning during installation is expected; the installed runtime remains solely `tardie@0.22.0`.

Paths, scope, source approval, native actor identity and replay keys are host-owned, never model arguments. Recall does not refresh. The host explicitly refreshes its approved log projection after replies; fixture sources and the separate metadata-only log view still require explicit tool reads. Existing disabled sources are not silently approved again. Forgetting suppresses retrieval, including cited/derived claims, but does not physically erase journals, prior tool/chat logs, current context or backups. Payloads are data, not instructions or authority.

See [integration details and verification](../../docs/aiko-entity-learn.md). This does not activate the unavailable classic branch, real-account access, Supabase Auth/RLS or Telegram OAuth. Those authentication/deployment gates remain separate.

## Verification

```sh
pnpm typecheck
pnpm aiko:browser:init     # Verify/install the pinned CLI asset before client tests
pnpm test                 # Vitest, Bun-native Aiko, and imported client tests
pnpm build
pnpm aiko:build
BU_CDP_URL=http://127.0.0.1:9339 pnpm test:e2e:aiko
```

UI tests use `browser-harness` and isolated sessions. The dedicated public-browser suite also reads actual public websites with a real Chromium process; no credentials or paid model are used. The separate console fixture is `bun scripts/aiko-console-fixture.ts` on port 4243; run `scripts/aiko_console_qa.py` through browser-harness with `UNLOCK_ROOT` set. Its published fixture token is **not** a real credential.

Public-browser integration evidence: `artifacts/aiko-browser/`. Entity-learn integration evidence: `artifacts/aiko-entity-learn/`, including an actual durable-host commit-before-acknowledgement crash regression. UI foundation evidence: `artifacts/aiko-build/app-qa/`, `artifacts/aiko-build/console-qa/`, and `docs/aiko-implementation.html`. Database-dependent backend tests require the separate backend test environment. Historical vault tests require the explicit development demo. The current gateway browser suite checks real Telegram navigation, responsive/accessibility behavior and disabled demo API/deep-link paths. Current production evidence is in `artifacts/aiko-production/`; real-provider probes are explicitly opt-in, outside the offline test suite.
