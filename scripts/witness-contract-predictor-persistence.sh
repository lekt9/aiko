#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
KEY="restart-$$-${RANDOM}"
cd "$TMP"
HOME="$TMP/home" python3 "$ROOT/scripts/contract_predictor_witness.py" train "$KEY"
HOME="$TMP/home" python3 "$ROOT/scripts/contract_predictor_witness.py" recall "$KEY"
echo "PREDICTOR-PERSISTENCE PASS: learned state survived a fresh process"
