---
name: typed-neuron/introspection
description: 'Reads the substrate and emits a typed capability map, ranked capability gaps, promotion proposals and inert limb specs; the inspector fires on neuron.inspect-request/v1 whenever the system needs to know what it currently is and what it is missing.'
probe_input: '{"schema":"neuron.stimulus/v1","firing_id":"probe-1","receptor_schema":"neuron.inspect-request/v1","now_ms":0,"reads":[{"id":"insp-req","schema":"neuron.inspect-request/v1","bytes":"{\"include_metrics\":true}","digest":"7a39f95f1ba0c5b79a70cd416cb21d5d589abc6cb904fe989c1d7b0472d2e872"},{"id":"agents/reference/generated/manifest","schema":"typed-neuron.agent-skill-manifest/v1","bytes":"{\"name\":\"repair-capability\",\"version\":\"1.0.0\"}","digest":"59a78d3b74ecef2033e13323d7a4cd3491c774c6a6831028c97ac4d5c979df19"}],"permitted_reads":["insp-req","agents/reference/generated/manifest"],"messages":[]}'
expect_contains: '"claim":"capability map with 2 artifact schemas, 1 neurons, 0 packages"'
---

# Introspection — self-aware capability discovery and self-modification

A generative limb that gives the Neuron system awareness of its own capabilities,
state, and gaps. The introspection neurons read the substrate, produce a typed
capability map, identify missing capabilities, observe firing patterns to propose
promotions, and generate new limb packages — all through the standard
describe→write→admit→attach lifecycle.

## Neurons

### inspector
Reads the substrate state and produces a `neuron.capability-map/v1` artifact
containing:
- All registered neuron identities with their versions
- All admitted packages with digests
- All artifact schemas present in the substrate
- All message schemas observed
- Firing metrics
- Active topology (edges, joins, wait predicates)

Accepts: `neuron.inspect-request/v1`  
Produces: `neuron.capability-map/v1` write

### gap-analyzer
Given a capability map and a desired capability set, identifies which
capabilities are missing and ranks them by structural energy:
- Present = grounded, energy 0
- Absent = ungrounded, energy 5.0
- Partial match = medium energy

Accepts: `neuron.gap-request/v1` (references capability-map read)  
Produces: `neuron.capability-gaps/v1` write

### promoter **[new — closes the firing→limb gap]**
Reads firing records plus a capability map, detects "hot" firing patterns
(same neuron identity, same receptor schema, consistently successful), ranks
them by promotion confidence, and emits `neuron.promote-proposal/v1` artifacts
with generated limb/v1 specs. The proposal is inert — the harness must
independently admit before the limb becomes executable (§30).

Thresholds (objective, LLM-free):
- Minimum 3 firings
- Minimum 80% success rate
- Effect consistency rewarded
- Cache hits rewarded

Accepts: `neuron.promote-request/v1` (reads capability-map + firing-summary)  
Produces: `neuron.promote-proposal/v1` writes (one per hot candidate)

### limb-designer
Given a capability gap artifact, generates a `limb/v1` spec package
and a `typed-neuron.limb-manifest/v1` manifest as inert artifacts.

Accepts: `neuron.gap/v1` (single gap entry)  
Produces: `neuron.limb-spec/v1` + `neuron.limb-manifest/v1` writes

## Schemas

| Schema | Purpose |
|--------|---------|
| `neuron.inspect-request/v1` | Request introspection with optional filters |
| `neuron.capability-map/v1` | Full system capability snapshot |
| `neuron.gap-request/v1` | Desired capabilities + map reference |
| `neuron.capability-gaps/v1` | Ranked missing/partial capabilities |
| `neuron.gap/v1` | Single gap for limb generation |
| `neuron.promote-proposal/v1` | Firing pattern → promotion proposal with limb spec |
| `neuron.limb-spec/v1` | Generated limb/v1 spec (inert) |
| `neuron.limb-manifest/v1` | Generated manifest (inert) |

## Self-modification cycle (complete)

```
inspector (read substrate → capability map)
    ↓
gap-analyzer (map + desired → ranked gaps)
    ↓                        ↓
promoter (firing records + map → hot patterns → promotion proposals)
    ↓                        ↓
limb-designer (gap or proposal → inert limb package)
    ↓
[harness: admit → attach → operate → judge]   ← §30 safety boundary
    ↓
inspector (re-read → verify new capability present)
```

The promoter closes the mechanical gap: useful firings are automatically
observed, ranked, and proposed for promotion. The limb-designer only writes
inert data. The harness admission boundary (§30) must independently validate,
admit, and attach any generated package. This preserves the trust boundary:
generated code is data until admitted — no self-authorization.

## Shared runtime

Uses `limbs/shared/_neuron.py` for stimulus validation, provenance, budget
enforcement, and typed decision emission.
