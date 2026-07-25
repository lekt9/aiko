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

- [x] Add `CapabilityGap`, `LimbProposal`, relational state, experiment result,
      and promotion decision schemas.
- [x] Add validation and privacy fixtures.
- [x] Add parent-authority subset validation.
- [x] Add gap deduplication and finite lease rules.

Gate: invalid authority expansion, missing sensor, missing rollback, duplicate
identity, and coordinate leakage fixtures all fail closed.

### Phase SG1 — Gap detector

- [x] Emit typed gaps from no-candidate, repeated-loop, unexplained-transition,
      prediction-error, and missing-sensor events.
- [x] Deduplicate by semantic signature and scope.
- [x] Expose gaps through CLI/native API without triggering generation.

Gate: synthetic and real ARC traces produce the expected gap class, while
ordinary recoverable failures do not create unbounded gaps.

### Phase SG2 — Relational receptor and transition learner

- [x] Track episode objects across frames.
- [x] Encode transferable relations without durable coordinates.
- [x] Learn action → relational delta from dense transition evidence.
- [x] Keep prediction agreement separate from progress.

Gate: held-out inverse-dynamics accuracy beats the current descriptor; restart
witness proves learned state persists without coordinate leakage.

### Phase SG3 — Temporary limb compiler

- [x] Reuse existing capability cells before proposing code.
- [x] Compile proposals into bounded Contract workflows.
- [x] Generate replaceable executor code only for unresolved cells.
- [x] Attach lease, health, cancellation, cleanup, and rollback contracts.

Gate: kill and restart a temporary limb; ledger state reconstructs it or cleans
it up without duplicate effects.

### Phase SG4 — Bounded experiment planner

- [x] Rank verified, unverified, failed, and unsafe candidates distinctly.
- [x] Add information-gain and loop/no-op energy terms.
- [x] Execute one authorized experiment at a time.
- [x] Settle dense transition evidence and sparse progress evidence separately.

Gate: mutation tests catch removal of cold experiments, loop inhibition,
independent sensing, or effect authorization.

### Phase SG5 — Promotion, lineage, and rollback

- [x] Run predictive, causal, utility, safety, isolation, reproduction, and
      mutation gates.
- [x] Sign proposal/evaluation/artifact lineage.
- [x] Promote versioned descriptors and workflows.
- [x] Inhibit failures by context; rollback promoted regressions automatically.

Gate: a deliberately overfit limb wins its training episodes but fails
promotion on held-out episodes.

### Phase SG6 — ARC evaluation

- [x] Run the relational-navigation diagnostic cohort.
- [x] Run all 25 games, two seeds, fresh stores, equal action budgets.
- [x] Record every attempt in the JESPA ledger.
- [x] Promote only on a reproducible completion-first win.

Gate:

```sh
JESPA_WIN_TARGET=1 \
  bash benchmarks/arc-agi3/jespa/jespa-benchmarks-gate.sh
```

Settled (witnessed, no fabricated green):

- **Offline benchmark gate PASS** — `JESPA_WIN_TARGET=1 jespa-benchmarks-gate.sh`
  reproduces one counted win (`arc-agi3-next-level-region-contract`): all 25 games,
  two seeds, fresh isolated stores, equal proposers/budgets. Score is a
  **completion-first tiebreak win**: equal completion (14 levels, 0 wins each),
  jespa strictly fewer actions-to-completion (354 < 358). Honest negatives
  (completion+actions tied, or jespa worse) are recorded `won:false` and never
  counted; three green regression rows are marked `counted:false` (not distinct wins).
- **Online receptor path — REAL live proof**
  (`benchmarks/arc-agi3/jespa/witness-arc-online-live.py`, needs user-provided
  `ARC_API_KEY` + `ARC_API_MODE=online`, never committed): authenticates against
  `three.arcprize.org`, opens a live scorecard, RESETs, emits one valid ACTION
  read from `available_actions`, and closes — reproduced across games (sb26, su15).
  The bench itself stays offline-mechanical by design; this witness proves the live
  receptor is genuinely wired, not stubbed.
- **Bounded limit (accepted with grace, not piled on)** — the win is an efficiency
  tiebreak, not a win-by-completing-more (the mechanical solver achieves 0 wins).
  A full online 25x2 run would not change that without a real solver/LLM budget, so
  it is held rather than blindly expanded (the amen reflect flagged a regression on
  blind expansion).
