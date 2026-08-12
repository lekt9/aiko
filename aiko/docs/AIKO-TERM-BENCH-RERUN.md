# Harbor task benchmark

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: 2026-08-03T17:38:34.449Z

## Outcome

- aiko: 3/5 (60%)

| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |
|---|---|---|---|---|---|
| heterogeneous-dates | aiko | deepseek-v4-pro | FAIL | — | 302.5s |
| regex-log | aiko | deepseek-v4-pro | PASS | — | 600.1s |
| log-summary | aiko | deepseek-v4-pro | PASS | — | 248.5s |
| count-call-stack | aiko | deepseek-v4-pro | PASS | — | 474.7s |
| organization-json-generator | aiko | deepseek-v4-pro | FAIL | — | 550.6s |

## Methodology

This is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit `d28711d0da2675d0bb1d56de45ae5df6082438a3`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path `/app` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after every selected harness finishes a task, preventing cross-run leakage.

aiko is pinned to `deepseek-v4-pro`. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication, quota, and runtime failures are reported separately and excluded from pass-rate denominators.

## Reproduce

`node scripts/benchmark-harbor-agents.mjs`

Machine-readable evidence: [AIKO-TERM-BENCH-RERUN.json](./AIKO-TERM-BENCH-RERUN.json).
