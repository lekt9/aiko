# AGENTS.md adherence audit

Audited 2026-09-08. **15 confirmed findings: one P1, thirteen P2, one P3.** The largest gaps concern predictable recovery, preserving work, truthful outcomes, and completing the journeys the product exposes. These are behavioral findings against [AGENTS.md](../AGENTS.md), not preferences about visual style.

P1 means fix before activating the affected capability. P2 means a concrete correctness or workflow issue to prioritize. P3 means documentation drift with lower immediate impact. The P1 affects the optional vault service, not Aiko's separate hosted browser engine.

## Implementation follow-up — 2026-09-09

The original findings below describe the audited pre-fix behavior. The follow-up implements the corresponding recovery and boundary changes in the shared working tree; it does not deploy them. Concurrent work supplied additional fixes and tests, which were preserved and checked.

| Findings | Result and maintained evidence |
| --- | --- |
| BND-1 | HTTP recipes seed each cookie at its own validated host and path. [Multi-domain recipe tests](../tests/backend/recipes.test.ts) cover same-name cookies and returned domains. |
| BND-2 | Ordinary synchronization requires a ready, verified, current-generation session before and after verification. Revoked/stale sessions need explicit owner recovery. [Runtime transaction tests](../tests/backend/runtime-status.test.ts) and [HTTP recovery tests](../tests/backend/http.test.ts) cover revocation races and owner import. |
| BND-3 | Hosted login imports share a 500-row/1-MiB UTF-8 JSON limit across preview, proxy, account handler and engine. [Joined import tests](../apps/agent/test/login-import-boundaries.test.ts) verify full-size batches, overflow and account isolation. Other request limits remain scoped to their routes. |
| BND-4 | One SDK deadline covers credential lookup, transport and response consumption; late credentials cannot dispatch cancelled writes. [SDK tests](../tests/aiko-sdk.test.ts) include actual loopback stalls and response-reader cleanup. Cancellation cannot retract an already-dispatched server action. |
| UI-1 | Secretary request lifetime follows the account mount, with stable transport and preserved capture identity/drafts. [Browser recovery checks](../apps/web/test/ui-recovery.browser.py) cover parent polling, late reads and failed captures. |
| UI-2 | Transient database reads preserve drafts and pause writes. Denied reads clear protected state. Explicit discard occurs only after a successful refresh and resets editors even at unchanged row revisions. [Database journey](../apps/web/test/database-artifact.browser.py) and [recovery journey](../apps/web/test/ui-recovery.browser.py) cover both distinctions. |
| UI-3 | Discoverable approval navigation preserves work and private-login input; account-scoped promise decisions stay mounted through navigation. [Recovery checks](../apps/web/test/ui-recovery.browser.py) cover focus, polling, failed decisions and combined queues. |
| UI-4 | Console submission retains the original text/ID for explicit uncertain-result recovery and preserves newer drafts. [Console regressions](../apps/agent/test/console.test.ts) and the browser recovery journey execute the shipped script. |
| RUN-1 | Authenticated owner review now reaches frozen promise payloads through the Mini App, proxy and both host APIs. Exact hashes, scope, origin and operator restrictions apply at the handler. [API tests](../apps/agent/test/promise-api.test.ts), [Worker-host tests](../apps/agent/test/promises-host.test.ts), [local-host tests](../apps/agent/test/promises-local-host.test.ts) and [UI contract tests](../apps/web/test/promises.test.ts) cover the path. |
| RUN-2 | Frozen promises use the existing native execute/tool receipt continuation and persisted deadlines. [Promise tests](../apps/agent/test/promises.test.ts) and host tests cover yielded tools, restart, expiry and authority changes. Legacy started executions and uncertain effects remain consumed. |
| RUN-3 | Observed-action consent binds the native invocation, owner and thread: exact replay retains its immutable preparation while a new intent gets new consent. [Observed-network tests](../apps/agent/test/observed-network.test.ts) cover expired/consumed replay and conflicting inputs. |
| RUN-4 | A potentially dispatched write with lost/error response or lost settlement remains unknown and cannot silently resend. [Observed-network tests](../apps/agent/test/observed-network.test.ts) verify one remote effect across receipt loss and replay. |
| DOC-1 | [Evidence capture](../scripts/verification_evidence.py) records actual command exits, source identity, execution times and artifact hashes; [rendering](../scripts/write-verification.py) rejects stale, changed, mixed or failing evidence, including with Python optimization enabled. [Regression tests](../scripts/verification_evidence_test.py) preserve the historical report on rejection. |
| DOC-2 | Default E2E now [runs](../scripts/aiko-ui-qa.mjs) native sign-in, database, secretary and recovery journeys in isolated Chromium/local hosts. [Hosted CI](../.github/workflows/hosted.yml) invokes the same suite. Failures remain failures; run-specific evidence and owned-process cleanup prevent stale passes and process leaks. Gateway and legacy-demo checks remain separately named. |
| DOC-3 | [README](../README.md#storage-and-security-boundary) now distinguishes live proxied endpoints from fixture-only 404s and labels vault/CSV results historical. |

Integration verification and limits are recorded in the follow-up evidence under `artifacts/agents-principles-fixes-2026-09-08/`. These local checks exercise synthetic data and actual local runtimes; they do not establish deployed provider readiness, live Telegram behavior or comprehensive accessibility certification. The original bug-expecting reproductions remain historical evidence and must not be used as passing regression checks.

## Scope and limits

Three independent workers reviewed the interface, agent runtime, and service/SDK boundaries. The primary agent reviewed documentation and verification. The primary agent independently checked worker findings and reran their focused reproductions; the interface reviewer independently checked the primary agent's findings. The dependency graph joined these four reviews into verification and report stages.

Coverage included live connector onboarding, database views, secretary controls, the local/hosted console, promises and learned writes, foreground/background delivery, approval handling, vault authorization and session custody, SDK transport, import boundaries, and documented verification commands. Historical demo behavior was distinguished from current hosted paths. The JSON evidence below describes inspected areas in more detail, including areas with no additional finding.

This was a bounded source audit of the working tree, including existing changes. Other work continued during the audit. It is not a frozen release assessment or an exhaustive security/accessibility certification. No production provider calls, real credentials, deployments, PostgreSQL integration run, actual browser journey, full build, or full test suite were used. UI reproductions execute source with simulated hooks/JSX or DOM objects; they are not React DOM/browser tests. No application fixes were made by this audit.

## Findings

### BND-1 · P1 · HTTP recipes send host-only cookies to the wrong host

**Where:** [apps/server/src/recipes.ts](../apps/server/src/recipes.ts#L133), lines 133–150. **Scope:** optional vault service, HTTP recipes with multiple allowed domains.

The cookie validator admits each cookie's original domain, but jar construction omits `Domain` for host-only cookies and inserts every cookie against the recipe's primary origin. This rebinds a secondary host's cookie to the primary host. A synthetic request to `service.test` received the host-only cookie belonging to `secondary.test`; the returned jar also rewrote its domain.

**Rule violated:** explicit ownership/boundaries and trustworthy behavior. **Fix:** seed cookies against their own validated host and path while retaining the fixed request origin. Add a multi-domain test proving both transmission scope and returned domains. Reproduced with MockAgent and network disabled; no live cookie disclosure was attempted.

### BND-2 · P2 · Normal sync can restore a revoked vault session

**Where:** [apps/server/src/runtime.ts](../apps/server/src/runtime.ts#L348), lines 348–414. **Scope:** optional vault service, an otherwise still-authorized runtime holding old destination cookies.

Revocation writes a tombstone and retrieval correctly refuses it. Normal `sync`, however, checks the supplied revision without rejecting the revoked status or stale generation, then publishes a ready session. The reproduction revoked revision 1 into revision 2, read the new revision, and synchronized the retained cookies into a retrievable revision 3 without owner recovery.

**Rule violated:** preserve control and enforce recovery boundaries where actions execute. **Fix:** reject revoked/stale sessions in normal sync; retain the explicit owner recovery path and publication fences. This is not a cross-account authorization bypass. The HTTP/SDK/Runtime reproduction used in-memory SQL, cipher, identity, and provider doubles.

### RUN-4 · P2 · A lost write response becomes a definite failure

**Where:** [apps/agent/src/observed-network.ts](../apps/agent/src/observed-network.ts#L504), lines 504–532.

The learned-write callback maps every non-completed transport result to `failed`. Transport loss after a POST can therefore persist an approval as settled/failed even when the provider committed the change. The reproduction simulated one remote commit followed by response loss; both the returned receipt and durable approval said failed.

**Rule violated:** distinguish failure from uncertainty and report reality accurately. **Fix:** carry dispatch/response evidence through settlement and use `unknown` when a write may have happened. Preserve the existing consumed-approval fence. No automatic replay was demonstrated; the problem is misleading evidence for later decisions.

### UI-1 · P2 · Routine polling can leave secretary controls stuck

**Where:** [apps/web/src/components/secretary-work-panel.tsx](../apps/web/src/components/secretary-work-panel.tsx#L98), lines 98–132; caller in [connector-onboarding.tsx](../apps/web/src/components/connector-onboarding.tsx#L221).

The parent recreates `request` on each render, including ordinary approval-poll updates. The secretary effect depends on that function and aborts the old controller. An in-flight work action uses the same controller, but its `finally` skips clearing `busy` after abort. Controls remain disabled after the replacement read succeeds, with no useful recovery message.

**Rule violated:** understandable progress, completion, and recovery. **Fix:** stabilize the account request callback, separate operation lifetime from routine renders, and release/reconcile aborted work on a still-mounted panel. Confirmed by source trace and an offline hook/effect reproduction.

### UI-2 · P2 · A temporary database refresh failure erases drafts

**Where:** [apps/web/src/components/database-artifact.tsx](../apps/web/src/components/database-artifact.tsx#L138), lines 138–165 and 189.

Successful refreshes respect dirty drafts, but any refresh error calls `setData(undefined)`. Polling continues while the person edits, so one network/5xx failure unmounts the entire editor and loses its local field/new-record state. The offline reproduction confirmed the provider/renderer disappears even with a dirty field.

**Rule violated:** preserve user input on recoverable failures. **Fix:** retain drafts and the mounted editor on transient failures, show stale/unavailable feedback, and offer retry. Handle confirmed revocation separately by clearing protected data; keep reauthorization active. Child draft loss follows from the unmount and local state; no browser test was run.

### UI-3 · P2 · Incoming approvals replace unrelated work in progress

**Where:** [apps/web/src/components/connector-onboarding.tsx](../apps/web/src/components/connector-onboarding.tsx#L467), lines 467–520.

When polling discovers an approval, an early return replaces the whole drawer with approval cards. This unmounts secretary drafts and the native sign-in panel. Secretary input lives in child state; sign-in cleanup aborts its request and resets the form. Approving or rejecting returns newly mounted panels, not the interrupted work.

**Rule violated:** proportionate feedback, control, and preservation of work. **Fix:** expose approvals through an explicitly opened review surface while retaining the current task, or preserve drafts and a return path. Do not discard credential-clearing safeguards. Confirmed through the polling/render/cleanup source trace, not a live browser reproduction.

### UI-4 · P2 · Completing a send clears a newer console draft

**Where:** [apps/agent/src/console.ts](../apps/agent/src/console.ts#L15), composer handler on line 15. This HTML is served by both local and Cloudflare entry points.

Only the Send button is disabled while submission awaits a response. The person can type another message, but success unconditionally clears the textarea. Executing the actual script with a deferred response confirmed that the first message was sent and the second unsent draft disappeared.

**Rule violated:** preserve input and account for the surrounding workflow. **Fix:** capture the submitted text and clear only if the composer still contains that text. Bind the pending message ID to its original payload so a changed draft cannot accidentally become a retry of that message.

### BND-3 · P2 · Accepted login imports exceed both HTTP-layer limits

**Where:** [apps/web/src/server/connector-proxy.ts](../apps/web/src/server/connector-proxy.ts#L101), line 101; [apps/agent/src/connector-api.ts](../apps/agent/src/connector-api.ts#L61), lines 61–63.

The live preview and import engine allow up to 500 ready rows. The proxy limits this request to 16 KiB, and the account handler imposes a smaller 8 KiB limit. A 300-row preview accepted 24,280 bytes that the proxy rejected with 413. Even 130 short rows (10,340 bytes) failed at the account handler with 409 before import execution.

**Rule violated:** complete the onboarding journey and keep contracts/errors consistent. **Fix:** share an import-specific bounded size policy across preview, proxy, and handler; report capacity errors clearly. Keep smaller limits for other operations. Reproduced against real preview/handler code with synthetic rows and a stub engine.

### RUN-1 · P2 · Approval promises point to a missing user journey

**Where:** [apps/agent/src/promises.ts](../apps/agent/src/promises.ts#L591), line 591; hosted mounting in [cloudflare.ts](../apps/agent/src/cloudflare.ts).

The hosted actor exposes approval-conditioned promises and tells the owner to approve from a Mini App promises screen. The service has a decision method, but no host caller or corresponding UI/proxy route was found. Existing browser and observed-action approval handlers resolve different records. The unit test resolves promises directly through the service.

**Rule violated:** wayfinding and ownership of the complete journey. **Fix:** connect authenticated owner decisions to a reachable review surface, or reject this unsupported condition with an actionable explanation until it is wired. Preserve pending records for recovery. Confirmed by static registration/caller/route review; no deployment assertion.

### RUN-2 · P2 · Promises stop at the first yielded tool call

**Where:** [apps/agent/src/promises.ts](../apps/agent/src/promises.ts#L691), lines 691–716.

Execution invokes one sandbox segment and ignores its yielded calls. A normal `await tools.call(...)` yields a continuation with `settled=false`; the promise is then recorded as unknown without invoking the tool or resuming the segment. A real local segment runner and in-memory account host reproduced exactly one segment, one unexecuted call, and terminal unknown state.

**Rule violated:** complete accepted work and distinguish execution states accurately. **Fix:** reuse the durable harness path that authorizes calls, records results, and resumes segments. Until available, reject unsupported package-dependent promises rather than accepting tasks that cannot execute.

### RUN-3 · P2 · Repeating a legitimate action cannot obtain fresh consent

**Where:** [apps/agent/src/observed-network.ts](../apps/agent/src/observed-network.ts#L472), lines 472–480; [action-approval.ts](../apps/agent/src/action-approval.ts#L124), lines 124–129.

Approval IDs depend only on the action and inputs, but each preparation creates a new expiry. The approval service correctly refuses to bind the same ID to changed immutable content. After one request, later identical requests therefore conflict instead of getting fresh consent. The reproduction completed a write, advanced time ten seconds, and observed rejection for a new request.

**Rule violated:** recoverability and explicit task identity. **Fix:** distinguish a new user intent from replay of the same preparation. New intents need fresh approval IDs; replay must retain its original payload/expiry. Keep completed and unknown attempts consumed to prevent silent retries.

### BND-4 · P2 · SDK cancellation cannot interrupt token lookup

**Where:** [packages/sdk/src/aiko.ts](../packages/sdk/src/aiko.ts#L99), lines 99–116.

The client awaits its async token provider before creating the deadline or combining the caller's abort signal. A stalled token refresh blocks the method indefinitely. With a 5 ms timeout and a never-resolving synthetic token callback, `status()` was still pending after 40 ms; no fetch occurred.

**Rule violated:** bounded, understandable asynchronous work and reuse of established behavior. **Fix:** wrap token lookup and dispatch in one cancellable lifecycle, as the existing shared SDK transport does. Check abort before dispatch so a late token cannot start a cancelled write. Timeout was reproduced; explicit cancellation was traced statically.

### DOC-1 · P2 · Report generation can relabel stale/failing evidence as current

**Where:** [scripts/write-verification.py](../scripts/write-verification.py#L6), lines 6–23 and the final `verifiedAt` record.

The generator checks success snippets and extracts HTTP passed counts without rejecting failed counts or requiring a shared revision/run identity. It then labels generation time `verifiedAt`. An isolated synthetic repository with artifacts dated 2000-01-01 and two HTTP reports containing `failed: 5` still produced a report claiming passing checks with today's verification timestamp.

**Rule violated:** evidence-based decisions and truthful verification. **Fix:** require structured exit/failure results and source/run provenance; distinguish execution time from report-generation time. The separate browser runner checks freshness, but direct report regeneration bypasses that check. This reproduction does not establish that real historical tests failed.

### DOC-2 · P2 · Default E2E coverage misses current core journeys

**Where:** [scripts/aiko_app_qa.py](../scripts/aiko_app_qa.py#L12), lines 12–51; dispatch in [package.json](../package.json).

Both default E2E commands run the landing-page suite: layout/accessibility, SDK disclosure, disabled demo routes, and Telegram navigation. They never exercise the live connector or database flows rendered by that page. The checked-in hosted CI workflow also omits those UI journeys.

**Rule violated:** verify meaningful behavior across the whole journey. **Fix:** refresh and wire existing connector/native-login/database fixture scenarios into the standard checks. Targeted browser scripts and connector deployment verifiers already exist; this is an integration/scope gap, not absence of all tests. No E2E pass was claimed during this audit.

### DOC-3 · P3 · The README contains a stale production API boundary

**Where:** [README.md](../README.md#L108), line 108; historical verification language at lines 139–145.

The README says the catch-all API returns 404 in production, while its implementation forwards selected live routes before the demo guard. AGENTS.md already notes this contradiction. Later verification text also calls old vault/CSV evidence current, despite default E2E selecting Aiko. An earlier historical-path disclaimer mitigates that second ambiguity but does not correct the API statement.

**Rule violated:** maintain accurate memory and understandable system boundaries. **Fix:** scope 404 behavior to fixture routes, document the live proxy, and date/label historical verification. The proxy still checks route/origin/authentication shape and forwards caller credentials; this finding is not an authentication bypass or proof that old counts were false.

## Verification

**11 issue reproductions confirmed the reported behavior:** three UI simulations, three runtime tests, four boundary scenarios, and one report-generator scenario. The primary agent independently reran all three worker reproduction files. The UI reviewer independently reran the primary agent's report-generator scenario. The four remaining findings use explicit source traces.

**40 existing focused tests passed:** 24 across promise/tool-workflow suites and 16 across HTTP-recipe/web-proxy suites. Those passes do not contradict the findings: the reproduced cases were outside their coverage. No full-suite or deployed verification is claimed. The boundary reproduction initially failed under Bun due to MockAgent compatibility; the successful run used Node 24 and the installed TypeScript loader.

Reproduction commands from the repository root:

```sh
node artifacts/agents-audit-2026-09-08/ui-repro.cjs
bun --no-env-file test artifacts/agents-audit-2026-09-08/runtime-repro.test.ts
TSX_DISABLE_CACHE=1 node --import ./apps/server/node_modules/tsx/dist/loader.mjs artifacts/agents-audit-2026-09-08/boundaries-repro.ts
python3 artifacts/agents-audit-2026-09-08/docs-report-repro.py
```

These checks assert that the bugs reproduce; their passing status does not mean the implementation is fixed.

Local evidence: [area reports and reproductions](../artifacts/agents-audit-2026-09-08/), [independent verification records](../artifacts/agents-audit-2026-09-08/verification.json), and [documentation cross-review](../artifacts/agents-audit-2026-09-08/docs-review.json). Artifacts are gitignored local audit material. The execution graph is in `.claude/jesus-graph.local.json`; prior completed graph state was archived in the evidence directory. Its completion gate checks report coverage, independent review, source hashes, and report integrity. It measures completion of the audit, not resolution of these issues.

## Suggested fix order

1. Before using the optional custody service, correct cookie host isolation and session recovery boundaries (BND-1, BND-2).
2. Restore truthful outcomes and protect work in progress (RUN-4, UI-1 through UI-4).
3. Finish exposed onboarding and promise capabilities, and restore fresh-consent and timeout behavior (BND-3, RUN-1 through RUN-3, BND-4).
4. Make those journeys part of standard verification and keep evidence/documentation accurately scoped (DOC-1 through DOC-3).
