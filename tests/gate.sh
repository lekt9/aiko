#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 tests/check_agents.py
python3 bench/jespa/benchmark.py --seeds 17 43 --verify-ledger
JESPA_WIN_TARGET=1 bash bench/jespa/jespa-benchmarks-gate.sh
echo "[neuron] PASS — document contract and honest benchmark witness are green"
