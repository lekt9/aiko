#!/usr/bin/env bash
# Prove public docs match the published monorepo and are safe to ship.
# Exit 0 only when the claims below hold in the tree. Do not pass on prose.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

need_file() {
  [[ -f "$1" ]] || fail "missing $1"
  ok "exists $1"
}

need_grep() {
  local file=$1 pattern=$2
  rg -q -- "$pattern" "$file" || fail "$file missing /$pattern/"
  ok "$file has /$pattern/"
}

forbid_grep() {
  local file=$1 pattern=$2
  if rg -q -- "$pattern" "$file"; then
    fail "$file still contains /$pattern/"
  fi
  ok "$file free of /$pattern/"
}

need_file LICENSE
need_file NOTICE
need_file CONTRIBUTING.md
need_file SECURITY.md
need_file CODE_OF_CONDUCT.md
need_file README.md
need_file docs/SOURCE-OF-TRUTH.md
need_file docs/README.md

need_grep LICENSE 'Apache License'
need_grep NOTICE 'SpaceXAI'
need_grep README.md 'github.com/lekt9/aiko'
need_grep README.md 'zig build'
need_grep README.md 'Aiko'
need_grep docs/SOURCE-OF-TRUTH.md 'github.com/lekt9/aiko'
need_grep docs/SOURCE-OF-TRUTH.md 'neuron/'
need_grep docs/SOURCE-OF-TRUTH.md 'contract/'
need_grep CLAUDE.md 'docs/SOURCE-OF-TRUTH.md'
need_grep SECURITY.md 'lekt9/aiko/security'

forbid_grep README.md 'gitea:Unbrowse/commons'
forbid_grep README.md 'aiko-flow/'
forbid_grep README.md '100\.124\.140\.92'
forbid_grep aiko/README.md '100\.124\.140\.92'
forbid_grep aiko/README.md 'gateway\.codegraff\.com'
forbid_grep aiko/SECURITY.md 'hackerone.com/x'
forbid_grep contract/README.md '100\.67\.11\.99'
forbid_grep contract/README.md 'gitea:Unbrowse/contract.git'
forbid_grep neuron/bench/agentic-organism/README.md '/Users/lewis/'

if [[ -e cell/data/hoysan-cto-lashing-context.md ]]; then
  fail "customer operational file cell/data/hoysan-cto-lashing-context.md is present"
fi
ok "no tracked hoysan operational context file"

# Public first-party docs must not carry private operator hosts or key-shaped tokens.
# Scope is the published product surfaces, not vendor/submodule trees.
SURFACES=(
  README.md
  CLAUDE.md
  CONTRIBUTING.md
  SECURITY.md
  docs/README.md
  docs/SOURCE-OF-TRUTH.md
  aiko/README.md
  aiko/CONTRIBUTING.md
  aiko/SECURITY.md
  contract/README.md
  neuron/README.md
  cell/README.md
)
for f in "${SURFACES[@]}"; do
  if rg -q -- 'BEGIN (RSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,}' "$f"; then
    fail "$f looks like it contains a secret"
  fi
done
ok "public surfaces free of key-shaped secrets"

echo
echo "docs-oss-ready-gate: PASS"
