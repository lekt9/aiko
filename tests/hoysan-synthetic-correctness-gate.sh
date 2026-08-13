#!/usr/bin/env bash
# Synthetic-only correctness witness for the actual Hoysan drafting Cell.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL hoysan-synthetic: $*" >&2; exit 1; }
[ -x zig-out/bin/aiko-doctor ] || fail "aiko-doctor missing; run zig build"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
python3 tests/fixtures/hoysan-synthetic/generate.py --out "$tmp/inputs"

python3 cell/run.py build cell/patterns/hoysan-draft/hoysan-draft.cell.yaml >/dev/null
python3 cell/run.py run cell/patterns/hoysan-draft/hoysan-draft.cell.yaml --inputs "$tmp/inputs/feasible.json" --out "$tmp/a" >/dev/null
python3 cell/run.py run cell/patterns/hoysan-draft/hoysan-draft.cell.yaml --inputs "$tmp/inputs/feasible.json" --out "$tmp/b" >/dev/null
cmp "$tmp/a/result.json" "$tmp/b/result.json" || fail "result is nondeterministic"
cmp "$tmp/a/summary.json" "$tmp/b/summary.json" || fail "summary is nondeterministic"

python3 - "$tmp/inputs/feasible.json" "$tmp/a" <<'PY'
import collections, hashlib, json, pathlib, sys
request=json.load(open(sys.argv[1]))["request"]
out=pathlib.Path(sys.argv[2])
result=json.load(open(out/"result.json")); manifest=json.load(open(out/"manifest.json"))
assert result["validation"] == {"ok": True, "errors": []}
assert result["stats"] == {"cranes_requested":3,"cranes_filled":3,"workers_deployed":15}
assert len(result["gangs"]) == 3
seen=[]
by_id={w["nric"]:w for w in request["workers"]}
for gang in result["gangs"]:
    assert len(gang["workers"]) == 5
    roles=collections.Counter(w["role"] for w in gang["workers"])
    want={"STA":1,"LW":2,"CM":1,"WTA":1} if gang["wta_required"] else {"STA":1,"LW":2,"CM":2}
    assert roles == want, (roles,want)
    for assigned in gang["workers"]:
        source=by_id[assigned["nric"]]
        assert assigned["role"] not in source.get("exceptions",[])
        assert assigned["wah"] or assigned["role"] == "CM"
        seen.append(assigned["nric"])
assert len(seen)==len(set(seen))==15
standby=[s["nts_nric"] for s in result["standby"]]
assert len(standby)==len(set(standby))==10
assert not set(standby)&set(seen)
canonical=lambda value: json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()
assert manifest["outputs"]["result"] == hashlib.sha256(canonical(result)).hexdigest()
summary=json.load(open(out/"summary.json"))
assert manifest["outputs"]["summary"] == hashlib.sha256(canonical(summary)).hexdigest()
assert len(manifest["produced_by"])==64 and len(manifest["cell"])==64
print("ok feasible composition, provenance, and determinism")
PY

# Input order and hash seed cannot change the semantic products.
python3 - "$tmp/inputs/feasible.json" "$tmp" <<'PY'
import json, pathlib, random, sys
base=json.load(open(sys.argv[1])); root=pathlib.Path(sys.argv[2])
for seed in (1,7,42):
    value=json.loads(json.dumps(base)); random.Random(seed).shuffle(value["request"]["workers"]); random.Random(seed+1).shuffle(value["request"]["cranes"])
    (root/f"shuffle-{seed}.json").write_text(json.dumps(value))
PY
for seed in 1 7 42; do
  PYTHONHASHSEED="$seed" python3 cell/run.py run cell/patterns/hoysan-draft/hoysan-draft.cell.yaml --inputs "$tmp/shuffle-$seed.json" --out "$tmp/shuffle-out-$seed" >/dev/null
  cmp "$tmp/a/result.json" "$tmp/shuffle-out-$seed/result.json" || fail "input order/hash seed moved result ($seed)"
  cmp "$tmp/a/summary.json" "$tmp/shuffle-out-$seed/summary.json" || fail "input order/hash seed moved summary ($seed)"
done

for case in shortfall wah exception rest rest-unknown pair standby duplicate unknown-pool; do
  set +e
  message=$(python3 cell/run.py run cell/patterns/hoysan-draft/hoysan-draft.cell.yaml --inputs "$tmp/inputs/$case.json" --out "$tmp/refuse-$case" 2>&1)
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || fail "$case was retained as success"
  echo "$message" | grep -qiE 'refused|no eligible|duplicate|unknown' || fail "$case did not name refusal"
  [ ! -e "$tmp/refuse-$case/result.json" ] || fail "$case retained result.json"
  [ ! -e "$tmp/refuse-$case/summary.json" ] || fail "$case retained summary.json"
  [ ! -e "$tmp/refuse-$case/manifest.json" ] || fail "$case retained manifest.json"
done

zig-out/bin/aiko-doctor bind-workflow cell/patterns/hoysan-draft/hoysan-draft.cell.yaml --plan > "$tmp/bind.json"
python3 - "$tmp/bind.json" <<'PY'
import json,sys
v=json.load(open(sys.argv[1])); assert [n["id"] for n in v["walk"]["nodes"]]==["hoysan-draft"]
assert v["plan"]["waves"]==[["hoysan-draft"]]
print("ok doctor binds actual Hoysan Cell")
PY

echo "PASS hoysan-synthetic-correctness-gate"
