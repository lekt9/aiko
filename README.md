# Typed Neuron

Typed Neuron is the canonical Zig contract and executable reference runtime for
one agentic primitive:

```text
Neuron.fire(Stimulus, Caps) -> Decision
```

A Neuron is stateless decision logic. It returns one control result and
declarative `write`, `send`, or `spawn` effects. The interpreter validates the
whole decision and commits every effect atomically or commits none.

## Start here

- [`AGENTS.md`](AGENTS.md) — normative architecture
- [`IMPLEMENTATION.md`](IMPLEMENTATION.md) — code map, execution flows, trust
  boundaries, production integration, gates, and known limits
- [`reference/SWARM_NODE.md`](reference/SWARM_NODE.md) — installable,
  persistent multi-machine node and `neuron.wire/v1` interface
- [`reference/SUPER_META_PATTERNS.md`](reference/SUPER_META_PATTERNS.md) —
  complete current super-meta pattern catalog, coverage map, and residuals
- [`reference/AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md`](reference/AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md) —
  anything-first plan for the canonical agent entrypoint and universal adapters
- [`reference/AGENTIC_ORGANISM.md`](reference/AGENTIC_ORGANISM.md) —
  organism-level natural analogy and falsifiable engineering consequences
- [`bench/agentic-organism/benchmark.json`](bench/agentic-organism/benchmark.json) —
  48 real-world prompts, stressors, trials, hard failures, and 100-point rubrics
- [`reference/META_AGENT.md`](reference/META_AGENT.md) — default decomposed
  Meta-Agent limb
- [`reference/ROADMAP.md`](reference/ROADMAP.md) — unfinished work only

Requires Zig 0.16:

```sh
zig build test
zig build run -- demo
zig build run -- check --json
zig build run -- meta-agent-check --json
```

Build the CLI and fire an external JSON-stdio Neuron:

```sh
zig build
./zig-out/bin/neuron run \
  --def <manifest.json> \
  --neuron <id> \
  --stimulus <file|-> \
  --json
```

## Install a swarm node

The portable node entry point is:

```sh
neuron node serve <node_dir>
```

Build a host-specific Linux or macOS bundle, copy its `.tar.gz` to a compatible
machine, and run the bundled installer:

```sh
bash packaging/build-bundle.sh ./dist
tar -xzf dist/typed-neuron-*.tar.gz
cd dist/typed-neuron-*
./install.sh
```

The installer creates a stable Ed25519 device identity and durable node
directory, but does not enable a background service without operator action.
Every node serves the same framed `neuron.wire/v1` interface. Production
ingress and CLI egress are restricted to Tailscale addresses by default.

## Standalone agent entrypoint

`neuron agent` is the canonical agent entrypoint (Phase 1 of the
[phased plan](reference/AGENT_ENTRYPOINT_UNIVERSAL_INTERFACE_PLAN.md)). It
works from an empty directory:

```sh
zig build
./zig-out/bin/neuron agent init <node_dir> <agent_id>
./zig-out/bin/neuron agent run <node_dir> <agent_id> --goal "<text>" --json
./zig-out/bin/neuron agent inspect <node_dir> <agent_id> --json
```

Each goal drives a composed stage network (intake → worker → verifier →
settler) built from the same Neuron primitives, grounded by durable
`neuron.firing-settled/v1` settlement events, and advanced by compare-and-swap
snapshots; it runs without Aiko or Contract. Rerunning an identical settled
goal replays the recorded result with a byte-identical WAL. `neuron agent
cancel` settles a not-yet-fired workflow as cancelled; `neuron agent retire`
CAS-advances the active snapshot to retired so later runs fail closed.
Runnable witness:

```sh
bash tests/agent-entrypoint-gate.sh
```

`neuron interface ...` — the universal adapter membrane for functions,
libraries, binaries, stores, APIs, protocols, streams, models, devices,
humans, and remote Neurons — is parsed but fails closed as NotImplemented;
plan Phases 2+ are not built yet.

## What lives where

`src/wire.zig`, exported as `typed_neuron`, is the single canonical package for
the Neuron types, transport schema, whole-decision validation, deterministic
CBOR/SHA-256 identities, and compatibility vectors. The standalone runtime
imports those types; it does not redefine them.

There are two interpreters:

- the in-memory Zig runtime in this repository is the executable reference;
- sibling Contract is the durable production interpreter and substrate used by
  Aiko.

The dependency direction is one-way:

```text
Aiko host → Contract ABI → canonical typed_neuron package
```

Neuron does not depend on Aiko. The standalone package, CLI, and swarm-node
bundle build and run without either sibling. Contract imports Neuron's
canonical Zig semantics; Aiko loads Contract's ABI and uses mechanically
generated Rust transport DTOs. References to `../aiko` are binding-generation
and cross-repository conformance paths, not a Neuron runtime dependency.

Aiko is the production host. It imports generated Rust wire bindings, obtains
a canonical decision from each admitted node, commits consequential tool
effects to Contract's canonical outbox before dispatch, and then acknowledges
the exact effect. Contract ABI 12 records the firing and node settlement in
one append-only transaction.

## Source layout and building Contract

Neuron is published as its own repo (`Unbrowse/neuron`).

Contract (the production substrate and `contract` CLI) is in `Unbrowse/contract`.

Contract now depends on the published neuron package via git (not a manual sibling checkout). See the "Building from source (single clone)" section in the Contract README for the exact commands:

https://gitea/.../Unbrowse/contract (or your local clone) → README.md

For the standalone neuron reference runtime only (this repo):

```sh
zig build test
zig build run -- demo
zig build
./zig-out/bin/neuron run --def <manifest> --neuron <id> --stimulus <file> --json
```

Check production boundary invariants with:

```sh
bash tests/check-production-neuron.sh
```

## Implemented reference behavior

- one polymorphic hard-typed `Neuron.fire` boundary;
- deny-by-default, prefix-scoped capabilities and aggregate budgets;
- atomic write/send/spawn decisions and compare-and-swap artifacts;
- evidence grounding against the exact stimulus, messages, and pinned reads;
- at-least-once delivery with stable effect identities, bounded retry,
  dead-letter, and reconciliation;
- deterministic cache identities and effect-disabled replay;
- deadlines, cancellation, quorum joins, cycle progress, rewiring, and
  retention-root garbage collection;
- Skill admission with digest, signature, scan, tests, and no ambient
  authority;
- a bounded external script-Neuron protocol;
- signed peer delegation and framed mesh delivery;
- a complete Meta-Agent witness including concurrent work, independent
  verification, recovery, generated-limb admission, replay, revocation, and
  collection.

The standalone substrate remains deliberately in-memory and is not presented
as crash-safe production storage. Experimental limb directories are also not
treated as admitted capabilities until their complete lifecycle is runnable.

## Gates

```sh
python3 tests/check_agents.py        # normative document
python3 tests/check_super_meta_patterns.py # super-meta catalog closure
bash tests/gate.sh                   # specification benchmark
bash tests/runtime-gate.sh           # standalone runtime
bash tests/meta-agent-gate.sh        # composed agent lifecycle
bash tests/agent-entrypoint-gate.sh  # standalone agent entrypoint
bash tests/swarm-package-gate.sh     # bundle + two installed nodes
bash tests/check-production-neuron.sh # Neuron + Contract + Aiko
```
