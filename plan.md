# Active Goal — FECH Core Capability Intelligence

## Outcome

Build the smallest useful Fractal Energy Cell Harness across Aiko and
`../contract`: normalize Aiko-native tools, MCP tools, installed skills, and
Unbrowse routes into one typed capability descriptor; rank them locally using
Contract's existing energy/evidence machinery; return a conservative execution
plan; execute it through Aiko's existing permissioned runtime; and record a
privacy-safe outcome so future routing improves.

The proof is not a new distributed network. The proof is that Aiko selects a
working, previously-proven capability more quickly and reliably than blind tool
selection or browser fallback.

## Product Boundary

```text
Aiko inventory
  native tools + MCP tools + skills + Unbrowse routes
                         ↓
              normalized descriptors
                         ↓
        Contract ranking + evidence + plan
                         ↓
          Aiko permissions + execution
                         ↓
           sanitized outcome feedback
```

### Contract owns

- capability descriptor storage and version-aware identity;
- energy ranking over task context and verified observations;
- freshness, success/failure evidence, inhibition, and invalidation;
- prerequisite sequences and conservative parallel-group recommendations;
- the stable native ABI used by Aiko.

### Aiko owns

- discovering the four capability sources;
- resolving live availability and permission requirements;
- prompt-scoped recommendation delivery;
- agent choice, execution, concurrency, cancellation, and approvals;
- sanitizing execution observations before passing them to Contract;
- UI/TUI diagnostics explaining what was selected and why.

### Unbrowse owns

- discovering and replaying website API routes;
- authentication/capture details for those routes;
- exporting route metadata as capability descriptors.

## Core Data Types

### Capability descriptor

```json
{
  "schema_version": 1,
  "id": "provider.capability",
  "capability_version": "1",
  "provider": "aiko | mcp:<server> | skill | unbrowse",
  "tool": "tool_name",
  "action": "action_name",
  "description": "Short agent-readable purpose",
  "input_schema": {},
  "output_schema": {},
  "requires": [],
  "permission": "read | write | network | purchase",
  "effects": ["read_only"],
  "available": true
}
```

Descriptors contain stable capability facts. They do not contain mutable
success rates, usage counts, credentials, raw examples, or machine paths.

### Capability observation

```json
{
  "capability_id": "provider.capability",
  "capability_version": "1",
  "success": true,
  "duration_ms": 42,
  "permission_result": "allowed",
  "error_class": null,
  "result_shape": "object",
  "observed_at": "ISO-8601"
}
```

Observations must never contain raw arguments, prompts, URLs, credentials,
page contents, response bodies, command output, or user-entered values.

### Capability plan

```json
{
  "version": 1,
  "candidates": [],
  "sequence": ["capability.id"],
  "parallel": [],
  "confidence": 0.0,
  "margin": 0.0,
  "automatic": false,
  "reason_codes": []
}
```

V1 supports one capability, one prerequisite sequence, or one parallel group
of independent read-only capabilities. Arbitrary recursive execution is out of
scope.

## Implementation Phases

### Phase 0 — Freeze the integration contract

- [x] Audit the current Contract ABI v3 capability routing and outcome fields.
- [x] Reconcile stale ABI documentation and make one integration document
      canonical.
- [x] Define descriptor, observation, availability, and plan JSON Schemas.
- [x] Define stable ID/version rules and when old evidence is invalidated.
- [x] Add golden fixtures shared by Aiko Rust tests and Contract Zig tests.

Acceptance:

- The schemas reject credentials, raw execution content, and unknown effect or
  permission classes.
- An incompatible capability version cannot inherit previous success evidence.
- Aiko and Contract parse the same golden fixtures.

### Phase 1 — General capability registry in Contract

- [x] Replace the application-only static catalog boundary with a registry that
      accepts normalized descriptors while retaining built-in application priors.
- [x] Add native ABI operations to register/replace a source snapshot and list
      the effective catalog.
- [x] Keep descriptor state separate from append-only outcome evidence.
- [x] Deduplicate by stable ID, provider, and version.
- [x] Remove descriptors that disappear from a refreshed source snapshot
      without deleting their historical evidence.

Proposed ABI additions:

- `contract_register_capabilities(source, descriptors_json)`
- `contract_list_capabilities(filter_json)`
- `contract_recommend_plan(context, availability_json, limit)`
- `contract_record_capability_observation(context, observation_json)` reuses
  the existing append-only outcome machinery; v2 remains compatible.

