# Main actor: catalogue alignment

Checked 9 September 2026 against `/home/deck/work/agent-harness/HARNESS-DESIGN-CATALOGUE.md` (catalogue inspection dated 8 September). This is **an operating-policy integration and a focused completion-boundary fix**, not certification of the catalogue's entire proposed combined system.

## Decision

A person asking Aiko to do substantial work needs the result, an honest account of what was checked, and a recoverable explanation when work cannot finish. Ending a conversation must not substitute for accomplishing that task.

The main [`aiko` actor](../apps/agent/src/actor.ts) now mounts [`aiko-task-discipline/v1`](../apps/agent/src/main-actor-policy.ts) through native `system(...)`. It covers goal/acceptance planning, persistent working notes, scoped delegation, verifier challenges, delivered-artifact checks, bounded context, proof-aware reuse, uncertain effects and explicit blockers. Its 4,842-byte text is self-contained: neither host needs the private archive or its absolute path at runtime. Worker identities, output contracts, permissions and feature rollout flags are unchanged.

Use the existing Tardigrade loop, native calls, journals, children, waits and cancellation. Do not import archived Stop hooks, Cell/YAML controllers, shell retry loops, caches or generic “satisfied” ledgers. The catalogue itself distinguishes useful mechanisms from unproven combined-system claims.

### Enforced response ordering

Native tool batches run concurrently. Previously, a non-coding main turn could batch a work call with `respond("Everything was checked")`. The response did not depend on that work's receipt. Coding had a narrower guard; it also allowed a batch containing multiple final replies.

The existing [`withRequiredResponse`](../apps/agent/src/channel-response.ts) binding now rejects **any multi-call action containing a final response**, before admitting the ordinary batch dispatch. This includes two final replies, not just a reply plus work. The coding gate uses the same final-call classifier. Both production hosts already mount this response binding; no new host loop or scheduler was added.

- The native failure retains usage, model endpoint/mode and an actionable diagnostic. The existing outbox may deliver its safe failure notice, never the rejected success draft.
- The rejected batch is not partially admitted, silently rewritten or automatically retried. The original request and failed native epoch remain available for existing resume/cancel controls. Earlier authorized speculative reads can already have run during inference; rejection is not rollback or evidence of zero prior effects. Inspect those receipts before retrying.
- Independent reads and non-final progress batches still work. One standalone final call, including `respond(..., outcome:"blocked")`, retains existing behavior.
- Code-mode response controls were **already excluded** from `tools.call` by [`CodeHarness`](../apps/agent/src/code-harness.ts). Keep final responses direct, after `execute` settles. This change does not add another dispatch path.
- Existing final-delivery receipts, including unknown sends, still stop inference without another send. Historical receipts are not rewritten.

Rejecting an unsafe batch is less automatic than dropping its final call and running the rest. It preserves the native all-or-nothing admission contract and avoids guessing which effects the model intended. Reconsider a bounded native correction protocol only with evidence that it improves recovery without duplicate effects or hidden calls.

**This gate proves ordering, not truth.** A standalone sentence can still overclaim. Fresh coding checks and independently verified library contracts remain the mechanical outcome checks in their supported domains. Generic natural-language acceptance, mandatory cold review and automatic milestone advancement are not universally enforced by this policy.

## Catalogue map

These are inspected native foundations and policy choices, not eleven newly implemented or independently benchmarked features.

