#!/bin/bash
set -euo pipefail
CELL="$(cd "$(dirname "$0")/../.." && pwd)"
# The canvas is a projection of the engine; a build that no longer compiles is
# a witness that no longer exists. Fail closed if the install is missing —
# "unverifiable" must never read as "green".
[ -d "$CELL/web/node_modules" ] || { echo "FAIL web-build: cell/web/node_modules missing — run npm --prefix cell/web install"; exit 1; }
if ! npm --prefix "$CELL/web" run build > /tmp/gate_web_build.log 2>&1; then
  echo "FAIL web-build: next build failed"
  tail -20 /tmp/gate_web_build.log
  exit 1
fi
echo "PASS web-build: next build green"
