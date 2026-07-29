# Neuron Agent Entrypoint and Universal Interface Plan

Status: implementation plan; Phase 1 (standalone agent bootstrap) is implemented and
witnessed by `bash tests/agent-entrypoint-gate.sh` as of 2026-07-29; commands and
schemas marked **target** in later phases do not exist yet  
Version: 0.2  
Date: 2026-07-29  
Scope: standalone Neuron package, optional Contract durability, optional Aiko host

## 1. Decision

The canonical portable agent entrypoint belongs to **Neuron**:

```text
neuron
├── node        machine identity, substrate, transport, installed adapters
├── agent       admitted topology, active snapshot, goals, settlement
├── interface   discovery, description, testing, admission, attachment
└── limb        packaged Neuron capabilities
```

Aiko remains an optional host for channels, user experience, model providers,
and tool adapters. Contract remains the production durable interpreter and
outbox. Neither owns the portable agent definition.

```text
any caller ───────────────────────────────────────────────┐
Aiko / CLI / HTTP / MCP / another Neuron ───────────────┤
                                                        ▼
                                               Neuron agent interface
                                                        │
                              ┌─────────────────────────┴──────────────┐
                              ▼                                        ▼
                    standalone Runtime                    production Contract
                              │                                        │
                              └──────── admitted interface limbs ──────┘
```

The architecture is **anything-first**, not API-first, binary-first, or
LLM-first. Anything with an observable or callable boundary can be wrapped by
the standard Neuron contract.

## 2. Universal Rule

For every external thing:

```text
DISCOVER
  find a function, library, binary, service, protocol, stream, store,
  device, human, model, peer, or other callable/observable boundary
    ↓
DESCRIBE
  pin identity/version and declare typed inputs, outputs, errors,
  effects, classifications, idempotency, streaming, cost, and Caps
    ↓
ADAPT
  reuse or generate a deterministic Neuron adapter
    ↓
TEST
  run contract, adversarial, timeout, budget, and side-effect tests
    ↓
ADMIT
  admit the exact interface + implementation + adapter digest
    ↓
ATTACH
  connect compatible schemas through a typed topology edge
    ↓
OPERATE
  call it only through recorded Caps or a committed outbox effect
    ↓
JUDGE
  verify real outputs and external consequences independently
    ↓
REUSE OR RETIRE
  rank from receipts, revoke/detach failures, preserve audit
```

The wrapped thing does not have to be rewritten as a Neuron. The **adapter**
implements the Neuron boundary. Discovery is a read and grants no authority.
Generated adapters are inert source until independently admitted.

## 3. What May Be Wired

| Interface kind | Examples | Adapter boundary |
|---|---|---|
| Pure code | function, module, library symbol, WASM component | typed call/return with pinned code digest |
| Native code | dynamic library, FFI/ABI function | isolated ABI adapter with memory and crash boundary |
| Process | executable, shell command, compiler, media tool | bounded argv/stdin/stdout/stderr/exit schema |
| Filesystem | file, directory, watcher, content store | path-scoped read/write/watch Caps |
| Database | SQL, key-value store, vector index, event store | query/command schemas and transaction policy |
| Network API | HTTP, REST, GraphQL, RPC, SOAP | request/response/error schema and egress Cap |
| Streaming API | SSE, WebSocket, gRPC stream, token stream | inert deltas plus typed completion/cancellation |
| Agent protocol | MCP, A2A, Neuron wire, custom protocol | protocol codec and capability projection |
| Messaging | queue, webhook, pub/sub, email, event bus | durable delivery, partition, ack, retry, DLQ |
| Model | local model, hosted LLM, embedding/reranker | model Cap with provider/version/cost provenance |
| Device | serial port, camera, microphone, robot, IoT sensor | device-specific sensor/actuator schemas and safety gate |
| Human | approval, review, annotation, escalation | human-gate stimulus and signed/attributed response |
| Remote Neuron | machine node, agent, limb, paid service | `neuron.wire/v1` or typed protocol bridge |
| Paid resource | ordinary paid API, x402 endpoint, invoice-based service | normal adapter plus an independent payment policy |

This table is extensible without changing the Neuron primitive. A new interface
kind adds a decoder/adapter limb and conformance cases, not a new execution
unit.

