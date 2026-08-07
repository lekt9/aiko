# Contract is the Neuron substrate

> STEER law: map recursive agent growth onto the Contract substrate already in
> production. There is **no second primitive** and no second durable truth.

## The production shape

Contract is the interpreter, capability membrane, scheduler, and append-only
substrate for one typed primitive: the Neuron. Aiko supplies a build-admitted
Meta-Agent Skill as the default reference connectome. Task Skills are limbs
which attach to its typed ports; they are not independent agent harnesses.
Contract imports the canonical pure firing types, validator, and identity
hashes from the sibling `typed_neuron` Zig package; it does not maintain a
parallel Neuron core.

```text
observe → recall → route → act ─────────────────→ verify → judge → settle
                    │                              ↑
                    └→ admitted task limb(s) ──────┘
```

The seven core nodes are embedded in the Aiko binary from
`.agents/skills/aiko-meta-agent/contract-skill.json`. Their actions are
`skill:aiko-meta-agent@1.0.0:<worker>`. There is no opaque `agent:aiko` action.

| Concern | Mechanical owner |
|---|---|
| Typed firing and decision admission | Contract ABI v12 `contract_neuron_fire_json` |
| Dependency-ready node lease and settlement | Contract ABI v12 node claim/settle |
| Durable identity, authoritative evidence, replay, contradiction | Contract ledger |
| Default topology and policy | Embedded `aiko-meta-agent` Skill |
| Task-specific behavior | Matched, manifest-validated Neuron Skills |
| External effects | Contract Caps and hardened product adapters |
| Dynamic attachment | `route` attach port and `verify` join port |
| Bounded growth | depth, node, time, effect, and concurrency budgets |

Both live turns and leased durable claims call the same Skill planner and admit
the same graph. A leased claim executes that graph node-by-node through
dependency-ready Contract leases. A foreground product turn remains the
interactive Aiko worker for its admitted reasoning occurrence, while every
consequential tool invocation expands a typed per-tool Neuron graph and binds
to the current Contract node/root. The CLI, desktop, and channel surfaces keep
their existing UX without becoming a second durable truth source.

The provider's end-turn signal crosses one bounded host-boundary Neuron named
`adapter/aiko-turn-terminal`. It commits only the typed terminal event and
digests—never prompt text—and is not an agent or a task-execution node.

Mechanical host nodes use exact named adapters only. `route` projects the Skill
references selected during graph materialization; it never performs a second
model route. Model-backed nodes run a tool-capable producer and then cross a
read-only hard-type boundary. Complete JSON already present in producer output
is extracted before any bounded fallback typing, so truncation cannot erase
evidence.

The adapter verdict is private host data. Before settlement Aiko turns it into
the canonical generated `NeuronDecision`; Contract validates that decision
with imported `typed_neuron` semantics instead of constructing a synthetic
decision from the verdict.

Digest-pinned `script` nodes cross a separate JSON-stdio boundary and never
route through the model. The runtime clears ambient environment variables,
binds the working directory, applies the admitted timeout and envelope limits,
and accepts only the versioned result schema with the node's exact evidence
keys. The product binary reuses Aiko's existing kernel sandbox entrypoint for
each script: the node declares the `read-only` scope, and the runner enforces
it with the read-confined `strict` kernel profile — system paths, the script
workspace, the admitted Skill root, and interpreter prefixes as explicit
read-only package Caps, nothing else readable — and fails closed when
enforcement is unavailable. Script Neurons are pure decision producers: a
script node with an effectful scope is rejected. External effects require a
separately admitted named adapter and the canonical pre-dispatch membrane.
Script admission never expands Caps.

## Atomic settlement and adapters

Contract appends the canonical firing, authoritative evidence, node
settlement, and pending effect outbox as one `neuron_transaction`. Evidence
blob materialization after that append is a reconstructible cache, not a
separate authority.

Every consequential Aiko tool call commits a canonical tool-effect decision
before `dispatch_tool`. After the named adapter returns, Aiko settles that
exact outbox effect through ABI v12. Replay does not dispatch again.
Uncertainty remains `reconciliation_required`; it is not converted into an
automatic retry.

## Why the old fractal model changed

[plasma-ai/fractal](https://github.com/plasma-ai/fractal) remains a useful
diagnostic analogy: recursive children, feedback, isolation, and hard caps.
Previously Aiko encoded that shape as a fixed
`observe → agent:aiko → verify → feedback` spine. The opaque middle node mixed
topology, model policy, and execution.

The Neuron-native model retains the useful recursion but makes every node an
admitted Skill action with explicit dependencies, inputs, effects, evidence,
and budgets. The fixed agent center is replaced rather than wrapped.

## Generative limbs

When verification exposes a real capability gap, the `learn` Neuron first
searches for or repairs an existing Skill. A genuinely missing limb is emitted
as an inert candidate package: `SKILL.md`, `contract-skill.json`, focused
scripts or assets, evals, and a runnable witness. Admission, attachment,
monitoring, rollback, and retirement are ledger-governed operations. Generation
does not grant execution authority.

The candidate lifecycle is intentionally separate from historical mutation:
identity plus version plus content digest names an immutable candidate, and a
later ledger event activates, rejects, retires, or rolls it back.

## Witness

```bash
bash scripts/witness-meta-agent-neuron-graph.sh
```

The witnesses validate the Skill package, prove route/verify limb composition,
exercise ABI v12 dependency-wave leasing, authoritative evidence/replay, exact host
adapters, live/durable admission parity, fail-closed node bounds, and reject the
opaque agent action:

```bash
bash scripts/witness-neuron-node-execution.sh
```

## Forbidden

- A new brain, fractal, graph, or orchestration runtime beside Contract
- Process-local shared agent state as durable truth
- Filesystem Skills that shadow or self-declare the build-admitted core
- Ambient transcript injection in place of explicit evidence bindings
- Generated code becoming active before admission and a runnable witness
- Treating provider acknowledgement or model prose as goal completion
