# Unlock

**Aiko by Unbrowse**: a live Telegram assistant with real model answers, cited per-account memory, public-page reading and a portable SDK. Built with **TanStack Start, React, TypeScript, native Tardie and entity-learn**.

**Production builds no longer expose the sample vault or fixture API.** They direct users to [Aiko in Telegram](https://t.me/aikospillstea_bot). The separate encrypted-custody backend in `apps/server` remains optional; the hosted assistant has its own connector and remote-browser paths. See [live operation and the remaining production gates](docs/aiko-production.md).

## Hosted Aiko

Use the [hosted setup and recovery guide](docs/aiko-hosted.md) for production. Aiko's Worker owns account state in Durable Objects, with remote browser VMs and encrypted R2 backups. The build includes its browser library and needs no sibling checkout or local Aiko configuration.

```sh
pnpm install --frozen-lockfile
pnpm aiko:cloud:build
pnpm aiko:cloud:verify
```

The sections below also describe the historical local development and separate vault-service paths.

## Aiko local agent

The home page opens the Telegram gateway. The historical sample workspace is available only with `VITE_AIKO_DEMO=true pnpm dev`; production builds cannot enable it.

```sh
pnpm aiko:init
pnpm aiko:dev
# Native local console: http://127.0.0.1:4242
```

Tardie 0.22 owns execution and recovery; `entity-learn@0.2.0` owns private per-account memory. Telegram is an adapter to the channel-independent `@unlock/sdk/aiko` plane. Hosted model routes are configured in `apps/agent/wrangler.jsonc`; local-mode configuration is separate.

- [Agent setup and security boundaries](apps/agent/README.md)
+- [Vault key backends: local keyring, AWS KMS, 1Password Connect](docs/vault-key-backends.md)
 - [Self-learning harness loop: mine agent logs, graff fixer agent, PR](docs/harness-self-learning.md)
- [Telegram gateway, account isolation, portable SDK and operations](docs/aiko-gateway.md)
- [Actual entity-learn integration, persistence and recovery](docs/aiko-entity-learn.md)
- [Public-web browser setup, approvals and real-browser verification](docs/aiko-browser.md)
- [Unlimited task execution and remaining safeguards](docs/aiko-unlimited.md)
- [Original UI/foundation implementation report](docs/aiko-implementation.html)
- App/browser checks: `BU_CDP_URL=http://127.0.0.1:9339 pnpm test:e2e:aiko`

## Backend and SDK

- [Implementation and operator setup](docs/backend-implementation.html)
- [Backend verification](docs/backend-verification.html)
- [SDK entry points and examples](packages/sdk/README.md)

`pnpm build:backend` builds the shared protocol, SDK and Node service. `pnpm server:init /private/path/server.json` creates a private starter key/config file without overwriting anything or creating an authentication bypass. Configure the upstream owner IdP, database, TLS and approved destination recipes, then use `UNLOCK_CONFIG=/private/path/server.json pnpm server:start`.

New SDK imports: `/vault` (owner metadata), `/owner` (owner secrets), `/agent` (private runtime), `/cdp`, `/oauth`, and `/tools` (MCP metadata helper). The old root and `/runtime` imports retain the demo protocol. A JSON CLI is available as `unlock-agent` when packaged, or `node packages/sdk/dist/cli.js help` locally.

Connections can natively resolve credentials from password managers instead of stored passwords: `@unlock/sdk/sources` builds source authorizations for **1Password** (official SDK), **Keeper Secrets Manager** (official SDK), **HashiCorp Vault** KV v2 and **Doppler** (documented REST APIs). The server dispatches resolution by source kind, seals provider tokens at rest, and fails closed on unregistered kinds; see [SDK entry points and examples](packages/sdk/README.md).

**Core implementation is not production certification.** Custody deployment, authenticated browser recipes, operations and independent security review remain activation gates. No private app accounts have been connected. The assistant's real inference and public-page reader are separately verified.

## Run

Use a patched Node 24 LTS (verified with 24.18.1) and pnpm 10.

```sh
pnpm install --frozen-lockfile
pnpm build:backend
pnpm dev
# http://127.0.0.1:4173

pnpm build
pnpm preview
# Production preview: http://127.0.0.1:4174
```

Both servers bind to loopback. Port 3000 belongs to an unrelated local service. Use Ctrl+C to stop foreground servers; inspect process identity before using `/tmp/unlock-dev.pid` or `/tmp/unlock-preview.pid`.

## Historical workspace — development demo only

The following UI features require `VITE_AIKO_DEMO=true pnpm dev`. They are not exposed by the production gateway and must not receive real credentials.

- **Your apps** drawer, app/account search, favorites, profile scoping and actionable sample status.
- App detail with capability previews and every saved identity underneath.
- **Accounts & access** retains All logins, search and the alphabetical website/username list.
- Desktop list/detail layout; phone list → details → Back.
- Profile dropdown: **My vault**, named agents, New profile and Edit profile.
- Profile switching changes the owner's view, not permissions or identity.
- Add a sample login, or share an existing item with an agent without duplication.
- Edit login names and synthetic usernames; reveal/copy the fixed fake password.
- Passwordless items show their sign-in method instead of a fabricated password field.
- **Available to** access editor; separate **Remove from profile** and **Delete login** confirmations.
- Actionable **Sign in again** / **Reconnect 1Password** notices, without session controls.
- Settings: vault name, whole-file CSV import, manager-reference fixtures, optional developer guidance and reset.
- Keyboard search shortcut, focus-trapped native dialogs, responsive layouts and reduced motion.

There is no Overview, Sessions, Sources, Activity or Developers navigation. Old URLs redirect into the vault or Settings. The runtime machinery remains behind the SDK/API, not in the everyday interface.

The add form deliberately uses sample websites/usernames and a read-only `demo-password-only` value. Editing cannot change a real password. Browser sign-in and manager connections are explicitly simulated. All destinations are fictional `.example.test` domains; usernames end in `.example` or `.test`. Brand names are integration concepts, not partnerships.

## Bulk CSV import

Open **Settings → Import CSV**. Choose an entire UTF-8 CSV/TSV, review matched columns and every row, then confirm one batch. A sample CSV is available in the dialog.

- Up to **1,000 rows / 1 MiB per file**, with a 2,000-record demo vault limit (including retained revoked records). Oversized files are rejected, never silently truncated.
- Comma, semicolon and tab delimiters; BOM, quoted commas, escaped quotes and multiline fields.
- Common Chrome/NordPass/Bitwarden/1Password-style column names are recognized; custom headers can be mapped manually. This is format handling, not a live integration or a guarantee for every provider export version.
- Duplicates match normalized hostname + trimmed, case-sensitive username. Different accounts on one website are retained. Existing records and profile access are never overwritten.
- Every row is reviewed in a paginated preview. Invalid/non-login rows are skipped explicitly; malformed CSV quoting blocks the file. The server revalidates and checks duplicates/capacity before publishing.
- Imports go to **My vault only**, with no automatic agent access or ongoing source synchronization.

**Demo files only:** websites/usernames must end in `.example` or `.test`. Recognized password, note and token columns are discarded locally; only mapped fictional metadata is sent to the API. URL paths and queries are not retained. CSV-created items say **Password: Not imported in this demo**, rather than showing the fixture password. Do not upload a real vault export to this demo. Encrypted password ingestion exists only in the separately authenticated backend/owner SDK.

## Storage and security boundary

`apps/web/src/routes/api.$.ts` forwards selected live connector, approval, scheduled-task, message, secretary, browser-watch and database endpoints to the authenticated agent proxy before checking demo mode. The remaining fixture API routes return 404 in production. Only an explicitly enabled development demo loads `src/server/demo.ts`. Its **shared in-memory state is process-scoped**: changes survive reloads, not server restarts. Settings → About this demo → Reset restores the seed. Tests reset this state; don't run them while preserving an interactive demo. See [the proxy allowlist](apps/web/src/server/connector-proxy.ts) for the exact live routes.

Loopback Host checks, same-origin checks and no-store JSON are **not authentication**. Any local process can access the fixture API. Password/cookie/token input is not accepted; free-text metadata fields are never intended for credentials. The UI's reveal/copy controls use a fixed synthetic constant, not a production secret retrieval endpoint.

`@unlock/sdk/runtime` is separate from management metadata. It belongs only in trusted host code, never LLM tool arguments/results. Initialize a dedicated browser once before authenticated navigation; synchronize with compare-and-swap revisions, not cookie reinjection before every click. Conflict recovery is explicit. The separate `/agent` and `/cdp` SDK entry points and backend worker implement the new service contract; they are not connected to this fixture API. Provider-specific browser login recipes still need implementation and live validation.

Disabling/unassigning a profile or deleting a login stops future retrieval/sync. Cookies already delivered to a browser may remain valid upstream; this does not guarantee website logout. One-time imports are independent snapshots; live references retain the source as authoritative.

## Verification

```sh
pnpm typecheck
pnpm test                 # Demo + backend unit tests; DB integration requires test configuration
# Real Postgres integration, in an isolated unlock_test_* schema:
# Set UNLOCK_TEST_DATABASE_URL through a private env file, then:
pnpm test:backend
pnpm format:check
pnpm build
pnpm test:http            # Requires an explicit development demo; resets its fixture state
```

The default `pnpm test:e2e` and `pnpm test:e2e:aiko` checks use **browser-harness** to exercise connector sign-in/recovery, database editing/recovery, secretary work and draft preservation. The runner builds the current connector UI, starts local synthetic native hosts and creates a temporary Chromium profile. It shuts down its processes afterward. Hosted CI runs the same command. These checks do not validate deployed providers or personal accounts.

Install `browser-harness==0.1.8` with Python 3.12 and an installed Chrome/Chromium binary:

```sh
CHROME_BIN=/path/to/chrome pnpm test:e2e:aiko
```

The runner discovers standard Linux Chrome locations when `CHROME_BIN` is omitted. Each run preserves its results and process logs in a unique directory under `artifacts/aiko-ui-qa/`. The separate gateway check (`pnpm test:e2e:gateway`) covers the landing page and Telegram link. For gateway or historical vault/CSV checks, launch an isolated browser and the appropriate web preview first:

```sh
chromium --headless=new --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9337 --user-data-dir="$(mktemp -d)" about:blank
# Use your installed Chromium binary. Some CI environments require --no-sandbox.
BU_CDP_URL=http://127.0.0.1:9337 pnpm test:e2e:gateway
# Historical vault/CSV checks require explicitly enabled demo servers:
BU_CDP_URL=http://127.0.0.1:9337 pnpm test:e2e:legacy
BU_CDP_URL=http://127.0.0.1:9337 pnpm test:csv
```

The legacy runner resets only its named QA daemon (`unlock-vault-qa` by default), disables cookie seeding/recording and checks for a fresh passing report. Set `BU_NAME` to use another isolated namespace and `UNLOCK_BASE_URL` for the intended loopback preview.

**Historical vault-demo evidence:** [the archived report](docs/verification.html) records 40 browser checks (28 vault + 12 CSV) and 20 axe scans with zero violations. These are historical synthetic-preview results, not a current Aiko verification claim. Axe is a baseline, not full accessibility certification; Safari, Firefox, screen readers and actual touch hardware were not tested.

To regenerate that vault-demo report, start a dedicated loopback development demo server, then run `python3 scripts/verification_evidence.py` with `BU_CDP_URL` and `UNLOCK_DEMO_DEV_URL` as needed. This executes all required checks and records exit codes, source revision/content hashes, execution times and artifact hashes. `python3 scripts/write-verification.py` only renders complete passing evidence from the same unchanged source within 24 hours. It rejects old unbound artifacts and distinguishes test completion from report generation; a failed render preserves the historical report. The generated report describes only its recorded development-demo checks. The separate production build check does not imply browser coverage of that bundle.

## Files

- `apps/web/src/components/vault/` — current login list, details, dialogs and Settings.
- `apps/web/src/lib/vault.tsx` — URL-based profile/search/selection state.
- `apps/server/src/` — encrypted PostgreSQL service, authentication, sources and renewal worker.
- `packages/protocol/` — strict shared API/cookie schemas.
- `packages/sdk/` — separate metadata, owner, agent, OAuth, CDP and CLI entry points.
- `tests/backend/` — real database/HTTP/OAuth, security, worker, SDK and process-restart checks.
- `tests/{sdk,vault,csv-import}.test.ts` — runtime, vault/access and CSV regressions.
- `tests/fixtures/` — fictional CSVs, including the 1,000-row browser test.
- `apps/web/src/lib/{csv-import,import-policy}.ts` — local parsing, mapping and shared demo validation.
- `apps/web/src/server/{csv-import,read-json}.ts` — atomic bulk import and bounded streamed JSON reading.
- `scripts/aiko-ui-qa.mjs`, `apps/web/test/*.browser.py` — current synthetic Aiko journeys.
- `scripts/{vault_qa,csv_qa,browser_helpers}.py` — historical demo browser suites and shared helpers.
- `docs/verification.html` — historical vault-demo report with embedded screenshots.
- `scripts/{verification_evidence,write-verification}.py` — capture fresh demo evidence and render its report.
- `docs/vault-ux.html` — approved redesign proposal.
- `docs/build-plan.html`, `docs/research/` — underlying production plan and pinned repository/license evidence.
- `docs/unlock-discussion.html` — preserved architecture discussion 0.7.
- `docs/dashboard-verification.html`, `artifacts/qa/` — historical dashboard evidence, not the current UX.
- `artifacts/{vault-qa,csv-qa}/` — historical demo evidence; fresh runs require the provenance checks above.

No delegation, commits, pushes, deployment, external account login or real credential imports. Pre-existing `codedb.snapshot` remains untouched.
