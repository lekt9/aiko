#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

python3 scripts/test-contract-workflow.py
python3 scripts/test-contract-lineage.py
python3 scripts/test-contract-native-skills.py
bash scripts/witness-contract-chokepoint.sh
bash scripts/witness-contract-predictor-persistence.sh

# Runtime state-machine witnesses: interface families, fail-closed effects,
# acknowledgement/progress separation, bounded process lifecycle, and evidence bindings.
CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
  contract_native::membrane::tests --lib
CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
  contract_native::tests::membrane_degrades_reads_but_holds_unbound_effects --lib
CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
  contract_native::tests::receipt_never_confuses_acknowledgement_with_progress --lib
CARGO_INCREMENTAL=0 cargo test -p xai-grok-shell \
  contract_native::skill_registry::tests::resolves_only_named_dependency_evidence --lib

bash scripts/witness-first-principles.sh
echo "CONTRACT-MEMBRANE PASS"
