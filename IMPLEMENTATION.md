# Typed Neuron implementation

This document describes the code that exists today. `AGENTS.md` is the
normative architecture contract; this file is the implementation map and
operational guide. If prose and executable behavior disagree, the canonical
types and tests win until the prose is corrected.

## One primitive, three responsibilities

The system has one user-programmable computational primitive:

```text
Neuron.fire(Stimulus, Caps) -> Decision
```

A decision contains exactly one control result and zero or more declarative
`write`, `send`, and `spawn` effects. A Neuron does not apply those effects.

The implementation separates three responsibilities without introducing a
second primitive:

| Responsibility | Owner | What it may do |
|---|---|---|
| Pure contract | `typed_neuron` (`src/wire.zig`) | Define types, validate a firing, and compute canonical identities |
| Interpreter and substrate | standalone `Runtime` or production Contract | Admit execution, enforce Caps, validate the whole decision, and commit or reject all declared effects |
| Host and adapters | CLI or Aiko | Turn external input into a stimulus, run an admitted implementation, and perform already-admitted external effects |

Policy that can be expressed as an ordinary Neuron belongs in an admitted
generative limb. The trusted interpreter retains only mechanisms needed for
typing, isolation, capability enforcement, atomic commit, identity, delivery,
and liveness.

Dependency flows toward the canonical package:

```text
Aiko (host/adapters) → Contract (durable interpreter) → typed_neuron
```

The standalone Neuron build, CLI, tests, and installable swarm node have no
runtime dependency on Aiko or Contract. Contract imports `typed_neuron`; Aiko
loads Contract's ABI and consumes generated transport DTOs. Sibling paths used
by binding generation and production conformance do not reverse this
dependency.

## Documentation authority

| Document | Authority |
|---|---|
| `AGENTS.md` | Normative architecture and conformance requirements |
| `schema/typed-neuron-wire.json` | Canonical transport schema source |
| `reference/META_AGENT.md` | Normative seed for composed agent behavior |
| `reference/SUPER_META_PATTERNS.md` | Expanded SMP-01–SMP-32 catalog, sources, coverage, status, and residuals |
| `reference/AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md` | Anything-first agent-entrypoint and universal-interface plan (Phase 1 implemented; Phases 2+ unsettled) |
| `reference/AGENTIC_ORGANISM.md` | Normative natural-system translation and benchmark derivation |
| `bench/agentic-organism/benchmark.json` | Structural authority for 48 benchmark prompts, trials, stressors, scoring, evidence, hard failures, and judge output |
| `reference/defaults/meta-agent.json` | Machine-readable default Meta-Agent package |
| `IMPLEMENTATION.md` | Current implementation and production integration |
| `reference/ROADMAP.md` | Unsettled work only |
| `reference/EBM_NEURON.md` | Diagnostic energy-based-model lens |

Generated files are never edited by hand:

- `src/generated_wire.zig`
- `../aiko/crates/codegen/xai-grok-shell/src/contract_native/typed_neuron_wire.rs`
- `../contract/libcontract/typed-neuron.lock.json`

Regenerate or check them with:

```sh
python3 tools/generate_wire_bindings.py
python3 tools/generate_wire_bindings.py --check
```

## Canonical package

`build.zig` exports `src/wire.zig` as the Zig module `typed_neuron`.
`src/types.zig`, `src/caps.zig`, and `src/neuron.zig` are aliases over that
module; they do not own parallel runtime contracts.

The package owns:

- the runtime `Neuron`, `Stimulus`, `Caps`, `Decision`, `Control`, `Effect`,
  `Evidence`, message, artifact, and spawn types;
- generated transport DTOs used at the Contract ABI boundary;
- whole-decision validation, including schema, Caps, budget, deadline, and
  grounding checks;
- deterministic CBOR plus SHA-256 firing and decision identities;
- runtime stimulus, decision, and capability fingerprints;
- fixed compatibility vectors and schema/version identifiers.

The current package identity is exposed by `CORE_VERSION`, `HASH_PROFILE`, and
`SCHEMA_DIGEST`. Breaking transport semantics require a schema version, hash
domain, core version, generated-binding, lock, and fixed-vector change
together.

The generated Rust structures are codecs only. Semantics remain in the Zig
package and Contract calls those semantics through the native ABI.

