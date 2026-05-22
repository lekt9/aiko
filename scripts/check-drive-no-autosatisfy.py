#!/usr/bin/env python3
"""Guard: the contract drive loop must never auto-satisfy.

`contract drive` may iterate and re-fire the agent turbo (no human pause),
but it must NOT mark any contract satisfied itself, and `_mark satisfied`
must NOT fabricate an `agent_verdict='genuine'` iteration row. Satisfaction
is the agent's KEY-2 call, recorded only by an explicit agent mark.

Exits 0 when the CLI is clean, 1 (with the violations) otherwise.
This is a permanent regression guard — emits evidence; the agent judges.
"""
import os
import sys

cli = os.path.expanduser("~/.claude/skills/contract/scripts/contract")
src = open(cli).read()

violations = []
if "'pass', 'genuine'" in src:
    violations.append("_mark still fabricates record_iteration(..., 'genuine')")
if '_mark "$NEXT_ID" satisfied' in src:
    violations.append("drive verb still auto-marks the iterated leaf")
if '_mark "$BUBBLE_TARGET" satisfied' in src:
    violations.append("drive verb bubble-up still auto-marks organs")

if violations:
    for v in violations:
        print(f"VIOLATION: {v}")
    sys.exit(1)

print("OK: contract drive is agent-judged — no auto-satisfy, no fabricated verdict")
sys.exit(0)
