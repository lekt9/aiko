#!/usr/bin/env python3
"""Fail-closed structural and semantic conformance checks for AGENTS.md."""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOC = ROOT / "AGENTS.md"

REQUIRED_HEADINGS = [
    "The Single Primitive", "Normative Vocabulary", "Canonical Data Model",
    "Firing Lifecycle", "Delivery, Idempotency", "Artifact and Substrate",
    "Grounding and Evidence", "Capability Security", "Determinism and Content-Addressed",
    "Topology, Self-Growth", "Failure Model", "Observability and Audit",
    "Registry Neurons", "Reference Conformance", "Superpattern Translation",
    "Acceptance Gate",
]

REQUIRED_CONCEPTS = [
    r"exactly one control decision", r"zero or more declarative effects",
    r"atomically, or commit none", r"at-least-once",
    r"Every firing and effect therefore MUST\s+be idempotent",
    r"compare-and-swap", r"snapshot-consistent", r"least authority",
    r"deny by default", r"reconciliation_required", r"deterministic replay",
    r"document-only pass MUST NOT be represented as runtime correctness",
]

CONTRADICTIONS = [
    r"return value is an explicit typed control decision: continue, terminate, branch, spawn",
    r"exactly-once external effects are guaranteed",
    r"Skills? (?:inherit|receive) ambient authority",
    r"same model twice is independent corroboration",
]


def errors(text: str) -> list[str]:
    found: list[str] = []
    if len(text.splitlines()) < 450:
        found.append("document is not built out to the minimum operational depth")
    for heading in REQUIRED_HEADINGS:
        if not re.search(rf"^### \d+\. .*{re.escape(heading)}", text, re.MULTILINE):
            found.append(f"missing heading: {heading}")
    for pattern in REQUIRED_CONCEPTS:
        if not re.search(pattern, text, re.IGNORECASE):
            found.append(f"missing invariant: {pattern}")
    for pattern in CONTRADICTIONS:
        if re.search(pattern, text, re.IGNORECASE):
            found.append(f"contradiction present: {pattern}")
    if "type Decision" not in text or "type Effect" not in text:
        found.append("control/effect type split missing")
    return found


def main() -> int:
    text = DOC.read_text(encoding="utf-8")
    found = errors(text)
    if found:
        print("\n".join(f"[agents] FAIL: {item}" for item in found))
        return 1
    print(f"[agents] PASS: {DOC.name} satisfies {len(REQUIRED_HEADINGS)} sections and semantic invariants")
    return 0


if __name__ == "__main__":
    sys.exit(main())
