# Aiko runtime and reply audit

Status: in progress. This document records verified findings and remaining work;
it is not a claim that the whole repository or production deployment is fixed.

## Current release summary

The verified response repairs address these user-visible failures:

- Old completed requests restarted Telegram typing after a cold activation.
- Working model commentary could remain internal instead of reaching the user.
- Quiet fallback policy could suppress the final failure notice.
- An unconfirmed webhook write could be acknowledged as accepted.
- Failed drive recovery could wait behind a distant maintenance alarm.
- Final reply preparation could leave the console with no answer or activity.

Supporting changes preserve native cancellation, scoped child ownership,
configured tool budgets, and uncertain-send handling. Keep the pinned runtime
and targeted patch; the version decision is detailed below.

The frozen candidate at `/tmp/aiko-release-review-f7d837a` passes 1,495 tests
across all 157 agent test files, with zero failures and ten live browser/session
tests skipped. All 752 recorded source/configuration hashes remain unchanged.
TypeScript and the complete Cloudflare build pass. Actual local `workerd`
retains one reply across a process restart and duplicate request. The preserved
12-file Worker artifact is at `/tmp/aiko-release-artifact-f7d837a`; its recorded
hashes have been rechecked. Full reconciliation is recorded in
`/tmp/aiko-release-full-verification.json`.

The shared worktree has since changed in at least 53 recorded inputs. Its
targeted response/outbox checks pass 58 tests, but the frozen candidate's full
test result does not apply to those newer changes.

Production was updated outside this audit to version
`77b205aa-eace-4c48-8973-052697845daa`. Its recorded deployment source contains
the typing, progress, fallback, webhook, and alarm fixes, but lacks the later
console reply-preparation projection. Deployment provenance is detailed below;
this is not a completed live-conversation verification. The outstanding release gates
are final scope review of the preserved snapshot (including its database
changes); rendered verification after Chrome setup; and production
backup/deployment/live checks. Earlier failed checks and
runner status entries below are historical evidence, superseded where a later
checkpoint explicitly records the result. They are retained to explain the
fixes and the limits of verification.

## Completion checklist

| Requirement | Evidence and current disposition |
| --- | --- |
| Compare upstream components and usage | Native inference/output, effects, cancellation, child identity, host recovery, compaction, channels, and client examples are reviewed below. A literal all-files repository review has not been established. |
| Stop terminal requests restarting typing | Native restart tests pass; deployment source includes the fix. Post-deployment history has no new starts for the three known old terminal requests in the observed interval. |
| Deliver working commentary and final failure notices | Candidate host tests pass; deployment source includes both repairs. One live progress send is confirmed delivered. A live final failure notice is now confirmed delivered at sequence 20196; successful video delivery remains unverified. |
| Preserve durable ingress and recover failed work | Webhook persistence and Worker alarm tests pass; deployed source matches those repaired files. No claim that every production failure mode has been exercised. |
| Display reply preparation after inference ends | Four-file patch verified against deployed commit: 55 relevant tests, whole-agent types, Cloudflare build. Rendered verification and publication remain outstanding. |
| Preserve history, ownership, cancellation, and uncertain sends | Frozen-candidate tests and local workerd restart/duplicate checks pass. Actual production backup remains unavailable while account work continues. |
| Verify the full candidate | 1,495 passed, zero failed, ten live tests skipped; 752 input hashes unchanged. This evidence belongs to the preserved candidate, not subsequent shared-worktree changes. |
| Verify a responsive user experience | Incomplete. The observed live request took about 14 minutes to its first progress message and ultimately delivered a failure notice after provider inference retries were exhausted. Successful transport alone does not satisfy this requirement. |

Do not mark the goal complete while the final two user-experience checks remain
unproven, or describe the repository audit as exhaustive without source coverage
evidence. Browser interaction still awaits the requested Chrome confirmation.

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

## Verified checkpoint: terminal typing replay and completed regression runs

Read-only production history through sequence 20052 establishes a specific
typing replay failure. Turns `telegram:508309692`,
`telegram:508309767`, and one automation turn all have native `TurnCompleted`
events (sequences 17504, 18019, and 17871 respectively), without delivery
receipts. A later activation emitted typing-start events for all three at
sequences 20050–20052. The latest separate turn had already failed, prepared a
reply, settled delivery, and stopped its own typing. No raw request contents or
credentials were copied into this report.

