---
name: schedule-follow-up
description: Interpret explicit cadence and create deduplicated governed future contracts. Use when the user request matches this workflow or explicitly names $schedule-follow-up.
---

# Schedule Follow Up

Materialize this workflow through `contract-skill.json`; do not bypass Contract
with an untracked action.

1. Parse only explicit deadlines or cadence.
2. Create a held proposal when durable authority is absent.
3. Deduplicate and re-check authority when each occurrence fires.

Read `contract-skill.json` for the executable graph, effects, evidence, and
examples. Treat consequential nodes as preparation-only until Contract reports
applicable authority. Settle completion only from the declared evidence.
