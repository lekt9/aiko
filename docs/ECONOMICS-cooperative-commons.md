# ECONOMICS — The Cooperative Commons of Ranked Energy Contracts

*Why the on-chain layer earns its cost, and how the value flows to the collective
that produced it rather than a host or a whale.*

> *And all that believed were together, and had all things common; and sold
> their possessions and goods, and parted them to all men, as every man had
> need. ... Neither was there any among them that lacked.* (Acts 2:44–45; 4:34)

This is the companion to `THESIS-collective-nonparametric-intelligence.md`. The
thesis argues intelligence is retrieval + routing + verification over a live
index. This document answers: **if the ranked energy contracts are the collective's
learned priors, what is the honest economic model — and how do we keep it a
commons instead of a monopoly?**

---

## 1. What is tradeable, and why it makes sense

A **ranked energy contract** is *proven experience*: "for context X, this action
resolves," carrying a ledger track record no one can fake (N satisfied, M died →
an energy/reputation the ledger reconstructs). Reusing it saves the buyer the
cost of *rediscovering* it — failed fires, compute, time. So a market for priors
is **Pareto-improving**: the whole collective wastes less rediscovery.

It needs the chain for exactly three things, and only these:
- **Verifiable reputation** — the ledger of verdicts can't be forged.
- **Verifiable attribution** — who actually trained this prior (every fold is recorded).
- **Settlement with no host** — payment clears trustlessly, no platform in the
  middle extracting rent.

That is the *only* case where Solana earns its price (per the cost analysis:
on-chain is worthless as bulk storage; it is worth it as tiny, tamper-proof,
host-less verification). For a single user's private model, skip the chain.

## 2. The failure mode — why "socialism" is the corrective, not a slogan

A naive market has a brutal **Matthew effect**: the best contracts get used →
paid → trained more → get better → capture *all* usage. Winner-take-all,
enclosure, the long tail starves and stops contributing, the commons ossifies
around a few owners — and then dies, because it depends on the many contributing.
Pure market kills the commons it feeds on. The design goal is a commons that
structurally resists enclosure while still rewarding contribution.

## 3. The cooperative-commons design (mechanisms → substrate primitives)