Acceptance:

- Registering the same snapshot twice is idempotent.
- A removed or unavailable capability is never automatically selected.
- A catalog of 1,000 descriptors can be refreshed without ledger corruption.

### Phase 2 — Four Aiko normalizers

- [x] Normalize Aiko's built-in tool definitions.
- [x] Normalize connected MCP `tools/list` definitions and refresh them when
      tools change or a server disconnects.
- [x] Normalize installed `SKILL.md` metadata without treating prose as an
      executable interface.
- [x] Normalize Unbrowse route contracts through an explicit export adapter.
- [x] Produce live availability facts separately from descriptors.

Acceptance:

- Every advertised descriptor resolves back to a real Aiko execution target.
- Disconnected MCP servers and unavailable Unbrowse routes are inhibited.
- Descriptor collection reads no credentials and emits no credential-bearing
  fields.

### Phase 3 — Ranking and conservative composition

- [x] Rank using context affinity, verified success/failure, freshness,
      availability, permission/effect fit, and measured duration.
- [x] Return the top three candidates with machine-readable reason codes.
- [x] Support prerequisite sequences from typed `requires` edges.
- [x] Parallelize only independent read-only capabilities with no shared lock,
      session, or mutation effect.
- [x] Refuse automatic routing when confidence, margin, freshness, or
      availability thresholds are not met.
- [x] Fall back to normal Aiko reasoning and tools when no safe route qualifies.

Acceptance:

- Correct capability appears in the top three on at least 85% of the checked-in
  evaluation set.
- Automatic-route false positives remain at or below 2%.
- Stale successes cannot override fresh failures or unavailability.
- No write, purchase, message-send, or external mutation runs in an automatic
  parallel group.

### Phase 4 — Aiko execution and generic feedback

- [x] Deliver the plan through the existing prompt-scoped Contract route.
- [x] Let the model choose among non-automatic candidates.
- [x] Execute through Aiko's existing tool dispatcher, approval boundary,
      cancellation, and progress events.
- [x] Record one sanitized observation after every routed execution.
- [x] Classify permission denial, unavailable provider, timeout, invalid input,
      provider failure, and success separately.
- [x] Bind observations to descriptor version and provider identity.

Acceptance:

- Contract never invokes Aiko tools directly.
- Existing Aiko permission prompts remain authoritative.
- Failed or denied calls lower/inhibit the matching route without poisoning
  unrelated capabilities.
- Automated privacy tests prove that raw arguments and results are absent from
  the Contract ledger.

### Phase 5 — Explainability, UI, and benchmarks

- [x] Expose selected candidates, status, confidence, freshness, prerequisites,
      and reason codes through Aiko's native interface.
- [x] Add compact TUI/UI treatment for selected route, fallback, and learning
      status without dumping internal ledger terminology into normal chat.
- [x] Benchmark warm ranking, catalog refresh, route accuracy, route execution,
      and browser fallback on a fixed corpus.
- [x] Add end-to-end tests for one capability from each of the four sources.

Acceptance:

- Warm local ranking p50 is at most 50 ms and p95 at most 150 ms.
- Refreshing 1,000 descriptors completes within 500 ms on the reference machine.
- Read-only parallel plans complete successfully at least 90% of the time on
  the evaluation suite.
- A representative cached Unbrowse route beats browser fallback on measured
  latency and tool-call count.
- Aiko remains fully usable if Contract is missing or incompatible, with one
  visible degraded-state warning.

## Required End-to-End Scenarios

1. A native application task selects `application_observe` prerequisites and
   executes through the existing permission rail.
2. An MCP capability ranks, executes, records success, and ranks higher for a
   similar later task.
3. A disconnected MCP capability is inhibited immediately.
4. An installed skill is recommended as guidance but is not falsely executed
   as a tool.
5. An Unbrowse route is preferred over browser automation when available and
   proven.
6. A failed Unbrowse route falls back to the browser path and records a typed
   failure without retaining request or response content.
7. Two independent read-only capabilities run in parallel; any mutation or
   shared-session requirement forces sequential, permissioned execution.
8. Updating a descriptor to an incompatible version prevents old evidence
   from making it automatic.

## Explicitly Out of Scope

