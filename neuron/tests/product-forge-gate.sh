#!/usr/bin/env bash
set -euo pipefail
# Business requirements -> pinned product, no product/UX spec.
# Falsifiers: prose outside pin, echoing expect_contains, non-determinism.
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$repo/zig-out/bin/neuron"
[ -x "$BIN" ] || { echo "FAIL: build first (zig build) at $BIN"; exit 1; }
LIMB="$repo/limbs/product-forge"
root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-forge-gate.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
export HOME="$root"
mkdir -p "$root/.contracts"
digest_of() { "$BIN" limb admit "$1" "$2" 2>/dev/null | grep -oE '[0-9a-f]{64}' | tail -1; }
artifact_bytes() {
  python3 - "$1" "$2" <<'PY'
import json, sys
log, aid = sys.argv[1], sys.argv[2]
for line in open(log):
    r=json.loads(line)
    if r.get("op")!="commit": continue
    for a in r.get("artifacts",[]):
        if a["id"]==aid:
            sys.stdout.write(bytes.fromhex(a["bytes"]).decode())
PY
}
"$BIN" agent init "$root/node" a1 >/dev/null
state="$root/node/state"
log="$state/substrate.log"
d0="$(digest_of "$LIMB" "$state")"
[ ${#d0} -eq 64 ] || fail "initial admit failed: $d0"
echo "  admitted ${d0:0:12}"
orig_skill="$(cat "$LIMB/SKILL.md")"
echo "# pin test" >> "$LIMB/SKILL.md"
d1="$(digest_of "$LIMB" "$state")"
[ "$d0" != "$d1" ] || fail "SKILL.md prose outside pin"
echo "  pin: ${d0:0:12} -> ${d1:0:12}"
printf '%s' "$orig_skill" > "$LIMB/SKILL.md"
d2="$(digest_of "$LIMB" "$state")"
[ ${#d2} -eq 64 ] || fail "re-admit failed"
brief_bike="run a neighbourhood bike shop - bookings for repairs, inventory of bikes and parts, roster of mechanics, customer history"
python3 - "$root/stim.json" "$brief_bike" <<'PY'
import json, hashlib, sys
path, brief = sys.argv[1], sys.argv[2]
body = json.dumps({"brief": brief, "project": "bike-shop"}, sort_keys=True)
r={"id":"forge-req","schema":"product-forge.request/v1","digest":hashlib.sha256(body.encode()).hexdigest(),"bytes":body}
stim={"schema":"neuron.stimulus/v1","firing_id":"forge-bike-1","receptor_schema":"product-forge.request/v1","reads":[r],"permitted_reads":[r["id"]],"messages":[],"now_ms":0}
open(path,"w").write(json.dumps(stim))
PY
"$BIN" limb run "$state" --package "$LIMB" --neuron forge --stimulus "$root/stim.json" --json > "$root/out.json" 2> "$root/err.txt" || fail "forge failed: $(cat "$root/err.txt" | head -c 800)"
python3 - "$root/out.json" <<'PY' || exit 1
import json, sys
j=json.load(open(sys.argv[1]))
assert j.get("effects_committed")==4, f"expected 4 got {j}"
print("  4 effects")
PY
for aid in "artifact/product-forge/bike-shop/prd" "artifact/product-forge/bike-shop/ia" "artifact/product-forge/bike-shop/tokens" "artifact/product-forge/bike-shop/crud"; do
  b="$(artifact_bytes "$log" "$aid")"
  [ -n "$b" ] || fail "missing $aid"
done
python3 <<PY || exit 1
import json
log="$log"
for line in open(log):
    r=json.loads(line)
    if r.get("op")!="commit": continue
    for a in r.get("artifacts",[]):
        if a["id"]=="artifact/product-forge/bike-shop/prd":
            prd=json.loads(bytes.fromhex(a["bytes"]).decode())
            assert prd.get("archetype")=="booking", f"expected booking got {prd.get('archetype')}"
            print(f"  archetype booking")
PY
echo "  4 artifacts at bike-shop/{prd,ia,tokens,crud}"
python3 - "$brief_bike" <<'PY' || exit 1
import json, hashlib, subprocess, sys
brief=sys.argv[1]
def stim(fid):
    body=json.dumps({"brief":brief,"project":"bike-shop"},sort_keys=True)
    r={"id":"forge-req","schema":"product-forge.request/v1","digest":hashlib.sha256(body.encode()).hexdigest(),"bytes":body}
    return json.dumps({"schema":"neuron.stimulus/v1","firing_id":fid,"receptor_schema":"product-forge.request/v1","reads":[r],"permitted_reads":[r["id"]],"messages":[],"now_ms":0})
a=subprocess.run([sys.executable, "neuron/limbs/product-forge/neurons/forge.py"], input=stim("forge-bike-1").encode(), capture_output=True)
b=subprocess.run([sys.executable, "neuron/limbs/product-forge/neurons/forge.py"], input=stim("forge-bike-2").encode(), capture_output=True)
assert a.stdout==b.stdout, "NON-DETERMINISTIC"
print("  deterministic")
PY
python3 <<'PY' || exit 1
import json, hashlib, subprocess, sys
brief="run a neighbourhood bike shop - bookings for repairs, inventory of bikes and parts, roster of mechanics, customer history"
body=json.dumps({"brief":brief,"project":"bike-shop"},sort_keys=True)
r={"id":"forge-req","schema":"product-forge.request/v1","digest":hashlib.sha256(body.encode()).hexdigest(),"bytes":body}
stim=json.dumps({"schema":"neuron.stimulus/v1","firing_id":"forge-blind","receptor_schema":"product-forge.request/v1","reads":[r],"permitted_reads":[r["id"]],"messages":[],"now_ms":0})
out=subprocess.run([sys.executable, "neuron/limbs/product-forge/neurons/forge.py"], input=stim.encode(), capture_output=True)
j=json.loads(out.stdout)
for e in j.get("effects",[]):
    if e.get("artifact",{}).get("id","").endswith("/prd"):
        prd=json.loads(e["artifact"]["bytes"])
        assert prd.get("archetype")=="booking", f"gap-blind {prd.get('archetype')}"
print("  gap-blind")
PY
python3 <<'PY' > "$root/stim-bad.json"
import json, hashlib
body=json.dumps({"brief":"hi","project":"bad"},sort_keys=True)
r={"id":"forge-req","schema":"product-forge.request/v1","digest":hashlib.sha256(body.encode()).hexdigest(),"bytes":body}
print(json.dumps({"schema":"neuron.stimulus/v1","firing_id":"forge-bad","receptor_schema":"product-forge.request/v1","reads":[r],"permitted_reads":[r["id"]],"messages":[],"now_ms":0}))
PY
if "$BIN" limb run "$state" --package "$LIMB" --neuron forge --stimulus "$root/stim-bad.json" --json >/dev/null 2>&1; then
  fail "short brief should refuse"
fi
echo "  fail-closed"
python3 - "$log" <<'PY' || exit 1
import json, sys
log=sys.argv[1]
recs=[]
for line in open(log):
    if "limb-admission" not in line: continue
    r=json.loads(line)
    for art in r.get("artifacts",[]):
        if art.get("schema")=="neuron.limb-admission/v1":
            recs.append(json.loads(bytes.fromhex(art["bytes"]).decode()))
assert recs, "no admission"
assert "expect_contains" in recs[-1].get("skill",{}), "ledger missing skill"
print(f"  ledger {recs[-1]['skill']['expect_contains']!r}")
PY
echo "product-forge gate: PASS"
