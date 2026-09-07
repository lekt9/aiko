# Build progress

Implementation is native to this session. Cancelled delegated work; retained public repository evidence only.

Additive paths: apps/web/{src,package.json,vite.config.ts,tsconfig.json}; packages/sdk/{src,tests,package.json,tsconfig*.json}; scripts/; tests/; docs/{build-plan.html,verification.html,research/}; root workspace configs; tokens.css; .hallmark/; artifacts/qa/. No deletions.

Initial architecture: synthetic in-memory web demo and its original SDK. The later separate encrypted backend is recorded below; the web preview still uses fixtures.

## Historical dashboard handoff · 2026-09-05T09:52:15.582840+00:00

- Production preview: http://127.0.0.1:4174; development: http://127.0.0.1:4173.
- 39 unit/service/runtime tests, 38 production browser checks, seven actual HTTP SDK checks on each server. Install, strict typecheck, format check and production build pass.
- Twenty axe scans (ten routes × desktop/mobile), zero violations; forty required-width route geometry passes. Actual screenshots inspected.
- Fixed challenge/pause state handling, seeded-profile punctuation validation, mobile text squeezing, low contrast, unnamed mobile command button and keyboard access to scroll regions.
- No known audit advisories. Real secrets/auth/provider connections remain unavailable.
- Self-contained handoff: docs/verification.html; reuse plan: docs/build-plan.html.
- No delegation resumed, no commits or deployment, no personal browser use.

## Vault-first revision · 2026-09-05

- User approved replacing the dashboard with a password manager. Implemented directly, without delegation.
- Root now shows saved logins; persistent profile dropdown, search/favorites, responsive details, add/edit/share/remove/delete flows. Sessions and operational navigation are gone from the everyday UI; legacy URLs redirect.
- Added typed metadata updates, favorites, avatars, initial profile assignments and atomic access updates. Real credential entry remains unavailable; reveal/copy uses a fixed fake value.
- Final verification: 49 tests, 28 production browser checks, nine HTTP checks against each server, 17 axe scans with zero violations. Strict typecheck, formatting and build pass.
- Five views checked at 320/375/414/768/1440px, separate dialog/picker checks, 1280×800/1920px and reduced motion. Fixed native-dialog keyboard wrapping and increased mobile copy targets.
- Busy-host CDP timeouts were isolated from app failures: final QA used a fresh browser and non-blocking axe completion polling. Final run passed; raw evidence is in artifacts/vault-qa/.
- Current report: docs/verification.html. Historical dashboard report: docs/dashboard-verification.html. Both embed screenshots.
- Dev: http://127.0.0.1:4173. Production: http://127.0.0.1:4174. Final isolated browser: CDP 9339, namespace unlock-final-qa; /tmp/unlock-final-chromium.pid.
- Legacy dashboard source files remain unrouted: components/connect.tsx, developers.tsx, manage-pages.tsx, vault-pages.tsx and styles/app.css. Retained pending deletion approval; not used by the new route tree. Large fixture-service/CSS modularization is follow-up cleanup, not production readiness.
- Architecture discussion and codedb.snapshot preserved. No real secrets, authentication, external connections, automatic provider renewal, deployments or commits.

## Whole-file CSV import · 2026-09-05

- Replaced the single-sample import entry with Settings → Import CSV: local file selection, common/custom column mapping, all-row paginated preview and one confirmed batch.
- Handles UTF-8/BOM, comma/semicolon/tab separators, quoted commas, doubled quotes and multiline fields. Up to 1,000 rows / 1 MiB; oversized or malformed files are rejected rather than truncated.
- Added typed connections.importCsv, shared demo validation, server-side duplicate checks and atomic capacity enforcement. Vault capacity is 2,000 retained records; larger profile assignments are supported with bounded request reading.
- Different usernames on the same host are retained; existing logins and profile access are never overwritten. Invalid/non-login rows are explained and skipped.
- Synthetic metadata only. Recognized password/notes/token columns are discarded locally, URL paths/queries are omitted, real domains are rejected, and imported details explicitly say no password was imported.
- Verified 72 tests, 12 dedicated production CSV checks (including an actual 1,000-row browser upload/import), all 28 vault regression checks, 10 HTTP checks per server and 20 total axe scans with no violations. Typecheck, formatting and production build passed.
- Reviewed the parser, transport limits, atomic writes, privacy boundary and UI. Condensed matched columns into a disclosure and removed a footer overlay that obstructed pagination during browser testing.
- Current proof: artifacts/csv-qa/ plus artifacts/vault-qa/. docs/verification.html aggregates both suites and embeds the CSV screenshots.
- Continued directly, with isolated synthetic browser testing; no delegation, real export inspection, new dependencies, commits or deployment.

