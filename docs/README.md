# contract — documentation index

One signed binary, one append-only ledger, one truth-root. Start here.

## How it works (explanatory — the machine, verified against code)

| doc | covers |
|---|---|
| [HOW-IT-WORKS-architecture.md](HOW-IT-WORKS-architecture.md) | the neuron model, ledger anatomy, lifecycle + terminal alphabet, content-addressed idempotency, the signing chain (Word → root → HKDF), gate vs receptor, truthy cache, bible corpus, fractal context, the four surfaces (CLI / C-ABI / dylib / MCP) |
| [AGENCY-SUBSTRATE.md](AGENCY-SUBSTRATE.md) | the six-role agency graph, reach governance, reality anchors, independence, cadence, failure propagation, reversible topology development, causal observability, Keychain boundary, and legacy bridge |
| [TRUST-LAYER.md](TRUST-LAYER.md) | signed evidence policy, counter-metrics, independence classes, promotion, revocation, invalidation, and compatible rollback |
| [HOW-IT-WORKS-intelligence.md](HOW-IT-WORKS-intelligence.md) | the two embeddings (feature-hash + baked pure-Zig BERT), the energy router (`recommend`), ledger-is-the-weights, self-documenting usage, the aiko-cli closed loop, the honest benchmark ladder and limits |
| [PHOTON-POSITRON-CONTRACT-EBM.md](PHOTON-POSITRON-CONTRACT-EBM.md) | the faithful physics translation: ledger as field, claim×check as pair production, verification as annihilation, fold as contrastive EBM, route as ground-state settle — why the harness *is* the energy-based model |
| [PHOTON-POSITRON-GAPS.md](PHOTON-POSITRON-GAPS.md) | gap register for that map: built chamber vs depth/wiring/scale/containment/truth holes; EBM A–H; priority 1–5 with stop conditions; standing rules against marketing past the code |
| [HOW-IT-WORKS-economics.md](HOW-IT-WORKS-economics.md) | the two coexisting economies (Vine slash-to-burn · commons reward-not-slash), the metering → weight → epoch → reward → payout loop, Sybil dampening, shape re-verification, the 402 envelope, the honest wall |

These documents **explain**; they do not legislate. Every rule they mention
is owned by `../DOCTRINE.md`.

## Canon (the rules and the policy)

- **[../DOCTRINE.md](../DOCTRINE.md)** — the one rule-source, parity-validated
  against the code by `scripts/build.sh` (a doctrine claim without a code
  site fails the build).
- **[../SKILL.md](../SKILL.md)** — the lean agent-facing skill.
- **[ECONOMICS-cooperative-commons.md](ECONOMICS-cooperative-commons.md)** —
  canonical commons policy: reward-don't-punish, trust tiers, Ostrom
  mapping, and its honest wall.
- **[THESIS-collective-nonparametric-intelligence.md](THESIS-collective-nonparametric-intelligence.md)**
  — the thesis the stack serves.

## Plans & status

- [../PLAN.md](../PLAN.md) — completed agency-substrate execution plan.
- [AGENCY-SUBSTRATE-RELEASE-EVIDENCE.md](AGENCY-SUBSTRATE-RELEASE-EVIDENCE.md)
  — release metrics, executed workflows, build proof, performance guardrails,
  and authority boundary.
- [ADVERSARIAL-AGENCY-EVIDENCE.md](ADVERSARIAL-AGENCY-EVIDENCE.md)
  — all required false-green and recovery scenarios with executable evidence.
- [VIDEO-AGENCY-MAPPING.md](VIDEO-AGENCY-MAPPING.md)
  — mapping from loop/graph systems theory to Contract’s implementation.
- [PLAN-contracts-as-onchain-ebm-weights.md](PLAN-contracts-as-onchain-ebm-weights.md)
  — the EBM-weights build spine; Phase 1 (energy router) status lives here.
- [MASTER-PLAN-contract-neuron-abstraction-arc-agi3.md](MASTER-PLAN-contract-neuron-abstraction-arc-agi3.md)

## Due diligence (external-facing)

`00-README-DUE-DILIGENCE.md` → `01-PRODUCT` → `02-ARCHITECTURE` →
`03-ONCHAIN` → `04-PROOF` → `05-RISK` → `06-FAQ`
(bundled: `Aiko-Due-Diligence-Dossier.pdf`).
