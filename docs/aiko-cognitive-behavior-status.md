# Cognitive behavior implementation status

Implementation of [the plan](aiko-cognitive-behavior-plan.md) is **in progress**. Proactive follow-through and an initial harness-library recovery slice work in controlled native fixtures. Broader recovery, procedural learning and matched performance evaluation remain incomplete. No quality improvement, SOTA result or production readiness is claimed.

## Implemented

- Waiting work uses existing `dependencyRefs`. When every prerequisite is completed with retained evidence, the coordinator proposes a notice bound to the exact parent and prerequisite versions. The parent remains unfinished.
- Reflection has a separate `aiko_contributions_v2` output contract. Started jobs retain their contract version and supplied observation IDs. Legacy jobs retain notify/silent validation. New reflection may cite older, still-current evidence supplied in its bounded context, together with triggering evidence.
- The boundary ranks at most three candidates; rejects invalid bounds, unsupported citations, weak usefulness and duplicate topics; and admits at most 16 unsettled topics per owner. Identity depends on evidence/topic, independently of wording.
- Fixed expiry is at most 24 hours; work notices also respect earlier task and decision deadlines. Native `proactiveWait` deadlines and foreground/work events drive rechecks. There is no new scheduler or memory database.
- Contributions wait during foreground work, including a turn arriving during voice preparation. Prepared speech survives restart. Corrections supersede old notices. Cancellation, stale/forgotten evidence, expiry, dismissal, retired policy and changed prerequisite versions suppress dispatch.
- Existing admission, current evidence checks, atomic outbox reservations and uncertain-send settlement remain the execution boundary.
- V2 reflection uses the stricter of the host allowance and 1,500 output tokens, a single native provider attempt with no throttle retry/fallback, and validate-once output handling. A deferred wait waking does not itself call a model. This is not an exactly-once physical-call guarantee across an uncertain provider crash.

The first slice checks three received agenda items using the existing workflow, unblocks dependent preparation work while the owner is busy, restarts, and then delivers, revises or cancels its notice. Direct foreground answers still arrive and replay does not deliver again. The agenda check establishes receipt of the required items, not the truth of the contact's statements.

## Initial recovery slice

[Harness recovery](../apps/agent/src/harness-recovery.ts) decorates existing `harness_run` and `harness_call` tools and adds `harness_recover` and `harness_reconcile`. It uses the same library, private blob custody, independent verifiers and native journal. Both direct and code-tool assembly receive the decorator when enabled; no scheduler or separate top-level task ledger was added.

- Two distinct checked executions with identical artifact/input/context and failure evidence retain an impasse bound to the native parent turn and epoch. Reading one receipt twice does not count. The third equivalent execution is blocked; material input/context changes are separate signatures.
- Recovery retains the original input and outcome contract, at most two distinct strategies, one prerequisite level and four total recovery executions. Relabeling the same procedure cannot reset the budget. The fixed deadline is at most 60 seconds after the first equivalent attempt, capped by any earlier retained parent deadline and the native call's cancellation signal.
- A currently promoted procedure can prepare the parent or perform the same operation through an alternate implementation. Preparation must pass its own independent check before the original parent runs and is checked. An alternate must use the exact original input and contract. Recovery never marks the whole parent task complete.
- Existing host append transactions enforce competing strategy/dispatch bounds and checked settlement. A checked child survives interruption before parent dispatch; reconstruction reuses its receipt and executes only the remaining parent operation. An uncertain dispatched operation is not replayed.
- Unsettled or uncertain writes, including failed outcome checks that do not prove absence of side effects, block further writes through these decorated harness calls in the same parent task. Current cancellation, ownership, context, procedure eligibility and existing source authority still apply.

Recovery settlements now retain up to 16 checked partial-result references from the exact owner, parent turn and epoch, with total/truncation metadata and the original unmet success condition. Owner-information and strategy-exhaustion responses expose those references for `harness_output`; raw private outputs stay in existing custody. They explicitly leave the parent unfinished. The host append fence validates references against native task associations and independent witnesses, excluding evaluation outputs, other turns/accounts, and unchecked failures. These are historical results, not authority to reuse an artifact or a guarantee that private output custody still exists. Broader task/tool partial accounting remains incomplete.

