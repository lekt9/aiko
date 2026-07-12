#!/usr/bin/env bash
# smoke.sh — end-to-end check of a running unbrowse proxy (local or deployed).
#
# Usage:
#   ./smoke.sh                         # defaults to http://localhost:8787
#   ./smoke.sh https://unbrowse-proxy.<subdomain>.workers.dev
#   ./smoke.sh https://unbrowse.ai
#
# Sends NO client auth — the proxy must inject the upstream key itself. Exits 0
# only if /health, /v1/models, and a real chat completion all succeed.
set -uo pipefail

BASE="${1:-http://localhost:8787}"
BASE="${BASE%/}"
fail() { echo "✗ $1"; exit 1; }

echo "→ smoke-testing $BASE (no client auth)"

# 1. Liveness
health=$(curl -fsS --max-time 10 "$BASE/health" 2>/dev/null) || fail "/health unreachable"
echo "$health" | grep -q '"ok":true' || fail "/health did not report ok:true — got: $health"
echo "✓ /health ok"

# 2. Model list collapses to the single unbrowse-default
models=$(curl -fsS --max-time 15 "$BASE/v1/models" 2>/dev/null) || fail "/v1/models unreachable"
echo "$models" | grep -q "unbrowse-default" || fail "/v1/models missing unbrowse-default — got: $models"
echo "✓ /v1/models → unbrowse-default"

# 3. A real chat completion with a placeholder model and no key
chat=$(curl -fsS --max-time 60 "$BASE/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"default","messages":[{"role":"user","content":"Reply with exactly: SMOKE_OK"}],"max_tokens":300}' \
  2>/dev/null) || fail "/v1/chat/completions request failed"
echo "$chat" | grep -q "SMOKE_OK" || fail "chat completion did not contain SMOKE_OK — got: $(echo "$chat" | head -c 300)"
echo "✓ /v1/chat/completions → SMOKE_OK (key injected upstream)"

echo "✅ proxy at $BASE is working end-to-end"
