# Aiko vs Grok: isolated Harbor rerun

Generated: 2026-07-22T05:10:36.552Z

- Aiko: 4/7 (57%)
- Grok: 7/7 (100%)

| Task | Harness | Model | Verifier | Agent time |
|---|---|---|---|---|
| count-call-stack | aiko | mimo-v2.5 | FAIL | 112.3s |
| count-call-stack | grok | grok-4.5 | PASS | 129.2s |
| heterogeneous-dates | aiko | mimo-v2.5 | PASS | 41.0s |
| heterogeneous-dates | grok | grok-4.5 | PASS | 60.0s |
| jsonl-aggregator | aiko | mimo-v2.5 | PASS | 32.5s |
| jsonl-aggregator | grok | grok-4.5 | PASS | 50.5s |
| log-summary | aiko | mimo-v2.5 | PASS | 29.1s |
| log-summary | grok | grok-4.5 | PASS | 31.7s |
| log-summary-date-ranges | aiko | mimo-v2.5 | PASS | 49.4s |
| log-summary-date-ranges | grok | grok-4.5 | PASS | 72.2s |
| organization-json-generator | aiko | mimo-v2.5 | FAIL | 63.0s |
| organization-json-generator | grok | grok-4.5 | PASS | 64.2s |
| regex-log | aiko | mimo-v2.5 | FAIL | 158.0s |
| regex-log | grok | grok-4.5 | PASS | 282.1s |

Each harness ran in a separate preserved workspace root. This is a host-executed Harbor compatibility run, not an official container-isolated leaderboard submission. Hidden verifiers were materialized only after the selected harness completed each task.

Machine-readable evidence: [AIKO-VS-GROK-HARBOR-RERUN-2026-07-22.json](./AIKO-VS-GROK-HARBOR-RERUN-2026-07-22.json).
