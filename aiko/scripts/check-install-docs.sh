#!/usr/bin/env bash
# Mechanical witness: install documentation matches scripts and Surplus proxy truth.
# Exit 0 only when every required claim is present and consistent.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PROXY_ROOT=${AIKO_PROXY_ROOT:-$(CDPATH= cd -- "$ROOT/../../aiko-proxy" 2>/dev/null && pwd || true)}

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

need_file() {
  local f=$1
  [[ -f "$f" ]] || fail "missing file $f"
}

need_grep() {
  local file=$1 pattern=$2 label=${3:-$pattern}
  rg -q -- "$pattern" "$file" || fail "$file missing: $label"
  ok "$file has $label"
}

need_file "$ROOT/README.md"
need_file "$ROOT/scripts/contract-runtime.sh"
need_file "$ROOT/scripts/install-aiko-package.sh"
need_file "$ROOT/sdk/registry/setup.sh"

# ── Aiko README: client install surface ──────────────────────────────
need_grep "$ROOT/README.md" 'scripts/contract-runtime\.sh install' 'source install command'
need_grep "$ROOT/README.md" 'aiko login' 'session login'
need_grep "$ROOT/README.md" 'aiko\.theclarityproject\.net' 'public proxy host'
need_grep "$ROOT/README.md" 'Surplus' 'Surplus upstream name'
need_grep "$ROOT/README.md" 'AIKO_CONTRACT_REPO|sibling.*contract|../contract' 'contract sibling requirement'
need_grep "$ROOT/README.md" 'rust-toolchain|Rust' 'Rust prerequisite'
need_grep "$ROOT/README.md" 'Zig' 'Zig prerequisite'
need_grep "$ROOT/README.md" 'AIKO_BIN_DIR|~/bin' 'binary install dir'
need_grep "$ROOT/README.md" 'AIKO_HOME|~/\.aiko' 'runtime home'
need_grep "$ROOT/README.md" 'target/aiko-package' 'package output dir'
need_grep "$ROOT/README.md" './install\.sh' 'portable install.sh'
need_grep "$ROOT/README.md" 'sdk/registry/setup\.sh' 'registry setup'
need_grep "$ROOT/README.md" 'PATH' 'PATH note for ~/bin'
need_grep "$ROOT/README.md" 'GITEA_TOKEN' 'registry token'

# ── Scripts still teach the same commands ────────────────────────────
need_grep "$ROOT/scripts/contract-runtime.sh" 'install' 'install command in script'
need_grep "$ROOT/scripts/contract-runtime.sh" 'AIKO_BIN_DIR' 'AIKO_BIN_DIR env'
need_grep "$ROOT/scripts/contract-runtime.sh" 'AIKO_HOME' 'AIKO_HOME env'
need_grep "$ROOT/scripts/contract-runtime.sh" 'aiko-install-selfcheck|selfcheck\.sh' 'packages install selfcheck'
need_grep "$ROOT/scripts/install-aiko-package.sh" 'AIKO_BIN_DIR' 'package installer AIKO_BIN_DIR'
need_grep "$ROOT/scripts/install-aiko-package.sh" 'selfcheck|AIKO_SKIP_SELFCHECK' 'install runs selfcheck by default'
need_file "$ROOT/scripts/aiko-install-selfcheck.sh"
need_grep "$ROOT/scripts/aiko-install-selfcheck.sh" 'postmortem' 'selfcheck writes postmortem ledger'
need_grep "$ROOT/scripts/aiko-install-selfcheck.sh" 'contract\.(declared|verified)' 'selfcheck writes contract-shaped events'
need_file "$ROOT/scripts/postmortem-contract.sh"
need_file "$ROOT/scripts/package-installable-witness.sh"
need_file "$ROOT/scripts/aiko-login-selfcheck.sh"
need_file "$ROOT/scripts/aiko-doctor-headless.sh"
need_file "$ROOT/scripts/gap-closure-snapshot.sh"
need_grep "$ROOT/sdk/registry/bin/aiko-install" 'selfcheck|SELFCHECK' 'registry installer runs selfcheck'
need_grep "$ROOT/scripts/contract-runtime.sh" 'package-installable-witness' 'package path runs installable witness'
need_grep "$ROOT/sdk/registry/setup.sh" 'GITEA_TOKEN' 'setup token'
need_grep "$ROOT/sdk/registry/setup.sh" 'GITEA_URL' 'setup Gitea URL'

# ── aiko-proxy operator docs (when sibling checkout exists) ──────────
if [[ -n "${PROXY_ROOT:-}" && -d "$PROXY_ROOT" ]]; then
  need_file "$PROXY_ROOT/README.md"
  need_file "$PROXY_ROOT/scripts/deploy.sh"
  need_file "$PROXY_ROOT/wrangler.toml"
  need_grep "$PROXY_ROOT/README.md" 'SURPLUS_API_KEY' 'proxy Surplus secret'
  need_grep "$PROXY_ROOT/README.md" 'api\.surplusintelligence\.ai' 'Surplus base URL'
  need_grep "$PROXY_ROOT/README.md" 'wrangler deploy|bash scripts/deploy\.sh' 'deploy command'
  need_grep "$PROXY_ROOT/README.md" 'aiko-openai-compat' 'compat binding note'
  need_grep "$PROXY_ROOT/scripts/deploy.sh" 'SURPLUS_API_KEY' 'deploy.sh Surplus secret'
  need_grep "$PROXY_ROOT/wrangler.toml" 'api\.surplusintelligence\.ai' 'wrangler UPSTREAM_BASE'
  # Stale Codegraff-primary language must not remain as the documented default
  if rg -q 'CODEGRAFF_API_KEY=cg_sk_' "$PROXY_ROOT/README.md"; then
    fail "aiko-proxy README still shows CODEGRAFF_API_KEY=cg_sk_ as the primary local run"
  fi
  if rg -q 'gateway\.codegraff\.com' "$PROXY_ROOT/README.md"; then
    fail "aiko-proxy README still documents gateway.codegraff.com as primary"
  fi
  ok "aiko-proxy docs free of Codegraff-primary defaults"
else
  echo "warn: aiko-proxy checkout not found at sibling path; skipped proxy checks" >&2
fi

# ── REPOSITORY-GUIDE packaging map still lists install ───────────────
if [[ -f "$ROOT/docs/REPOSITORY-GUIDE.md" ]]; then
  need_grep "$ROOT/docs/REPOSITORY-GUIDE.md" 'scripts/contract-runtime\.sh install' 'guide install'
fi

echo
echo "ALL INSTALL DOC CHECKS PASSED"
exit 0