- **Correction to the "0 wins" reading** — the LLM proposer wire
  (`_ask_aiko` → `aiko --single`) was a silently-dead wire: `-p`/`--single` takes the
  prompt as its value, but the argv led with `-p --model …`, so clap errored every
  call and `_ask_aiko` always returned `""`. The LLM never proposed an ARC action in
  any run; "0 wins" is the mechanical-organs-only score with the proposer dead, not
  "the LLM tried and failed." Fixed (argv reordered) and witnessed live: with
  `AIKO_MODEL=glm-5.2` `_ask_aiko` returns a clean `{"a": 1}` (rc=0). The default
  model id (`qwen3.5:4b`) is backend-specific (Ollama); set `AIKO_MODEL` to a real id
  for the clarityproject endpoint. Whether the live proposer actually clears more
  levels / wins a game is an untested, paid (per-action LLM) cohort — held for
  authorization.

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

---

# Contract-Native Receptor Mesh

## Outcome

Make inbound and outbound interfaces behave like durable Contract neurons:
declare a provider-neutral receptor or effector, bind it to the cheapest viable
transport, observe its health and use, and upgrade or degrade that transport
without changing the semantic Contract graph.

The immediate witness is a messaging receptor that can begin with polling or an
ephemeral development tunnel, graduate to a durable webhook after sustained
use, survive Aiko process restarts, deduplicate replayed events, detect changed
remote state, and route authorized replies through typed effectors. Telegram and
Cloudflare are fixtures, not branches in Contract.

```text
outside event
  → transport adapter
  → receptor envelope
  → durable occurrence + dedup cursor
  → normalize / authorize / route
  → typed effector
  → provider acknowledgement sensor
  → consequence sensor
  → settle + update transport evidence
```

The ledger is durable truth. Tunnels, pollers, webhooks, workers, and daemons
are leased apparatus that can be reconstructed from ledger declarations.

## Polymorphic Cell Law

Everything that plays the same role must implement the same stable shape.
Variation belongs behind the interface, never in the Contract graph:

```text
Receptor<I, E>
  observe(input: I) → EventEnvelope<E>
  checkpoint() → Cursor
  health() → HealthEvidence
  acknowledge(receipt) → AcknowledgementEvidence

Effector<C, O>
  prepare(command: C) → PreparedEffect
  execute(prepared) → ExecutionReceipt<O>
  sense(receipt) → ConsequenceEvidence

Transport
  bind(receptor, lease) → TransportBinding
  renew(binding) → TransportBinding
  health(binding) → HealthEvidence
  retire(binding) → RetirementEvidence
```

The common shape is semantic, not a lowest-common-denominator payload. Typed
extension fields preserve richer affordances without making the core branch on
providers:

```json
{
  "kind": "message.received",
  "identity": {},
  "content": {},
  "context": {},
  "capabilities": ["reply.text", "presence.typing", "reply.voice"],
  "extensions": {
    "adapter-owned-schema-id": {}
  }
}
```

Contract reasons over the stable fields and declared capabilities. The selected
adapter validates and consumes its own extension. Unknown extensions remain
opaque; missing required capabilities HOLD. No adapter may reinterpret a core
field or weaken its authority, privacy, idempotency, or evidence semantics.

### Substitutability rules

- A poller, ephemeral tunnel, durable tunnel, hosted worker, and native webhook
  all implement `Transport`.
- Telegram, email, iOS, filesystem, and remote APIs all emit `EventEnvelope`.
- Text, voice, reaction, file, process, and publication actions all implement
  `Effector`, with different declared effects and authority.
- Cached and live observations share the same result shape but carry distinct
  freshness and provenance evidence.
- Provider errors normalize to one typed error algebra:
  `retryable | terminal | unauthorized | rate_limited | invalid |
  unavailable | contradictory`.
- Capability discovery selects implementations; it never changes the parent
  workflow topology.

Polymorphism must not erase meaning. A voice response cannot silently degrade
to text, an execution receipt cannot masquerade as goal progress, and an
ephemeral tunnel cannot claim durable availability.

## Canonical Hard-Type Algebra

Contract must hard-type facts whose ambiguity can widen authority, duplicate an
effect, corrupt lifecycle state, or fabricate success. These are versioned
closed sums or opaque validated values at the Contract boundary; adapters may
map provider values into them but may not invent alternatives.

### Authority and effects

```text
Authority =
  Observe
  | LocalWrite
  | ExternalMessage
  | Publish
  | Purchase
  | Delete
  | CredentialAccess
  | ProcessSpawn
  | ProcessPersist
  | PermissionChange

Effect =
  Read
  | Transform
  | LocalMutation
  | ExternalMutation
  | Message
  | Publication
  | Financial
  | Destructive

Reversibility =
  Pure
  | Idempotent
  | Compensatable(CompensationCapability)
  | Irreversible
```

