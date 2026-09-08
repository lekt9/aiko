# Native experiment trial children

`HarnessExperimentTrials` gives each candidate/case/repeat a separate native child thread. Its parent component and worker use the existing account host, `ChildCreated`, `Router`, `EventLog` and keyed effects. There is no trial scheduler, queue, inference component or persistent JavaScript promise.

The parent retains a private brief pinning owner, parent/child thread, experiment, operation, artifact, contract, verifier, evaluator, dataset, case, split, repeat, context and original deadline. Native handoff events carry the private brief reference and routing metadata. Candidate code receives only its selected fixture input through the ordinary sandbox job interface; other trial histories and model trajectories are never supplied.

## Mounts

Create one adapter for the owner with the existing parent library binding/journal. `authorize(scope, signal)` is trusted application policy: resolve the retained experiment and reservation, check the candidate and development/held-out phase, current cancellation, original deadline, generation and regime. A request does not create its own evaluation or monetary grant. Existing `authorize` and `authorizeEvaluation` checks also run before execution and joining evidence.

Supply `sandbox(scope, signal)` with the existing trusted placement, transport, current authority resolver and optional asset hydration. The adapter calls `createHarnessSandboxBinding` with the **child thread** itself; do not copy the parent's `execute` closure and merely change a label. The sandbox operation identity includes this child thread. Each worker mounts only the selected contract/artifact in its own native log and calls the real `HarnessLibrary.run` with the fixed case ID and expected context. Verification remains host-owned.

Mount:

```ts
// In the existing owner actor:
components: [...existingComponents, trials.component()]

// In actorFor(thread), before generic child selection:
if (harnessExperimentTrialIsChild(thread)) {
  return actor({ name: "aiko", methods: {}, components: [trials.worker()] });
}

// Compose with the account host's existing policy and keys:
allowChild: (parent, child) =>
  parent === library.thread && harnessExperimentTrialIsChild(child)
keyOf: event => harnessExperimentTrialEventKey(event) ?? existingKeyOf(event)
```

Keep `ownsThread` restricted to the owned root threads. The account host independently requires a durable `ChildCreated` edge with a matching operation ID before first child delivery; a matching name alone does not admit a thread. `readThread` must be that account host's owner-scoped retained-log reader. Preserve the existing native/library append guards and reject trial/library internal events at public ingress. `harnessExperimentTrialExternalEventAllowed` identifies this adapter's additional reserved event types. A child must not expose an API that allows a model, source artifact or provider to append `AikoHarnessChecked`.

The account host overwrites links on `AikoHarnessTrial*` deliveries from the authenticated outer Router envelope, as it already does for native messages and methods. A sibling child cannot supply a payload link pretending to be the root or another trial. The adapter also uses native `linkedEventOf(envelope)` and validates the resulting link against thread lineage. Work, Returned and Cancelled occurrence keys include their source/scope, so an invalid sibling message cannot consume the legitimate parent's cancellation identity. Unrelated custom-event behavior is unchanged.

## Recovery when execution is unavailable

Keep admitted lifecycle work mounted when the executable registry, sandbox transport or model grant is absent. The metadata-only factory needs the current owner scope and a trusted account-host root reader:

```ts
const retainedTrials = harnessExperimentTrialLifecycle({
  owner,
  parentThread: `user-${owner}`,
  readParent: () => host.read(`user-${owner}`),
});
// Select the full adapter when available, otherwise these same lifecycle projections.
const trialRuntime = trials ?? retainedTrials;
// Owner actor: trialRuntime.component()
// Admitted trial child actor: trialRuntime.worker()
```

The factory accepts no library binding, private store, execution grant or sandbox. Its parent component observes retained cancellation, terminal settlement or a real native `AlarmFired` and routes cancellation only along an existing exact `ChildCreated` edge. It never writes a new child edge or dispatches Work. Without an edge it records not-dispatched; an existing edge may receive cancellation before its first Work. Keep the experiment's native wait method and `harnessExperimentLifecycle(owner)` mounted separately so the existing host can produce deadline wakeups and settle its parent experiment even when execution is disabled.

The child verifies its actual native parent, authenticated envelope, owner, retained Requested metadata and the parent's matching native edge. A cancellation additionally requires the parent's real retained stop fact. An unstarted cancelled trial becomes unavailable; a retained RunStarted without Executed remains unknown. An existing Executed receipt takes precedence: its original status and witness reference can be returned without hydration or reevaluation. This return alone does not mint Joined, verify a private witness or make a candidate eligible. Work without cancellation or an existing Executed receipt remains idle until an execution-capable mount becomes available or the parent stops it.

The full adapter and metadata factory use the same parent cancellation and child cancellation/return projections, durable keys and trust checks. Mount one selected variant per root/child, preserving the existing owner host admission, event keys and public ingress fences. The `readParent` closure must resolve the current same-owner host root; artifact JSON or a caller-supplied parent log cannot substitute for it. No process timer, second queue, private hydration or new execution is introduced by recovery.