## 4. Canonical Interface Manifest

**Target schema:**

```ts
type InterfaceManifest = {
  schema: "neuron.interface-manifest/v1"
  id: InterfaceId
  version: string
  implementationDigest: Digest
  adapterDigest: Digest
  kind:
    | "function"
    | "library"
    | "process"
    | "filesystem"
    | "database"
    | "http"
    | "rpc"
    | "stream"
    | "mcp"
    | "queue"
    | "model"
    | "device"
    | "human"
    | "neuron"
    | "custom"

  locator: OpaqueLocator
  accepts: readonly SchemaRef[]
  emits: readonly SchemaRef[]
  errors: readonly SchemaRef[]

  invocation: {
    mode: "read" | "command" | "duplex"
    streaming: boolean
    deterministic: boolean
    idempotency: "intrinsic" | "keyed" | "none"
    timeoutMs: number
    concurrency: number
  }

  requestedCaps: CapabilityProposal
  dataFlow: {
    inputClasses: readonly DataClass[]
    outputClasses: readonly DataClass[]
    declassificationGate?: NeuronRef
  }

  economics?: {
    profile: "none" | "x402" | "quote" | "subscription" | "custom"
    currency?: string
    quoteSchema?: SchemaRef
    receiptSchema?: SchemaRef
    policyRef: ArtifactRef
  }

  evidenceRequirements: readonly EvidenceRequirement[]
  settlement: PredicateRef
  provenance: ProvenanceRef
}
```

`locator` is interpreted only by the admitted adapter. It is never ambient
authority. A path, URL, symbol, device name, model name, or peer address in a
manifest remains inert unless current Caps allow that exact operation.

## 5. One Membrane, Two Invocation Classes

Every interface operation is classified before attachment:

### 5.1 Capability read

A read observes without causing an externally meaningful mutation:

```text
Neuron fires
  → invokes a narrow capability read
  → adapter records request, provider/version, result digest, time, cost
  → result becomes firing provenance
  → Neuron returns a Decision
```

Examples: pure function, database query, file read, sensor reading, model
completion, HTTP GET only when the endpoint is contractually non-mutating.

### 5.2 Consequential command

A command may mutate external state:

```text
Neuron fires
  → returns a declarative tool/interface effect
  → harness validates and commits an outbox record
  → adapter dispatches with an idempotency identity
  → acknowledgement/sensor result returns
  → reconciliation or independent verification settles it
```

Examples: file write, database mutation, POST with effects, email, payment,
device actuation, deployment, purchase, or destructive binary invocation.

An interface declaration cannot relabel a real command as a read to bypass the
outbox. Unknown or mixed behavior defaults to `command`.

## 6. Target CLI

The node daemon owns transport and can host multiple logical agents. There is
one server, not a separate competing server per agent.

```sh
# Machine
neuron node init <node_dir>
neuron node serve <node_dir>

# Logical agent
neuron agent init <node_dir> <agent_id> \
  --profile reference/default
neuron agent inspect <node_dir> <agent_id> --json
neuron agent run <node_dir> <agent_id> \
  --goal "..." \
  --acceptance <predicate.json> \
  --json
neuron agent cancel <node_dir> <agent_id> <workflow_id>
neuron agent retire <node_dir> <agent_id>

# Anything adapter
neuron interface discover <target> --kind auto --json
neuron interface describe <target> --output interface.json
neuron interface test interface.json --sandbox
neuron interface admit <node_dir> interface.json
neuron interface attach <node_dir> <agent_id> \
  --interface <digest> \
  --edge <edge.json>
neuron interface detach <node_dir> <agent_id> --interface <digest>

# Expose the same agent through the node
neuron agent expose <node_dir> <agent_id> \
  --receptor goal/v1 \
  --transport neuron-wire,http,mcp
```

Implemented as of 2026-07-29: `neuron agent init|run|inspect|cancel|retire`
(Phase 1; `neuron agent run` currently takes `--goal` plus `--budget` with the
acceptance predicate fixed to the deterministic reference verifier, and
`expose` remains target). Every `neuron interface ...` verb parses and fails
closed as NotImplemented. The existing `neuron run`, `neuron limb ...`,
`neuron mcp`, and `neuron node ...` commands are implementation material to
reuse, not parallel paths to retain indefinitely.

