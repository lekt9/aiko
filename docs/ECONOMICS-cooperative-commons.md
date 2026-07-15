# ECONOMICS — The Cooperative Commons of Ranked Energy Contracts

*A governed common-pool resource secured by bonded accountability. Unifies the
ranked-energy-contract commons with the Unbrowse Maintenance Network
(Proof of Indexing + Bonded Accountability, Tham 2026): a ranked energy contract
IS a route, so the same economics apply without reinvention.*

> *And all that believed were together, and had all things common ... and parted
> them to all men, as every man had need. ... Neither was there any among them
> that lacked.* (Acts 2:44–45; 4:34)

Companion to `THESIS-collective-nonparametric-intelligence.md` (why a lean
non-parametric collective can be intelligent) and
`PLAN-contracts-as-onchain-ebm-weights.md` (how it's built, prove-the-atom-first).

---

## 0. The unifying insight

A **ranked energy contract** — a reusable, ledger-reconstructible prior that
resolves some context — is the same *kind* of object as a **route** in the
maintenance-network paper: a shared, reusable asset that **decays** (the world
drifts; the prior goes stale) and whose **freshness/quality is a non-rival public
good**. So the paper's economics transfer 1:1. This document adopts them.

Naming it correctly (per Ostrom): the graph of ranked contracts is a
**common-pool resource** — hard to exclude, but *depletable through
uncoordinated use*. The depletion is **epistemic**: every agent that leans on a
stale prior and propagates it as correct lowers the trustworthiness of the graph
for everyone. A prior that is *wrong with confidence* is worse than none.

## 1. Why pure usage fees are the wrong instrument

A usage fee (pay-per-call) is the right tool to *ration* a contract — heavy users
pay more — and the **wrong** tool to *fund the freshness of the graph*:
- Freshness is **non-rival** (my using a fresh prior doesn't consume it) and near
  **non-excludable** → a public good → usage fees **structurally under-provide**
  it (everyone free-rides on someone else's fee).
- Letting a prior rot is a **negative externality**: the neglecter's cost lands on
  every downstream agent whose call now fails or returns wrong data.

Pigou's corrective for an uninternalised externality is not a tax but **a price on
the harmful act** — rendered here as **a slashable bond**. Staleness stops being a
free option and becomes a liability the claimant carries. *This is the staking.*

## 2. Two assets, deliberately separate

| Rail | Asset | Job | State |
|---|---|---|---|
| **Usage** | USDC over `x402` | meter/ration *calls that happen* — narrow | exists |
| **Security** | **FDRY** (base token) | **bond/stake against the integrity of the graph**; funds maintenance; slashed on a false freshness claim | to build |

They stay separate for the same reason you don't pay a deductible out of the till:
the thing that *funds maintenance and prices its failure* must be the asset whose
worth rises and falls with **the network being worth trusting at all**. **FDRY's
value grows with real usage of a trustworthy graph** — tied to integrity, not to a
speculative launch. Its **fair distribution is a security parameter, not marketing**:
a coordination asset launched for money cannot become trustworthy.

## 3. Proof of re-verification — freshness as a checkable artifact

A bond only punishes a false claim *after* it's found false — it presupposes a way
to find it false. So freshness is made a **verifiable artifact**, the ranked-contract
analog of the paper's **Proof of Indexing**:

- A maintainer **re-verifies** a contract — re-runs it against fresh evidence and
  attests that it still resolves and its observed shape matches — and commits a
  **content-addressed, hash-chained attestation** to the ledger. **`cas.zig`
  (built) is exactly this substrate**: content-addressed, integrity-checked,
  independently reproducible. Anyone can re-verify and check they reconstruct the
  same attestation. Freshness stops being say-so and becomes a checkable object.
- One proof certifies a *moment*; **repeated proofs on a cadence** (set by the
  trust tier) are what show a prior is *kept* fresh — the Proof-of-Spacetime
  property, not the point one. `ebm.zig`'s 30-day freshness decay is the clock
  that says when re-verification is due.
- We attest *what* is observable (it resolves, the shape matches) and never
  publish *how* the capture/re-verification is produced — the private surface
  stays private; the proof is public.

## 4. Trust tiers (Ostrom's nested enterprises) — and why it's "optional"

Not all traffic needs the same assurance; pretending it does taxes a harmless
price-check at the same rate as a funds-moving call.

- **Open tier — the socialized commons.** Low-risk, idempotent priors. **No bond,
  best-effort, free**, and honest about being best-effort. This is the
  **ledger-reconstructible public good**: anyone rebuilds the shared centroids
  from the public ledger for free — **un-encloseable by construction**. The free,
  fast majority.
- **Bonded / high-trust tier — the optional premium.** Authenticated, high-value,
  or must-not-be-wrong priors. **FDRY-bonded, proof-of-re-verification-backed,
  slashable** by a threshold quorum. A maintainer stakes FDRY behind "this prior
  is fresh/good"; if independent re-verification refutes it, the bond is slashed.

**"Own it via Voltr, but optional" fits exactly:** you run a **maintainer/bonding
vault** serving the high-trust tier; the open tier stays free and un-encloseable.
You are a *maintainer*, not an encloser. Staking is opt-in — it buys you *into*
the verified tier; it never gates the commons.

## 5. "Simulate socialism" = Ostrom CPR governance, done the empirical way

Durable commons are **neither privatised nor centrally administered — governed by
the appropriators** (Ostrom's Nobel finding). Three principles map directly:
- **Clearly-defined boundaries** — who may claim a prior is fresh, and who may draw
  on it (the receptor grant + the trust tiers).
- **Graduated sanctions** — slashing *tiers*: a first low-confidence miss ≠ a
  repeated or high-value false claim.
- **Nested enterprises** — the trust tiers themselves: lightly-governed open routes
  inside tightly-governed high-trust ones.

*From each according to ability* (everyone's verdicts train the base prior) → *to
each according to need* (free access to the commons prior). Only the **surplus** —
bonded verification, priority compute, private priors — is ever paid. That is not
utopian socialism; it is a **governed commons**, the thing that actually works.

## 6. THE HONEST WALL — what's live, what's reference, what breaks

*(As loud as the design, per the substrate's own tradition — and the paper's.)*

1. **Formal Sybil resistance is NOT closed.** The bond raises the cost of a false
   identity but does not formally solve Sybil. Stated openly in the paper; it
   stands here.
2. **The token's fair distribution is load-bearing.** FDRY exists strictly for the
   security function. If its distribution is a money-grab, the whole trust model
   collapses — "a coordination asset launched for money cannot become trustworthy."
3. **Yield on the bond couples the security asset to market risk.** Holding the
   FDRY bond in a Voltr yield vault is attractive (idle collateral works), but the
   asset that *secures* the graph should track *network integrity*; a strategy
   loss that impairs the bond weakens the security it's supposed to provide. A
   conscious tradeoff, not a free lunch.
4. **Reputation is now a checkable artifact — but re-verification quality is the
   new crux.** Proof-of-re-verification dissolves "reputation ≠ correctness" only
   as far as the re-verification is honest and independently reproducible. Garbage
   re-verification → confidently-wrong "fresh" priors. The quorum + graduated
   slashing is the guard, and it is the same guard the whole collective bet rests on.
5. **On-chain only for the genuine commons.** All of this is worth its cost ONLY
   when the trustless, host-less, shared case is real. Single user or trusted group
   → skip the chain; the energy router + encrypted local/Arweave store already
   deliver lean/private/realtime at zero SOL.
6. **Live vs reference vs design.** Be explicit (as the paper is): the route/contract
   resolution + the `x402` usage rail are live; the energy router, `cas.zig`
   attestation substrate, and receptor are built+proven here; the bond/challenge/
   slash economics are *design + reference*, not a deployed production mechanism.

## 7. Mapping to substrate primitives

| Mechanism | Primitive | State |
|---|---|---|
| Socialized base prior | ledger + `ebm_store.replayFromLedger` | exists (main) |
| Energy ranking (the quality signal) | `ebm.zig` + Phase-1 router | **built + proven (arc-lean)** |
| Proof-of-re-verification substrate | `cas.zig` content-addressed attestation | **built (arc-lean)** |
| Freshness cadence / demurrage | `ebm.freshness` (30-day half-life) | exists (main) |
| Access boundary | receptor grants (`capability.zig` F1) | **built (arc-lean)** |
| Usage rail | `x402:` (USDC) | exists (main) |
| Trustless settlement + commitments | `iq_ledger` / Solana | exists (main), needs yoink |
| Corroboration / quorum for slashing | "two/three witnesses" doctrine | exists (doctrine) |
| **FDRY bond / stake / slash** | new security-asset contract (+ optional Voltr vault) | **to build** |
| **Proof-of-re-verification proof + dispute** | re-run + attest (`cas`) + quorum challenge | **to build** |

## 8. The falsifiable first step (discipline)

Before any FDRY or on-chain settlement, the smallest testable claim, **all local**:
a **re-verify → attest → bond → slash-on-refutation** flow — re-run a ranked
contract, commit a content-addressed attestation via `cas.zig`, post a (mock) bond
behind the freshness claim, and have an independent re-verification under a
quorum **slash** the bond when the attestation fails to reproduce. If the *local*
bond-and-slash is correct and un-gameable under corroboration, then — and only
then — settle FDRY on-chain. Prove the economics off the chain before paying the
chain to enforce them, exactly as we proved the router and the dedup first.

---

**Bottom line:** the chain is not a database; it is the **trust layer of a governed
commons**. FDRY's one job is to make "whose freshness claim is real, who
maintained it, who gets slashed" un-fakeable and host-less — so a collective can
share and *keep fresh* a graph of ranked priors without a platform enclosing the
value or letting it rot. That is the reason the on-chain layer exists, and the only
reason it is worth its cost.
