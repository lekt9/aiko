# Aiko — Development Guide

Aiko is the Contract-native agent. One repo, one binary. Every tool call
crosses `neuron.fire/v2`: typed validate → commit → dispatch → settle. The
Contract substrate (`libcontract.dylib`, ABI v12) is the durable interpreter.
Sibling repos (`contract`, `neuron`) are independent build artifacts pulled
from the Gitea package registry on install — not separate agents.

## The single primitive

```ts
type Neuron<S, C extends Caps, R> = (
  stimulus: Stimulus<S>,
  caps: C
) => Decision<R>
```

Every computational unit — tool wrapper, LLM call, verifier, human gate,
router, cache — is an inhabitant of this one type. The three traditional layers
(harness, loop, graph) are emergent projections of composing neurons.

## Key crates

| Crate | Role |
|-------|------|
| `xai-grok-pager-bin` | Composition root for the `aiko` binary |
| `xai-grok-pager` | TUI, prompts, modals, rendering |
| `xai-grok-shell` | Agent runtime, Contract-native turn bridge |
| `xai-grok-tools` | Terminal, file, search, and other tools |
| `xai-grok-shell/src/contract_native/` | Neuron bridge (ABI 12), skill registry, membrane |
| `xai-grok-mcp` | MCP client |
| `xai-aiko-collective` | Peer mesh store, libp2p transport |

## Development

```sh
# Build aiko + contract dylib + SDK package
scripts/contract-runtime.sh build-aiko

# Just the aiko binary (no contract rebuild)
cargo run -p xai-grok-pager-bin

# Full package (distributable)
scripts/contract-runtime.sh package

# Install to ~/bin/aiko + ~/.aiko/
scripts/contract-runtime.sh install
```

## Neuron/Contract Architecture Patterns

The single primitive of the Aiko stack is the typed Neuron. One Neuron fires,
one Decision commits. That is the whole runtime. Every traditional software
pattern reduces to composed neurons calling each other through typed stimuli
and declared effects — with the Contract substrate validating, committing,
caching, and training muscle memory on every firing.

### Perpetual self-calling

Neurons do not need an external scheduler. They call each other through
declared effects (`write`, `send`, `spawn`). A neuron writes an artifact; the
next neuron reads it as stimulus. A neuron sends a message; the topology
routes it to the receptor. A neuron spawns a child; the child fires, writes
its result, and the parent continues. This is **perpetual hook chaining** —
each firing is a hook that triggers the next, with the Contract substrate as
the event loop.

```
firing 1: write artifact A → firing 2: reads A, sends msg B → firing 3: receives
B, spawns child C → child C: writes result D → firing 4: reads D, terminates
```

No cron. No while-loop. No polling. Each effect is the trigger for the next
firing.

### Pattern map — traditional → neuron/contract