- P2P, DHT, gossip, or federated discovery;
- the public Unbrowse collective and contract publication;
- shared accounts, multi-brain sync, and cross-user permissions;
- marketplaces, monetization, reputation, and contribution incentives;
- EVM, Solana, settlement, and other on-chain work;
- scanning or wrapping arbitrary local binaries and data sources;
- viral/seed propagation;
- recursive autonomous inter-contract execution;
- a second ledger or replacement contract row schema;
- replacing Aiko reasoning or its existing permission runtime.

## Definition of Done

The FECH core is complete when Aiko can inventory the four supported capability
sources, Contract can rank and conservatively compose them from versioned local
evidence, Aiko can execute the selected plan through existing permissions, and
the sanitized result changes a later recommendation. All eight end-to-end
scenarios and the performance/privacy thresholds above must pass.

---

# Next Active Goal — Self-Growing Contract Limbs

## Outcome

Extend FECH so Aiko can detect a missing internal capability, describe the gap
as data, synthesize a temporary Contract-native subsystem, test it against
reality, and retain only the parts that earn independent evidence.

The intended loop is:

```text
unexplained observation, repeated failure, or missing proposal
                            ↓
                  CapabilityGap contract
                            ↓
             bounded temporary limb proposals
                            ↓
        receptor → predictor → planner → executor → sensor
                            ↓
               held-out and causal evaluation
                     ┌──────┴──────┐
                     ↓             ↓
                  promote       inhibit/purge
                     ↓
          reusable Contract-native capability
```

This is self-learning and self-contract-building. It is never
self-authorizing: a generated contract inherits the authority, effect ceiling,
budget, privacy boundary, and lifetime of its parent and cannot expand them.

## Design Boundary

Contract is the universal membrane and durable evidence field, not the
implementation language for every computation.

### Contract owns

- capability-gap identity, lineage, scope, lease, and lifecycle;
- typed hypotheses, predicted outcomes, dependencies, and effect declarations;
- experiment budgets and action authorization;
- evidence settlement, energy ranking, promotion, inhibition, and rollback;
- episode, archetype, and global memory boundaries;
- durable workflow graphs and generated-limb provenance.

### Aiko owns

- recognizing and describing gaps from the active task;
- proposing receptors, predictors, planners, sensors, and native executors;
- generating ordinary implementation code behind typed Contract interfaces;
- running bounded experiments through the existing execution chokepoint;
- explaining promoted and rejected limbs to the user;
- requesting authority when a proposed effect exceeds the parent envelope.

### Native executors own

- efficient ordinary computation;
- interface and provider protocol details;
- typed acknowledgements;
- cancellation and resource cleanup;
- no durable authority or unverified success claims.

## Non-Negotiable Invariants

1. **No self-authorization.** Child authority is a subset of parent authority.
2. **No effect without a dual.** Every effect names its sensor, timeout,
   cancellation path, and success/failure evaluator before execution.
3. **No activity-as-success.** Executed, acknowledged, predicted correctly,
   progressed, and completed are separate evidence states.
4. **No coordinate leakage.** Exact coordinates, frame hashes, process IDs,
   and provider handles remain episode-local.
5. **No immortal experiments.** Every temporary limb has a finite lease,
   action budget, cost budget, child limit, cancellation owner, and rollback.
6. **No circular proof.** Generator output cannot evaluate itself; promotion
   needs an independent sensor and a held-out witness.
7. **No global blessing.** Verification is conditional on semantic
   preconditions, capability version, effect profile, and evidence scope.
8. **No universal-code graph.** Contract graphs describe decisions, effects,
   evidence, and dependencies; implementations remain replaceable code.
9. **No silent bypass.** A required Contract binding or capability catalog
   failure enters HOLD or fails loudly.
10. **No benchmark fiction.** Every attempt enters the JESPA ledger, including
    ties, regressions, timeouts, and negative results.

## Core Types

### `CapabilityGap`

```json
{
  "schema_version": 1,
  "gap_id": "gap:<content-hash>",
  "parent_contract": "contract:<id>",
  "scope": "episode | archetype | global",
  "kind": "receptor | representation | predictor | proposer | planner | executor | sensor",
  "observation": {
    "expected": "typed predicate or predicted delta",
    "observed": "privacy-safe typed outcome",
    "failure_class": "unexplained_transition | repeated_loop | no_candidate | prediction_error | missing_sensor"
  },
  "required_capability": {
    "input_shape": {},
    "output_shape": {},
    "effects": [],
    "evidence_required": []
  },
  "authority_ceiling": {},
  "budgets": {
    "experiments": 16,
    "children": 8,
    "wall_seconds": 300,
    "lease_seconds": 600
  },
  "status": "open | experimenting | promotable | held | inhibited | closed"
}
```

