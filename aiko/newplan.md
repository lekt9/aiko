# Universal Contract-Native Aiko Plan

## Goal

Make Contract the stateful, local-first reflex substrate beneath Aiko while
keeping each Aiko reasoning worker disposable and stateless. Every ordinary
event, user turn, agent turn, and tool call must participate in one bounded
contract graph. Contract learns grounded state → action → outcome patterns,
ranks likely next actions by energy, prepares future work, and mechanically
fires only actions permitted by confidence, authority, risk, and resource
budgets.

This work is complete only when the behavior is universal. Telegram and other
adapters may describe domain capabilities, but they must not be the only paths
that create multi-contract graphs.

## Required lifecycle

```text
event or turn
  → declare one canonical root with inherited lineage and budgets
  → observe sanitized user/agent state
  → recall grounded state → action → outcome patterns
  → predict prerequisites, independent work, and future obligations
  → materialize a bounded child DAG
  → run eligible siblings concurrently in fresh stateless Aiko workers
  → gate consequential effects by authority and risk
  → observe every tool result and resulting state transition
  → create follow-up or scheduled contracts when evidence requires them
  → settle children from external evidence
  → settle the root only from grounded child outcomes
  → update energy, transition, cost, and confidence weights
```

## Invariants

1. Contract owns durable state; Aiko workers do not share conversational
   memory. Workers may read their contract, ancestors, bounded evidence, and
   relevant learned patterns.
2. Every normal Aiko turn declares exactly one canonical root contract.
3. `AIKO_CONTRACT_PARENT_ID` is consumed by native turn declaration. A child
   worker never creates an unrelated root or duplicate lineage record.
4. Every tool call is represented beneath the active turn, including its
   prerequisites, authorization decision, sanitized inputs, observed outcome,
   duration, cost, and state transition.
5. Multi-contract expansion is a mandatory substrate phase, not an optional
   Telegram-specific behavior.
6. Parents receive positive reinforcement only after required children have
   grounded successful outcomes. An LLM assertion is never completion proof.
7. Observation is automatic but privacy-minimized. Contract must not capture
   raw keystrokes, credentials, private document contents, or secret-shaped
   values as passive training data.
8. Reflexes are bounded and fail closed. No recursive explosion, unbounded
   worker spawning, or automatic consequential action.
9. Learned state must survive application and machine restarts and remain
   inspectable, correctable, exportable, and erasable by the user.
10. Domain skills describe APIs and composition patterns; core Contract owns
    lineage, ranking, scheduling, gating, execution waves, and feedback.

## Execution budgets

Each root creates an inherited budget envelope:

- maximum graph depth: 4;
- maximum children per node: 16;
- maximum concurrently live workers: configurable, default 4;
- maximum total children per root: 64;
- maximum automatic reflex cost per root: configurable and locally enforced;
- repeated `(state signature, action signature)` in one lineage: cycle hold;
- expired deadline or exhausted budget: held with a recorded reason;
- child processes increment `AIKO_CONTRACT_DEPTH` and inherit the root ID,
  parent ID, authority envelope, cancellation token, and remaining budget.

## Reflex policy

Contract assigns each candidate an energy and an execution class.

### Automatic observation

- application identity and foreground transitions;
- tool/binary/API identity;
- sanitized argument and result shapes;
- timing, exit status, resource cost, and externally observed state changes;
- user corrections, cancellations, repeats, and explicit preferences.

### Automatic preparation

- retrieve relevant contracts and capabilities;
- inspect safe local state;
- validate prerequisites;
- prepare arguments or artifacts without publishing them;
- create dependency children;
- record a future obligation or proposed schedule.

### Automatic firing

Only read-only or explicitly allowlisted, reversible local actions may fire
automatically, and only after sufficient grounded support. The initial default
threshold is at least three successful comparable observations, no unresolved
failure in the current context, acceptable predicted cost, and an unambiguous
capability match.

### Mandatory hold

Messages, purchases, job applications, credential access, deletion, publishing,
permission changes, external account mutation, and other consequential effects
remain held unless an applicable durable authority explicitly permits them.
Confidence never substitutes for authority.

## Energy and transition memory

Replace the process-only muscle bank with durable local storage. Each learned
cell records:

- sanitized context/state prototype;
- capability and version;
- predicted state delta;
- grounded successes and failures;
- recency and repetition;
- latency, token, compute, and monetary cost when known;
- authority/risk class;
- source lineage and evidence references;
- confidence calibration and last invalidation reason.

Ranking should minimize energy using context mismatch, predicted target-state
error, failure risk, cost, staleness, and authority friction. Repeated grounded
success lowers energy. Failure, correction, invalidation, or unexpected state
raises it. Raw observation volume alone must not increase confidence.

## Work phases

### Phase 1 — Canonical lineage and stateless workers

- Add a native declaration interface that accepts root ID, parent ID, depth,
  authority, and budgets.
- Make Rust consume `AIKO_CONTRACT_PARENT_ID` and reject malformed lineage.
- Prevent child Aiko processes from generating disconnected turn roots.
- Pass cancellation and remaining budgets to every descendant.
- Test nested workers through at least three generations.

