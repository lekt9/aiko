#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SKILL="$ROOT/.agents/skills/contract-interface"
CONTRACT_ROOT=$(CDPATH= cd -- "$ROOT/../contract/libcontract" && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

case "$(uname -s)" in
  Darwin) CONTRACT_LIBRARY="$CONTRACT_ROOT/zig-out/lib/libcontract.dylib" ;;
  Linux) CONTRACT_LIBRARY="$CONTRACT_ROOT/zig-out/lib/libcontract.so" ;;
  *) echo "unsupported Contract witness platform" >&2; exit 2 ;;
esac

(cd "$CONTRACT_ROOT" && zig build test && zig build)
export AIKO_CONTRACT_LIBRARY="$CONTRACT_LIBRARY"

python3 "$SKILL/scripts/grow.py" "$SKILL/tests/telegram.json" --out "$TMP/telegram" >/dev/null
python3 "$SKILL/scripts/grow.py" "$SKILL/tests/filesystem.json" --out "$TMP/filesystem-v1" >/dev/null
python3 "$SKILL/scripts/grow.py" "$SKILL/tests/http-webhook-v2.json" --out "$TMP/http-webhook-v2" >/dev/null
python3 "$SKILL/scripts/conform.py" "$TMP/telegram"
python3 "$SKILL/scripts/conform.py" "$TMP/filesystem-v1"
python3 "$SKILL/scripts/conform.py" "$TMP/http-webhook-v2"
python3 "$TMP/telegram/tests/witness.py" "$TMP/telegram"
python3 "$TMP/filesystem-v1/tests/witness.py" "$TMP/filesystem-v1"
python3 "$TMP/http-webhook-v2/tests/witness.py" "$TMP/http-webhook-v2"
python3 "$ROOT/scripts/test-contract-native-skills.py"

if rg -n -i 'telegram|ios|slack' "$SKILL/scripts/grow.py"; then
  echo "provider branch leaked into generic compiler" >&2
  exit 1
fi

python3 - "$TMP" "$SKILL" <<'PY'
import importlib.util, json, pathlib, sys
root, skill = map(pathlib.Path, sys.argv[1:])
module_spec=importlib.util.spec_from_file_location("grow", skill/"scripts/grow.py")
grow=importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(grow)
a=json.loads((root/"telegram/contract-skill.json").read_text())
b=json.loads((root/"filesystem-v1/contract-skill.json").read_text())
shape=lambda manifest: [key.split("-",1)[0] for key in (node["key"] for node in manifest["nodes"])]
assert shape(a)==["observe","normalize","authorize","prepare","execute","execute","sense","evaluate","settle"]
assert shape(b)==["observe","normalize","authorize","prepare","execute","sense","evaluate","settle"]
assert a["nodes"][4]["effect"]=="external_message"
assert b["nodes"][4]["effect"]=="local_reversible"
assert all("input_bindings" in node and node["evidence"] for node in a["nodes"]+b["nodes"])
c=json.loads((root/"http-webhook-v2/assets/capabilities.json").read_text())
assert c["schema_version"]==2 and c["ingress"]["privacy"]=="redacted" and c["cursor"]["identity_fields"]
c_v1=json.loads((root/"telegram/assets/capabilities.json").read_text())
assert c_v1["schema_version"]==1 and "ingress" not in c_v1 and "cursor" not in c_v1
first=grow.bundle_digest(root/"telegram")
second=grow.bundle_digest(root/"telegram")
assert first==second and first[1] > 0
print("cross-interface typed fixed-point passed")
PY

python3 - "$SKILL/tests/filesystem.json" "$TMP/filesystem-v2.json" <<'PY'
import json, pathlib, sys
source, target = map(pathlib.Path, sys.argv[1:])
spec=json.loads(source.read_text())
spec["version"]="2.0.0"
spec["description"]="Filesystem fixture version two"
target.write_text(json.dumps(spec, sort_keys=True))
PY
python3 "$SKILL/scripts/grow.py" "$TMP/filesystem-v2.json" --out "$TMP/filesystem-v2" >/dev/null

PROJECT="$TMP/project"
mkdir -p "$PROJECT/.claude"
(
  cd "$PROJECT"
  AIKO_HOME="$PROJECT/.aiko" python3 "$SKILL/scripts/grow.py" \
    "$SKILL/tests/filesystem.json" --out "$TMP/filesystem-v1" --install >/dev/null
  AIKO_HOME="$PROJECT/.aiko" python3 "$SKILL/scripts/grow.py" \
    "$TMP/filesystem-v2.json" --out "$TMP/filesystem-v2" --install >/dev/null
)

AIKO_HOME="$PROJECT/.aiko" python3 - "$PROJECT" "$TMP" "$SKILL" <<'PY'
import importlib.util, json, os, pathlib, sys
project, root, skill = map(pathlib.Path, sys.argv[1:])
module_spec=importlib.util.spec_from_file_location("grow", skill/"scripts/grow.py")
grow=importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(grow)
os.chdir(project)
v1=root/"filesystem-v1"; v2=root/"filesystem-v2"
a1=grow.artifact_for(v1); a2=grow.artifact_for(v2)
assert a1["digest"] != a2["digest"]
assert grow.skill_state(a1)["state"]=="retired"
assert grow.skill_state(a2)["state"]=="active"
spec1=json.loads((v1/"assets/receptor.json").read_text())
proofs,gates=grow.verify_candidate(spec1,v1)
assert grow.transition(a1,"stage",proofs,gates)["status"]=="replayed"
rolled=grow.rollback_to(a1["digest"])
assert rolled["state"]=="active" and rolled["active_digest"]==a1["digest"]
assert grow.skill_state(a2)["state"]=="retired"
retired=grow.retire(v1,spec1)
assert retired["state"]=="retired" and retired["active_digest"] is None
objects=project/".aiko/neuron-skills/objects"
assert sorted(path.name for path in objects.iterdir())==sorted([a1["digest"],a2["digest"]])
assert grow.artifact_for(objects/a1["digest"])==a1
assert grow.artifact_for(objects/a2["digest"])==a2
ledger=(project/".claude/contracts.jsonl").read_text()
assert ledger.count('"event":"neuron_skill_transition"')==8
assert "Filesystem fixture version two" not in ledger
print("candidate → admit → activate → replace → rollback → retire passed")
PY

(
  cd "$ROOT"
  CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell --lib \
    contract_native::skill_registry::graph::tests::generated_skill_is_inert_until_contract_activation_and_retirement_is_immediate \
    -- --ignored --exact --nocapture
)

echo "contract interface generator + lifecycle witness passed"
