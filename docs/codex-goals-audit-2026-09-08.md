# Codex goals audit — 8 September 2026

## Addendum — 9 September 2026

The two stale results in this audit are now superseded on the current tree; the original checkpoint text below is preserved as history.

- The default E2E gate **passes**. Two receipts from 2026-09-08 17:48/17:49 UTC under `artifacts/aiko-ui-qa/` and a fresh contract-verified run (`pnpm test:e2e:aiko`, 2026-09-09) show browser-init, connector-build, native-login, **database**, secretary-work, ui-recovery and browser-cleanup all passing. Remaining-work item 1 (database test entry) is closed: the "Use an account access token" disclosure is present in `DatabaseWorkspace` and both browser journeys enter through it.
- `pnpm typecheck` **passes** again. The untracked in-progress `apps/agent/test/native-replay.test.ts` typed its empty `layersFor` against Effect 4's contravariant `Layer` ROut parameter (`Layer.empty as Layer.Layer<unknown>`); the suite passes 4/4.

Remaining-work items 2–6 are unchanged: they still require their owners, live-provider or protected witnesses, or an explicit decision on exhausted budgets, and remain out of scope for local implementation.

## Outcome

**Six of nine recorded goals remain non-complete.** This audit closed the outstanding outer-Worker promise authorization gap and verified its regression coverage. It did not complete the larger browser, memory, database, cognition or release plans.

The latest checks pass **54 promise/approval/network tests**, workspace types, Worker types, an offline native CLI memory witness and actual local workerd restart/isolation checks. The default UI gate remains **failing**: its database fixture expects a sign-in control that `/connect` no longer offers. Self-composition and browser-events full acceptance also remain blocked.

### Scope and provenance

- Inventory started **2026-09-08 23:29 +08:00**; continuation checks ran on **2026-09-09**. “Today’s Markdown” means the original 8 September inventory, not files subsequently dated 9 September.
- Read-only Codex metadata identified **63 exact-cwd threads and nine goals**: four active, one blocked, one usage-limited and three complete. A read-only refresh of those nine rows at 01:04 +08:00 found unchanged statuses. No goal database was modified.
- Inventoried **47 modified Markdown files and 1,027 source hashes**, then checked relevant requirements, current source, callers, tests and recovery handoffs. This is not an exhaustive all-files audit of Unlock or upstream Tardigrade.
- Evidence: [`artifacts/goals-audit-2026-09-08/`](../artifacts/goals-audit-2026-09-08/), including `starting-inventory.json`, `codex-goal-inventory.json`, `codex-goals-resumed.json`, `closing-checks.json` and `ending-inventory.json`. These are **gitignored local evidence**, not portable published receipts. Missing artifacts require a rerun, not assumed success.
- The shared worktree and HEAD changed under other sessions. Closing checks record observed source drift; promise checks also retain the executed Worker bundle and source map. Neither unchanged tracked inputs nor a compiled fixture freezes every installed dependency or attests the whole current repository.
- This audit made no commits, deployments, new worker/recovery launches, personal sign-ins, real message sends, provider subscriptions, paid evaluations, budget changes or acceptance-pin refreshes. Other sessions’ edits and historical failures were preserved.

## All nine goals

Short thread IDs identify the full sanitized records in the local inventory. **Recorded status is metadata, not independent completion evidence.**

