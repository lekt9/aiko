# PLAN — Aiko Due-Diligence Documentation Suite

GOAL: Purge outdated dev-internal docs and write a thorough, honest,
investor-ready due-diligence suite for **Aiko** — the contract/aiko fractal-EBM
energy harness — grounded in the ACTUAL codebase (arc-lean), building on
`THESIS-collective-intelligence.pdf`, covering the product pitch (reliable /
private / powerful), the architecture, the economics, the on-chain/privacy story,
the proof/traction, the risk register, and a DD-FAQ that answers the VC's
questions from the 2nd-round transcript.

NORTH STAR: Compelling AND honest — the substrate's own tradition ("state the
limits as loudly as the vision, or it's marketing"). Every claim carries a
build-status label (BUILT+PROVEN / DESIGNED / RESEARCH-DIRECTION). Never present
an unbuilt thing (ZK credential binding, EBLLM benchmark claims, full on-chain
weights) as done. These are CONFIDENTIAL DD docs (founder: "don't share") — files
only, never published artifacts.

## Purge (outdated, dev-internal, superseded)
- docs/journal.md               (benchmark journal — internal)
- docs/observations-fractal-loop.md  (3088-line raw mid-build log, 2026-05-26)
- docs/MASTER-PLAN-contract-neuron-abstraction-arc-agi3.md (superseded plan)
- keep docs/bench.sh (a tool, not a doc)

## Grounding sources
- THESIS PDF (the bet: intelligence = retrieval + routing + verification over a
  live index; lean/private/realtime/collective; the honest wall).
- VC 2nd-round transcript (core product/customer/differentiation/moat/benchmark).
- Aiko pitch copy (laptop agent; reliable EBLLM; private on-chain weights + ZK;
  powerful learn-as-it-works).
- The arc-lean codebase I built this session (energy router, cas, reward/usage/
  epoch commons, voltr staking, broadcast tool — all with tests).

# LAYERS

## Layer 1 — Purge & Foundation
Delete the superseded dev logs. Write `00-README-DUE-DILIGENCE.md` (entry point:
what Aiko is, the one-paragraph pitch, the three pillars, the doc map,
confidentiality). Refresh `THESIS` so it matches the PDF exactly and cross-links
the suite.

## Layer 2 — Architecture & Product
`02-ARCHITECTURE-fractal-ebm-harness.md` — the harness technically, grounded in
real files (embed/ebm energy router, fractal keys, train-on-fire, the contract
substrate, ledger-reconstructible weights, the non-parametric grounding). Mark
built vs designed. `01-PRODUCT-aiko.md` — the laptop agent: use cases (Telegram
triage, restaurant booking), the harness that one-shots tasks (the wine/Overwatch
first-principles story), the small grounded model, why it beats raw frontier LLMs
for computer use.

## Layer 3 — Economics & On-chain
Keep/refresh `ECONOMICS-cooperative-commons.md`. Write `03-ONCHAIN-privacy-solana.md`
— weights on-chain, the frecency cache, the Solana moat ("product pays itself via
SOL volume"), and privacy: envelope encryption + receptor grant (real) vs ZK
credential binding + query privacy (DESIGNED/RESEARCH — honestly labelled).

## Layer 4 — Proof, Risk & FAQ
`04-PROOF-traction.md` — what's BUILT+PROVEN with test evidence (energy router
2-vs-3, cas, the commons loop, voltr real mainnet vault, broadcast cluster-valid,
ARC-AGI attempt). `05-RISK-honest-wall.md` — the DD risk register (verification
crux, energy containment, single-user vs commons, ZK unsolved, moat honesty,
"superintelligence is a bet"). `06-DUE-DILIGENCE-FAQ.md` — direct answers to the
VC's transcript questions. Final layer fires SHIPPED.
