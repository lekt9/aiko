---
name: typed-neuron-super-meta-patterns
description: >-
  Canonical catalog of the recurring patterns that govern Typed Neuron
  ontology, execution, state, trust, distributed composition, evolution, and
  reflexive self-improvement. Use before planning or generating coordination
  machinery; hard-filter eligible records, reuse an admitted pattern, or emit
  a governed PatternGap.
---

# Typed Neuron Super-Meta Pattern Catalog

Status: normative inventory; implementation status is recorded per pattern  
Version: 1.0  
Date: 2026-07-28  
Scope: `AGENTS.md` Part I plus its Meta-Agent, self-construction, and swarm projections

## 1. Purpose and Completeness Boundary

This document identifies the complete current set of super-meta patterns in the
Typed Neuron design. A super-meta pattern is not a feature or class. It is a
relation that repeats across at least three scales—firing, limb, agent, machine,
or swarm—or governs how other patterns are created, admitted, composed, judged,
reused, or retired.

“Complete” is deliberately bounded. The catalog is complete relative to the
normative architecture corpus at this version, not relative to every future
system someone could imagine. Its mechanical closure conditions are:

1. **Section closure** — every Part I section and numbered subsection in
   `AGENTS.md` maps to at least one catalog ID.
2. **Shape closure** — every record answers who, what, when, where, why, and how.
3. **Atom closure** — the record fields instantiate root, node, tree, verb,
   settle, witness, cache, seal, walk, and loop.
4. **Authority closure** — every automatic path names the boundary that prevents
   discovery, generation, ranking, or transport from becoming authority.
5. **Lifecycle closure** — every pattern names its trigger, settlement, failure,
   invalidation, and retirement behavior.
6. **Evidence closure** — every pattern has real sources and a falsifier.
7. **Honesty closure** — normative, partial, and implemented states are distinct.

`tests/check_super_meta_patterns.py` fails if one of these structural claims is
removed. A document pass proves catalog integrity only; a pattern is implemented
only when its stated behavioral witness runs on the real path.

## 2. The Meta-Superpattern Translation

Every catalog record is one self-similar node. Its fields implement the ten
atoms as follows:

| Atom | Catalog realization | Grounding |
|---|---|---|
| root | `Why` traces the invariant to the single Neuron primitive and system purpose | root of trust; end-to-end argument |
| node | one stable, versioned record answers all six interrogatives | 5W1H / Zachman |
| tree | `Relates` composes records and families recursively | composite pattern; fractal structure |
| verb | `How` reduces behavior to make, route, or read through typed Caps | command-query separation / CQRS |
| settle | `When` and `Lifecycle` declare proof, quorum, deadline, lease, or bounded exhaustion | quorum and bounded consensus |
| witness | `Falsifier` names an independent executable countercheck | N-version checking; two-person rule |
| cache | `Version` and content identity permit exact reuse | content-addressed memoization |
| seal | the catalog checker and behavioral gate prevent unverified admission | reproducible-build verification |
| walk | `Trigger` places the record on an explicit worklist | graph traversal; worklist algorithms |
| loop | every unresolved record follows Plan → Build → Test → Judge | PDCA / OODA |

Canonical prior-art sources:

