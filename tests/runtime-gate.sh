#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
zig fmt --check build.zig src
zig build test
zig build
human="$(./zig-out/bin/neuron demo)"
json="$(./zig-out/bin/neuron check --json)"
grep -q "firing committed atomically" <<<"$human"
python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["status"]=="ok" and d["committed"]==3 and d["artifacts"]==d["messages"]==d["neurons"]==1' <<<"$json"
python3 bench/jespa/runtime_tasks.py --assert-win
JESPA_WIN_TARGET=2 bash bench/jespa/jespa-benchmarks-gate.sh
bash tests/meta-agent-gate.sh
echo "[runtime] PASS — Zig build, behavioral claims, CLI UX, and reproduced task ledger are green"
