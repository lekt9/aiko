# Harbor task benchmark

> **Historical.** Dated benchmark report. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: 2026-07-22T05:09:01.295Z

## Outcome

- grok: 7/7 (100%)

| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |
|---|---|---|---|---|---|
| heterogeneous-dates | grok | grok-4.5 | PASS | — | 60.0s |
| regex-log | grok | grok-4.5 | PASS | — | 282.1s |
| jsonl-aggregator | grok | grok-4.5 | PASS | — | 50.5s |
| log-summary | grok | grok-4.5 | PASS | — | 31.7s |
| log-summary-date-ranges | grok | grok-4.5 | PASS | — | 72.2s |
| count-call-stack | grok | grok-4.5 | PASS | — | 129.2s |
| organization-json-generator | grok | grok-4.5 | PASS | — | 64.2s |

## Methodology

This is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit `d28711d0da2675d0bb1d56de45ae5df6082438a3`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path `/app` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after every selected harness finishes a task, preventing cross-run leakage.

grok is pinned to `grok-4.5`. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication, quota, and runtime failures are reported separately and excluded from pass-rate denominators.

## Reproduce

`node scripts/benchmark-harbor-agents.mjs`

Machine-readable evidence: [GROK-HARBOR-ISOLATED-2026-07-22.json](./GROK-HARBOR-ISOLATED-2026-07-22.json).