Gap identity is based on structural preconditions and missing behavior, not a
game ID, application name, machine path, or provider coordinate.

### `LimbProposal`

```json
{
  "schema_version": 1,
  "proposal_id": "limb:<content-hash>",
  "gap_id": "gap:<content-hash>",
  "lineage": {
    "generator": "capability.id",
    "generator_version": "1",
    "parent_proposal": null,
    "artifact_hash": "sha256:..."
  },
  "cells": [
    {"role": "receptor", "capability": "observe.typed-state"},
    {"role": "predictor", "capability": "predict.relational-delta"},
    {"role": "planner", "capability": "plan.bounded-experiment"},
    {"role": "executor", "capability": "execute.native-action"},
    {"role": "sensor", "capability": "observe.independent-outcome"}
  ],
  "hypothesis": "An action changes a transferable relation",
  "predicted_delta": {},
  "effects": [],
  "rollback": "contract:<rollback-id>",
  "lease": {},
  "evidence_state": "unverified"
}
```

### `RelationalState`

The first general limb should represent geometry without durable coordinates:

```json
{
  "objects": [
    {
      "episode_ref": "object:7",
      "durable_role": "selected-medium-color-family-2",
      "attributes": ["selected", "movable"]
    }
  ],
  "relations": [
    ["object:7", "left_of", "target:2"],
    ["object:7", "approaching", "target:2"],
    ["object:7", "overlaps", "region:1"],
    ["object:7", "inside", "container:3"],
    ["object:7", "aligned_with", "target:2"]
  ]
}
```

`episode_ref` may resolve to coordinates in process memory. Durable Contract
evidence stores roles, relation classes, direction signs, distance bands, and
predicted deltas only.

## Multiscale Learning

| Scale | Learns | Stored evidence |
|---|---|---|
| Micro | action → relational delta | prediction agreement, no-op, failure |
| Meso | sequence/workflow → progress | required cells, ordering, termination |
| Macro | gap shape → useful limb architecture | promoted/rejected proposal lineage |
| Global | proposer and evaluator reliability | held-out fitness and failure domains |

The same transition can update several scales, but success at one scale does
not imply success at another. A correct movement prediction is dynamics
evidence, not task completion.

## Growth Lifecycle

### 1. Detect

Open or reinforce a gap when one of these bounded triggers fires:

- no valid candidate crosses the Contract boundary;
- the same semantic state/action loop repeats;
- prediction error remains above threshold;
- an observed transition has no typed explanation;
- execution acknowledgement exists but no consequence sensor exists;
- a task needs an interface affordance absent from the capability catalog.

Deduplicate gaps by structural signature. Repeated observations reinforce one
gap instead of spawning unlimited parallel development.

### 2. Diagnose

Classify what is missing before generating anything:

- cannot observe → receptor gap;
- cannot represent → representation gap;
- cannot predict → predictor gap;
- cannot suggest a novel action → proposer gap;
- cannot order candidates → planner gap;
- cannot cause the effect → executor gap;
- cannot determine consequence → sensor gap.

The diagnosis itself is a hypothesis with a falsifier.

### 3. Propose

Generate two or more bounded `LimbProposal` variants when evidence supports
meaningful alternatives. Reuse existing capabilities first. New code is
justified only for the unresolved residual.

Each proposal must declare:

- typed input and output;
- effect and permission profile;
- prediction and falsifier;
- experiment set and held-out set;
- resource budget and lease;
- independent sensor;
- rollback and cleanup procedure.

### 4. Compile

Compile the proposal into the existing Contract workflow substrate:

```text
observe
  → normalize
  → infer hypotheses
  → generate bounded experiments
  → predict outcomes
  → rank by energy
  → authorize one experiment
  → execute through native chokepoint
  → independently observe
  → settle, inhibit, refine, or promote
```

Sequential phases may contain parallel read-only workers. Mutating experiments
remain serialized unless independence is mechanically proven.

### 5. Experiment

Cold candidates are explicitly unverified experiments:

```text
verified success   → exploit within matching preconditions
unverified         → bounded experiment
verified failure   → inhibit in that context
unsafe or illegal  → HOLD
```