An authorization grant is an opaque, scoped value containing authority class,
subject, resource/effect scope, issuer, lineage, issuance time, expiry, and
revocation generation. Child authority must mechanically be a subset of its
parent. `Compensatable` is invalid without a typed compensation capability;
compensation is a new governed effect, not history deletion.

### Outcome and evidence

```text
Outcome =
  Observed
  | Authorized
  | Prepared
  | Executed
  | Acknowledged
  | Consumed
  | Progressed
  | Completed

Evidence =
  ProviderReceipt
  | IndependentSensor
  | UserConfirmation
  | PredictionAgreement
  | StateTransition
  | ProgressSignal
  | CompletionSignal
  | Contradiction
```

Each outcome declares the evidence variants allowed to support it. Promotion is
monotonic only when new evidence satisfies the next state; contradiction may
invalidate a prior projection without rewriting its historical occurrence.

In particular:

- an HTTP success may support `Executed` or `Acknowledged`;
- delivery acknowledgement does not support `Consumed`;
- state change does not automatically support `Progressed`;
- prediction agreement trains a predictor but does not support task success;
- only declared independent completion evidence supports `Completed`.

### Lifecycle and runtime

```text
Lifecycle =
  Declared
  | Held(HoldReason)
  | Leased(Lease)
  | Running(RuntimeIdentity)
  | Settling
  | Grounded
  | Released(ReleaseReason)
  | Failed(TypedError)
  | Superseded(OccurrenceIdentity)

Durability =
  Ephemeral
  | Session
  | Leased
  | Restartable
  | HostedDurable

Health =
  Starting
  | Healthy
  | Degraded
  | Unreachable
  | Expired
  | Retired
```

Lifecycle transitions are a validated transition table, not arbitrary status
writes. Durability is a claim requiring matching runtime evidence. Health
contains observation time, freshness, sensor identity, and bounded diagnostic
codes. A ledger declaration with no live reconciler cannot become
`Restartable` or `HostedDurable`.

`Lease` is an opaque value containing owner, generation, issued time, expiry,
renewal policy, cancellation handle, and bounded child count. Only the current
generation may execute or settle; stale workers may append observations but
cannot commit effects or terminal outcomes.

### Delivery, identity, and idempotency

```text
DeliverySemantics =
  AtMostOnce
  | AtLeastOnce
  | EffectivelyOnce

Identity =
  ActorId
  | ConversationId
  | ResourceId
  | OccurrenceId
  | RuntimeId
  | ProviderHandle

IdempotencyKey = opaque(
  receptor identity,
  source instance,
  event identity,
  semantic effect identity,
  schema generation
)
```

Identity variants are not mutually substitutable even if providers represent
all of them as strings or integers. `EffectivelyOnce` means at-least-once input
plus durable deduplication and idempotent/compensatable effects; it is never a
claim of exactly-once transport.

### Freshness, cache, cursors, and change

```text
Freshness =
  Live(observed_at)
  | FreshUntil(deadline)
  | Stale(last_observed_at)
  | Expired(last_observed_at)
  | Unknown

Cursor =
  SequenceCursor
  | VersionCursor
  | ConditionalHttpCursor
  | FingerprintCursor

Change =
  Created
  | Updated
  | Deleted
  | Moved
  | Reordered
  | Unchanged
  | Unknown

Progress =
  NoChange
  | StateChange
  | NovelState
  | LocalProgress
  | GoalProgress
  | TerminalSuccess
```

Every observation includes freshness and provenance. Cached and live values may
share a payload schema but never the same evidence state. Each cursor
implementation supplies typed `compare`, `advance`, and `resynchronize`
operations; cursors advance only after durable occurrence creation. `Change`
and `Progress` remain separate so a changed webhook or visual frame cannot
fabricate useful progress.

### Payload privacy and provenance

```text
Payload<T> =
  RawSecret<T>
  | Sensitive<T>
  | Redacted<T>
  | Public<T>

Provenance =
  LiveProvider
  | DurableLedger
  | LocalCache
  | ModelPrediction
  | UserAssertion
  | Derived(EvidenceReferences)
```

Only `Redacted` and `Public` projections may enter prompts, ordinary logs,
diagnostics, shared descriptors, or durable content fingerprints.
`RawSecret` may be consumed only by an explicitly authorized adapter and cannot
implement serialization into Contract rows. Every derived value retains
bounded evidence references and transformation identity.

### Errors, retries, and HOLD

```text
TypedError =
  Invalid
  | Unauthorized
  | RateLimited(RetryAfter)
  | Retryable
  | Unavailable
  | Contradictory
  | Terminal

HoldReason =
  MissingAuthority
  | UnsupportedCapability
  | IncompatibleVersion
  | MissingEvidence
  | UnsafeFallback
  | BudgetExhausted
  | LeaseUnavailable
```

