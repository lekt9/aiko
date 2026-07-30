# Self-Constructing Agent

## A Cardiac Execution and Governed Morphogenesis Pattern

Status: normative pattern plus runnable standalone reference wiring  
Version: 0.2  
Date: 2026-07-28  
Scope: Typed Neuron, Contract, and Aiko

---

## 1. Goal

Define the default agent as an admitted, recursively composable network of
typed Neurons rather than a privileged monolithic agent loop.

The resulting system must be able to:

- reconstruct itself from Contract artifacts and admitted Skill digests;
- receive a typed goal and compose work through ordinary Neuron firings;
- discover compatible existing binaries, tools, APIs, and limbs;
- generate typed adapters or new limbs when no compatible capability exists;
- independently test and admit generated code before it becomes executable;
- attach admitted limbs without restarting or modifying the kernel;
- route work by grounded, contextual energy rather than hard-coded preference;
- learn from verified outcomes;
- retire, revoke, and collect limbs safely;
- preserve one canonical Neuron decision and identity boundary throughout.

The agent is therefore:

```text
minimal trusted kernel
  + admitted Neuron limbs
  + immutable artifacts and evidence
  + typed topology
  + contextual routing weights
  + one CAS-rooted active snapshot
```

There is no separate programmable `Agent` primitive.

---

## 2. Thesis

A sufficiently composed limb is an agent.

A limb may contain smaller limbs, and the whole default agent may itself be
packaged as a larger Skill, provided every level:

1. implements the canonical Neuron contract;
2. receives no ambient authority;
3. writes generated source as inert data;
4. crosses independent admission before execution;
5. operates through Contract's ordinary firing and effect boundary;
6. exposes a bounded progress and settlement rule;
7. can be judged, revoked, detached, and replayed.

Self-construction does not mean self-authorization.

---

## 3. Irreducible Boundary

The limbs may replace agent policy, planning, routing, memory indexing,
verification, recovery, scheduling policy, and workflow composition. They do
not replace the trusted mechanisms required to execute untrusted decisions.

The permanent kernel remains responsible only for:

- canonical Neuron, Stimulus, Decision, Effect, Evidence, Message, and Artifact
  contracts;
- capability enforcement and sandbox isolation;
- schema validation and generated-code admission;
- content identity and provenance;
- atomic Contract transaction and effect-outbox primitives;
- minimal receptor delivery and admitted-Neuron execution;
- resource, deadline, cancellation, and emergency termination enforcement;
- tamper-evident firing records.

If a behavior can be implemented by an admitted Neuron reading a typed
stimulus and returning a typed decision, it belongs in a limb.

---

## 4. Cardiac Execution Model

The cardiac model describes the fast execution cycle. It is an operational
model, not a claim that engineered Neurons reproduce biological neurons.

Typed messages, artifacts, evidence, budgets, and work envelopes are the
blood. Contract is the durable circulation. Neurons are excitable decision
tissue. LLM inference supplies cognitive metabolism. Generated limbs are
governed morphogenesis.

One beat is:

```text
FILL
  pin stimulus, messages, snapshot, reads, Caps, deadline, and budget
    ↓
OXYGENATE
  perform a recorded LLM or deterministic capability read
    ↓
CONTRACT
  close all partial computation into one typed Decision
    ↓
VALVE
  validate schemas, grounding, authority, evidence, targets, and budgets
    ↓
EJECT
  atomically commit the decision and declared effects
    ↓
PERFUSE
  dispatch committed outbox effects to tools, binaries, APIs, or limbs
    ↓
RETURN
  receive typed adapter results and external sensor evidence
    ↓
VERIFY
  independently evaluate, settle, learn, and advance the snapshot
    ↓
REST
  terminate this workflow or wait for the next typed predicate
```

### 4.1 Dual circulation

```text
Pulmonary circulation
  unresolved intent → model reasoning → candidate decision

Systemic circulation
  validated decision → external action → measured evidence
```

An LLM-produced candidate is not evidence that the world changed. It becomes
settled only after the systemic path returns sufficient sensor and evaluator
evidence.

### 4.2 Stream rule

LLM stream deltas may be delivered to a user interface and recorded as
bounded observations, but they are inert. A partial stream must never directly
write, send, spawn, or dispatch an external effect.

The model adapter should expose:

```text
model.stream-start/v1
model.stream-delta/v1
model.stream-complete/v1
model.stream-cancelled/v1
model.stream-failed/v1
```

Only `model.stream-complete/v1` may be decoded into a candidate Decision.
That Decision must still pass the ordinary validation and commit valve.

### 4.3 Persistent liveness versus finite work

