# Dcontract Usage Analysis — One-Shot Chain & Invalidation Patterns

Analyzed from `/Users/lewis/Library/Mobile Documents/com~apple~CloudDocs/Backups/agent-harness/2026-07-11/claude/contracts.jsonl` (20,769 events across 2026-06-28 sessions).

## Core Architecture: The Recursive Neuron Tree

The dcontract substrate operates as a **recursive neuron tree** where every unit of work is a typed neuron firing. Three layers emerge:

| Layer | Pointer Type | Role |
|-------|-------------|------|
| 3 | `neuron` | Root contract — declares intent, spawns children |
| 2 | `cli`, `iterate` | Action children — interpret, verify, adjudicate, record retry |
| 1 | (terminal) | Resolved — child finished upon resolution |

## The One-Shot Chain Pattern

The agent declares ONE contract. The substrate chains automatically through these event phases:

### Phase 1: Root Fires → Holds
```
event: declared (neuron, layer 3)
event: iterated → action_result: hold
event: guard → error_class: generic → spawns recovery
```

### Phase 2: Children Declared (in parallel where independent)
```
child_added: interpret (885a9fae) → action: cli, layer 2
child_added: verify   (10d10483) → action: cli, layer 2
child_added: adjudicate (b5956d86) → action: cli, layer 2
```

### Phase 3: Children Fire Independently
```
iterated: 885a9fae → action_result: interpreted
  ebm_proto: fire:ok (energy updates)
  satisfied: "native resolver reached mechanical true"
  cache_resolved: snapshot hash stored

iterated: 10d10483 → action_result: "verified: claim well-formed"
  ebm_proto: fire:ok
  satisfied
  cache_resolved

iterated: b5956d86 → action_result: "adjudicated: interpret+verify satisfied -> promote"
  ebm_proto: fire:ok
  satisfied
  cache_resolved
```

### Phase 4: Break Above (Parent Terminates Child Iteration)
```
break_above: source_id=885a9fae → "resolved — child finished upon resolution"
break_above: source_id=10d10483
break_above: source_id=b5956d86
```

### Phase 5: Fill Iteration (Auto-Chaining)
The parent iterates, automatically filling gaps by chaining to completed children:

```
iterated (parent): "fill who:contract via contract artifact-reachable-9 (diffuse-default wave 0)"
  delta: -1.858 → energy improved (negative = better)

iterated (parent): "fill who:contract via contract 885a9fae (diffuse-default wave 0)"
  delta: -1.769

iterated (parent): "fill who:contract via contract 10d10483 (diffuse-default wave 0)"
  delta: -1.769
```

Each `fill` spawns an `iterate` child that records the retry wave:
```
child_added: iterate (366d5bf7)
  iterated: "iterate:fc38956b — fill who:contract via contract artifact-reachable-9 => iterate: recorded retry wave"
```

### Phase 6: Wave Progression
```
wave 0 → fills: artifact-reachable-9, 885a9fae, 10d10483, b5956d86
wave 1 → fills: 91499f7a, e507d275, 058dfc40, 8800e633, ...
wave 2 → hold:sabbath — two-witness/emergency checkpoint
```

## The Invalidation → Refire Pattern (EBM-Driven)

### Guard Events (Failure Detection)
When a neuron fires with `action_result: hold`, a guard event triggers:
```json
{"event": "guard", "id": "fc38956b", "error_class": "generic",
 "layer": "neuron",
 "remediation": "generic resolver fault; inspect action_result + check parent_id chain for upstream cause"}
```

The guard spawns a **recovery neuron** (`9931d194`) that:
1. Holds initially (wave 1, 2, 3 all hold)
2. Continues until external evidence resolves

### EBM Energy Routing
Every firing updates the energy-based model:
```json
{"event": "ebm_proto", "key": "fire:ok", "from_id": "885a9fae",
 "w": 1, "mean": "<base64 energy vector>", "te": 1782667087}
```

