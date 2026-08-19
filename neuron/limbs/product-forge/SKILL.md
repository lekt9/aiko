---
name: typed-neuron/product-forge
description: Turns a business-requirements brief into a pinned product — PRD, IA, design tokens, and CRUD spec — with no product or UX spec required. Fires on a product-forge.request/v1 stimulus.
probe_input: {"firing_id":"probe-forge","messages":[],"now_ms":0,"permitted_reads":["forge-req"],"reads":[{"bytes":"{\"brief\":\"run a neighbourhood bike shop — bookings for repairs, inventory of bikes and parts, roster of mechanics, customer history\",\"project\":\"bike-shop\"}","digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","id":"forge-req","schema":"product-forge.request/v1"}],"receptor_schema":"product-forge.request/v1","schema":"neuron.stimulus/v1"}
expect_contains: product-forge.prd/v1
grounding: neuron/AGENTS.md#30, skill:nextlevelbuilder/ui-ux-pro-max, skill:mattpocock/to-prd, skill:anthropics/frontend-design
---

# typed-neuron/product-forge

**Status**: reference generative limb — business requirements in, proper gated product out.

Turns free-form **business requirements** into a **pinned product** without anyone
having to write a product spec or a UX spec. The limb chooses the archetype,
IA, design direction, and data model itself — deterministically — from what the
brief actually says.

## What it does

Fires on one `product-forge.request/v1` read:

```json
{ "brief": "free-form business description", "project": "slug" }
```

Walks a **bounded, gap-blind** archetype catalogue (booking, crm, inventory —
see `neurons/forge.py`) that never reads `expect_contains`. Classification is
lexical on the brief only; a probe string stuffed into `expect_contains` cannot
change the result (the manufactured-generalization refusal).

Emits **four writes + one result**:

- `artifact/product-forge/<project>/prd` — `product-forge.prd/v1`
- `artifact/product-forge/<project>/ia` — `product-forge.ia/v1`
- `artifact/product-forge/<project>/tokens` — `product-forge.design-tokens/v1`
- `artifact/product-forge/<project>/crud` — `product-forge.crud-spec/v1`

All four land under `artifact/product-forge/`, inside the limb's declared
`write_prefix`. No sends, no spawns.

## Why the probe is what it is

The probe hands in a *bike-shop* brief that straddles two archetypes
(booking + inventory). The acceptance is `product-forge.prd/v1` — which only
appears if the limb opened the digest-pinned read, classified lexically (not
by reading the gap's acceptance), derived all four artifacts, and declared the
PRD write. A limb that echos `expect_contains` or skips the classification
still won't produce that artifact id.

Reproduce directly:

```sh
printf '%s' "<probe_input>" | python3 neurons/forge.py
```

## Gating

- **Deterministic** — same `product-forge.request/v1` bytes → same four artifacts, byte-for-byte (sorted keys, no clocks, no LLM). Required for any producer on the recompute path.
- **Grounded** — every decision cites `forge-req` as a source; staleness on the business requirements correctly invalidates the product.
- **Digest-pinned** — `SKILL.md` is inside `computePackageDigest`; editing prose changes the digest (§30, skill-doc gate).
- **Durable ledger** — admission carries `skill.expect_contains`; a reader asks the ledger what the package claimed when pinned.
- **Fail-closed** — brief < 10 chars is `validation` rejection with zero effects.

## Conformance

```sh
python3 tests/conformance.py
```

## Pack wiring (one-shot)

`product-forge` is the *first* atom of the product-oneshot graph — it supplies
the PRD/IA/tokens/CRUD for `crud_master` and `design_skills` without a
human-authored spec. The shared atom is `product.business_requirements` as
pinned input.