#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export TMPDIR=/tmp
bun test apps/agent/test
pnpm --filter @unlock/agent typecheck
pnpm --filter @unlock/web typecheck
python - <<'CHECK'
import json
checks=json.load(open('artifacts/connectors/browser/browser-results.json'))['checks']
assert len(checks)>=14 and all(c['passed'] for c in checks)
CHECK
bun scripts/verify-connectors-deployment.ts
# Deployment witnesses are deliberately separate from mocked/unit tests.
python - <<'CHECK'
import json
from pathlib import Path
for name in (
    'connectors/browser/native-login-deployed.json',
    'connectors/deployed-native-login.json',
    'connectors/deployed-native-renewal.json',
    'connectors/deployed-native-index.json',
    'request-memory/deployed-agent.json',
    'backups/deployed.json',
    'backups/deployed-recovery.json',
):
    path = Path('artifacts') / name
    assert path.exists(), f'Missing deployment witness: {path}'
    assert json.loads(path.read_text()).get('verified') is True, f'Unverified: {path}'
backup = json.loads(Path('artifacts/backups/deployed.json').read_text())
recovery = json.loads(Path('artifacts/backups/deployed-recovery.json').read_text())
assert backup['id'] == recovery['id'], 'Recovery must verify the current backup'
print('Native login, renewal, crawling, agent replay and encrypted recovery witnesses passed.')
CHECK
