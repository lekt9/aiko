#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
python3 tests/check_agents.py
python3 bench/jespa/benchmark.py --seeds 17 43 --verify-ledger
python3 bench/jespa/benchmark.py --suite organism --seeds 17 43 101 --verify-ledger

# Prove the ledger gate snapshots input and counts unique reproduced benchmark
# identities rather than rows. A duplicate win and a non-reproduced win must
# not satisfy a target of two; adding a second genuine unique row must.
jespa_gate_tmp=$(mktemp -d "${TMPDIR:-/tmp}/neuron-jespa-selftest.XXXXXX")
jespa_gate_ledger="$jespa_gate_tmp/ledger.jsonl"
printf '%s\n' \
  '{"bench":"same","won":true,"reproduced":true,"witness":"true"}' \
  '{"bench":"same","won":true,"reproduced":true,"witness":"true"}' \
  '{"bench":"fake","won":true,"reproduced":false,"witness":"true"}' \
  > "$jespa_gate_ledger"
if JESPA_LEDGER="$jespa_gate_ledger" JESPA_WIN_TARGET=2 \
    bash bench/jespa/jespa-benchmarks-gate.sh >/dev/null 2>&1; then
  echo "[neuron] FAIL — JESPA ledger gate counted duplicate or non-reproduced wins"
  rm -f "$jespa_gate_ledger"
  rmdir "$jespa_gate_tmp"
  exit 1
fi
printf '%s\n' \
  '{"bench":"second","won":true,"reproduced":true,"witness":"true"}' \
  >> "$jespa_gate_ledger"
JESPA_LEDGER="$jespa_gate_ledger" JESPA_WIN_TARGET=2 \
  bash bench/jespa/jespa-benchmarks-gate.sh >/dev/null
rm -f "$jespa_gate_ledger"
rmdir "$jespa_gate_tmp"

JESPA_WIN_TARGET=4 bash bench/jespa/jespa-benchmarks-gate.sh
echo "[neuron] PASS — document contract and honest benchmark witness are green"
