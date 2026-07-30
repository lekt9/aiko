# Neuron Agent Entrypoint and Universal Interface Plan

Status: implementation plan; Phase 1 (standalone agent bootstrap) and Phase 2
(local universal interface membrane) are implemented and witnessed by
`bash tests/agent-entrypoint-gate.sh` and `bash tests/universal-interface-gate.sh`
as of 2026-07-29; commands and schemas marked **target** in later phases do not
exist yet  
Version: 0.3  
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
(Phase 1) and `neuron interface discover|describe|test|admit|attach|detach|
revoke|call|dispatch|list` (Phase 2). `neuron agent run` takes `--goal`,
`--budget`, and `--acceptance <predicate.json>`; the predicate is required when
an attached worker interface declares itself non-deterministic, since such a
product cannot be verified by repetition. `neuron agent expose` remains target.
The existing `neuron run`, `neuron limb ...`, `neuron mcp`, and `neuron node
...` commands are implementation material to reuse, not parallel paths to
retain indefinitely.

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

### Phase 2 — Local universal interfaces — **implemented 2026-07-29**

- `InterfaceManifest` as `neuron.interface-manifest/v1`, parsed and fully
  validated in `src/membrane.zig`. ✓
- Pure-function, process, and filesystem adapters. ✓ The pure-function kind is
  a total op pipeline whose canonical text *is* the pinned code digest;
  process is a bounded argv/stdin/stdout/exit boundary with an enforced
  deadline and output ceiling; filesystem is a path-confined store with
  content-addressed writes.
- `neuron interface discover|describe|test|admit|attach|detach|revoke|call|
  dispatch|list`, in `src/membrane_ops.zig`. ✓ Discovery and description write
  nothing; admission re-pins the implementation and re-runs the adversarial
  battery itself rather than trusting a prior `interface test`.
- Read/command classification enforced structurally: `invokeRead` refuses a
  command manifest, so relabelling a mutation cannot bypass the outbox. ✓
- Attachment derives a least-authority grant (`agents/<id>/work/`, no spawn,
  budgets clamped to the interface ceiling) instead of adopting the one the
  manifest asked for. ✓
- The agent's work slot routes through an attached `worker` interface, and a
  judged product crosses an attached `effector` boundary through the outbox
  before the snapshot advances. ✓ `neuron agent run --acceptance` supplies the
  explicit predicate a non-deterministic boundary requires.

Witness — implemented as `bash tests/universal-interface-gate.sh`: a pure
function, an admitted test binary, and a local store are described, tested,
admitted, and used through one membrane; an untyped binary, argv injection, a
locator/argv0 mismatch, capability widening, a mislabelled kind, a missed
deadline, a path traversal, a symlink escape, and digest drift are each
rejected with zero commits; a command commits to the outbox before it crosses,
is reconciled by independent read-back, and does not duplicate on retry; a real
agent goal is performed by a real boundary and independently reproduced before
settlement; revocation and detachment stop new calls while the audit survives
compaction.

Not in this phase, and still open: library/WASM and database adapters, and
process *commands*. A process mutation has no independent local sensor to
reconcile against, so `mode: "command"` is admitted for the filesystem kind
only and fails closed as `UnverifiableCommand` elsewhere until Phase 3 brings
real sensors. Multi-hop chaining of several boundaries within one goal is
Phase 3; the Phase 2 agent has one `worker` and one `effector` slot. The
existing script/limb path is not yet unified under `InterfaceManifest` — both
membranes admit by digest and run through the same valve, but a limb package is
still described by `typed-neuron.limb-manifest/v1`.

### Phase 3 — Protocol and remote interfaces

- Add HTTP request/response, streaming HTTP, MCP, queue/webhook, and
  `neuron.wire/v1` adapters.
- Normalize OpenAPI/JSON Schema, MCP tool schemas, and explicit custom
  manifests into the same interface record.
- Preserve remote idempotency, causation, classification, and reconciliation.

Witness: one goal chains local code → process → HTTP → MCP → verifier; a
duplicate request does not duplicate effects and a poisoned response fails
closed.

### Phase 4 — Models, devices, and humans — **implemented 2026-07-30**

