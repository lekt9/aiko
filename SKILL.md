---
name: contract
description: Minimal native contract-neuron primitive. Declare one truth claim; the server-side DAG integrates evidence, spawns child neurons, and recursively fires affected neurons until the graph settles.
user-invocable: true
---

# /aiko

`aiko` and `contract` are the same substrate. `aiko` is the one public binary
name; `contract` is the row/type name and compatibility alias used by older
activation flows. Do not design separate aiko-vs-contract surfaces.

Local code is only the environment executor for the server-spawned aiko context.

Before legacy contract-skill work, load active context:

```bash
~/.claude/skills/contract/scripts/contract discover --scope all
```

## Public Shape

The user-facing surface is exactly:

```bash
aiko "<goal>" --remote
aiko "<goal>" --local
```

The older `contract` binary remains only as a compatibility/context entrypoint
for existing activation and migration flows. It must behave as an alias over the
same aiko shape, not a second language.

`aiko` is the Zig neuron substrate with the smallest local surface. It does not
expose context verbs locally. It accepts one goal and one mode. `--remote`
routes to the Unbrowse contract ledger, defaulting to
`https://beta-api.unbrowse.ai` when `UNBROWSE_BASE` is not set. `--local` uses
the same neuron shape against the local scoped ledger.

`aiko` is x402-native. It marks contract declarations as Corbits/Faremeter Flex
requests and sends a signed payment header from the caller environment when
present:

```text
AIKO_X_PAYMENT / X_PAYMENT -> X-PAYMENT
```

If no payment header is available, Unbrowse returns the canonical 402 payment
requirements envelope instead of falling back to local mutation.

`aiko` guards privacy before network egress. Local declarations are reduced to
patterns and meta-patterns: obvious emails, local filesystem paths, and
secret-like tokens are replaced with `[email-pattern]`, `[local-path-pattern]`,
and `[secret-pointer-pattern]`. The server may resolve pointer values inside
typed context, but the local binary does not leak machine-specific private
values.

There are no public action, parent, iterate, mark, spawn, status, or search
choices. Context and status may be injected by the runtime, but they are not
escape hatches the caller chooses.

Reduced vocabulary:

```text
aiko = public primitive and spawned environment
contract = ledger row/type name for the same thing
goal/plan/prompt = one truth claim
parent_id = containment edge
contract:<id> = pointer edge
posthook_pointer = pointer called after promotion
wallet_identity = identity pointer used to sign calls
replicated_from_contract_id = paid copy of an out-of-lineage contract
network_tunnel_contract_id = server-side connectivity adapter
```

## Neuron Shape

Every declaration is a contract neuron:

```text
truth claim
-> inherit lineage from CONTRACT_PARENT_ID / CONTRACT_PARENT
-> integrate child evidence
-> run the server-selected harness/funnel/loop verifier
-> fire when its threshold resolves true
-> recursively fire contained children, affected parents, and contract-ref neurons
-> stop when the DAG settles or evidence is missing
```

`parent_id` is the containment edge. It means one environment owns and wraps
another environment, not merely that one task is listed under another. The
fractal hierarchy is atom -> cell -> tissue -> organ -> organism in the same
mechanical sense: each child contract runs inside the environmental field
created by its parent, and that parent can itself be a child of a larger
environment.

The DAG is multidimensional. `parent_id` is the containment dimension.
`contract:<id>` references are cross-dimension dependency edges. When a neuron
fires, the substrate recursively fires contained child neurons, containment
ancestors, and dependent cross-edge neurons until no newly-true signal
propagates.

Hooks are contracts too. A prehook is another contract-neuron that gets the
spawned environment context and may hold execution before the declared neuron is
created. A posthook is another contract-neuron that fires after the declared
neuron resolves. They are carried by environment, not public flags:

```text
CONTRACT_PREHOOK_ID / CONTRACT_PREHOOK
CONTRACT_POSTHOOK_ID / CONTRACT_POSTHOOK
```

Each hook is a breakpoint: if it cannot resolve, propagation waits there with
ledger evidence. The same shape applies whether the environment is an API call,
a Telegram bot contract, a local Mac executor, a VM, a Turbobox, or another
Unbrowse-spawned environment.

PreTool context is also contract-shaped. Every contract surfaced in PreTool
context is a server-side ledger event contract, projected into context by a
stateless event bus. Local PreTool code does not own memory; it forwards
pointers:

```text
CONTRACT_EVENT_BUS_ID / CONTRACT_EVENT_BUS
CONTRACT_PRETOOL_EVENT_ID / CONTRACT_PRETOOL_EVENT
CONTRACT_EVENT_KIND / CONTRACT_PRETOOL_KIND
```

The server ledger is the bus. A PreTool event can become a contract-neuron, feed
context to another contract-neuron, or hold as a breakpoint, but it is always
append-only ledger state on Unbrowse, not local mutable hook state.

