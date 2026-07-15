# 05 · Risk register — the honest wall

> Confidential DD dossier. The substrate's own tradition: *state the limits as
> loudly as the vision, or it's marketing.* This is the section diligence should
> weight most. Nothing here is hidden elsewhere; it is collected for scrutiny.

## Technical risk

**R1 — The energy model is a router, not a mind (the core bet).** Today's model
is a cosine-to-centroid plus a thin linear head — soft priors over "what resolved
before." Real reasoning is **not** in this model. The leap from "thin router" to
"intelligence" is *unbuilt* and comes from one of two unproven places: richer
composed energy models (which return some of the compute cost) or emergent
collective composition (many thin routers + verification composing into
reasoning). **This is the whole company's central technical bet.** Mitigation:
the falsifiable-atom discipline — prove each rung (the router *is* proven) before
funding the next. Do not mistake the scaffold for the building.

**R2 — Retrieval ≠ reasoning.** Indexing the world gives knowledge *access*, not
thought. Superintelligence needs composition, planning, and verification *over*
retrieved knowledge. The energy-descent-as-generation primitive is the seed, but
it is linear and shallow. **The reasoning layer is the hard, unsolved core.**

**R3 — Verification is the crux and the single biggest risk.** A system that
learns on-fire from verdicts is only as good as its verdicts. Bad or *gamed*
verdicts don't just add noise — they train the shared prior toward delusion. The
guard (a scripture-grounded truth-root + "two or three witnesses" corroboration +
the reward economics' verification gate) is **load-bearing**: if it fails, the
collective becomes confidently, collectively wrong. This is the line between
wisdom-of-crowds and madness-of-crowds, and it is **not automatic.**

**R4 — "Low compute" is low *marginal*, not low *total*.** Embedding and serving
retrieval over the live web is heavy infrastructure. The compute *moves* from
training to indexing/serving; it does not vanish. Honest claim: cheap-per-thought,
not cheap-overall. The "half the cost" pitch is a per-task target, not a total-
infrastructure claim, and is **not yet independently benchmarked.**

**R5 — Energy containment (the founder's own stated blocker).** The design is
power-hungry — it "leaks energy" by nature (it trains and grows storage on every
fire). This is *why* it isn't released yet. The on-chain offload is the intended
fix (weights on-chain, laptop as frecency cache), and is DESIGNED but not proven
at scale. Until contained, the product is unsafe/uneconomical to hand to users.

**R6 — Query privacy is unsolved; ZK is unbuilt.** Data-at-rest is sealed, but
querying a shared index can leak intent (needs PIR/local-replicas/ZK). And the
headline "ZK credential binding" is a **direction, not a shipped feature** —
today's identity layer is hash commitments + signed lineage. Marketing that says
"privacy you can verify" is ahead of the code; diligence should hold the code's
actual maturity (see `03-ONCHAIN-privacy-solana.md`).

## Strategic / market risk

**R7 — The algorithm is copyable; the moat is the network, not the code.** If the
EBM harness works, frontier labs can and will build it — it is proprietary but not
un-reproducible. The defensibility thesis is **distribution + the ledger**
(Solana's storage + wallet distribution + a commons of corroborated weights won
first). That is a race, not a lock. If Aiko does not win the network before the
approach is commoditized, the moat does not hold.

**R8 — Single-user, not yet a collective.** The thesis's power (compounding
intelligence, shared prior) requires *many* agents firing and corroborating. Today
there is **one user** (the founder). Every "collective" property is architectural
potential, not observed behavior. The network effects are unproven because the
network does not yet exist.

**R9 — Pre-launch, zero external validation.** Not publicly released, no external
users, no revenue. Capability is founder-demonstrated (Overwatch one-shot,
ARC-AGI) and awaits independent, recorded replication.

**R10 — A new-currency ambition adds scope and regulatory surface.** The founder's
end-vision includes defining a *new currency that rewards novelty/value-created*
(beyond value-of-work). This is early and unformed, and paying token holders from
usage introduces securities-like questions. It should be treated as a research
aspiration, not a near-term deliverable, and de-scoped from the core investment
thesis.

## Execution / key-person risk

**R11 — Single founder, deep in a rabbit hole.** One person, ~2–3 months into a
very deep build, self-aware about scope creep ("dug myself into a deep rabbit
hole"). Enormous surface area (harness + model + on-chain + economics) for one
person. Key-person risk is maximal; the first hire and a scoped roadmap are the
obvious de-risking moves.

**R12 — Two projects in superposition.** Aiko is a partial pivot from Unbrowse;
Unbrowse still exists. Focus risk: the pivot is not clean, and "which company is
this" is a real question a first-round panel already flagged.

## "Superintelligence" — a bet, not a result

Collective systems (markets, evolution, science) *do* exceed any participant, so
the ambition is not crazy. But whether this reaches *super* — and not merely
*useful* — is untested and hinges entirely on R1, R2, and R3 holding. It should be
underwritten as a **falsifiable direction with a cheap first gate already passed**
(the router), not as a destination being claimed.

## The one honest sentence

*The router is proven; the reasoning is a bet; the network doesn't exist yet; the
privacy pillar is real for data and aspirational for ZK; and the moat is a race to
own a commons before the idea is copied.* Everything compelling about Aiko is
downstream of bets that are named, cheap to test next, and being tested in order.
