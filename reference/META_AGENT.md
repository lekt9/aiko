# Reference Meta-Agent Limb

Status: implemented executable reference  
Package name: `typed-neuron/meta-agent`  
Purpose: a mechanically verifiable default agent assembled entirely from admitted Neurons

## 1. Boundary

The Meta-Agent is not a new primitive and is not part of the kernel. It is a generative
limb: a Skill package containing Neuron definitions, schemas, default topology, capability
requests, tests, and settlement rules.

Its apparent “agent state” is not an in-memory `Agent` object. It is a projection over
immutable substrate artifacts rooted at one compare-and-swap pointer:

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

Only `agents/<agent-id>/active` is mutable. Advancing state writes a complete new snapshot
and atomically moves that pointer from the expected prior digest. A failed CAS causes
re-planning from the new snapshot; it never merges hidden process memory.

## 2. Default Neuron Composition

Each responsibility is independently replaceable and communicates only through typed
stimuli, messages, and artifacts.

| Neuron | Reads | Emits | Settlement |
|---|---|---|---|
| `intake` | receptor event, active snapshot | normalized `Intent` | intent schema valid |
| `governor` | intent, Caps, budgets, policy refs | admitted `WorkEnvelope` or rejection | authority and budget decided |
| `context` | work envelope, narrow artifact refs | `ContextManifest` | every included item has provenance |
| `planner` | intent, context, prior evidence | `Plan` and `WorkItem[]` | every leaf has an acceptance predicate |
| `router` | work item, admitted topology and limbs | typed target selection | selected target accepts the schemas |
| `executor` | one work item, scoped Caps | declarative effects and evidence | effect proposal complete or typed failure |
| `verifier` | work item, proposal, independent reads | `Verification` | acceptance predicate independently judged |
| `settler` | plan frontier, verifications, budgets | next snapshot, terminate, or recovery message | root goal proved or residual emitted |
| `recovery` | typed failure, attempts, evidence | revised work item, compensation, or dead letter | bounded recovery decision |
| `memory-indexer` | newly settled artifacts | immutable index delta | index points only to admitted artifacts |
| `limb-designer` | unresolved capability gap, registry | proposed Skill limb | complete inert package written |
| `limb-judge` | proposed limb, tests, provenance | admission recommendation | independent admission evidence complete |

No default Neuron may call another as a language-level function. Composition occurs through
the substrate and typed routing so a generated replacement can occupy the same edge.

## 3. Required Schemas

The reference Skill must publish machine-readable schemas for:

- `AgentManifest`: package digest, schema versions, default topology, and compatibility;
- `AgentSnapshot`: root refs plus parent snapshot and causation firing;
- `Intent`: normalized request, origin, priority, deadline, and expected result schema;
- `WorkEnvelope`: intent ref, authority decision, budgets, and data classification;
- `ContextManifest`: ordered narrow reads with exact digests and inclusion reasons;
- `Plan`: goal decomposition, dependencies, acceptance predicates, and settlement budget;
- `WorkItem`: one leaf with who/what/when/where/why/how and scoped Caps request;
- `Verification`: claim, independent evidence, method, verdict, and confidence;
- `Frontier`: open, running, waiting, settled, rejected, and cancelled work refs;
- `Failure`: class, retryability, evidence, attempt, and reconciliation status;
- `MemoryIndex`: content-addressed index roots; never copied conversational state;
- `LimbRef`: admitted Skill digest, interface schemas, grant, and attachment topology.

Every schema is versioned. Unknown required fields fail closed. Extension fields live under
a namespaced `extensions` object and cannot modify core semantics.

## 4. Default Topology

```text
receptor
   │
 intake ──invalid──────────────▶ settler(reject)
   │ Intent
 governor ──denied─────────────▶ settler(reject)
   │ WorkEnvelope
 context
   │ ContextManifest
 planner
   │ WorkItems
 router ───────────────┬───────▶ existing admitted limb
                      ├───────▶ executor
                      └───────▶ limb-designer → limb-judge → admission gate
                                      │ admitted LimbRef
                                      └───────────────▶ router
 executor/admitted limb
   │ proposal + evidence
 verifier ──red───────────────▶ recovery ──bounded retry──▶ router
   │ green                                      └────────▶ settler(dead letter)
 settler ──open frontier──────────────────────────────────▶ router
   └──────root predicate green────────────────────────────▶ terminate
```

Parallel work items may execute concurrently. Only `settler` proposes the next active
snapshot pointer, and the substrate CAS remains the binding serialization point.

## 5. Good Defaults