- Model adapters become ordinary interface capabilities with exact provider,
  model, tokenizer/protocol, cost, and nondeterministic-input provenance.
- Device adapters declare sensor versus actuator operations and safety gates.
- Human interfaces use typed approval/review/annotation schemas.

Witness: swap two compatible model providers without topology changes; require
human approval before a simulated actuator; prove model output and human input
remain untrusted evidence until validation.

Implemented as three kinds on the existing membrane, so no new transport was
invented: `model` pins its *contract* like `http` — with provider, model,
protocol, and cost inside the pin, which is what makes a provider swap a
different admitted interface rather than a silent substitution; `device` splits
`sensor` (read) from `actuator` (content-addressed command with an independent
state read-back); `human` is a typed decision document read out of an inbox.

Two properties are structural rather than advisory:

- **Nondeterminism cannot be disclaimed.** `Kind.nondeterministic()` covers
  model and human, and a manifest claiming `deterministic` is refused with
  `InterfaceNondeterminismClaim` — because verification-by-second-invocation,
  the settlement every deterministic boundary relies on, is unavailable to a
  boundary that samples. Their answers settle only against the caller's
  acceptance predicate, and the manifest records that in `settlement`.
- **An actuator cannot move without a human.** The gate is enforced on the
  dispatch path *before* the boundary is crossed. A missing decision parks as
  `InterfaceApprovalMissing` (retryable — a human may still answer), a refusal
  is `InterfaceApprovalDenied` (permanent), a decision naming different bytes
  is `InterfaceApprovalMalformed`, and a gate that is not a human approval
  boundary is `InterfaceSafetyGateMissing`. Silence is never consent.

Witness: `bash tests/model-device-human-interface-gate.sh` (mutation-proven —
disabling the dispatch-path approval check turns the gate red).

### Phase 5 — Optional economic adapters — **implemented 2026-07-30**

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

Economics is a *profile*, not a kind: `economics: none | x402` sits on an
ordinary `http` or `model` manifest and defaults to `none`, so an omitted
profile can never authorize spending. The order of the paid flow is the whole
safety property — **challenge → decode → govern → approve → sign → retry** —
and every refusal happens before the adapter is reached, so an over-budget or
unapproved call provably cannot have signed anything.

