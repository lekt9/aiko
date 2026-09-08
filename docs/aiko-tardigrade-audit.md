# Aiko runtime and reply audit

Status: in progress. This document records verified findings and remaining work;
it is not a claim that the whole repository or production deployment is fixed.

## Objective and evidence boundary

Audit the complete Aiko integration against clavia-labs/tardigrade's components,
examples, runtime, persistence, and clients. Fix intermittent missing responses
and silent long-running work, preserving account isolation, history, cancellation,
and uncertain-delivery handling. Verify the resulting user experience rather than
only component shapes.

Sources checked:

- Installed `tardie@0.22.0`, including local patches in `patches/tardie@0.22.0.patch`.
- Upstream matching tag `v0.22.0`, commit `e5c7389a5cf77df3bb69ea49606dfcf5edc8941b`.
- Upstream main snapshot `9b6ce9d4ce58881e3903e2281975e2cf51a3ded2`.
- Release changes through `v0.22.3`, particularly child identity, atomic deadline
  cancellation, and retained active-drive fixes. These need compatibility review;
  newer examples are not automatically compatible with the installed version.
- Live control events inspected before this audit: an accepted video request,
  a script polling a reconstructed route instead of the returned status URL,
  repeated `sandbox_job` results with running state and empty output, and more
  than forty model calls in the same turn. No raw commands or credentials are
  copied into this report.

Upstream references:

