---
name: transform-local-files
description: Preview and apply explicitly scoped, reversible local file transformations. Use when the user request matches this workflow or explicitly names $transform-local-files.
---

# Transform Local Files

Materialize this workflow through `contract-skill.json`; do not bypass Contract
with an untracked action.

1. Resolve only explicitly scoped files.
2. Prepare and display a bounded diff.
3. Apply with local-write authority and verify the resulting diff.

Read `contract-skill.json` for the executable graph, effects, evidence, and
examples. Treat consequential nodes as preparation-only until Contract reports
applicable authority. Settle completion only from the declared evidence.
