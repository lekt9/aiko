#!/usr/bin/env bash
# roadmap-wave2-gate.sh — the pinned jesus-ralph witness for wave 2:
#   R2  energy-router admitted limb — wire into meta-agent router slot
#       (replace FixedNeuron stubs), honest benchmark deltas on held-out
#       tasks, Zig EnergyRouterNeuron first-class path, revoke/GC.
#   R3  fan-out / pipeline reusable limb packages with conformance
#       witnesses (duplicate coordinator, quorum containment, fail-closed)
#   R4  closed telemetry → policy-advisor loop (firing-record projection,
#       rollup artifacts, governed topology/grant proposals)
#   R5  immutable source dependency pin (independent repo/revision)
#       plus cross-machine artifact sync (§22) + distributed cache
#       dedupe (§25).
# Every item settles through a runnable witness. File presence and prose
# are not completion (reference/ROADMAP.md §208).
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

echo "=== [wave2] zig test suite ==="
zig build test

echo "=== [wave2] exe build (test build does not compile main.zig) ==="
zig build

echo "=== [wave2] R2: energy-router admitted-limb lifecycle + benchmark ==="
python3 limbs/energy-router/tests/lifecycle.py

echo "=== [wave2] R3: fan-out + pipeline conformance ==="
python3 limbs/fanout/tests/conformance.py

echo "=== [wave2] R4: telemetry-advisor closed loop ==="
bash tests/telemetry-advisor-witness.sh

echo "=== [wave2] runtime gate ==="
bash tests/runtime-gate.sh

echo "=== [wave2] document + jespa + neuron gate ==="
bash tests/gate.sh

echo "=== ROADMAP WAVE2 OK ==="