- **The core never signs.** `governSpend` is a pure decision over declared
  numbers that performs no I/O; the signature comes from an admitted adapter
  invoked through the ordinary read path (plan §10, "keys never enter Neuron
  data"). Refusals are typed: `InterfacePaymentUnaffordable`,
  `InterfacePaymentUnacceptable`, `InterfacePaymentUnapproved`,
  `InterfacePaymentQuoteInvalid`, `InterfacePaymentProfileIncomplete`.
- **The policy is the operator's, never the resource's.** It lives at
  `interfaces/policy/spending` as a durable node artifact installed by
  `neuron interface policy`, so the boundary being paid cannot state what it
  may charge. Cumulative spend is recomputed from the durable payment receipts
  rather than held in a counter, so a restart cannot reset a budget.
- **Idempotency is a stored proof, not a flag.** A repeated call finds the
  prior payment receipt and re-presents the same payload instead of buying a
  second quote — one receipt, one signature, one charge at the far end.
- **Payment ≠ correctness.** The payment receipt is committed in its own firing,
  separate from the resource result, and a rejected proof
  (`InterfacePaymentProofRejected`) is a distinct condition from a challenge.
- A 402 answer to an unpaid admission probe is recorded as `payment-challenged`
  and passes: admission must never require paying.

Witness: `bash tests/paid-interface-gate.sh` (mutation-proven — disabling the
governor's asset check makes it pay for a disallowed asset and turns the gate
red).

### Phase 6 — Automatic interface morphogenesis — **implemented 2026-07-30**

- Registry Neurons consume typed CapabilityGaps and PatternRecords.
- Search admitted interfaces before external discovery.
- Generate complete adapter Skills when reuse fails.
- Independently test/admit/attach, retry the original goal, and retire failures.
- Learn rankings only from verified results.

Witness: begin with no compatible adapter, discover a test interface, generate
and admit its adapter, attach it without restart, resolve the original goal,
reuse it on the second goal, then revoke/detach it and preserve audit.

Implemented in `src/morphogenesis.zig` behind
`neuron interface resolve-gap <node_dir> <agent> --gap <gap.json>`. A typed
`neuron.capability-gap/v1` goes in; an admitted, attached, and *verified* edge
comes out — or nothing does.

**"Generate" means deriving a complete, inert adapter manifest for a discovered
boundary, not synthesizing code.** A synthesized implementation could not be
pinned to bytes that existed before the pin, which is the property every
admission depends on. How a boundary takes its input is part of its contract and
cannot be read off its name (§9 forbids inventing schemas from names), so it is
established by **bounded experiment**: each admissible input shape is drafted as
an inert artifact, and the one kept is the one that both passes the contract +
adversarial battery and actually satisfies the gap.

Three refusals are structural:

- **Reuse is searched before discovery**, ranked by accumulated verified
  successes, so a boundary that has actually worked is preferred over one that
  merely type-matches. Generating an adapter for a capability the node already
  holds is a defect, not an optimization.
- **Nothing is retained on compilation alone.** A candidate that admits and
  attaches but fails the gap on the real path is revoked and detached
  (`GeneratedAdapterRetired`). Admission is not success.
- **Rankings are learned only from verified results.** A `PatternRecord` is
  written *after* the real-path retry succeeds, never before, so a boundary that
  never worked cannot train the ranking. A gap with no acceptance is
  unfalsifiable and is refused (`InvalidCapabilityGap`) rather than trivially
  resolved.

The generated edge never inherits the generator's authority: `attachCore`
computes the grant, scoped to `agents/<agent>/work/` with no spawn and — for a
`worker`, which is a capability read — no send.

Witness: `bash tests/interface-morphogenesis-gate.sh` (mutation-proven in two
directions — disabling the reuse search, and skipping the real-path judgement,
each turn the gate red; the second makes a regressing boundary be retained and
reported `verified: true`, which is exactly the failure §9 forbids).

### Phase 7 — Multi-machine interface swarm — **implemented 2026-07-30**

- Advertise admitted interface digests through NodeClaims.
- Negotiate EdgeContracts under per-peer Caps.
- Route across machines using hard eligibility before evidence/energy/cost.
- Reconcile topology and artifacts explicitly after partitions.

Witness: two installed nodes expose different interface kinds, construct one
cross-machine agent chain, survive one node restart, reject a widened edge,
expire a lease, reconcile, and settle without a global-memory claim.

Implemented in `src/swarm.zig` (types and the pure eligibility decision) and
`src/swarm_ops.zig` (`neuron swarm negotiate|route|reconcile|revoke`), over the
existing framed `neuron.wire/v1` federation rather than a second protocol. Two
read refs were added to the node: `mesh/claims` and `mesh/interface-call`.

Serving them required one wire change: a response may now carry a `reply`. It is
additive — a ref that commits and returns nothing answers with the unchanged
commit summary, so `swarm-package-gate.sh`'s exact-equality assertion still
holds. Only capability **reads** are advertised across a machine boundary: a
peer edge does not confer this node's outbox.

Three properties are structural:

- **Hard eligibility is a gate, not a ranking.** `eligible` checks membership in
  the peer's *live* claim, the lease, and the caps. An ineligible peer is
  excluded outright — energy and cost may only reorder what already passed.
- **A widened edge is refused, never clamped.** Silent narrowing would leave a
  caller believing it holds authority it does not. The peer's declared ceiling
  is consulted independently of the local one.
- **No global memory.** A contract records what this node *observed* of a peer;
  every route re-reads the claim, so an interface the peer retires stops being
  routable without this node being told. A partition is recorded as a state
  (`ConnectionRefused`) rather than assumed away, and an expired lease is a
  distinct status from an unreachable peer. The peer's reported output digest
  becomes evidence only by agreeing with one recomputed locally over the bytes
  actually received.

The lease is counted in **uses**, not wall time: a node partitioned for an hour
has spent nothing, and a clock it does not control should not be able to extend
or shorten its authority.

Witness: `bash tests/multi-machine-agent-gate.sh` (mutation-proven — disabling
lease expiry, and allowing widened per-peer caps, each turn the gate red).

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
bash tests/universal-interface-gate.sh # implemented (Phase 2)
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
