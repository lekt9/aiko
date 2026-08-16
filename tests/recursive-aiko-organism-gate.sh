#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
cd "$SCRATCH"

# The focused suite starts from an empty durable Contract file and executes the
# real SpawnAuthority -> BaseCliAgent -> child_process path twice (parent+child).
(cd "$ROOT/aiko-flow" && bun test --timeout=30000 packages/agents/tests/ContractAikoAgent.test.js)

AGENT="$ROOT/aiko-flow/packages/agents/src/ContractAikoAgent.js"
SPAWN="$ROOT/aiko-flow/packages/agents/src/SpawnAuthorityPolicy.js"
FLOW="$ROOT/aiko-flow/.smithers/workflows/deploy-aiko.tsx"

grep -q 'extends SpawnAuthorityAikoAgent' "$AGENT"
grep -q 'intersection(grantedScopes, parentEffects, this.childPolicy.effectScopes)' "$AGENT"
grep -q 'Delegated citations:' "$AGENT"
grep -q 'openCompensation' "$AGENT"
grep -q 'inheritEnv: false' "$SPAWN"
grep -q 'permissionMode: "default"' "$SPAWN"
! grep -q 'new AikoAgent({})' "$FLOW"
! grep -Eq 'handoff|account_id|tenant: z|role: z' "$FLOW"
grep -q 'ContractAikoAgent' "$FLOW"

# Compile the authored Smithers workflow as source. Runtime service binding is
# deliberately external and fail-closed; this catches JSX/import drift.
(cd "$ROOT/aiko-flow" && bun build .smithers/workflows/deploy-aiko.tsx \
  --target=node --outfile "$SCRATCH/deploy-aiko.mjs" \
  --external smthrs --external zod/v4 --external @smthrs/agents/ContractAikoAgent >/dev/null)