`harness_reconcile` reads an existing trusted executor receipt and checks it with the original pinned verifier, input, contract and context. It permits at most two named receipt reads within the original parent/60-second budget, never calling the write executor. Native cancellation, current source/authority checks and private input custody are checked again at the read boundary. An append fence ties receipt checks to their native parent and validates the final projection. The original unknown witness remains immutable; a separate `AikoHarnessReconciled` fact projects a satisfied outcome only after an independently checked result. A late original witness cannot overwrite that projection. Reading the same reconciliation attempt after restart does not repeat the receipt read. The same exact input and outcome contract requested through another write implementation in that parent reuses the reconciled result.

The trusted sandbox adapter exposes a separate receipt read through local SQLite custody, Codegraff's private runner, and the compute dispatcher. Missing custody never enters job claim/dispatch. Procedure metadata counts receipt reads separately and keeps original failures/unknowns and their costs. These changes recover a completed result whose acknowledgement was lost **after** executor custody. If the provider itself never produced a conclusive receipt, the result stays unknown; this does not establish absence of side effects or authorize another write. Provider-specific outcome lookup, definitive non-application evidence, cross-contract action identity, and broader router/browser/connector recovery remain incomplete.

This slice does **not** yet cover every router/browser/connector operation. It does not generalize corrected inputs, choose strategies through a measured model policy, or establish held-out recovery improvement. The native host tests exercise the real private code sandbox wrapper; these controlled regression cases are separate from the plan's protected performance set.

## Procedure evidence

The existing library now exposes `harness_procedure`. It derives metadata from immutable contracts, artifacts and retained execution/evaluation receipts; it does not create a second procedure store. A single successful task is labelled `saved-example`. A current promoted route is labelled `verified-transfer` only when its independently checked cases cover development inputs and at least one distinct held-out input, with intact exact input custody. Fixed-case success remains evidence within the registered domain and context, not universal correctness.

Trusted contracts can opt into `transfer: { version: 1, minimumNovelHeldOutInputs: N }`. Promotion and named reuse then require that many distinct held-out inputs not copied from development. Renaming a duplicate case does not satisfy the condition. The same route lookup is used by recovery, preserving this check through composed calls. Existing contracts retain their execution semantics; this requirement has **not** been retroactively added to the built-in contract catalog.

Metadata includes the declared input/output schemas, applicability, pinned context, dependencies/runtime lock and checked historical recovery examples. Examples require a checked parent outcome tied to the original input; child-only successes are excluded. Current authority is still checked for the actual invocation. A changed context removes current-route eligibility. Reading this metadata performs no execution, inference, promotion or repair.

Cold evaluation and ordinary task executor receipts are summarized separately, preserving failures and unknown outcomes. Missing executor tokens/costs stay unknown. Acquisition/generation cost and break-even uses remain unavailable until matched measurement exists. Joined child-experiment costs remain in their experiment report. This is the evidence boundary for procedural reuse, **not** completion of automatic procedure learning or repair.

## Fixed comparison workbench

