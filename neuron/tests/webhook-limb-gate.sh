#!/usr/bin/env bash
# Public witness for the standalone admitted Neuron webhook effector.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
zig build
python3 limbs/webhook/tests/conformance.py
