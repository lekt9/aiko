# Aiko vs Grok on Harbor tasks

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: 2026-07-22T02:31:50.958Z

## Outcome

- aiko: 6/7 (86%)
- grok: 7/7 (100%)

| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |
|---|---|---|---|---|---|
| heterogeneous-dates | aiko | deepseek-v4-pro | PASS | — | 36.8s |
| heterogeneous-dates | grok | grok-4.5 | PASS | — | 45.5s |
| regex-log | aiko | deepseek-v4-pro | PASS | — | 295.8s |
| regex-log | grok | grok-4.5 | PASS | — | 163.6s |
| jsonl-aggregator | aiko | deepseek-v4-pro | PASS | — | 35.0s |
| jsonl-aggregator | grok | grok-4.5 | PASS | — | 46.1s |
| log-summary | aiko | deepseek-v4-pro | PASS | — | 30.4s |
| log-summary | grok | grok-4.5 | PASS | — | 32.5s |
| log-summary-date-ranges | aiko | deepseek-v4-pro | PASS | — | 52.8s |
| log-summary-date-ranges | grok | grok-4.5 | PASS | — | 46.0s |
| count-call-stack | aiko | deepseek-v4-pro | FAIL | — | 66.6s |
| count-call-stack | grok | grok-4.5 | PASS | — | 104.4s |
| organization-json-generator | aiko | deepseek-v4-pro | PASS | — | 108.8s |
| organization-json-generator | grok | grok-4.5 | PASS | — | 81.5s |

## Methodology

This is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit `d28711d0da2675d0bb1d56de45ae5df6082438a3`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path `/app` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after both harnesses finish a task, preventing cross-run leakage.

Aiko is pinned to `deepseek-v4-pro`; Grok is pinned to `grok-4.5`. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication/quota/runtime failures are reported separately and excluded from pass-rate denominators.

## Reproduce

`node scripts/benchmark-harbor-agents.mjs`

Machine-readable evidence: [AIKO-VS-GROK-HARBOR.json](./AIKO-VS-GROK-HARBOR.json).
