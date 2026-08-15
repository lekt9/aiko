#!/usr/bin/env bash
# Context-plane witness: cited lineage, tenant refusal, source invalidation, and
# dependency-free handoff. Assertions inspect the durable lineage artifact.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
plane="$repo_dir/cell/primitives/context-plane/context_plane.py"
gate_root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-fde-context.XXXXXX")"
trap 'rm -rf -- "$gate_root"' EXIT
state="$gate_root/state"
fail() { echo "FAIL: $*" >&2; exit 1; }
refuses() { if "$@" >"$gate_root/refusal.out" 2>"$gate_root/refusal.err"; then fail "command should have refused: $*"; fi; }

# Start with no host, database, or shared service: the artifact is the plane.
"$plane" init --state "$state" --tenant tenant-a >/dev/null
"$plane" source-add --state "$state" --tenant tenant-a \
  --kind stimulus --id order/42 --content '{"required":4}' >/dev/null
"$plane" source-add --state "$state" --tenant tenant-a \
  --kind message --id reply/alice --content confirmed >/dev/null
read_bytes='{"workers":["alice","bob","carol","dave"]}'
read_pin="$(printf %s "$read_bytes" | shasum -a 256 | awk '{print $1}')"
"$plane" source-add --state "$state" --tenant tenant-a \
  --kind pinned_read --id workers/current --content "$read_bytes" --pin "$read_pin" >/dev/null

"$plane" claim-add --state "$state" --tenant tenant-a \
  --id roster/42 --text 'four pinned workers satisfy order 42' \
  --source order/42 --source workers/current >/dev/null
"$plane" claim-add --state "$state" --tenant tenant-a \
  --id confirmation/alice --text 'alice confirmed' --source reply/alice >/dev/null

# Nothing may invent dependency edges later: an uncited claim is no claim.
refuses "$plane" claim-add --state "$state" --tenant tenant-a \
  --id invisible/read --text 'read something but cited nothing'
refuses "$plane" source-add --state "$state" --tenant tenant-a \
  --kind pinned_read --id workers/unpinned --content "$read_bytes"
refuses "$plane" source-add --state "$state" --tenant tenant-a \
  --kind pinned_read --id workers/wrong-pin --content "$read_bytes" --pin deadbeef

# The envelope is a hard boundary, including reads and verification.
refuses "$plane" status --state "$state" --tenant tenant-b
refuses "$plane" claim-add --state "$state" --tenant tenant-b \
  --id stolen --text 'cross tenant' --source order/42

# A source movement appends, never overwrites. Only claims citing its old bytes
# become invalid; unrelated cited context remains current.
"$plane" source-move --state "$state" --tenant tenant-a \
  --id order/42 --content '{"required":5}' >/dev/null
lineage="$state/cited-context-lineage.json"
python3 - "$lineage" <<'PY'
import hashlib, json, sys
p = json.load(open(sys.argv[1]))
assert p["schema"] == "aiko.cited-context-lineage/v1"
assert p["tenant"] == "tenant-a"
assert set(p["claims"]) == {"roster/42", "confirmation/alice"}
order = p["sources"]["order/42"]
assert order["current"] == 1 and len(order["versions"]) == 2
assert order["versions"][0]["content"] == '{"required":4}'
assert order["versions"][1]["content"] == '{"required":5}'
claim = p["claims"]["roster/42"]
assert {c["kind"] for c in claim["citations"]} == {"stimulus", "pinned_read"}
assert claim["citations"][0]["digest"] == order["versions"][0]["digest"]
assert p["sources"]["workers/current"]["versions"][0]["pin"] == hashlib.sha256(
    '{"workers":["alice","bob","carol","dave"]}'.encode()).hexdigest()
PY
"$plane" status --state "$state" --tenant tenant-a >"$gate_root/status.json"
python3 - "$gate_root/status.json" <<'PY'
import json, sys
rows = {r["id"]: r for r in json.load(open(sys.argv[1]))["claims"]}
assert rows["roster/42"]["valid"] is False
assert [x["source"] for x in rows["roster/42"]["invalidated_by"]] == ["order/42"]
assert rows["confirmation/alice"]["valid"] is True
assert rows["confirmation/alice"]["invalidated_by"] == []
PY

# Handoff is a cold copy read by a fresh process. There is no daemon or Aiko
# state to recreate, and integrity plus invalidation survive the copy.
mkdir "$gate_root/handoff"
cp "$lineage" "$gate_root/handoff/cited-context-lineage.json"
"$plane" verify --state "$gate_root/handoff" --tenant tenant-a >"$gate_root/verified.json"
python3 - "$gate_root/verified.json" <<'PY'
import json, sys
v = json.load(open(sys.argv[1]))
assert v["integrity"] == "verified"
assert v["invalid_claims"] == ["roster/42"]
PY

# Falsifier: evidence[].sources in Neuron is this plane's citations. Strip the
# citations from one durable claim and verification MUST go red rather than
# making that firing invisible to invalidation.
mkdir "$gate_root/stripped"
python3 - "$lineage" "$gate_root/stripped/cited-context-lineage.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p["claims"]["roster/42"]["citations"] = []
json.dump(p, open(sys.argv[2], "w"), sort_keys=True, separators=(",", ":"))
PY
refuses "$plane" verify --state "$gate_root/stripped" --tenant tenant-a

# Digest tampering is also a refusal, not silently reclassified context.
mkdir "$gate_root/tampered"
python3 - "$lineage" "$gate_root/tampered/cited-context-lineage.json" <<'PY'
import json, sys
p = json.load(open(sys.argv[1]))
p["sources"]["reply/alice"]["versions"][0]["content"] = "declined"
json.dump(p, open(sys.argv[2], "w"), sort_keys=True, separators=(",", ":"))
PY
refuses "$plane" verify --state "$gate_root/tampered" --tenant tenant-a

echo "fde-context-gate: pass"
