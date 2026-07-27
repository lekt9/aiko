**Typed Neurons**  
**A Unified Architecture for Reliable Agentic Systems**

**Executable Architecture Contract**  
Version 2.1 — 27 July 2026

Part I (§1–§34) is the normative architecture contract. Part II (§35–§41) records the
current implemented state of this repository as of 2026-07-27; it is descriptive,
date-stamped evidence and does not weaken Part I.

---

### 1. Motivation

Modern agent systems are commonly described with three overlapping layers:

- **Harness engineering** — the machinery around the model (tools, memory, sandboxes, permissions, observability, context injection, execution control).
- **Loop engineering** — repeated work-and-feedback cycles with triggers, goals, evidence, and stopping rules.
- **Graph engineering** — explicit workflow topology (nodes, edges, branches, joins, controlled cycles).

These layers are useful diagnostic lenses, but they are not foundational. All three reduce cleanly to a single polymorphic, hard-typed primitive: the **Neuron**.

This document defines that primitive and the complete architecture that follows from it.

---

### 2. The Single Primitive: the Neuron

The foundational unit is the **hard-typed polymorphic Neuron**:

```ts
type Neuron<S, C extends Caps, R> = (
  stimulus: Readonly<Stimulus<S>>,
  capabilities: Readonly<C>
) => Promise<Decision<R>>

type Decision<R> = Readonly<{
  control:
    | { kind: "continue"; waitFor?: PredicateRef }
    | { kind: "terminate"; result: R }
    | { kind: "branch"; next: NeuronRef }
  effects?: readonly Effect[]
  evidence: readonly EvidenceRef[]
}>

type Effect =
  | { kind: "spawn"; neurons: readonly NeuronDef[]; edges?: readonly Edge[] }
  | { kind: "write"; artifacts: readonly ArtifactWrite[] }
  | { kind: "send"; to: NeuronRef | ChannelRef; message: TypedMessage; durable: boolean }
```

- Neurons are pure and **stateless** by design. They receive only the current stimulus and the capabilities they are allowed to use.
- `Caps` is a hard interface of allowed effects (tools, model calls, sandboxes, human gates, registry access, write permissions, messaging permissions, etc.).
- The return value contains exactly one control decision and zero or more declarative effects. This permits one firing to spawn, write, and send atomically without multiplying primitives.
- Polymorphism arises because the same type constructor is inhabited by pure functions, LLM calls, tool wrappers, verifiers, human gates, middleware, Registry Neurons, and more.

This is the only computational unit. Everything else is specialization or composition of it.

---

### 3. Core Operations of a Neuron

A Neuron can perform three fundamental actions:

1. **Spawn** — create new Neurons and optionally wire them into the network (self-growth / chain reaction).
2. **Write** — emit artifacts into the shared substrate (self-generative persistence).
3. **Send** — deliver a typed message to another Neuron or channel (direct communication).

Receiving a message simply appears as part of the next stimulus.  
All three operations remain pure decisions mediated by Caps and the substrate.

“Pure” means the Neuron implementation cannot perform an external effect directly. It may
read only through capability methods that record provenance, and it may return effect
descriptions. The harness validates and commits those descriptions. Model calls, clocks,
randomness, network access, and human input are capability reads and therefore become part
of the firing record and cache identity.

---

### 4. Pointer Chains and Firing

A Neuron does not contain a value. It holds (or is given) typed references to capabilities, possible next steps, and evidence requirements. Execution is the act of resolving that chain of pointers under type constraints.

Firing is sparse and event-driven. Most of the network stays quiet until a typed condition is met.

**Structural mapping:**

| Engineered Concept             | Biological Analogue                  |
|--------------------------------|--------------------------------------|
| Neuron                         | Neuron                               |
| Caps / tools / write / send    | Receptors / neuromodulators          |
| Edges / routing / messaging    | Axonal connections with predicates   |
| Evidence thresholds            | Membrane potential                   |
| Firing                         | Spike                                |
| Network of neurons             | Connectome                           |
| Recurrent composition          | Recurrent connectivity               |
| External events (webhooks)     | Sensory receptors                    |

---

### 5. How the Original Three Layers Emerge

No additive layers are required.

- **Harness** is the ambient interpreter and the concrete implementation of `Caps`. It supplies tools, sandboxes, model routing, observability, messaging delivery, and the ability to write artifacts.
- **Loop** is recursive composition of the same Neuron under a typed evidence predicate.
- **Graph** is free or constrained composition of multiple Neurons. The topology is simply how instances are arranged, wired, and messaged.

The three original lenses remain useful only as diagnostic tools.

---

### 6. Role of LLMs

The Neuron itself is not powered by LLMs. LLM reasoning is one powerful specialization among many.

Some Neurons are pure or deterministic. Some are human gates. Some invoke an LLM. Reliability comes from the composition of these different inhabitants under hard type constraints, not from the LLMs alone.

---

### 7. Standard Interface and Infinite Hooking

The Neuron *is* the standard interface. Everything implements or is wrapped by it. Because the interface is fixed and hard-typed you can chain, nest, branch, wrap, replace, spawn, and message Neurons without rewriting interconnection logic. This is infinite, type-safe hooking.

---

### 8. Reactivity and Instinctual Grounding

**Receptor inputs.**  
Caps expose external receptors (webhooks, queues, timers, file watchers, API callbacks). An incoming event becomes a stimulus that causes one or more Neurons to fire.

**Instinctual grounding.**  
Every Neuron (or a mandatory thin wrapper) requires that its output is explicitly grounded in its inputs and any artifacts or messages it has chosen to read. Grounding is structural. Context awareness is a hard requirement of every firing.

---

### 9. Self-Generative Persistence (Pure Stateless Model)

Neurons are pure and **stateless**. They do not carry a central durable state object.

Persistence is achieved by the Neurons themselves. When durable effects or memory are required, a Neuron **writes its own code and artifacts**. Those artifacts can materialize as:

- database tables, schemas, or event stores
- caches
- files on the filesystem
- generated scripts or modules
- wiring definitions
- complete Skill packages
- message logs
- any other durable medium