## 7. Agent Execution

`neuron agent run` must:

1. open the node substrate;
2. resolve the admitted agent manifest and exact active snapshot;
3. normalize the goal into a typed receptor stimulus;
4. require an explicit acceptance predicate and aggregate budget;
5. reconstruct context only from permitted artifact refs;
6. query the Pattern Registry and admitted Interface Registry;
7. plan and hard-filter eligible interface limbs;
8. route work through the bounded event pump;
9. invoke reads through Caps and commands through committed outbox effects;
10. independently verify results;
11. CAS a new agent snapshot;
12. settle with result, rejection, cancellation, timeout, or exhausted budget;
13. return a typed result plus evidence/audit refs.

The fixed `meta-agent-check` witness becomes a seed profile for this general
path; it must stop being the only way to exercise the composed agent.

## 8. Universal Chaining

Once wrapped, interface kinds disappear from topology:

```text
goal
  → planner Neuron
  → local library adapter
  → binary adapter
  → HTTP API adapter
  → model adapter
  → database command adapter
  → human gate
  → independent verifier
  → settlement
```

Every hop is still:

```text
typed input
  + exact interface/adaptor identity
  + scoped Caps
  + deadline/cost/depth budget
  → typed result or typed failure
  + provenance
```

Chains may be sequential, parallel, branched, joined, recurrent, local, or
cross-machine. They must preserve causation, idempotency, classification, and
aggregate budgets. Cycles require a progress measure. A remote response is
untrusted input until decoded and verified.

## 9. Governed Self-Building

The agent may construct its own interface network:

```text
CapabilityGap
  → search admitted InterfaceManifests by schema compatibility
  → inspect local machine and authorized registries
  → discover candidate code/binary/service/device/model/human boundary
  → derive explicit interface schema
  → reuse or generate adapter Skill as inert artifacts
  → run contract + adversarial tests
  → independently admit exact implementation + adapter digests
  → attach least-authority edge
  → retry original goal on the real path
  → judge outcome
  → retain, rerank, quarantine, or retire
```

“Self-building” therefore means self-describing, self-generating,
self-testing, and self-proposing under an admission boundary. It never means:

- self-authorizing;
- executing discovered code before admission;
- inheriting the generator’s Caps;
- inventing schemas solely from names;
- placing secrets in generated source or prompts;
- silently paying;
- hiding work in untyped shell/API side channels;
- claiming a successful interface from compilation alone.

## 10. APIs and Payment Profiles

An API is one interface kind. It may be free, authenticated, metered, prepaid,
subscription-based, invoice-based, or paid per request. Payment is orthogonal
to invocation:

```text
HTTP InterfaceManifest
  invocation: request/response schemas
  authentication: capability-held credential adapter
  economics:
    none | x402 | quote | subscription | custom
```

An ordinary LLM HTTP API uses the same model/interface adapter even when it has
no x402 support. An x402 endpoint uses the normal HTTP adapter plus an admitted
x402 payment adapter.

The current x402 protocol uses an HTTP-native challenge flow: the resource
server can return `402 Payment Required` with `PAYMENT-REQUIRED`; the client
may retry with `PAYMENT-SIGNATURE`; success can include settlement information
in `PAYMENT-RESPONSE`. The protocol is open and usable for machine clients, but
this is only an economic transport profile, not Neuron admission, identity,
Caps, or evidence. Sources:

- [x402 Foundation specification and SDK repository](https://github.com/x402-foundation/x402)
- [Coinbase: How x402 Works](https://docs.cdp.coinbase.com/x402/core-concepts/how-it-works)
- [Coinbase x402 FAQ: agents, headers, idempotency, and extensions](https://docs.cdp.coinbase.com/x402/support/faq)
- [Coinbase MCP + x402 integration](https://docs.cdp.coinbase.com/x402/mcp-server)

Target paid-call flow:

```text
ordinary typed interface request
  → 402 challenge
  → decode quote as untrusted data
  → spending governor checks provider, asset, amount, cumulative budget,
    workflow purpose, expiry, idempotency, and approval threshold
  → payment adapter signs locally; keys never enter Neuron data
  → commit payment intent/outbox record
  → retry the identical request with payment proof
  → record payment response and resource result separately
  → independently judge whether the resource satisfied the work
```

Payment proves only that a payment condition was satisfied. It does not prove
the provider is safe, the output is correct, the code is admitted, or the
workflow is settled.

## 11. Security and Operational Invariants

1. There is no raw universal `execute-anything` capability.
2. Every adapter is pinned by implementation, interface, dependency, and
   adapter digest.
3. Reads and commands remain distinct; unknown behavior is a command.
4. Credentials, wallet keys, device secrets, and signing keys remain inside
   capability adapters.
5. Every call has timeout, byte, concurrency, cost, and classification limits.
6. An adapter cannot widen the caller’s Caps or delegate without explicit
   permission.
7. Streaming deltas remain inert until a complete typed result is decoded.
8. External commands use outbox/idempotency/reconciliation semantics.
9. Chains carry a cumulative budget and hop/depth limit.
10. Eligibility precedes energy, price, latency, reputation, and preference.
11. Paid calls require an independent spending policy; payment cannot be
    smuggled inside an ordinary network Cap.
12. Generated adapters have no authority before admission.
13. Interface drift invalidates attachment and cache identity.
14. Revocation stops new calls before the next adapter operation.
15. Audit and compensation survive detach and retirement.

## 12. Implementation Phases

### Phase 0 — Canonical contracts and command shape

- Add schemas for `AgentManifest`, `AgentGoal`, `AgentResult`,
  `InterfaceManifest`, `InterfaceOffer`, `InterfaceCall`,
  `InterfaceResult`, `InterfaceFailure`, and `InterfaceReceipt`.
- Decide which types belong in canonical `typed_neuron` wire and which remain
  limb schemas.
- Add CLI parsing/help for the target commands, returning
  `NotImplemented` only until each subsequent phase lands.

Witness: generated bindings remain drift-free and schema compatibility vectors
cover every new trust-boundary type.

Partial as of 2026-07-29: the agent lifecycle types exist as versioned artifact
schemas (`neuron.agent-manifest/v1`, `neuron.agent-snapshot/v1`,
`neuron.agent-active/v1`, `neuron.agent-goal/v1`, `neuron.agent-result/v1`,
`neuron.agent-verdict/v1`, `neuron.agent-context/v1`) rather than canonical
`typed_neuron` wire types — they stay substrate-local until a remote transport
needs them. The `neuron agent` and `neuron interface` command shapes are
parsed; unimplemented interface verbs fail closed as NotImplemented.

### Phase 1 — Standalone agent bootstrap — **implemented 2026-07-29**

- Implement `neuron agent init|inspect|run|cancel|retire`. ✓ (`src/agent_ops.zig`)
- Materialize the default agent seed as composed stage neurons (intake →
  worker → verifier → settler) wired through waiter predicates, with a
  grounder neuron subscribed to durable `neuron.firing-settled/v1` events
  re-grounding every committed beat into `agents/<id>/context/` artifacts. ✓
  (Packaging the seed as an admitted external Skill remains open and joins
  Phase 2's unification of script, limb, and binary paths.)
- Reconstruct state from `agents/<id>/active`. ✓ (CAS-advanced pointer)
- Drive the existing Pump to settlement from a real goal. ✓ (per-workflow
  firing namespaces make resumed workflows replay by identity)
- Work without Aiko or Contract using the standalone substrate. ✓

Witness — implemented as `bash tests/agent-entrypoint-gate.sh`: from an empty
directory, initialize an agent, solve a deterministic goal, restart,
reconstruct the same snapshot, replay without duplicate effects (byte-identical
WAL), cancel another goal, and retire the agent.

### Phase 2 — Local universal interfaces

- Unify existing script, limb, and binary paths under `InterfaceManifest`.
- Add pure-function, library/WASM, process, filesystem, and database adapters.
- Implement discovery, description, sandbox tests, admission, attachment, and
  detachment.

Witness: compose a pure function, an admitted test binary, and a local store;
reject an untyped binary, argv injection, capability widening, timeout, and
digest drift.

### Phase 3 — Protocol and remote interfaces

- Add HTTP request/response, streaming HTTP, MCP, queue/webhook, and
  `neuron.wire/v1` adapters.
- Normalize OpenAPI/JSON Schema, MCP tool schemas, and explicit custom
  manifests into the same interface record.
- Preserve remote idempotency, causation, classification, and reconciliation.

Witness: one goal chains local code → process → HTTP → MCP → verifier; a
duplicate request does not duplicate effects and a poisoned response fails
closed.

### Phase 4 — Models, devices, and humans

- Model adapters become ordinary interface capabilities with exact provider,
  model, tokenizer/protocol, cost, and nondeterministic-input provenance.
- Device adapters declare sensor versus actuator operations and safety gates.
- Human interfaces use typed approval/review/annotation schemas.

Witness: swap two compatible model providers without topology changes; require
human approval before a simulated actuator; prove model output and human input
remain untrusted evidence until validation.

### Phase 5 — Optional economic adapters

- Add economics as an optional interface profile.
- Implement quote and spending-policy schemas.
- Add x402 through an admitted adapter or sidecar; do not add wallet semantics
  to the Neuron core.
- Implement payment idempotency, receipts, cumulative budgets, approval
  thresholds, and reconciliation.

Witness: a local x402-compatible test resource produces a 402 challenge; an
under-budget call pays once and returns a typed result; retry does not repay;
over-budget and unapproved calls never sign; resource correctness is judged
separately from payment success. An optional testnet witness may supplement,
not replace, the deterministic local gate.

### Phase 6 — Automatic interface morphogenesis

- Registry Neurons consume typed CapabilityGaps and PatternRecords.
- Search admitted interfaces before external discovery.
- Generate complete adapter Skills when reuse fails.
- Independently test/admit/attach, retry the original goal, and retire failures.
- Learn rankings only from verified results.

Witness: begin with no compatible adapter, discover a test interface, generate
and admit its adapter, attach it without restart, resolve the original goal,
reuse it on the second goal, then revoke/detach it and preserve audit.

### Phase 7 — Multi-machine interface swarm

- Advertise admitted interface digests through NodeClaims.
- Negotiate EdgeContracts under per-peer Caps.
- Route across machines using hard eligibility before evidence/energy/cost.
- Reconcile topology and artifacts explicitly after partitions.

Witness: two installed nodes expose different interface kinds, construct one
cross-machine agent chain, survive one node restart, reject a widened edge,
expire a lease, reconcile, and settle without a global-memory claim.

## 13. Dependency Order

```text
Phase 0 schemas/CLI
    ↓
Phase 1 standalone agent
    ↓
Phase 2 universal local interface membrane
    ↓
Phase 3 remote protocols ───┬──▶ Phase 4 models/devices/humans
                            └──▶ Phase 5 optional economics
                                      │
                                      ▼
                         Phase 6 automatic construction
                                      │
                                      ▼
                         Phase 7 multi-machine swarm
```

Aiko integration is a consumer test after Phase 1, not a prerequisite. Contract
integration is the production durability profile after the standalone semantics
are green.

## 14. Target Runnable Gates

```sh
bash tests/agent-entrypoint-gate.sh    # implemented (Phase 1)
bash tests/universal-interface-gate.sh
bash tests/remote-interface-chain-gate.sh
bash tests/model-device-human-interface-gate.sh
bash tests/paid-interface-gate.sh
bash tests/interface-morphogenesis-gate.sh
bash tests/multi-machine-agent-gate.sh
```

Each gate must create its own temporary node and agent, exercise the public CLI,
assert typed failures, and inspect durable evidence. Source presence, help text,
mock-only Neuron registration, or calling existing test functions directly is
not completion.

## 15. Completion Definition

The plan is complete only when a fresh packaged Neuron installation can:

1. initialize a machine and a logical agent;
2. accept a typed goal through CLI, HTTP, MCP, or Neuron wire;
3. discover and use already admitted interfaces of different kinds;
4. safely generate an adapter when no interface matches;
5. compose local and remote interfaces into one bounded chain;
6. use LLMs as replaceable interfaces rather than the agent primitive;
7. optionally handle paid interfaces without embedding payment in the core;
8. independently verify external consequences;
9. restart and reconstruct from durable artifacts;
10. replay without duplicate effects or duplicate payment;
11. revoke, detach, and retire interfaces and agents;
12. run without Aiko, while allowing Aiko to connect without a bespoke agent
    implementation.

Until those witnesses exist, this document is a plan and the current production
agent host remains Aiko.
