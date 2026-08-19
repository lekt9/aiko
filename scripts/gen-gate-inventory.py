#!/usr/bin/env python3
"""Regenerate the root-gate-inventory blocks in README.md and CLAUDE.md.

build.zig is the single source of truth for which shell witnesses the root
build schedules. The doc blocks between <!-- root-gate-inventory:start/end -->
are GENERATED — edit build.zig, run this script, commit both. The extraction
regex is deliberately identical to the one in tests/docs-oss-ready-gate.sh so
the generator can never produce a block the checker rejects.

Usage: python3 scripts/gen-gate-inventory.py [--check]
  --check  exit 1 if any doc block is stale, without writing
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
MARKER = re.compile(
    r"(<!-- root-gate-inventory:start -->\n)(.*?)(<!-- root-gate-inventory:end -->)",
    re.S,
)

build = (ROOT / "build.zig").read_text()
seen: dict[str, None] = {}
for witness in re.findall(r'"((?:neuron/)?tests/[^"\n]*-gate\.sh)"', build):
    seen.setdefault(witness)
gates = list(seen)
if not gates:
    raise SystemExit("FAIL: no gates extracted from build.zig")
for witness in gates:
    if not (ROOT / witness).is_file():
        raise SystemExit(f"FAIL: build.zig names missing witness {witness}")

block = "".join(f"- `{g}`\n" for g in gates)
check_only = "--check" in sys.argv[1:]
stale = []

for name in ("README.md", "CLAUDE.md"):
    path = ROOT / name
    text = path.read_text()
    match = MARKER.search(text)
    if not match:
        raise SystemExit(f"FAIL: {name} lacks root-gate-inventory markers")
    if match.group(2) == block:
        continue
    stale.append(name)
    if not check_only:
        path.write_text(text[: match.start(2)] + block + text[match.end(2) :])

if check_only and stale:
    raise SystemExit(f"STALE: {', '.join(stale)} — run scripts/gen-gate-inventory.py")
print(f"ok: {len(gates)} gates; " + (f"rewrote {', '.join(stale)}" if stale else "docs already current"))