| Traditional Pattern | Traditional Implementation | Neuron/Contract Equivalent | Why Better |
|---|---|---|---|
| **Queue** | Redis/RabbitMQ/SQS | `send` effect → topology routes to receptor neuron | Typed, auditable, replay-safe. No lost messages (CAS journal). No dead-letter custom code (outbox-drainer limb). |
| **Cache** | Redis/Memcached | `preemptor` limb + content-addressed firing digest | Automatic. No TTL tuning. Invalidation is a reactive trigger, not a cron sweep. Cache key = SHA-256(neuron + stimulus + reads + caps). |
| **Router** | nginx/Envoy/API Gateway | `dispatch-router` limb + energy router | Routes by structural energy, not static rules. Lowest-energy limb wins. Learns from outcomes — routes improve automatically. |
| **Database** | PostgreSQL/MySQL | Contract substrate (append-only artifact log + CAS) | No migrations. No ORM. Every write is a typed, versioned artifact. Reads are content-addressed. Replay restores entire state from journal. |
| **Event Bus** | Kafka/NATS | `reactive triggers` — `when:schema:written` → dependent fires | Typed schemas, not byte blobs. Content-addressed, not offset-addressed. Replay = re-read the artifact log. No consumer groups — topology routes to receptor neurons. |
| **Workflow Engine** | Temporal/Cadence/Airflow | `meta-agent` composition + `pipeline` limb | Workflows are neuron graphs, not scripts. Each step is a typed firing. Retry = reactive trigger on `timed_out`. Branch = `Decision.control.branch`. |
| **Cron Scheduler** | systemd timer/crontab | `scheduler` limb + lease-based claims | Kill-9 safe. Lease prevents duplicate ticks. Deadline enforced by the substrate, not the script. Failed ticks → recovery neuron re-routes. |
| **Auth/Middleware** | JWT check + middleware chain | `middleware` cage + `tailnet` peer ceilings | Capabilities, not tokens. `Caps` are typed grants (write_prefix, max_effects, max_depth). Deny-by-default. Cage constrains every effect before commit. |
| **Retry/Dead-Letter** | Custom retry logic in every service | `outbox-drainer` limb | One limb handles all retries. Typed failure classes determine policy. Dead-letter is an artifact, not a separate queue. |
| **Rate Limiter** | Token bucket / sliding window | `middleware` cage budget (`max_effects`, `max_writes`) | Per-neuron, per-stimulus. Enforced at commit time. Violations are typed rejections. |
| **Load Balancer** | HAProxy/AWS ALB | `dispatch-router` + `energy-router` | Routes to lowest-energy (most grounded, cheapest) candidate. Not round-robin. Learns which candidate handles which receptor best. |
| **Search Index** | Elasticsearch/Algolia | `memory-indexer` limb | 256-dim feature-hash embeddings over artifact bytes. Cosine similarity, not BM25. Index is an artifact — versioned, content-addressed, replayable. |
| **Garbage Collector** | Mark-and-sweep / reference counting | `retention GC` limb | Roots = active sessions, cron jobs, admitted limbs. Scans artifact references. Deterministic collection output. |
| **Service Mesh** | Istio/Linkerd | `tailnet` peer ceilings + `mesh` trust | Ed25519 identity. Signed delegations. Peer ceilings attenuate incoming caps. No sidecar — the topology IS the mesh. |
| **Observability** | Datadog/Grafana/Prometheus | `telemetry` projection + `observability` limb | Every firing writes its decision digest. Telemetry is a projection, not a separate pipeline. Energy scores track per-neuron cost. |
| **CI/CD Pipeline** | GitHub Actions/Jenkins | `pipeline` limb + reactive trigger chain | Each stage is a neuron. Items proceed independently with in-flight budget. Cache invalidation triggers re-execution. |
| **Feature Flags** | LaunchDarkly/Split.io | `reflex` ladder (hold/prepare/fire) | Not a boolean — a three-level policy. `hold` = never fire. `prepare` = model decides. `fire` = grounded, authorized, auto-fire. |

### The perpetual hook chain — neurons calling neurons forever

```
                   ┌──────────────────────────────────────┐
                   │         Contract Substrate            │
                   │  ┌────────────────────────────────┐  │
  stimulus ────────▶│  │ validate → commit → dispatch   │  │
                   │  │    ↓                             │  │
                   │  │  settle                          │  │
                   │  │    ↓                             │  │
                   │  │  train (EBM + JEPA)              │  │
                   │  │    ↓                             │  │
                   │  │  emit firing-settled event       │  │
                   │  └──────────────┬─────────────────┘  │
                   │                 │                     │
                   │  ┌──────────────▼─────────────────┐  │
                   │  │ reactive triggers:              │  │
                   │  │  when:schema:X/written → fire Y  │  │
                   │  │  when:firing-settled → count +   │  │
                   │  │    trigger introspection at N    │  │
                   │  └──────────────┬─────────────────┘  │
                   │                 │                     │
                   │  ┌──────────────▼─────────────────┐  │
                   │  │ topology: route stimulus → limb  │  │
                   │  │  edge(source, dest, predicate)   │  │
                   │  └──────────────┬─────────────────┘  │
                   │                 │                     │
                   │  ┌──────────────▼─────────────────┐  │
                   │  │ next firing: neuron receives     │  │
                   │  │ stimulus, fires, commits,        │  │
                   │  │ settles, trains, emits event     │  │
                   │  │ → loop back to top               │  │
                   │  └────────────────────────────────┘  │
                   └──────────────────────────────────────┘
```

This is not a while-loop. Each firing IS a tick of the loop. The loop ends when
a neuron returns `terminate` and no reactive trigger fires a successor. The loop
runs forever because each effect — write, send, spawn — can become the stimulus
for the next firing.

### When to use a neuron vs. traditional code

| Situation | Neuron | Traditional |
|---|---|---|
| One-shot utility script | Overkill | ✅ |
| Stateful service with audit trail | ✅ — journal IS the audit trail | Complex |
| High-throughput API (>10k/s) | Current bottleneck — membrane is per-firing | ✅ |
| Multi-step workflow with retries | ✅ — pipeline limb, reactive triggers | Complex |
| Search over structured data | ✅ — memory-indexer limb | ✅ but needs separate index |
| Simple data transform | Overkill | ✅ |
| Any task where you need to prove what happened | ✅ — every firing is cryptographically recorded | Needs external audit |
| Long-running background task | ✅ — scheduler limb, lease-based | Needs cron + locking |