Subsequent Neurons read only the relevant, narrow slice of artifacts that earlier Neurons have written. The substrate is the cumulative product of self-generative acts.

---

### 10. Inter-Neuron Communication

Neurons communicate in two complementary ways:

1. **Direct messaging (`send`)** — typed, capability-restricted messages delivered to specific Neurons or channels. Can be transient or durable.
2. **Via the shared substrate** — write artifacts that other Neurons later read (content-addressable, durable, event-sourced communication).

Both remain pure. Messaging is mediated by Caps and the substrate so it stays auditable, cacheable, and governable.

---

### 11. Parallelism and the Substrate

The Neuron remains the only computational unit. Parallelism is concurrent execution of many instances. The harness schedules them; the substrate provides the shared medium and concurrency control.

Topology and connectivity become data. Meta-Neurons can emit writes that add, remove, or reweight edges and channels. The network can rewire itself under typed constraints.

The set of Neuron definitions plus the artifacts they have written *is* the program. The neurons become the new programming language.

**Requirements for reliability:**

- Strong concurrency control and a clear consistency model
- Typed constraints and governance on what Neurons may write, spawn, or send
- Strict locality of reads
- The harness retains ownership of external side-effects and Caps enforcement

---

### 12. Registry Neurons and Neurons as Skills

Specialized Registry Neurons manage external skill and library registries (agentskills.io, skills.sh, and others).

Reusable and higher-level Neurons are preferably packaged as **Agent Skills**:

- `SKILL.md` (name, description, instructions, examples)
- optional scripts and assets that implement the hard-typed Neuron contract

This provides progressive disclosure, portability, versioning, better LLM guidance, and seamless discovery by Registry Neurons. Self-generative Neurons can emit complete Skill packages.

The Skill is packaging only. The runtime still executes the hard-typed Neuron.

---

### 13. Self-Growth and Chain Reactions

A Neuron, upon firing, may:

- Spawn new specialized Neurons (planner, verifier, critic, recovery, etc.)
- Write new edges, artifacts, and Skill packages
- Send messages to existing Neurons
- Create temporary or durable feedback loops

The original firing behaves like a Promise that dynamically constructs its own resolution machinery. Every piece remains a first-class hard-typed Neuron.

Self-growth is optional and governed by resource budgets, depth limits, typed Caps, evidence-based stopping conditions, and optional human approval gates.

---

### 14. Caching (Docker-style)

Because Neurons are pure and stateless, firings can be content-addressed:

**Cache key** = hash of  
(Neuron identity/version + stimulus + exact artifacts read + relevant Caps)

If a previous successful firing with the same hash exists, the system can reuse the previous decision and artifacts. When any input changes, the Neuron re-executes. This is layer caching for computation and is a recommended operational feature.

---

### 15. Gaps Between Engineered Neurons and Biological Neurons

We call the units **neurons** because the structural and dynamical analogies are useful. The gaps are deliberate engineering strengths:

| Biological Neurons                     | Engineered Neurons                                      | Why the gap is intentional                          |
|----------------------------------------|---------------------------------------------------------|-----------------------------------------------------|
| Continuous, analog, noisy              | Discrete, typed, deterministic or explicitly stochastic | Perfect auditability and verification               |
| No explicit schema or types            | Hard-typed Caps and control decisions                   | Safe composition and prevention of drift            |
| Memory distributed and lossy           | Self-generated, reconstructible, typed artifacts        | Perfect recall and multi-session continuity         |
| Massive unstructured parallelism       | Controlled concurrency with explicit consistency        | Avoids race conditions and chaos                    |
| No external governance                 | Typed Caps, budgets, sandboxes, human gates             | Safety and resource control                         |
| Limited observability                  | Every firing carries typed evidence                     | Debuggability and evaluation                        |
| Evolutionary / embodied adaptation     | Explicit meta-Neurons that rewrite code and topology    | Directed, evidence-based plasticity                 |

---

### 16. Governance, Safety, and Operational Constraints

Required elements (themselves expressed as Neurons and Caps) include:

- Resource and depth budgets on spawning, writing, and messaging
- Typed Caps that restrict what any Neuron may access, generate, or send
- Sandboxing and provenance validation for external skills and generated code
- Evidence-based stopping and rejection rules
- Strong concurrency and consistency models on the substrate
- Complete observability of firings, messages, evidence, and topological changes
- Optional human gates for high-impact actions

---

### 17. Design Principles

1. There is only one primitive: the hard-typed polymorphic Neuron.
2. Neurons are pure and stateless. Persistence is self-generative — Neurons write the code and artifacts that create ongoing structure.
3. Neurons communicate by sending typed messages and by writing to a shared substrate.
4. Everything else is a specialization or composition of Neurons.
5. Prefer sparse, local, grounded, event-driven computation.
6. Prefer packaging reusable Neurons as Agent Skills for progressive disclosure, portability, and better LLM guidance.
7. Allow controlled self-growth (spawn + message + write) for planning and verification cascades.
8. Use content-addressable caching of Neuron firings.
9. Treat the original three layers purely as diagnostic lenses.
10. Call the units neurons while remaining explicit about the deliberate engineering gaps with biology.
11. Build higher-order capabilities as **generative limbs**: Skill-packaged networks of
    Neurons generated, admitted, attached, observed, and retired through the standard
    contract. Do not promote policy into the harness merely because it is commonly used.
12. Maintain the hard-typed firing envelope, validator, and identity algorithms as one
    importable canonical package. Production interpreters MUST import that package rather
    than copy it; substrate adapters may add ingress, commit, replay, and persistence only.

---

### Summary

The architecture is a network of hard-typed polymorphic Neurons that:

- communicate directly via typed messages
- persist by writing their own code and artifacts
- self-organize and rewire through a shared substrate
- absorb external capabilities (including other Neurons packaged as Skills)
- dynamically grow their own planning, checking, and resolution structure
- fire sparsely and only when grounded
- cache by content hash of their inputs