- Deny all effects until `governor` emits a scoped grant proposal accepted by the harness.
- Use one planner and an independently implemented verifier.
- Limit initial fan-out to four, spawn depth to three, and recovery attempts to three.
- Require a deadline, maximum effects, maximum bytes, and maximum external cost on every
  work envelope.
- Prefer an existing compatible admitted limb before invoking `limb-designer`.
- Cache only committed deterministic firings with exact read and capability fingerprints.
- Treat transient messages as hints only; correctness-critical handoffs are durable.
- Keep context narrow: every read records an inclusion reason and content digest.
- Require explicit acceptance predicates before execution starts.
- Terminate on proof, typed rejection, cancellation, or exhausted budget—never on prose
  claiming that the work is done.

Defaults are data in `defaults/meta-agent.json`, not constants in the kernel. A generated
agent may replace any default by emitting a new manifest whose compatibility and
conformance witnesses pass.

## 6. Decoupling Rules

1. A Neuron reads no sibling’s private memory or concrete Zig type.
2. Edges depend on schemas and predicates, never implementation names.
3. Every mutable transition is a new artifact plus CAS, never in-place shared state.
4. Capability grants attach to one firing or admitted limb digest, not an agent name.
5. Verifiers cannot share the producer’s hidden context, model call, or unrecorded inputs.
6. Generated limbs cannot inherit the Meta-Agent’s Caps.
7. Removing a limb leaves a typed unresolved edge; it cannot corrupt the snapshot.
8. Replay disables effects and reconstructs decisions solely from recorded inputs.
9. The reference package can bootstrap from an empty substrate using only kernel
   admission, write, send, spawn, and read mechanisms.

## 7. Self-Generation Protocol

When `router` cannot find a compatible limb:

1. Write a `CapabilityGap` describing input schema, output schema, acceptance evidence,
   budgets, and authority ceiling.
2. Search admitted and external registries by interface compatibility and content digest.
3. If reuse fails, `limb-designer` writes a complete inert Skill package.
4. `limb-judge` runs schema, unit, adversarial, resource, provenance, and authority tests.
5. The harness admission gate admits or rejects the exact package digest.
6. On admission, write a new `TopologyManifest` attaching the limb through typed edges.
7. CAS a new snapshot and route the original work item to the admitted digest.
8. Record performance evidence; later snapshots may retain, replace, or retire the limb.

Generation is successful only when the new limb handles the original capability gap on
the real path. Producing source files or passing compilation alone is not settlement.

## 8. Mechanical Reference Witness

`tests/meta-agent-gate.sh` proves from an empty temporary working directory and
empty in-memory substrate that:

1. the Meta-Agent Skill is admitted by digest with no ambient authority;
2. a receptor event becomes a normalized intent and bounded plan;
3. two independent work items execute in parallel and join through the frontier;
4. a verifier rejects a plausible but false proposal and recovery reroutes it;
5. a missing capability generates, tests, admits, and attaches a new Skill limb;
6. the original work item succeeds through that newly attached limb;
7. duplicate delivery produces no duplicate effects;
8. a stale snapshot CAS loses without partial writes;
9. replay reproduces every decision digest with effects disabled;
10. the limb is detached, its grants revoked, and unreachable artifacts collected while
    audit roots remain readable.

The gate drives ordinary Registry, Runtime, Scheduler, Join, replay, limb,
revocation, CAS, and garbage-collection interfaces. Its deterministic Neuron
implementations are part of the shipped reference CLI, not test-only runtime
branches. The emitted package, trace, and final snapshot digests are retained in
`zig-out/meta-agent-witness.json` as reviewable evidence.

## 9. Implemented Walk

1. Schemas, budgets, topology, and default Neuron interfaces are published in
   `reference/defaults/meta-agent.json`.
2. `src/meta_agent.zig` advances immutable snapshots through one CAS pointer.
3. Independently bound default Neuron identities materialize intent, authority,
   context, plan, work, verification, recovery, memory, and settlement artifacts.
4. Two pure executor firings cross an atomic barrier concurrently; commits remain
   serialized and atomic in the substrate.
5. The independent verifier rejects a plausible false artifact and recovery
   reroutes the gap.
6. The limb designer writes an inert package; the judge pins it; Registry admits
   it without authority; Scheduler attaches it; the original work succeeds.
7. Every committed firing is recomputed under effects-disabled replay. The
   generated limb is detached and revoked before unreachable artifacts are
   collected with audit roots retained.
8. `tests/meta-agent-gate.sh` is the pinned completion witness.

This reference is a seed, not a superclass. Future agents fork its admitted artifacts and
replace limbs through typed compatibility; they do not inherit a monolithic agent object.