- `w`: weight (increases with successful firings)
- `mean`: energy vector (lower = better route)
- `te`: timestamp
- Key patterns: `fire:ok` (success), `fire:retryable` (needs retry), `verdict:ok` (terminal success)

The EBM learns which routes succeed fastest:
- `fire:ok` → energy decreases, weight increases → route reinforced
- `fire:retryable` → energy increases → route deprioritized
- `verdict:ok` → terminal energy update after cache resolution

### Cache Invalidation (Content-Addressed)
```json
{"event": "cache_resolved", "id": "885a9fae", "wave": 1,
 "snapshot": "329502f8fb1fa48e47743df6f917ebd7d4a2c5075b34a56a6a708d956a6977c9"}
```

- Each firing produces a content-addressed snapshot (SHA-256 of inputs + neuron + stimulus + caps)
- **Replay**: same hash → `NeuronFireStatus::Replayed` → caching hit, zero work
- **Invalidation**: changed input → new hash → cache miss → re-fire
- This is how the substrate knows to re-fire when dependencies change

### Sabbath Two-Phase Commit
```
iterated: "hold:sabbath — two-witness/emergency checkpoint awaits sabbath-eval child to self-attest via chain coherence"
```

The sabbath pattern:
1. Phase 1: All children fire and settle
2. Phase 2: Sabbath-eval child self-attests via chain coherence
3. Two witnesses required (Matt 18:19): the model's claim + the substrate's mechanical true

## The EBM Proto Format (Muscle Memory)

The `ebm_proto` events carry energy vectors that the substrate uses for routing:

```
key formats:
  fire:ok        — firing succeeded
  fire:retryable — firing failed, retry possible
  verdict:ok     — terminal verdict, cache resolved
```

The `mean` field is a base64-encoded float64 vector representing per-dimension energy. Lower energy = better route. The substrate's `dispatch-router` limb routes to the lowest-energy candidate.

## Key Insight: One-Shot = Declarative Gap Filling

The agent never explicitly chains contracts. Instead:

1. **Declare** one neuron contract with a plan
2. **Substrate interprets** the plan into typed children (interpret, verify, adjudicate)
3. **Substrate fills gaps** automatically: `fill who:contract via contract X`
4. **Children resolve independently**, each with its own cache snapshot
5. **break_above** terminates parent iterations as children complete
6. **EBM routes** future similar plans to proven paths
7. **Invalidation** is automatic: changed input → new hash → re-fire
8. **Sabbath** provides two-phase commit for safety

The agent's role is to **declare the intent**. The substrate owns the chain, the retries, the caching, and the routing.

## What Aiko Currently Does vs. What It Should Do

### Current State (Passive Adapter)
Aiko fires a neuron through FFI (`fire_neuron`) and gets back a `NeuronFireResult`. It:
- Wraps tool calls as neuron firings (treating substrate as ledger, not loop)
- Records turn terminals as neuron firings
- Manages skill lifecycle (admit, transition, settle)
- Reads learning contracts for context

But it does NOT:
- Observe fill iterations and execute them as tool calls
- Handle guard events to retry failed work
- Use EBM routing to select tools
- Participate in sabbath two-phase commit
- Drive the chain loop

### Target State (Active Loop Driver)
Aiko should be an active participant in the neuron chain:

1. **ContractLoopDriver**: A new module that listens for fill iterations and drives the loop
2. **Fill iteration handler**: When the substrate emits `fill who:contract via contract X`, Aiko executes the corresponding work and feeds results back
3. **Guard handler**: When a guard fires, Aiko retries with a different approach (new lens)
4. **EBM router**: Use EBM energy rankings to select the best tool/approach for each firing
5. **Sabbath participant**: Participate in two-phase commit by providing self-attestation evidence
6. **One-shot surface**: Agent declares intent → Aiko + substrate handle everything else
