#!/usr/bin/env bash
set -euo pipefail
# Stub gate — full spawn membrane is Designed, not yet wired to live contract worker.
# Asserts covenant + transcript absence + fenced-lease refusal are documented.
test -s docs/graph-engineering/DROP-IN-SPAWN.md
grep -q 'inheritEnv=false' docs/graph-engineering/DROP-IN-SPAWN.md
grep -q 'delegation_capability' docs/graph-engineering/DROP-IN-SPAWN.md
grep -q 'ForgedSender' docs/graph-engineering/DROP-IN-SPAWN.md || grep -q 'Cross-journal' docs/graph-engineering/DROP-IN-SPAWN.md
echo "drop-in-spawn: PASS (covenant + lease + conversation documented)"
