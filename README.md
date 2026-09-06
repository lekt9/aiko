# Unlock

**Aiko by Unbrowse**: a live Telegram assistant with real model answers, cited per-account memory, public-page reading and a portable SDK. Built with **TanStack Start, React, TypeScript, native Tardie and entity-learn**.

**Production builds no longer expose the sample vault or fixture API.** They direct users to [Aiko in Telegram](https://t.me/aikospillstea_bot). The separate encrypted-custody backend in `apps/server` is not yet connected: private app access, identity bridging and arbitrary-code VMs remain disabled. See [live operation and the remaining production gates](docs/aiko-production.md).

## Aiko local agent

The home page opens the Telegram gateway. The historical sample workspace is available only with `VITE_AIKO_DEMO=true pnpm dev`; production builds cannot enable it.

```sh
pnpm aiko:init
pnpm aiko:dev
# Native local console: http://127.0.0.1:4242
```

This installation is configured for **live GLM 5.3 Flash inference**, with durable allowances of 200 requests/day globally and 40/account/day. Fresh installations still require explicit paid-mode consent. Tardie 0.22 owns execution/recovery; actual `entity-learn@0.2.0` owns private per-account memory. Telegram is an adapter to the channel-independent `@unlock/sdk/aiko` plane. Public URL reading is enabled without cookies or JavaScript. Private app access and VM provisioning remain unmounted.

- [Agent setup and security boundaries](apps/agent/README.md)
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

`apps/web/src/routes/api.$.ts` returns 404 in production. Only an explicitly enabled development demo loads `src/server/demo.ts`. Its **shared in-memory state is process-scoped**: changes survive reloads, not server restarts. Settings → About this demo → Reset restores the seed. Tests reset this state; don't run them while preserving an interactive demo.

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

Browser tests use **browser-harness** and a fresh isolated Chromium profile, never personal Chrome. Install browser-harness and launch your own isolated browser:

```sh
chromium --headless=new --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9337 --user-data-dir="$(mktemp -d)" about:blank
# Use your installed Chromium binary. Some CI environments require --no-sandbox.
BU_CDP_URL=http://127.0.0.1:9337 pnpm test:e2e
BU_CDP_URL=http://127.0.0.1:9337 pnpm test:csv
```

The runner resets only its named QA daemon (`unlock-vault-qa` by default), disables cookie seeding/recording and checks for a fresh passing report. Set `BU_NAME` to use another isolated namespace. Latest production verification used `BU_NAME=unlock-csv-qa`, CDP `http://127.0.0.1:9339`, and `UNLOCK_BASE_URL=http://127.0.0.1:4174`; browser PID: `/tmp/unlock-final-chromium.pid`.

**40 production browser checks (28 vault + 12 CSV); 20 axe scans, zero violations.** Five views checked at 320/375/414/768/1440px, additional CSV/dialog/picker checks and 1280×800/1920px geometry. CSV checks import all 1,000 rows through the browser and cover custom mapping, malformed files, duplicates, invalid records, cancel and network recovery. Axe is a baseline, not full accessibility certification. Safari, Firefox, screen readers and actual touch hardware were not tested.

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
- `scripts/{vault_qa,csv_qa,browser_helpers}.py` — current browser suites.
- `docs/verification.html` — current self-contained report with embedded screenshots.
- `scripts/write-verification.py` — regenerate that report from measured artifacts.
- `docs/vault-ux.html` — approved redesign proposal.
- `docs/build-plan.html`, `docs/research/` — underlying production plan and pinned repository/license evidence.
- `docs/unlock-discussion.html` — preserved architecture discussion 0.7.
- `docs/dashboard-verification.html`, `artifacts/qa/` — historical dashboard evidence, not the current UX.
- `artifacts/{vault-qa,csv-qa}/` — current verification evidence.

No delegation, commits, pushes, deployment, external account login or real credential imports. Pre-existing `codedb.snapshot` remains untouched.
