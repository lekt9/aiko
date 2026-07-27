#!/usr/bin/env bash
# roadmap-wave3-gate.sh — wave 3: R5 immutable source pin + R2d Registry Neuron.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

echo "=== [wave3] zig test suite ==="
zig build test

echo "=== [wave3] exe build ==="
zig build

echo "=== [wave3] R5: immutable source pin ==="
bash tests/source-pin-witness.sh

echo "=== [wave3] R2d: Registry Neuron over mesh ==="
python3 limbs/energy-router/tests/registry_witness.py

echo "=== [wave3] runtime gate ==="
bash tests/runtime-gate.sh

echo "=== [wave3] document + jespa + neuron gate ==="
bash tests/gate.sh

echo "=== ROADMAP WAVE3 OK ==="