## Firing lifecycle

Both interpreters preserve this mechanical order:

```text
receive
  -> pin admitted neuron, Caps, messages, and readable artifact digests
  -> execute pure decision logic
  -> validate the complete decision
  -> atomically commit decision plus local effects
  -> expose committed outbox work to external adapters
```

Before commit, a `write` is not an artifact, a `send` has not been delivered,
and a `spawn` is not executable. A malformed or unauthorized member rejects
the entire decision.

Evidence sources must resolve to the current stimulus, a message, or an exact
digest-pinned read. A claim cannot ground itself in an arbitrary artifact name.

At-least-once delivery is made safe with stable firing/effect identities.
External delivery is not described as exactly once: adapters must use an
idempotency key, and uncertainty is parked for reconciliation.

## Standalone reference interpreter

The standalone implementation is intentionally small and in-memory. It is the
executable reference for the architecture, not the production durability
layer.

Complete source map:

| Module | Responsibility |
|---|---|
| `src/wire.zig` | Canonical types, validation, deterministic identities, and generated transport exports |
| `src/generated_wire.zig` | Generated Zig transport DTOs and compatibility constants |
| `src/types.zig`, `src/caps.zig`, `src/neuron.zig` | Thin aliases and binding helpers over `typed_neuron` |
| `src/runtime.zig` | Execute `Neuron.fire`, validate, and atomically commit |
| `src/substrate.zig` | In-memory artifacts, messages, definitions, firings, cache, and transaction state |
| `src/registry.zig` | Admit and revoke digest-pinned Skill packages without granting authority |
| `src/scheduler.zig` | Sparse work scheduling and cycle-progress checks |
| `src/topology.zig` | Edges, joins, quorum, and rewiring |
| `src/delivery.zig` | Acknowledge, retry, dead-letter, and reconciliation state |
| `src/cache.zig` | Content-addressed firing cache and replay-safe reuse |
| `src/limb.zig` | Generated Skill limb admission, attachment, and retirement |
| `src/middleware.zig` | Mechanically constrain fallible child output to fixed targets, evidence, control, and payload bounds |
| `src/observability.zig` | Metrics and effect-disabled replay verification |
| `src/script.zig` | JSON-stdio adapter for an external Neuron implementation |
| `src/run.zig` | Manifest/stimulus ingress and CLI execution projection |
| `src/agent_ops.zig` | Standalone `neuron agent` lifecycle: composed stage neurons, settlement-event grounding, CAS snapshot advance |
| `src/main.zig`, `src/demo.zig` | CLI dispatch and atomic write/send/spawn demonstration |
| `src/meta_agent.zig` | Full default Meta-Agent composition witness |
| `src/mesh.zig`, `src/identity.zig` | Signed delegation and framed peer delivery |
| `src/tailnet.zig` | Tailnet peer classification to a deny-by-default capability ceiling |
| `src/mcp.zig` | MCP stdio edge exposing bounded `neuron.info` and `neuron.fire` tools |
| `src/interface.zig` | Normalize channel updates and provide scoped router/conversation Neurons |
| `src/pump.zig` | Bounded event pumping, wait predicates, and work-factory dispatch |
| `src/energy_router.zig` | Orphan experimental router prototype; formatted but not imported by the build |
| `src/tests.zig` | Behavioral conformance, integration, transport, and lifecycle witnesses |

`Runtime.fire` records timeout failures, rejects invalid decisions before
mutation, and uses the substrate transaction as the linearization point.
Standalone writes, sends, and spawns either all appear or none do.

### Script Neurons

`neuron run` admits an external process as decision logic:

```sh
neuron run \
  --def path/to/neuron.json \
  --neuron worker-id \
  --stimulus path/to/stimulus.json \
  --json
```

The manifest supplies the argv, requested capability prefixes, package version,
and fallback timeout. The invocation/result schemas are fixed by the runtime.
The harness stages only declared digest-pinned reads, sends a bounded JSON
invocation on stdin, reads one typed decision from stdout, validates it, and
commits it atomically. A hung child is killed and recorded as `timed_out`.