- [Migration responsibilities and event rendering](https://github.com/clavia-labs/tardigrade/blob/v0.22.0/docs/how-to/migrate.md)
- [RLM component composition](https://github.com/clavia-labs/tardigrade/blob/v0.22.0/examples/rlm/actor.ts)
- [Pure component projections](https://github.com/clavia-labs/tardigrade/blob/9b6ce9d4ce58881e3903e2281975e2cf51a3ded2/docs/getting-started/concepts.mdx)
- [Durable webhook ingress](https://github.com/clavia-labs/tardigrade/blob/9b6ce9d4ce58881e3903e2281975e2cf51a3ded2/packages/host/src/transport/http/webhook.ts)
- [Active drive fix](https://github.com/clavia-labs/tardigrade/commit/c16a07c6c79a69ad608d0dd55e2ccafe958bc0ea)

## Findings and changes

### Working commentary was invisible

The native model action can contain working text alongside a tool call. Tardigrade
records that as `TextReturned`; it is distinct from `TurnCompleted.output`.
Upstream's application migration guide renders it as working text. Aiko's Telegram
pipeline generally waited for explicit send tools or its final outbox, so useful
commentary could remain internal while typing continued.

`channel-progress.ts` now consumes those native events and delivers working text
through keyed native effects, using the existing voice and sender boundaries.
Separate `AikoProgressStarted`/`AikoProgressSettled` receipts cannot complete the
final outbox or stop typing. Explicit message tools suppress the duplicate
commentary from the same model action. Recovery never retries a started send with
unknown outcome. Epochs, destination, original topic, redaction, and obsolete
commentary are covered by tests. The prompt describes this delivery behavior.

The code-harness wrapper independently removed commentary on `execute`, and the
workflow wrapper removed it after workflow results. Both now preserve redacted
working text. Real host tests verify Telegram progress precedes actual tool
execution for single and batched execute actions. The response wrapper also
redacts `respond` text inside native batches before recording their tool calls.

### Quiet fallback mode could suppress the final reply

`voiceAndOutbox` previously returned no transitions for some missing-answer,
no-result, and uncertain-browser outcomes when verbose diagnostics were disabled.
New requests now get a concise notice. Verbose diagnostics remain optional.
A keyed activation event is recorded only when a request is pending; old quiet
terminals remain quiet, and settled histories remain exportable.

### A projection could start another model turn

The outbox's `step` called a `nudge` callback, which submitted an operator message
from inside replay. This made reading/reconstructing state capable of running
external work, contrary to the component contract. The callback and reducer side
effects were removed. Terminal notices use the existing durable outbox. Reporting
occurs inside a native effect rather than during replay.

### Webhook timeout acknowledged unconfirmed persistence

The Cloudflare ingress returned HTTP 200 after eight seconds even if account
acceptance was still pending, leaving `waitUntil` to finish persistence. A Worker
termination or failed RPC could therefore lose a message Telegram considered
delivered. `telegramWebhookResponse` now returns success only for confirmed
accepted/duplicate results; timeout/failure returns 503 for a provider retry.
Stable update IDs make a late accepted request plus retry deduplicate normally.

### Unchanged job polls spent model calls

Every immediate `sandbox_job` response could trigger another inference with no
new evidence. The tool now waits inside one bounded native effect for a status
or output change, returning after at most its configured wait window. It never
resubmits the command. Abort interrupts waiting; explicit cancellation remains
available. Instructions direct scripts to use returned provider URLs, bound error
retries, and inspect unchanged work rather than blindly polling.

### Code mode duplicated the catalog and bypassed the configured budget

Aiko exposed the full native tool catalog directly and through `codeMode` at the
same time. Its optional budget wrapped only the direct tools, leaving `execute`
outside that boundary. The actor now keeps channel response tools direct and
makes ordinary capabilities discoverable through the code package. One optional
native budget wraps both execution branches. The production-actor test verifies
that the second over-budget execute does not dispatch another read. The default
remains uncapped when the host has not supplied a tool budget.

### Crash recovery overrode the native attempt bound

Aiko requested ten abandoned inference attempts instead of Tardigrade's default
three. The override was removed. This is a bound on abandoned physical attempts,
not a limit on normal multi-step tasks. A seeded crash history verifies that three
unanswered `ModelCalled` records produce a native failure and one visible notice
without opening another provider request.

### Deadline recovery

The custom Cloudflare host now uses the installed native alarm scheduling helpers
to replace expired recovery alarms. A due alarm and its native deadline
cancellation intents are appended together, preventing a blocked effect from
delaying cancellation until another reconciliation. A SQLite failure-injection
test verifies that both records roll back together and recover on the next alarm.

### A failed drive could wait behind a distant maintenance alarm

The production Worker's alarm error handler only scheduled a one-second retry
when `getAlarm()` returned null. A future maintenance alarm could therefore leave
failed native work waiting for that unrelated wake. The actual Worker fixture
reproduced this with a one-hour alarm and an injected native-drive failure.

The handler now uses native `armAt(current, now, 1000)`. It replaces distant or
expired alarms, preserves a sooner pending wake, and does not alter invocation
history. The Worker regression covers all three cases; 17 host and production
Worker tests pass (`/tmp/aiko-worker-recovery-alarm-fixed.log`).

### Remote process cancellation and truthful status

The native cancellation protocol aborts active effects, but a `sandbox_exec`
process may still be running after its launch tool has returned. The compute
component now derives native `cancelState` cleanup from the existing direct-tool
and code-tool dispatch receipts. Cleanup addresses the retained account/thread
job, is bounded to ten seconds, and settles before `TurnCancelled`. An uncertain
stop acknowledgement remains unknown and is not silently retried after restart.
Already-submitted external actions are not claimed to have been rolled back.
Cleanup receipts contain only status, never command output; completed-job and
lost-acknowledgement tests check this with a private-output sentinel.

The message APIs now use native `turnTerminalOf`/`turnEpochOf` when calculating
pending status. Previously a failed historical turn without `AikoReplyPrepared`
stayed pending forever; an old prepared reply could also hide a resumed turn.
Confirmed progress delivery appears in message history with its own ID, while
unknown sends do not appear as delivered text.

### Effect service requirements

The effect constructor's input type now includes the `concurrent` option already
supported by its interface and reconciler. This is persisted in the dependency
patch. The code-harness inference wrapper preserves its input layer's service
requirements, allowing worker inference to receive its native `EventLog` service.

Compaction now uses a history-specific context lookup. A retired model reference
is replayed under the smallest currently configured context window; it does not
grant permission to invoke that model. The exact routing/grant API still rejects
unconfigured models. A native `restingActor` replay test observes the retired
reference, completes without inference, and verifies invocation remains denied.

## What already follows the framework

Aiko uses native `infer`, `tool`, `codeMode`, `compaction`, `outputValidateOnce`,
the actor reconciler, thread driver, event keys, EventLog, Router, and epoch-based
cancellation. Its custom account Durable Object binds those services to one
account's storage. Replacing all of it with a new loop is not supported by the
findings so far. The explicit `respond` conversion takes another native runtime
step, but the next inference is short-circuited locally: the service-level test
with a controlled model records one model call, one final delivery, and no resend on restart.
It preserves final-media and uncertain-delivery semantics. Removing it merely to
copy the shortest upstream example is not justified by the response evidence.

Further upstream comparison:

- Native `output/boundary.ts` treats current-epoch terminals as authoritative;
  this directly informed the pending-status correction.
- Native component cancellation derives cleanup obligations before the terminal;
  the compute cleanup uses that contract rather than an abort-listener side effect.
- Native Telegram provider supports text/topic addressing; Aiko additionally owns
  rich media, voice preparation, and unknown-send receipts. Its custom adapter
  therefore remains necessary; it must still honor durable webhook acceptance.
- Native client streams separate durable event cursors from transient inference
  deltas and explicitly require polling when bearer-authenticated SSE is refused.
  Aiko uses its own authenticated control/message API and does not depend on that
  unauthenticated EventSource path.
- Upstream 0.22.1 child identity includes the parent coordinate. Aiko's current
  scoped package permits spawning only from `user-<owner>` and its host isolates
  account namespaces; nested spawning is denied. This reduces the known collision
  exposure, but the new worker-scope integration is changing concurrently and
  still needs its final compatibility review.

## Verification

Baseline: 83 tests passed across runtime, production, channel-response,
telegram-tools, and Cloudflare-host suites before edits. Logs are in
`/tmp/aiko-tardigrade-baseline.log`.

The focused regression tests exercise real native Bun and Worker-storage hosts,
not mocked component output alone. Covered cases include progress before tool
dispatch, final delivery, explicit progress deduplication, uncertain sends,
resumption, stale epochs, restart, old-history activation, migration export,
proactive claim fencing, webhook persistence timeouts, and bounded job waiting.
Final command results are recorded after the current verification pass.

Latest focused pass: 127 tests passed, zero failed across 10 matching files
(`/tmp/aiko-reliability-current.log`), including atomic deadline recovery. The
broader suite has additional provider-bridge timeouts and remains under review.
Subsequent passes: 27 browser/cancellation tests passed; 11 provider-bridge tests
passed in isolation; 56 response/Cloudflare-host/compute tests passed with native
cleanup and message-status regressions. Bun and Worker dry-run builds passed.
The constructor dependency type error was fixed. A later whole-agent typecheck
found a concurrently added worker fixture's digest type mismatch; see
`/tmp/aiko-reliability-types-final-turn.log`. Do not treat this as a green full suite.

The full agent suite was started as session `74293`, PID `2997728`, with output at
`/tmp/aiko-reliability-suite.log`. It included an English media-host timeout and
later provider/login/compute timeouts. It was deliberately stopped after verifying
its process identity, because it had loaded obsolete code before these changes
and concurrent integration edits. The log is retained; failed groups are being
rerun against current files. These results cannot establish a wholly green
worktree or a production fix.

Latest review and checks:

- Native cancellation and response/status: 41 tests passed after the cleanup
  receipt privacy review (`/tmp/aiko-final-cancellation-status.log`).
- Login-operation and compute-harness group: 14 passed
  (`/tmp/aiko-reliability-recheck-groups.log`).
- Native compaction/migration/proactive/model-routing group: 52 passed, one
  migration source-file digest test failed. Migration alone then passed all eight
  tests. Later diagnosis reproduced the same digest change by forcing Bun GC
  **before export ran**: deferred closed writable SQLite statements performed
  their final checkpoint. The fixture now forces finalization before its byte
  baseline and after export's readers close. The unchanged-byte assertion stays
  intact. All 53 combined compaction/migration/proactive/routing tests then passed
  (`/tmp/aiko-migration-gc-verified.log`).
- Worker-specific TypeScript check passed after explicitly retaining TextDecoder's
  default `ignoreBOM:false` for the installed Worker type definitions.
- Latest Worker dry-run artifact built at `/tmp/aiko-reliability-worker-end`.
- Whole-agent TypeScript still fails in concurrently added
  `src/coding-workspace.ts:74` (`string | undefined` supplied as `string`), as
  recorded in `/tmp/aiko-reliability-types-end.log`.
- Review covered event replay purity, account/thread/epoch scoping, duplicate and
  uncertain sends, native cancellation ordering, and receipt privacy. This is
  progress toward review, not approval of the entire changing worktree.
- Code/workflow commentary and native batch/response review: 50 tests passed
  (`/tmp/aiko-commentary-final.log`). Historical-model replay plus response and
  compaction: 33 passed (`/tmp/aiko-history-model-review.log`); the strengthened
  retired-reference assertion also passed (`/tmp/aiko-history-model-verified.log`).
- The coding-workspace invocation type error was fixed by requiring an owning
  turn before dispatch. Later whole-worktree checks still encountered concurrent
  additions outside the response changes (`/tmp/aiko-audit-types-current2.log`).
- Rendered console fixture runs on loopback port 4349, using only synthetic
  history and fixture authentication. Browser inspection is pending Chrome's
  remote-debugging approval as required by the installed browser-harness skill;
  no rendered/live-browser success is claimed.

No production restart, deployment, or user-chat test message has been performed.
Production latency, spend, and model-quality comparisons are not yet measured.

Additional cancellation and runtime-boundary verification:

- Background worker cleanup now participates in native cancellation obligations
  before `TurnCancelled`, matches the exact invocation epoch, and records only
  sanitized cancelled/unknown receipts. Both worker and retained compute cleanup
  have an enforced ten-second effect timeout. Worker/response/Cloudflare checks:
  53 passed (`/tmp/aiko-worker-terminal-final.log`); compute checks: 16 passed
  (`/tmp/aiko-compute-cleanup-bound.log`).
- A later Worker build exposed a shared configuration import pulling Bun SQLite
  storage into Cloudflare. Pure budget types/defaults now live in
  `src/model-budget-policy.ts`; the Bun storage module re-exports them for
  compatibility. The Worker dry-run then passed, producing
  `/tmp/aiko-native-audit-worker-fixed` (log with the same prefix and `.log`).
  Model routing, including budget enforcement, passed 23 tests in
  `/tmp/aiko-budget-policy-review.log`. These are scoped checks, not evidence
  that the entire concurrently changing worktree passes.

## Latest integration regression checks

Latest integration regression (2026-09-08): the commitments host fence used
`startsWith("AikoWork")`, which also matched `AikoWorkerGranted` and worker job
receipts. It silently rejected grants before native child dispatch, causing child
inference to fail with "Native worker authority is absent or revoked". Work keys
and the atomic append fence now require the capitalized Work event suffix, so
Worker/Workflow events reach their own policies. External ingress retains its
existing restrictive filter. The actual Bun worker execution, two cleanup cases,
commitment safeguards, response and progress group passed all 54 tests after the
fix (`/tmp/aiko-worker-prefix-fixed.log`); the prior run failed three worker tests.

The retained channel-management grant API also omitted `namespace`,
`parentOperation`, and `deadline`, although the newer atomic child-port admission
fence requires those lifetime fields. It now writes the same metadata as native
handler dispatch. Management fixtures retain the trusted grant before execution.
Channel custody/restart, registry, and lifetime fencing passed 62 tests after the
fix (`/tmp/aiko-channel-lifetime-fixed.log`). No admission or revocation check was
removed to obtain this result.

The memory crash witness now injects failure at the native `ToolReturned` append,
after the memory store commits. Throwing inside the tool no longer simulates a
process crash because the installed tool component captures ordinary defects.
All 11 memory tests pass, including exactly one historical memory observation
after cold recovery (`/tmp/aiko-memory-ack-crash.log`). The coding-worker fixture
now declares its native model selection; both completion-verification cases pass
(`/tmp/aiko-coding-model-fixed.log`). The whole-agent TypeScript check passed in
`/tmp/aiko-current-types5.log` before the subsequent channel changes.

A provider-channel test with several cold starts exceeded Bun's five-second
default; it passed all 27 assertions in 8.6 seconds with a 30-second bound. That
specific test now declares the bound. No production timeout was increased.

After the channel-lifetime fix, whole-agent TypeScript, the Bun production build,
and the Cloudflare Worker dry-run all passed (`/tmp/aiko-latest-typecheck.log`,
`/tmp/aiko-latest-node-build.log`, `/tmp/aiko-latest-worker-build.log`). The Worker
artifact is `/tmp/aiko-latest-worker-artifact`; it has not been deployed.

The release comparison also covered allocation changes in `018aca9` and the
interaction/runtime reorganizations in `061c10e` and `5293a60`. A blanket upgrade
would change record projection and host interfaces, not merely apply a response
fix. Retain the pinned release while verifying the targeted patch and custom
host changes against stored histories. The upstream normalized-usage correction
in `4954c95` is a separate accounting concern, not evidence of a typing-loop fix;
its effect on Aiko's usage reporting still needs an explicit compatibility check.

The broader per-file run is recorded incrementally in
`/tmp/aiko-isolated-regression-current/results.json`. Its failures, including
experiment and CPU-media cases, remain to be investigated; it is not a green
suite claim.
The live runner is exec session `27674`, most recently confirmed running after
82 of 148 files. It gives each file a separate Bun process and a 180-second
execution limit, which terminates that Bun process. Both `harness-video.test.ts`
and `media-host.test.ts` later reached that limit. Some media files declare
five-minute setup and per-test budgets, so this runner cannot establish their
failure or completion. Resume this runner rather than starting
another full suite. The experiment diagnostic at
`/tmp/aiko-experiment-diagnostic.log` also exceeded its declared 30-second test
timeout; subsequent closed-host errors occurred during teardown and do not by
themselves identify the original slowdown.

The initial physical-media run also lacked `MEDIA_HARNESS_PACKAGES` and
`MEDIA_HARNESS_MODELS`. Two processing files explicitly rejected this setup; the
multilingual fixture otherwise created an empty model directory. These are
unconfigured checks, not production failure evidence. A configured multilingual
rerun uses the existing `/tmp/unlock-media-runtime/lib/python3.13/site-packages`
and `/tmp/unlock-media-multilingual-models`, with no downloads. It is exec session
`25868`, log `/tmp/aiko-multilingual-configured.log`; sealed runtime setup completed
in 19.3 seconds. That run finished with one passing test and four failures;
several jobs reached about 62 seconds wall time with only 4–5 seconds of CPU.
The default Node/Bun temporary directory resolves to `/home/deck/tmp` on the
external disk, while `/tmp` is tmpfs. An isolated fixture copy explicitly setting
the existing `temporaryRoot` option to `/tmp` is running as session `47320`, log
`/tmp/aiko-media-ram-check.log`, to test this explanation. It finished: all five
tests passed (35 assertions), including fixed English/Spanish quality and cold
receipt replay. The same speech case improved from a roughly 62-second failed
run to 5.6 seconds completed, with unchanged runtime lock and resource limits.
Production settings have not been changed. A configured rerun of the 13 failed
files now uses `TMPDIR=/tmp` and the installed offline runtime/model paths,
recording results in `/tmp/aiko-configured-regression/results.json`. Its per-file
limit is 30 minutes, exceeding the declared media setup and test budgets.
The configured runner is exec session `93096`; resume it instead of duplicating
the run. Its first nine files have now passed, including all 26 experiment-trial tests
and all 30 experiment-controller tests. The latter finished in 11.1 seconds;
the original external-disk run took 154.9 seconds and failed six tests. The
configured video tests also pass (53 assertions), as do both English/Spanish
production media-host cases (89 assertions). Four processing/repair/video-host
files remain in progress at this checkpoint.

The full per-file runner `27674` has now exited: 148 files completed, 135 passed,
13 returned failures or the runner's timeout. Four early failing groups have
subsequent passing checks documented above; the remaining experiment/media
results still require reconciliation with configured execution and declared
time limits. No test file changed during its own measured invocation.

Worker dispatch now verifies the persisted grant after `EventLog.append` before
invoking native `agents.run`. A policy-rejected append previously still returned
`dispatched:true`; the new regression reproduced that behavior, then passed
after the fix. All 16 worker tests pass (`/tmp/aiko-worker-grant-all.log`). The
production-Worker test's in-process `Bun.build` failed to resolve `zod`
from the protocol package; the equivalent Worker build in a fresh process
succeeds (`/tmp/aiko-isolated-worker.mjs`). The test now builds in a fresh Bun
process before loading its Worker fixture, separating Node fixture resolution
from `workerd` build conditions. It passes all 15 assertions, including selected
worker model/effort, scoped execution, and restart recovery
(`/tmp/aiko-worker-cloudflare-fresh-builder.log`).
The latest whole-agent TypeScript check also passes after the grant confirmation
and fresh-builder changes (`/tmp/aiko-worker-grant-typecheck2.log`).
After the alarm recovery fix, TypeScript and the Worker dry-run pass again
(`/tmp/aiko-recovery-types.log`, `/tmp/aiko-recovery-worker-build.log`), with
artifact `/tmp/aiko-recovery-worker-artifact`. No deployment has been performed.

## Remaining completion requirements

- Finish the repository-wide comparison, including native invocation/output,
  child identity/cancellation, scheduler retention/deadlines, model middleware,
  compaction, channels, CLI deployment, and client event rendering. A directory
  inventory is not proof of a complete source audit.
- Resolve whether the `0.22.1–0.22.3` fixes require an upgrade or targeted changes
  to Aiko's custom host, with stored-history compatibility evidence.
- Complete the broad regression run and investigate response-relevant failures;
  re-run required checks after final edits.
- Build and exercise the final Worker artifact, inspect rendered progress and
  terminal states, and perform an authorized deployment/live verification with
  retained history and a concrete rollback path.
- Record the before/after evidence and limitations, then audit every requirement
  against the final state before marking the goal complete.

The final-response conversion review and asynchronous cancellation review are
completed for the current implementation: retain the existing native `respond`
boundary, because tests establish one physical model completion and one final
delivery, media handling, epoch scoping, and uncertain-send recovery. Compute and
worker cancellation tests establish cleanup before terminal events, retained job
identity, bounded cleanup, no duplicate cancellation after restart, and no private
output in cleanup receipts. Those completed checks do not replace the remaining
rendered and live verification.
