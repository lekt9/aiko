# Aiko malformed tool-output recovery

> **Historical.** Dated report or retest log. Not current product documentation. What the tree is today: [../../docs/SOURCE-OF-TRUTH.md](../../docs/SOURCE-OF-TRUTH.md).

Status: PASS

## Problem

MiMo could occasionally emit legacy XML such as `<tool_call><function=update_goal>…` as assistant prose. The named tool was not available and the block was not executable, but it polluted JSON responses and made a successful run look broken.

## Fix

The headless response boundary now removes complete, model-authored `<tool_call>…</tool_call>` blocks before producing final JSON. Typed ACP tool events remain untouched. Incomplete tags and ordinary explanatory examples remain untouched so code-oriented answers are not silently corrupted.

The system prompt also tells the model to use only available tools, never imitate tool-call markup, budget every individual tool invocation, and answer immediately after sufficient authoritative verification.

## Verification

- Release build: PASS
- Installed CLI: `/Users/lewis/bin/aiko` (`0.2.102`)
- Installed Contract runtime: `/Users/lewis/.aiko/lib/libcontract.dylib`
- Live malformed-markup probe: no `<tool_call>` or `<function=` escaped in JSON
- Max-turn classification probe: reports `MaxTurns`, not `Cancelled`
- Full actual-task benchmark: PASS
  - Aiko: 3/3 tasks, all exit 0 with `EndTurn`
  - Grok: 3/3 tasks, all exit 0 with `EndTurn`
  - Aiko total: 196.28 seconds; median: 67.17 seconds
  - Grok total: 173.33 seconds; median: 58.77 seconds
  - No malformed tool markup in any recorded response
- `git diff --check`: PASS

The optional macOS launch-service bootstrap returned error 5 after one installer invocation. The binary and Contract runtime were installed successfully and all direct CLI benchmark runs completed. Launch-service registration remains a separate installer issue.
