#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:8793}"
if [[ "$BASE" == http* ]]; then echo "witness full $BASE"; else BASE="http://127.0.0.1:8793"; echo "witness full fallback $BASE"; fi
bash scripts/witness-api.sh "$BASE"
bash scripts/witness-ui.sh "$BASE"
test -f artifacts/e2e/primary-surface.png.log && echo "witness artifacts present"
echo "witness full PASS"
