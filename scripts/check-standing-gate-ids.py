#!/usr/bin/env python3
# check-standing-gate-ids.py — every standing-gate ID named in SKILL.md
# (the "Standing gate IDs (canonical pointers)" table) must resolve to a
# real declared contract in the global ledger whose `plan` field still
# starts with the documented name.
#
# Catches the failure mode where SKILL.md tells agents to do
# `--action contract:27125bd7` but the referenced contract was never
# declared (or was deleted, or its plan-text drifted such that agents
# would be confused when reading `contract status`).

import sys
import re
import json
import os
from pathlib import Path

SKILL = Path(os.environ.get("SKILL_MD", Path.home() / ".claude/skills/contract/SKILL.md"))
LEDGER = Path(os.environ.get("CONTRACTS_STORE", Path.home() / ".contracts/contracts.jsonl"))

text = SKILL.read_text()
# Find the "Standing gate IDs" table: 3-column markdown table with backticked IDs.
m = re.search(r"### Standing gate IDs[\s\S]*?\|---\|---\|---\|\n((?:\|[^\n]*\n)+)", text)
if not m:
    print("could not find Standing gate IDs table in SKILL.md", file=sys.stderr)
    sys.exit(2)

rows = [r for r in m.group(1).strip().split("\n") if r.startswith("|") and "---" not in r]
expectations = []
for r in rows:
    cells = [c.strip() for c in r.strip("|").split("|")]
    if len(cells) < 2:
        continue
    name = cells[0]
    idm = re.search(r"`([a-f0-9]+)`", cells[1])
    if not idm:
        continue
    expectations.append({"name": name, "id": idm.group(1)})

if not expectations:
    print("Standing gate IDs table is empty in SKILL.md", file=sys.stderr)
    sys.exit(2)

# Build id -> plan map from the ledger
plans = {}
with LEDGER.open() as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as e:
            # Surface the malformed-line error to stderr so the substrate
            # principle holds (no silent fallback). Continue to the next row
            # — one bad line doesn't disqualify the whole ledger from being
            # checked, but the error is visible.
            print(f"WARN: malformed ledger line skipped ({LEDGER.name}): {e}", file=sys.stderr)
            continue
        if row.get("event") == "declared":
            plans[row.get("id")] = row.get("plan", "")

bad = []
for e in expectations:
    plan = plans.get(e["id"])
    if plan is None:
        bad.append(f"{e['id']}: SKILL.md says '{e['name']}' but no declared row exists in the ledger")
        continue
    # SKILL.md names them like "served-surface gate", "empathy gate", "observe-original gate".
    # The actual plan begins with that name + " (standing)" per the contract declarations.
    expected_prefix = e["name"].lower().split(" (")[0]
    if expected_prefix not in plan.lower():
        bad.append(
            f"{e['id']}: SKILL.md says '{e['name']}' but ledger plan starts with "
            f"'{plan[:60]}…'"
        )

if bad:
    print("standing-gate-id drift detected:", file=sys.stderr)
    for line in bad:
        print(f"  {line}", file=sys.stderr)
    sys.exit(1)

print(f"standing-gate-ids clean: {len(expectations)} IDs resolve to declared contracts with matching plan text.")
sys.exit(0)
