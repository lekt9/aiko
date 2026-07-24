# Aiko engine3 ARC-AGI-3 replication

## Outcome

The retained engine3 peak was real, but it was a hybrid result rather than the native
Contract/cognitive-map controller acting alone.

- Retained v62 scorecard: 50 levels across 21 of 25 public games, 1,942 actions.
- Reproduced structural controller: 6 levels across 3 games in the same public suite.
- Reproduced clears: `r11l=1`, `tn36=1`, `sb26=4`.
- Recorded-action replay: none in either run.

The machine-readable reproduction is in
`docs/AIKO-ARC-AGI3-ENGINE3-REPLICATION.json`.

## What blocked the current controller

The current benchmark runner unconditionally removed `ARC_LEGACY_HEURISTICS` before
importing the solver. That disabled engine3's frame-derived paint and region planners.
The runner now exposes these explicitly as `--historical-structural` and labels the
result separately from strict-general evaluation.

That restores the deterministic six-level floor, but not the full v62 result. The v62
Kaggle log proves that its Qwopus/Qwen-family 35B-A3B int4 model successfully booted in
vLLM and that `_ask_aiko` repeatedly invoked the Aiko CLI for unresolved frames. The
current native benchmark forces `ARC_MECHANICAL=1`, so that proposer is deliberately
absent. The remaining gap is therefore primarily the missing capable proposer, not a
missing replay table or an absent cognitive map.

## Replication architecture

```text
frame
  -> deterministic perception
  -> interaction-class router
       -> paint planner ---------+
       -> region planner/sweep --+--> action
       -> cognitive map ---------+
       -> model proposer -> EBM selector/signature
  -> observed transition/reward
  -> Contract evidence + cognitive-map update
```

## Correct next experiment

Run the hybrid controller with the requested DeepSeek v4 Pro provider as the proposer,
while retaining Contract as selector/evidence memory. Compare three isolated arms on
the same seeds and action cap:

1. strict-general mechanical;
2. engine3 structural mechanical;
3. engine3 structural + DeepSeek v4 Pro proposer.

Do not describe arm 3 as a native-Contract result. Contract ranks and records; the model
supplies semantic hypotheses. Promotion should require improvement on held-out games or
versions, not only the 25 public environments used during development.

## Reproduction command

```sh
/Users/lewis/Unbrowse/ARC-AGI-3-Agents/.venv/bin/python \
  .agents/skills/arc-agi-3/scripts/benchmark_native.py \
  --historical-structural --games all --max-actions 80 \
  --output docs/AIKO-ARC-AGI3-ENGINE3-REPLICATION.json
```