## Controller handoff

After the controller reserves and prepares a trial, call:

```ts
const result = await trials.request({
  experimentId,
  harnessDigest,
  phase, // development | held-out
  caseId,
  repeat,
  operationId, // harnessExperimentTrialOperation with these same fields
  contextDigest,
  deadlineAt, // original absolute experiment deadline
}, signal);
```

`pending` means the native host has work to drive. End this controller advance; do not poll or wait inside a promise. Include `AikoHarnessTrialJoined` and `AikoHarnessTrialUnavailable` in the experiment component's relevant event watermark so a native completion advances it again. Repeating the same request reuses the retained brief and child. Changed identity fields or deadline conflict; missing private bytes are not regenerated.

On `checked`, consume `result.witness`, `result.witnessRef` and `result.childThread`. The parent has already read the actual child's `AikoHarnessRunStarted` and `AikoHarnessChecked` facts, checked artifact/case/context/operation lineage, and compared the private witness against those facts. The retained Joined fact contains `witnessDigest = harnessDigest(verifiedWitness)` and the actual child RunStarted `inputRef` only after this check; a controller witness mirror must match both, as well as the private witness reference and child scope. The input reference is read from retained execution evidence after its private value matches the selected fixture; joining never recreates that input. A supplied score or digest alone cannot settle the trial. A checked witness can be `violated` or `unknown`; the controller's existing frozen evaluation and Pareto rules still determine eligibility. Every trial lifecycle fact carries `experimentId` so the existing experiment watermark observes progress.

The adapter leaves the authoritative `AikoHarnessChecked` receipt in the child log. The current controller, which reads parent-local library witnesses, needs an explicit integration step: either consume the joined witness directly and retain its locator, or append a trusted parent witness mirror after this verified join, recording its child thread and witness reference. Do not expose a generic witness-import tool. This module does not change the controller, promotion policy, host assembly or acceptance map.

`unknown` means execution may have occurred without a retained check; it never authorizes another execution. `unavailable` means scope, custody or checked handoff evidence could not be confirmed.

The parent component observes `AikoHarnessExperimentCancelled`, terminal experiment settlement and the existing native deadline's `AlarmFired`. It interrupts pending dispatch/join effects and sends a keyed cancellation through Router to each unfinished admitted trial. Cancellation uses the retained request metadata and exact `ChildCreated` edge, so missing private brief bytes cannot prevent stopping work. Before any child edge exists it records not-dispatched without allocating a child; after an edge but before Work it can admit a cancellation-only child that never runs the artifact. A lost cancellation acknowledgement reuses the same native occurrence after restart.

The worker accepts cancellation only from the authenticated parent link with matching owner, operation, experiment, brief, child and deadline. Native effect interruption and the absolute deadline propagate into the actual sandbox signal. A started job remains unknown on cancellation; an undispatched job is unavailable. Cancellation does not retract a provider write or prove its rollback. The CancelSent `admitted` status means the child host durably accepted cancellation, not that remote cleanup or reconciliation has completed. Settled trials are not executed again.

Record routing, preparation and joining overhead separately from `witness.latencyMs`, which measures the child's library execution/verification phase. Do not represent it as end-to-end trial latency. Joined/Unavailable explicitly retain `joinedLatencyMs: null`: no trustworthy monotonic measurement spans a process restart, and subtracting wall-clock timestamps would not establish one. Fixture reset and network/browser session isolation remain the trusted `prepare`/regime policy's responsibility; a fresh thread does not itself reset an external service or browser session.

## Controlled evidence

`test/harness-experiment-trials.test.ts` uses the actual native SQLite account host, its owner-restricted `allowChild` admission, Router delivery, isolated local sandbox and independent fixed verifier. It covers distinct baseline/candidate, development/held-out and repeated-case child jobs; a real wrong held-out output; root and child log privacy; restart at handoff and after execution; revoked and foreign authority; forged return evidence; deleted private brief/witness; lost execution acknowledgement; and a lost checked receipt that remains unknown without a repeated job or verifier. Cancellation checks abort an actual in-flight sandbox HTTP request and await its physical receipt, exercise authorization/join races and a missing-brief/lost-cancellation acknowledgement, and send adversarial sibling Router envelopes with forged payload links.

The metadata-only cases reconstruct the native host over the retained SQLite after removing execution bindings and private brief bytes. A retained native wait method produces a real deadline alarm. Recovery preserves unavailable/unknown/checked outcomes without new jobs, verifier calls or private binding access, and rejects foreign scope, missing parent edges, sibling links and cancellation payloads without a real parent stop. These cases recreate the host within one process; independent production/process-restart verification remains separate.

These module-level native witnesses do not attest production mounts, a live Codegraff deployment or the complete S16/full-plan outcome.
