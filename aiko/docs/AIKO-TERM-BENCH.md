# Harbor task benchmark

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: 2026-08-03T22:29:44.134Z

## Outcome

- aiko: 7/7 (100%)

| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |
|---|---|---|---|---|---|
| heterogeneous-dates | aiko | deepseek-v4-pro | PASS | — | 25.9s |
| regex-log | aiko | deepseek-v4-pro | PASS | — | 171.2s |
| jsonl-aggregator | aiko | deepseek-v4-pro | PASS | — | 39.2s |
| log-summary | aiko | deepseek-v4-pro | PASS | — | 17.9s |
| log-summary-date-ranges | aiko | deepseek-v4-pro | PASS | — | 61.6s |
| count-call-stack | aiko | deepseek-v4-pro | PASS | — | 58.2s |
| organization-json-generator | aiko | deepseek-v4-pro | PASS | — | 64.8s |

## Methodology

This is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit `d28711d0da2675d0bb1d56de45ae5df6082438a3`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path `/app` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after every selected harness finishes a task, preventing cross-run leakage.

aiko is pinned to `deepseek-v4-pro`. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication, quota, and runtime failures are reported separately and excluded from pass-rate denominators.

## Reproduce

`node scripts/benchmark-harbor-agents.mjs`

Machine-readable evidence: [AIKO-TERM-BENCH.json](./AIKO-TERM-BENCH.json).