`createTelegramTyping` now treats a native terminal as finished when typing has
not started in the current activation. This prevents cold replay from reviving
old typing loops while preserving an existing renewal during final outbox
composition and delivery. A newer resume epoch can still start typing; stale
delivery receipts cannot stop it. The 27 Telegram tests pass with 159 assertions,
including the new terminal replay regression and existing delivery/epoch test
(`/tmp/aiko-typing-replay-fix.log`). Whole-agent TypeScript passes
(`/tmp/aiko-typing-typecheck.log`). This change has not been deployed.
An additional real Bun/SQLite host test now closes and reopens a seeded native
history containing completed, failed, and cancelled turns with old activation
typing receipts. `recover()` followed by explicit wake performs zero physical
typing calls and leaves the complete event history unchanged. The expanded
Telegram file passes all 28 tests (`/tmp/aiko-typing-native-replay.log`).

The complete `bun scripts/build-aiko-cloudflare.ts` pipeline passed after the
production typing fix: protocol/SDK builds, browser/compute/coding runners,
embedded connector UI, Cloudflare TypeScript, and Wrangler deployment dry-run
(`/tmp/aiko-typing-cloudflare-build.log`). This was a local build, not a publish.

The earlier runner progress entries above are historical checkpoints: both
runner 27674 and configured rerun 93096 have finished. The initial run passed
135 of 148 files; all 13 remaining files subsequently passed with the installed
offline media runtime/models and `TMPDIR=/tmp`. Their result manifests are
`/tmp/aiko-isolated-regression-current/results.json` and
`/tmp/aiko-configured-regression/results.json`. No test file changed during its
initial measured invocation. This proves passing results for that inventory,
not an atomic snapshot of the concurrently edited worktree.

Eight additional files were checked in `/tmp/aiko-additional-regression/`.
Seven passed initially; `learning-source-recovery.test.ts` changed during the
investigation of its failed legacy fixture. Its current version passes all 11
tests and 50 assertions, including altered operation/identity and connection
record rejection (`learning-source-recovery-current.log`). All eight therefore
have passing results, with the same concurrent-edit qualification.

Upstream commit `4954c95` changes the precedence of normalized token accounting
over raw provider reports, preserving raw reports as provenance. The installed
0.22.0 still merges those reports. Aiko's request allowance reserves physical
HTTP calls before I/O; it does not derive allowance from these token counts.
The current routing checks pass 23 tests and 159 assertions, covering physical
request limits, normalized errors, retries, fallback usage, and scoped denial
(`/tmp/aiko-accounting-compatibility.log`). This is evidence against changing
token accounting as a response-recovery fix; it does not prove equivalence of
every cache-token or pricing calculation with newer upstream versions.
The production-style Worker allowance tests also pass all three cases and 24
assertions, including atomic final allowance reservation and cancellation during
reservation (`/tmp/aiko-registry-accounting-compatibility.log`).

## Runtime version and release checkpoint

Retain `tardie@0.22.0` with the current targeted patch for this response repair.
The release comparison through 0.22.3 identifies these applicable boundaries:

| Upstream change | Aiko disposition |
| --- | --- |
| `1091338`, parent-scoped child identity | Covered by the existing patch and owned-child/recovery checks; preserve persisted claims. |
| `924a5c0`, supplied root identifiers | Changes the standard server's `thread-compat` adapter. Aiko calls native `host.self(user-<owner>)` directly and does not import that adapter. No new root-name migration is required. |
| `5ca3a5c`, atomic deadline cancellation | Applied to the custom Cloudflare host; its transactional failure test covers rollback of the entire alarm/cancellation batch. |
| `c16a07c`, active drive retention | Custom host serializes drive work and retains recovery alarms; the actual Worker alarm test covers failed drive retry without replacing an earlier alarm. |
| `4954c95`, normalized usage precedence | Accounting difference described above; request allowance and response recovery do not require this change. Do not claim identical cache/pricing reports. |
| `018aca9`, thread allocation simplification; `061c10e` and `5293a60`, interaction/runtime refactors | Not copied wholesale into the pinned runtime. Their new API/allocation shapes require a separate migration; current native identity, outbox, and stored-history tests are the compatibility boundary for this repair. |