| Catalogue design | Native application and boundary |
| --- | --- |
| 1. Runnable completion check | Keep [coding verification](native-harness-parity.md) and the [library's pinned verifiers](../apps/agent/src/harness-library.ts); add the general final-batch guard above. No universal verifier for arbitrary user requests is claimed. |
| 2. Test the checker | Policy calls for relevant negative controls in disposable fixtures. New native regressions reject premature completion; existing [coding tests](../apps/agent/test/coding-workspace.test.ts) challenge stale/failed checks. Never damage live state or rewrite both a result and its accepted manifest. |
| 3. Independent review | Use existing [native workers](native-harness-parity.md) with the original requirement, exact evidence and a bounded brief. Main actor synthesizes findings. Reviewer selection remains model guidance, not an automatically mandatory second model. |
| 4. Persist before deferring | Reuse private [working-data custody](../apps/agent/src/code-data.ts), native tool journals and [compute dispatch fences](../apps/agent/src/sandbox-compute.ts). Native waits/receipts own continuation. This does not certify every browser producer's crash/power-loss boundary. |
| 5. Exercise the delivered tool | Policy requires the normal install/invoke/readback journey when authorized. The CLI exercise below calls the real main actor through the repository-pinned Tardie CLI; no live website or deployment is represented by it. |
| 6. Bounded orientation and tools | Keep native compaction, `tools.search/describe/call`, retained handles and bounded queries. Read full detail on demand. Added policy bytes are measured; real-model total tokens/latency are not. |
| 7. Searchable session evidence | Keep [native log following](../apps/agent/src/log-memory.ts) and scoped entity-learn memory. Summaries/working notes are navigation and claims, not replacements for raw evidence or new authority. |
| 8. Validity-bound reuse | Use existing [library/procedure checks](aiko-cognitive-behavior-status.md#procedure-evidence) and [pinned saved workflows](request-memory-and-workflows.md), not the archive's incomplete repository fingerprint. A working binding alone does not certify freshness. |
| 9. Destination verification | Instruct the actor to inspect the actual destination/artifact after authorized transport. Missing state stays unverified. No blanket deployment verifier or new publish authority is introduced. |
| 10. Persistent milestones | Native requests/epochs preserve original work; code-mode working notes can retain requirements, partials and next steps. Existing secretary commitments remain their own domain controller. A general immutable goal/obligation state machine with automatic criterion evaluation remains a gap. |
| 11. Consensus/escalation | Retain as an explicitly budgeted experiment through existing evaluation machinery, not a default voting requirement, proof of correctness or claim of savings. Existing experimental recovery/contribution opt-ins are unchanged. |

## Verification

Local synthetic evidence is under `artifacts/main-actor-catalogue/` (gitignored).

| Check | Observed result |
| --- | --- |
| Existing response/coding baseline | 50 passed, 0 failed; `baseline.log` |
| New premature-batch check on old boundary | Both Bun and AccountStorage cases reproduced the bug: expected failure terminal was absent; `negative-baseline.log` |
| Focused candidate regression suite | 107 passed, 0 failed, 683 assertions across six files; `regression.log` |
| Normal agent build | Passed, including entity-learn integrity; `build.log` |
| Agent typecheck | Final rerun passed; `typecheck-final.log`. Initial concurrent memory-authority errors remain in `typecheck.log`. |
| Worker types/build | Full `aiko:cloud:build` passed, including Worker types and Wrangler dry run; `cloud-build.log`. Initial concurrent memory-authority type error remains in `worker-types.log`. No deployment. |
| Final response-only rerun | 39 passed, 0 failed, 218 assertions; `response-final.log`. Overlaps the six-file suite; do not sum these counts. |
| Native CLI build, methods, calls, restart | Built; valid call completed, premature batch failed before dispatch; restart plus duplicate valid invocation left the entire retained event list unchanged. |

The six-file suite comprises `main-actor-catalogue`, `channel-response`, `coding-workspace`, `native-tool-batches`, `code-harness` and `telegram-tools`. It covers real main-factory assembly on Bun/AccountStorage, all five final response kinds, multiple finals, usage retention, explicit blockers, code-mode control exclusion, ordinary concurrency, cancellation, epoch scoping and unknown-send replay. AccountStorage uses a local SQLite fixture, not deployed workerd.

The first new-suite run also failed two policy-presence assertions and two incorrectly written code-mode fixtures. Those code fixtures expected a callable response control, but the existing package deliberately excludes it; they were corrected to test that exclusion and use direct progress. These four failures are **not** evidence of four runtime fixes. The unchanged premature-batch test is the reproduced before/after defect. Differently sized passing suites are not an agent-performance comparison.

The scripted successful run supplies its strategy and expected evidence. No independent model reviewer or paid inference was run. Semantic task success, net cost, tokens, latency improvement and held-out autonomous behavior remain unmeasured. No new dependencies, rollout enablement or deployment were made by this change. The initially failing memory-authority typechecks cleared after those concurrent changes were corrected; this task did not edit those files. Other agents were editing the workspace concurrently; this is not a frozen whole-repository comparison. The broader [cognitive acceptance work](aiko-cognitive-behavior-status.md#remaining-acceptance-work) remains open.

### Reproduce the native CLI exercise

From the repository root, build the [isolated entry](../apps/agent/scripts/main-actor-catalogue-cli/actor.ts):

```sh
bun apps/agent/node_modules/tardie/src/cli/main.ts build apps/agent/scripts/main-actor-catalogue-cli/actor.ts --out artifacts/main-actor-catalogue/cli-build --json
```

Start from `apps/agent/scripts/main-actor-catalogue-cli/`:

```sh
bun ../../node_modules/tardie/src/cli/main.ts dev --port 43837 --no-open </dev/null
```

In another shell at the repository root:

```sh
bun apps/agent/node_modules/tardie/src/cli/main.ts methods --url http://127.0.0.1:43837 --json
bun apps/agent/node_modules/tardie/src/cli/main.ts call message '{"text":"checked","model":{"provider":"fixture","model_id":"offline"}}' --thread user-123 --id catalogue-checked-v3 --url http://127.0.0.1:43837 --json
# Expected nonzero exit and failed native invocation, with no batch calls dispatched:
bun apps/agent/node_modules/tardie/src/cli/main.ts call message '{"text":"premature","model":{"provider":"fixture","model_id":"offline"}}' --thread user-123 --id catalogue-premature-v3 --url http://127.0.0.1:43837 --json
bun apps/agent/node_modules/tardie/src/cli/main.ts events user-123 --url http://127.0.0.1:43837 --json
```

Actor `aiko`, CLI instance `main`, logical thread `user-123`, native thread `ag.user-123`. Bind the fixture to that exact native thread; do not weaken the production response tool's owner/thread check. The first CLI attempt used the logical thread as its binding and was correctly rejected; that diagnostic remains in `cli-events-initial.json` and the final history. After correction, the new invocation completed normally. The fixture does not provision services, use customer memory or send Telegram messages. The CLI's warning about absent provider configuration is expected; each call explicitly selects the offline fixture route.

Final CLI captures use the `*-v3.json` artifact names; the entire history, including earlier diagnostic invocations, was byte-identical in `cli-events-v3.json` and `cli-events-replay-v3.json`. Captured final build digest: `sha256:2e3d9c6a084f2c51b30bc5cb25923bc1a4fe5518a01d45cc7e08af8209a0a5ef`. Rebuild after source changes. The local Voyager trace is `http://127.0.0.1:43837/?thread=user-123` while the fixture server runs; JSON traces survive stopping it. The server was stopped after verification.
