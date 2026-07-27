# Energy Router

Status: experimental generative-limb prototype

The Energy Router is a diagnostic and routing-policy experiment over the
existing Neuron primitive. It is not a kernel feature and is not currently an
admitted production limb.

## Structural energy

The reference scorer ranks candidate firings with:

```python
def firing_energy(
    grounding_ok,
    evidence_conf_milli,
    normalized_cost,
    settlement_distance,
    violations=0,
):
    return (
        (0.0 if grounding_ok else 3.0)
        + max(0.0, (1000 - evidence_conf_milli) / 250.0)
        + normalized_cost * 2.0
        + settlement_distance
        + violations * 2.5
    )
```

Lower is better. The terms are observable properties of a proposed firing:
grounding, evidence confidence, normalized cost, distance from settlement, and
explicit violations. Schema and authority checks still run before the score;
energy never converts an invalid candidate into a valid one.

## Mapping

| EBM term | Typed Neuron mechanism |
|---|---|
| high local energy | `continue_wait` with an unresolved predicate |
| low-energy settlement | verified `terminate` |
| a lower valley elsewhere | `branch` to an admitted target |
| micro-EBM | spawned narrow Neuron or limb |
| resolving signal | typed message or digest-pinned artifact |
| global frontier | unresolved work in the Meta-Agent snapshot |
| cost | firing and cumulative budgets |
| recommendation | an ordinary router Neuron selecting the lowest valid score |

A waiting Neuron is not literally an analog EBM. The vocabulary is useful
only where the mechanical mapping above remains true.

## What exists

`limbs/energy-router/` is now a reference generative limb package:

- `neuron.json` (manifest for `neuron run --def`)
- `SKILL.md`
- `neurons/energy_router.py` — full Neuron: deterministic `firingEnergy` scoring, `EnergyScore` write, branch or spawn of `energy-sub-ebm` on unresolved work
- `neurons/registry_lookup.py` — EBM-ranked lookup over `PackageOffer` + `Candidate` records (supports paid mesh commons discovery)
- Versioned schemas: `energy.candidate/v1`, `energy.score/v1`, `energy.package-offer/v1`, `energy.usage/v1`, `energy.settlement-claim/v1`
- `index/seed.json` (tiny publishable public index seed)
- Pure reference scorers (`scorer.py`, `energy.zig`) + early `src/energy_router.zig` prototype

The package is executable through the real harness:

```sh
neuron run --def limbs/energy-router/neuron.json --neuron energy-router \
  --stimulus limbs/energy-router/examples/route_request.json --json
# → committed with EnergyScore write (and spawn when wants_sub_ebm)
```

It is the concrete reference for EBM-native routing + sub-EBMs + publishable paid neuron offers over the mesh.

It is **not yet**:
- wired into the reference meta-agent router slot
- proven with published benchmark deltas against a baseline on settlement tasks
- promoted as a first-class Zig build-integrated limb

See `reference/ROADMAP.md` (R2) and `reference/EBM_NEURON.md` for remaining work.

## Conforming target

A complete Energy Router limb must:

1. read candidate and frontier artifacts through versioned, digest-pinned
   schemas;
2. emit a typed route choice and `EnergyScore` artifact;
3. request only narrow read/write/branch authority;
4. be written as inert Skill data and admitted by exact digest;
5. attach through an ordinary router edge;
6. beat a declared baseline on held-out settlement tasks without weakening
   any safety/conformance property;
7. be revoked, detached, and garbage-collected safely.

The benchmark ledger must retain failures as well as wins. Until that witness
exists, the energy implementation is a useful experiment, not a system claim.

See `reference/EBM_NEURON.md` for the broader lens and
`reference/ROADMAP.md` for the completion work.
