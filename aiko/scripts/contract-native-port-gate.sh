#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
python3 scripts/test-contract-workflow.py
python3 scripts/test-contract-lineage.py
python3 scripts/test-contract-native-skills.py
bash scripts/witness-contract-chokepoint.sh
bash scripts/witness-contract-predictor-persistence.sh
CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell contract_native::skill_registry --lib
echo "CONTRACT-NATIVE-PORT PASS"