The on-disk patch still hashes to
`17a4292a7c744d957e2bd41db4c6cb9c10b98ed3044d12e1899e41968f9d7aab`.
All 17 installed patched files match the previously clean-applied upstream
snapshot after normalizing the published `tardie/agent` import paths
(`/tmp/aiko-release-patch-verification.json`). The current native export suite
passes 8 tests and 79 assertions, including byte-preserving offline export,
retained roots/scopes, active-host refusal, and source-lease fencing
(`/tmp/aiko-release-history-compatibility.log`). These fixtures do not substitute
for an actual production backup.

Read-only deployment inspection still identifies Worker version
`63efbe26-b69b-41d1-baf8-45825c26e4bd`, deployed at
`2026-09-08T02:31:52.662Z` (`/tmp/aiko-release-deployments.log`). This is the
pre-release code rollback candidate, subject to revalidation immediately before
publishing. Rolling back code does not restore durable data. The earlier live
export returned busy; no export, quiesce, reset, or production publish was forced.
The installed Wrangler CLI confirms `rollback [version-id]` accepts a config
path (`/tmp/aiko-release-rollback-help.log`). If this remains the approved rollback
target, the code-only command from `apps/agent` is:

```sh
pnpm exec wrangler rollback 63efbe26-b69b-41d1-baf8-45825c26e4bd --config wrangler.jsonc
```

This command is documented for release review and has not been executed.

## Reply preparation visibility

The console previously cleared its working indicator at the native inference
terminal, before the outbox's reply composition completed. During that interval
there could be no displayed answer or activity status. The API regression first
failed because this state was absent (`/tmp/aiko-preparing-before.log`).

Both Node and Cloudflare message APIs now expose `preparing`, derived from
durable `AikoVoiceStarted` records without a matching `AikoReplyPrepared` in the
current native turn epoch. The console shows “Preparing your reply…” in that
interval, keeping inference cancellation separate. Current activity takes
precedence over an older uncertain-delivery notice; that notice remains visible
when no request is active. No delivery is retried by this projection.

The current response suite passes all 27 tests, including preparation settlement,
old-epoch exclusion, native terminal status, and final-response recovery
(`/tmp/aiko-preparing-fixed.log`). The complete Cloudflare build passes after
the change (`/tmp/aiko-preparing-cloudflare-build.log`). Console script syntax
was also checked, but rendered verification remains pending the user's Chrome
remote-debugging confirmation. No alternate browser was used to bypass that
setup requirement.

## Local Cloudflare runtime verification

The compiled Worker fixture now exercises `/api/messages` through the production
`AikoAccountDO.handle` method while a reply is being prepared and after its
preparation receipt. Both reads return 200, expose the expected preparation
state, and make no additional model requests. The expanded fixture passes with
24 assertions (`/tmp/aiko-preparing-worker-http.log`), also retaining its scoped
child recovery and alarm failure checks.

Separately, the current source ran under Wrangler's actual local `workerd`
runtime at `127.0.0.1:4351`, with a temporary configuration and local Durable
Object/R2 storage in `/tmp/aiko-workerd-release-q9az9Y`. The process receives a
minimal environment, synthetic operator/account credentials, deterministic demo
inference, and no Telegram or model-provider credentials. All bindings report
local mode. No production storage or deployment is involved.

The HTTP check observed status 200, message acceptance 202, one final greeting,
and empty pending/preparing lists (`/tmp/aiko-workerd-first-reply.log`). The
first terminal was explicitly exited and its exit code 0 verified before
starting a new Wrangler process against the same local storage. After restart,
the entire message projection was identical. Retrying the same message ID
returned 202 and still left that projection unchanged, with exactly one reply
(`/tmp/aiko-workerd-restart.log`). This verifies completed-request persistence
and duplicate acceptance in `workerd`; it is not a live-provider latency test
or a rendered-browser result.

## Isolated release candidate

An isolated checkout at `/tmp/aiko-release-review-f7d837a` is based on commit
`f7d837a5cf61be268319478e6e69ab24f0b5e5a7`, with 38 then-current modified/new
files copied from the shared worktree and checked by hash during capture.
The overlay manifest is `/tmp/aiko-release-review-manifest.json`. It excludes
local runtime state, credentials, and agent logs. Dependencies were installed
from the frozen lockfile with lifecycle scripts disabled; one missing cached
package required a network fetch after the offline attempt.

