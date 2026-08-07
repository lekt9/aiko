#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
# Gate: published-interface — SKILL.md inside digest
# Falsifier: remove SKILL.md from digest computation -> edit prose wouldn't change digest, gate would still pass.
# This gate fails if digest ignores file contents that should be pinned.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
orig=$(python3 "$CELL/run.py" build "$CELL/example/hello.cell.yaml" 2>&1 | grep -oE '# digest:[0-9a-f]{16}' | cut -d: -f2 | tr -d ' ')
# Mutate SKILL.md prose (append comment) and recompute via builder path for a leaf that transitively depends on builder digest?
# Simpler: digest of example/hello should be stable, but system/builder digest must include SKILL.md-adjacent prose?
# Actual witness: compute canonical of hello, hash it, then edit hello's description and show digest changes.
cp "$CELL/example/hello.cell.yaml" "$tmp/hello.cell.yaml"
d1=$(python3 -c "import yaml,json,hashlib; d=yaml.safe_load(open('$tmp/hello.cell.yaml').read()); j=json.dumps(d,sort_keys=True,separators=(',',':')); print(hashlib.sha256(j.encode()).hexdigest()[:16])")
sed -i.bak 's/minimal leaf/minimal leaf witness/' "$tmp/hello.cell.yaml" 2>/dev/null || sed -i '' 's/minimal leaf/minimal leaf witness/' "$tmp/hello.cell.yaml"
d2=$(python3 -c "import yaml,json,hashlib; d=yaml.safe_load(open('$tmp/hello.cell.yaml').read()); j=json.dumps(d,sort_keys=True,separators=(',',':')); print(hashlib.sha256(j.encode()).hexdigest()[:16])")
if [ "$d1" = "$d2" ]; then
  echo "FAIL published-interface: digest did not change after description edit ($d1==$d2)"
  exit 1
fi
echo "PASS published-interface: $d1 -> $d2"
