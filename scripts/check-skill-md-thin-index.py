#!/usr/bin/env python3
# check-skill-md-thin-index.py — Β4 binding gate.
#
# The substrate's own pointer-not-payload law says: SKILL.md should be a
# THIN INDEX of doctrines, each delegating to its own standing-gate
# contract (Β3 pattern). Not a 3000-line monolith with all doctrine prose
# inline. NB: Β3's `audits/references-purge/` forbids new doctrine .md
# files under references/; the long narrative belongs in (a) the
# standing-gate contract's plan text + (b) the Outline appendix. SKILL.md
# carries only a ≤120-line summary citing the standing-gate id.
#
# This check surfaces the drift mechanically:
#   1. SKILL.md total line count ≤ SKILL_MD_MAX_LINES (soft target).
#   2. Each L2 "doctrine" section (top-level `## ` header beyond the
#      operational core) has a corresponding row in
#      references/REGISTRY.md naming the doctrine + its standing-gate id.
#   3. No single doctrine section exceeds DOCTRINE_MAX_LINES — once a
#      section grows beyond that, its prose moves to the standing-gate
#      contract's plan / Outline appendix; SKILL.md keeps the summary.
#
# Origin: Β4 doctrine, 2026-05-24. Lewis: "break down skill.md so each
# contract layer lives inside its own contract — delegate responsibly,
# self-correct via the substrate's own self-awareness honesty."

import os
import re
import sys
from pathlib import Path

SKILL = Path(os.environ.get("SKILL_MD", Path.home() / ".claude/skills/contract/SKILL.md"))
REGISTRY = Path(
    os.environ.get(
        "REGISTRY_MD",
        Path.home() / ".claude/skills/contract/references/REGISTRY.md",
    )
)

# Soft thresholds: these are the discipline targets. Set deliberately
# generous so the gate fires when SKILL.md is bloated, not at first patch.
SKILL_MD_MAX_LINES = int(os.environ.get("SKILL_MD_MAX_LINES", "1200"))
DOCTRINE_MAX_LINES = int(os.environ.get("DOCTRINE_MAX_LINES", "120"))

# Operational-core sections that legitimately live IN SKILL.md (front door
# the agent always needs in-thread). Everything else is a "doctrine" that
# should delegate to references/ + a contract id.
OPERATIONAL_CORE = {
    "When to invoke",
    "Architecture (L0-L2)",
    "Modifying the skill vs creating contracts (dev-level routing)",
    "Default contracts (universal — declare these in any context)",
    "How to actually use this (working loop)",
    "CLI",
    "Output mode (load-bearing)",
    "The nine shapes (one data model)",
    "The two-key exit (load-bearing invariant)",
    "Ledger schema",
    "Pointer principle",
    "What this skill does NOT do",
    "Bundled scripts",
    "Doctrine delegation (the thin-index discipline)",  # Β4 itself
}


def parse_sections(text):
    """Yield (header_title, start_line, end_line) for each top-level ## section."""
    lines = text.split("\n")
    sections = []
    cur = None
    for i, line in enumerate(lines, start=1):
        m = re.match(r"^## (?!#)(.+)$", line)
        if m:
            if cur is not None:
                cur["end"] = i - 1
                sections.append(cur)
            cur = {"title": m.group(1).strip(), "start": i, "end": None}
    if cur is not None:
        cur["end"] = len(lines)
        sections.append(cur)
    return sections


def parse_registry_doctrines(text):
    """Extract doctrine NAMES from the REGISTRY.md table (bold-quoted)."""
    doctrines = set()
    # Match `**X** name` or `**X**` patterns plus the literal name beside it
    for m in re.finditer(r"\*\*([^*]+)\*\*\s*([^|]+)\|", text):
        tag = m.group(1).strip()
        rest = m.group(2).strip()
        doctrines.add(tag.lower())
        if rest:
            doctrines.add(rest.lower())
    # Also tolerate bare doctrine names in the table
    for line in text.split("\n"):
        if "|" in line and "`" in line and not line.strip().startswith("|---"):
            cells = [c.strip() for c in line.strip("|").split("|")]
            if cells and cells[0]:
                doctrines.add(cells[0].lower())
                # Strip bold markers + leading tags
                stripped = re.sub(r"\*\*([^*]+)\*\*", "", cells[0]).strip()
                if stripped:
                    doctrines.add(stripped.lower())
    return doctrines


