#!/usr/bin/env bash
# Compatible layer packages: lock, direction, install, Cell runner.
# Falsifier: put contract in neuron/aiko-package.json requires — check goes red.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
fail() { echo "FAIL aiko-packages: $*" >&2; exit 1; }

python3 scripts/aiko-packages.py check || fail "check red on this tree"
python3 scripts/aiko-packages.py list >/dev/null

# Direction: neuron must not require contract.
python3 - <<'PY'
import json
from pathlib import Path
n = json.loads(Path("neuron/aiko-package.json").read_text())
c = json.loads(Path("contract/aiko-package.json").read_text())
cell = json.loads(Path("cell/aiko-package.json").read_text())
assert n["requires"] == [], n
assert "contract" not in n["requires"]
assert c["requires"] == ["neuron"], c
assert cell["requires"] == [] and cell["api"] == "cell/v0", cell
ctl = Path("aiko-flow/aiko-package.json")
if ctl.exists():
    p = json.loads(ctl.read_text())
    assert "cell" in p["requires"], p
    assert "contract" not in p["requires"] and "neuron" not in p["requires"], p
print("ok direction")
PY

# Tamper: neuron requiring contract is refused.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp neuron/aiko-package.json "$tmp/neuron.aiko-package.json"
python3 - <<PY
import json
from pathlib import Path
p = Path("neuron/aiko-package.json")
data = json.loads(p.read_text())
data["requires"] = ["contract"]
p.write_text(json.dumps(data))
PY
set +e
python3 scripts/aiko-packages.py check >/dev/null 2>"$tmp/check.err"
rc=$?
set -e
mv "$tmp/neuron.aiko-package.json" neuron/aiko-package.json
[ "$rc" -ne 0 ] || fail "check admitted neuron→contract"
grep -q "contract\|require" "$tmp/check.err" || fail "tamper refusal did not name the defect"

# Install into a temp home and resolve the Cell runner the Smithers way.
HOME="$tmp/home"
export HOME
AIKO_HOME="$tmp/home/.aiko"
export AIKO_HOME
python3 scripts/aiko-packages.py install
test -f "$AIKO_HOME/packages/cell/current/run.py" || fail "installed cell runner missing"
test -f "$AIKO_HOME/packages/stack.lock.json" || fail "installed stack.lock missing"
python3 - <<'PY'
import os
from pathlib import Path
home = Path(os.environ["AIKO_HOME"])
os.environ.pop("AIKO_CELL_RUNNER", None)
candidates = [
    home / "packages" / "cell" / "current" / "run.py",
    home / "cell" / "run.py",
]
hit = next((p for p in candidates if p.is_file()), None)
assert hit is not None, candidates
assert hit.name == "run.py"
print("ok installed runner", hit)
PY

echo "PASS aiko-packages-gate"
