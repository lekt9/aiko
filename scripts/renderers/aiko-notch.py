#!/usr/bin/env python3
"""aiko-notch renderer: substrate stdio → JSON card for the Mac notch /
Dynamic Island style generative UI.

Output shape:
    {
      "kind":   "status" | "requirement" | "proposal" | "context" | "result",
      "title":  "<2-6 word headline>",
      "body":   "<one-line plain-English summary>",
      "actions":[{"label":"...","cmd":"..."}],
      "raw":    "<original input truncated>"
    }

Heuristic: scan input for the first '=== ... ===' marker to classify; if
none, classify as 'status' and use the first non-blank line as title.
"""
from __future__ import annotations
import json, os, re, sys


def classify(text: str) -> tuple[str, str]:
    """Return (kind, title) for the input."""
    m = re.search(r"=== ([A-Z][A-Z _-]+) ===", text)
    if m:
        marker = m.group(1).strip().lower()
        if "payment required" in marker:
            return "requirement", "Payment needed"
        if "sign-in required" in marker or "sign in required" in marker:
            return "requirement", "Sign in"
        if "context needed" in marker:
            return "requirement", "Context needed"
        if "machine binary missing" in marker:
            return "requirement", "Install needed"
        if "two-key exit" in marker:
            return "status", "Judging…"
        if "propagation" in marker:
            return "status", "Resolved"
        if "break on resolution" in marker:
            return "status", "Just fired"
        if "contract drive armed" in marker:
            return "status", "Driving"
        return "result", marker[:40].title()
    # No marker — fall back to first content line
    for line in text.splitlines():
        s = line.strip()
        if s and not s.startswith("{") and not s.startswith("=="):
            return "status", s[:40]
    return "status", "Working…"


def actions_from_text(text: str, cid: str) -> list[dict]:
    actions: list[dict] = []
    # Look for "contract iterate <id>" or "contract _mark <id>" hints
    for m in re.finditer(r"contract (iterate|_mark|judge|render|context-of|next-of) ([0-9a-f]{8})\b", text):
        verb, ref = m.group(1), m.group(2)
        actions.append({"label": f"{verb} {ref[:6]}", "cmd": f"contract {verb} {ref}"})
        if len(actions) >= 3:
            break
    if not actions and cid:
        actions.append({"label": "iterate", "cmd": f"contract iterate {cid}"})
    return actions


def main() -> int:
    text = sys.stdin.read()
    cid = os.environ.get("CONTEXT_CONTRACT_ID", "")
    kind, title = classify(text)
    body = ""
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("=") or s.startswith("contract "):
            continue
        if any(s.startswith(p) for p in ("plan:", "result:", "body:", "reason:")):
            body = s[len(s.split(":", 1)[0]) + 1:].strip()[:200]
            break
        if 20 < len(s) < 200:
            body = s
            break
    card = {
        "kind": kind,
        "title": title,
        "body": body,
        "actions": actions_from_text(text, cid),
        "contract_id": cid,
        "raw": text[:400] + ("…" if len(text) > 400 else ""),
    }
    print(json.dumps(card, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
