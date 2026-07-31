---
name: typed-neuron/energy-router
description: Scores routing candidates with the deterministic firingEnergy function (grounding, evidence confidence, normalized cost, settlement distance, violations) and branches to the lowest-energy candidate, or spawns a narrow sub-EBM when the winner declares wants_sub_ebm. Use when a firing must choose among candidate limbs, contexts, or actions and the choice has to be replayable and content-addressed rather than model-judged.
probe_input: {"schema":"neuron.stimulus/v1","firing_id":"probe-energy-1","receptor_schema":"energy.candidate/v1","reads":[{"id":"cands","schema":"energy.candidate/v1","bytes":"[{\"id\":\"router-heuristic\",\"grounding_ok\":true,\"evidence_conf_milli\":710,\"normalized_cost\":0.35,\"settlement_distance\":1.2},{\"id\":\"spawn-micro-ebm\",\"grounding_ok\":true,\"evidence_conf_milli\":880,\"normalized_cost\":0.25,\"settlement_distance\":0.1,\"wants_sub_ebm\":true},{\"id\":\"context-narrow\",\"grounding_ok\":true,\"evidence_conf_milli\":920,\"normalized_cost\":0.15,\"settlement_distance\":0.4}]","digest":"b66adddeff468f045e3a11d39bcdfd5e742b5a4001cde0ba5d858d459ffb12b8"}],"permitted_reads":["cands"],"messages":[]}
expect_contains: context-narrow|1.02
---

<!--
Acceptance note. `expect_contains` is the `bytes` of the emitted
`energy.score/v1` write: the winning candidate id joined by `|` to its energy,
rounded to 4 places. For the probe above, in the order the candidates appear:

    router-heuristic 0 + (1000-710)/250 + 0.35*2 + 1.2 + 0  = 3.06
    spawn-micro-ebm  0 + (1000-880)/250 + 0.25*2 + 0.1 + 0  = 1.08
    context-narrow   0 + (1000-920)/250 + 0.15*2 + 0.4 + 0  = 1.02   <- argmin

so the string is false unless the scorer ran over every candidate AND took the
minimum. The winner is deliberately last in the list, is not the cheapest by
settlement distance, and is not the one asking to spawn — first-item, greedy,
and "honour wants_sub_ebm" shortcuts each emit a different id, and any
arithmetic drift emits a different number. A handler that only prints its own
acceptance cannot know 1.02.
-->

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
