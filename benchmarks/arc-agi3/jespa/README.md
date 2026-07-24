# ARC-AGI-3 Contract/JESPA benchmark

This is an offline ARC-AGI-3 comparison, not a leaderboard result.

## Comparison

- JESPA arm: the strict-general mechanical solver with a fresh native Contract
  store, native cognitive map, capability ranking, transition observations, and
  persistent evidence.
- Baseline arm: the same solver, games, action budget, and deterministic
  structural planners, with Contract unavailable and the process-local Python
  cognitive map fallback.
- Isolation: every seed receives a new temporary `HOME`. Historical Contract
  evidence cannot enter either arm.
- Metric: completed levels first, full-game wins second, then actions used to
  reach completed levels. This follows ARC's completion-first scoring law.

## Results

| Attempt | Scope | JESPA | Baseline | Verdict |
|---|---|---:|---:|---|
| Probe | 3 games, 2 seeds, 150 actions | 8 levels | 8 levels | tie |
| Full fresh store | 25 games, 2 seeds, 500 actions | 12 levels, 314 completion actions | 12 levels, 314 completion actions | tie |
| Learn then replay | 25 games, 2 seeds, 2 rounds, 500 actions | 12 levels, 314 completion actions | 12 levels, 314 completion actions | tie |
| v0.2.103 release replay | 25 games, 2 seeds, 500 actions | no fresh result within 600s | no fresh result within 600s | witness timeout |
| Parallel witness recovery | 25 games, 2 seeds, 500 actions | 14 levels, 354 completion actions | 14 levels, 358 completion actions | JESPA wins on efficiency in 133.62s |
| Unique Contract candidates | `sp80`, 2 seeds, 500 actions | 0 levels, 60 survival actions | 0 levels, 50 survival actions | honest negative |

The full fresh-store JESPA arm made 6,726 native Contract calls. The replay
attempt made 14,092. This proves the native path was live rather than silently
falling back. Its trajectories differed on `ft09`, `lp85`, and `sb26`, but no
difference improved completed levels or their action efficiency.

## Diagnosis

The result reproduces the skill's named boundary: the proposer remains the wall.
Structural planners and local exploration act before durable Contract recall.
Contract is consulted only after the state-local cognitive map exhausts untried
actions. ARC exposes no goal state, so transition learning can distinguish
change, failure, and level progress but cannot assign useful energy to unseen
goal-directed proposals. Persistent evidence therefore changes some late
trajectories without creating the missing action hypothesis.

The honest distinct reproduced-win count is one. The v0.2.103 replay initially
exceeded the benchmark discipline's 600-second limit because four independent
arm/seed processes ran serially. Bounded concurrency now preserves isolated
stores, sequential learn/replay rounds, and deterministic report order while
reproducing the 14-level score in 133.62 seconds.

The next experiment fixed a separate Contract chokepoint bug: equivalent
objects produced duplicate coordinate-free capability IDs, causing native
catalog registration to reject the entire candidate union. Reading-order role
ordinals now keep those identities unique without persisting coordinates, and
required Contract mode fails loudly if registration is rejected. This restored
seven Contract experiments per `sp80` seed but did not clear a level. Mixed
click-and-move games still need a grounded goal relation rather than additional
unguided novelty, so that result remains an honest negative.

Run the evidence gate:

```sh
bash benchmarks/arc-agi3/jespa/arc-agi3-jespa-gate.sh
```