`RetryPolicy` is a bounded value containing maximum attempts, deadline,
backoff, jitter, total cost, and allowed retryable error variants. No error text
parsing may decide retries after normalization. HOLD is non-terminal and
inspectable; it cannot silently fall through to a weaker effect.

### Capability and binding

```text
Capability<I, O, X> = {
  identity,
  schema_version,
  input: I,
  output: O,
  effect: X,
  authority,
  reversibility,
  evidence_requirements,
  supported_variants,
  availability
}

Binding<C, R> = {
  semantic_capability: C,
  runtime_implementation: R,
  compatibility_version,
  provenance,
  lease,
  health
}
```

Capabilities describe meaning; bindings select implementations. Discovery may
replace a binding without changing the semantic workflow. Availability and
health are observations, not permanent descriptor facts.

### Universal cell

The shared compilation target is:

```text
Cell<Input, State, Command, Receipt, Evidence, Output, Error>

observe(Input)
  → normalize(State)
  → decide(Command)
  → authorize(Authority)
  → prepare(PreparedEffect)
  → execute(Receipt)
  → sense(Evidence)
  → evaluate(Outcome)
  → settle(Output | Error)
```

Receptors, effectors, predictors, tunnels, agents, workflows, monitors, and
generated limbs specialize this cell. Cells may omit an inapplicable effect
stage only by selecting a typed pure/read-only specialization; they may not
bypass the lifecycle.

### Contract continuation envelope

Contract is the consistent semantic primitive passed between every meaningful
cell. Any reasoning worker, model call, subagent, scheduled job, webhook
handler, CLI/TUI turn, MCP invocation, generated limb, or hosted worker that
continues consequential work must receive one typed `ContractContinuation`.

```text
ContractContinuation<Input> = {
  schema_version,
  triggering_occurrence,
  parent_and_dependency_lineage,
  normalized_input: Input,
  identity_scope,
  resource_or_conversation_cursor,
  authority_envelope,
  open_obligations,
  relevant_settled_evidence,
  relevant_contradictions,
  capability_bindings,
  freshness_and_provenance,
  privacy_projection,
  budgets_and_deadlines,
  continuation_token
}
```

The continuation is the input membrane around native computation. It does not
force implementation code, tokens, parser internals, or pure arithmetic into
ledger rows. It ensures that the goal, authority, dependencies, memory,
evidence, and expected settlement of that computation retain one consistent
shape.

The universal invocation law is:

```text
external or internal event
  → append triggering occurrence
  → resolve dependencies and cursors
  → rank relevant Contract evidence
  → project bounded ContractContinuation
  → invoke native worker / model / adapter
  → validate typed worker result
  → append receipts and independent evidence
  → settle or release occurrence
  → advance cursor after durable settlement
```

Invocation and context projection form one readiness barrier. A worker cannot
race ahead while its Contract graph is being created asynchronously. Missing,
invalid, stale, over-authorized, or incompatible continuations HOLD
consequential work. Pure local computation may use a typed read-only
continuation or remain inside an already-authorized cell.

### Context projection, not ledger dumping

Passing Contract through the system does not mean copying the entire ledger
into every prompt. Contract resolves a deterministic, bounded projection:

1. The triggering occurrence and direct dependency outputs.
2. Current authority, budgets, deadline, lease, and supported effects.
3. Open obligations and pending effects in the same identity/resource scope.
4. Recent scoped interaction occurrences needed for conversational continuity.
5. Semantically ranked settled evidence and contradictions.
6. Current cursor, freshness, provenance, and capability availability.
7. The output schema and evidence required to settle this occurrence.

Every included item carries an occurrence ID, type, provenance, freshness, and
privacy class. Token/byte budgets are hard bounds. Retrieval scores are soft
priors; they cannot grant authority or upgrade evidence. Secret, stale,
unrelated, cross-identity, and superseded values are excluded mechanically.

Conversation memory is therefore not a mutable model session. A user message,
assistant response, tool decision, tool receipt, and observed consequence are
typed occurrences associated with a `ConversationId` cursor. A new worker
receives the bounded relevant projection and may be stateless without becoming
amnesiac.

### Universal worker result

Every worker returns the same outer shape:

```text
ContractResult<Output> = {
  continuation_token,
  output: Output,
  proposed_effects,
  observations,
  unresolved_obligations,
  claimed_outcome,
  evidence_references,
  usage,
  errors
}
```

The worker may propose but cannot self-authorize effects. Contract validates the
result against the continuation, executes approved effects through native
effectors, and independently settles the claimed outcome. An unrecognized
continuation token, stale lease generation, undeclared output, authority
expansion, or unsupported effect is rejected or held.

