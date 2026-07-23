---
name: build-and-test-project
description: Detect a project toolchain and run bounded builds and tests with exact exit evidence. Use when the user request matches this workflow or explicitly names $build-and-test-project.
---

# Build And Test Project

Materialize this workflow through `contract-skill.json`; do not bypass Contract
with an untracked action.

1. Compose with inspect-project to identify the toolchain.
2. Prepare exact build and test commands before execution.
3. Run safe independent checks concurrently and report exit evidence.

Read `contract-skill.json` for the executable graph, effects, evidence, and
examples. Treat consequential nodes as preparation-only until Contract reports
applicable authority. Settle completion only from the declared evidence.
