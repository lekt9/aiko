# Aiko versus Grok on ARC-AGI-3

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Generated: `2026-07-22T09:45:33Z`

This is a local offline ARC-AGI-3 comparison, not a leaderboard submission. Both harnesses received the same raw frame and transition format, one fresh model turn per action, and a 3-action cap per game. Exact progress comes from the local `arc_agi` engine.

| Game | Harness | Model | Levels | Actions | Model calls | Seconds | Error |
|---|---|---|---:|---:|---:|---:|---|
| ls20 | aiko | mimo-v2.5 | 0 | 3 | 3 | 103.8 | none |
| ls20 | grok | grok-4.5 | 0 | 3 | 3 | 217.6 | none |

## Aggregate

| Harness | Games | Levels | Wins | Actions | Calls | Seconds | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|
| Aiko | 1 | 0 | 0 | 3 | 3 | 103.8 | 0 |
| Grok | 1 | 0 | 0 | 3 | 3 | 217.6 | 0 |
