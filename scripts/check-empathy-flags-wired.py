#!/usr/bin/env python3
# check-empathy-flags-wired.py — every empathy-gate flag named in SKILL.md's
# "Empathy primitives" table must be parsed by scripts/browser/verify.mjs.
# Catches drift where SKILL.md documents a flag the script silently ignores.

import sys
import re
import os
from pathlib import Path

SKILL = Path(os.environ.get("SKILL_MD", Path.home() / ".claude/skills/contract/SKILL.md"))
VERIFY = Path(os.environ.get("VERIFY_MJS", Path.home() / ".claude/skills/contract/scripts/browser/verify.mjs"))

skill = SKILL.read_text()
verify = VERIFY.read_text()

# Collect every flag literal mentioned in the Empathy primitives table. The
# table is the canonical surface — agents read it; the script implements it.
m = re.search(r"## Empathy gate.*?\n\| Flag .*?\n((?:\|.*\n)+)", skill, flags=re.DOTALL)
if not m:
    print("could not find Empathy gate primitives table in SKILL.md", file=sys.stderr)
    sys.exit(2)

table = m.group(1)
flags = sorted(set(re.findall(r"`(--[a-z][a-z0-9-]*)`", table)))
if not flags:
    print("Empathy primitives table had no `--flag` entries", file=sys.stderr)
    sys.exit(2)

# Whitelist: well-known playwright bits we might document for completeness
# but not implement ourselves. None today; kept as a clean extension point.
WHITELIST = set()

missing = []
for flag in flags:
    if flag in WHITELIST:
        continue
    # verify.mjs parses flags like  if (a === "--flag")  or  a === '--flag'.
    pattern = rf'["\']({re.escape(flag)})["\']'
    if not re.search(pattern, verify):
        missing.append(flag)

if missing:
    print("empathy-flag drift detected — SKILL.md documents flags verify.mjs does NOT parse:", file=sys.stderr)
    for f in missing:
        print(f"  {f}", file=sys.stderr)
    sys.exit(1)

print(f"empathy-flags-wired clean: all {len(flags)} documented flags are parsed by verify.mjs.")
sys.exit(0)