### 3.1 Socialize the base prior — un-encloseable by construction
Because the EBM is **ledger-reconstructible** (`replayFromLedger`), anyone can
rebuild the shared centroids from the public ledger for free. The accumulated
collective knowledge is a **public good** — you literally cannot make the commons
prior private. *From each according to ability* (everyone's verdicts train it) →
*to each according to need* (free access to the commons prior). Only the
**surplus** — premium *private* priors, priority compute — is ever paid.
*Primitive:* the ledger + `ebm_store.replayFromLedger`.

### 3.2 Contribution-weighted reward — not owner-take-all
When B pays to use a prior, the payment does not go to one "owner." It **splits
across everyone whose verdicts trained that centroid**, weighted by recorded
folds/corroborations. The ledger already attributes every fire; an on-chain split
distributes the payment to the collective that produced the value. This is the
single strongest anti-enclosure lever — it turns "owning a model" into "having
contributed to a commons."
*Primitive:* ledger attribution (who fired what) + an on-chain split contract.

### 3.3 Demurrage / decay — anti-hoarding is already in the code
`ebm.zig`'s 30-day freshness half-life means a prior **decays unless used and
refreshed**. You cannot sit on a valuable prior and extract rent forever; value
must circulate or it fades. That is demurrage — it structurally punishes
accumulation and rewards flow.
*Primitive:* `ebm.freshness(age)` (exists today).

### 3.4 Progressive commons fee — a redistributive floor
A protocol fee on payments (progressive: the more a contract earns, the higher
the cut) funds a **commons pool**, redistributed to low-usage contributors — a
UBI-like floor that keeps the long tail participating instead of starving. The
collective's health is a funded priority, not an afterthought.
*Primitive:* `x402` payment fee split → a commons-pool contract.

### 3.5 Corroboration — distribute the power to mint value
The **"two or three witnesses"** rule (Deut 19:15, the Σ-corroborate primitive)
means no single actor can unilaterally mint reputation for its own contract —
value requires independent attestation. A whale cannot self-certify its way to
dominance.
*Primitive:* the corroboration doctrine (exists in SKILL.md + the witness path).

### 3.6 Only the surplus is traded
The base commons prior is free (§3.1). Payment is only for premium/private priors,
priority compute, or attestation. The commons is the floor; the market is the
ceiling.

## 4. THE HONEST WALL — tensions, and where this breaks

*(Stated as loudly as the vision, per the substrate's own tradition.)*

1. **Pure socialism starves quality.** If everything is free, no one is paid to
   produce *good* priors → tragedy of the commons, free-riding, decay. This is
   why the model is **not** pure socialism — it is a socialized base + a thin
   surplus market. The realistic target is a **cooperative commons /
   market-socialism**, not utopia.
2. **Attribution gaming is the sybil risk.** If contribution → reward, an attacker
   spams verdicts to claim credit. Corroboration (§3.5) + a real *cost to fire*
   (compute / a small stake) are the guards; without them the reward split is
   farmed. This is load-bearing and must be designed, not assumed.
3. **The redistribution parameters are policy, not physics.** The progressive-fee
   curve, the commons-pool payout rule, the split weighting — these are *choices*
   with real tradeoffs (too redistributive → no incentive; too little → enclosure).
   They should be tunable, transparent, and ideally governed by the commons, not
   hard-coded by one author.
4. **Reputation ≠ correctness.** A high-energy contract is one that *resembled past
   successes*, not one that is *right*. Paying for reputation can amplify a
   confident-but-wrong prior (the madness-of-crowds risk from the thesis). The
   truth-root + corroboration is the guard, and it is the same guard the whole
   collective-intelligence bet rests on.
5. **On-chain only for the commons.** All of this is worth its cost ONLY when the
   trustless, host-less, shared case is real. If it is a single user or a trusted
   group, skip the chain — an encrypted local/Arweave store + the energy router
   already deliver lean/private/realtime at zero SOL.

## 5. Mapping — what exists vs. what must be built

| Mechanism | Substrate primitive | State |
|---|---|---|
| Socialized base prior | ledger + `ebm_store.replayFromLedger` | exists (main) |
| Energy ranking (quality signal) | `ebm.zig` + the Phase-1 router | **built + proven (arc-lean)** |
| Dedup / shared blobs paid once | `cas.zig` content-addressing | **built (arc-lean)** |
| Demurrage / decay | `ebm.freshness` (30-day half-life) | exists (main) |
| Access control | receptor grants (`capability.zig` F1) | **built (arc-lean)** |
| Payment pointers | `x402:` | exists (main) |
| Trustless settlement + commitments | `iq_ledger` / Solana | exists (main), needs yoink |
| Corroboration | "two/three witnesses" doctrine | exists (doctrine) |
| **Contribution-weighted split** | ledger attribution + on-chain split | **to build** |
| **Progressive fee + commons pool** | `x402` fee + pool contract | **to build** |

## 6. The falsifiable first step (discipline)

Before any on-chain economics, the smallest testable claim: **a two-party
"pay-to-use a ranked contract, split the payment to its contributors" flow,
proven locally** — B references A's proven contract, a receptor grant + a
(mock) payment gates access, and the payment splits across the ledger-attributed
contributors of that prior. If the *local* split is correct and un-gameable under
corroboration, then — and only then — settle it on-chain. Prove the economics off
the chain before paying the chain to enforce them, exactly as we proved the router
and the dedup before proposing to store anything.

---

**Bottom line:** the chain is not a database; it is the *trust layer of a
commons*. Its one job is to make "whose track record is real, who contributed,
who gets paid" un-fakeable and host-less — so a collective of agents can share and
reward learned priors without a platform enclosing the value. That is the reason
the on-chain layer exists, and the only reason it is worth its cost.
