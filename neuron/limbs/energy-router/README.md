# Energy Router — EBM-native generative limb (reference)

This is the concrete implementation of the structural energy router as a publishable, admit-by-digest, mesh-routable, paid-capable Skill package.

## Files

- `neuron.json` — manifest consumable by `neuron run --def`
- `SKILL.md` — human + agent documentation
- `scorer.py` + `energy.zig` — pure deterministic reference scorers (cross-language fidelity)
- `neurons/energy_router.py` — the main Neuron (lowest energy + conditional sub-EBM spawn)
- `neurons/registry_lookup.py` — EBM-ranked discovery over PackageOffer + Candidate indexes
- `schemas/*.v1.json` — versioned schemas for Candidate, EnergyScore, PackageOffer, Usage, SettlementClaim
- `examples/route_request.json` — demo stimulus
- `index/seed.json` — tiny seed public package index (for demo / cold-start)

## Quick verification (evidence)

```sh
python3 scorer.py
python3 -c '
import json, sys
sys.path.insert(0,"neurons"); sys.path.insert(0,"../../shared")
from energy_router import fire
with open("examples/route_request.json") as f: stim=json.load(f)
print(fire(stim))
'
zig test energy.zig || true
```

## Public paid commons flow (intended)

1. Author publishes the full inert tree + a digest of the package.
2. Registry Neuron (or static index) lists `PackageOffer` entries (with energy witnesses + price).
3. Consumer admits by exact digest (local `Registry.admit`).
4. Consumer stimulates the provider node over the mesh (signed delegation, locally clamped ceiling).
5. EnergyRouter (local or remote) can be used to rank offers by energy + price.
6. Usage writes `energy.usage/v1`; settlement via outbox + `energy.settlement-claim/v1`.

The mesh and Neuron primitive never carry money or authority. Economics are normal effects + artifacts.

See AGENTS.md §12/§29/§30, reference/energy_router.md, reference/EBM_NEURON.md, and ROADMAP R2.