…while remaining fully constrained, observable, and single-primitive.

There is only one primitive. Everything else is how it is specialized, composed, messaged, written, packaged, and governed.

---

### 18. Normative Vocabulary and System Boundary

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative. A conforming implementation consists of Neuron definitions plus a trusted
harness and substrate. The Neuron is the only user-programmable computational primitive;
the harness is the interpreter and reference monitor, not a second programmable unit.

The trust boundary is explicit:

- Neuron code is untrusted decision logic.
- The harness owns scheduling, capability enforcement, validation, effect commit, retries,
  cancellation, and observation.
- The substrate owns durable artifacts, messages, topology, firing records, leases, and
  content-addressed cache entries.
- Capability adapters own external side effects. A Neuron MUST NOT reach an adapter except
  through its `Caps`.
- Generated code and imported Skills are data until independently validated and admitted.

The reference wire core is exported as the `typed_neuron` Zig module. A production
interpreter MUST consume the canonical types, validation rules, and firing/decision
identity functions through that module (or a mechanically generated binding from the same
source schema). Re-declaring or hand-porting those rules inside a substrate is
non-conforming because it creates a second semantic authority. Interpreter-specific code
MAY parse transport envelopes and MUST own durable commit/replay, but it MUST delegate the
pure decision boundary to the imported core. Breaking wire changes require a schema/hash
domain and core-version change plus fixed compatibility vectors.

### 19. Canonical Data Model

Every durable entity MUST carry `schema`, `id`, `version`, `createdAt`, and `provenance`.
Identifiers are opaque and stable. Hashes use a named canonical serialization and digest
algorithm; the reference profile is deterministic CBOR plus SHA-256.

```ts
type Stimulus<S> = {
  schema: "neuron.stimulus/v1"
  firingId: FiringId
  receptor: ReceptorEvent<S>
  messages: readonly MessageEnvelope[]
  permittedReads: readonly ArtifactRef[]
  deadline: string
  budget: Budget
}

type Caps = {
  schema: "neuron.caps/v1"
  fingerprint: Digest
  reads: ReadCaps
  model?: ModelCaps
  tools?: ToolCaps
  human?: HumanGateCaps
  effects: EffectPolicy
}

type EvidenceRef = {
  claim: string
  sources: readonly ProvenanceRef[]
  method: string
  digest: Digest
}

type ArtifactWrite = {
  mediaType: string
  schema: string
  bytes: ByteRef
  expectedPrior?: Digest
  classification: DataClass
}

type TypedMessage<T = unknown> = {
  schema: string
  correlationId: string
  causationId: FiringId
  payload: T
  ttl?: string
}
```

Schemas MUST be versioned and validated at ingress and before commit. `any` is forbidden at
trust boundaries; opaque payloads use `unknown` plus an explicit decoder. Schema evolution
MUST declare backward/forward compatibility and a migration path.

### 20. Firing Lifecycle and Interpreter Semantics

A firing has the following state machine:

`received → admitted → executing → decided → validated → committing → committed`

It may instead end in `rejected`, `failed`, `timed_out`, or `cancelled`. The harness MUST:

1. authenticate the receptor or message and validate its schema;
2. resolve the Neuron definition and immutable capability grant;
3. snapshot or pin every readable artifact reference;
4. allocate deadline, cost, spawn-depth, message, and write budgets;
5. execute the Neuron in a sandbox while recording every capability read;
6. validate the returned decision, evidence, targets, schemas, and budgets;
7. commit the decision record and declared effects atomically, or commit none;
8. acknowledge the input only after commit;
9. enqueue resulting firings and emit an immutable observation record.

Effects are declarative. Returning a `write` does not itself write; returning `send` does
not itself deliver. The commit boundary is the sole linearization point. A terminated
Neuron may emit effects, but termination applies only to that logical invocation or
workflow scope, never to the harness.

`continue` suspends until its predicate is satisfied or its deadline expires. `branch`
selects an already-admitted target. `spawn` proposes definitions or instances; the harness
validates identity, depth, budgets, provenance, and edge policy before admission.

### 21. Delivery, Idempotency, and Ordering

The reference delivery guarantee is at-least-once. Every firing and effect therefore MUST
be idempotent under its stable identity. The substrate MUST deduplicate committed effects
by `(firingId, effectIndex)`.

- Durable messages survive restart and are acknowledged after the consumer commits.
- Transient messages MAY be lost and MUST NOT be used for correctness-critical facts.
- Ordering is guaranteed only within one channel partition and monotonic sequence.
- Cross-channel ordering is undefined; causal relationships use `causationId` and vector
  or logical clocks when required.
- Poison messages move to a typed dead-letter channel after a bounded retry policy.
- Retries use bounded exponential backoff with jitter supplied and recorded through Caps.

Exactly-once external effects are not claimed. Adapters MUST use idempotency keys or an
outbox/inbox protocol and expose reconciliation evidence.

### 22. Artifact and Substrate Semantics

Artifacts are immutable and content-addressed. Mutation is represented by a new artifact
and an explicit relation to its predecessor. Named mutable pointers MAY exist, but updates
MUST use compare-and-swap through `expectedPrior`.

The reference consistency model is:

- serializable commit for one firing’s decision and effects;
- snapshot-consistent reads within a firing;
- eventual visibility between independent partitions;
- explicit barriers or join Neurons for cross-partition convergence.

Conflicts reject the whole commit and may trigger a fresh firing with a new snapshot.
Readers MUST request narrow refs or indexed projections; unconstrained substrate scans are
not valid capability grants. Garbage collection MUST preserve anything reachable from a
retention root, audit hold, live topology, or admitted cache entry.

### 23. Grounding and Evidence

Every externally meaningful claim in a decision MUST be traceable to one or more stimulus
fields, capability-read results, messages, or artifacts in that firing’s provenance set.
The harness MUST reject undeclared evidence references.

Evidence records include claim, source digests, method, producer, time, and confidence or
acceptance threshold. A verifier MUST be independent in implementation, data path, model,
or authority from the producer for high-impact claims. Merely asking the same model twice
is not independent corroboration.