### Surface polymorphism

All surfaces bind to the same continuation ABI:

- CLI, TUI, desktop, iOS, and chat turns emit interaction occurrences;
- Telegram, email, webhooks, filesystems, devices, and monitored APIs emit
  receptor occurrences;
- MCP tools, shell commands, HTTP calls, messages, publications, and process
  spawns return typed effect receipts;
- local models, hosted models, ThinkFeel, subagents, and generated workers
  consume `ContractContinuation` and return `ContractResult`;
- polling, tunnels, workers, and native webhooks change transport only; they do
  not change semantic context or memory.

Provider adapters may translate the continuation into their supported input
format. For a messages-array API, the adapter renders bounded recent
conversation occurrences plus one system/developer Contract context block. For
a structured worker, it passes the envelope directly. Translation must preserve
authority, provenance, ordering, role, reply/thread context, and evidence
requirements.

### Deliberately soft layer

The following remain extensible data or model reasoning rather than closed
Contract enums:

- natural-language goals and user-facing response style;
- provider-specific payload extensions;
- energy weights, ranking strategies, and learned priors;
- domain hypotheses and predicted latent state;
- generated implementation strategies;
- presentation and interface styling.

The rule is: hard-type truth, identity, safety, lifecycle, privacy, effects, and
substitution boundaries; leave interpretation and strategy adaptable.

## Product Boundary

### Contract owns

- semantic receptor, effector, transport, lease, cursor, and observation types;
- durable occurrence identity, lineage, authority, evidence, and settlement;
- idempotency and compare-and-set rules for event cursors;
- transport requirements and energy ranking from observed cost, latency,
  reliability, demand, privacy, and freshness;
- upgrade, downgrade, renewal, supersession, and HOLD decisions;
- the distinction between receipt, execution acknowledgement, consequence, and
  goal progress.

### Aiko owns

- discovering installed transport and interface capabilities;
- compiling receptor specifications into Contract graphs and runtime
  descriptors;
- starting bounded local workers and connecting hosted adapters;
- executing approved effects through the universal tool chokepoint;
- rendering health, lag, authority, and degraded-state diagnostics;
- reconciling desired ledger state with disposable runtime state after restart.

### Transport adapters own

- obtaining and renewing ephemeral or durable ingress endpoints;
- translating provider callbacks or polling results into the common envelope;
- validating provider signatures before content normalization;
- reporting health, expiry, delivery attempts, latency, and provider errors;
- deleting or disabling superseded endpoints when authority permits.

They do not own conversation policy, agent reasoning, authorization, durable
truth, or task completion.

## Core Types

### Receptor specification

Extend the generated receptor pack rather than introducing a second workflow
engine:

```json
{
  "schema_version": 2,
  "id": "messaging-inbound",
  "events": [{"id": "message", "kind": "external_event"}],
  "ingress": {
    "modes": ["poll", "ephemeral_tunnel", "durable_tunnel", "provider_webhook"],
    "delivery": "at_least_once",
    "signature": "adapter_declared",
    "max_body_bytes": 262144,
    "privacy": "redacted"
  },
  "cursor": {
    "identity_fields": ["source_instance", "event_id"],
    "change_token_fields": ["version", "etag", "updated_at", "content_hash"],
    "ttl_ms": 2592000000
  },
  "effects": []
}
```

Descriptors contain no tokens, tunnel credentials, API keys, raw payloads, or
account secrets. Secret references resolve only inside the adapter at runtime.

### Event envelope

```json
{
  "receptor_id": "messaging-inbound",
  "source_instance": "secret-independent-stable-id",
  "event_id": "provider-event-id",
  "event_kind": "message",
  "observed_at": "ISO-8601",
  "provider_version": "optional-version",
  "content_fingerprint": "keyed-redacted-digest",
  "summary": "bounded redacted summary",
  "reply_context": {},
  "transport_receipt": {}
}
```

`reply_context` contains only typed, bounded handles needed by a later effector.
It must not smuggle credentials or arbitrary provider responses into Contract.

### Change cursor

Each monitored resource has one compare-and-set cursor:

```json
{
  "receptor_id": "remote-resource",
  "resource_key": "privacy-safe-stable-key",
  "generation": 7,
  "provider_token": "etag-or-version",
  "content_fingerprint": "keyed-redacted-digest",
  "last_observed_at": "ISO-8601",
  "last_changed_at": "ISO-8601",
  "lease_owner": "runtime-instance-id",
  "lease_until": "ISO-8601"
}
```

