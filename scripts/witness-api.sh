#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:8793}"
echo "witness api health $BASE/api/health"
curl -sf "$BASE/api/health" | grep -q '"ok"'
echo "witness api login"
curl -sf -X POST "$BASE/api/login" -H 'content-type: application/json' -d '{"pin":"hoysan-test"}' | grep -q 'ok'
echo "witness workers crud"
curl -sf "$BASE/api/workers" | grep -q 'LOCAL\|workers'
echo "witness rosters"
curl -sf "$BASE/api/rosters" | grep -q 'roster\|cells\|\[\]'
echo "witness deployments"
curl -sf "$BASE/api/deployments" | grep -q '\[\]\|deployments\|demand'
echo "witness api PASS"