Absence of evidence is not negative evidence. If required evidence cannot be acquired
within budget, the correct result is a typed `insufficient_evidence` rejection or a human
gate, never an invented success.

### 24. Capability Security Model

Capabilities follow least authority and deny by default. Grants MUST specify resource
scope, allowed verbs, data classification, rate/cost limits, expiry, delegation policy,
and whether human approval is required.

Neuron-generated capability grants are proposals only. A Neuron MUST NOT widen, forge,
serialize for reuse, or delegate a capability unless its existing grant explicitly permits
that exact delegation. Revocation takes effect before the next capability operation and
invalidates cache entries whose fingerprint includes the revoked authority.

Secrets MUST remain in adapters, never in stimuli, decisions, artifacts, logs, or model
prompts. Reads and outputs are labeled with data classifications; information may flow
only to equal or more restrictive sinks unless an explicit declassification gate approves.
Prompt injection and tool output are untrusted data and cannot alter Caps or interpreter
policy.

### 25. Determinism and Content-Addressed Caching

The complete cache key is:

```text
hash(
  neuron identity + code/version digest +
  canonical stimulus +
  ordered exact read-set digests +
  capability semantic fingerprint +
  model/tool adapter versions +
  recorded clock/random/nondeterministic inputs +
  interpreter and schema versions
)
```

Cache lookup occurs only after the effective inputs and read-set can be established. An
implementation MAY use a declared-read manifest for pre-execution hits; otherwise it runs
in read-discovery mode and can reuse a matching prior result before effect commit.

Only successfully committed, deterministic or fully replayable firings are cacheable.
Human decisions, unpinned remote calls, secrets, expiring authority, and external writes
make a firing non-cacheable unless represented by stable recorded inputs and replay-safe
effects. A cache hit revalidates current policy, schemas, artifact reachability, and effect
idempotency. Cache reuse MUST never replay a non-idempotent external effect.

### 26. Topology, Self-Growth, and Settlement

Topology is typed, versioned data. An edge names source and destination schemas, predicate,
delivery mode, partition key, priority, and budget. A topology change is proposed as an
artifact and admitted only after validation.

Self-growth MUST be bounded by:

- maximum spawn depth, fan-out, live instances, and cumulative cost;
- an acyclic default, with cycles requiring an explicit progress measure;
- a deadline and evidence-based settlement predicate;
- ownership and garbage-collection rules;
- optional human approval for durable or high-impact growth.

A join fires only when its declared quorum, window, and duplicate policy are satisfied.
Loops MUST expose a monotonic progress measure or bounded attempts. “Continue forever”
is not a valid settlement rule for a finite workflow.

### 27. Failure Model and Recovery

Failures are typed at minimum as validation, capability_denied, budget_exhausted,
dependency, timeout, conflict, poisoned_input, invariant_violation, and internal.
Retry policy is defined per class. Validation, denial, poison, and invariant violations
are not automatically retried.

The harness MUST fail closed: malformed decisions, unknown effect kinds, missing required
evidence, budget overflow, or partial adapter responses produce no committed effects.
Crashes during commit are recovered from the decision log and idempotency identities.
External-effect uncertainty enters `reconciliation_required`; it is never silently retried.

Cancellation is a typed stimulus. It propagates to descendants, stops new effects, and
allows bounded cleanup through pre-authorized compensation Neurons. Compensation is a new
audited action, not history erasure.

### 28. Observability and Audit

Every firing emits an append-only record containing identities and versions, input and
read digests, capability fingerprint, timing, resource use, model/tool calls, decision,
evidence, validation outcome, commit identity, cache status, parent/correlation links, and
redacted failure details.

Metrics MUST cover admission, latency, queue depth, cache hit rate, retries, rejects,
budget use, effect commits, reconciliation, and settlement. Trace propagation follows
message causation and spawn ancestry. Logs MUST be structured, schema-versioned, redacted,
and protected by the same capability model as artifacts.

Audit records are tamper-evident and retained by policy. Operators MUST be able to replay a
firing with external effects disabled and compare its decision digest.

### 29. Registry Neurons and Skill Admission

A Skill package is distribution data, not ambient authority. Admission MUST:

1. pin source, version, and content digest;
2. validate manifest and Neuron schemas;
3. scan code and declared dependencies;
4. verify signatures or record an explicit trust decision;
5. run contract and adversarial tests in a sandbox;
6. derive a minimal capability proposal for human or policy approval;
7. publish an immutable admitted package and provenance record.

Registry discovery is a read. Installation, upgrade, and execution are distinct writes
with separate authorization. Dependency resolution MUST be reproducible and resist
dependency confusion, mutable tags, and unreviewed transitive capability expansion.

### 30. Generative Limbs: Capabilities Made of Neuron Skills

A **generative limb** is a higher-order capability implemented as one or more Neurons,
packaged as an Agent Skill, and attached to the running network through typed messages,
artifacts, edges, and capability grants. It is called a limb because it extends what the
system can do without becoming a second computational primitive. A limb is still made
entirely of Neurons.

Examples include schedulers, routers, retry policies, dead-letter handlers, caches and
indexes, planners, verifiers, joins, workflow engines, Registry Neurons, migration tools,
metrics projections, recovery procedures, garbage collectors, and human-approval flows.
These capabilities SHOULD be generated or composed on demand as limbs rather than
hard-coded as privileged harness subsystems.

The permanent kernel MUST contain only irreducible mechanisms that cannot safely be
expressed by an untrusted Neuron:

- the hard-typed Neuron, stimulus, decision, effect, message, and artifact contracts;
- capability enforcement and sandbox boundaries;
- schema validation and generated-code admission;
- atomic substrate transaction and outbox primitives;
- content identity, provenance, and tamper-evident firing records;
- minimal receptor delivery and execution needed to fire an admitted Neuron;
- resource enforcement, isolation, and emergency termination.