The organism may remain alive indefinitely, but an individual workflow may
not.

- The daemon heartbeat may wait indefinitely for new receptors.
- Every goal must settle by proof, typed rejection, cancellation, deadline, or
  exhausted budget.
- A cycle must expose monotonic progress or bounded attempts.
- Repeated firings without progress are an arrhythmia and must fail closed.

---

## 5. Multiple Biological Timescales

Self-construction must not occur inside every token or tool call. The system
uses distinct timescales:

| Timescale | Biological analogue | System behavior |
|---|---|---|
| Fast | heartbeat | fire, validate, commit, dispatch, settle |
| Medium | homeostasis | routing weights, backpressure, cache, retry, budgets |
| Slow | growth and repair | generate, judge, admit, attach, replace, retire limbs |
| Generational | evolution | change default patterns and compatibility contracts |

The heartbeat transports the information and evidence required for growth.
Morphogenesis changes topology only through a slower, separately governed
cycle.

---

## 6. Default Agent Limb

The default agent is an admitted Skill containing replaceable Neurons:

```text
receptor
  → intake
  → governor
  → context
  → planner
  → router
      ├→ compatible admitted limb
      ├→ executor
      └→ capability-gap
            → registry search
            → limb designer
            → independent limb judge
            → admission gate
            → attachment
            → retry original work
  → verifier
  → settler
      ├→ advance snapshot
      ├→ bounded recovery
      └→ terminate
```

Additional default responsibilities include memory indexing, retention
management, telemetry projection, and limb retirement. These remain limbs,
not privileged host policy.

The apparent agent state is reconstructed from:

```text
agents/<agent-id>/active
  → AgentSnapshot
      → Goal
      → Frontier
      → ContextManifest
      → TopologyManifest
      → CapabilityProfile
      → EvidenceIndex
      → MemoryIndex
      → admitted LimbRefs
```

Only the active snapshot pointer is mutable, and it advances by compare-and-swap.

---

## 7. Governed Self-Construction Loop

The slow loop is:

```text
OBSERVE
  inspect admitted capabilities, firing history, failures, cost, and topology
    ↓
DETECT
  emit a typed CapabilityGap with acceptance evidence and authority ceiling
    ↓
SEARCH
  look for an existing compatible admitted or external limb by interface
    ↓
DESCRIBE
  generate a NeuronDef, schemas, topology, tests, Caps proposal, and budgets
    ↓
WRITE
  persist the complete Skill package as inert content-addressed artifacts
    ↓
JUDGE
  independently test provenance, schemas, code, dependencies, and authority
    ↓
ADMIT
  admit or reject the exact package digest
    ↓
ATTACH
  grant least authority and commit typed topology edges
    ↓
OPERATE
  retry the original work through the newly admitted limb
    ↓
VERIFY
  judge the real result against the original acceptance predicate
    ↓
LEARN
  update contextual routing evidence only from verified outcomes
    ↓
RETIRE
  revoke, detach, settle descendants, retain audit roots, and collect garbage
```

Generation is not successful when source compiles. It is successful only when
the admitted limb resolves the original capability gap on the production path.

---

## 8. Making Existing Binaries Contract-Native

An existing executable does not need to be rewritten. It becomes
Contract-native through a typed, admitted adapter:

```text
discover executable
  → inspect version and declared interface
  → generate explicit input/output schemas
  → generate deterministic adapter Neuron
  → run sandboxed contract and adversarial tests
  → derive minimum capability grant
  → admit exact executable + adapter digest
  → attach to compatible receptors
  → dispatch through Contract outbox
  → settle from adapter acknowledgement and external sensors
  → rank from verified outcomes
```

Discovery is a read and grants no authority.

Secrets remain in capability adapters. They must never enter stimuli, model
prompts, generated source, decisions, artifacts, or logs.

Interactive, stateful, destructive, remote, or non-idempotent binaries require
specialized session, approval, idempotency, and reconciliation adapters. An
executable is not safe merely because its stdout can be decoded as JSON.

---

## 9. Explicit Interface Manifests

Auto-attachment must not infer a Neuron's interface from names such as
`Request`, `Input`, or `Trigger`.

Each Neuron definition must explicitly declare:

```json
{
  "id": "search",
  "accepts": ["search.request/v1"],
  "emits": ["search.result/v1", "search.failure/v1"],
  "argv": ["./search-adapter"],
  "caps_request": {
    "reads": ["workspace/**"],
    "writes": [],
    "sends": []
  }
}
```

An attach edge must bind one admitted producer schema to one admitted consumer
schema and include predicate, delivery mode, partition, priority, budget, and
package digest.