The cache is evidence, not authority. A cache hit can suppress duplicate
normalization; it cannot authorize an effect or prove that the external world
still has the cached state.

### Transport binding

```json
{
  "receptor_id": "messaging-inbound",
  "mode": "ephemeral_tunnel",
  "adapter_capability": "transport.tunnel.ephemeral",
  "endpoint_ref": "secret-store-reference",
  "lease_until": "ISO-8601",
  "health_check": "transport-health-v1",
  "restart_policy": "on-failure",
  "supersedes": null
}
```

Endpoint URLs may be sensitive and stay in the runtime/secret store. Contract
retains a redacted binding identity and evidence about its behavior.

## Transport State Machine

```text
declared
  → polling
  → ephemeral tunnel
  → durable tunnel
  → provider-native webhook

any live state
  → degraded
  → renew / replace / fall back
  → retired
```

Transitions are ranked, not hard-coded:

- prefer polling for low-frequency, private, or development-only receptors;
- prefer an ephemeral tunnel for interactive development and bounded tests;
- promote to durable ingress when demand, latency, restart, or availability
  evidence exceeds declared thresholds;
- prefer a provider-native webhook when it has lower cost and stronger delivery
  evidence than a third-party tunnel;
- fall back to polling when tunnel health or authority disappears;
- never silently expose a local endpoint, publish a durable URL, deploy a
  worker, or mutate a provider webhook without matching authority.

Promotion requires a minimum observation window, hysteresis, and cooldown so
bursty traffic cannot oscillate the binding. Demotion preserves the semantic
receptor and cursor, preventing missed or duplicated events during migration.

## Change Detection and Caching

Every receptor normalizes remote change through the same ordered strategy:

1. Provider event/version identifier.
2. Conditional request token such as `ETag` or `Last-Modified`.
3. Typed semantic version or monotonic sequence.
4. Keyed digest of a canonical, redacted projection.
5. Bounded structural diff when no stable token exists.

The runtime writes the event occurrence before advancing its cursor. This gives
at-least-once delivery with idempotent processing:

```text
receive
→ validate signature and bounds
→ derive dedup key
→ append occurrence if absent
→ process and settle children
→ compare-and-set cursor
→ acknowledge source
```

Required behaviors:

- replaying the same event creates no duplicate effect;
- a changed payload with a reused provider identifier is retained as a
  contradiction and held for adapter evaluation;
- out-of-order versions are observed but cannot move the cursor backwards;
- concurrent poller and webhook delivery converge on one occurrence;
- cursor expiry causes a bounded resynchronization, not an unbounded replay;
- cache invalidation propagates to dependent observations in the same resolver
  tick;
- raw bodies and secrets never enter durable fingerprints or diagnostics.

## Neuron and Hook Composition

One logical neuron is a closed receptor-to-effector loop:

```text
receptor
  → normalize
  → identity / pairing
  → rule and goal matching
  → reason or transform
  → authorize
  → prepare effect variant
  → execute effector
  → acknowledge
  → independently sense consequence
  → settle
```

Hooks remain composable middleware around typed cells. They must not become a
parallel source of truth. Every hook declares:

- input/output schemas;
- read/write effects;
- authority and privacy requirements;
- idempotency key derivation;
- timeout and cancellation;
- evidence needed for satisfaction;
- whether failure blocks, holds, or safely passes through.

Unsupported variants HOLD rather than collapsing to text. Presence, typing,
voice, replies, edits, reactions, files, callbacks, and future affordances are
capability variants discovered from an adapter catalog.

## Implementation Phases

### Phase RM0 — Correct the persistence model

- [ ] Document and test that ledger declarations persist while scheduler
      processes, tunnels, and workers require leased runtime ownership.
- [ ] Reject `durable: true` when no reconciler can reconstruct the runtime.
- [ ] Add desired-state versus observed-runtime-state diagnostics.
- [ ] Add a restart witness: kill Aiko, restart the reconciler, recover the
      receptor without duplicating an effect.

Gate: a ledger row alone can never be reported as a live watcher.

### Phase RM1 — Receptor schema v2

- [ ] Extend `receptor.schema.json` with ingress modes, delivery semantics,
      signature policy, bounds, cursor strategy, and privacy projection.
- [ ] Define versioned `Receptor`, `EventEnvelope`, `Effector`, `Transport`,
      `Cursor`, `HealthEvidence`, and typed error schemas.
- [ ] Add capability-negotiated extension fields without provider-owned core
      fields.
- [ ] Preserve v1 compilation compatibility.
- [ ] Generate typed event, cursor, transport, and effector capabilities.
- [ ] Add fixtures for a messaging surface and a non-messaging resource API.

Gate: provider names and credentials are unnecessary for Contract compilation,
and every fixture passes the same shape conformance suite.