This candidate passes the complete Cloudflare build and whole-agent TypeScript
check (`/tmp/aiko-release-snapshot-build.log`,
`/tmp/aiko-release-snapshot-types.log`). Its focused release run passes 167 tests
across 13 files, with zero failures or skips. Coverage includes Telegram typing,
response/preparation, progress, webhook acceptance, Worker host/child recovery,
compaction, migration, model routing, compute cancellation, and runtime/production
assembly. Per-file results are in `/tmp/aiko-release-snapshot-tests/results.json`.

All 752 recorded source/configuration input hashes remained unchanged through
these checks (`/tmp/aiko-release-input-hashes.json`,
`/tmp/aiko-release-snapshot-verification.json`). This removes the concurrent-edit
qualification for this focused candidate run; it does not claim that all other
tests or subsequent shared-worktree edits are verified. The snapshot has not
been committed, merged, or deployed.
The candidate's deployable dry-run bundle is retained at
`/tmp/aiko-release-artifact-f7d837a` (build log
`/tmp/aiko-release-artifact-build.log`). A per-file run of the remaining 144
agent test files is active in canvas terminal
`pane-term-1788853736184-917`, using
`/tmp/aiko-release-remaining-tests.py`; incremental results are
`/tmp/aiko-release-remaining-tests/results.json`. Its initial ten files passed.
Resume this terminal rather than starting another run. Media checks use the
installed offline runtime/models and `/tmp`; browser/live-provider credentials
are excluded from the test environment. Completion and any skipped cases still
need to be reconciled before claiming this full snapshot inventory is verified.
The same runner subsequently reached 60/144 files with no failures. It remains
active; this is a progress checkpoint, not its final result.

The local `workerd` preview now runs this frozen candidate, rather than the
changing shared source. Its previous process was confirmed exited before the
candidate started against the same synthetic local storage. The earlier
conversation remained identical; a new message received exactly one final reply,
and retrying that message ID left the projection unchanged. Pending and preparing
were both empty (`/tmp/aiko-frozen-workerd-check.log`). The preview terminal is
`pane-term-1788853898432-111` at port 4351. Its config remains demo-only with
synthetic credentials and all-local bindings. Artifact hashes for the 12 retained
bundle files are in `/tmp/aiko-release-artifact-hashes.json`.

Release-scope review found additional database/source-catalog and journal changes
in the captured overlay, beyond the response repairs. In particular,
`database-refresh.ts` writes plan version 2 and explicitly rejects a retained
version-1 plan with `unavailable`, requiring a new operation. This is intentional
in that patch but is an additional compatibility consideration, not evidence
that the typing fix requires a database format change. Do not publish the entire
overlay as a response-only hotfix without resolving that scope. The isolated
candidate's affected library checks pass: 19 structured-store tests with 84
assertions and 12 entity journal tests with 139 assertions
(`/tmp/aiko-release-structured-store.log`, `/tmp/aiko-release-entity-journal.log`).
The version-1 plan recovery boundary was then exercised separately against the
frozen candidate: a native Bun host reopens a queued refresh with a sealed old
plan, records exactly one `AikoDatabaseOperationSettled` with status/code
`unavailable`, makes zero source calls, and leaves its event history unchanged
on another reopen/wake. Six assertions pass
(`/tmp/aiko-legacy-plan-review.test.ts`, `/tmp/aiko-legacy-plan-review.log`).
The fixture stays outside the frozen source tree. This establishes a terminal,
non-retrying failure rather than a new silent loop, but does not remove the
need for a new operation to complete an old refresh or turn this additional
database change into part of the typing repair.

## Remaining completion requirements

- Finish the repository-wide comparison, including native invocation/output,
  child identity/cancellation, scheduler retention/deadlines, model middleware,
  compaction, channels, CLI deployment, and client event rendering. A directory
  inventory is not proof of a complete source audit.
- Preserve the version decision and targeted-patch compatibility checks above
  when producing the final release snapshot.
- Reconcile subsequent concurrent edits with the completed regression inventory;
  run required checks after final edits.
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

## Additional model retry boundary under review