The kernel provides mechanisms, never domain policy. If a proposed kernel feature can be
implemented by an admitted Neuron reading typed stimuli and returning typed decisions, it
MUST be implemented as a limb unless moving it into the kernel is required to preserve the
trust boundary, atomicity, isolation, or liveness of the interpreter itself. Convenience,
performance, or frequent reuse alone is not sufficient justification for kernel privilege.
Performance-sensitive limbs MAY use optimized adapters, but the adapter remains behind
Caps and the governing policy remains a Neuron.

Every generative limb follows the same lifecycle:

1. **Describe** — emit a versioned `NeuronDef`, topology, schemas, requested Caps, evidence
   requirements, budgets, settlement rules, and Skill manifest.
2. **Write** — persist the complete Skill package and implementation as content-addressed
   artifacts. Generated source is inert data at this stage.
3. **Admit** — independently validate provenance, schemas, code, dependencies, tests,
   requested authority, resource bounds, and signatures according to Skill admission.
4. **Attach** — instantiate only the admitted digest, grant least authority, and connect it
   through typed edges or channels. A limb receives no ambient authority.
5. **Operate** — fire it through the ordinary Neuron interpreter. Its reads, decisions,
   effects, messages, evidence, costs, and topology changes remain fully observable.
6. **Judge** — compare its outputs against explicit acceptance evidence. A limb that fails
   must re-plan, be quarantined, or be detached; it must not silently widen its own Caps.
7. **Cache** — reuse an identical admitted limb or firing by content identity when replay
   is safe. Generation MUST first search for an existing compatible limb.
8. **Retire** — revoke its grants, stop new firings, settle or cancel descendants, preserve
   required audit roots, detach its edges, and garbage-collect unreachable artifacts.

Self-generation therefore does not mean self-authorization. A Neuron MAY propose and write
the code and Skill artifacts for a new limb, but only the harness admission boundary may
make that code executable or grant it Caps. A generated limb MUST NOT modify the kernel,
bypass admission, inherit the generator’s authority, or conceal behavior in an untyped
script or side channel.

Composition remains self-similar. A limb may generate smaller limbs, and a network of
limbs may itself be packaged as a larger Skill, provided every level implements the same
Neuron contract and remains within cumulative depth, cost, authority, and settlement
budgets. The set of admitted Skill limbs plus their written artifacts and topology is the
evolving program.

**Architectural falsifier:** a conforming implementation MUST demonstrate that at least
one non-trivial capability—such as retry routing, verification, caching policy, or
workflow joining—can be generated as a Skill package, admitted by digest, attached without
restarting or modifying the kernel, exercised through ordinary firings, and safely
detached. A test that merely registers a built-in Zig class under a Skill-shaped name does
not satisfy this requirement.

The normative seed for composed agent behavior is
`reference/META_AGENT.md`. Implementations SHOULD use its snapshot-rooted, decomposed
Meta-Agent limb as the default reference for future self-generation. They MAY replace any
of its limbs, but MUST preserve the mechanical boundary: state is reconstructed from typed
artifacts, composition occurs through standard Neuron interfaces, and completion is
decided by its runnable witness rather than resemblance to the reference prose.

### 31. Reference Conformance Profile

An implementation conforms only if runnable tests demonstrate all of the following:

- schema-invalid stimuli and decisions are rejected before effects;
- a firing can atomically combine spawn, write, and send;
- duplicate delivery commits each effect at most once;
- a compare-and-swap conflict commits nothing and can be retried from a fresh snapshot;
- unauthorized reads, writes, sends, spawns, and delegation fail closed;
- grounding rejects evidence absent from the recorded provenance set;
- budget, depth, deadline, cancellation, and poison-message limits settle predictably;
- cache keys change for code, stimulus, read-set, Caps, adapter, schema, clock, or random
  changes, and cache hits never duplicate external effects;
- crash recovery and external-effect reconciliation preserve the audit trail;
- joins, cycles, rewiring, and garbage collection obey their declared policies;
- imported and generated Skills receive no authority before admission;
- production substrate adapters import the canonical Neuron wire types, validator, and
  identity functions, with a runnable guard rejecting local duplicate implementations;
- a non-trivial generative limb passes the describe → write → admit → attach → operate →
  judge → retire lifecycle without kernel modification or ambient authority;
- deterministic replay reproduces the decision digest with effects disabled.

Document conformance is checked by `tests/check_agents.py`. Behavioral runtime
conformance requires an implementation-specific adapter that exercises the same named
properties; a document-only pass MUST NOT be represented as runtime correctness.

### 32. Superpattern Translation

This architecture maps the ten settlement atoms into its own domain:

| Atom | Typed-Neuron primitive | Runnable interpretation |
|---|---|---|
| root | hard-typed Neuron contract | trace every feature to the single primitive |
| node | one firing | validate its who/what/when/where/why/how record |
| tree | spawned and messaged topology | traverse typed edges and descendants |
| verb | read plus declared write/send/spawn effects | enforce command/query separation |
| settle | typed predicate, quorum, deadline, or budget | stop only on recorded evidence |
| witness | independent verifier or human gate | corroborate high-impact claims |
| cache | firing content key | replay only identical, safe decisions |
| seal | validate-and-commit boundary | admit all effects atomically or none |
| walk | scheduler worklist | expand sparse receptor-ready firings |
| loop | plan/build/test/judge Neuron composition | re-enter with typed failure evidence |

The mapping is grounded in the Superpattern canon and its cited parallels: roots of trust
and the end-to-end argument; 5W1H; composite structures; command-query separation; quorum;
N-version checking; content-addressed memoization; reproducible-build gates; graph
traversal; and PDCA/OODA. The operational contract above is the domain translation, while
the original harness/loop/graph terms remain diagnostic projections.

### 33. Acceptance Gate

The document is settled only when:

```bash
python3 tests/check_agents.py
python3 bench/jespa/benchmark.py --seeds 17 43
JESPA_WIN_TARGET=1 bash bench/jespa/jespa-benchmarks-gate.sh
bash tests/gate.sh
```

