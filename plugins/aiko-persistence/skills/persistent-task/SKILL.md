---
name: persistent-task
description: >-
  Persist through long, multi-step, autonomous, or open-ended tasks until a
  runnable completion witness passes. Use automatically when work requires
  several implementation and verification cycles, the user says keep going,
  finish it, do not stop, handle everything, work autonomously, or when a task
  is likely to outlast one straightforward pass. Do not use for simple answers,
  reviews, explanations, status checks, or tasks waiting on a required user choice.
metadata:
  short-description: Finish long tasks against real evidence
---

# Persistent task

Keep the task inside the active Aiko turn. Do not end merely because one work
unit finished or because a partial result is present.

## Start

1. State the concrete outcome in one sentence.
2. Choose the strongest runnable witness available: focused tests, build,
   validator, query, or an exact state inspection. A witness must fail before
   completion and pass only when the requested outcome is genuinely true.
3. Arm local progress state:

```bash
python3 "${GROK_PLUGIN_ROOT}/scripts/persistent_task.py" arm \
  --goal "<outcome>" --check "<witness command>"
```

If no honest machine witness exists, use `--manual` and define explicit review
criteria in the goal. Never invent a command that only prints success.

## Work cycle

Repeat until the witness passes:

1. Inspect the current state and select the smallest meaningful unfinished unit.
2. Implement that unit on real paths and data.
3. Run focused verification, then run the completion witness:

```bash
python3 "${GROK_PLUGIN_ROOT}/scripts/persistent_task.py" check
```

4. Record a short progress note:

```bash
python3 "${GROK_PLUGIN_ROOT}/scripts/persistent_task.py" note "<what changed and evidence>"
```

5. If the same failure repeats twice, change method: inspect a different seam,
   reduce scope, reproduce more narrowly, or use an independent verifier.

Use subagents only when the task naturally divides into independent work. Keep
external writes and destructive actions within the user's authorization.

## Exit conditions

- Machine witness exits 0: remove state with `persistent_task.py complete` and
  report the evidence.
- User cancels: run `persistent_task.py cancel`.
- A required decision, credential, approval, or external state blocks progress:
  preserve state, report the exact blocker, and ask only for what is necessary.
- Manual mode: evaluate every stated criterion explicitly, then complete. Do not
  use a completion phrase as evidence.

Never claim completion while the witness is red. Never spin on unchanged output;
adapt or surface a genuine blocker.