This adapter is a process and protocol boundary, but the standalone CLI is not
a complete production OS sandbox and does not content-pin the executable named
by argv. Do not grant an untrusted script more host access merely because its
returned decision is validated. Production Aiko separately verifies the
admitted script digest before and after entering its read-only sandbox.

### Signed mesh

The mesh is a reference transport, not a global scheduler. Device identities
use Ed25519. Delegations bind account, device, expiry, and attenuated Caps.
Signed envelopes are length-framed over TCP. A receiver verifies the envelope
and grant, resolves a local admitted Neuron, and fires it through the ordinary
runtime. Network receipt never bypasses local admission or Caps.

### Meta-Agent

`reference/META_AGENT.md` decomposes agent behavior into snapshot reconstruction,
context, routing, planning, parallel workers, verification, recovery,
settlement, learning, and garbage collection. `src/meta_agent.zig` exercises
that package using ordinary Registry, Runtime, Scheduler, join, CAS, replay,
limb, revocation, and collection interfaces.

It proves that:

- durable state is reconstructed from typed artifacts;
- workers can run concurrently while commits remain serialized;
- false work is independently rejected and recovery is rerouted;
- a generated limb is written inert, admitted by digest, attached, used,
  revoked, detached, and collected;
- duplicate effects and stale snapshot commits do not corrupt state;
- completion is the runnable witness, not resemblance to the reference prose.

Run it with:

```sh
zig build run -- meta-agent-check --json
bash tests/meta-agent-gate.sh
```

The retained result is `zig-out/meta-agent-witness.json`.

## Production interpreter: Contract

Production durability lives in `../contract/libcontract`; it is not copied
into this repository.

Contract imports `typed_neuron` through `libcontract/build.zig.zon`. Its
`src/neuron.zig` is a JSON and durable-ledger adapter that re-exports the
canonical validator and identities. `typed-neuron.lock.json` pins the content
of the mutable sibling dependency, including the normalized schema. This is a
content pin rather than a Git revision because this Neuron directory is not
currently its own Git repository.

The production C ABI is version 12. The important boundary is:

1. Aiko supplies a canonical fire request or canonical decision.
2. Contract validates and hashes it with imported `typed_neuron` semantics.
3. Contract appends one `neuron_transaction` containing the canonical firing,
   authoritative evidence payload, node settlement, and pending effect outbox.
4. The append-only transaction is the decision/effect linearization point.
5. Evidence blob materialization occurs after commit as a reconstructible
   cache; a missing blob is rebuilt from committed transaction data.
6. Tool adapters acknowledge the specific outbox effect through
   `contract_neuron_effect_settle_json`.

Duplicate firings replay the existing result. A different decision for an
existing firing identity is a contradiction and fails closed. A torn JSONL
tail is ignored; a committed transaction remains reconstructible. An uncertain
external effect stays pending for reconciliation and is never silently run
again.

## Production host: Aiko

Aiko imports mechanically generated Rust transport DTOs and loads Contract's
compiled ABI. It does not carry a second Zig validator.

Model, host, and script implementations may use private adapter result types
internally, but node settlement crosses the boundary as a canonical
`NeuronDecision`.

Consequential tool calls follow this order:

```text
build canonical tool-effect decision
  -> Contract admits and commits its pending outbox effect
  -> Aiko dispatches the named adapter
  -> Aiko settles that exact effect with the adapter acknowledgement
```

Raw tool arguments are hashed into the canonical payload and are not persisted
as cleartext ledger evidence. Replay suppresses duplicate dispatch. An
uncertain prior dispatch produces a hold for reconciliation.

Aiko script nodes are stricter than the standalone CLI: production scripts run
only through its enforced read-only sandbox and may only produce a canonical
decision. Effectful script nodes fail closed; external effects must pass
through the same pre-dispatch membrane as named product tools.

Contract bookkeeping for an ordinary conversational turn remains best-effort,
but a tool effect already governed by a canonical Neuron decision is not
best-effort: it must cross the Contract membrane before dispatch.

## Generative limbs

A limb is executable only after describe, write, admit, and attach. A source
file or directory named like a Skill is not evidence of that lifecycle.

Current status:

| Limb | Status |
|---|---|
| Meta-Agent generated retry/verification limb | Conforming reference witness in `src/meta_agent.zig` |
| `limbs/energy-router` | Reference generative limb package delivered (manifest + Python neurons + versioned schemas + harness execution via `neuron run --def`). Supports EBM routing, sub-EBM spawn, PackageOffer discovery, Usage/Settlement claims for paid mesh commons. Pure scorers (`scorer.py`, `energy.zig`) + early Zig `EnergyRouterNeuron` also present. Not yet wired into meta-agent router slot; full benchmark deltas and Zig build integration remain. |
| `limbs/outbox-drainer` | Partial prototype; decision scripts and driver exist, but its manifest and conformance suite are missing |

The energy-router package can be executed through the real harness and emits grounded `EnergyScore` artifacts (and spawns on `wants_sub_ebm`). It is the concrete reference for the structural-energy + paid-neuron-commons direction. It is not yet "the" production router inside the meta-agent, nor has it produced published settlement-metric wins against a baseline. The package + harness witness is the settled artifact.

The outbox drainer likewise must not be used as the production guarantee.
Production Aiko external effects currently use Contract's canonical effect
outbox and ABI settlement path.

## Test and witness matrix

Run the smallest gate that proves the claim being changed:

| Claim | Command |
|---|---|
| Normative document shape | `python3 tests/check_agents.py` |
| Super-meta pattern/atom/section closure | `python3 tests/check_super_meta_patterns.py` |
| Spec discrimination benchmark | `bash tests/gate.sh` |
| Standalone behavior, CLI, benchmark, Meta-Agent | `bash tests/runtime-gate.sh` |
| Meta-Agent lifecycle only | `bash tests/meta-agent-gate.sh` |
| Standalone agent entrypoint (plan Phase 1) | `bash tests/agent-entrypoint-gate.sh` |
| Generated files and Neuron/Contract/Aiko boundary | `bash tests/check-production-neuron.sh` |
| Wire generator drift only | `python3 tools/generate_wire_bindings.py --check` |

`tests/gate.sh` is a specification gate. It does not establish runtime
correctness. `tests/runtime-gate.sh` compiles and executes the standalone
behavioral witnesses. `tests/check-production-neuron.sh` is the complete
cross-repository production witness: it checks generated bindings and the
content lock, builds Neuron and Contract, then runs focused Aiko Rust and
native-FFI tests.

The JESPA ledger counts only reproduced wins and retains honest negatives. It
does not convert a document assertion into an implementation result.

## Known limits

The standalone reference runtime is not a durable production substrate. It
does not claim:

- crash-safe multi-process storage;
- production schema migration;
- a complete OS sandbox on every platform;
- content-pinned executable admission in the standalone `neuron run` adapter;
- exactly-once remote effects;
- globally ordered peer messages;
- automatic contract-native mesh formation or cross-machine topology convergence;
- an admitted runtime Pattern Registry Neuron that consumes the document catalog;
- the universal `InterfaceManifest` registry for arbitrary code, binaries,
  stores, APIs, protocols, models, devices, humans, remote Neurons, and paid
  resources (the standalone `neuron agent init|run|inspect|cancel|retire`
  lifecycle is implemented and witnessed by `tests/agent-entrypoint-gate.sh`;
  every `neuron interface ...` verb still fails closed as NotImplemented);
- behavioral execution adapters, fixtures, or measured agent scores for the
  Agentic Organism prompt benchmark; its current gate validates the corpus and
  rubric only;
- that an experimental limb is admitted merely because its source exists.

Contract supplies the current durable production transaction and recovery
path. Aiko supplies product adapters and sandbox enforcement. Remaining work is
kept in `reference/ROADMAP.md`.

## Change procedure

For a canonical contract change:

1. edit `schema/typed-neuron-wire.json` and/or `src/wire.zig`;
2. change schema/hash/core versions for breaking semantics;
3. regenerate Zig and Rust bindings plus the Contract content lock;
4. add or update fixed vectors and behavioral tests;
5. update this implementation map and any affected host documentation;
6. run `bash tests/check-production-neuron.sh`.

For an interpreter feature, first ask whether it can be an admitted Neuron
limb. Kernel placement requires a concrete trust-boundary, atomicity,
isolation, or liveness reason. For a limb, source generation is only the
`write` phase; admission, least-authority attachment, operation, judgment, and
retirement must all be witnessed.
