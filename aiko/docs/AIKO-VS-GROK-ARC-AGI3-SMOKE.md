# Aiko versus Grok on ARC-AGI-3

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: `2026-07-22T09:39:30Z`

This is a local offline ARC-AGI-3 comparison, not a leaderboard submission. Both harnesses received the same raw frame and transition format, one fresh model turn per action, and a 1-action cap per game. Exact progress comes from the local `arc_agi` engine.

| Game | Harness | Model | Levels | Actions | Model calls | Seconds | Error |
|---|---|---|---:|---:|---:|---:|---|
| ls20 | aiko | mimo-v2.5 | 0 | 1 | 1 | 131.7 | none |
| ls20 | grok | grok-4.5 | 0 | 0 | 1 | 36.6 | Error: max turns reached
 |

## Aggregate

| Harness | Games | Levels | Wins | Actions | Calls | Seconds | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aiko | 1 | 0 | 0 | 1 | 1 | 131.7 | 0 |
| Grok | 1 | 0 | 0 | 0 | 1 | 36.6 | 1 |
