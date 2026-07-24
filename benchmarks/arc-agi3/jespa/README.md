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

The honest reproduced-win count is zero. All three attempts are retained in
`benchmarks-ledger.jsonl`; none is relabeled as a routing or systems win.

Later work reached a stored 14-level tie with a four-action Contract advantage,
but the v0.2.103 release replay exceeded the benchmark discipline's 600-second
limit. The release therefore reports that score as historical evidence and
does not count a current reproduced ARC win.

Run the evidence gate:

```sh
bash benchmarks/arc-agi3/jespa/arc-agi3-jespa-gate.sh
```