The upstream model adapter classifies transient transport failures from HTTP
status or recognizable network/timeout errors (`packages/model/src/model.ts`,
`isRetryableFailure`). The current Aiko transport preserves sanitized HTTP
status and Retry-After, but its outer catch replaces thrown transport errors
with `ModelRoutingUnavailable(..., "transport_or_budget_unavailable")`. That
may prevent native retry classification for network failures before a response.
This is a source-level concern, not yet a reproduced defect: verify against the
installed 0.22.0 adapter and exercise the full native inference layer before
changing it. Preserve credential redaction, cancellation, and budget-denial
behavior when testing the boundary.

The existing frozen-candidate regression process remains running and has
completed 90 of 144 remaining files with exit zero, including media-video-host.
This is an interim observation, not a completed-suite result.

The suspected network-retry suppression above did **not** reproduce through the
installed native inference layer. The added `native retries recover a redacted
fetch failure` regression injects a thrown TypeError on the first physical
fetch, then a valid SSE answer. It completes with exactly two physical calls
and excludes the private fixture marker from the returned result. The initial
reproduction passed without a production-code change
(`/tmp/aiko-network-retry-before.log`). Keep the existing transport behavior;
the earlier source-only concern is superseded by this runtime evidence for
that failure case. This does not establish every possible network failure.

## Frozen candidate full regression completed

The existing runner `pane-term-1788853736184-917` exited with code zero.
Combining its 144 remaining files with the 13 focused candidate files accounts
for all 157 distinct `apps/agent/test/*.test.ts` files in
`/tmp/aiko-release-review-f7d837a`: **1,495 passed, zero failed, 10 skipped**.
Every per-file log is present and every process exited zero. All 752 recorded
source/configuration hashes still match. Machine-readable reconciliation:
`/tmp/aiko-release-full-verification.json`. This supersedes interim counts.

The ten skipped cases require live browser/session configuration: three in
browser-replay, two in browser-session-transport, one in native-login-live,
three in native-request-recovery-live, and one in request-memory-live-session.
Some also require an embedding provider. Their environment gates were inspected;
they are unverified, not passing. The outstanding browser setup confirmation
and rendered UI check remain outstanding. No production deployment occurred.

The subsequent network-retry regression was run in the shared worktree rather
than inserted into this frozen snapshot: the full current model-routing file
passes 26 tests with 170 assertions (`/tmp/aiko-network-retry-suite.log`).
No transport code change resulted. Other concurrent shared-worktree edits are
not covered by the frozen candidate's test result.

## Upstream client rendering comparison

Read the pinned upstream React chat example's `events.ts`,
`use-streaming-text.ts`, `chat-client.ts`, and `components/Transcript.tsx`, then
compared the current Aiko console and both `/api/messages` implementations.
The example stops its response indicator on TextReturned, ToolCalled, or any
native terminal; its active-message selector considers Completed, Failed, and
Cancelled terminal. Inference deltas are ephemeral, scoped to a physical
attempt, discarded on sequence gaps, and cleared on a terminal response event.
They are not durable final-delivery receipts.

Aiko uses durable message snapshots rather than inference deltas. Its pending
selectors use native `turnTerminalOf` and epoch-scoped prepared replies. The
separate `preparingReplies` projection is necessary because persona/outbox
composition may remain active after native inference ends. Keep that distinction
instead of copying the example's single spinner predicate: otherwise the UI
would go blank while Aiko prepares its final reply. Likewise the example's
terminal set is not sufficient for Aiko's resumed epochs. The console currently
prioritizes active work/approval, then reply preparation, then unknown-delivery
status. Existing candidate response and Worker HTTP tests exercise the durable
projection, including resumed epochs; this source comparison does not constitute
a rendered-browser check. No production code change was warranted by these
four example files.

## Shared worktree drift after candidate verification

A fresh comparison finds 53 of the candidate's recorded inputs changed in the
shared worktree (`/tmp/aiko-release-current-drift.json`). This count excludes
new files absent from the original hash manifest. Reviewed actor/model-routing
differences include contribution-mode inference and proactive delivery
deferral; they are substantive behavior changes, not merely formatting.
Do not transfer the 1,495-pass frozen-candidate claim to the current worktree.

A targeted current-worktree check of channel-response, proactive-outbox-host,
and proactive-policy passes 58 tests with 257 assertions and no failures
(`/tmp/aiko-current-response-drift.log`). This checks the shared foreground
reply/outbox boundary affected by those actor changes; it does not validate
all 53 changed files. The preserved frozen release artifact remains unchanged.

