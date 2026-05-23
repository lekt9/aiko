#!/usr/bin/env python3
"""
Φ1 — render contract iterate output as OpenAI-compatible streaming chunks.

Reads contract iterate output from stdin (or via the contract CLI when
called as `contract openai-render --from <id>` later), and emits SSE
chunks shaped like OpenAI's /v1/chat/completions stream:

  data: {"id":"chatcmpl-...","choices":[{"delta":{"content":"..."},"index":0}]}
  data: {"id":"chatcmpl-...","choices":[{"delta":{"tool_calls":[...]}}]}
  data: [DONE]

The four substrate requirement blocks (PAYMENT REQUIRED, SIGN-IN REQUIRED,
ROUTED, INHIBITION REFUSAL) are converted to OpenAI tool_calls so a web
client (or any OpenAI-SDK consumer) can render generative UI from the
structured payload — same shape as the substrate-side block, just
re-encoded as a function call.

This script is the LOAD-BEARING substrate translator. Per pointer-not-
payload: the unbrowse-side /v1/chat/completions endpoint piping this
stream to its caller never needs to KNOW about requirement-block syntax
— it just forwards SSE chunks. The translation lives here, once.

Usage:
  bash ~/.claude/skills/contract/scripts/contract iterate <id> 2>&1 \
    | python3 ~/.claude/skills/contract/scripts/openai-render.py
  # → emits OpenAI-format SSE on stdout

Exit codes:
  0 — stream emitted successfully (even if iterate FAILed; the requirement
      block is delivered as a tool_call, that's a successful render)
  2 — malformed input
"""
from __future__ import annotations

import json
import re
import sys
import time
import uuid


# Map known requirement-block headers to OpenAI function names.
# Adding a new block here is the only change required to extend.
BLOCK_TO_TOOL = {
    "PAYMENT REQUIRED":      "payment_required",
    "SIGN-IN REQUIRED":      "sign_in_required",
    "ROUTED":                "agent_routed",
    "INHIBITION REFUSAL":    "inhibition_refusal",
    "MACHINE BINARY MISSING": "machine_binary_missing",
}

# Block format on the wire:
#   === <KIND> ===
#   key:   value
#   key:   value
#   ...
#   (empty line OR a non-key line OR the next === === ends the block)
BLOCK_HEADER = re.compile(r"^\s*===\s+(.+?)\s+===\s*$")
KV_LINE      = re.compile(r"^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$")


def _parse_blocks_and_text(raw: str):
    """
    Walk the raw iterate output and split into:
      - text  — non-block content (becomes content deltas)
      - blocks — list of (kind, dict) tuples (become tool_calls)
    Blocks may have lines that aren't strict KV (e.g. the "Render this
    block per transport:" prose); we keep KV-shaped lines as args and
    drop the rest. That keeps the tool_call args small and parseable.
    """
    text_lines: list[str] = []
    blocks: list[tuple[str, dict]] = []
    lines = raw.splitlines()
    i = 0
    while i < len(lines):
        m = BLOCK_HEADER.match(lines[i])
        if not m:
            text_lines.append(lines[i])
            i += 1
            continue
        kind = m.group(1).strip()
        # Collect until next blank line OR next === header OR EOF.
        j = i + 1
        args: dict[str, str] = {}
        while j < len(lines):
            line = lines[j]
            if BLOCK_HEADER.match(line):
                break
            if line.strip() == "":
                # Empty inside-block line — keep scanning past it; the
                # block can have multi-paragraph prose.
                j += 1
                # But if the NEXT non-empty line isn't KV-shaped, end the block.
                k = j
                while k < len(lines) and lines[k].strip() == "":
                    k += 1
                if k >= len(lines) or BLOCK_HEADER.match(lines[k] if k < len(lines) else ""):
                    break
                if k < len(lines) and not KV_LINE.match(lines[k]) and not lines[k].lstrip().startswith("Render"):
                    # Non-KV non-empty after blank — likely end of block.
                    break
                continue
            kv = KV_LINE.match(line)
            if kv:
                args[kv.group(1)] = kv.group(2)
            j += 1
        blocks.append((kind, args))
        i = j
    return "\n".join(text_lines).strip(), blocks


def _chat_id() -> str:
    return "chatcmpl-" + uuid.uuid4().hex[:24]


def _emit(obj: dict) -> None:
    sys.stdout.write("data: " + json.dumps(obj, separators=(",", ":")) + "\n\n")
    sys.stdout.flush()


def render(raw: str) -> None:
    chat_id = _chat_id()
    created = int(time.time())
    model = "contract-substrate"

    text, blocks = _parse_blocks_and_text(raw)

    # First chunk: role
    _emit({
        "id": chat_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{
            "index": 0,
            "delta": {"role": "assistant"},
            "finish_reason": None,
        }],
    })

    # Text content (single delta; substrate iterate output isn't a hot stream)
    if text:
        _emit({
            "id": chat_id, "object": "chat.completion.chunk",
            "created": created, "model": model,
            "choices": [{
                "index": 0,
                "delta": {"content": text + ("\n" if blocks else "")},
                "finish_reason": None,
            }],
        })

    # Tool calls for each requirement block
    finish_reason = "stop"
    if blocks:
        finish_reason = "tool_calls"
        tool_calls = []
        for idx, (kind, args) in enumerate(blocks):
            fn = BLOCK_TO_TOOL.get(kind, kind.lower().replace(" ", "_"))
            tool_calls.append({
                "index": idx,
                "id": f"call_{uuid.uuid4().hex[:16]}",
                "type": "function",
                "function": {
                    "name": fn,
                    "arguments": json.dumps(args, separators=(",", ":")),
                },
            })
        _emit({
            "id": chat_id, "object": "chat.completion.chunk",
            "created": created, "model": model,
            "choices": [{
                "index": 0,
                "delta": {"tool_calls": tool_calls},
                "finish_reason": None,
            }],
        })

    # Final chunk
    _emit({
        "id": chat_id, "object": "chat.completion.chunk",
        "created": created, "model": model,
        "choices": [{
            "index": 0,
            "delta": {},
            "finish_reason": finish_reason,
        }],
    })
    sys.stdout.write("data: [DONE]\n\n")
    sys.stdout.flush()


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        print("openai-render: empty input on stdin", file=sys.stderr)
        return 2
    render(raw)
    return 0


if __name__ == "__main__":
    sys.exit(main())
