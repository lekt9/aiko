# Connector login, agent memory and backup verification

## Deployment recheck — 2026-09-08

Worker `67efbc4a-f28a-424a-8693-25a1e8963f57` was already published by the parallel release at 16:06 UTC from Unlock `097b611c` and shared runtime `0933948b`. This connector check did not republish, change keys or webhook settings, or include later concurrent working-tree edits. Use [the hosted entry instructions](aiko-hosted.md#open-the-connector-interface).

**Reachable, but full connector readiness is blocked:**

- Public assets, authenticated catalog discovery (8,252 tools), and anonymous-access rejection passed. The 390px browser check loaded the real app list with the isolated canary bearer and simulated Telegram presentation; this is not a real Telegram-client session test.
- 116 focused connector/login tests passed; one opt-in live-browser test skipped. These ran against the isolated deployed-source snapshot.
- A fresh Worker → Codegraff synthetic sign-in verified and saved credentials at 16:27 UTC. Its indexing job then failed with `connection_context_index_failed`; the complete native-login/index verifier did **not** pass. Both the prior and new synthetic canary grants were disconnected with confirmed private cleanup.
- The full catalog/router verifier repeatedly failed with HTTP 409, including after canary cleanup. Separate routing reads succeeded, but a tagged probe also returned HTTP 503 with a Cloudflare Durable Object storage-reset reference. The underlying cause remains unresolved; no automatic replay of sign-in inputs or application writes was used.
- Scheduled-task reads reported `promises_unavailable` because deployed code mode was disabled. No unrelated feature gates or grants were enabled to make checks pass.

Evidence is retained privately under `artifacts/connector-availability-20260908/`, including `summary.json`, `host-diagnostic.json`, `index-diagnostic.json`, the native login receipt and cleanup receipts. `/ready`, a catalog result, or a saved connection must not substitute for these failed execution gates. Next: diagnose routing/storage resets and connection-context indexing on the isolated canary, then rerun the complete checks before declaring readiness.

## Historical complete witness

Verified on 2026-09-07 against `https://aiko-agent.lewis-6d8.workers.dev/connect` using the isolated `acct_cloudflare_e2e02` account and synthetic credentials.

| Requirement | Implementation and evidence |
| --- | --- |
| TanStack Mini App | TanStack Router and Query own `/connect`. Deployed mobile login fields and layout verified in real Chrome; 14 browser checks passed. |
| Verified credential custody | The production Worker privately drove login in Codegraff. Username/password entered encrypted Unlock custody only after independent login verification. See `artifacts/connectors/deployed-native-login.json`. |
| Automatic re-login | A deployed session expired and renewed without the client resubmitting credentials. See `artifacts/connectors/deployed-native-renewal.json`. |
| Route indexing | All three linked safe canary routes, including a query route, indexed under one verified connection revision. See `artifacts/connectors/deployed-native-index.json`. |
| Live request graph | The deployed Tardigrade agent searched learned pointers, replayed request dependencies, and reported the fresh project name. See `artifacts/request-memory/deployed-agent.json`. Real Chrome separately verified restoration after driver restart, a three-request DAG, and login/challenge refusals. |
| Tool and code capabilities | Deployed catalog/router verification passed with 8,252 catalog tools and Gmail/Slack read routes. Native tests cover observed tools, GitHub-derived harnesses, saved code workflows, graph provenance and owner-scoped router exposure. |
| Database-backed verification | 79 backend tests passed against a real isolated PostgreSQL 17 instance. The temporary instance was shut down afterward. |
| Cloudflare persistence | A deployed Worker → Codegraff → encrypted R2 snapshot passed readback. The matching real R2 snapshot was decrypted into an empty local store, including its verified synthetic credentials; integrity and current-grant filtering passed. See `artifacts/backups/deployed.json` and `deployed-recovery.json`. |

The final agent suite passed 640 tests, with eight environment-gated skips and no failures. Live browser tests ran separately. Agent and web typechecks and the entity-learn integration contract passed. Logs are under `artifacts/verification/`.

Coverage is explicit: crawling follows discoverable safe links, with durable continuation for large pages; hidden and button-driven routes are not an exhaustive site inventory. Request pointers expose required non-secret route inputs and recompute observed response-derived identifiers. MFA and unrecognized login pages require owner input. Backups are on demand. Recovery was exercised into an empty local store, without replacing the production VM. The Mini App browser check used a real canary bearer and simulated Telegram UI adapter, not a real Telegram-client authentication session.

Reproduction: `scripts/verify-deployed-native-login.ts`, `scripts/verify-deployed-request-agent.ts`, `scripts/verify-deployed-backup.ts`, and `scripts/verify-deployed-recovery.ts`. The public synthetic site is defined by `scripts/native-login-cloudflare-fixture.ts`. The complete witness gate is `scripts/witness-connectors.sh`; preserve the private backup key as described in `docs/aiko-cloud-backup.md`.

## Pending Connect recovery fix

The reported LinkedIn failure was reproduced with a persisted private target ID after its browser tab disappeared. Native form/view reads now reopen a confirmed-missing target, and retry a stale CDP connection once; credential and interaction requests are never replayed against a replacement page. The deployed Codegraff check loaded LinkedIn username/password fields, restarted the runner, and loaded the fields again at the next pending revision, without submitting credentials. Evidence: `artifacts/connectors/pending-login-recovery.json`. Validation: 57 focused tests, 661 full-suite tests (nine environment-gated skips), two real-browser tests, and agent typecheck passed.


### CloakBrowser in the existing Codegraff VM (2026-09-07)

The deployed trusted runner now installs and verifies CloakBrowser community build `146.0.7680.177.5` using the existing `@unbrowse/browser-harness/install-cloakbrowser` integration. The installer is uploaded through Codegraff's file API and downloads the pinned vendor archive inside the VM; its signed manifest, archive digest and complete extracted file tree must all verify. The linked browser-harness installer now accepts a trusted installation directory so the binary lives under `/home/daytona/aiko/native/`.

The driver uses a stable per-owner fingerprint and a separate `browser/profile-cloak` profile. The existing profile was written by Chromium 152 and remains intact rather than being opened by an older browser. The private proxy, credential vault and request transport remain in the normal driver path. Binaries are regenerated during provisioning; existing encrypted vault backups continue to supply session recovery.

Live evidence: `artifacts/connectors/cloakbrowser-vm.json` confirms the existing owner VM is running the CloakBrowser executable, LinkedIn's username/password form loads through the private runner, and the Chromium 152 profile remains intact. `artifacts/connectors/cloakbrowser-session.json` confirms a synthetic login, authenticated request after browser restart, stable launch fingerprint and a separate profile. No real credentials were submitted.

Validation: 58 browser/Codegraff tests, 24 native login/vault tests and 5 CloakBrowser integrity tests passed; agent and Cloudflare deployment typechecks passed. Deployment used an isolated checkout of `6f8311e3` plus the browser change because unrelated work was in progress in the shared checkout. Shared installer changes are in the linked `/home/deck/work/unbrowse-playground/runtime` repository.

The first deployed test-sandbox upgrade returned 409 after leaving a new runner with a missing CloakBrowser directory. Upgrade installation now runs from `install/runner.js` before closing and atomically replacing the installed runner. A regression test interrupts the download and verifies that the previous runner/version remain available and that retry verifies assets before publication.

Final deployed Connect check passed at `2026-09-07T14:02:20.465Z`: LinkedIn form fields loaded, the trusted runner was restarted, and the form recovered at revision 2. The disposable test connection was disconnected. Evidence: `artifacts/connectors/cloakbrowser-deployed-connect.json`.

### Automatic CloakBrowser provisioning in new VMs

A fresh Codegraff VM was created through the same `CodegraffSandbox` provisioning path with the deployed runner and bootstrap. CloakBrowser installed automatically and its running executable was verified. Public navigation, screenshot capture, stop/start, and browser-directory persistence passed. Provisioning ran exactly once: one allocation, one bootstrap, one native installation. Cold readiness took 46.9 seconds; restart readiness took 7.8 seconds. The disposable VM was deleted after verification. Evidence: `artifacts/connectors/cloakbrowser-fresh-sandbox.json`. The reusable `scripts/probe-codegraff.ts --browser-fresh` check now explicitly asserts CloakBrowser as the default and verifies its running process.
