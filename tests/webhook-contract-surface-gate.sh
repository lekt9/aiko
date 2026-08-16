#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
(cd aiko-flow && bun test packages/server/tests/contractWebhookLifecycle.test.js packages/server/tests/contractWebhooks.test.js)
# The feature must be reachable from every promised public composition surface.
grep -q 'contractWebhooks.deliver' aiko-flow/packages/server/src/gateway.js
grep -q 'routeContractWebhookRpc' aiko-flow/packages/server/src/gateway.js
(cd aiko-flow && bun -e 'import { listGatewayRpcMethods } from "./packages/gateway/src/rpc/index.js"; for (const m of ["create","list","inspect","rotate","pause","revoke"]) if (!listGatewayRpcMethods().includes(`contractWebhooks.${m}`)) process.exit(1)')
grep -q 'ContractWebhookClient' aiko-flow/packages/gateway-client/src/index.ts
grep -q 'contractWebhooks' aiko-flow/packages/protocol/src/index.ts
grep -q 'pub mod contract_webhook_tools' aiko/crates/codegen/xai-grok-mcp/src/lib.rs
grep -q 'contract_webhook_create' aiko/crates/codegen/xai-grok-mcp/src/contract_webhook_tools.rs
# Refuse the two tempting regressions: body parsing before verification and caller-selected generations.
python3 - <<'PY'
from pathlib import Path
s=Path('aiko-flow/packages/server/src/contractWebhooks.js').read_text()
assert s.index('await verifier.verify') < s.index('JSON.parse')
delivery=s[s.index('async function deliver'):s.index('const management')]
assert 'request.endpointGeneration' not in delivery
assert 'request.credentialGeneration' not in delivery
assert 'rawBody:' not in delivery[delivery.index('contract.intake'):delivery.index('return Object.freeze')]
PY
git diff --check
