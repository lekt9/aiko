#!/usr/bin/env bash
# Public witness for the standalone digest-admitted Unbrowse Neuron boundary.
set -euo pipefail
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
zig build
python3 limbs/unbrowse/tests/conformance.py
python3 limbs/unbrowse/tests/mutation_falsifiers.py