Schema compatibility is necessary but not sufficient. Current Caps, package
state, provenance, deadline, and policy must also be valid.

---

## 10. Contextual Energy Routing

Routing occurs only after hard eligibility filters:

```text
eligible =
  admitted digest
  ∧ compatible input/output schemas
  ∧ current Caps permit execution
  ∧ required artifacts are reachable
  ∧ policy and deadline permit execution
```

Only eligible candidates are ranked. Lower energy wins:

```text
energy =
  grounding penalty
  + evidence uncertainty
  + normalized cost
  + expected settlement distance
  + latency pressure
  + policy/risk violations
  + α × learned transition energy
```

Requirements:

- ranking is contextual, never a single global tool leaderboard;
- invalid candidates cannot be rescued by a low learned score;
- cold candidates carry explicit uncertainty;
- deterministic tie-breaking uses admitted digest and Neuron identity;
- only independently verified outcomes strengthen a candidate;
- contradiction, revocation, changed Caps, or changed code invalidates prior
  confidence;
- the model remains the fallback when no admitted limb is appropriate.

The dispatch decision is itself a recorded Neuron firing.

---

## 11. Required Production Wiring

The following wires close the loop.

### 11.1 Settlement event pump

After every committed firing, emit a durable `neuron.firing-settled/v1`
event. A bounded pump routes resulting messages and predicates until the
workflow settles or exhausts its budget.

### 11.2 Automatic introspection trigger

Route settlement events to the admitted introspection-trigger limb. Trigger
introspection on:

- a bounded firing cadence;
- repeated failures;
- high structural energy;
- unresolved receptor schemas;
- explicit operator request.

### 11.3 Admission-to-attachment

After an exact package digest is admitted, fire the auto-attacher with the
immutable admission artifact. Commit new edge manifests atomically. The
attacher may route authority already granted by admission; it may not widen it.

### 11.4 Live topology consumption

Contract's scheduler and Aiko's worker must observe committed topology versions
and route new stimuli without a process restart. A topology conflict produces
a typed conflict artifact or human gate, never last-write-wins mutation.

### 11.5 Dispatch control

The dispatch-router must run before the model or tool path, query Contract's
capability registry and learned energy, then return a typed branch or durable
message to the selected target.

### 11.6 Canonical preemption

Predictive reuse may propose a cache candidate, but the canonical runtime must
revalidate the complete cache identity, reachability, policy, and effect safety.
It must never independently reconstruct or replay a non-idempotent effect.

### 11.7 Production host pump

The closed loop must operate through Contract and Aiko, not only through the
standalone in-memory Neuron interpreter. Aiko owns model and product adapters;
Contract owns durable graph admission, node claims, firing transactions,
outbox settlement, replay, and evidence.

---

## 12. Current State as of 2026-07-28

Implemented and covered by the runnable reference gate:

- canonical Neuron wire and identity package;
- whole-decision validation and atomic effect semantics;
- atomic durable `neuron.firing-settled/v1` emission for pumped firings;
- non-reflexive lifecycle observation (settlement observers do not recursively
  generate settlement events for themselves);
- durable Pump subscriptions with acknowledgement only after consumer commit;
- automatic introspection-trigger firing with narrow state reconstruction and
  compare-and-swap updates;
- atomic limb admission record plus durable admission event;
- explicit per-Neuron `accepts` and `emits` interface declarations;
- admission-driven auto-attachment from explicit interfaces;
- live topology projection and routed dispatch without scheduler restart;
- exact cache-candidate proposal with zero effect replay, backed by the
  canonical runtime cache identity and safety checks;
- revocation/detachment that removes digest-owned live topology while
  preserving lifecycle audit roots;
- Contract's durable firing transaction and effect outbox;
- admitted Skill graph claim and settlement;
- standalone limb admission, execution, revocation, detachment, and GC;
- reference Meta-Agent lifecycle witness;
- introspection, gap analysis, promotion, and limb generation;
- structural energy, Contract muscle memory, and JEPA primitives;
- admitted, real-runtime-executed packages for preemptor, auto-attacher,
  introspection-trigger, and dispatch-router.

Not yet established by the production Contract/Aiko witness:

- dispatch control using real Contract EBM/JEPA evidence;
- LLM streaming as a typed capability-read lifecycle;
- arbitrary binary discovery through generated, independently admitted adapters;
- full default-agent replacement of the foreground monolithic loop;
- restart-safe end-to-end self-construction on the Contract/Aiko path.

Source presence is not attachment, and a pure-function composition test is not
the production lifecycle witness.

---

## 13. Implementation Order

Completed in the standalone canonical runtime:

