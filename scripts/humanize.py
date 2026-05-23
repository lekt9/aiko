#!/usr/bin/env python3
"""humanize.py — the curve-humanisation pipe-stage.

Reads substrate stdio (any contract output) on stdin, emits humanized
text suitable for a public-tier surface (Aiko voice, no jargon, no AI-
slop, no em-dashes) on stdout. Idempotent.

Per aiko-voice (1bed8068):
  1. Strip substrate jargon — replace cells/funnel/iterate/KEY/_mark/
     PROPAGATION/BREAK ON RESOLUTION/etc with plain-English equivalents.
  2. Remove em-dashes ('—' and ' -- ') — replace with commas/periods/
     semicolons.
  3. Remove AI-slop adjectives (powerful/seamless/unleash/elevate/
     next-gen/robust/enterprise-grade).
  4. Strip substrate section headers (=== X ===) and CLI-only prompts
     ("Run: contract iterate ...", "If genuine →") that aren't useful
     to a non-developer.

What this does NOT do:
  - Translate complete user-facing copy from scratch. The agent still
    writes the final voice; humanize is the mechanical first pass that
    removes the obvious jargon before the agent polishes.
  - Touch JSON-shaped output (any line starting with { or `data:` is
    passed through unchanged — Φ1 SSE chunks, aiko-notch cards, etc.).
"""
from __future__ import annotations
import re
import sys

JARGON_MAP = {
    # substrate verbs → plain
    r"\bcontract iterate\b": "advance",
    r"\bcontract _mark\b": "mark",
    r"\bcontract iterate\b": "advance",
    r"\bcontract spawn\b": "spawn a child",
    r"\bcontract declare\b": "declare",
    r"\bcontract supersede\b": "supersede",
    r"\bcontract drive\b": "drive",
    r"\biterate the\b": "advance the",
    r"\b_mark\b": "mark",
    # substrate nouns
    r"\bfunnel\b": "group",
    r"\bcell contract\b": "step",
    r"\bcells\b": "steps",
    r"\bcell\b": "step",
    r"\bKEY 1\b": "machine check",
    r"\bKEY 2\b": "judgment",
    r"\bKEY 3\b": "pause",
    r"\bthe substrate\b": "the system",
    r"\bthe ledger\b": "the record",
    r"\bhooks\b": "triggers",
    r"\bMCP\b": "tool",
}
# Headers / section markers to strip entirely
STRIP_LINES_PREFIXES = (
    "=== ",
    "  === ",
    "wave: ",
    "  wave: ",
    "  pointer(",
    "  result: ",
    "  stderr: ",
    "  KEY 1 (",
    "  KEY 2 (",
    "  KEY 3 (",
    "  If genuine ",
    "  If genuine → ",
    "  Fix the target",
    "  Render this block",
    "    Telegram → ",
    "    Web      → ",
    "    Panel    → ",
    "    Terminal → ",
    "  Run: ",
    "  Run now: ",
    "  next leaf: ",
    "  Keep iterating until",
    "  missing credential",
    "  (then: ",
)

AI_SLOP = [
    r"\bpowerful\b", r"\bseamless\b", r"\bseamlessly\b",
    r"\bunleash\b", r"\belevate\b", r"\belevates\b",
    r"\bnext.gen\b", r"\brobust\b", r"\benterprise.grade\b",
    r"\bcutting.edge\b", r"\brevolutionary\b",
]
AI_SLOP_RES = [re.compile(p, re.IGNORECASE) for p in AI_SLOP]
JARGON_RES = [(re.compile(k), v) for k, v in JARGON_MAP.items()]

# Em-dashes (U+2014, also " -- ")
EM_DASH = re.compile(r"\s+—\s+|\s+--\s+")


def humanize_line(line: str) -> str:
    # Pass-through for JSON / SSE chunks
    s = line.lstrip()
    if s.startswith("{") or s.startswith("[") or s.startswith("data:"):
        return line
    if any(s.startswith(p.lstrip()) for p in STRIP_LINES_PREFIXES):
        return ""
    for pat, repl in JARGON_RES:
        line = pat.sub(repl, line)
    for slop in AI_SLOP_RES:
        line = slop.sub("", line)
    line = EM_DASH.sub(", ", line)
    return line


def main() -> int:
    text = sys.stdin.read()
    out_lines: list[str] = []
    for raw in text.splitlines():
        h = humanize_line(raw)
        if h.strip() == "" and out_lines and out_lines[-1].strip() == "":
            continue  # collapse consecutive blanks from stripped lines
        out_lines.append(h)
    # collapse leading/trailing blanks
    while out_lines and out_lines[0].strip() == "":
        out_lines.pop(0)
    while out_lines and out_lines[-1].strip() == "":
        out_lines.pop()
    sys.stdout.write("\n".join(out_lines))
    if out_lines:
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