The benchmark compares a structural energy validator against a keyword-presence baseline
on independently labeled faithful and adversarial document variants. Its ledger records
real reproduced results, including negatives. Passing this document gate establishes that
the architecture is complete and discriminative as a specification; it does not claim
that an unbuilt runtime is reliable.

### 34. Documentation and Implementation Authority

This file is the normative architecture contract; Part II records the current state
against it. `IMPLEMENTATION.md` MUST describe the
code that currently exists, its trust boundaries, its production integration, and its
known limits without weakening this contract. `reference/ROADMAP.md` MUST contain only
unsettled work; completed behavior belongs in the implementation document and in runnable
tests.

The executable authorities are:

- `schema/typed-neuron-wire.json` for the transport schema;
- the exported `typed_neuron` module for pure types, validation, and identities;
- an interpreter's atomic transaction and recovery tests for substrate behavior;
- `reference/META_AGENT.md` plus its runnable witness for the default composed agent;
- the production conformance gate for cross-repository claims.

Generated bindings are codec projections, not semantic authorities. A source directory
named like a Skill or limb is not evidence of admission, attachment, operation, or
conformance. Documentation MUST label prototypes and partial lifecycle stages explicitly
and MUST NOT use a document-only, compile-only, or built-in registration test as proof of
the full generative-limb lifecycle.

---

## Part II — Current State (2026-07-27)

Part I is the normative contract. This part records what exists today: the repository
map, the canonical package, the standalone reference runtime, the generative limbs, the
production integration, and the executable witnesses. It is descriptive and
date-stamped. Where prose and executable behavior disagree, the canonical types and
tests win until the prose is corrected. `IMPLEMENTATION.md` remains the operational
map; `reference/ROADMAP.md` holds only unsettled work.

### 35. Current State: Repository Map

```text
neuron/
├── AGENTS.md                     # this document: normative contract + current state
├── IMPLEMENTATION.md             # operational implementation map and production guide
├── README.md                     # entry point and quickstart
├── schema/typed-neuron-wire.json # canonical transport schema source
├── build.zig                     # typed_neuron module, CLI artifact, test steps
├── src/                          # canonical package + standalone reference runtime (Zig 0.16)
├── limbs/                        # generative limb packages in Skill form
├── reference/                    # META_AGENT.md, defaults/meta-agent.json, EBM lens, energy router, ROADMAP.md
├── tests/                        # document, specification, runtime, Meta-Agent, and production gates
├── bench/jespa/                  # JESPA benchmarks and the honest ledger
├── tools/                        # generate_wire_bindings.py (binding generator and drift guard)
└── zig-out/                      # built CLI and retained witnesses
```

The expected sibling layout is `Unbrowse/{neuron, contract, aiko}`: this repository
holds the canonical package and executable reference runtime; sibling Contract is the
durable production interpreter and substrate; sibling Aiko is the production host. This
directory is not currently its own Git repository, so the production dependency is
pinned by content, not by revision (R5).

### 36. Current State: Canonical Package and Generated Bindings

`build.zig` exports `src/wire.zig` as the Zig module `typed_neuron`. The package
identity is `CORE_VERSION = "typed-neuron/2"` with `HASH_PROFILE` (deterministic CBOR
plus SHA-256) and `SCHEMA_DIGEST`. Breaking transport semantics change schema version,
hash domain, core version, generated bindings, content lock, and fixed vectors together.

The package owns:

- the polymorphic `Neuron` primitive and `bind`, plus the `Stimulus`, `Caps`, `Budget`,
  `Decision`, `Control`, `Effect`, `Evidence`, message, artifact, and spawn runtime types;
- whole-decision `validate` covering schema, Caps, budgets, deadline, and grounding;
- deterministic identities: `firingId`, `decisionDigest`, `runtimeDecisionDigest`,
  `runtimeStimulusDigest`;
- capability semantics: `fingerprint` and narrowing-only `allowsDelegation`;
- fixed compatibility vectors (`FIRING_VECTOR`, `DECISION_VECTOR`) and embedded self-tests.

`src/generated_wire.zig` is generated from `schema/typed-neuron-wire.json`: transport
DTOs (`NeuronFireRequest`, `NeuronFireResult`, `NeuronStimulus`, `NeuronCaps`,
`NeuronDecision`, `NeuronEffect`, `NeuronEvidence`, `NeuronGrant`, `NeuronFireStatus`)
and version/digest constants. `src/types.zig`, `src/caps.zig`, and `src/neuron.zig` are
thin aliases over the module; they own no parallel contract.

`tools/generate_wire_bindings.py` canonicalizes the schema and regenerates three
artifacts, none of which may be edited by hand:

- `src/generated_wire.zig` (Zig DTOs and constants);
- `../aiko/crates/codegen/xai-grok-shell/src/contract_native/typed_neuron_wire.rs`
  (Rust serde codecs only);
- `../contract/libcontract/typed-neuron.lock.json` (content pin of the framed package
  files).

`python3 tools/generate_wire_bindings.py --check` is the drift guard and runs inside
the production gate.

### 37. Current State: Standalone Reference Runtime

The standalone interpreter is intentionally small and in-memory. It is the executable
reference for the architecture, not the production durability layer. Module
responsibilities:

