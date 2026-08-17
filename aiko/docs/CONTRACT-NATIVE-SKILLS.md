# Contract-native skills

Aiko now treats domain behavior as versioned Contract graph bundles rather
than adding another branch to the Rust substrate. The substrate owns graph
validation, lineage, fan-out limits, effect/authority policy, evidence, and
settlement. A bundle owns triggers, domain instructions, node dependencies,
effects, and verification requirements.

## Resolution

The embedded `aiko-meta-agent` core is always first and cannot be shadowed.
Matched Skills use this deterministic precedence for equal IDs:

1. project `.agents/skills`, `.aiko/skills`, `.grok/skills`, then a
   Contract-activated project artifact;
2. user `~/.agents/skills`, `~/.aiko/skills`, `~/.grok/skills`, then a
   Contract-activated user artifact;
3. Aiko's bundled library.

Invalid schemas, unsafe relative script paths, unknown effects, dependency
cycles, unsupported platforms, and ungoverned consequential nodes fail closed.
The entire graph is capped at sixteen nodes. The seven-node core is admitted
first; up to four matching limbs may use the remaining budget. Limb roots attach
at `route`, and their terminal evidence rejoins at `verify`.

Generated Skills have a stricter path. Their complete package is hashed into
`.aiko/neuron-skills/objects/<sha256>/`; the registry admits it only when the
directory still matches that digest and Contract's ledger projects that exact
artifact as active. A candidate or retired artifact is inert even though its
bytes remain available for audit and rollback.

## Inspect and test

```sh
aiko native contract-skills list
aiko native contract-skills plan "inspect this project and run its tests"
./scripts/test-contract-native-skills.sh
```

The TUI equivalent is `/contract-skills` or
`/contract-skills <goal>`. Desktop Settings → Skills uses the same native
endpoints: `GET /v1/contract-skills` and
`POST /v1/contract-skills/plan`.

The canonical suite validates every bundled manifest (including the always-on
Meta-Agent), their examples, Rust registry tests,
malformed/cyclic/path-traversal/effect-laundering cases, the native binary, and
the desktop build. Set `AIKO_SKILL_TEST_FAST=1` for manifest-only checks while
authoring.

Contract ABI v13 materializes each admitted node with an exact worker kind,
named adapter or relative script path, script digest, input bindings, effect
scope, evidence keys, and activation provenance. Dependency-ready waves are
leased and settled individually. The credential-rejecting canonical evidence
payload enters the same append-only transaction as the firing and settlement.
A content-addressed artifact written afterward is a reconstructible read cache,
not a second authority.

Aiko produces the canonical `NeuronDecision` before node settlement. Contract
atomically appends that firing, authoritative evidence, node settlement, and
pending effect outbox in one `neuron_transaction`; later evidence-blob writes
are reconstructible caches. Consequential named tools commit their pending
effect before adapter dispatch and acknowledge the exact effect afterward.

Foreground provider completion uses the explicit
`adapter/aiko-turn-terminal` host-boundary Neuron. It records the bounded
terminal commitment only; it neither substitutes for the admitted Meta-Agent
graph nor acquires task-execution authority.

An admitted `script` worker does not re-enter the model loop. Aiko resolves the
relative path through the active immutable Skill, verifies its pinned digest,
clears the ambient environment, supplies only the bounded
`aiko.neuron-script.invoke/v1` JSON receptor over stdin, enforces the node
timeout, and accepts only `aiko.neuron-script.result/v1` on stdout. The result
must contain exactly the evidence keys declared by the node. This adapter is an
execution boundary, not an authority grant: the product's existing kernel
sandbox runner must successfully apply `read-only` before the script starts.
Script nodes are admitted only as pure read-only producers; an effectful script
node fails closed because effects require a separately declared adapter and the
canonical pre-dispatch membrane. Seatbelt enforces the boundary on macOS;
Landlock/bubblewrap and Aiko's child-network filter enforce it on Linux. The
exact admitted Skill root is added as a read-only Cap so packaged helpers and
assets remain composable without granting ambient home access. Unavailable
enforcement fails closed.

## Create, override, or remove

Use the repository generator to reproduce the bundled examples:

```sh
./scripts/generate-contract-native-skills.py
```

For a hand-written bundle, initialize a normal skill folder, add a manifest
conforming to [the v1 schema](../.agents/contract-skill.schema.json), then add
cases under `tests/cases.json`. A project or user bundle with the same ID
replaces the bundled version locally. Removing that directory restores the next
lower precedence version.

Consequential effects must be declared on the actual node that performs them.
Wrapping a purchase, message, publication, deletion, permission change, or
account mutation in a read-only parent never removes the authority hold.

For an arbitrary external interface, use the bundled `contract-interface`
Skill. Its receptor compiler grows the same typed germ-layer graph around a
real adapter and emits instructions, manifest, capability/receptor assets,
agent metadata, evals, cases, and a runnable witness.

`grow.py SPEC --install` does not copy mutable code into the ordinary Skill
layer. It reproduces the package, runs conformance and its witness, checks
privacy/provenance/replay/rollback gates, stores the immutable object, then asks
Contract to record `stage → admit → activate`. Replacement activation retires
the prior digest atomically. Use `--rollback-to <digest>` to restore a prior
admitted object or `--retire` to disable the active object. Those authority
transitions are append-only; historical bytes and events are never rewritten.
