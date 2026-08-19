#!/usr/bin/env bash
set -euo pipefail
BASE="${1:-http://127.0.0.1:8793}"
# Real browser witness — fails closed. A placeholder log is not a screenshot.
command -v agent-browser > /dev/null 2>&1 || { echo "witness ui FAIL: agent-browser not installed"; exit 1; }
mkdir -p artifacts/e2e
agent-browser open "$BASE" > /dev/null
sleep 2
agent-browser screenshot artifacts/e2e/primary-surface.png > /dev/null
[ -s artifacts/e2e/primary-surface.png ] || { echo "witness ui FAIL: screenshot missing or empty"; exit 1; }
echo "witness ui PASS: artifacts/e2e/primary-surface.png"