### Phase RM1b — Hard-type kernel

- [ ] Implement closed/versioned sums for authority, effects, reversibility,
      outcomes, evidence, lifecycle, durability, health, delivery, freshness,
      change, progress, typed errors, HOLD reasons, and provenance.
- [ ] Implement opaque validated types for identities, authorization grants,
      idempotency keys, leases, retry policies, compensation capabilities,
      cursors, capabilities, and runtime bindings.
- [ ] Encode the legal lifecycle transition table and outcome-to-evidence
      compatibility matrix in Contract.
- [ ] Enforce parent-authority subset, current lease generation, payload
      privacy, bounded retry, and compensation requirements at construction.
- [ ] Generate Rust, TypeScript, JSON Schema, and native ABI representations
      from one canonical definition or prove them against shared golden vectors.
- [ ] Add explicit version negotiation, migration, and incompatible-version
      HOLD behavior.

Gate: invalid states cannot be constructed through any public boundary, all
language bindings accept and reject the same golden vectors, and replacing a
typed decision with string parsing turns a mutation witness red.

### Phase RM1c — Continuation ABI and resolver

- [ ] Define versioned schemas for `ContractContinuation<Input>` and
      `ContractResult<Output>`.
- [ ] Implement one native resolver for trigger, dependency, lineage,
      conversation/resource cursor, authority, obligation, evidence,
      contradiction, capability, freshness, privacy, budget, and settlement
      projections.
- [ ] Make projection deterministic under a fixed ledger snapshot and context
      budget.
- [ ] Bind each continuation to occurrence, lease generation, identity scope,
      schema version, and single-use or explicitly replayable token semantics.
- [ ] Add provider-neutral renderers for structured workers and messages-array
      model APIs.
- [ ] Validate worker results before any proposed effect can enter execution.

Gate: identical scoped ledger state produces identical projections; unrelated,
secret, stale, cross-identity, and over-budget evidence cannot enter the
continuation; a forged or stale result cannot settle or execute.

### Phase RM2 — Durable occurrence and cursor store

- [ ] Add atomic deduplication by receptor/source/event identity.
- [ ] Add compare-and-set generation cursors and leased cursor ownership.
- [ ] Add conditional-fetch metadata and canonical redacted fingerprints.
- [ ] Add retention, compaction, resync, and contradiction policies.

Gate: replay, race, out-of-order, changed-ID, expiry, and restart tests all
converge without event loss or duplicate effects.

### Phase RM3 — Generic transport registry

- [ ] Normalize poller, local listener, ephemeral tunnel, durable tunnel,
      hosted worker, and provider-native webhook as capabilities.
- [ ] Discover Cloudflare Tunnel/Worker adapters when installed, without naming
      Cloudflare in Contract core.
- [ ] Require lease, owner, health sensor, cancellation, restart policy, and
      bounded children for every live binding.
- [ ] Store endpoint and credentials only through secret references.

Gate: replacing the Cloudflare fixture with a second tunnel provider requires
only a new adapter descriptor and executor.

### Phase RM3b — Polymorphic substitution gate

- [ ] Build one provider-blind contract test kit for every interface role.
- [ ] Run identical lifecycle tests against at least two implementations per
      role.
- [ ] Mutation-test providers that omit fields, lie about durability, weaken
      authority, advance cursors early, or collapse unsupported variants.
- [ ] Require version negotiation and explicit incompatibility HOLD for future
      schema revisions.

Gate: any conforming implementation can replace another of the same role
without recompiling or branching the semantic Contract graph.

### Phase RM4 — Adaptive binding controller

- [ ] Rank bindings using event frequency, required latency, uptime, lease
      horizon, cost, privacy, setup authority, failure rate, and restart need.
- [ ] Add promotion thresholds, hysteresis, cooldown, and maximum spend.
- [ ] Implement zero-loss handoff: overlap receipts, converge by dedup key,
      switch acknowledgement ownership, then retire the old binding.
- [ ] Fall back safely when a durable binding loses health.

Gate: a synthetic load trace promotes polling → ephemeral → durable, then
degrades back without duplicate replies or missed occurrences.

### Phase RM5 — Universal receptor runtime

- [ ] Reconcile desired ledger bindings into bounded local or hosted workers.
- [ ] Compile every role through the generic
      `Cell<Input, State, Command, Receipt, Evidence, Output, Error>` lifecycle.
- [ ] Route every inbound event through the native Contract occurrence graph.
- [ ] Persist the triggering occurrence and resolve its
      `ContractContinuation` before starting any reasoning worker.
- [ ] Replace optional prompt-only context hints with the mandatory
      continuation readiness barrier for consequential work.