| Thread / recorded status | Goal | Verified interpretation and remaining boundary |
| --- | --- | --- |
| `01a08081` · active | [Browser events and reusable tools](browser-events-and-reusable-tools.md) | Native ingress, watches, action adapters and saved-tool slices have substantial local evidence in [the ledger](browser-events-status.md). Genuine subscribed push, the complete hosted browser-to-action/tool-revision journey, provider continuity and full private-copy/retention/restore coverage remain open. The audited full gate refuses the absent production browser verifier. Active browser ownership was not duplicated. |
| `01a07ae4` · active | [Self-composing harness](self-composing-harness-plan.md) | Current gate: **0 satisfied / 187 blocked; all 25 parents blocked**. Twenty outcomes stop at changed source pins; 167 lack registered evidence. This is not 187 reproduced runtime bugs. [Independent learning proofs](self-composing-harness-status.md) establish bounded process/restart slices, but S21.C04 retained-log deletion, the joined S21 parent and remaining full outcomes are incomplete. Memory/host integration remains separately owned. |
| `01a07fe7` · active | [Cognitive behavior](aiko-cognitive-behavior-plan.md) | Recovery, receipt reconciliation, procedural-transfer checks and proactive waits have local mechanism evidence. [Current status](aiko-cognitive-behavior-status.md) retains incomplete task association, broader recovery/repair, independent protected families and autonomous quality/cost comparisons. Recovery development reached its **120-execution budget**; a new directory cannot reset it. The continuation also records an unresolved shared outbox owner-projection probe; final coordinated verification remains necessary. No protected or paid comparison was run here. |
| `01a07f5d` · active | [Structured databases](structured-databases-design.md) | Native records, artifacts, mapped edits, staged/manual refresh and recovery pass focused tests. [The full ledger](structured-databases-status.md) still requires evaluation-scoped transient custody, lifecycle/scheduling, remaining bridge and causal invalidation, source membership, resumable subscriptions and archive/restore. Fresh UI verification is blocked at the stale fixture entry described below; earlier browser passes remain historical. |
| `01a07cb2` · blocked | Fix intermittent/missing replies and audit native Tardigrade usage | Reply/typing/preparation fixes have fresh focused checks; actual local workerd preserves one reply over two restarts and duplicate acceptance. The [runtime audit](aiko-tardigrade-audit.md) still does not establish exhaustive upstream coverage or a consistently responsive live user journey. Its frozen **1,495-pass** candidate is not evidence for this later shared tree. |
| `01a07656` · usage_limited | Primary native code-mode harness, scoped sandboxes/workers/workflows | Later implementation and [native parity evidence](native-harness-parity.md) cover much of this older goal. [Gateway](aiko-gateway.md), custody and saved-workflow contracts should be reused, not rebuilt merely because metadata remains open. A matched current full regression/release and the original end-to-end outcome were not established by this audit; no deployment authority was inferred. |
| `01a07f64` · complete | CodeGraff-derived native parity and browser indexing | The old [gap audit](codegraff-gap-audit.md) explicitly points to the subsequent [21-requirement implementation matrix](native-harness-parity.md). Treat the old gap list as a baseline, not 21 still-missing features. Local implementation evidence does not establish arbitrary provider compatibility or deployment; the full matrix was not independently rerun here. |
| `01a07c97` · complete | Portable hosted operation rather than dependence on this machine | [Hosted architecture](aiko-hosted.md) and the SDK/account boundaries exist. The fresh local workerd check verifies persistence, reply recovery, isolation and read-only scope. It does not establish a production backup, remote VM restore, fresh deployment or complete account-loss recovery. |
| `01a07bc5` · complete | Password-provider reference passing | [Password-manager connections](password-manager-connections.md) documents private host resolution, OAuth/reference custody and renewal boundaries. Recorded completion is not live-provider proof: live Zoho consent/unlock remains explicitly unverified. No real vault was connected and this full provider suite was not rerun here. |

## Fix completed by this audit

**Person/task:** an account owner reviews and approves a frozen promise. An operator credential must not inspect or decide that owner’s promise, or create account work while being rejected.

**Reproduction:** the inner [`promiseApi`](../apps/agent/src/promise-api.ts) already denied operators, but [`cloudflare.ts`](../apps/agent/src/cloudflare.ts) resolved their compatibility owner (`local`) first. The actual Worker-entry fixture threw `Foreign account`, returning **503 instead of 403**, before the inner guard could run. Preserve `promise-host-resumed-before.log` and `promise-host-alias-before.log` as the failing evidence.

**Smallest fix:** reject an operator at the outer `/api/promises` or `/v1/promises` route boundary, including subroutes, before owner resolution, registry admission and account lookup. This follows the existing owner-only consent policy; it grants no new authority and changes neither frozen payloads nor execution identity. Keep the inner guard as enforcement at the account API boundary.

[`promises-host.test.ts`](../apps/agent/test/promises-host.test.ts) now checks both list aliases, both decision POSTs and `?account=` requests. Rejected operators add **zero account lookups, admissions, code segments, model calls or external calls**. Existing owner review, exact-hash/scope/origin rejection, native tool continuation, account reopen and no-duplicate assertions remain. The final run also includes another owner’s response-receipt regression; that change is not attributed to this audit.

The fixture initially could not resolve installed `@json-render/core` while bundling the Worker. Its existing dependency resolver now resolves that real package from its protocol-package owner, alongside Effect and Zod. No mock, new dependency, lockfile change or runtime timeout increase was introduced.

**Review:** the guard covers exact route segments rather than similarly named routes, preserves owner/read-only behavior and stops before stateful routing. The test exercises production authentication/routing/execution with adapted platform storage. It runs on Bun, **not real workerd**; the separate workerd witness below covers reply/account behavior, not this promise journey. Recheck both boundaries whenever promise routing or operator identity changes.

## Fresh checks and their limits

Rows are separate invocations and **must not be added together**: several suites overlap. Earlier checks sampled earlier shared source; closing checks do not retroactively revalidate them.

