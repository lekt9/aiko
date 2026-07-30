# `/contract` A/B benchmark — durable leased job queue

Date: 2026-07-20

## Task

Repair a multi-file SQLite job queue with durable idempotency, atomic claims
across independent instances, unpredictable expiring lease tokens, stale-token
rejection, heartbeat extension, exponential retry, dead-lettering, malformed
payload handling, and restart recovery.

The starter passed 1/4 visible tests and only 3/12 hidden tests.

## Design

- Three matched pairs from the same baseline commit.
- Pair order: control-first, treatment-first, control-first.
- Ephemeral Codex sessions with identical model/config isolation and workspace
  sandboxing.
- Control was prohibited from using `/contract`.
- Treatment used the explicit `task begin -> status -> verify -> status`
  lifecycle.
- The 12-test evaluator remained outside every agent workspace.
- After primary scoring, every submission ran the complete hidden suite 20
  additional times to stress nondeterministic SQLite claim races.

## Per-run results

| Pair | Arm | Hidden | Visible | Time | Input | Uncached input | Output | Reasoning | Commands |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | without | 12/12 | 12/12 | 152.91 s | 226,202 | 31,386 | 6,218 | 802 | 5 |
| 1 | with | 12/12 | 10/10 | 137.72 s | 202,168 | 24,504 | 6,091 | 781 | 12 |
| 2 | without | 12/12 | 11/11 | 125.28 s | 214,466 | 30,402 | 5,112 | 721 | 7 |
| 2 | with | 12/12 | 10/10 | 149.53 s | 311,205 | 25,253 | 6,078 | 768 | 10 |
| 3 | without | 12/12 | 12/12 | 134.27 s | 149,831 | 19,783 | 5,636 | 536 | 6 |
| 3 | with | 12/12 | 9/9 | 137.48 s | 215,267 | 19,427 | 5,440 | 695 | 13 |

## Aggregate

| Metric | Without `/contract` | With `/contract` | Treatment delta |
|---|---:|---:|---:|
| Hidden correctness | 36/36 | 36/36 | tied |
| 20x stress repeats | 60/60 suites | 60/60 suites | tied |
| Mean wall time | 137.49 s | 141.58 s | +2.97% |
| Total input tokens | 590,499 | 728,640 | +23.39% |
| Cached input tokens | 508,928 | 659,456 | +29.58% |
| Uncached input tokens | 81,571 | 69,184 | -15.19% |
| Output tokens | 16,966 | 17,609 | +3.79% |
| Reasoning tokens | 2,059 | 2,244 | +8.98% |
| Command executions | 18 | 35 | +94.44% |

Each treatment task independently recorded:

```text
declared -> iterated -> satisfied
```

and its project-local activity log recorded both `task.verify.start` and
`task.verify.satisfied`.

## Interpretation

The upgraded `/contract` is operationally sound: it no longer causes help
mutations, it works inside the sandbox, and it produces replayable evidence
that the declared verification command actually passed.

It did not improve implementation correctness in this experiment. All six
agents solved the task and survived repeated concurrency stress. The treatment
added only 3% mean wall time, but nearly doubled command count and increased
total context through cached-token replay. Interestingly, uncached input fell
15%, suggesting that the explicit lifecycle may have replaced some novel
orientation with repeated cached context; three samples are too few to treat
that as established.

The limiting factor is now experimental, not task difficulty. A complete
one-turn specification plus visible tests lets the model build its own internal
control loop. `task begin` and `task verify` add durable evidence but no
independent watcher, counter-metric, or new information, so a correctness uplift
should not be expected.

The next discriminating experiment should be longitudinal: interrupt the task,
start a fresh agent with no conversation history, inject a failed or misleading
intermediate result, and measure whether contract replay improves handoff,
recovery, and resistance to false completion.
