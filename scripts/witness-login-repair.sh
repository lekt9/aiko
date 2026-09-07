#!/usr/bin/env bash
set -euo pipefail
export TMPDIR=/tmp
cd "$(dirname "$0")/.."
bun test apps/agent/test/native-login.test.ts apps/agent/test/native-login-vault.test.ts apps/agent/test/codegraff.test.ts apps/agent/test/connector-browser-lifecycle.test.ts
pnpm --filter @unlock/agent typecheck
bun scripts/verify-connectors-deployment.ts
python - <<'PY'
import json, datetime
from pathlib import Path
for name in ['connectors/browser/native-login-recovery-ui.json', 'connectors/login-repair-api.json']:
    receipt = json.loads((Path('artifacts') / name).read_text())
    assert receipt['verified'] is True, name
    at = datetime.datetime.fromisoformat(receipt['at'].replace('Z', '+00:00'))
    assert 0 <= (datetime.datetime.now(datetime.timezone.utc) - at).total_seconds() < 7200, 'Stale receipt: ' + name
    assert receipt['base'] == 'https://aiko-agent.lewis-6d8.workers.dev'
    if 'screenshot' in receipt:
        import hashlib
        png = Path(receipt['screenshot']).read_bytes()
        assert hashlib.sha256(png).hexdigest() == receipt['screenshotSha256']
    if 'runnerHash' in receipt:
        import hashlib
        assert hashlib.sha256(Path('apps/agent/assets/runner.txt').read_bytes()).hexdigest() == receipt['runnerHash']
print('Fresh deployed private-login API and browser witnesses passed.')
PY
