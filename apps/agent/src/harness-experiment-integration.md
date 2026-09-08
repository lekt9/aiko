# Native harness experiments

`HarnessExperiment` advances an immutable experiment through native actor effects. It uses `HarnessLibrary` for sandbox execution and independent contract witnesses. The event log owns reservations, lineage, evaluation progress, cancellation and the final decision; there is no experiment queue or scheduler alongside Tardigrade.

The configured binding supplies a fixed fixture preparation protocol, a development-only reflection adapter and current authorization. A model response can replace only the named baseline source files. It cannot replace the contract, verifier, cases, runtime, permission scope, comparison policy or limits. Dependencies for changed existing modules are repinned from their exact source. Source diffs, hypotheses and development feedback stay in owner-private retained storage.

## Host configuration

Mount `harnessExperimentWaitMethod` as `harnessExperimentWait` and wrap `harnessExperimentComponent(binding)` with native `handles(harnessExperimentWaitMethod, ...)`, beside `harnessLibraryComponent(owner)`. Add `harnessExperimentTools(binding)` to the existing CodeHarness native tools. The binding must use the same owner, thread, private blob store, sandbox and trusted verifiers as the library. `harnessLibraryAppendAllowed` includes the experiment reservation, child-witness and cancellation fences; the host must run it inside the append transaction. External input must not mint `AikoHarness*` facts.

Keep the native wait method and lifecycle mounted when execution becomes unavailable. `harnessExperimentLifecycle(owner)` uses the same deadline and terminal projection without a library, private brief, model or sandbox; use it in place of the full component when no executable binding is available. This preserves expiry and retained cancellation without granting new execution. Already admitted child work additionally needs its metadata and Router cleanup path; a parent settlement alone does not attest that a child or external effect has stopped.

Production execution supplies `binding.trials: HarnessExperimentTrials`, mounts its parent component, and routes admitted child threads to its worker through the existing host. Follow the [native trial assembly](harness-experiment-trials-integration.md) for exact lineage, Router, event keys, private read scope and cancellation requirements. The controller and adapter must share the same library binding object. Standalone callers that omit this adapter retain local controller execution; that path does not attest fresh-child isolation.

The host authorizes experiment start, each advance, reflection, cancellation and private promotion. `prepare` must establish the pinned fixture/cache regime and is called only after current controlled-fixture authorization. It must report its actual cost and resource counts; unavailable measurements remain unavailable. The proposal adapter receives a maximum generated-token count and deadline, and must enforce those limits through the host's existing inference transport. It receives development witness evidence and comparisons, never fixture inputs/outputs or held-out trajectories.

A retained proposal with `status: "no-hypothesis"` stops the experiment and retains the baseline with reason `no-supported-hypothesis`. It does not open the held-out set or launch further trials. The same metadata projection settles a crash between that proposal receipt and terminal settlement without private artifact access or execution bindings. Reservation, held-out admission, promotion and child execution all respect this stop receipt; existing children use their native cancellation/reconciliation path. Completed development evidence remains available for inspection.

Reported completion tokens above the retained per-proposal cap produce `budget-exhausted` with reason `proposal-token-limit-exceeded`. Use the minimum of the experiment limit, reservation and physical reflection request, so a narrower host policy also applies. The usage receipt remains recorded even if the proposal is rejected. Recovery can settle from that receipt without private artifacts; missing usage remains unknown rather than becoming zero or evidence of an overrun.

Daily inference exhaustion comes from the same ledger used by ordinary calls: Bun's SQLite account/global reservation or the Worker's atomic owner KV reservation. A denial before dispatch becomes `AikoHarnessReflectionSettled` with `status: "budget-exhausted"`, zero physical calls and unknown tokens/cost. Its owner, reservation claim, reflection claim, request, policy and parent digests must match the retained proposal. The experiment settles with reason `daily-model-budget-exhausted`; the native metadata lifecycle can recover that settlement without private artifacts, another inference call or sandbox execution. Provider failures, corrupt ledger rows and cancellations cannot supply this receipt. Admission checks the current log again at append, so retained cancellation wins over a racing denial or budget settlement. Cancellation after a successful quota reservation prevents dispatch and leaves the reservation spent.

The initial limits support two to eight repeats, up to three proposals, 48 evaluation runs and 20 minutes. A conservative per-trial and per-proposal cost ceiling can reserve spend before dispatch. If pricing or consumption is unavailable, fixed run/call/token caps still apply, while the monetary total stays unknown. Known preparation or execution spend remains visible as a lower bound. An adapter reporting spend above its promised ceiling stops further work and records the breach.

Importing the component performs no inference or grants. [Registry optimization](registry-optimization.ts) supplies the default host assembly: fixed stateless built-in cases, current owner policy, shared model budget, native child trials and a bounded trigger from repeated ordinary executions. Its Bun/Worker activation and deployment evidence are separate from the controller-level tests below. General repository-derived evaluators and production network/browser fixture reset policies remain additional trusted integrations.