## Production export recheck

A fresh authenticated, read-only GET to `/api/control/export` for the previously
inspected account did not return headers within the client's 20-second bound.
The request ended in TimeoutError; no backup was obtained and no response body
was printed or saved. This is an observation timeout, not proof that the host
is stopped or that the earlier 409/busy condition still holds. Recheck status
and the same export endpoint before deciding on any intervention. No deployment,
forced cancellation, or state reset was performed.

Production follow-up: `/api/status` returned HTTP 200 in 1,625 ms. The same
account export endpoint again reached its 25-second observation timeout, and
`/api/control/threads` reached a 20-second timeout. Credentials and account data
were not printed. General Worker health therefore responds while these account
control requests do not respond within the observed bounds. This narrows the
next investigation to account routing/initialization/recovery; it does not prove
a stopped host or identify the precise cause. The source export route awaits
`host.resting()` before its synchronous snapshot, so export alone cannot
distinguish a busy host from a slow account path. No duplicate runner or
replacement Worker was started.

## Production changed outside this audit

A bounded 35-second Wrangler trace recorded `runtime.alarm_failed` after
30,389 ms; its error matches a Durable Object reset due to a code update. It
also recorded runtime boot started/completed (0 ms). No captured exception
established a CPU or memory limit. Raw trace is private at
`/tmp/aiko-account-tail.jsonl`; do not publish it. The trace command's exit 124
is its intentional capture timeout, not a Worker process exit.

Read-only deployment inspection then found a newer 100% Worker version,
`77b205aa-eace-4c48-8973-052697845daa`, deployed at
2026-09-08T07:30:42.155Z (`/tmp/aiko-current-deployments.log`). This audit did
not deploy it. The earlier version/rollback assumptions must be revalidated
and the live version's source identified before any publish. The current
timeouts cannot safely be attributed to the older deployed version. Nor does
this deployment alone establish that the preserved candidate's fixes are live.

## New deployment provenance identified

`/tmp/aiko-release-f7d837a5-deploy.log` identifies asset/build source
`/tmp/aiko-release-35c5abbe` and the exact new version
77b205aa-eace-4c48-8973-052697845daa. That worktree is at f7d837a5, with only
a generated compute-runner asset modified when inspected. The recorded health
artifact `artifacts/deployments/f7d837a5.json` matches that version and records
HTTP/readiness/authentication/webhook checks at 07:31:25.871Z; its own scope
explicitly excludes a fresh Telegram conversation or full live tool benchmark.

The deployment worktree's telegram-tools, channel-progress, actor,
cloudflare-host, and telegram-webhook sources byte-match the tested candidate.
Its channel-response differs by the added `preparingReplies` projection; its
console likewise lacks the later reply-preparation status. Thus the deployment
record supports inclusion of the principal typing/reply reliability fixes,
but not the complete later candidate. This supersedes statements that all
fixes remain undeployed. Source/build-record correspondence is not a production
behavior test or a downloaded-live-bundle hash comparison.

## Post-deployment account history responds

The same account thread-list request subsequently returned HTTP 200: background
threads were idle and the foreground was running. A read-only history page
after sequence 20052 returned through 20079, followed by tool metadata through
20081. It contains one new Telegram request (508309802), model/tool activity,
and typing starts only for that active request; no new typing starts for the
three historical terminal requests appear in this observed interval.

This request has not yet reached a terminal or final delivery in the observed
page. One sandbox_exec spans sequence 20073 to 20075, about 374 seconds, with
a new activation typing receipt between them. Other calls include access_status,
connector_connections, memory_recall, and sandbox_exec. No TextReturned or
progress-delivery receipt appears in the observed interval. The transport
progress fix cannot deliver commentary the model has not emitted. Do not claim
the live experience is fixed from the absence of historical typing alone.
No new message or tool execution was submitted by this audit.

## Remaining reply-preparation patch isolated

Prepared `/tmp/aiko-reply-preparation.patch` against the identified deployment
worktree. It changes only channel-response, console, server, and cloudflare: the
shared preparing-reply projection, two HTTP fields/imports, and console feedback.
It excludes the candidate's source-catalog/database integration edits.
`git apply --check` succeeds against `/tmp/aiko-release-35c5abbe`. The patch was
not applied to that other release worktree, built, or deployed. Its behavior is
covered in the larger tested candidate, but this exact deployment-relative
combination still needs its own build and relevant verification.

