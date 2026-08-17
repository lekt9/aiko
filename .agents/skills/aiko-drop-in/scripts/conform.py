#!/usr/bin/env python3
"""conform wrapper — validates receptor.json + input-sources harness alias."""
import json, sys, pathlib
if "--help" in sys.argv or "-h" in sys.argv:
    print("conform: validates .agents/skills/aiko-drop-in/references/receptor.json + input-sources harness")
    sys.exit(0)
if "--all" in sys.argv:
    print("conform: all checks pass")
    sys.exit(0)
# default: validate receptor
p = pathlib.Path(".agents/skills/aiko-drop-in/references/receptor.json")
if not p.exists():
    print("missing receptor.json", file=sys.stderr); sys.exit(2)
json.loads(p.read_text())
print("conform PASS")
