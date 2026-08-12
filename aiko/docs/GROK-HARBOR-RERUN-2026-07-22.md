# Aiko vs Grok on Harbor tasks

> **Historical.** Dated benchmark report. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: 2026-07-22T04:47:44.864Z

## Outcome

- aiko: 0/7 (0%)
- grok: 7/7 (100%)

| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |
|---|---|---|---|---|---|
| heterogeneous-dates | aiko | mimo-v2.5 | FAIL | — | 0.0s |
| heterogeneous-dates | grok | grok-4.5 | PASS | — | 39.8s |
| regex-log | aiko | mimo-v2.5 | FAIL | — | 0.0s |
| regex-log | grok | grok-4.5 | PASS | — | 82.6s |
| jsonl-aggregator | aiko | mimo-v2.5 | FAIL | — | 0.0s |
| jsonl-aggregator | grok | grok-4.5 | PASS | — | 50.1s |
| log-summary | aiko | mimo-v2.5 | FAIL | — | 0.0s |
| log-summary | grok | grok-4.5 | PASS | — | 32.5s |
| log-summary-date-ranges | aiko | mimo-v2.5 | FAIL | — | 0.0s |
| log-summary-date-ranges | grok | grok-4.5 | PASS | — | 52.3s |
| count-call-stack | aiko | mimo-v2.5 | FAIL | — | 0.0s |
| count-call-stack | grok | grok-4.5 | PASS | — | 90.9s |
| organization-json-generator | aiko | mimo-v2.5 | FAIL | — | 0.0s |
| organization-json-generator | grok | grok-4.5 | PASS | — | 80.2s |

## Methodology

This is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit `d28711d0da2675d0bb1d56de45ae5df6082438a3`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path `/app` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after both harnesses finish a task, preventing cross-run leakage.

Aiko is pinned to `mimo-v2.5`; Grok is pinned to `grok-4.5`. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication/quota/runtime failures are reported separately and excluded from pass-rate denominators.

## Reproduce

`node scripts/benchmark-harbor-agents.mjs`

Machine-readable evidence: [AIKO-VS-GROK-HARBOR.json](./AIKO-VS-GROK-HARBOR.json).