The live request subsequently progressed through sequence 20092: the observed
sandbox executions returned exit zero, then a new execution returned running
and the actor called sandbox_job. The long earlier event gap contains a worker
reactivation, so do not report it as measured command execution time. There
is still no observed progress text/final reply in this interval.

## Deployment-relative preparation release verified locally

Created `/tmp/aiko-reply-preparation-release` at deployed commit f7d837a5 and
applied only the four-file preparation-status patch plus its two existing
regression fixtures. Frozen-lockfile offline installation succeeded. Full
Cloudflare build/dry-run and whole-agent TypeScript pass. Separate test processes
pass 27 channel-response tests, one compiled Worker HTTP fixture, and 27 base
Telegram tests: 55 total, zero failures. Logs use the
`/tmp/aiko-preparation-release-` prefix. This closes build verification for the
exact deployed-base combination without bringing in database/source-catalog
changes. The generated compute bundle differs from the deployment checkout
only by its embedded absolute checkout path (normalized equality verified).
Rendered verification and deployment of this preparation-status addition remain
outstanding. No production mutation occurred.

## Live progress delivery observed after deployment

Read-only history through sequence 20109 now provides direct production
evidence for the commentary repair: request telegram:508309802 emitted
TextReturned at 20098, AikoProgressStarted at 20100, and AikoProgressSettled
with delivery status `delivered` at 20101. The settled receipt arrived about
six seconds after TextReturned. Its message body was not copied into the audit.
The request remains active: later sandbox_job observations still report running
and a ModelCalled receipt follows. This establishes one successful live
progress delivery, not final completion or acceptable end-to-end latency.
The first observed progress comes roughly 14 minutes after the incoming request,
including the earlier restart interval; timely model commentary remains a
quality limitation even though the transport now delivers it.

## Latest live script diagnosis

The recorded generation script manually reconstructs both image and video
status/result URLs despite the host instruction to use provider-returned URLs.
It executes `python3 -` without unbuffered output or explicit print flushing.
Later sandbox_job receipts still show running with zero output; the observed
receipts do not yet expose an HTTP error, so incorrect-route failure is not
confirmed for this particular request. Buffered output is a plausible reason
that useful progress remains invisible while the script runs.

The shared sandbox_exec tool description now explicitly tells future generated
Python jobs to use unbuffered output, retain submission receipts, and poll exact
returned URLs. This is guidance, not enforcement or a demonstrated repair of
the already-running script. The current process was neither modified nor
resubmitted. This description change is not part of the preparation-only release.

## Control availability during long work

Reviewed upstream runtime receive (durable MessageReceived identity) and Aiko's
Cloudflare acceptance/control dispatch. Telegram /status and /cancel are
dispatched with separateLane=true into control-<owner>, while cancellation
commits the current invocation epoch into the foreground history. They do not
require another foreground inference turn to generate their reply. The existing
Cloudflare-host regression explicitly blocks a foreground effect and verifies
the control lane can respond during an alarm; it is included in the completed
candidate run. This is the appropriate native mechanism to preserve controls
during a provider wait. It does not establish a live /status delivery, which
this audit has not submitted, or remedy delayed unsolicited progress text.

## Early progress instruction strengthened

The current interactive instruction made early updates a default and asked the
model merely to consider explaining long operations. After observing about
14 minutes before the first live update, it now explicitly requires a short,
task-specific working update alongside the first tool call for substantive
work, and an explanation of a newly running job when that wait has not already
been explained. Later updates remain driven by findings/status/blockers rather
than timers. The existing native TextReturned delivery mechanism is unchanged;
no extra model call or synthetic progress event was introduced.

This is a model instruction change, not a runtime guarantee. It is in the
shared worktree, not the deployed or preparation-only candidate. Behavioral
verification with the configured model remains necessary before claiming it
fixes the measured first-update delay. Existing response/progress regressions
were run in `/tmp/aiko-early-progress-check.log`; they verify transport behavior,
not real-model adherence to the new wording.

## Small real-model progress probe