Experiment selection balances:

- predicted progress energy;
- information gain;
- loop and no-op penalties;
- verified-failure penalties;
- action and resource cost;
- a fairness floor for live hypotheses.

### 6. Settle

Record dense but honest evidence:

- state changed or unchanged;
- relation added, removed, or changed;
- predicted delta agreed or disagreed;
- new state discovered or loop revisited;
- legal capabilities changed;
- external acknowledgement received;
- task progress occurred;
- terminal failure or completion occurred;
- actions, time, and cost consumed.

Only independently grounded task progress can settle task success.

### 7. Promote or reject

#### Promotion gates

A temporary limb becomes reusable only when all applicable gates pass:

1. **Schema:** typed inputs, outputs, effects, and errors validate.
2. **Predictive:** held-out transition prediction beats the current substrate.
3. **Causal:** bounded interventions support the claimed action → outcome edge.
4. **Utility:** completion improves, or actions/cost improve when completion ties.
5. **Safety:** authority containment, cancellation, timeout, and rollback pass.
6. **Isolation:** exact episode coordinates and secrets are absent from durable state.
7. **Reproduction:** at least two seeds or independent occurrences reproduce.
8. **Mutation:** disabling the new limb makes its claimed witness fail.

Failure does not disappear. It adds scoped inhibitory evidence and lineage
showing why the proposal was rejected.

### 8. Retain and reuse

Promotion produces:

- a versioned capability descriptor;
- a Contract workflow;
- an implementation artifact hash;
- signed evaluation lineage;
- semantic preconditions;
- evidence and expiry policy;
- a runnable witness;
- a rollback pointer.

Recall binds the durable semantic capability to new episode-local coordinates,
handles, processes, or interface objects at execution time.

## Authority and Safety Matrix

| Limb behavior | Autonomous default |
|---|---|
| Read-only observation and normalization | allowed within parent scope |
| Local prediction and simulation | allowed within budget |
| Temporary local files in scoped workspace | allowed with cleanup |
| Bounded benchmark/environment action | allowed when parent authorizes it |
| Long-lived process | requires lease, owner, health sensor, cancellation |
| Message/send/publish | HOLD unless durable authority already covers it |
| Purchase/payment | HOLD and explicit approval |
| Delete/overwrite outside reversible workspace | HOLD |
| Credential or permission change | HOLD |
| Broader process spawning or machine persistence | HOLD unless explicitly governed |

Generated development code never expands this matrix.

## First Implementation: Relational Navigation Limb

The first production slice targets the demonstrated mixed click-and-movement
gap without naming `sp80`.

### Cells

1. **Object receptor:** tracks objects across frames using episode-local IDs.
2. **Selection sensor:** identifies which object changed appearance or motion
   after click/selection experiments.
3. **Relation encoder:** emits `left_of`, `above`, `aligned_with`, `overlaps`,
   `inside`, `approaching`, and coarse distance bands.
4. **Inverse dynamics learner:** estimates which action changes which relation.
5. **Goal-hypothesis proposer:** proposes overlap, containment, alignment,
   matching, and commit-after-arrangement hypotheses.
6. **Bounded planner:** searches short action sequences over predicted
   relational deltas.
7. **Outcome sensor:** distinguishes prediction agreement, environmental
   acknowledgement, level progress, and completion.

### ARC binding witness

- Fresh isolated stores.
- Same games, proposer set, action budgets, and two seeds for both arms.
- Contract arm must improve completed levels first.
- If levels tie, it must reduce actions-to-completion.
- A targeted mixed interaction/navigation cohort is diagnostic only; the
  all-game comparison is the promotion witness.
- Every failed proposal and timeout remains in the JESPA ledger.
- No game IDs, fixed routes, or durable exact coordinates.

## Implementation Phases

### Phase SG0 — Schemas and lifecycle

- [ ] Add `CapabilityGap`, `LimbProposal`, relational state, experiment result,
      and promotion decision schemas.
- [ ] Add validation and privacy fixtures.
- [ ] Add parent-authority subset validation.
- [ ] Add gap deduplication and finite lease rules.

Gate: invalid authority expansion, missing sensor, missing rollback, duplicate
identity, and coordinate leakage fixtures all fail closed.

### Phase SG1 — Gap detector

- [ ] Emit typed gaps from no-candidate, repeated-loop, unexplained-transition,
      prediction-error, and missing-sensor events.
