# Aiko cancellation lifecycle fix

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Status: **PASS**

## Failure

The original `secret-redaction` benchmark produced a correct patch and passing tests, but exited 1 with `stopReason: "Cancelled"`. The exported session showed that the agent exhausted the explicit 12-turn budget by performing redundant verification and never reached a normal final response.

Two separate defects were involved:

1. Headless output mapped max-turn exhaustion to ACP's generic `Cancelled` stop reason, making a harness limit look like user cancellation.
2. The system prompt did not explain that every individual tool invocation consumes the turn budget, and the model could imitate unavailable goal-tool markup after finishing its work.

## Repair

- Headless JSON now reports `MaxTurns` when response metadata identifies `max_turns_reached`.
- The system prompt requires proportional verification, preserves budget for the final response, forbids re-reading unchanged files after authoritative tests pass, and forbids inventing unavailable tools or printing tool-call markup.
- Prompt-template and headless regression assertions cover these rules.

## Verification

Built and installed Aiko 0.2.102 at `/Users/lewis/bin/aiko` with the bundled Contract runtime.

### Deterministic max-turn probe

- Limit: 1 turn
- Process result: exit 1 (expected limit failure)
- JSON stop reason: `MaxTurns`
- Result: PASS — no false user-cancellation label

### Original task, fresh baseline

- Task: `secret-redaction`
- Model: `mimo-v2.5`
- Limit: 12 turns
- Process result: exit 0
- JSON stop reason: `EndTurn`
- Turns used: 10
- Elapsed: 114 seconds
- Public test: PASS
- Hidden evaluator (cycles, shared references, Dates, accessors, redaction): PASS

The response still contained inert model-authored `<tool_call>update_goal` text before its real final answer. It was not executed and no longer prevented completion. Treating or stripping malformed model text at the protocol layer is a separate presentation-hardening task.
