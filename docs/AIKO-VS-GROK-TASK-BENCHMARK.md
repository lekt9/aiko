# Aiko versus Grok: actual task benchmark

Generated: `2026-07-22T05:18:57.443Z`

## Fairness boundary

Each harness received an identical fresh Git repository, prompt, public tests, 12-turn limit, disabled memory/subagents/web search, and permission to edit and run local commands. Execution order alternated by task. Aiko used `mimo-v2.5`; Grok used `grok-4.5` because the installed products have no shared accessible model. With one trial per task, this is an end-to-end product comparison, not a statistically stable model leaderboard.

## Results

| Task | Harness | Model | Public tests | Hidden evaluator | Seconds | Stop reason |
|---|---|---|---|---|---:|---|
| retry-policy | aiko | mimo-v2.5 | true | true | 77.40 | MaxTurns |
| retry-policy | grok | grok-4.5 | true | true | 42.86 | EndTurn |
| route-ranking | grok | grok-4.5 | true | true | 34.58 | EndTurn |
| route-ranking | aiko | mimo-v2.5 | true | false | 79.12 | EndTurn |
| secret-redaction | aiko | mimo-v2.5 | false | false | 117.72 | — |
| secret-redaction | grok | grok-4.5 | true | true | 93.69 | EndTurn |

| Harness | Tasks passed | Total agent seconds | Median task seconds |
|---|---:|---:|---:|
| Aiko | 1/3 | 274.24 | 79.12 |
| Grok | 3/3 | 171.13 | 42.86 |

## Interpretation

Task correctness is determined only by the public and hidden evaluators. Grok used 37.6% less total agent time and had a 45.8% lower median task time in this run. Non-zero agent exits are retained even when the resulting patch passes, because clean lifecycle completion is part of harness reliability.

## Tasks

1. Repair an asynchronous retry primitive with callback ordering, attempt limits, and error identity requirements.
2. Implement deterministic route ranking with filtering, scoring, tie-breaking, missing-data behavior, and immutability.
3. Harden recursive secret redaction for cycles, shared references, Dates, accessors, arrays, and non-mutation.

The raw JSON preserves each patch, evaluator status, agent exit status, response size, and timing. Hidden evaluator source was added only after the agent finished and removed after evaluation.
