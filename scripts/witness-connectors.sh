#!/usr/bin/env bash
set -euo pipefail
cd /home/deck/work/unlock
bun test apps/agent/test
pnpm --filter @unlock/agent typecheck
pnpm --filter @unlock/web typecheck
python - <<'CHECK'
import json
checks=json.load(open('artifacts/connectors/browser/browser-results.json'))['checks']
assert len(checks)>=14 and all(c['passed'] for c in checks)
CHECK
bun scripts/verify-connectors-deployment.ts
# The complete original objective also requires a real secure password relay.
if ! test -s artifacts/connectors/password-relay-e2e.json; then
  echo "BLOCKED: real password-relay login not verified. Configure the deployed Unlock vault origin and owner-approved runtime mapping; see docs/connector-vault-setup.md." >&2
  exit 1
fi
