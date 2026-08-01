# Aiko vs Grok on Harbor tasks

Generated: 2026-07-22T02:53:47.807Z

## Outcome

- aiko: 0/1 (0%)
- grok: 0/1 (0%)

| Task | Harness | Model | Verifier | Infrastructure issue | Agent time |
|---|---|---|---|---|---|
| count-call-stack | aiko | deepseek-v4-pro | FAIL | — | 96.5s |
| count-call-stack | grok | grok-4.5 | FAIL | — | 94.4s |

## Methodology

This is a **host-executed Harbor compatibility benchmark**, not an official container-isolated Harbor leaderboard run. It uses task definitions and deterministic pytest verifiers from Terminal-Bench commit `d28711d0da2675d0bb1d56de45ae5df6082438a3`. Each harness receives the same task in a separate fresh workspace. The compatibility adapter only rewrites Harbor's container path `/app` to that workspace and recreates fixtures described by the Dockerfile. Hidden verifier code is materialized only after both harnesses finish a task, preventing cross-run leakage.

Aiko is pinned to `deepseek-v4-pro`; Grok is pinned to `grok-4.5`. This compares the installed products as configured, so it is not a same-model harness ablation. Authentication/quota/runtime failures are reported separately and excluded from pass-rate denominators.

## Reproduce

`node scripts/benchmark-harbor-agents.mjs`

Machine-readable evidence: [AIKO-VS-GROK-HARBOR.json](./AIKO-VS-GROK-HARBOR.json).
