# Harbor task benchmark

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: 2026-07-22T07:02:19.810Z

## Outcome

- aiko: 0/3 (0%)

| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |
|---|---|---|---|---|---|
| regex-log | aiko | mimo-v2.5 | FAIL | — | 106.2s |
| count-call-stack | aiko | mimo-v2.5 | FAIL | — | 170.3s |
| organization-json-generator | aiko | mimo-v2.5 | FAIL | — | 75.1s |

## Methodology

This is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit `d28711d0da2675d0bb1d56de45ae5df6082438a3`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path `/app` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after every selected harness finishes a task, preventing cross-run leakage.

aiko is pinned to `mimo-v2.5`. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication, quota, and runtime failures are reported separately and excluded from pass-rate denominators.

## Reproduce

`node scripts/benchmark-harbor-agents.mjs`

Machine-readable evidence: [AIKO-HARBOR-BUGFIX-RETEST.json](./AIKO-HARBOR-BUGFIX-RETEST.json).
