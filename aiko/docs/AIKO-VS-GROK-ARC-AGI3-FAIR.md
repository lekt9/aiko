# Aiko versus Grok on ARC-AGI-3

Generated: `2026-07-22T11:58:01Z`

This is a local offline ARC-AGI-3 comparison, not a leaderboard submission. Both harnesses received the same raw frame and transition format, one fresh model turn per action, and a 1-action cap per game. Exact progress comes from the local `arc_agi` engine.

| Game | Harness | Model | Levels | Actions | Model calls | Seconds | Error |
|---|---|---|---:|---:|---:|---:|---|
| ar25 | aiko | mimo-v2.5 | 0 | 1 | 1 | 112.8 | none |
| ar25 | grok | grok-4.5 | 0 | 1 | 1 | 78.9 | none |
| cn04 | aiko | mimo-v2.5 | 0 | 1 | 1 | 30.8 | none |
| cn04 | grok | grok-4.5 | 0 | 0 | 1 | 123.2 | Error: max turns reached
 |
| su15 | aiko | mimo-v2.5 | 0 | 1 | 1 | 51.3 | none |
| su15 | grok | grok-4.5 | 0 | 0 | 1 | 300.0 | timeout after 300s |

## Aggregate

| Harness | Games | Levels | Wins | Actions | Calls | Seconds | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aiko | 3 | 0 | 0 | 3 | 3 | 194.9 | 0 |
| Grok | 3 | 0 | 0 | 1 | 3 | 502.2 | 2 |
