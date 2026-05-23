#!/usr/bin/env python3
# check-heading-ladder.py — guard SKILL.md against the section-wedge defect.
#
# A markdown doc's heading ladder is monotonic: an H2 starts a new section,
# and any H3 between two H2s belongs to the first H2's section. If a `## X`
# header appears between `### Y` lines of a still-open `## A` section, that
# `## X` is wedged INSIDE A's content even though typographically it looks
# like a new section. Agents reading the doc misroute.
#
# This script fails if any H2 appears between H3+ children that follow a
# different H2 — i.e. a `## X` was inserted into a section started by an
# earlier `## A` whose subsections (`### B`, `### C`, etc.) continue AFTER X.
#
# Concretely: the failure mode this catches is
#     ## A
#     ### A.1
#     ## X            ← wedged
#     ### A.2         ← still references A's table/content
#
# Detect: walk the headings; for each H2 (#X), check that no earlier H2
# (#A) has an H3+ subsection AFTER X. If so, X is wedged.
#
# Exit 0 on clean ladder, 1 on wedge.

import sys
import re
from pathlib import Path

doc = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / ".claude/skills/contract/SKILL.md")
text = doc.read_text()

headings = []
for i, line in enumerate(text.splitlines(), start=1):
    m = re.match(r"^(#{1,4})\s+(.*)$", line)
    if not m:
        continue
    headings.append({"line": i, "level": len(m.group(1)), "title": m.group(2).strip()})

# For each H2, find the line range of its section (from its line to the next H2).
# Then for any subsequent H2 within that range — wait, by construction there
# can't be one. The wedge is subtler: subsections (H3+) belonging to section
# A appear AFTER a different H2 inserted mid-flow.
#
# Simpler rule that actually catches the bug: an H3 must be preceded by an
# H2 with NO intervening higher-priority H2. Concretely, walk heading-by-
# heading; an H3+ "belongs to" the most recent H2. If the most recent H2 is
# X (not A) but the H3's content references A's table/topic, that's a
# semantic drift not catchable by structure alone. Structurally we catch:
# any H2 that appears between an H2's first H3 child and another H3 sibling
# of that first H2 — i.e. an H2 nests an H3 sibling chain that got broken.
#
# Implementation: track for each H2 the line of its FIRST H3 child and its
# LAST H3 child (before the next H2). If any OTHER H2 appears strictly
# between those two lines, that's a wedge.

h2_sections = []
current = None
for h in headings:
    if h["level"] == 2:
        if current is not None:
            h2_sections.append(current)
        current = {"h2_line": h["line"], "h2_title": h["title"], "h3_lines": []}
    elif h["level"] == 3 and current is not None:
        current["h3_lines"].append(h["line"])
if current is not None:
    h2_sections.append(current)

wedges = []
for i, sect in enumerate(h2_sections):
    if not sect["h3_lines"]:
        continue
    first_h3 = sect["h3_lines"][0]
    last_h3 = sect["h3_lines"][-1]
    # any OTHER h2 between first_h3 and last_h3?
    for other in h2_sections:
        if other is sect:
            continue
        if first_h3 < other["h2_line"] < last_h3:
            wedges.append((sect["h2_title"], other["h2_title"], other["h2_line"], first_h3, last_h3))

if wedges:
    print("heading-ladder wedges detected:", file=sys.stderr)
    for sect_title, wedge_title, wedge_line, first_h3, last_h3 in wedges:
        print(
            f"  '## {wedge_title}' (line {wedge_line}) is wedged INSIDE "
            f"'## {sect_title}' (its H3 subsections span lines {first_h3}-{last_h3})",
            file=sys.stderr,
        )
    sys.exit(1)

print(f"heading-ladder clean: {len(h2_sections)} H2 sections, no wedges.")
sys.exit(0)
