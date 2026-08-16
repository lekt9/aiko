#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="$ROOT/aiko-flow/packages/cloudflare-webhook"

test -f "$PKG/package.json"
test -f "$PKG/src/worker.ts"
test -f "$PKG/src/index.ts"
grep -q 'export default worker' "$PKG/src/worker.ts"
grep -q '"./worker"' "$PKG/package.json"
grep -q 'WEBHOOK_SECRETS.get' "$PKG/src/worker.ts"
! grep -Eq 'env\[[^]]+\]|fetch\([^)]*https?://[^g]' "$PKG/src/worker.ts"

(cd "$PKG" && bunx tsc -p tsconfig.json --noEmit)
(cd "$PKG" && bun test tests/worker.test.ts tests/verifiers.test.ts tests/queue.test.ts)

# This frontier produces a hermetic Worker artifact only. Deployment belongs to the release frontier.
! grep -RniE "liveDeploymentClaim:[[:space:]]*true|smoke:[[:space:]]*.[Pp]assed" "$PKG/src" "$PKG/tests"
echo "cloudflare webhook edge gate: ok"
