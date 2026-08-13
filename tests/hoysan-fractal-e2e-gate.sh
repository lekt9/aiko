#!/usr/bin/env bash
# End-to-end: Aiko authors a Hoysan-shaped tool, binds it as a Cell,
# seats herself, and the Smithers runner fires the same harness.
# Synthetic workers only — no customer roster/PII.
# Falsifier: delete the roster author transform and the author step goes red.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CELL="$ROOT/cell"
fail() { echo "FAIL hoysan-fractal: $*" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "== 1. author refuses an unbound Hoysan product gap =="
printf '%s\n' '{"gap":{"need":"excel-native cloudflare neon hoysan product ui"}}' > "$tmp/unbound.json"
set +e
out=$(python3 "$CELL/run.py" run "$CELL/primitives/author.cell.yaml" --inputs "$tmp/unbound.json" --out "$tmp/unbound-out" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "unbound product gap was authored: $out"
echo "ok refused unbound product gap"

echo "== 2. author writes a roster-leveler (bounded, no expect read) =="
printf '%s\n' '{"gap":{"need":"roster level for hoysan shift fill"}}' > "$tmp/gap.json"
python3 "$CELL/run.py" run "$CELL/primitives/author.cell.yaml" --inputs "$tmp/gap.json" --out "$tmp/authored" >/dev/null
python3 -c 'import json; json.load(open("'"$tmp"'/authored/cell.json")); print("ok authored cell")'
python3 - <<PY
import json
from pathlib import Path
raw = json.loads(Path("$tmp/authored/cell_yaml.json").read_text())
if not isinstance(raw, str):
    raise SystemExit(f"cell_yaml is {type(raw)}")
Path("$tmp/roster-level.cell.yaml").write_text(raw)
assert "roster-level" in raw
print("ok materialized yaml")
PY

echo "== 3. run authored roster — fill and shortfall =="
cat > "$tmp/fill.json" <<'JSON'
{"requirement":{"target":2,"shift":"D","max_consecutive":5},"workers":{"items":[
  {"id":"W01","klass":"local","name":"W01","last_worked":"2026-08-01","consecutive":1},
  {"id":"W02","klass":"ts","name":"W02","last_worked":"2026-08-02","consecutive":1},
  {"id":"W03","klass":"nts","name":"W03","last_worked":"2026-08-03","consecutive":1}
]}}
JSON
python3 "$CELL/run.py" run "$tmp/roster-level.cell.yaml" --inputs "$tmp/fill.json" --out "$tmp/fill-out"
python3 - <<PY
import json
r=json.load(open("$tmp/fill-out/roster.json"))
assert r["count"]==2 and r["assigned"]==["W01","W02"], r
print("ok fill", r["assigned"])
PY
cat > "$tmp/short.json" <<'JSON'
{"requirement":{"target":4,"shift":"D"},"workers":{"items":[
  {"id":"W01","klass":"local","name":"W01","last_worked":"a","consecutive":0}
]}}
JSON
set +e
sout=$(python3 "$CELL/run.py" run "$tmp/roster-level.cell.yaml" --inputs "$tmp/short.json" --out "$tmp/short-out" 2>&1)
src=$?
set -e
[ "$src" -ne 0 ] || fail "shortfall wrote a complete roster"
echo "$sout" | grep -qi "shortfall" || fail "shortfall did not name the refusal"

echo "== 4. self-wire seats Aiko on the Hoysan role =="
printf '%s\n' '{"account":{"tenant":"hoysan","origin":"https://ops.local","account_id":"aiko-foreman"},"role":"deployment-foreman","outcome":"own daily pre-shift fill"}' > "$tmp/seat.json"
python3 "$CELL/run.py" run "$CELL/patterns/fde/self-wire.cell.yaml" --inputs "$tmp/seat.json" --out "$tmp/seat"
python3 - <<PY
import json
h=json.load(open("$tmp/seat/handoff.json"))
assert h["agent"]=="aiko" and h["handle_id"].startswith("cred:"), h
print("ok seated", h["handle_id"])
PY

echo "== 5. aiko-doctor bind-workflow on haulio + authored roster =="
[ -x zig-out/bin/aiko-doctor ] || fail "aiko-doctor missing; run zig build"
zig-out/bin/aiko-doctor bind-workflow cell/haulio.cell.yaml --plan > "$tmp/haulio.bind.json"
python3 - <<PY
import json
d=json.load(open("$tmp/haulio.bind.json"))
assert [n["id"] for n in d["walk"]["nodes"]]==["portal","dispatch","billing"], d
assert d["plan"]["waves"]==[["portal"],["dispatch"],["billing"]], d
print("ok haulio bind", d["cell"]["digest"][:12])
PY
zig-out/bin/aiko-doctor bind-workflow "$tmp/roster-level.cell.yaml" --plan > "$tmp/roster.bind.json"
python3 - <<PY
import json
d=json.load(open("$tmp/roster.bind.json"))
assert d["walk"]["nodes"][0]["id"]=="roster-level", d
print("ok roster bind")
PY

echo "== 6. Smithers fires the actual Hoysan Cell and propagates refusal =="
(cd aiko-flow/packages/components && bun test tests/runCell.test.js tests/hoysanRunCell.test.js >/dev/null)

echo "== 7. stack packages still compatible =="
python3 scripts/aiko-packages.py check

echo "== 8. actual Hoysan synthetic correctness matrix =="
bash tests/hoysan-synthetic-correctness-gate.sh

echo "PASS hoysan-fractal-e2e-gate"
