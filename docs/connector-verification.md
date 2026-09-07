# Connector login, agent memory and backup verification

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
