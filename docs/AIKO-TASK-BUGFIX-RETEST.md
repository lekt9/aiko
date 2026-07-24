# Aiko versus Grok: actual task benchmark

Generated: `2026-07-22T06:56:07.704Z`

## Fairness boundary

Each harness received an identical fresh Git repository, prompt, public tests, 12-turn limit, disabled memory/subagents/web search, and permission to edit and run local commands. Execution order alternated by task. Aiko used `mimo-v2.5`; Grok used `grok-4.5` because the installed products have no shared accessible model. With one trial per task, this is an end-to-end product comparison, not a statistically stable model leaderboard.

## Results

| Task | Harness | Model | Public tests | Hidden evaluator | Seconds | Stop reason |
|---|---|---|---|---|---:|---|
| retry-policy | aiko | mimo-v2.5 | true | true | 39.34 | EndTurn |
| retry-policy | grok | grok-4.5 | true | true | 33.09 | EndTurn |
| route-ranking | grok | grok-4.5 | true | true | 32.64 | EndTurn |
| route-ranking | aiko | mimo-v2.5 | true | true | 30.77 | EndTurn |
| secret-redaction | aiko | mimo-v2.5 | true | true | 116.23 | EndTurn |
| secret-redaction | grok | grok-4.5 | true | true | 92.93 | EndTurn |

| Harness | Tasks passed | Total agent seconds | Median task seconds |
|---|---:|---:|---:|
| Aiko | 3/3 | 186.33 | 39.34 |
| Grok | 3/3 | 158.66 | 33.09 |

## Interpretation

Task correctness is determined only by the public and hidden evaluators. Grok used 14.9% less total agent time and had a 15.9% lower median task time in this run. Non-zero agent exits are retained even when the resulting patch passes, because clean lifecycle completion is part of harness reliability.

## Tasks

1. Repair an asynchronous retry primitive with callback ordering, attempt limits, and error identity requirements.
2. Implement deterministic route ranking with filtering, scoring, tie-breaking, missing-data behavior, and immutability.
3. Harden recursive secret redaction for cycles, shared references, Dates, accessors, arrays, and non-mutation.

The raw JSON preserves each patch, evaluator status, agent exit status, response size, and timing. Hidden evaluator source was added only after the agent finished and removed after evaluation.
