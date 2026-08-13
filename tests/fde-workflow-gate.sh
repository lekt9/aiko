#!/usr/bin/env bash
# Root witness for the Cell-native FDE self-wire increment.
# Falsifier: delete patterns/fde/ or the secret refusal and this gate goes red.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fail() { echo "FAIL fde-workflow: $*" >&2; exit 1; }

doc=docs/AI-FORWARD-DEPLOYED-ENGINEER.md
test -s "$doc" || fail "missing $doc"
grep -q 'Proven' "$doc" || fail "$doc missing Proven"
grep -q 'Designed' "$doc" || fail "$doc missing Designed"
grep -q 'Absent' "$doc" || fail "$doc missing Absent"
grep -q 'telethon-fde-gate' "$doc" || fail "$doc does not name the first-vertical gate"
grep -q 'the first AI FDE' "$doc" || fail "$doc must name the market-first claim in order to keep it Absent"

bash cell/tests/gates/fde-self-wire.sh

bind=docs/AIKO-WORKFLOW-BINDING.md
test -s "$bind" || fail "missing $bind"
grep -qi 'no second scheduler' "$bind" || fail "$bind must refuse a second scheduler"
if grep -qi 'aiko-flow is a shipped' "$bind"; then
  fail "$bind documents unpublished aiko-flow as shipped"
fi

if [ -x zig-out/bin/aiko-doctor ]; then
  python3 - <<'PY'
import json, pathlib, subprocess, tempfile, os
doc = pathlib.Path("zig-out/bin/aiko-doctor")
# Cell is the workflow: doctor asks Cell to canonicalize, then projects a walk.
raw = subprocess.check_output(
    [str(doc), "bind-workflow", "cell/patterns/fde/self-wire.cell.yaml", "--plan"],
    text=True,
)
bind = json.loads(raw)
walk = bind["walk"]
ids = [n["id"] for n in walk["nodes"]]
assert ids == ["account", "workflow", "aiko"], ids
deps = {n["id"]: set(n["depends_on"]) for n in walk["nodes"]}
assert deps["account"] == set()
assert "account" in deps["workflow"]
assert {"account", "workflow"} <= deps["aiko"]
digest = bind["cell"]["digest"]
assert len(digest) == 64, digest
plan = bind["plan"]
assert plan.get("cycle_list") == [], plan
assert plan.get("unknown_dependencies") == [], plan
assert plan.get("ungrounded") == [], plan
assert plan.get("ungated") == [], plan
assert plan["ready"] == ["account"], plan
# Code movement changes the digest: a different Cell is a different pin.
other = json.loads(subprocess.check_output(
    [str(doc), "bind-workflow", "cell/patterns/fde/deploy-aiko.cell.yaml"],
    text=True,
))
assert other["cell"]["digest"] != digest, (digest, other["cell"]["digest"])
# Pause/resume is durable across a new process.
ctl = tempfile.mkdtemp()
subprocess.check_output([str(doc), "workflow-control", ctl, "bind", "--digest", digest])
subprocess.check_output([str(doc), "workflow-control", ctl, "pause"])
paused = json.loads(subprocess.check_output([str(doc), "workflow-control", ctl, "status"]))
assert paused["status"] == "paused" and paused["scheduler"] is False, paused
resumed = json.loads(subprocess.check_output([str(doc), "workflow-control", ctl, "resume"]))
assert resumed["status"] == "running", resumed
print("ok bind-workflow")
PY
fi

echo "PASS fde-workflow-gate"
