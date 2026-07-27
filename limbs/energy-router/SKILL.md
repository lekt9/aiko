# typed-neuron/energy-router

**Status**: reference generative limb (in progress)

Structural energy minimization for neuron firing recommendation, context selection, action choice, and spawning of micro sub-EBMs for unresolved work.

## What it is

A first-class hard-typed polymorphic Neuron (and small supporting registry lookup) that:

- Scores candidate next firings / limbs / actions using the deterministic `firingEnergy` function (grounding, evidence confidence, normalized cost, settlement distance, violations).
- Emits a content-addressed `EnergyScore` artifact.
- Either branches to the lowest-energy target or spawns a narrow specialist (`energy-sub-ebm`) that will `continue_wait` until sibling work supplies resolving evidence.
- Supports EBM-native public commons: packages can carry `PackageOffer` metadata (price, metering) and emit `UsageRecord` + `SettlementClaim` effects for compensated sharing over the mesh.

Lower energy is always better. The scorer is pure, deterministic, and content-addressable — perfect for caching, replay, and JESPA-style structural witnesses.

## Schemas (versioned)

- `energy.candidate/v1` — one routing candidate (id + grounding + conf + cost + settlement + optional package_digest + price_milli)
- `energy.score/v1` — the chosen id + energy value written as artifact
- `energy.package-offer/v1` — published offer for a digest-pinned Skill (price schedule, units, witnesses)
- `energy.usage/v1` — recorded usage of a remote or local neuron (who, what digest, cost, evidence)
- `energy.settlement-claim/v1` — claim for compensation after usage (idempotent, reconcilable)

## How it fits the architecture

- Single primitive only: returns `Decision` (control + effects + evidence).
- Generative limb per AGENTS.md §30: describe (this SKILL + manifest), write (inert package), admit (by digest), attach (typed edge + narrow grant), operate, judge (energy delta + settlement witnesses), retire.
- Registry discovery is a read. Energy ranking augments schema compatibility.
- Sub-EBMs via spawn + continue_wait + progress measure (no new control flow).
- Paid commons: offers and usage/settlement are normal artifacts and effects. Payment rails live in outbox adapters or external settlement limbs.

## Usage (local)

```sh
# Score demo
python3 scorer.py

# Fire the reference Python neuron via the real harness (manifest-driven)
neuron run --def neuron.json --neuron energy-router --stimulus examples/route_request.json --json

# Zig reference scorer (pure)
zig test energy.zig
```

## Public mesh + paid sharing

1. Author publishes the full inert package (this directory + pinned digest).
2. Registry Neuron (or index) surfaces `PackageOffer` entries with energy witnesses.
3. Consumer admits the package by digest.
4. Consumer stimulates the provider's node over `neuron.wire/v1` (signed delegation, locally clamped ceiling).
5. EnergyRouter on either side can prefer lowest-energy + acceptable-price options.
6. Usage is written as durable artifacts; settlement claims flow through outbox/reconciliation.

The mesh carries no money and no ambient authority. All economics are effects + evidence.

## Conformance target (per ROADMAP R2)

- Versioned schemas + pinned artifact reads (not ad-hoc payload).
- Allocator-safe + build-integrated.
- Complete manifest + capability proposal.
- Attached via ordinary router edge.
- Beats baseline on held-out settlement tasks (energy delta).
- Full lifecycle witness + honest negatives in ledger.
- Clean revoke/detach.

See `reference/energy_router.md`, `reference/EBM_NEURON.md`, and `reference/ROADMAP.md`.

## License / contribution

Published under the same terms as the typed-neuron reference. Every published package must carry reproducible witnesses (JESPA rows, firing energy deltas, settlement benchmarks) for consumers to evaluate.