| Check / local evidence file | Actual result | Boundary |
| --- | --- | --- |
| Promise/approval/network group · `promises-closing.log` | **54 pass, 0 fail, 343 assertions**, five files | Supersedes the earlier 53-pass/334-assertion run. No change among the 1,027 observed starting inputs during this invocation; full executed Worker bundle retained in `promise-worker-closing/`. |
| `pnpm typecheck` · `typecheck-closing.log` | **Pass**, including protocol/SDK builds and root test types | Earlier login-contract and browser-watch fixture errors are retained but superseded. `scripts/verify-browser-events.ts` changed during this run; no atomic whole-tree claim. |
| Worker TypeScript · `worker-types-closing.log` | **Pass** | Separate Worker project; no observed starting-input drift during this invocation. |
| Native CLI · `native-cli-resumed-v2/result.json` | **Pass**, eight commands, restart verified, replay adds zero events | Existing `native-memory-witness.cell.yaml`; actual installed Tardie CLI, synthetic memory/citations, no paid calls. Not erasure/restore or default production-host enforcement. Server stopped. Initial invocation mistakenly supplied JSON text instead of an input-file path; that failure remains in `native-cli-resumed.log`. |
| `verify-portable-cloud.ts` · `workerd-resumed.log` | **Pass**, actual local workerd, two restarts, one retained reply, duplicate/isolation/read-scope checks | Zero provider calls; synthetic local DO/R2 storage, not deployment or live conversation quality. |
| Default E2E · `core-ui-resumed.log` | **Fail**: database; native-login, secretary-work, ui-recovery and cleanup pass | Full receipt: [`browser-results.json`](../artifacts/aiko-ui-qa/2026-09-08T17-04-29.408Z-64181/browser-results.json). Connector UI production bundle succeeds as a prerequisite. |
| Native login/render/host · `login-before.log` | **37 pass**, three files | Isolated private-login lifecycle, not personal Gmail or live SSO. |
| Runtime/reply/console/promise group · `runtime-before.log` | **111 pass**, seven files | Includes native typing/reply recovery; not provider latency or the full runtime suite. |
| Provider host lifecycle · `provider-before.log` | **22 pass**, one file | Controlled provider/platform edges, not genuine browser push. |
| Database store/component/bridge/hosts · `database-tests.log` | **122 pass**, seven files | Includes native Node and Worker-entry fixtures; no PostgreSQL service or real live-source request. |
| Cognitive regression group · `cognitive-tests.log` | **61 pass**, four files | Mechanism tests, not development-budget reset or a protected comparison. |
| Memory authority/erasure/restore group · `memory-tests.log` | **47 pass**, nine files | Controlled custody/host fixtures; not full log erasure or complete default-host/remote restore mounting. |
| Web Vitest · `web-tests.log` | **105 pass**, 12 files | Unit/contract tests, not all rendered journeys. |
| Root Vitest · `root-tests.log` | **141 pass, 61 skipped** | No dedicated PostgreSQL integration database configured by this audit; skips are not passes. This was not `pnpm test` in full. |
| Shared browser client · `browser-client.log` | **38 pass, 1 skip** | The physical browser case is unverified by this invocation. |
| Evidence validator · `evidence-tests.log` | **14 pass normally and 14 under `python3 -O`** | Same suite twice; refusal of stale/failing evidence survives optimized Python. |
| UI runner/HTTP serialization · `ui-runner-tests.log`, `http-smoke-tests.log` | **One pass each** | Failure/report cleanup and structured output; not real provider/browser acceptance. |
| Retained compute-media receipts · `compute-receipts.log` | **Five validated** | Existing frames, English, Spanish, silence and malformed-input receipts rechecked read-only. No new live compute execution. |
| Self-composition · `self-composition-resumed.json` | **Full completion false: 0/187 satisfied** | 20 changed-pin failures, 167 unregistered outcomes; all 25 parents blocked. Manifest validation and 22 gate self-tests pass, without changing criteria/pins. |
| Browser events · `browser-events-full.log` | **Full gate exit 1**, `contractSatisfied:false` | Missing `scripts/verify-browser-events-live.ts`; no production journey executed. Later browser-owner receipts remain separate evidence. |

**Not established here:** a full current agent suite, complete current Cloudflare build, frozen full-repository pass, protected autonomous-quality evaluation, production backup/deployment or live account journey. Passing types and a compiled Worker fixture cannot replace these checks.

## Reconcile Markdown without erasing history

