# Aiko — Due-Diligence Dossier

> **Confidential.** Prepared for investor due diligence. Not for distribution.
> This dossier describes proprietary architecture; please do not share it.

---

## What Aiko is, in one paragraph

**Aiko is an agent that lives on your laptop and does the things you'd do, so you
don't have to.** Coworkers bombing you on Telegram — Aiko tells you what actually
applies to you and replies in your voice. Your mum's birthday — Aiko finds a
restaurant nearby and books a table for six at 6:30. *If you can do it on your
laptop, ask Aiko.* Under the hood, Aiko is not a wrapper around a frontier LLM.
It is a **fractal energy-based harness**: a substrate that routes, verifies, and
learns from doing — grounding a small local model with a live index and a shared,
auditable memory, so it gets *twice the reliability at half the cost* of running
a large model for computer use.

## The three pillars (the pitch)

| Pillar | The claim | Honest status (see §Status legend) |
|---|---|---|
| **Reliable** | Our own Energy-Based model for computer use, trained on-device; twice the reliability, half the cost | Harness + energy router **BUILT+PROVEN**; the "2× / ½" figures are **DESIGN targets, not yet independently benchmarked** |
| **Private** | Weights on-chain; zero-knowledge credential binding; your data stays yours; Solana volume makes the product pay for itself | Local inference + sealed data + reward economics **BUILT/DESIGNED**; **ZK credential binding is RESEARCH-DIRECTION, not built** |
| **Powerful** | A new architecture lets Aiko learn *as it works* | Train-on-fire + energy-ranked resolution **BUILT+PROVEN** as a router; "reasoning-grade intelligence" is a **falsifiable bet, not a result** |

We state the limits as loudly as the vision — that is the substrate's own
tradition, and this dossier keeps it. Where something is a target or a direction,
it says so, in the same breath as the claim.

## The bet (why this is a different scaling law)

Frontier AI scales intelligence as **parameters × data × compute** — static,
centralized, and *your data trains their model*. Aiko scales it as **index
coverage × collective firing history × routing/verification quality** — live,
distributed, and *your data stays yours*. Knowledge lives in a retrievable index,
not in frozen weights, so **the marginal cost of a thought falls toward the cost
of a lookup and a fold**. That is the whole thesis; everything else is mechanism.

## How to read this dossier

| # | Document | What it answers |
|---|---|---|
| 00 | **README-DUE-DILIGENCE** (this) | What is it, what's the pitch, how to navigate |
| 01 | **PRODUCT-aiko** | What does the user get; the use cases; why it beats a raw LLM for computer use |
| 02 | **ARCHITECTURE-fractal-ebm-harness** | How it works, grounded in the actual code |
| — | **THESIS-collective-nonparametric-intelligence** | The intellectual bet + the honest wall (foundation) |
| — | **ECONOMICS-cooperative-commons** | The token, the commons, the reward economics |
| 03 | **ONCHAIN-privacy-solana** | Weights on-chain, the frecency cache, the Solana moat, privacy & ZK |
| 04 | **PROOF-traction** | What is built and *proven*, with test evidence |
| 05 | **RISK-honest-wall** | The risk register — where this breaks and what must be true |
| 06 | **DUE-DILIGENCE-FAQ** | Direct answers to the diligence questions |

Start at 01 for the product, 02 for the tech, 04 for the proof, 05 for the risks.

## Status legend

Every substantive claim in this dossier is tagged:

- **BUILT+PROVEN** — code exists on the `arc-lean` branch with tests that pass in
  the build gate; verifiable by reading the source and running `zig build test`.
- **DESIGNED** — specified in detail, mechanism worked out, not yet fully built or
  not yet exercised end-to-end on production data.
- **RESEARCH-DIRECTION** — a bet or an open problem; plausible, motivated, but
  unproven at this scale. This is where the honest wall lives.

If a claim is not tagged, treat it as narrative framing, not a technical assertion.

## Where the company is, honestly

One founder, deep in a two-to-three-month build. The harness is real and running
locally; it has one-shotted tasks most agents cannot (see 04). It is **not yet
publicly released** — deliberately: the energy-based design is power-hungry and is
being contained, and the on-chain layer is being hardened. The pivot from the
original Unbrowse (a commons for agents to browse the internet) to Aiko (an agent
that "unbrowses" your *own computer's context*) is recent and partial; Unbrowse
still exists and is the sister project this inverts. This dossier documents the
Aiko direction as it stands today, with the seams visible.