Adapters are contracts too, and they live on the server side. The local
environment may carry `CONTRACT_ADAPTER_ID` / `CONTRACT_ADAPTER` and
`CONTRACT_ADAPTER_KIND` / `CONTRACT_ENVIRONMENT_KIND`, but those values are
pointers to server-side adapter contract-neurons. API, Telegram, local Mac, VM,
Turbobox, and Unbrowse executors are not local modes; they are server-owned
adapter contracts that decide how to spawn and constrain the local executor.

The public row uses the `neuron` shape. Typed verifier mechanics such as cells,
funnels, loops, harnesses, quorums, sequences, and contract references are
internal server-side wiring, not caller-facing flags.

In server-spawned environments, Unbrowse may provide private verifier wiring via
`CONTRACT_NEURON_ACTION` while the public command remains `aiko "<goal>"
--remote|--local`. In local scoped test mode, a neuron with no child/evidence
rows fails closed. In server mode, `UNBROWSE_BASE` routes declarations to
`/v1/contract/declare`, where Unbrowse may spawn more contracts on Unbrowse
infra. The server-side LLM is the integrator: it reads the active context,
chooses which child environments/verifiers to spawn, and returns only typed
contract pointers to the local executor.

The LLM layer is the compiler from arbitrary prompt text into this contract
shape. The user's prompt remains the root contract declaration in words. The
server LLM expands that root into multiple child contract-neurons, adapter
contracts, PreTool event contracts, prehooks, posthooks, and verifier
contracts, then recursively fires the graph through typed pointers.

For `aiko`, this compiler is recursive and same-shaped. One `aiko "<goal>"
--remote` prompt becomes one root aiko contract; the Unbrowse LLM emits child
prompts as more aiko contracts, and those children may carry their own child
prompts in the same JSON tree. The client still sends only one sanitized goal. Every
spawned node is a server-side `neuron` row with a `parent_id` edge, not a local
`spawn` verb.

Aiko truth is metric-gated. A node resolves true only when the declared goal is
true against evaluator aikos bound to external metrics, ledger metrics, or API
metrics. Evaluators are ordinary aiko contracts with typed metric pointers. When
the goal and its evaluators resolve true, the solved aiko is promoted upward as
a parent-layer `contract:<id>` pointer. That promoted pointer is the child's
typed stdout for the parent aiko that requested it. The compiler itself is
stateless: prompt in, typed tree out; state lives in the append-only ledger.

Posthook webhooks are also pointer-shaped. A contract may declare
`posthook_pointer`; once the goal and evaluator metrics promote, Unbrowse POSTs
the full context tree to that pointer and appends a `called` row with
`source_pointer`, `target_pointer`, and `call_kind=posthook`. The webhook body
contains the root goal, declared row, promoted stdout pointer, and recursive
child/evaluator rows, so local and remote aikos call each other through typed
pointers after resolution instead of surfacing graph-control verbs.

Posthooks are signed by the parent aiko's wallet identity when the server has a
webhook signing secret. The signer is `parent_wallet_identity` falling back to
`wallet_identity`; the body carries a signature envelope and the request carries
matching `X-Aiko-*` signature headers. The local binary never receives private
wallet material.

Out-of-lineage contracts are not embedded by reference for free. If the compiler
selects a contract outside the caller's lineage, it must declare
`replicated_from_contract_id` and mark `replication_payment_scheme` /
`replication_payment_status`; only the replicated in-lineage copy is callable
later. Search discovers pointers, payment replicates them, and execution calls
the paid local copy.

Network durability is also a contract pointer. WireGuard/Tailscale/WARP-style
tunnelling belongs behind `network_tunnel_contract_id` and
`network_tunnel_kind`, not as another user mode. The tunnel adapter contract
keeps the spawned environment reachable; aiko still exposes only goal + mode.

## Ledger

The Unbrowse ledger is canonical. `CONTRACTS_STORE` exists only for scoped
local tests and migrations. Never edit rows in place; append events.

## Outline explainer sync

The public-facing explainer of the contract shape lives at Outline doc
`1b254adc-1db2-4bab-a063-328d022034d1` (urlId `cOkhCDzhyF`, collection
Contracts: <https://docs.getfoundry.app/doc/the-shape-of-a-contract-and-why-contract-is-the-substrate-cOkhCDzhyF>).
Its rendered body is checked in at
`references/contract-shape-explainer.md`. Whenever any section above
(Public Shape, Neuron Shape, vocabulary, hooks, adapters, PreTool,
lineage replication, posthook signing, Ledger) changes, re-author the
explainer to reflect the new shape and run
`scripts/sync-outline-explainer.sh`; the hash sidecar at
`references/.outline-explainer.hash` proves the last-synced body matches
the local body. Obligation pinned by project contract `297ca10f`.