- [The principles audit](agents-principles-audit.md) records **15 original findings**, not today’s unresolved count. Boundary owners report BND-1–4 repaired with isolated PostgreSQL/transport/import evidence; this audit did not repeat their PostgreSQL run. UI owners report UI-1/3/4 repaired; the fresh recovery journey passes. Database UI-2 has prior native-host browser evidence, but the current standalone database journey cannot enter its page. Promise RUN-1–4 have local API/native/consent/uncertainty evidence; this audit closes the missed outer-Worker guard. DOC-1–3 have validator, runner and README repairs, while the current UI gate correctly remains red. Source audit completion is not issue-resolution or release acceptance.
- [The compute canary introduction](compute-live-verification.md) retains an early exit-137 failure. Its **later final-bundle checkpoint** records five successful physical media cases and cleanup. The read-only receipt validator passes all five. Do not repeat “Python media remains unverified” as a blanket current statement, or extend those bounded samples to arbitrary media quality/current deployment.
- [Self-composition historical green slices](self-composing-harness-status.md) belong to their reviewed source graphs. Current changed pins invalidate acceptance without disproving every implementation. Do not refresh hashes just to obtain green or sum child reports into a parent.
- [The runtime audit’s frozen candidate](aiko-tardigrade-audit.md) and recovery workers’ passing copies are useful evidence of those bytes. Their full-suite/build/browser counts must not be transferred to later shared edits. Earlier type failures have now cleared, but neither that nor the fresh workerd pass closes live responsiveness.
- `/connect` currently requires a verified Telegram Mini App launch; bearer credentials remain valid for appropriate API/console paths, not that page’s sign-in UI. [Hosted entry instructions](aiko-hosted.md#open-the-connector-interface) take precedence over obsolete fixture interactions.

## Remaining work, owners and safe next steps

1. **Database owner: repair the isolated test entry.** [`database-artifact.browser.py`](../apps/web/test/database-artifact.browser.py) calls the removed “Use an account access token” disclosure at line 12; [`database-layouts.browser.py`](../apps/web/test/database-layouts.browser.py) has the same helper. Use current authenticated fixture setup, or a dedicated component entry retaining real host authorization. Preserve read-only, actual revocation, draft/CAS and unknown-command assertions. Do not restore obsolete production token sign-in. Then rerun the default UI gate and layout witness. This failure proves an entry mismatch, not a passing or failing database editor.
2. **Memory/integration owners: finish coordinated default-host authority and remote custody.** Helper/native-workerd success is not an all-writer mount. Follow the [exact host handoff](../.agent-grid/notes/recovery-20260908/pending-memory-host.md) and [backup boundary](aiko-cloud-backup.md): fresh exclusive owner/writer authority across awaited work; original-operation import/publication receipts; hold uncertain claims. Do not stage either remote restore mode without verified executor custody. Current shared implementation is moving; recheck it before applying any handoff hunk.
3. **Memory/proofs owners: preserve S21.C04’s strict red witness.** The latest independent fixed-source proof removes the memory observation/export payload but retains the synthetic deleted payload in `background-123-indexer` seq 6 (`AikoHookReceived`) and `background-123-reflection` seq 5 (`MessageReceived`). Suppressing notification/projection is insufficient. This audit did not rerun or weaken that protected proof; remediation and joined parent verification remain outstanding.
4. **Database/integration owners: implement the remaining full ledger**, especially transient result custody before fresh queries, causal bridge/lifecycle and consistent archive/restore. No parallel scheduler or memory store is justified by a mounting blocker.
5. **Cognition owner: preserve evaluation controls.** Complete the trusted task/receipt seams and reserved drivers, resolve the shared outbox projection with its owner, obtain independent protected authorship and an explicit decision before exceeding exhausted development budgets. Regression tests are not autonomous performance comparisons.
6. **Browser and release owners: complete genuine provider/human witnesses.** Push subscription/delivery, hosted browser-to-action and session-bound tool revision remain distinct from mocked push events or API fixtures. Private email-code/login steps require the owner; no automated replay of an uncertain sign-in/send is authorized by an old thread. A future release needs a new source-bound candidate, full feasible tests/builds, required environment prerequisites and separately authorized live checks.

Coordination and exact findings are in [`requests/goals-audit.md`](../.agent-grid/notes/recovery-20260908/requests/goals-audit.md). No other worker’s status was rewritten. Root `AGENTS.md` remains coordinator-owned; durable guard/fixture lessons are proposed in that handoff rather than edited concurrently.

## Reproduce the completed slice

From the repository root, with the existing pinned workspace dependencies installed:

```sh
TMPDIR=/tmp bun --no-env-file test \
  ./apps/agent/test/promises-host.test.ts ./apps/agent/test/promises.test.ts \
  ./apps/agent/test/promise-api.test.ts ./apps/agent/test/action-approval.test.ts \
  ./apps/agent/test/observed-network.test.ts
pnpm typecheck
pnpm --filter @unlock/agent exec tsc --noEmit -p tsconfig.cloudflare.json
TMPDIR=/tmp bun --no-env-file scripts/verify-portable-cloud.ts
TMPDIR=/tmp pnpm test:e2e:aiko
```

The last command was failing at this checkpoint. The existing native CLI cell takes a JSON **file path** for `--inputs`; use `empty-inputs.json` containing `{}` and a fresh output directory. The full self-composition/browser-events commands are documented in their linked ledgers; preserve their nonzero results and registrations until the original outcomes are actually verified.
