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

## What lives where

`src/wire.zig`, exported as `typed_neuron`, is the single canonical package for
the Neuron types, transport schema, whole-decision validation, deterministic
CBOR/SHA-256 identities, and compatibility vectors. The standalone runtime
imports those types; it does not redefine them.

There are two interpreters:

- the in-memory Zig runtime in this repository is the executable reference;
- sibling Contract is the durable production interpreter and substrate used by
  Aiko.

Aiko is the production host. It imports generated Rust wire bindings, obtains
a canonical decision from each admitted node, commits consequential tool
effects to Contract's canonical outbox before dispatch, and then acknowledges
the exact effect. Contract ABI 12 records the firing and node settlement in
one append-only transaction.

The expected source layout is:

```text
Unbrowse/
├── neuron/
├── contract/
└── aiko/
```

Check the complete boundary with:

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
bash tests/gate.sh                   # specification benchmark
bash tests/runtime-gate.sh           # standalone runtime
bash tests/meta-agent-gate.sh        # composed agent lifecycle
bash tests/check-production-neuron.sh # Neuron + Contract + Aiko
```