`createHarnessReflection` uses native `Infer` with the existing `createModelRouting` transport and the same account ledger as conversation inference. One retained proposal operation permits one physical request, with no retry ladder or provider fallback; its wire token limit is the lower of the request and host limits. Only development feedback and the pinned source surface enter its isolated trajectory. Tool responses, edits outside that surface and invalid output cannot produce a candidate. A retained private response recovers a lost acknowledgement without another model request. Completion-token accounting requires an explicit raw provider count; missing or partial usage remains null. Reflection policy version 2 pins that measurement rule, so older policy receipts cannot silently acquire its evidence claim.

## Agent entry

Discover `harness_experiment_start`, `harness_experiment_status` and `harness_experiment_cancel` through `tools.search/describe`. `start` takes a `request` object. This example assumes an explicitly configured controlled-network fixture binding; the default stateless JavaScript policy has narrower limits and cannot authorize it:

```js
await tools.call({
  name: "harness_experiment_start",
  arguments: { request: {
    id: "reduce-repeated-reads",
    baselineDigest: currentStableDigest,
    mutableFiles: ["network.json"],
    repeats: 2,
    policy: {
      version: 1,
      objectives: [{ metric: "networkRequests", direction: "min", tolerance: 0 }],
      qualityTolerance: 0
    },
    limits: { candidates: 3, runs: 48, wallMs: 1200000, proposalTokens: 2048, costUsd: 3 }
  }}
});
```

The baseline must be the current verified route in the pinned context. This call registers work; native effects advance it after the foreground turn settles. Code does not wait on a JavaScript timer or perform the trial itself. `proposalTokens` is a numeric generation budget accepted only by this declared tool schema; credential strings and other credential fields remain rejected.

## Evaluation and recovery

Each candidate runs the same development cases with unique operation IDs for every repeat. With native trials, each candidate/phase/case/repeat owns a separate child thread and a child-specific sandbox binding. Preparation commits once before the durable child request; an existing reservation without preparation evidence never runs the reset again. `pending` ends the controller advance while the native host drives the child and returns its receipt.

The adapter joins the actual child's `AikoHarnessRunStarted` and `AikoHarnessChecked`, its retained private input/witness, and the exact source/target lineage. The controller then records `AikoHarnessExperimentTrialWitness`, retaining the child, input and witness references. The parent never emits a pretend local execution. Projection and append fences require the exact registered experiment, reservation, preparation, child request and joined witness digest/input reference. This makes the checked child result available to the existing comparison/promotion path without exposing a witness-import tool. Changed scores, cases, inputs or child references cannot reuse a verified join.

Fixed quality checks and hard constraints determine eligibility independently of resource objectives. Failed runs remain in the archive. Pareto comparisons keep distinct tradeoffs and use observed repeat ranges; those ranges are not confidence intervals or tail-latency estimates. Unknown quality or required measurements cannot win selection. The current automatic promotion policy requires conservative improvement over the baseline; broader preference-driven routing among tradeoffs remains separate work.

Once search closes, the survivor set is fixed. Only then can baseline and survivors use the final cases. A previously exposed final set cannot support another experiment's final decision. No reflection is invoked after this boundary. Promotion requires final witnesses, per-case no-regression checks, the recorded policy, current authorization and the original route generation. Cancellation committed before the promotion append prevents publication atomically.

Preparation, admission, sandbox build/run, verification and joining contribute to retained trial accounting. Preparation resource counts are added to the verified sandbox counts. Child-trial elapsed time uses a retained start on the current process's monotonic clock and includes the handoff and join. The clock epoch is measurement metadata and grants no authority. If recovery cannot compare the original clock epoch, total trial latency is null; the child's own execution latency is not substituted for it. Historical output bytes remain private checker custody.

A reservation with no conclusive receipt stays unknown. Concurrent observers cannot settle over the active owner. Reconstruction can restore a missing trial acknowledgement from retained preparation plus the exact checked witness. Missing brief/output custody is unavailable. Lost proposal acknowledgements do not cause another model call. The native method deadline arms before foreground deferral and survives host restart; actual `AlarmFired` expires an idle experiment even if its private brief is missing. Cancellation interrupts active controller work and the trial adapter routes cancellation to admitted child work. Already dispatched external effects still require their normal reconciliation evidence.

## Current evidence and remaining scope

The executable fixtures in `test/harness-experiment.test.ts` compare actual sandbox network DAGs against a controlled HTTP service. One candidate removes a redundant request: six requests become three per full case sweep, with two repeats. A complete native path uses 12 distinct child threads, verified witness joins and one real Infer request through the shared ledger to a controlled provider transport. Restart performs no extra job or model request. Another candidate passes development and fails the final negative-input case; the stable route remains selected. These are controlled runtime witnesses, not live-provider quality or deployed-host evidence.

The tests also cover native component execution and SQLite reconstruction, duplicate dispatch prevention, retained-witness recovery, cancellation at publication, fixed deadlines, frozen fixtures and source scope, cost ceilings, missing measurements and final-set reuse. Independent fixtures under `scripts/fixtures/self-composing-experiment-*.ts` audit the controller separately. Full plan acceptance remains open, including generalized contract registration, production fixture/session isolation, broader perturbations, optimizer-aware passive documentation, preference-based routing and deployed verification of the complete path.