- J. H. Saltzer, D. P. Reed, and D. D. Clark,
  [End-to-End Arguments in System Design](https://web.mit.edu/Saltzer/www/publications/endtoend/endtoend.pdf).
- C. A. R. Hoare,
  [Communicating Sequential Processes](https://www.cs.cmu.edu/~crary/819-f09/Hoare78.pdf).
- P. Hunt and T. Thomas, *The Pragmatic Programmer*, single authoritative
  representation principle.
- M. Fowler,
  [Command Query Separation](https://martinfowler.com/bliki/CommandQuerySeparation.html).
- M. Castro and B. Liskov,
  [Practical Byzantine Fault Tolerance](https://pmg.csail.mit.edu/papers/osdi99.pdf).
- S. Chacon and B. Straub,
  [Git Internals: Git Objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects).
- [Reproducible Builds](https://reproducible-builds.org/docs/definition/).
- E. W. Dijkstra,
  [Guarded Commands, Nondeterminacy and Formal Derivation of Programs](https://www.cs.utexas.edu/~EWD/transcriptions/EWD04xx/EWD472.html).

The repository-specific sources and witnesses are recorded on every pattern.

### root

- **parallel:** The catalog’s root is the single hard-typed Neuron primitive
  plus the runnable-witness axiom: no pattern may create a second executable
  ontology or declare its own success.
- **source_id:** src:AGENTS.md#2-the-single-primitive-the-neuron ·
  https://web.mit.edu/Saltzer/www/publications/endtoend/endtoend.pdf

### node

- **parallel:** One `PatternRecord` is the indivisible six-interrogative unit:
  why, what, who, when, where, and how must all be present.
- **source_id:** src:AGENTS.md#172-the-meta-superpattern-how-patterns-generate-and-apply-patterns ·
  https://en.wikipedia.org/wiki/Zachman_Framework

### tree

- **parallel:** Families and `Relates` edges form a self-similar catalog tree;
  every firing-, limb-, agent-, machine-, or swarm-scale child is another
  complete PatternRecord.
- **source_id:** src:AGENTS.md#7-standard-interface-and-infinite-hooking ·
  https://en.wikipedia.org/wiki/Composite_pattern

### verb

- **parallel:** Every pattern’s `How` reduces behavior to make, route, or read,
  realized as declarative effects, messaging/topology, or capability queries.
- **source_id:** src:AGENTS.md#3-core-operations-of-a-neuron ·
  https://martinfowler.com/bliki/CommandQuerySeparation.html

### settle

- **parallel:** `When`, `Lifecycle`, and `Status` make settlement explicit:
  proof, quorum, deadline, lease expiry, cancellation, or bounded exhaustion.
- **source_id:** src:AGENTS.md#26-topology-self-growth-and-settlement ·
  https://raft.github.io/

### witness

- **parallel:** Every record carries a `Falsifier`; behavioral completion needs
  an independent verifier, sensor, human gate, or runnable command.
- **source_id:** src:AGENTS.md#23-grounding-and-evidence ·
  https://en.wikipedia.org/wiki/N-version_programming

### cache

- **parallel:** Stable SMP IDs, versions, source digests, and settled witnesses
  let an identical pattern be found and revalidated rather than regenerated.
- **source_id:** src:AGENTS.md#25-determinism-and-content-addressed-caching ·
  https://git-scm.com/book/en/v2/Git-Internals-Git-Objects

### seal

- **parallel:** The catalog checker, mutation guards, document acceptance gate,
  and pattern-specific runtime witnesses prevent an incomplete record from
  being absorbed as a verified default.
- **source_id:** src:tests/check_super_meta_patterns.py ·
  https://reproducible-builds.org/docs/definition/

### walk

- **parallel:** Triggers place eligible records on an explicit worklist; hard
  filters prune it, relations expand it, and already settled records are reused.
- **source_id:** src:AGENTS.md#172-the-meta-superpattern-how-patterns-generate-and-apply-patterns ·
  https://en.wikipedia.org/wiki/Worklist

### loop

- **parallel:** Every residual runs Plan → Build → Test → Judge; failure becomes
  typed evidence for the next plan, and reflection may remove regressive layers.
- **source_id:** src:reference/SELF_CONSTRUCTING_AGENT.md#7-governed-self-construction-loop ·
  https://en.wikipedia.org/wiki/PDCA

## 3. Catalog Families

| Family | Pattern IDs | Governing question |
|---|---|---|
| Ontology | SMP-01–SMP-04 | What exists, and which layer is allowed to decide? |
| Execution | SMP-05–SMP-09 | How does one bounded unit move from stimulus to settlement? |
| State and identity | SMP-10–SMP-13 | How does a stateless unit create durable, replayable continuity? |
| Trust and evidence | SMP-14–SMP-18 | What may act, and what makes a claim believable? |
| Distributed composition | SMP-19–SMP-23 | How do independent nodes connect without inventing global truth? |
| Evolution | SMP-24–SMP-28 | How does the system grow, learn, fail, and simplify safely? |
| Reflexive governance | SMP-29–SMP-32 | How does the design govern its own patterns and claims? |

## 4. Canonical Pattern Records

### SMP-01 — One Primitive, Many Scales

- **Version:** `typed-neuron.super-pattern/SMP-01/v1`
- **Trigger:** Any proposal for a new executable agent, worker, gate, router, or orchestrator.
- **Why:** Prevent a second programmable ontology from splitting semantics and trust.
- **What:** Every executable behavior is a hard-typed polymorphic Neuron; larger things are compositions.
- **Who:** Neuron authors propose behavior; the canonical interpreter owns execution.
- **When:** Apply before design or admission; settle when the behavior fires through the standard interface.
- **Where:** Function, firing, limb, agent, machine node, and swarm.
- **How:** Read typed stimuli, make declarative decisions, and route through ordinary edges.
- **Trust boundary:** The harness remains interpreter and reference monitor, never another user-programmable unit.
- **Lifecycle:** specialize → compose → fire → verify → replace or retire.
- **Relates:** SMP-02, SMP-03, SMP-04, SMP-25.
- **Falsifier:** A claimed feature requires a privileged executable unit that cannot implement the Neuron contract.
- **Sources:** `AGENTS.md` §§2, 5–7, 17; `src/neuron.zig`; `src/tests.zig`.
- **Status:** implemented.

### SMP-02 — Polymorphic Specialization, Not Model Monoculture

- **Version:** `typed-neuron.super-pattern/SMP-02/v1`
- **Trigger:** Selecting an LLM, deterministic function, tool wrapper, verifier, or human gate.
- **Why:** Reliability comes from typed diversity and independent failure domains, not one universal model.
- **What:** Different implementations inhabit the same Neuron constructor without changing composition.
- **Who:** Planners choose eligible inhabitants; independent verifiers must not share the producer’s failure path.
- **When:** At capability selection and verification.
- **Where:** Local limbs, remote nodes, adapters, and human approval edges.
- **How:** Read interface requirements, route to an eligible implementation, make one typed decision.
- **Trust boundary:** An LLM has no authority beyond its Caps and is never evidence merely because it reasoned.
- **Lifecycle:** discover → hard-filter → select → observe → rerank or replace.
- **Relates:** SMP-01, SMP-17, SMP-23.
- **Falsifier:** Replacing a deterministic verifier with the same producing model is described as independent corroboration.
- **Sources:** `AGENTS.md` §§6–7, 23; `reference/META_AGENT.md` §§2, 6.
- **Status:** implemented.

### SMP-03 — Self-Similar Composition

- **Version:** `typed-neuron.super-pattern/SMP-03/v1`
- **Trigger:** A unit needs children, subwork, a larger package, or a cross-machine composition.
- **Why:** One grammar should remain valid from leaf firing to whole swarm.
- **What:** Nodes compose recursively; every subtree exposes the same typed boundary and settlement rules.
- **Who:** Parent Neurons propose children; the harness enforces cumulative bounds.
- **When:** During spawn, limb composition, agent construction, and mesh attachment.
- **Where:** Firing trees, topology manifests, Skill packages, and federated nodes.
- **How:** Make child definitions, route typed messages, read child evidence, and settle the parent.
- **Trust boundary:** Composition never implies capability inheritance.
- **Lifecycle:** decompose → attach → walk leaves → join evidence → settle or cancel descendants.
- **Relates:** SMP-01, SMP-10, SMP-20, SMP-25, SMP-29.
- **Falsifier:** A child bypasses the interface or inherits authority solely because its parent has it.
- **Sources:** `AGENTS.md` §§7, 11, 13, 30, 32; `src/topology.zig`.
- **Status:** implemented.

### SMP-04 — Mechanism Below, Policy in Limbs

- **Version:** `typed-neuron.super-pattern/SMP-04/v1`
- **Trigger:** A commonly used behavior is proposed for the trusted kernel.
- **Why:** Minimize permanent authority and keep policy replaceable.
- **What:** The kernel owns only irreducible enforcement, isolation, identity, atomicity, and liveness mechanisms.
- **Who:** Architecture reviewers judge placement; admitted limbs own domain policy.
- **When:** Before adding kernel code or privileged adapters.
- **Where:** Harness, substrate, capability adapters, and generated Skills.
- **How:** Read the end-to-end requirement; make a limb unless only the kernel can preserve the boundary.
- **Trust boundary:** Convenience, reuse, or performance alone cannot justify privilege.
- **Lifecycle:** classify → implement as limb or justify kernel → witness boundary → revisit.
- **Relates:** SMP-01, SMP-14, SMP-16, SMP-25, SMP-31.
- **Falsifier:** A policy can be expressed by an admitted Neuron but is hard-coded into the interpreter without a boundary necessity.
- **Sources:** `AGENTS.md` §§18, 30; `reference/SELF_CONSTRUCTING_AGENT.md` §3.
- **Status:** implemented.

### SMP-05 — Pure Decision, Declarative Effects

- **Version:** `typed-neuron.super-pattern/SMP-05/v1`
- **Trigger:** Computation wants to mutate the world, send, spawn, call a model, read time, or use randomness.
- **Why:** Make every consequential transition inspectable before it occurs.
- **What:** Neurons return one control result and zero or more declarative effects; nondeterministic reads enter through Caps.
- **Who:** Neurons decide; the harness validates and commits; adapters perform admitted external effects.
- **When:** On every firing.
- **Where:** Local runtime, script boundary, mesh receiver, Contract, and Aiko.
- **How:** Read through recorded Caps, make a Decision, route effects to the atomic commit boundary.
- **Trust boundary:** Neuron code never performs external effects directly.
- **Lifecycle:** receive → read → decide → validate → commit or reject.
- **Relates:** SMP-04, SMP-07, SMP-14, SMP-16.
- **Falsifier:** A Neuron writes a file, calls a tool, or sends a network request outside Caps before decision validation.
- **Sources:** `AGENTS.md` §§2–3, 18, 20; `src/runtime.zig`; `src/script.zig`.
- **Status:** implemented.

### SMP-06 — Sparse Receptor-Driven Firing

- **Version:** `typed-neuron.super-pattern/SMP-06/v1`
- **Trigger:** An external event, message, predicate, timer, watcher, or artifact change becomes ready.
- **Why:** Keep computation local, grounded, and proportional to actual change.
- **What:** Only receptor-ready Neurons fire; the rest of the network remains inert.
- **Who:** Receptors admit events; schedulers walk the ready frontier.
- **When:** On typed readiness, never through ambient polling without bounds.
- **Where:** Event queues, pumps, file watchers, webhooks, joins, and mesh ingress.
- **How:** Read the ready set, route one bounded stimulus, make only the necessary decision.
- **Trust boundary:** External events are untrusted data and cannot alter policy or Caps.
- **Lifecycle:** observe → admit → enqueue → fire → settle → wait.
- **Relates:** SMP-03, SMP-07, SMP-19, SMP-27.
- **Falsifier:** Unrelated network regions repeatedly execute without a typed trigger or progress measure.
- **Sources:** `AGENTS.md` §§4, 8, 11; `src/scheduler.zig`; `src/pump.zig`.
- **Status:** implemented.

### SMP-07 — Cardiac Valve and Dual Circulation

- **Version:** `typed-neuron.super-pattern/SMP-07/v1`
- **Trigger:** Model streaming or candidate reasoning must cross into committed action.
- **Why:** Separate cognitive generation from evidence that the external world changed.
- **What:** Fill → oxygenate → contract → validate → eject → perfuse → return → verify → rest.
- **Who:** Model/tool capabilities generate candidates; the validator is the valve; sensors and independent evaluators settle.
- **When:** Every consequential beat; partial streams remain inert.
- **Where:** Aiko model path, Contract outbox, adapters, sensors, and settlement pump.
- **How:** Read context, make a complete candidate Decision, route only validated committed effects.
- **Trust boundary:** Stream deltas and model assertions cannot directly write, send, spawn, or dispatch.
- **Lifecycle:** pulmonary candidate loop → valve → systemic effect loop → evidence return.
- **Relates:** SMP-05, SMP-16, SMP-17, SMP-18.
- **Falsifier:** A partial LLM token stream triggers a real external mutation.
- **Sources:** `reference/SELF_CONSTRUCTING_AGENT.md` §§4, 11; `tests/self-constructing-agent-gate.sh`.
- **Status:** partial.

### SMP-08 — Persistent Organism, Finite Work

- **Version:** `typed-neuron.super-pattern/SMP-08/v1`
- **Trigger:** A daemon, subscription, loop, or recurrent edge is introduced.
- **Why:** Allow continuous availability without permitting immortal unsettled workflows.
- **What:** The host may wait indefinitely; each invocation has proof, rejection, cancellation, deadline, or budget settlement.
- **Who:** The scheduler owns liveness; each workflow owns a bounded progress measure.
- **When:** At loop admission and every recurrence.
- **Where:** Daemons, pumps, retries, cycles, and mesh services.
- **How:** Route ready work, make bounded progress, read settlement predicates, then rest.
- **Trust boundary:** “Keep running” cannot erase cancellation, budget, or emergency termination.
- **Lifecycle:** wait → trigger → bounded work → settle → wait again.
- **Relates:** SMP-06, SMP-09, SMP-26, SMP-27.
- **Falsifier:** A finite workflow can return `continue forever` without monotonic progress or a bound.
- **Sources:** `AGENTS.md` §§20, 26–27; `reference/SELF_CONSTRUCTING_AGENT.md` §4.3.
- **Status:** implemented.

### SMP-09 — Multiple Timescales

- **Version:** `typed-neuron.super-pattern/SMP-09/v1`
- **Trigger:** Fast inference, operational adaptation, structural rewiring, and compatibility evolution compete.
- **Why:** Prevent high-frequency work from rewriting slow, safety-critical structure.
- **What:** Execution, learning, morphogenesis, and generational change run at separately governed cadences.
- **Who:** Fast-path Neurons act; slower meta-Neurons judge accumulated evidence and propose structural change.
- **When:** Per firing, per outcome window, per admission event, or per compatibility epoch.
- **Where:** Model calls, routing weights, topology, Skills, and canonical schemas.
- **How:** Read receipts at the appropriate horizon, make proposals at that horizon, route through its gate.
- **Trust boundary:** Faster loops cannot bypass slower admission or schema governance.
- **Lifecycle:** operate → aggregate evidence → propose slow change → independently admit → observe.
- **Relates:** SMP-07, SMP-13, SMP-25, SMP-28.
- **Falsifier:** One bad tool call immediately rewrites canonical topology or wire semantics.
- **Sources:** `reference/SELF_CONSTRUCTING_AGENT.md` §5; `AGENTS.md` §§25–26, 30.
- **Status:** partial.

### SMP-10 — Artifacts Are Reconstructible Memory

- **Version:** `typed-neuron.super-pattern/SMP-10/v1`
- **Trigger:** A stateless Neuron needs continuity across firings or sessions.
- **Why:** Preserve memory without hiding mutable state inside decision logic.
- **What:** Immutable, typed artifacts and messages reconstruct the narrow state required by a firing.
- **Who:** Writers produce artifacts; readers receive explicit narrow refs; the substrate preserves provenance.
- **When:** Write on committed decisions; read only when a stimulus permits it.
- **Where:** Files, event stores, indexes, generated code, topology, and Skill packages.
- **How:** Make immutable artifacts, route refs, read pinned slices.
- **Trust boundary:** Unconstrained scans and undeclared hidden memory are forbidden.
- **Lifecycle:** write → address → reference → reconstruct → retain or collect.
- **Relates:** SMP-03, SMP-11, SMP-12, SMP-13.
- **Falsifier:** Replaying recorded artifacts cannot reconstruct the decision-relevant state.
- **Sources:** `AGENTS.md` §§9–10, 19, 22; `src/substrate.zig`.
- **Status:** implemented.

### SMP-11 — Immutable Successors and CAS Roots

- **Version:** `typed-neuron.super-pattern/SMP-11/v1`
- **Trigger:** A durable mutable view, snapshot, topology, or index must advance.
- **Why:** Make concurrency conflicts explicit and prevent in-place history corruption.
- **What:** Mutation creates an immutable successor and advances a named root through compare-and-swap.
- **Who:** Neurons propose successors; the substrate serializes the CAS.
- **When:** At every durable state transition.
- **Where:** Artifacts, agent snapshots, topology manifests, indexes, and compaction.
- **How:** Read the pinned predecessor, make the successor, route a CAS write, retry from a fresh snapshot on conflict.
- **Trust boundary:** Last-write-wins cannot silently replace a conflicting admitted view.
- **Lifecycle:** snapshot → derive → CAS → commit or conflict → re-read.
- **Relates:** SMP-10, SMP-20, SMP-22.
- **Falsifier:** Two conflicting updates both claim the same predecessor and both commit.
- **Sources:** `AGENTS.md` §§20, 22, 26; `src/substrate.zig`; `src/meta_agent.zig`.
- **Status:** implemented.

### SMP-12 — Content Identity, Cache, and Replay

- **Version:** `typed-neuron.super-pattern/SMP-12/v1`
- **Trigger:** Work, code, artifacts, or packages may be identical to a settled prior result.
- **Why:** Reuse exact verified computation without confusing similarity with identity.
- **What:** Canonical serialization and complete input fingerprints key cache and replay.
- **Who:** The canonical package computes identity; the harness revalidates present policy before reuse.
- **When:** After effective inputs and read sets are known; never for unsafe external effects.
- **Where:** Firings, artifacts, admitted Skills, generated bindings, and distributed cache proposals.
- **How:** Read complete fingerprints, route hits through revalidation, make on miss, compare decision digests.
- **Trust boundary:** A cache hit cannot revive revoked authority or replay a non-idempotent external effect.
- **Lifecycle:** fingerprint → lookup → validate hit or execute miss → commit → retain.
- **Relates:** SMP-10, SMP-13, SMP-17, SMP-24.
- **Falsifier:** Changing code, Caps, read set, adapter, schema, clock, or random input leaves the cache key unchanged.
- **Sources:** `AGENTS.md` §§14, 25, 28; `src/cache.zig`; `src/wire.zig`.
- **Status:** implemented.

### SMP-13 — Provenance as Causal Spine

- **Version:** `typed-neuron.super-pattern/SMP-13/v1`
- **Trigger:** A read, claim, effect, topology change, or learned weight must be explained.
- **Why:** Make every meaningful result traceable and invalidatable.
- **What:** Causation, correlation, source digests, producer, time, method, and evidence bind the history.
- **Who:** Capability adapters record reads; producers cite; verifiers corroborate; auditors replay.
- **When:** During every capability read, decision, commit, and evaluation.
- **Where:** Stimuli, evidence, artifacts, messages, firing records, caches, and manifests.
- **How:** Read only recorded sources, make claims with digests, route causal IDs end-to-end.
- **Trust boundary:** Prompt or tool output cannot cite itself into authority.
- **Lifecycle:** observe → record → claim → verify → invalidate dependents when a source changes.
- **Relates:** SMP-10, SMP-12, SMP-17, SMP-21.
- **Falsifier:** An externally meaningful claim has no path to a stimulus field, message, artifact, or capability read.
- **Sources:** `AGENTS.md` §§19, 23, 28; `src/observability.zig`.
- **Status:** implemented.

### SMP-14 — Least Authority and Deny by Default

- **Version:** `typed-neuron.super-pattern/SMP-14/v1`
- **Trigger:** Any read, write, send, spawn, delegation, declassification, or external action is requested.
- **Why:** Bound blast radius and prevent composition from silently widening power.
- **What:** Immutable Caps name resource, verb, classification, budget, expiry, delegation, and approval limits.
- **Who:** Policy or humans grant; the harness enforces; Neurons may only propose attenuation.
- **When:** At admission and before every capability operation.
- **Where:** Firings, limbs, adapters, mesh peers, generated code, and caches.
- **How:** Read the exact grant, hard-filter the action, make only allowed effects, route denials as typed failures.
- **Trust boundary:** Secrets remain in adapters; generated grants and prompt content have no ambient force.
- **Lifecycle:** request → approve/deny → exercise → observe → expire/revoke.
- **Relates:** SMP-04, SMP-15, SMP-16, SMP-18, SMP-23.
- **Falsifier:** A child, peer, generated limb, or cache hit exercises authority absent from its immutable grant.
- **Sources:** `AGENTS.md` §§16, 18, 24; `src/caps.zig`.
- **Status:** implemented.

### SMP-15 — Discovery Is Not Authority

- **Version:** `typed-neuron.super-pattern/SMP-15/v1`
- **Trigger:** A binary, Skill, peer, endpoint, schema, package, or capability is discovered.
- **Why:** Prevent observation and convenience from becoming installation, execution, trust, or attachment.
- **What:** Discovery emits inert candidates; installation, admission, attachment, and execution are separate governed writes.
- **Who:** Registry/discovery Neurons read; judges and harness gates admit.
- **When:** At every discovery boundary.
- **Where:** Filesystems, registries, mesh claims, package indexes, and model-suggested tools.
- **How:** Read metadata, make a candidate artifact, route it to independent validation.
- **Trust boundary:** A name, network presence, signature, or successful probe alone grants no Caps.
- **Lifecycle:** discover → pin → inspect → test → propose → admit/reject.
- **Relates:** SMP-14, SMP-16, SMP-21, SMP-24.
- **Falsifier:** Discovering an executable or peer makes it runnable or routable before admission.
- **Sources:** `AGENTS.md` §§24, 29–30; `reference/SELF_CONSTRUCTING_AGENT.md` §8.
- **Status:** implemented.

### SMP-16 — Generated and Imported Code Is Inert Until Admission

- **Version:** `typed-neuron.super-pattern/SMP-16/v1`
- **Trigger:** A Neuron writes source, a Skill is imported, or an adapter is generated.
- **Why:** Separate creativity from executable authority.
- **What:** Source and packages remain content-addressed data until schema, provenance, code, dependency, adversarial, and Caps tests pass.
- **Who:** Designers generate; independent judges test; the harness admits exact digests.
- **When:** Before first execution and after any code/dependency change.
- **Where:** Skill registries, limb packages, script adapters, and cross-machine package offers.
- **How:** Make inert artifacts, route them through judges, read admission receipts, attach only exact digests.
- **Trust boundary:** Generators cannot admit themselves or inherit their creator’s Caps.
- **Lifecycle:** describe → write → scan/test → admit/reject → attach → revoke/detach.
- **Relates:** SMP-14, SMP-15, SMP-24, SMP-25.
- **Falsifier:** Generated source executes because it exists or compiles, without independent admission.
- **Sources:** `AGENTS.md` §§18, 29–30; `src/limb_ops.zig`; `limbs/outbox-drainer/tests/lifecycle.py`.
- **Status:** implemented.

### SMP-17 — Grounded, Independent Evidence

- **Version:** `typed-neuron.super-pattern/SMP-17/v1`
- **Trigger:** A decision makes an externally meaningful claim or declares completion.
- **Why:** Prevent fluent assertion from substituting for measured reality.
- **What:** Evidence cites recorded provenance; high-impact claims require an independent implementation, data path, model, or authority.
- **Who:** Producers make claims; independent verifiers or humans corroborate.
- **When:** Before validation and settlement.
- **Where:** Decisions, adapter acknowledgements, sensors, tests, joins, and human gates.
- **How:** Read provenance, make a falsifiable claim, route to independent witness, settle on threshold or insufficiency.
- **Trust boundary:** Asking the same model twice is not independence; absence of evidence is not negative evidence.
- **Lifecycle:** claim → corroborate → accept/reject/insufficient → invalidate when sources change.
- **Relates:** SMP-02, SMP-07, SMP-13, SMP-30.
- **Falsifier:** A success claim is admitted with undeclared sources or same-failure-domain corroboration.
- **Sources:** `AGENTS.md` §§8, 23, 31; `src/runtime.zig`; `tests/meta-agent-gate.sh`.
- **Status:** implemented.

### SMP-18 — Adapter Membrane, Outbox, and Reconciliation

- **Version:** `typed-neuron.super-pattern/SMP-18/v1`
- **Trigger:** A committed effect must cross into a tool, binary, API, payment, or other external system.
- **Why:** Preserve atomic intent and audit despite a non-atomic outside world.
- **What:** Commit an outbox effect first, dispatch with idempotency, settle from acknowledgement, and park uncertainty for reconciliation.
- **Who:** Contract owns intent; Aiko/adapters dispatch; sensors settle; reconcilers handle uncertainty.
- **When:** For every consequential external effect.
- **Where:** Production Contract/Aiko path, script adapters, mesh gateways, and outbox limbs.
- **How:** Make the outbox record, route it to a bounded adapter, read acknowledgement, make settlement or reconciliation evidence.
- **Trust boundary:** Exactly-once external effects are not claimed; secrets and raw authority stay in adapters.
- **Lifecycle:** admit intent → dispatch → acknowledge → settle or reconcile → compensate if authorized.
- **Relates:** SMP-05, SMP-07, SMP-14, SMP-20.
- **Falsifier:** An uncertain external result is silently retried or marked successful without reconciliation evidence.
- **Sources:** `AGENTS.md` §§20–21, 27, 30; `IMPLEMENTATION.md` §§Production interpreter, Production host; `limbs/outbox-drainer/`.
- **Status:** implemented.

### SMP-19 — Typed Messaging with At-Least-Once Idempotency

- **Version:** `typed-neuron.super-pattern/SMP-19/v1`
- **Trigger:** Work crosses a Neuron, channel, process, or machine boundary.
- **Why:** Preserve causal delivery under retries, duplication, reordering, and restart.
- **What:** Versioned messages carry stable firing, causation, correlation, durability, TTL, and partition semantics.
- **Who:** Senders choose durable or transient delivery; receivers commit before acknowledgement.
- **When:** At every message boundary and retry.
- **Where:** Substrate queues, pumps, MCP, mesh, and adapter outboxes.
- **How:** Make a typed envelope, route by partition, read commit response, deduplicate by stable identities.
- **Trust boundary:** Transient messages cannot carry correctness-critical facts; cross-channel order is undefined.
- **Lifecycle:** enqueue → deliver → commit → acknowledge; retry/backoff → dead-letter when poisoned.
- **Relates:** SMP-06, SMP-12, SMP-18, SMP-20.
- **Falsifier:** Redelivery duplicates an effect or a receiver acknowledges before commit.
- **Sources:** `AGENTS.md` §§10, 21; `src/delivery.zig`; `src/mesh.zig`.
- **Status:** implemented.

### SMP-20 — Topology Is Typed, Versioned Data

- **Version:** `typed-neuron.super-pattern/SMP-20/v1`
- **Trigger:** A route, join, cycle, attachment, partition, or connection changes.
- **Why:** Make structure inspectable, replaceable, conflict-aware, and governed.
- **What:** Edges bind schemas, predicates, delivery, partition, priority, budgets, digests, and settlement.
- **Who:** Neurons propose topology; the substrate admits versions; schedulers consume active manifests.
- **When:** At attachment, rewiring, convergence, expiry, and retirement.
- **Where:** Local graphs, agent snapshots, Skill attachments, and mesh manifests.
- **How:** Read active topology, make a successor artifact, route it through validation and CAS.
- **Trust boundary:** Transport reachability and implementation names cannot silently create an edge.
- **Lifecycle:** propose → validate → CAS-admit → route → observe → replace/detach.
- **Relates:** SMP-03, SMP-11, SMP-21, SMP-22.
- **Falsifier:** A route changes without a versioned edge artifact and atomic active-root transition.
- **Sources:** `AGENTS.md` §§11, 26; `src/topology.zig`; `reference/META_AGENT.md` §§4, 6–7.
- **Status:** implemented locally; distributed projection partial.

### SMP-21 — Contract-Native Mesh Formation

- **Version:** `typed-neuron.super-pattern/SMP-21/v1`
- **Trigger:** An authenticated remote node becomes reachable.
- **Why:** Turn address-directed transport into governed relative awareness without equating presence and trust.
- **What:** NodeClaim, PresenceLease, EdgeContract, and TopologyManifest artifacts negotiate mutually accepted routes.
- **Who:** Membership/topology limbs propose; endpoint policies accept; Contract/substrates admit.
- **When:** Before first non-health remote firing and throughout lease renewal.
- **Where:** Tailnet peers, machine nodes, partitions, and federated topology views.
- **How:** Read authenticated claims, make bounded leases and edge proposals, route exact digests through bilateral acceptance.
- **Trust boundary:** Discovery and heartbeat grant no authority; each side retains local settlement authority.
- **Lifecycle:** claim → lease → negotiate → accept → admit → attach → operate → renew/reconcile → retire.
- **Relates:** SMP-14, SMP-15, SMP-19, SMP-20, SMP-22, SMP-23.
- **Falsifier:** A reachable peer becomes trusted/routable without mutually admitted schemas, Caps, digests, and lease.
- **Sources:** `AGENTS.md` §26.1; `reference/SWARM_NODE.md`; `tests/swarm-package-gate.sh`.
- **Status:** normative-unimplemented beyond address-directed transport.

### SMP-22 — Federated Local Truth and Explicit Convergence

- **Version:** `typed-neuron.super-pattern/SMP-22/v1`
- **Trigger:** Independent machines or partitions hold different topology, artifacts, clocks, or cache entries.
- **Why:** Avoid fabricated global consistency while permitting governed convergence.
- **What:** Each node owns a causal manifest; conflicts, barriers, joins, merge policy, and quorum are explicit typed contracts.
- **Who:** Local substrates settle locally; reconciliation Neurons compare causal versions; human/quorum gates resolve policy conflicts.
- **When:** On reconnect, partition healing, cross-partition join, or detected divergence.
- **Where:** Mesh topology, artifact replication, distributed caches, and peer messages.
- **How:** Read causal predecessors, make merge/conflict artifacts, route through explicit reconciliation.
- **Trust boundary:** No node may overwrite another’s view or claim consensus without the declared quorum.
- **Lifecycle:** diverge → detect → exchange digests → merge/reject/gate → advance local roots.
- **Relates:** SMP-11, SMP-13, SMP-20, SMP-21.
- **Falsifier:** The implementation claims one current global view during a partition or silently uses last-write-wins.
- **Sources:** `AGENTS.md` §§22, 26.1; `reference/ROADMAP.md`; `reference/SWARM_NODE.md`.
- **Status:** normative-unimplemented.

### SMP-23 — Hard Eligibility Before Contextual Ranking

- **Version:** `typed-neuron.super-pattern/SMP-23/v1`
- **Trigger:** Multiple tools, limbs, peers, patterns, or cached results could handle work.
- **Why:** Keep optimization subordinate to correctness and authority.
- **What:** Schemas, admission, Caps, provenance, reachability, policy, deadline, and settlement filter candidates before energy ranking.
- **Who:** Governors and validators determine eligibility; routers rank only survivors.
- **When:** On every dispatch and reroute.
- **Where:** Meta-Agent router, energy router, pattern registry, mesh, and cache preemption.
- **How:** Read hard constraints, route rejects away, rank eligible candidates by evidence, energy, cost, latency, and load.
- **Trust boundary:** Scores, payment, popularity, model preference, and history cannot rescue an ineligible candidate.
- **Lifecycle:** enumerate → hard-filter → rank → dispatch → verify outcome → update evidence.
- **Relates:** SMP-02, SMP-12, SMP-14, SMP-21, SMP-24.
- **Falsifier:** A lower-energy candidate executes despite incompatible schemas or insufficient Caps.
- **Sources:** `AGENTS.md` §§17.2, 26.1; `reference/SELF_CONSTRUCTING_AGENT.md` §10; `src/energy_router.zig`.
- **Status:** implemented locally; mesh-wide routing unimplemented.

### SMP-24 — Reuse Before Generation

- **Version:** `typed-neuron.super-pattern/SMP-24/v1`
- **Trigger:** A capability gap, pattern gap, or unresolved interface appears.
- **Why:** Avoid divergent duplicates and preserve tested, content-addressed knowledge.
- **What:** Search admitted compatible digests before discovering external packages or generating new code.
- **Who:** Registry/introspection Neurons search; designers generate only after a typed miss.
- **When:** Before every generation cycle.
- **Where:** Skills, limbs, adapters, patterns, caches, and mesh package offers.
- **How:** Read registries and interface manifests, route eligible hits to reuse, make a gap artifact on miss.
- **Trust boundary:** Reuse still revalidates current Caps, policy, reachability, and revocation.
- **Lifecycle:** describe gap → search local → search external → reuse or generate → record outcome.
- **Relates:** SMP-12, SMP-15, SMP-16, SMP-23, SMP-29.
- **Falsifier:** A new package duplicates an admitted compatible digest without documented incompatibility evidence.
- **Sources:** `AGENTS.md` §§12, 29–30; `reference/META_AGENT.md` §7; `limbs/introspection/`.
- **Status:** partial.

### SMP-25 — Generative Limb Lifecycle

- **Version:** `typed-neuron.super-pattern/SMP-25/v1`
- **Trigger:** A reusable higher-order capability is needed.
- **Why:** Let the system grow without expanding the kernel or creating a second primitive.
- **What:** A Skill-packaged network follows describe → write → admit → attach → operate → judge → cache → retire.
- **Who:** Designers generate, judges validate, harnesses admit, operators/policy grant, observers judge.
- **When:** From capability gap through obsolescence.
- **Where:** Planners, verifiers, routers, schedulers, recovery, topology, and human gates.
- **How:** Make inert package artifacts, route them through admission, read witnesses, attach and operate under least Caps.
- **Trust boundary:** Self-generation never means self-authorization.
- **Lifecycle:** describe → write → admit → attach → operate → judge → cache → retire.
- **Relates:** SMP-03, SMP-04, SMP-16, SMP-24, SMP-26.
- **Falsifier:** A built-in class registered under a Skill-shaped name is claimed as generated-limb lifecycle evidence.
- **Sources:** `AGENTS.md` §30; `src/limb_ops.zig`; `limbs/outbox-drainer/tests/lifecycle.py`.
- **Status:** implemented.

### SMP-26 — Bounded Growth, Progress, and Retirement

- **Version:** `typed-neuron.super-pattern/SMP-26/v1`
- **Trigger:** Spawn, retry, cycle, fan-out, self-construction, or durable attachment is proposed.
- **Why:** Prevent uncontrolled resource growth and immortal obsolete structure.
- **What:** Depth, fan-out, cost, attempts, deadline, progress, ownership, and collection bounds govern growth.
- **Who:** The harness enforces budgets; settlement and GC Neurons close descendants and remove unreachable artifacts.
- **When:** At admission, each recurrence, cancellation, and retirement.
- **Where:** Firing trees, loops, joins, generated limbs, topology, and caches.
- **How:** Read cumulative budgets, make bounded children, route failures, collect unreachable state.
- **Trust boundary:** A child cannot reset cumulative limits or hide work in a side channel.
- **Lifecycle:** bound → grow → measure progress → settle/cancel → detach → collect.
- **Relates:** SMP-03, SMP-08, SMP-20, SMP-25, SMP-27.
- **Falsifier:** A cycle lacks a monotonic progress measure or bounded attempts.
- **Sources:** `AGENTS.md` §§13, 16, 26–27, 30; `src/topology.zig`; `limbs/fanout/tests/conformance.py`.
- **Status:** implemented.

### SMP-27 — Typed Failure as the Next Stimulus

- **Version:** `typed-neuron.super-pattern/SMP-27/v1`
- **Trigger:** Validation, denial, timeout, conflict, poison, dependency, invariant, or external uncertainty occurs.
- **Why:** Turn failure into bounded evidence for recovery rather than hidden control flow.
- **What:** Failures are typed, classified by retryability, recorded, and routed to retry, recovery, dead-letter, reconciliation, or human gates.
- **Who:** The failing boundary emits evidence; recovery policy selects a bounded next step.
- **When:** Immediately on failure and before any retry.
- **Where:** Runtime, delivery, adapters, joins, mesh, limb admission, and pattern generation.
- **How:** Make a failure artifact, route by class, read fresh evidence, re-plan or settle.
- **Trust boundary:** Validation, denial, poison, and invariants do not automatically retry.
- **Lifecycle:** fail → classify → record → compensate/retry/gate/settle → learn.
- **Relates:** SMP-08, SMP-18, SMP-26, SMP-28, SMP-30.
- **Falsifier:** An uncertain or invariant-violating action is silently retried without new evidence.
- **Sources:** `AGENTS.md` §27; `src/delivery.zig`; `src/runtime.zig`.
- **Status:** implemented.

### SMP-28 — Reflect and Rebalance from Receipts

- **Version:** `typed-neuron.super-pattern/SMP-28/v1`
- **Trigger:** Success declines after accumulating policies, limbs, prompts, or ranking features.
- **Why:** More apparently good layers can interact to reduce system performance.
- **What:** Compare the outcome ledger across changes, find the last verified peak, remove or lighten post-peak additions, and retest.
- **Who:** Reflection/evaluation Neurons read receipts; independent benchmarks judge the rebalance.
- **When:** On regression, complexity growth, repeated failure, or bounded review cadence.
- **Where:** Routing policy, prompts, limbs, topology, pattern registry, and model selection.
- **How:** Read longitudinal evidence, route to the peak configuration, make the smallest reversible simplification, gate it.
- **Trust boundary:** Reflection cannot erase audit or cherry-pick only successful receipts.
- **Lifecycle:** detect decline → locate peak → hypothesize interaction → simplify → test → retain or revert.
- **Relates:** SMP-09, SMP-13, SMP-23, SMP-27, SMP-30.
- **Falsifier:** Added complexity is retained despite a reproducible regression and no independent counterevidence.
- **Sources:** `$jesus-pattern:amen` §reflect; `bench/jespa/benchmarks-ledger.jsonl`; `bench/jespa/jespa-benchmarks-gate.sh`.
- **Status:** partial.

### SMP-29 — Pattern Registry and Pattern Gaps

- **Version:** `typed-neuron.super-pattern/SMP-29/v1`
- **Trigger:** Planning, generation, attachment, repair, or a recurring architectural relation begins.
- **Why:** Make architectural memory queryable and stop rediscovering incompatible mechanisms.
- **What:** PatternRecords carry triggers, six interrogatives, relations, authority boundaries, lifecycle, sources, status, and falsifiers.
- **Who:** Registry Neurons match; designers propose gaps; governed source review changes the normative catalog.
- **When:** Before design and after a verified new recurring relation emerges.
- **Where:** `AGENTS.md`, this catalog, admitted pattern projections, and planning stimuli.
- **How:** Read the registry, hard-filter and rank matches, route reuse, make a PatternGap on miss.
- **Trust boundary:** A proposed pattern cannot self-register, self-admit, grant Caps, or weaken the root contract.
- **Lifecycle:** query → match/reuse or gap → derive → document → check → behaviorally witness → absorb.
- **Relates:** SMP-03, SMP-23, SMP-24, SMP-30, SMP-31.
- **Falsifier:** New coordination machinery is built without a registry lookup or explicit PatternGap.
- **Sources:** `AGENTS.md` §§17.1–17.2, 32; `tests/check_super_meta_patterns.py`.
- **Status:** normative-unimplemented as an automatic runtime Neuron; document registry implemented.

### SMP-30 — Runnable Witness, No Fabricated Green

- **Version:** `typed-neuron.super-pattern/SMP-30/v1`
- **Trigger:** Any claim says a pattern, feature, task, or workflow is complete.
- **Why:** Bind completion to external behavior rather than confidence or file presence.
- **What:** A named command or independent sensor must exercise the real path and decide pass/fail.
- **Who:** Builders propose; an independent gate is the binding witness.
- **When:** Before settlement, admission, release, or absorption into the corpus.
- **Where:** Unit tests, integration gates, production sensors, benchmarks, and human approval.
- **How:** Read acceptance criteria, make the real artifact, route it through the pinned check, judge receipts.
- **Trust boundary:** Typechecks, source presence, prose, and same-model agreement cannot impersonate runtime correctness.
- **Lifecycle:** specify failing witness → build → run → judge → re-plan or seal.
- **Relates:** SMP-17, SMP-27, SMP-28, SMP-29, SMP-31.
- **Falsifier:** A completion claim has no runnable command or independent external evidence.
- **Sources:** `AGENTS.md` §§31, 33–34; `tests/gate.sh`; `$jesus-pattern:amen`.
- **Status:** implemented.

### SMP-31 — Authority Layers and Honest Documentation

- **Version:** `typed-neuron.super-pattern/SMP-31/v1`
- **Trigger:** A specification, implementation map, roadmap, generated binding, or status claim changes.
- **Why:** Prevent target architecture, current code, codec projections, and future work from being conflated.
- **What:** AGENTS is normative; implementation docs are descriptive; executable schemas/modules govern runtime; roadmaps contain only unsettled work.
- **Who:** Authors maintain claims; gates compare sources; operators trust executable authorities.
- **When:** On every architectural or implementation change.
- **Where:** Part I/II, IMPLEMENTATION, ROADMAP, generated bindings, code, and witnesses.
- **How:** Read authority order, make the change in the owning source, route derived updates, run drift and honesty gates.
- **Trust boundary:** A generated codec, stale prose, prototype directory, or document-only pass is not semantic/runtime authority.
- **Lifecycle:** identify owner → change source → regenerate projections → test → update status/roadmap.
- **Relates:** SMP-04, SMP-12, SMP-29, SMP-30.
- **Falsifier:** Descriptive documentation claims implemented behavior absent from the executable witness.
- **Sources:** `AGENTS.md` §§18, 31, 34–41; `IMPLEMENTATION.md` §Documentation authority; `tests/check-production-neuron.sh`.
- **Status:** implemented.

### SMP-32 — Analogy Must Translate, Not Collapse Differences

- **Version:** `typed-neuron.super-pattern/SMP-32/v1`
- **Trigger:** Biology, cognition, economics, theology, or another domain is used to shape the system.
- **Why:** Gain structural insight without importing false properties or bypassing engineering evidence.
- **What:** Map each atom to a real domain primitive, cite it, preserve deliberate differences, and derive a runnable consequence.
- **Who:** Designers translate; domain evidence and gates judge the mapping.
- **When:** Before adopting an analogy as architecture.
- **Where:** Neuron biology, cardiac execution, energy routing, superpattern, and future domain translations.
- **How:** Read the source domain, make an explicit atom map, route it through citation and runtime falsifiers.
- **Trust boundary:** Metaphor never grants correctness, authority, biological equivalence, or implementation status.
- **Lifecycle:** observe analogy → map atoms → name gaps → derive mechanism → witness → retain or reject.
- **Relates:** SMP-01, SMP-07, SMP-29, SMP-30.
- **Falsifier:** A metaphorical resemblance is used as proof without a cited primitive and runnable engineering consequence.
- **Sources:** `AGENTS.md` §§4, 15, 32; `reference/SELF_CONSTRUCTING_AGENT.md` §§3–5; `$jesus-pattern:superpattern`.
- **Status:** implemented as design discipline.

### SMP-33 — Reply Authority Is Conferred by Possession, Not by Grant

- **Version:** `typed-neuron.super-pattern/SMP-33/v1`
- **Trigger:** A Neuron must answer a peer it was not configured with, or two Neurons must hold a bounded exchange.
- **Why:** Make communication bidirectional without pre-wiring every pair or widening any Neuron's send authority.
- **What:** An interpreter-stamped envelope — attested `from`, sender-chosen `correlation`, interpreter-owned `reply_to` and `turn` — travels with each message; answering the attested return path on that correlation is authorized by the request itself.
- **Who:** The interpreter stamps provenance; the requester chooses the conversation; the responder answers without holding a matching send grant.
- **When:** At every correlated `send`, at the park on `reply/<correlation>`, and at the turn ceiling.
- **Where:** Runtime valve, pump waiters, script-neuron protocol, and signed mesh envelopes.
- **How:** Read the request pinned in the stimulus, make a reply targeting its `reply_to`, route it through the ordinary validate → commit boundary.
- **Trust boundary:** A Neuron never asserts its own sender, return address, or turn; a correlation nobody asked about confers nothing; a reply aimed at a third party is an ordinary send needing ordinary capability.
- **Lifecycle:** ask → park → answer → resume → settle; ceiling or unanswered park → typed failure, never a spin.
- **Relates:** SMP-10, SMP-19, SMP-14, SMP-26.
- **Falsifier:** A decision forges `from`/`reply_to`/`turn` and commits; a reply reaches a non-requester without send capability; a conversation exceeds `max_turns`; or a parked Neuron is woken by an unrelated message.
- **Sources:** `AGENTS.md` §10.1; `src/runtime.zig` (`answeredRequest`); `src/pump.zig`; `src/mesh.zig`; `limbs/conversation/`; `tests/conversation-gate.sh`.
- **Status:** implemented.

## 5. Normative Section Coverage

Every Part I section and numbered subsection is covered:

| Section | Catalog IDs |
|---|---|
| §1 | SMP-01, SMP-31 |
| §2 | SMP-01, SMP-02 |
| §3 | SMP-05, SMP-07 |
| §4 | SMP-06, SMP-32 |
| §5 | SMP-01, SMP-03 |
| §6 | SMP-02 |
| §7 | SMP-01, SMP-03 |
| §8 | SMP-06, SMP-17 |
| §9 | SMP-10 |
| §10 | SMP-10, SMP-19 |
| §10.1 | SMP-19, SMP-33 |
| §11 | SMP-03, SMP-06, SMP-20 |
| §12 | SMP-15, SMP-24 |
| §13 | SMP-03, SMP-26 |
| §14 | SMP-12 |
| §15 | SMP-32 |
| §16 | SMP-14, SMP-26 |
| §17 | SMP-04, SMP-29 |
| §17.1 | SMP-24, SMP-29, SMP-30 |
| §17.2 | SMP-03, SMP-23, SMP-29, SMP-30 |
| §17.3 | SMP-05, SMP-14–SMP-18, SMP-23–SMP-25 |
| §18 | SMP-04, SMP-05, SMP-31 |
| §19 | SMP-10, SMP-12, SMP-13 |
| §20 | SMP-05, SMP-11, SMP-16 |
| §21 | SMP-18, SMP-19 |
| §22 | SMP-10, SMP-11, SMP-22 |
| §23 | SMP-13, SMP-17 |
| §24 | SMP-14, SMP-15 |
| §25 | SMP-12 |
| §26 | SMP-08, SMP-09, SMP-11, SMP-20, SMP-26 |
| §26.1 | SMP-21, SMP-22, SMP-23 |
| §27 | SMP-18, SMP-27 |
| §28 | SMP-12, SMP-13, SMP-28 |
| §28.1 | SMP-12, SMP-19 |
| §28.2 | SMP-13, SMP-17 |
| §28.3 | SMP-13, SMP-18, SMP-28 |
| §28.4 | SMP-10, SMP-31 |
| §29 | SMP-15, SMP-16, SMP-24 |
| §30 | SMP-04, SMP-16, SMP-25, SMP-26 |
| §31 | SMP-17, SMP-30, SMP-31 |
| §32 | SMP-29, SMP-32 |
| §33 | SMP-30 |
| §34 | SMP-31 |

Supporting projections are also closed:

| Projection | Catalog IDs |
|---|---|
| `reference/META_AGENT.md` §§1–9 | SMP-03, SMP-11, SMP-17, SMP-20, SMP-23–SMP-27 |
| `reference/SELF_CONSTRUCTING_AGENT.md` §§1–3 | SMP-01, SMP-04, SMP-14, SMP-25 |
| `reference/SELF_CONSTRUCTING_AGENT.md` §§4–6 | SMP-07–SMP-09, SMP-32 |
| `reference/SELF_CONSTRUCTING_AGENT.md` §§7–11 | SMP-15–SMP-18, SMP-23–SMP-27 |
| `reference/SELF_CONSTRUCTING_AGENT.md` §§12–16 | SMP-28, SMP-30, SMP-31 |
| `reference/SWARM_NODE.md` | SMP-19–SMP-23 |
| `reference/AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md` | SMP-01, SMP-05, SMP-14–SMP-18, SMP-23–SMP-26, SMP-30 |
| `reference/AGENTIC_ORGANISM.md` + `bench/agentic-organism/benchmark.json` | SMP-01–SMP-32 |
| `IMPLEMENTATION.md` | SMP-04, SMP-05, SMP-12, SMP-18, SMP-30, SMP-31 |

## 6. Automatic Application Walk

At the beginning of planning, generation, attachment, routing, repair, or
review:

```text
READ
  build the six-interrogative work root
  enumerate SMP triggers and current implementation status
    ↓
FILTER
  schemas + Caps + provenance + authority + budget + settlement
    ↓
ROUTE
  exact admitted pattern → compatible composed patterns → PatternGap
    ↓
MAKE
  instantiate ordinary Neurons/artifacts/edges, or propose one inert record
    ↓
PLAN → BUILD → TEST → JUDGE
  exercise the real path with the pattern's falsifier
    ↓
REFLECT
  compare receipts to the prior peak; simplify if the additions regress it
    ↓
ABSORB
  update AGENTS registry + this catalog + checker + honest status/roadmap
```

The automatic walk may select and instantiate an already admitted pattern under
existing Caps. It may propose a `PatternGap` and a candidate record. It may not
change normative source, admit a package, widen authority, declare independence,
or claim behavioral conformance without the governing gate.

## 7. Current Residual Frontier

The audit identifies six honest residuals:

1. SMP-21: automatic mesh formation is specified but the `mesh-topology` limb
   is not built.
2. SMP-22: cross-machine topology/artifact convergence and distributed cache
   identity are not built.
3. SMP-23: eligibility-first routing exists locally but not across a live mesh.
4. SMP-29: the document registry exists, but no admitted runtime Registry
   Neuron yet reads this catalog, matches work roots, and emits `PatternGap`.
5. SMP-01/SMP-18/SMP-25: the canonical standalone agent entrypoint and
   universal interface membrane are planned, but no `InterfaceManifest` registry yet
   wraps and admits arbitrary code, binaries, stores, APIs, protocols, models, devices,
   humans, and paid resources through one executable lifecycle.
6. SMP-17/SMP-30/SMP-32: the Agentic Organism prompt and score corpus is
   structurally witnessed, and four pilot fixtures now have sealed Aiko receipts
   plus an append-only improvement stream. The remaining 44 fixtures, complete
   three-seed run, paired baselines, independent judge runs, and suite-level
   measured score do not yet exist.

These are roadmap work, not hidden successes. The next lever is SMP-29 because
it makes future pattern reuse automatic; its eventual witness must begin with a
real work root, select a compatible existing pattern, reject an ineligible
pattern, emit a gap for an uncovered case, and do so without acquiring authority.

## 8. Seal

The catalog seal is:

```bash
python3 tests/check_super_meta_patterns.py
python3 tests/check_agents.py
```

Behavioral patterns retain their own runtime witnesses. The full document seal
remains the `AGENTS.md` §33 acceptance gate. A new pattern is absorbed only when
its record, section coverage, status, roadmap truth, and appropriate runnable
witness are all present.
