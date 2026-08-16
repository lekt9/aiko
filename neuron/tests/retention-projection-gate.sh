#!/usr/bin/env bash
# Production witness for the Neuron -> Contract retention pin membrane.
set -euo pipefail
cd "$(dirname "$0")/.."

zig test src/cross_journal_retention.zig >/dev/null
zig build test >/dev/null

# Mutation proof: deleting the collection refusal must make the behavioral
# witness fail. A textual inventory alone could pass with unsafe GC.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp src/cross_journal_retention.zig "$tmp/cross_journal_retention.zig"
python3 - "$tmp/cross_journal_retention.zig" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = "if (self.entries[index].retained) return Error.LiveReference;"
assert s.count(old) == 1, "collection refusal mutation point drifted"
p.write_text(s.replace(old, "if (false) return Error.LiveReference;"))
PY
if zig test "$tmp/cross_journal_retention.zig" >/dev/null 2>&1; then
  echo "retention-projection gate: mutation deleting live-reference refusal survived" >&2
  exit 1
fi

echo "retention-projection gate: PASS"
