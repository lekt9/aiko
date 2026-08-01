# Photon / positron collisions → Contract → EBM

**Canon lives in the Contract repo** (single source of truth for the substrate):

[`../../contract/docs/PHOTON-POSITRON-CONTRACT-EBM.md`](../../contract/docs/PHOTON-POSITRON-CONTRACT-EBM.md)

If you are browsing Gitea `Unbrowse/aiko` only, the same document is published
from `Unbrowse/contract` as `docs/PHOTON-POSITRON-CONTRACT-EBM.md`.

---

## Why this file exists in Aiko

Aiko is the experimenter; Contract is the collision chamber; the EBM is the
energy ledger of verified work. This short mirror keeps the mapping discoverable
from the application tree without forking two long copies.

## One-sentence claim

**Work is pair production (claim × check); verification is annihilation;
terminal energy trains local prototypes; routing is energy descent.** That is
what we have been building — not a metaphor bolted on later.

## Minimal map

| Physics | Contract / Aiko |
|---|---|
| Field | append-only ledger |
| Pair production | `task begin` + real `--check` |
| Annihilation | verify → satisfied / died / purged |
| Energy deposit | EBM `fold(+1/−1)` into prototypes |
| Ground-state settle | `recommend` / energy-ranked resolution = argmin E |

## Elevator pitch

> Frontier agents talk without obligatory collisions. Aiko forces claim×check
> annihilation, then uses that energy to route the next action. The harness *is*
> the energy-based model.

## Read next

| Doc | Where |
|---|---|
| Full isomorphism + honest wall | `contract/docs/PHOTON-POSITRON-CONTRACT-EBM.md` |
| Fractal EBM architecture | `contract/docs/02-ARCHITECTURE-fractal-ebm-harness.md` |
| Intelligence / recommend loop | `contract/docs/HOW-IT-WORKS-intelligence.md` |
| Collective nonparametric thesis | `contract/docs/THESIS-collective-nonparametric-intelligence.md` |