- [ ] Persist conversation turns, tool decisions, receipts, consequences, and
      open commitments as typed scoped occurrences.
- [ ] Ensure stateless workers recover bounded continuity from Contract rather
      than mutable in-process sessions.
- [ ] Route every outbound variant through the typed execution envelope.
- [ ] Separate provider receipt, effect acknowledgement, human consumption,
      and goal progress.
- [ ] Prevent cached, predicted, or provider-acknowledged evidence from being
      promoted beyond its compatible outcome state.
- [ ] Expose lag, last event, cursor generation, binding health, and HOLD reason.

Gate: process death, host restart, network partition, expired lease, and revoked
authority are independently witnessed.

### Phase RM6 — Telegram and remote-API witnesses

- [ ] Telegram fixture: accept webhook and polling delivery concurrently,
      deduplicate updates, preserve reply context, and exercise text, typing,
      reply, and voice variants.
- [ ] Telegram fixture: resolve the conversation continuation before calling
      either native Aiko or a messages-array persona/model provider.
- [ ] Prove a fresh worker recalls bounded prior turns, relevant settled
      contracts, open commitments, and current authority without a mutable
      process session.
- [ ] Tunnel fixture: run ephemeral ingress in development and durable ingress
      in a hosted environment.
- [ ] API-monitor fixture: use conditional requests and content fingerprints to
      emit an event only when a selected resource projection changes.
- [ ] CLI/TUI fixture: consume the same continuation ABI as Telegram and settle
      equivalent semantic work into the same lineage.
- [ ] Prove neither fixture adds a provider branch to Contract core.

Gate: both unlike interfaces compile from receptor specs and pass the same
conformance suite.

### Phase RM7 — Security and mutation gates

- [ ] Verify webhook signatures and reject oversized, stale, malformed, and
      replayed payloads.
- [ ] Redact credentials, endpoint secrets, user content, and raw API bodies
      from ledger, logs, prompts, and fingerprints.
- [ ] Fail closed for message sends, publication, tunnel deployment, webhook
      mutation, credential access, process persistence, and permission changes.
- [ ] Rotate any credential exposed in conversation or command history before
      production use.
- [ ] Mutation-test dedup, authority, signature, lease, cursor, and independent
      consequence sensors.

Gate: removing any one boundary turns its corresponding witness red.

## Required End-to-End Scenarios

1. A new receptor starts in polling mode and truthfully reports its live state.
2. An authorized development session acquires an ephemeral public endpoint.
3. Sustained demand promotes the same receptor to durable ingress.
4. Promotion overlaps transports without duplicate message effects.
5. A dead tunnel falls back to polling while retaining cursor continuity.
6. A restart reconstructs the runtime from ledger declarations and leases.
7. The same Telegram update arriving by polling and webhook becomes one
   occurrence.
8. A changed monitored API resource emits one semantic change event.
9. An unchanged resource returns a cache observation without firing children.
10. A reused event ID with changed content records a contradiction.
11. A reply acknowledgement does not falsely prove that the user consumed it.
12. A second, unlike provider uses the same receptor and transport substrate.
13. A fresh Telegram worker receives prior conversation and relevant Contract
    evidence before generating its response.
14. A CLI worker and Telegram worker receive equivalent continuations for the
    same semantic occurrence.
15. Cross-user conversation evidence cannot enter another identity scope.
16. A worker launched before continuation readiness is mechanically blocked.
17. A forged, replayed, or stale `ContractResult` cannot execute an effect or
    settle its parent.

## Verification Commands

Planned bounded witnesses:

```sh
python3 .agents/skills/contract-interface/scripts/conform.py <generated-pack>
bash scripts/witness-contract-receptor-restart.sh
bash scripts/witness-contract-transport-handoff.sh
bash scripts/witness-contract-event-dedup.sh
bash scripts/witness-contract-change-cursor.sh
bash scripts/witness-contract-interface-matrix.sh
```

The first four scripts are deliverables of this track, not claims that they
already exist.

## Definition of Done

This track is complete when an interface can be declared once, receive events
through polling or any registered tunnel/webhook transport, adapt its binding
from ephemeral to durable using grounded evidence, survive process restart,
detect semantic changes with bounded durable cursors, and invoke typed
effectors exactly once under authority. Every meaningful worker must receive a
valid bounded `ContractContinuation` before starting and return a validated
`ContractResult`; continuity must survive stateless workers and move unchanged
across interface and model providers. Contract must remain provider-neutral,
and disabling continuation readiness, identity isolation, result binding,
deduplication, lease recovery, authority, signature validation, or independent
sensing must fail a runnable witness.