| Module | Responsibility |
|---|---|
| `src/wire.zig` | Canonical types, validation, deterministic identities, generated transport exports |
| `src/generated_wire.zig` | Generated transport DTOs and compatibility constants |
| `src/types.zig`, `src/caps.zig`, `src/neuron.zig` | Thin aliases and binding helpers over `typed_neuron` |
| `src/runtime.zig` | Execute `Neuron.fire`, validate the whole decision, atomically commit or reject |
| `src/substrate.zig` | In-memory artifacts, messages, definitions, firings, cache, and transaction state |
| `src/registry.zig` | Admit and revoke digest-pinned Skill packages without granting authority |
| `src/scheduler.zig` | Sparse work scheduling, branch-target validation, and cycle-progress checks |
| `src/topology.zig` | Join Neurons (quorum, dedupe) and retention-root garbage collection |
| `src/delivery.zig` | Acknowledge, bounded retry, dead-letter, and `reconciliation_required` parking |
| `src/cache.zig` | §25 content-addressed firing cache; hits replay decisions with zero effects |
| `src/limb.zig` | `SpecNeuron`: interpreter for declarative `limb/v1` spec packages (prefix rules, max 8) |
| `src/middleware.zig` | Mechanical cage constraining fallible child output to fixed targets, evidence, control, and payload bounds |
| `src/observability.zig` | Metrics projection and effect-disabled replay verification |
| `src/script.zig` | Bounded JSON-stdio script-Neuron adapter; hung children are killed and recorded `timed_out` |
| `src/run.zig` | `neuron run` manifest/stimulus ingress through the real Runtime |
| `src/main.zig`, `src/demo.zig` | CLI dispatch and the atomic write/send/spawn demonstration |
| `src/meta_agent.zig` | Full default Meta-Agent composition witness |
| `src/identity.zig` | Ed25519 node identities and signed, expiring, attenuated Delegations |
| `src/mesh.zig` | Signed `neuron.wire/v1` envelopes, proof-chain verification, TCP framing, symmetric nodes |
| `src/tailnet.zig` | Tailnet (CGNAT `100.64.0.0/10`) peer classification to deny-by-default pinned ceilings |
| `src/mcp.zig` | MCP stdio edge (NDJSON JSON-RPC 2.0) exposing bounded `neuron.info` and `neuron.fire` |
| `src/interface.zig` | Provider-neutral channel normalization and scoped router/conversation Neurons |
| `src/pump.zig` | Bounded event pump driving a seed stimulus to quiescence; wait predicates and factories |
| `src/energy_router.zig` | Orphan experimental router prototype; formatted but not imported by the build |
| `src/tests.zig` | Behavioral conformance, integration, transport, and lifecycle witnesses |

The CLI (`zig-out/bin/neuron`) provides `demo`, `check`, `meta-agent-check [--json]`,
`run --def/--neuron/--stimulus [--json] [--dump]`, `serve <ip:port> <write_prefix>`
(mesh daemon), `mcp <write_prefix>` (stdio edge), and `--version/--help`.

The behavioral suite holds fifty-one named witnesses in `src/tests.zig`, plus
module-embedded tests in `wire` (3), `types` (1), `caps` (1), `cache` (1), `limb` (2),
`interface` (1), `script` (9), and `energy_router` (2). Coverage spans: atomic
write/send/spawn commit; validation atomicity and capability denial; duplicate-delivery
dedupe; compare-and-swap conflict and fresh-snapshot retry; evidence grounding and
digest-pinned artifact evidence; effect, byte, and spawn-depth budgets; firing-identity
contradiction rejection; scheduler branch validation and typed waiting; bounded retry,
dead-letter, and reconciliation; deadline and cancellation; metrics and replay;
unauthorized-read admission; narrowing-only delegation; cache effect-safety; joins and
quorum; evidence-gated cycles; rewiring; garbage collection; registry fail-closed
admission; the full generative-limb lifecycle; interface normalization, per-chat
scoping, and self-contained loops; pump multi-turn settlement and bounded cycle
handling; the middleware decision cage; generational spawn attachment; Meta-Agent
settlement; mesh delegation chains, fail-closed envelope admission, and TCP symmetry;
tailnet classification; and the MCP edge ceiling and CGNAT-only egress.

### 38. Current State: Generative Limbs

A limb is executable only after describe, write, admit, and attach; a source directory
named like a Skill is not evidence of that lifecycle (§30, §34). Current status:

- **Reference Meta-Agent** — conforming lifecycle witness in `src/meta_agent.zig`
  driven by `reference/defaults/meta-agent.json`; satisfies the §30 architectural
  falsifier through ordinary Registry, Runtime, Scheduler, join, CAS, replay, limb,
  revocation, and collection interfaces.
- **`limbs/energy-router`** — reference generative limb package delivered and
  harness-executable. Contains the `neuron.json` manifest, `SKILL.md`,
  `neurons/energy_router.py` (structural `firingEnergy` scoring, `EnergyScore` write,
  conditional `energy-sub-ebm` spawn), `neurons/registry_lookup.py` (EBM-ranked
  discovery over `PackageOffer` and `Candidate`), five versioned schemas
  (`energy.candidate/v1`, `energy.score/v1`, `energy.package-offer/v1`,
  `energy.usage/v1`, `energy.settlement-claim/v1`), a tiny public `index/seed.json`,
  `examples/route_request.json`, and pure cross-language scorers (`scorer.py`,
  `energy.zig`). It runs through the real harness:

  ```sh
  neuron run --def limbs/energy-router/neuron.json --neuron energy-router \
    --stimulus limbs/energy-router/examples/route_request.json --json
  # → {"status":"committed", ...} with an EnergyScore artifact (and a sub-EBM spawn on wants_sub_ebm)
  ```

  The package carries the EBM-native paid mesh commons shape: lowest-energy routing,
  explicit sub-EBM spawn for unresolved work, and PackageOffer/Usage/SettlementClaim
  exchange as ordinary artifacts and effects. It is not yet wired into the Meta-Agent
  router slot, has no published benchmark deltas, and its Zig path is not
  build-integrated (R2).
- **`limbs/outbox-drainer`** — partial prototype. `driver.py`
  (ingest/drain/reconcile/status over an append-only JSONL state root),
  `neurons/drainer.py`, `neurons/reconciler.py`, and `tests/mock_adapter.py` exist, but
  the manifest and conformance suite are missing, so it is not a complete Skill package
  and has no lifecycle witness (R1). The production outbox path does not depend on it.
- **`limbs/shared/_neuron.py`** — shared Python runtime for script Neurons: stimulus
  validation, the provenance-set computation matching the Zig grounded-read rule,
  digest-pinned reads, budget checks, the delegation-narrowing port, and fail-closed
  decision/typed-rejection emission.

### 39. Current State: Production Integration (Contract and Aiko)

