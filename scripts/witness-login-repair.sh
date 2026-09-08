#!/usr/bin/env bash
set -euo pipefail
export TMPDIR=/tmp
cd "$(dirname "$0")/.."
bun test apps/agent/test/native-login.test.ts apps/agent/test/native-login-vault.test.ts apps/agent/test/codegraff.test.ts apps/agent/test/connector-browser-lifecycle.test.ts
pnpm --filter @unlock/agent typecheck
# The broad legacy connector verifier provisions pasted password-manager tokens,
# which the current authorization-only manager API deliberately rejects.
# This release gate checks the private-login surface and its real API/UI receipts.
bun - <<'TS'
import {cloudflareState} from './scripts/cloudflare-paths.ts';
const env=await cloudflareState();
if(env.AIKO_E2E_OWNER!=='acct_cloudflare_e2e02')throw Error('Wrong canary account');
const base=env.AIKO_CLOUDFLARE_URL;
const ready=await fetch(base+'/ready',{signal:AbortSignal.timeout(20000)});
if(!ready.ok||(await ready.json()).storage!=='durable-object')throw Error('Deployed storage unavailable');
const page=await fetch(base+'/connect',{signal:AbortSignal.timeout(20000)});
if(!page.ok||!(await page.text()).includes('id="root"'))throw Error('Connect UI unavailable');
const rejected=await fetch(base+'/api/connectors/connections',{signal:AbortSignal.timeout(20000)});
if(rejected.status!==401)throw Error('Authentication gate failed');
await rejected.body?.cancel();
const response=await fetch(base+'/api/connectors/connections',{headers:{authorization:`Bearer ${env.AIKO_E2E_TOKEN}`},signal:AbortSignal.timeout(120000)});
const connections=await response.json();
const ui=await Bun.file('artifacts/connectors/browser/native-login-recovery-ui.json').json();
if(!response.ok||connections.nativeInline!==true||!connections.connections?.some(row=>row.id===ui.connectionId&&row.status==='connected'))throw Error('Verified UI connection is not available');
console.log('Deployed storage, auth gate and current private-login connection passed.');
TS
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