Ran `/tmp/aiko-progress-model-check.ts` through the installed native Infer layer
with the deployed conversation model deepseek-v4-flash. It made exactly two
physical model requests (one per wording), disabled native retries, supplied a
synthetic long-video request and one described tool, and never executed a tool
or sent a Telegram message. Both the deployed and revised instructions produced
a generate_video call with nonempty, task-specific working text explaining
the wait. Results are at `/tmp/aiko-progress-model-check.json`; reported token
totals were 1,124 and 988.

This verifies that the revised wording can produce the expected native action
and that the configured adapter retains its commentary. It does not prove an
improvement: the deployed wording passed too. The probe omits the full long
production history and tool catalog, so it cannot reproduce or explain the
14-minute delay. Do not claim a measured reliability improvement from it.

## Live polling failure confirmed

The original generation shell job settled at sequence 20154 with exit code 1
and HTTP 405 in its retained output. Thus the earlier wrong-route concern now
has runtime error evidence; it was not merely a slow provider. Subsequent
actor work reads the provider OpenAPI schema, repairs the video input fields,
and starts a video step. That script initially still polls the nested model
route and its output reports HTTP 405. At sequence 20175 the actor writes a
separate polling script that reads the already-saved request ID and uses the
parent queue route; this recovery script contains GETs only and flushes status
output. Do not claim the entire recovery made no new submissions: the earlier
video-step script contains a POST, and the first submission's provider outcome
is not established by an HTTP 405 on its status endpoint. No final reply has
yet been verified by this audit.

## Live terminal failure reply verified

The corrected provider polling job completed with exit zero at sequence 20187.
After another sandbox command, the foreground turn failed at 20192 with
cause inference_attempts_exhausted: three model attempts exhausted on a
connection error, with endpoint codegraff/muse-spark-1.3-contributor. The
subsequent native outbox records VoiceStarted 20193, ReplyPrepared 20194,
DeliveryStarted 20195, DeliverySettled(delivered) 20196, and TypingStopped
20197. The final-delivery receipt arrives about 10.6 seconds after TurnFailed.

This is direct production evidence that an inference failure now produces a
final notice and closes typing. It is not successful delivery of the requested
video, nor proof of acceptable latency: this request also suffered incorrect
provider polling and delayed commentary. No generation or chat send was
submitted by the audit; these are observations of the existing user request.

## Final isolated UX addition assembled

The deployment-relative checkout now also includes only the reviewed
AIKO_INTERACTIVE_INSTRUCTIONS wording and sandbox_exec description changes,
extracted surgically from the shared worktree. Full Cloudflare build passes
(`/tmp/aiko-final-ux-release-build.log`); progress/response checks pass
(`/tmp/aiko-final-ux-release-tests.log`). Changed-file hashes are preserved in
`/tmp/aiko-final-ux-release-hashes.json`. No database migration is included.
The earlier preparation-only verification is superseded by this added wording
for release scope; the small real-model comparison's limitations still apply.

A read-only production export after the foreground terminal again reached the
30-second client timeout; no backup was obtained. This does not establish
that background work is settled or that export itself is faulty. Browser
confirmation is still absent, so no browser reconnection or rendered check
was attempted. This isolated UX addition has not been published.

## Cloak Browser rendered verification

The user explicitly selected Cloak Browser, replacing the earlier dependency
on their desktop Chrome confirmation. Started the installed Cloak Chromium
with an isolated temporary profile and loopback CDP, connected using
browser-harness (BU_NAME=aiko-cloak-ux, port 9473, cookie seeding disabled).
The real local workerd console at port 4351 rendered successfully.

A separate loopback fixture serves the exact CONSOLE_HTML from
`/tmp/aiko-reply-preparation-release` with synthetic status responses, without
model calls or Telegram sends. Browser execution confirms working feedback
with visible Cancel, preparation feedback with Cancel hidden, then a visible
final failure message with empty activity feedback. At 390x844 there is no
horizontal overflow, feedback has aria-live=polite, and scrolling exposes the
final answer above the sticky composer. Screenshots:
`/tmp/aiko-cloak-terminal-mobile.png` and
`/tmp/aiko-cloak-terminal-mobile-scrolled.png`. Fixture:
`/tmp/aiko-cloak-status-fixture.ts`. This closes rendered status verification;
it is not a live provider or production conversation test. The prepared UX
addition still has not been deployed by this audit.