## Separate encrypted backend and SDK · 2026-09-05 UTC

- Implemented apps/server and packages/protocol, with SDK 0.2.0 metadata, owner-secret, trusted-agent, OAuth, CDP and metadata-tool entry points. Original demo exports and UI remain intact.
- Real Postgres persistence/migrations, envelope encryption with supplied local or KMS wrapping keys, selected 1Password references, password-bearing CSV staging/atomic commit, standing assignments, owner OIDC and agent OAuth.
- Private destination-cookie retrieval/sync, verified publication with CAS and generation fencing, scheduled job claims/retries, private reusable SSO parents/checkpoints and shared-parent locking. Unsupported providers surface challenges; no arbitrary browser-login catalog is claimed.
- Isolated CDP adapter and exactly-once tool delegation with explicit recovery; encrypted serialized refresh-token storage, operator-gated JSON CLI and metadata-only MCP host helper.
- Fresh evidence: 127 tests passed (55 backend + 72 demo), 4 private Chromium adapter checks, all 40 existing production UI browser checks, 10 HTTP checks per demo server, 20 axe scans with zero violations, 2 real dump/restore checks, and 8 packed-consumer import checks. Current dependency audit: zero advisories.
- Backend/protocol/SDK/web and backend-test typechecks, formatting and builds pass. A new concurrent apps/agent scaffold appeared with no source inputs; workspace-wide typecheck reports TS18003 there. It was left untouched, and scoped passing checks are recorded separately. Host contention also prompted bounded test/typecheck concurrency and explicit multi-I/O test budgets; no failed assertions were suppressed.
- Runbook: docs/backend-implementation.html. SDK: packages/sdk/README.md. Current measured report: docs/backend-verification.html; raw evidence: artifacts/backend-qa/. Prior SDK guide archived at docs/sdk-demo.md.
- Activation still requires production IdP/TLS/database/key configuration, authorized source credentials, reviewed destination-specific browser/SSO recipes, actual provider/KMS validation, operations drills and independent security review. Current web UI is not connected to real custody. No production backend was left running.
- No delegation, commits, pushes, deployment, real-account access or paid APIs. Architecture discussion and unrelated codedb.snapshot preserved.

## Native password manager sources · 2026-09-07

- Replaced the 1Password-only source authorization with a native multi-provider registry. `@unlock/protocol` now validates a discriminated union of password manager kinds, each with its own reference syntax: `onepassword` (`op://vault/item[/section]/field`), `keeper` (`keeper://RECORD_UID/field/NAME`), `hashicorp-vault` (`vault://MOUNT/PATH#FIELD`, KV v2, path traversal rejected) and `doppler` (`doppler://SECRET_NAME`).
- New apps/server/src/sources.ts: `SourceRegistry` dispatches resolution by the source kind persisted in the vault database; per-provider implementations use the official 1Password and Keeper SDKs and documented REST APIs for Vault KV v2 and Doppler. Unregistered kinds and provider failures collapse to `SOURCE_UNAVAILABLE`; response bodies are capped and no provider internals leak into error paths.
- The HashiCorp Vault cluster address/namespace is operator server configuration (`sources.hashicorpVault`, HTTPS enforced outside loopback development), not per-tenant data; provider tokens stay sealed at rest exactly as before, so no envelope format or rewrap change is needed.
- New `@unlock/sdk/sources` entry point: `passwordManagers.onePassword/keeper/hashicorpVault/doppler` builders validate references locally before anything is sent, so callers can pass in the password manager directly. `SourceAuthorization` is now the protocol union; `owner.addSource`/`reconnectSource` accept it. Reconnection cannot change a source's kind (`INVALID_INPUT`).
- Runtime resolution selects the provider by kind from the sources row; the maintainer fails closed for unknown kinds, records the error on the job, publishes no session and keeps retrieval in recovery. Bitwarden's official JS SDK is still pre-release WASM-only, so that kind is intentionally deferred rather than hand-rolling its access-token crypto.
- Tests: 11 new checks (per-kind reference acceptance/rejection including traversal, kind dispatch without cross-provider mixing, fail-closed unregistered kinds, kind-stable reconnection) — full backend suite 79/79 and workspace 112 passed / 47 skipped. Backend builds and strict typechecks pass. Found during testing: the maintainer claims queued jobs across tenants in the shared test schema, so new tests now clean up their queued jobs to keep the retry-budget test deterministic.
- Demo UI boundary unchanged: the web preview still simulates manager connections and accepts no real credentials. Live provider validation, authorized service tokens and independent security review remain activation gates. No commits, deployment or real-account access.