1. Define explicit Neuron `accepts` and `emits` interfaces and event schemas.
2. Implement the durable, non-reflexive settlement-event pump.
3. Wire settlement events to automatic introspection with CAS state.
4. Wire admission events to auto-attachment.
5. Consume committed topology versions on every routed Pump call.
6. Implement exact safe cache proposal and canonical revalidation.
7. Remove digest-owned routing edges during detachment.

Remaining production integration order:

1. Make Contract and Aiko consume the same live topology versions.
2. Put the dispatch-router in control before Aiko model/tool dispatch.
3. Replace cold-start candidate constants with Contract EBM/JEPA queries.
4. Wrap LLM streaming in the typed model capability lifecycle.
5. Implement executable discovery and adapter generation.
6. Replace the foreground agent composition with the admitted default-agent
    limb.
7. Run the production completion witness.

Each step must preserve a working model fallback.

---

## 14. Target Production Completion Witness

### 14.1 Current runnable reference gate

Run:

```sh
bash tests/self-constructing-agent-gate.sh
```

The gate starts with an empty temporary durable substrate and proves:

1. all four reference limbs are admitted by exact package digest;
2. each admission atomically writes its immutable record and durable event;
3. the admitted auto-attacher consumes a digest-pinned admission artifact
   through the real ScriptNeuron and Runtime boundary;
4. explicit `accepts` declarations become typed edge manifests;
5. the admitted dispatcher consumes that newly committed edge after reopening
   the substrate and routes to the selected digest;
6. two admitted introspection-trigger firings reconstruct and CAS-update state
   across process restarts;
7. canonical runtime tests prove settlement pumping, post-commit durable
   acknowledgement, live edge consumption, and cache reuse without duplicated
   external effects;
8. revocation and detachment remove live topology, retain audit roots, and
   make the next compatible dispatch fall back to the model;
9. compaction and a final reopen reconstruct the same live state.

The former pure-function composition test remains a fast policy unit test. It
is not the binding completion witness.

### 14.2 Full Contract/Aiko witness

One runnable gate must prove the complete claim from an empty temporary state:

1. Start Contract with no generated limbs admitted.
2. Admit and attach only the default-agent seed package.
3. Deliver a typed goal through Aiko.
4. Confirm no compatible limb exists.
5. Discover a real local executable needed for the goal.
6. Generate a complete typed adapter Skill with narrow Caps.
7. Independently test and admit its exact digest.
8. Auto-attach it without restarting the host.
9. Retry the original work.
10. Prove the dispatch-router selected the limb using recorded energy evidence.
11. Commit its proposed effect before adapter dispatch.
12. Settle the exact outbox effect from real adapter and sensor evidence.
13. Terminate only when the original acceptance predicate is green.
14. Kill and restart the process.
15. Reconstruct the active agent, topology, limb, evidence, and routing history
    exclusively from Contract state.
16. Deliver a compatible second goal and prove the admitted limb is preferred.
17. Deliver a replay-safe equivalent request and prove canonical reuse causes
    no duplicate external effect.
18. Revoke and detach the limb.
19. Deliver another compatible request and prove routing safely falls back.
20. Verify audit roots remain while unreachable generated artifacts are
    collectable.

Additional falsifiers:

- terminate an LLM stream before completion: zero committed effects;
- change the executable digest after admission: execution rejected;
- request authority beyond the admitted ceiling: execution rejected;
- inject an invalid topology edge: whole commit rejected;
- replay a `send` or uncertain external effect: held for reconciliation;
- generate repeated limbs without progress: bounded settlement failure.

This gate, not the existence of source files, is the definition of “wired.”

---

## 15. Safety and Non-Goals

- The system does not auto-admit generated code.
- The system does not grant authority based on discovery or popularity.
- The system does not preempt nondeterministic or consequence-bearing work
  based only on semantic similarity.
- The system does not treat LLM output as external evidence.
- The system does not mutate admitted package contents in place.
- The system does not allow infinite workflow loops.
- The system does not remove the trusted kernel boundary.
- The system does not require every task to avoid the model; model reasoning
  remains an ordinary capability and fallback.
- The system does not claim distributed convergence until cross-machine
  artifact synchronization and cache identity agreement have runnable proofs.

---

## 16. Settlement Statement

The architecture is complete when the default agent is an admitted Neuron limb
whose durable identity is its packages, artifacts, evidence, topology, and
active snapshot—not a hidden in-memory object—and when that limb can safely
grow another admitted limb that resolves a real capability gap through the
same contract it inhabits.

The heartbeat keeps the system alive. Contract preserves circulation. Evidence
controls settlement. Governed morphogenesis changes what the system can become.
