#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
zig test contract/libcontract/src/execution_control.zig
python3 - <<'PY'
from pathlib import Path
root=Path('.')
ec=(root/'contract/libcontract/src/execution_control.zig').read_text()
s=(root/'contract/libcontract/src/scheduler.zig').read_text()
c=(root/'contract/libcontract/src/c_abi.zig').read_text()
r=(root/'aiko/crates/codegen/xai-grok-shell/src/contract_native/execution_control.rs').read_text()
h=(root/'aiko/crates/codegen/xai-grok-shell/src/contract_native.rs').read_text()
claims={
 'unique incarnation': ['incarnation', 'boot_nonce'],
 'lease fence': ['lease_id', 'fence', 'StaleFence'],
 'Contract-time CAS': ['LeaseExpired', 'VersionMismatch', 'CommitOrder'],
 'bounded control': ['MAX_CLAIM_BATCH', 'MAX_LEASE_MS', 'MAX_ATTEMPTS'],
 'cancel/invalidate': ['Cancelled', 'Invalidated'],
 'crossed compensation': ['CompensationRequired', 'crossed'],
 'effect serialization': ['EffectKeyBusy', 'effect_key'],
}
for title, needles in claims.items():
    missing=[n for n in needles if n not in ec]
    assert not missing, f'{title}: missing {missing}'
for needle in ['lease_id','owner_incarnation','attempt','fence','graph_version','input_version','commit_ordinal']:
    assert needle in s and needle in c and needle in h, f'public transport missing {needle}'
assert 'owner_incarnation' in r and 'BOOT_NONCE' in r
assert 'state.lease_until_unix <= now_unix' in s, 'late settlement/renew must refuse'
assert 'max_items > execution_control.MAX_CLAIM_BATCH' in s
print('contract execution control public surface: OK')
PY
# The full native suite proves the public C ABI and scheduler compile together.
( cd contract/libcontract && zig build test )
echo 'contract-execution-control-gate: PASS'
