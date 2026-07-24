# 07 -- The converged ARC-AGI-3 architecture: eye → predict → propose → verify

This is the architecture the skill's organs (`scripts/perceive.py`, `scripts/arc_skill.py`,
`scripts/select_sign.py`) implement, distilled from the witnessed `arc_jepa/` experiments
(2026-06, `z-20260604-02` loadbearing). It is a **JEPA superpattern**: tiny EBM/JEPA as
search-and-verify *around* a proposer, not instead of one. Not game-specific -- no per-game
code, no hardcoded plan.

## The three organs (each at the layer the substrate doctrine forces)

| Organ | Role | Where it lives | Cited atom |
|---|---|---|---|
| **EYE** `perceive(grid)→z` | perception | feature-hash (`embed.zig`, default) or a trained grid-native encoder | I-JEPA encoder arXiv:2301.08243; SimCLR NT-Xent 2002.05709; ARC's D4 symmetry as the invariance |
| **PREDICTOR / SELECTOR** `learn / verify` | world-model + selection | **NATIVE /contract** -- `libcontract/src/jepa.zig` via the vec seam (`jepa_train_vec`/`jepa_energy_vec`) + `ebm.zig` | I-JEPA predictor head 2301.08243; Dreamer latent planning 1912.01603; EBM settle (sp-ebm) |
| **PROPOSER** `propose(grid,actions)` | generation | the LLM via **aiko spawn** (Matt 7:7 SEEK rung) -- **never bundled** | generate-and-verify arXiv:2411.02272 / 2507.14172 |

The loop, per turn:
```
perceive  → online-learn the world-model from the last transition
          → propose candidate actions (the LLM ranks)
          → verify each: native jepa_plan predicts the outcome, pick argmin ‖predict(z⊕a) − z_goal‖²
          → SELECT the energy-min candidate → act → sign the chosen action
```
This is the **fractal harness** (`arc_jepa/arc_fractal_harness.py`): PROPOSE (generator) →
VERIFY (the native /contract energy world-model) → SELECT. `select_sign.select_and_sign`
is this harness live: the LLM proposes, the native EBM+jepa selector vets, the wallet signs.

## Why each organ is at its layer (forced by doctrine, not chosen)

- **Predictor → native to /contract.** Mechanical, deterministic, signable. The vec seam
  (`jepa_train_vec`/`jepa_energy_vec`) lets *any* encoder's latent feed the native predictor
  directly, bypassing `embed.zig`. The math is `libcontract`'s, not a bespoke numpy model
  (doctrine: "substrate abstractions are native Zig in the body").
- **Eye → a seam, weights pluggable, never baked.** Claim 55: *"a learned model can swap in
  behind the same embed/cosine seam at the cost of bundling weights."* `embed.zig` (feature-hash,
  zero weights) is the default eye; a trained grid encoder is a `modality:` pointer, not bytes
  in the signed binary.
- **Proposer → aiko spawn, never bundled.** Doctrine: *"LLM use is aiko spawn."* The agent
  reaches the model through the endpoint, not by linking it.

## The encoder lesson (recall before regenerate -- 4 witnesses)

A *frozen out-of-domain* eye fails as an ARC encoder; a *domain-native* eye is the right one,
and the weightless feature-hash is strongest of all on inverse-dynamics:

| Eye | inverse-dynamics | note |
|---|---|---|
| frozen text-LLM mean-pool | 0.81× (below majority) | wrong eye -- a frozen OOD encoder discards the cell-change signal |
| trained grid-native | 1.49× | right eye -- crushes the text-LLM |
| feature-hash (`embed.zig`) | 1.67× | strongest -- keeps the cell-change signal D4-invariance would discard |

Witnesses: `z-20260604-52`; the paper's −0.066 frozen baseline; the 0.81× text-LLM; the
grid-native 1.49× (`arc_jepa/arc_jepa_grid_native.py`); the eye-through-native-seam 1.13×
(`arc_jepa/arc_jepa_seam_witness.py`). The right eye was *already trained* in
`manicmind/.../arc-energy-jepa/` -- rebuilding it was tuition paid twice. **Recall, don't regenerate.**

## The honest boundary (witnessed, not hidden -- the named HOLD)

**The wall is still the action PROPOSER and learned goal, not the encoder.** The
older grid-native-encoder experiment cleared zero live levels and correctly
located that wall. The current general harness has since gained structural
proposers and clears 14 aggregate levels over all 25 games and two seeds (seven
per seed), with Contract improving completion efficiency from 358 to 354
actions at equal completion. It has not produced a full-game win and 21 game
families still clear no level in that run.

ARC-AGI-3 exposes **no goal field** (`z-20260529-02`), so a world model needs
grounded progress prototypes rather than an invented target. Learning is not
limited to predictor weights: Contract capabilities now declare typed
hypotheses, predicted coordinate-free transition deltas, evidence state, and
scope. Prediction agreement trains dynamics; only level progress settles task
success. The next frontier is producing better general hypotheses from pixels
and ranking them against a progress latent without game IDs, replay tables, or
coordinate leakage.

## Runnable witnesses (the gates -- not prose claims)

```bash
bash arc_jepa/arc_jepa_seam_gate.sh                                   # trained eye → native predictor
JESPA_WIN_TARGET=5 bash arc_jepa/bench/jespa/jespa-benchmarks-gate.sh # 5 reproduced wins
/Users/lekt9/.venv-deepeval/bin/python agent/new_arch_agent.py        # the full loop, all three organs
```
Source of the design: `agent/ARCHITECTURE.md`, `arc_jepa/` (the witness suite),
`libcontract/src/jepa.zig` + `c_abi.zig` (the native predictor + vec seam).