- [ ] Deduplicate by semantic signature and scope.
- [ ] Expose gaps through CLI/native API without triggering generation.

Gate: synthetic and real ARC traces produce the expected gap class, while
ordinary recoverable failures do not create unbounded gaps.

### Phase SG2 — Relational receptor and transition learner

- [ ] Track episode objects across frames.
- [ ] Encode transferable relations without durable coordinates.
- [ ] Learn action → relational delta from dense transition evidence.
- [ ] Keep prediction agreement separate from progress.

Gate: held-out inverse-dynamics accuracy beats the current descriptor; restart
witness proves learned state persists without coordinate leakage.

### Phase SG3 — Temporary limb compiler

- [ ] Reuse existing capability cells before proposing code.
- [ ] Compile proposals into bounded Contract workflows.
- [ ] Generate replaceable executor code only for unresolved cells.
- [ ] Attach lease, health, cancellation, cleanup, and rollback contracts.

Gate: kill and restart a temporary limb; ledger state reconstructs it or cleans
it up without duplicate effects.

### Phase SG4 — Bounded experiment planner

- [ ] Rank verified, unverified, failed, and unsafe candidates distinctly.
- [ ] Add information-gain and loop/no-op energy terms.
- [ ] Execute one authorized experiment at a time.
- [ ] Settle dense transition evidence and sparse progress evidence separately.

Gate: mutation tests catch removal of cold experiments, loop inhibition,
independent sensing, or effect authorization.

### Phase SG5 — Promotion, lineage, and rollback

- [ ] Run predictive, causal, utility, safety, isolation, reproduction, and
      mutation gates.
- [ ] Sign proposal/evaluation/artifact lineage.
- [ ] Promote versioned descriptors and workflows.
- [ ] Inhibit failures by context; rollback promoted regressions automatically.

Gate: a deliberately overfit limb wins its training episodes but fails
promotion on held-out episodes.

### Phase SG6 — ARC evaluation

- [ ] Run the relational-navigation diagnostic cohort.
- [ ] Run all 25 games, two seeds, fresh stores, equal action budgets.
- [ ] Record every attempt in the JESPA ledger.
- [ ] Promote only on a reproducible completion-first win.

Gate:

```sh
JESPA_WIN_TARGET=<genuine-count> \
  bash benchmarks/arc-agi3/jespa/jespa-benchmarks-gate.sh
```

### Phase SG7 — General interface transfer

- [ ] Apply the same gap lifecycle to a non-ARC interface.
- [ ] Discover provider affordances through typed receptors.
- [ ] Grow an adapter limb without hard-coding the provider into Contract.
- [ ] Prove effects still cross the universal execution envelope.

Gate: one previously unknown interface affordance is discovered, wrapped,
executed, independently acknowledged, and recalled after restart.

## Required End-to-End Scenarios

1. An unexplained ARC transition opens one deduplicated predictor gap.
2. A mixed click-and-movement environment grows a temporary relational limb.
3. Duplicate semantic objects receive unique coordinate-free identities.
4. A rejected native catalog fails loudly and cannot fall through ungoverned.
5. A correct transition prediction earns dynamics evidence but not task success.
6. A generated limb cannot request effects absent from the parent envelope.
7. A killed limb releases its lease and leaves no orphan process.
8. A training-set winner fails promotion when held-out utility does not improve.
9. A promoted limb survives restart and binds to new episode-local objects.
10. A later non-ARC interface reuses the same gap and promotion substrate.

## Observability

Expose a concise growth trace:

```text
gap detected
→ existing cells considered
→ proposal variants
→ experiment authorized
→ execution acknowledged
→ consequence observed
→ prediction settled
→ progress settled
→ promoted / inhibited / held
```

Normal chat should describe the practical result. Detailed lineage, energies,
leases, and evidence remain inspectable through diagnostics.

## Definition of Done

This track is complete when Aiko can encounter a genuinely missing capability,
open one scoped gap, assemble or generate a bounded temporary limb, execute its
experiments through Contract, independently evaluate it, reject an overfit
variant, promote a reproducibly useful variant, survive restart, and transfer
the promoted structure to a second interface without gaining new authority.

The first benchmark milestone is not “more Contract calls.” It is a fresh,
two-seed ARC completion-first win attributable to the relational limb, with the
counterfactual mutation turning the win red and every negative retained in the
ledger.
