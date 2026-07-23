#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SKILL="$ROOT/.agents/skills/contract-interface"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT HUP INT TERM

for SPEC in http-webhook cli-stream mobile-lifecycle scheduled-email device-watcher; do
  python3 "$SKILL/scripts/grow.py" "$SKILL/tests/$SPEC.json" --out "$TMP/$SPEC" >/dev/null
  python3 "$SKILL/scripts/conform.py" "$TMP/$SPEC"
done

AIKO_HOME="$TMP/user-root" python3 "$SKILL/scripts/grow.py" \
  "$SKILL/tests/http-webhook.json" --out "$TMP/install-source" --install >/dev/null
test -f "$TMP/user-root/skills/http-webhook/contract-skill.json"

python3 - "$TMP" "$SKILL" <<'PY'
import importlib.util, json, pathlib, subprocess, sys
root, skill = map(pathlib.Path, sys.argv[1:])
expected = {
  "http-webhook": ["external_message"],
  "cli-stream": ["local_reversible", "local_write"],
  "mobile-lifecycle": ["local_reversible", "external_message", "permission_change"],
  "scheduled-email": ["local_reversible", "external_message"],
  "device-watcher": ["read_only", "local_write"],
}
shapes = set()
for name, effects in expected.items():
    manifest=json.loads((root/name/"contract-skill.json").read_text())
    actual=[n["effect"] for n in manifest["nodes"] if n["key"].startswith("execute-")]
    assert actual == effects, (name, actual)
    shapes.add(tuple(k.split("-",1)[0] for k in (n["key"] for n in manifest["nodes"])))
assert len(shapes) == 3, "matrix must exercise one-, two-, and three-effect fan-outs"
assert len({tuple(value) for value in expected.values()}) == 5, "effect semantics must differ across all fixtures"

module_spec=importlib.util.spec_from_file_location("grow", skill/"scripts/grow.py")
grow=importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(grow)
runtime=json.loads((skill/"tests/http-webhook.json").read_text())
plist=grow.supervisor_plist(runtime, pathlib.Path("/home/specimen"), pathlib.Path("/aiko/specimen"))
assert plist["ProgramArguments"] == ["/usr/bin/true"]
assert not any(isinstance(value, str) and (";" in value or "&&" in value) for value in plist["ProgramArguments"])
assert plist["EnvironmentVariables"]["AIKO_INTERFACE_ID"] == "http-webhook"
assert plist["KeepAlive"] is True

bad = [
  {"id":"bad","description":"x","triggers":["x"],"events":[{"id":"e","kind":"e"}],"effects":[{"id":"x","effect":"publish","variants":["x"],"requires_authority":False}]},
  {"id":"bad","description":"x","triggers":["x"],"events":[{"id":"e","kind":"e"}],"effects":[{"id":"x","effect":"external_message","variants":["typing"],"ephemeral":True}]},
  {"id":"bad","description":"x","triggers":["x"],"events":[{"id":"e","kind":"e"}],"effects":[{"id":"x","effect":"invented","variants":["x"]}]},
]
for i, spec in enumerate(bad):
    path=root/f"bad-{i}.json"; path.write_text(json.dumps(spec))
    result=subprocess.run([sys.executable, str(skill/"scripts/grow.py"), str(path), "--out", str(root/f"bad-{i}")], capture_output=True)
    assert result.returncode != 0, (i, result.stdout, result.stderr)
print("negative authority, TTL, and taxonomy cases rejected")
PY

if rg -n -i 'telegram|ios|email|webhook|device|slack' "$SKILL/scripts/grow.py"; then
  echo "provider branch leaked into generic compiler" >&2
  exit 1
fi
python3 "$ROOT/scripts/test-contract-native-skills.py"
cargo test -p xai-telegram-daemon --quiet
echo "cross-interface matrix witness passed"