Exit condition: every spawned worker appears exactly once beneath its actual
parent and cannot exceed inherited limits.

### Phase 2 — Universal pre-turn expansion

- Run Contract expansion after every root declaration and before model work.
- Build children for observation, relevant recall, prerequisite inspection,
  execution preparation, verification, and detected future obligations.
- Keep domain reasoning in skills while using the same core graph ABI.
- Return compact ranked graph context to the model.
- Remove adapter-only ownership of graph creation.

Exit condition: CLI, desktop, Telegram, scheduled, and subagent turns all enter
the same expansion path.

### Phase 3 — Tool calls become native children

- Bind every tool call to the active root/child contract.
- Materialize prerequisite and authorization children before execution.
- Permit independent prepared tool calls to execute concurrently.
- Record sanitized before/after state, result shape, duration, cost, and outcome.
- Settle the tool child mechanically from the tool result.
- Propagate failure and cancellation through dependent children.

Exit condition: no successfully dispatched tool call lacks a contract ID,
parent, gate result, observation, and settlement evidence.

### Phase 4 — Durable muscle memory and EBM ranking

- Persist learned cells across processes and restarts with atomic local writes.
- Hydrate the bank lazily and update it transactionally after grounded outcomes.
- Rank multiple candidates rather than returning only one opaque binary name.
- Include energy components and evidence counts in inspectable results.
- Support correction, decay, invalidation, deletion, and deterministic rebuild
  from the local event log.

Exit condition: a restarted Aiko recalls the same grounded capability ordering,
and corrected or failed behavior predictably loses rank.

### Phase 5 — Future preparation and schedules

- Infer follow-ups from grounded transition gaps, explicit deadlines, recurring
  patterns, and incomplete obligations.
- Represent inferred future work as proposed or held contracts first.
- Automatically schedule only when a durable user rule grants cadence and
  authority; otherwise surface the proposal without interrupting work.
- Re-evaluate prerequisites and authority when a scheduled occurrence fires.
- Deduplicate equivalent future contracts by semantic action/state signature.

Exit condition: demonstrated tasks create the correct follow-up contract, avoid
duplicates, survive restart, and do not execute external effects without
authority.

### Phase 6 — Local user-activity sensors

- Provide opt-in OS adapters for foreground application transitions, explicit
  shortcuts/commands, file-selection metadata, and other privacy-safe signals.
- Normalize sensor events into the same contract observation schema used by
  agent tools.
- Keep raw content local and excluded by default; redact secret-shaped data.
- Provide pause, inspect, delete, per-application exclusion, and retention
  controls in CLI and UI.
- Do not require cloud services.

Exit condition: an allowed repeated user workflow improves local ranking while
excluded applications and sensitive content produce no retained payload.

### Phase 7 — Reflex firing and operator surfaces

- Implement confidence/risk/authority thresholds in Contract, not prompts.
- Fire eligible safe reflexes through the normal child execution pipeline.
- Expose why a reflex fired, was prepared, or was held.
- Add UI/TUI views for the current graph, active workers, learned reflexes,
  schedules, evidence, correction, and deletion.
- Add a global kill switch and per-capability automatic-execution controls.

Exit condition: safe learned reflexes fire mechanically and consequential
effects remain held in adversarial and regression tests.

## Verification matrix

The implementation must include automated tests for:

- one canonical root and correct nested lineage;
- depth, fan-out, concurrency, total-work, cycle, timeout, and cancellation
  enforcement;
- universal expansion from CLI, desktop, scheduled, Telegram, and subagent
  entry points;
- parallel independent children and dependency barriers;
- a contract record for every tool call;
- grounded settlement and parent reward propagation;
- persistence across process and machine-style restart tests;
- energy improvement after repeated success and degradation after failure;
- automatic safe preparation and safe reflex firing;
- mandatory holds for consequential effects;
- inferred follow-up creation, schedule survival, and deduplication;
- redaction, exclusions, retention, pause, inspect, correction, and deletion;
- no cloud dependency for local operation.

## End-to-end acceptance scenario

1. A user performs a repeatable local workflow several times and Aiko also
   completes the equivalent workflow through tools.
2. Contract records sanitized events and grounded outcomes under canonical
   lineages.
3. After restart, a similar intent causes Contract to rank the learned workflow,
   materialize prerequisite and verification children, and run independent safe
   preparation concurrently.
4. An allowlisted reversible local step fires automatically after meeting the
   confidence threshold.
5. A proposed outbound message is prepared but held without authority.
6. A detected incomplete obligation becomes one deduplicated durable follow-up.
7. The user can inspect the energy/evidence explanation, correct the behavior,
   delete its learned cell, and observe that it is no longer recalled.

## Definition of done

Contract is no longer an optional observer attached to selected integrations.
It is the mandatory local substrate for every Aiko event, turn, child worker,
tool call, learned transition, reflex, and future obligation. Aiko reasoning
processes remain stateless; Contract provides durable memory and mechanically
grounded execution. All acceptance tests pass against the installed macOS
runtime and distributable package, with Windows behavior covered wherever the
platform exposes equivalent sensors and process controls.