- **Contract** (`../contract/libcontract`) imports `typed_neuron` through its
  `build.zig.zon`; `typed-neuron.lock.json` pins the sibling package by content (not by
  Git revision, because this directory is not its own repository). Its `src/neuron.zig`
  is a JSON and durable-ledger adapter that re-exports the canonical validator and
  identities; settlement appends atomically before artifact materialization. The
  production C ABI is version 12. One append-only `neuron_transaction` carries the
  canonical firing, authoritative evidence payload, node settlement, and pending effect
  outbox; that append is the sole linearization point. Evidence blobs materialize after
  commit as a reconstructible cache. Duplicate firings replay the existing result; a
  different decision for an existing firing identity fails closed; a torn JSONL tail is
  ignored; uncertain external effects stay pending for
  `contract_neuron_effect_settle_json` reconciliation and are never silently re-run.
- **Aiko** imports the generated Rust transport DTOs and loads Contract's compiled ABI;
  it carries no second validator. Consequential tool calls cross the pre-dispatch
  membrane in order: build the canonical tool-effect decision, Contract admits and
  commits its pending outbox effect, Aiko dispatches the named adapter, then settles
  that exact effect with the adapter acknowledgement. Raw tool arguments are hashed
  into the canonical payload and are not persisted as cleartext ledger evidence. Replay
  suppresses duplicate dispatch; an uncertain prior dispatch produces a hold for
  reconciliation. Aiko script nodes are stricter than the standalone CLI: they run only
  through the enforced read-only sandbox, may only produce a canonical decision, and
  effectful script nodes fail closed.
- **Boundary guard** — `tests/check_production_neuron.py` statically asserts the import
  discipline: canonical ownership in `wire.zig`, pure aliases, no second digest,
  generated-DTO usage in the Aiko bridge, atomic append ordering in Contract,
  content-lock freshness, outbox ABI symbols, and pre-dispatch tool binding.

### 40. Current State: Executable Witnesses and Gates

Run the smallest gate that proves the claim being changed:

| Claim | Command |
|---|---|
| Normative document shape | `python3 tests/check_agents.py` |
| Specification discrimination | `bash tests/gate.sh` |
| Standalone behavior, CLI, benchmarks, Meta-Agent | `bash tests/runtime-gate.sh` |
| Meta-Agent lifecycle only | `bash tests/meta-agent-gate.sh` |
| Generated files and Neuron/Contract/Aiko boundary | `bash tests/check-production-neuron.sh` |
| Wire generator drift only | `python3 tools/generate_wire_bindings.py --check` |

Gate contents:

- `tests/gate.sh` runs `tests/check_agents.py`, then
  `python3 bench/jespa/benchmark.py --seeds 17 43 --verify-ledger`, then
  `JESPA_WIN_TARGET=1 bash bench/jespa/jespa-benchmarks-gate.sh`.
- `tests/runtime-gate.sh` runs `zig fmt --check`, `zig build test`, `zig build`, the
  `demo` and `check --json` CLI witnesses (three effects committed atomically: one
  artifact, one message, one neuron), `python3 bench/jespa/runtime_tasks.py
  --assert-win`, `JESPA_WIN_TARGET=2 bash bench/jespa/jespa-benchmarks-gate.sh`, and
  `tests/meta-agent-gate.sh`.
- `tests/meta-agent-gate.sh` runs the Meta-Agent from an empty temporary directory,
  asserts fifteen witness fields, and installs `zig-out/meta-agent-witness.json`
  (mode 600).
- `tests/check-production-neuron.sh` checks generated bindings and the content lock,
  builds and tests Neuron and Contract, and runs three focused Aiko `cargo test -p
  xai-grok-shell` suites (generated-binding vectors, script-Neuron boundary, and
  native-FFI commit/replay/contradiction).

The retained Meta-Agent witness (`zig-out/meta-agent-witness.json`) currently records:
`status: ok`; all ten lifecycle booleans true (`admitted_without_authority`,
`normalized_and_planned`, `join_settled`, `false_proposal_rejected`,
`recovery_rerouted`, `generated_limb_attached`, `original_work_succeeded`,
`stale_cas_rejected`, `limb_revoked`, `audit_roots_readable`);
`parallel_workers: 2`; `duplicate_effects_skipped: 2`; `committed_firings: 16`;
`replayed_firings: 16`; `artifacts_collected: 12`; and the package, final-snapshot, and
trace digests.

The JESPA ledger (`bench/jespa/benchmarks-ledger.jsonl`) records only reproduced wins
and retains honest negatives. It currently holds a reproduced document-discrimination
win (structural energy 1.0 vs keyword baseline 0.5 balanced accuracy across seeds 17
and 43) and a reproduced runtime-conformance win (all thirteen §31 properties witnessed
by named executable tests against a sequential-executor baseline).

### 41. Current State: Known Limits and Unsettled Work

The standalone reference runtime does not claim: crash-safe multi-process storage;
production schema migration; a complete OS sandbox on every platform; content-pinned
executable admission in `neuron run`; exactly-once remote effects; globally ordered
peer messages; or that an experimental limb is admitted merely because its source
exists. Contract supplies the durable production transaction and recovery path; Aiko
supplies product adapters and sandbox enforcement.

Unsettled work lives only in `reference/ROADMAP.md`, in priority order:

1. **R1** — complete the outbox-drainer package (manifest, digest-pinned definitions,
   conformance cases, full lifecycle witness).
2. **R2** — turn the energy router into an admitted limb (Meta-Agent router-slot
   wiring, held-out benchmark deltas with honest negatives, Zig build integration, a
   live mesh registry read plus payment flow witness, limb-specific revoke/detach and
   garbage collection).
3. **R3** — reusable fan-out and pipeline limbs.
4. **R4** — closed telemetry and policy-advisor loop over firing records.
5. **R5** — reproducible source dependency pin once repository ownership is decided.
6. **R6** — standalone durability and isolation remain intentionally outside the
   reference runtime; a second durable adapter must import the canonical module, pass
   the drift guard, and publish its own atomicity, crash, and reconciliation witnesses.

Every item settles through a runnable witness. File presence, prose, and a green
document validator are not completion.
