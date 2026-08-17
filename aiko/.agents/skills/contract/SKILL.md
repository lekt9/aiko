---
name: contract
description: >
  Use Aiko's native Contract substrate to register, execute, and verify durable
  outcomes. Use for any multi-step build, fix, refactor, deployment, automation,
  application interaction, or background task.
metadata:
  short-description: "Make outcomes durable and verifiable"
---

# Contract-native execution

Contract wraps an outcome; it does not replace Aiko's existing tools.

For substantive work:

1. Define one concrete outcome and a real shell check that exits zero only when
   the outcome is true.
2. Before the third tool call, run:

   ```bash
   contract task begin "<outcome>" --check "<check command>"
   ```

3. Perform the work with the best native Aiko tools.
4. Run `contract task verify <id>`.
5. Do not report completion until verification returns `satisfied`. If it
   fails, continue working and verify again.

Prefer `application_observe` and `application_act` for browser, Electron, or
desktop application work. They consume Contract's typed capability route and
record useful execution evidence.

Never use `contract declare`. Do not create explicit task rows for greetings or
trivial one-shot conversation; automatic turn grounding already covers those.