The [evaluation workbench](../apps/agent/scripts/cognitive-eval/README.md) contains 60 authored scenario definitions, split 10 development / 5 validation / 5 reserved protected entries within each of recovery, procedures and proactivity. **Fifty drivers are implemented: 20 procedures, 15 recovery and 15 proactive cases.** The five reserved recovery and five reserved proactive drivers remain pending. The [family audit](../apps/agent/scripts/cognitive-eval/FAMILY-AUDIT.md) found cross-split input/mechanism dependence. All definitions are builder-visible; reserved execution does not establish unseen-task independence. Historical comparisons below retain their original scope; the latest evidence is in [the recovery-worker record](#recovery-worker-evidence--2026-09-08).

The procedure driver mounts the real `createAikoActor`, native tools, private code sandbox, checked artifacts and AccountStorage with isolated synthetic accounts and offline scripted inference. Both arms receive the same task program and inputs. The current control omits the new trusted transfer field; it is not the preserved pre-change source baseline. The workbench reuses the Telegram evaluator's receipt rubric, with synthetic delivery and unmeasured token/human-quality fields labelled explicitly.

| Fixed procedural comparison | Current control | Transfer contract |
| --- | --- | --- |
| Development families | 9/10 | 10/10 |
| Validation families | 3/5 | 5/5 |
| Protected families | Not run | Not run |

The control failures are specific to the new transfer requirement: repeated development inputs, duplicated held-out input counts and erased evaluation-input custody. This demonstrates the checked mechanism on supplied programs, not an autonomous agent's strategy selection, improved user completion or warm-cost savings. No provider inference was purchased. The v2 development and validation reports have identical tracked source and dataset digests and report no drift. Warm reuse checks two different private input references and satisfied receipts, rather than merely using two operation IDs.

Evidence is under `artifacts/cognitive-behavior/procedures-development-v2/` and `procedures-validation-v2/`. Earlier v1 runs remain as driver diagnostics. Each directory retains its pre-run dataset/rubric/source freeze, one-shot budget record, per-case native events, deterministic checks, receipt grades and final report. The runner limits attempts and wall time, kills timed-out child processes, removes their scratch state, preserves failed results, excludes protected cases by default and requires a sealed current candidate plus complete passing validation before protected execution. A missing driver, insufficient run budget, unsealed protected request and direct use of the internal child entry were all verified to reject execution. Agent typecheck and the separate evaluation-script typecheck passed (`eval-typecheck.log`, `eval-scripts-typecheck.log`). The default agent project excludes scripts; the workbench has its own TypeScript project including asset declarations.

The recovery driver also mounts the actual actor, native code sandbox and AccountStorage. It compares the same supplied script with recovery disabled/enabled; ordinary checked alternate/prerequisite calls remain available to the control. Its ten development families cover repeated failures, checked prerequisites, alternate capabilities, unknown writes, owner information, strategy exhaustion, changed evidence, receipt rereads, a still-failing parent, and legitimate waiting.

`recovery-development-v1/` exposed the missing partial-result handoff. After that fix, `recovery-development-v2/` observed 7/10 control and 9/10 candidate passes, with no paid inference. **Both recovery reports have source drift and are diagnostic only; these counts are not a valid matched performance comparison.** Concurrent tracked changes were detected outside the recovery implementation. At that revision, recovery validation and protected cases had not been executed. At that revision, the candidate's remaining failed scenario safely blocked another write but could not turn the supplied provider receipt into a checked reconciled outcome. The control also repeats that uncertain write. Safe stopping alone does not meet reconciliation acceptance. Retry/strategy-bound checks establish mechanisms under supplied scripts, not an autonomous model's choices.

After implementing receipt reconciliation, `recovery-development-v3/` observed **10/10 candidate and 7/10 control** development passes, with **no tracked source drift**. Both arms receive the same script and can discover available tools; the synthetic provider retains the actual QuickJS result before losing its acknowledgement. The candidate discovers `harness_reconcile`, checks that receipt, and preserves the original unknown witness without another write. The control failures are repeated equivalent execution, unbounded strategy accounting, and unknown-write reconciliation. This is a controlled mechanism comparison on supplied strategies, not a 30-point autonomous recovery improvement. Recovery validation was unexecuted at v3; protected cases remain unexecuted. `reconciliation-native-smoke-v1/` separately records the actual Aiko actor for the unknown-write family.

`reconciliation/` retains both Bun and AccountStorage native code-tool traces: actor `aiko`, instance `recovery-test`, thread `user-123`, two scripted model calls, one synthetic write and one receipt read. Complete event equality and unchanged model/write/read counts were checked after host reconstruction. A separate regression executes a real sandbox network action against an in-process synthetic transport, loses the acknowledgement after receipt custody, and checks the retained receipt through the original verifier. No external provider or real recipient was contacted. `reconciliation-evidence.json` records hashes and exact check results.

The current runner dataset digest differs from the earlier procedural v2 dataset because the recovery definitions are now executable. Earlier reports remain immutable evidence of their own frozen dataset/source, and do not validate the current candidate.

## Recovery worker evidence — 2026-09-08

**Partial implementation, not phase acceptance.** Reconciliation of the actual interrupted artifacts found `recovery-validation-v1` at 5/5 candidate and 3/5 control with no tracked drift. The unfinished `recovery-development-v4` had completed at 10/10 candidate and 7/10 control **with source drift** and did not match validation. Both remain unchanged. Control validation failed original-deadline and concurrent-strategy checks.

The recovery handoff now includes checked partial-result references and the unmet success condition when a repeated call is stopped, an uncertain write blocks further writes, or the original recovery deadline expires. These paths do not reset budgets, complete the parent or change the unknown witness. Two added regressions check exact parent partials, unchanged execution counts and reconstruction.

Fifteen proactive development/validation drivers now mount `createAikoActor`, `createReflectionActor`, native tools/private code sandbox, AccountStorage, coordinator, native waits and outbox. The direct-answer case must obtain an actual native read receipt. Silent cases require valid reflection completion, so a fixture/model crash cannot count as useful silence. Work cases declare synthetic initial task/receipt state; they do not prove upstream correspondence verification. Calendar substitution plus real native `AlarmFired` events checks quiet hours/DST, not physical scheduler latency.

The initial proactive diagnostics are preserved: v2 omitted the fixture's required native output mode; v3 exposed a missing exact correction `supersedes` reference and a checker incorrectly counting repeated wait records as distinct pending topics. Fixes preserve actual native contract and lifecycle checks, rather than substituting success flags. The legacy single-notice protocol is not penalized merely for lacking v2's duplicate-omission metadata.

### Source and experiment integrity

All new artifacts are under `artifacts/cognitive-behavior/cognition-recovery-20260908/`. Early snapshots v1–v4 and the `matched-*-v2` reports remain diagnostics: source enumeration accidentally omitted the linked browser runtime (a mixed-depth Bun brace glob returned no files), allowing shared dependency fallback. A regression caught this. Subsequent snapshot/build checks also exposed required exported workspace `dist`, server/database-client files and the public database CA certificate. No earlier snapshot was repaired in place or relabelled as isolated evidence.

The corrected current-dirty snapshot is `/home/deck/tmp/cognition-candidate-20260908-v5/source`; `snapshot.json` compares original-before, original-after and copied hashes. It includes the resolved sibling browser runtime and redirects workspace source links. Its digest is `sha256:0a75fb3f6b0d34ac3d0255774d5a0e6e78f6a45de3cec89c997ed641e9ea157d`; final dataset digest is `sha256:274e24038a4d8d1e782ac5902ff760d49112ebcbf940a8029db63ee4fa3930ef`. Registry dependency bytes remain shared, with the lock retained; this is **not** a hermetic dependency or deployed build claim. Existing exported dist is part of the copied candidate, not an assertion that it was freshly regenerated from source.

All `final-*/report.json` comparisons below use that same source/dataset and report no tracked drift. Each arm receives the same declared opportunity/strategy, with its respective native output contract. No protected candidate was sealed or executed.

| Final local comparison | Control | Candidate |
| --- | --- | --- |
| Recovery development, first eight catalog cases only | 5/8 | 8/8 |
| Recovery validation | 3/5 | 5/5 |
| Procedure development | 9/10 | 10/10 |
| Procedure validation | 3/5 | 5/5 |
| Proactive development | 5/10 | 10/10 |
| Proactive validation | 4/5 | 5/5 |

Recovery control failures remain repeated identical execution, strategy accounting and unknown-write reconciliation; validation fails deadline/concurrency checks. Procedure failures remain development/held-out input duplication and erased custody. Proactive control failures concern busy-owner timing/correction, legacy rejection of older support, withdrawal after premature dispatch and capacity; validation fails foreground arrival during voice preparation. These are supplied-program mechanism checks, **not** measured autonomous recovery gains, warm-call savings, judged notification precision/recall or independent held-out quality. Nonzero comparison exits preserve control failures; they are not all-green test suites.

The retained development evidence reaches the proposed **120 recovery executions** (including diagnostics), so no further recovery development was run. The final snapshot covers the first eight cases in fixed catalog order; `parent-still-failing` and `ordinary-wait` have earlier diagnostic/regression evidence, not final-snapshot paired development results. Procedure/proactive recorded development totals are 82/80, including the early procedure smoke without a run-start marker. `budget-audit.json` preserves accounting. A fresh directory cannot authorize a budget reset.

| Final snapshot check | Observed evidence |
| --- | --- |
| Recovery, proactive policy/outbox, manifest regressions | 61 passed, 0 failed, 359 assertions; `snapshot-v5-native-tests.log` |
| Dedicated evaluation-script TypeScript project | Passed; `snapshot-v5-scripts-typecheck.log` |
| Local Bun main bundle (`--packages=external`) | Passed, 212 modules; `snapshot-v5-bun-build.log` — not a Worker build/deployment |
| Protected/unsealed, insufficient-budget, direct-child and reused-directory requests | Rejected before case execution; gate logs retained |
| Final comparison identities/checks | `final-evidence.json`, individual native traces and reports |

Whole-plan blockers remain: ten reserved recovery/proactive drivers, independent protected authorship, authoritative general task association for older evidence and other tool paths, selected trusted-contract transfer/repair integration, a preserved equivalent pre-change/simple/combined baseline, blinded/provider measurements and full workspace/Worker gates. Requests for reserved `background.ts`, actor/router/host and library seams are in `.agent-grid/notes/recovery-20260908/requests/cognition.md`; no out-of-scope runtime files were edited by this worker. Recovery development now additionally needs an explicit budget decision. No owner rollout, live mutation, paid comparison or quality/SOTA claim was made.

## Continuation correctness checks — 2026-09-08

The resumed worker made no additional comparison runs. Recorded development executions remain recovery **120/120**, procedures **82**, proactive **80**. No protected case, candidate seal/repin, paid inference or rollout was authorized or performed. The earlier v5 comparison snapshot is historical evidence, not validation of subsequent source changes.

- Recovery now uses one exact-parent deadline helper in its producer and atomic append fence. It takes the earlier valid message/call deadline and the existing 60-second ceiling; malformed original budgets cannot acquire a fresh allowance. Explicitly foreign parent/tool/cancellation rows cannot bind or cancel the owned task; legacy unowned native rows remain supported.
- Proactive policy ignores explicitly foreign acceptance/suppression/delivery receipts when settling owned waits, accounting for admission reservations and checking atomic admission/dispatch. A foreign Started row cannot supply an owned dispatch claim. Owned and legacy unowned receipts still prevent replay.
- Recovery host regressions now mount the actual `createAikoActor`, existing deterministic owner indexer, native code tools and private sandbox on both Bun and AccountStorage. Reconciliation retains the actual QuickJS result before synthetic acknowledgement loss and reads it through the original checker. Each host records one write and one receipt read, retaining the original unknown witness. Restart preserves all rows and execution/inference counts. These are offline mechanism tests, not autonomous performance evidence.

Evidence is retained under `artifacts/cognitive-behavior/continuation-20260908T161218Z/`:

| Check | Result and limit |
| --- | --- |
| Latest recovery, proactive policy/outbox, library and watch-action regressions | **103 passed, 0 failed, 612 assertions**; `focused-native-v7.log`, `native-v7/`. Five explicitly addressed files; selected source hashes matched before/after, not a hermetic snapshot. |
| Latest agent TypeScript check | Passed under the shared lock; `agent-typecheck-v5.log`. Earlier lock-contention exits remain recorded. A concurrent explicit `Event` annotation corrected the new fixture's spread-inference type; it was preserved before the final type and native checks. |
| Shared outbox owner projection | **Unresolved failure** in `foreign-outbox-projection-v3.log`: a foreign delivery receipt removes an owned pending send transition. No effect or host ingress ran; this does not establish an exploitable hosted ingress path. Shared `actor.ts` projection and retained receipt queries require integration's owner-scoped fix and native restart coverage. |

Failed evidence remains intact: initial owner/deadline regressions; an underconfigured AccountStorage indexer fixture; the subsequently corrected indexer inference layer type; two outbox probe setup errors; and `focused-native-v5.log`, whose unprefixed Bun path filters also discovered another session's incomplete release-copy tests (103 own checks passed, five copy-loader errors). Explicit `./apps/…` paths fixed selection without modifying the other session's copy.

**17:40 UTC recheck:** later actor changes mount login/promise tools, not the requested receipt-scope fix. The existing outbox projection probe still fails; the native five-file suite passes **103 tests / 612 assertions**, and agent types pass under the shared lock. Evidence: `artifacts/cognitive-behavior/recheck-20260908T174032Z/`. Concurrent login-tool source drift among 17 selected inputs prevents an isolated current-source acceptance claim. No runtime/test edits, comparisons, protected execution, repin or rollout were made in this recheck.

General task association remains blocked on a trusted source-job field: title-based older-evidence retrieval supplies neither task identity nor authority. The exact producer → retained context → decoder → admission → outbox contract, broader receipt/custody seams and trusted-contract transfer/repair selection still need coordinated work. Current requests and the final partial result are under `/home/deck/.pi/task-recovery/2026-09-08/requests/cognition.md` and `results/cognition.json`. Full-plan acceptance remains open; no acceptance threshold changed.

## Outbox owner isolation — 2026-09-09

The foreign-receipt projection defect recorded above is fixed in the native `voiceAndOutbox` component. Explicitly foreign rows cannot reserve its effect keys, change its reply projection, or satisfy its retained pre-dispatch/post-claim queries. Owned and legacy unowned lifecycle receipts keep their existing meaning, including holding an uncertain send without replay. This extends the existing actor; it introduces no scheduler or delivery ledger.

The regression requires foreign suppressed/prepared/settled rows to exist in native history before reconstructing each Bun and AccountStorage host. An additional interleaving inserts a foreign settlement after the owned atomic dispatch claim; the owned sender executes once and restart does not resend. Projection checks also cover foreign Started rows and owned/legacy unknown settlements. The first Bun fixture accidentally supplied an invalid Started batch and was rejected by the append fence; the corrected test checks retained-row presence, so rejection cannot earn a pass.

Evidence is under `artifacts/cognitive-behavior/outbox-owner-20260909/`: seven relevant regression files passed **146 tests, 995 assertions**, with no failures; the original projection probe now passes; the local Bun bundle passed (240 modules, registry packages external). The dedicated evaluation-script TypeScript project, which imports the actor, passed. Whole-agent TypeScript checking failed in the concurrently added `test/native-replay.test.ts:110` (`Layer` type mismatch); that file was preserved. These are shared-worktree offline checks with hashes captured after execution, not a frozen comparison, Worker/deployment gate, foreign HTTP-ingress witness or migration of historical persisted foreign keys.

No comparison, protected case, candidate repin, paid inference or rollout ran. Recovery development remains at its recorded 120-execution ceiling. The full plan's remaining acceptance work below is unchanged.

## Rollout

Both Bun and Worker assembly use comma-separated lists of at most 64 owner IDs:

| Setting | Behavior |
| --- | --- |
| Neither list contains the owner | Existing behavior; new contribution policy disabled |
| `AIKO_COGNITIVE_CONTRIBUTION_SHADOW_OWNERS` | Form/retain decisions and account for inference; suppress v2 dispatch |
| `AIKO_COGNITIVE_CONTRIBUTION_OWNERS` | Enable v2 admission/delivery for that owner; takes precedence over shadow |
| `AIKO_COGNITIVE_RECOVERY_OWNERS` | Independently enable the experimental harness-library recovery slice for that owner; absent/empty disables it |

No deployed target was enabled during this implementation. Existing user preferences are preserved. The foreground actor retains `AikoProactiveContributionPolicy` changes: disabling retires pending v2 decisions, and reenabling cannot resurrect them or shadow decisions. History and receipts remain. Legacy work notices keep their old contract when the experiment is disabled. Already reserved sends keep conservative settlement semantics.

## Evidence

Synthetic local artifacts are in `artifacts/cognitive-behavior/` (gitignored); live owner memory was not imported.

| Check | Observed result |
| --- | --- |
| Pre-change native baseline | 61 passed, 0 failed, 436 assertions; `baseline/native-tests.log` |
| Focused candidate suite before six negative-output additions | 104 passed, 0 failed, 728 assertions; `phase1-tests.log` |
| Negative v2 native cases | 6 passed, 0 failed, 30 assertions; `negative-contribution-tests.log` |
| Prerequisite slice | Deliver/revise/cancel/withdrawn-evidence: 4 passed, 48 assertions; `first-slice-tests.log` |
| Mid-voice foreground interruption | Bun and AccountStorage host variants passed; `outbox-defer-tests.log` |
| Native adapter budget | 1,024/4,096 host allowances yielded 1,024/1,500 wire limits and one synthetic 503 request without fallback; `model-bound-tests.log` |
| Recovery, library and source checks | 51 passed, 0 failed, 302 assertions; Bun and AccountStorage replay included; `recovery-tests.log` |
| Recovery build checks | Agent typecheck, Aiko build and Worker dry-run build passed; `recovery-typecheck.log`, `recovery-build.log`, `recovery-cloud-build.log` |
| Procedure and recovery checks | 40 passed, 0 failed, 233 assertions; native metadata-tool invocation included; `procedure-tests.log` |
| Recovery partial-result checks | 15 passed, 0 failed, 104 assertions, including Bun/AccountStorage restart; `recovery-partial-tests.log` |
| Recovery partial-result integration | Library/source checks: 42 passed, 0 failed, 244 assertions; `recovery-partial-integration-tests.log` |
| Recovery partial-result typechecks | Agent and dedicated script projects passed; `recovery-partial-typecheck-v2.log`, `recovery-eval-typecheck-v2.log`. Initial agent check caught a test-only spread type error, fixed before the passing rerun. |
| Recovery partial-result builds | Aiko build and Worker dry-run build passed; `recovery-partial-build.log`, `recovery-partial-cloud-build.log` |
| Reconciliation boundary tests | 32 passed, 0 failed, 207 assertions; `reconciliation-tests-v3.log` (includes seven sandbox journal tests). |
| Reconciliation native host tests | 27 passed, 0 failed, 188 assertions; `reconciliation-native-tests.log`, including separate Bun/AccountStorage reconciliation replay traces. Overlaps the recovery cases above; do not sum as independent families. |
| Reconciliation adapters | Compute dispatcher and browser-watch callers: 13 passed, 0 failed, 108 assertions; `reconciliation-adapter-tests.log`. |
| Reconciliation broader checks | Earlier five-file run: 74 passed, one sandbox timeout; targeted timeout rerun passed (`reconciliation-tests-v2.log`, `reconciliation-timeout-recheck.log`). The failed run remains evidence. |
| Reconciliation types/builds | Dedicated script typecheck and Aiko/Worker dry-run builds passed. Whole-agent typecheck v3 passed; latest v4 failed in concurrently edited `code-workers.test.ts` and `codegraff.test.ts`. See `reconciliation-*-typecheck*.log`, `reconciliation-typecheck-v4.log`, `reconciliation-build.log`, `reconciliation-cloud-build.log`. |
| Procedure integration checks | Acquisition, experiments and sources: 64 passed, 0 failed, 661 assertions; `procedure-integration-tests.log` |
| Procedure build checks | Agent typecheck, Aiko build and Worker dry-run build passed; `procedure-typecheck.log`, `procedure-build.log`, `procedure-cloud-build.log` |
| Workspace typecheck/build and Aiko build | Passed; respective logs retained |
| Worker bundle | Wrangler dry-run build passed; `cloud-build.log` |
| Full repository tests | Ended with SIGTERM after failures/timeouts; incomplete, not green (`workspace-tests.log`). The old process handle is gone. Both batch cases passed earlier isolated reruns (`batch-recheck-tests.log`). |
| Real workerd verifier | Failed: non-JSON second-account response, then request timeout on diagnostic rerun; investigation pending |

The baseline manifest pins revision `f7d837a5cf61be268319478e6e69ab24f0b5e5a7`, 447 file hashes, dirty diff digest, and source digest `e269912ca163c5c74b97733ddf2224ab896ebf95abd764fcd61587ce83f2e332`. Exact copies are at `/home/deck/tmp/aiko-cognitive-baseline-ip25zwu3/source`. Concurrent unrelated changes must be accounted for in a matched comparison. Different-sized passing suites are not a performance comparison.

`recovery-evidence.json` records the recovery source hashes and synthetic traces under `recovery/`. Both hosts used actor `aiko`, instance `recovery-test`, thread `user-123`: 50 retained rows, two synthetic model calls and three task executions (two failed attempts and one checked alternate). Complete row equality and unchanged execution/inference counts were checked after host reconstruction. These are native-host fixtures, not CLI/Voyager or real-provider recovery runs. Source hashes were captured after checks in the shared worktree; they do not establish an isolated immutable candidate build.

`procedure-evidence.json` records the later procedure source and test-log hashes. Its measurements are synthetic regression evidence; there is no matched performance comparison or real-provider learning-cost result.

## Native CLI compatibility

Use the repository-pinned CLI; the global `tdg` has an older interface. The [isolated entry](../apps/agent/scripts/cognitive-cli/actor.ts) calls the real `createAikoActor` factory with synthetic memory/inference and no physical sender.

```sh
bun apps/agent/node_modules/tardie/src/cli/main.ts build apps/agent/scripts/cognitive-cli/actor.ts --out artifacts/cognitive-behavior/cli/build --json
```

From the fixture directory, start the pinned CLI with `dev --port 43829 --no-open </dev/null`. Closed stdin avoids interactive provider setup. From the repository root:

```sh
bun apps/agent/node_modules/tardie/src/cli/main.ts methods --url http://127.0.0.1:43829 --json
bun apps/agent/node_modules/tardie/src/cli/main.ts call message '{"text":"Verify the isolated native actor can answer this direct request.","model":{"provider":"fixture","model_id":"offline"}}' --thread user-123 --id cognitive-cli-direct-3 --url http://127.0.0.1:43829 --json
bun apps/agent/node_modules/tardie/src/cli/main.ts events user-123 --url http://127.0.0.1:43829 --json
```

Actor name: `aiko`; CLI instance: `main`; logical thread: `user-123`; native thread: `ag.user-123`. The call completed. Restart and the same invocation left all 19 retained rows unchanged, with one total synthetic `ModelCalled`. Two earlier calls without an explicitly selected model failed and remain in the trace. This proves CLI build/method/replay compatibility, not a complete hosted assembly or provider-backed behavioral evaluation.

Local Voyager is `http://127.0.0.1:43829/?thread=user-123` while the fixture server runs. It was stopped after capture; JSON traces remain under `cli/`. Captured build digest: `sha256:cf2437f7f23bf3078ba3da472df13b2ea70a1ce9c3d6f4dc2e8f5fe39254f161`; rebuild after source changes.

## Remaining acceptance work

1. **Phase 0:** implement the ten remaining reserved recovery/proactive drivers without using protected outcomes to tune; obtain independently authored family-level splits (the audit found current cross-split dependence); complete immutable baseline assembly and matched current/simple/individual/combined comparisons. The current 50-driver workbench is not full phase acceptance. Further recovery development needs an explicit budget decision. Existing regressions are not the protected performance set.
2. **Phase 1:** complete general task association for older evidence, coverage/revision metadata, bounded contextual reevaluation beyond deterministic rechecks, and broader adversarial/performance coverage. Inspect the conservative known-no-send outcome when the owner becomes busy after dispatch reservation.
3. **Phase 2:** extend the initial library mechanism to other existing task/tool paths and relevant work versions; complete provider-specific outcome reconciliation and cross-contract action identity, extend partial-result accounting and measured strategy selection; test broader deadline, authority and interrupted-write cases. The implemented slice is not full phase acceptance.
4. **Phase 3:** apply and evaluate transfer requirements in selected trusted contracts, integrate procedure selection/parameterization and dependency-triggered bounded repair, and measure total cold costs and warm savings. The new evidence metadata and opt-in transfer checks do not establish full phase acceptance. Existing acquisition is not acceptance evidence for these additions.
5. **Phase 4:** finish full gates, isolated provider runs, fixed-budget GEPA comparisons, blinded usefulness/timing ratings and latency/cost measurements, followed by authorized shadow/limited rollout.

Real-model quality, provider tokens/spend, p95 latency, recovery improvement and procedural savings are **unavailable**. Synthetic tests incurred no paid-provider spend. No policy was promoted. The plan's acceptance thresholds are unchanged.