def section_in_registry(title, doctrines):
    """Is this section's title represented in the registry?"""
    t = title.lower()
    if t in doctrines:
        return True
    # Greek-letter doctrines: section says "Π2 — autopay" registry says "Π2"
    head = t.split("—")[0].strip().split(":")[0].strip().split("(")[0].strip()
    if head and head in doctrines:
        return True
    # Token overlap on first three words
    for d in doctrines:
        if d and (d in t or t.startswith(d + " ") or t.startswith(d + ":")):
            return True
    return False


def main():
    if not SKILL.exists():
        print(f"FAIL: SKILL.md missing at {SKILL}", file=sys.stderr)
        return 2
    if not REGISTRY.exists():
        print(f"FAIL: REGISTRY.md missing at {REGISTRY}", file=sys.stderr)
        return 2

    text = SKILL.read_text()
    total_lines = len(text.split("\n"))
    sections = parse_sections(text)
    doctrines = parse_registry_doctrines(REGISTRY.read_text())

    fails = []
    warns = []

    # Gate 1: total SKILL.md size
    if total_lines > SKILL_MD_MAX_LINES:
        fails.append(
            f"SKILL.md is {total_lines} lines, over soft cap {SKILL_MD_MAX_LINES}. "
            f"Shrink fat doctrines per Β3/Β4: each section ≤{DOCTRINE_MAX_LINES} lines, "
            f"narrative in the standing-gate contract's plan + Outline appendix."
        )

    # Gate 2: each non-core doctrine section must be in REGISTRY.md
    # AND under DOCTRINE_MAX_LINES
    fat_doctrines = []
    unregistered = []
    for s in sections:
        if s["title"] in OPERATIONAL_CORE:
            continue
        size = s["end"] - s["start"] + 1
        if size > DOCTRINE_MAX_LINES:
            fat_doctrines.append((s["title"], size, s["start"]))
        if not section_in_registry(s["title"], doctrines):
            unregistered.append((s["title"], s["start"]))

    if fat_doctrines:
        fails.append(
            f"{len(fat_doctrines)} doctrine section(s) exceed {DOCTRINE_MAX_LINES}-line cap. "
            f"Shrink in-place: move prose to the standing-gate contract's plan / "
            f"Outline appendix; SKILL.md keeps the ≤{DOCTRINE_MAX_LINES}-line summary:"
        )
        for title, size, start in fat_doctrines[:10]:
            fails.append(f"  L{start} ({size} lines): {title}")
        if len(fat_doctrines) > 10:
            fails.append(f"  ... and {len(fat_doctrines) - 10} more")

    if unregistered:
        warns.append(
            f"{len(unregistered)} doctrine section(s) have no REGISTRY.md entry "
            f"(declare standing-gate contract + add row):"
        )
        for title, start in unregistered[:8]:
            warns.append(f"  L{start}: {title}")
        if len(unregistered) > 8:
            warns.append(f"  ... and {len(unregistered) - 8} more")

    if fails:
        print(
            f"FAIL: SKILL.md violates the Β4 thin-index discipline.",
            file=sys.stderr,
        )
        for f in fails:
            print(f"  {f}", file=sys.stderr)
        if warns:
            print("\nALSO surfaced (not yet failing):", file=sys.stderr)
            for w in warns:
                print(f"  {w}", file=sys.stderr)
        return 1

    if warns:
        # Gate is structurally green (size + fat-doctrines pass) but
        # registry coverage incomplete — surface as evidence, not fail.
        print(
            f"PASS-with-warnings: SKILL.md under {SKILL_MD_MAX_LINES} lines, "
            f"no fat doctrines. {len(unregistered)} sections lack REGISTRY entries:",
        )
        for w in warns:
            print(f"  {w}")
        return 0

    print(
        f"PASS: SKILL.md is {total_lines} lines (cap {SKILL_MD_MAX_LINES}), "
        f"every doctrine ≤{DOCTRINE_MAX_LINES} lines, every section registered."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
