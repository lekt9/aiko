#!/usr/bin/env bash
# Mechanical witness: install documentation matches scripts and Surplus proxy truth.
# Exit 0 only when every required claim is present and consistent.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# Cross-repo proxy checks are opt-in so an unrelated sibling checkout cannot
# make Aiko's own documentation witness nondeterministic.
PROXY_ROOT=${AIKO_PROXY_ROOT:-}

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
need_file "$ROOT/scripts/prep-installer.sh"
need_file "$ROOT/scripts/stage-dist-app.sh"
need_file "$ROOT/scripts/check-installer-ci.sh"
need_file "$ROOT/installer/macos/distribution.xml"
need_file "$ROOT/installer/macos/resources/welcome.html"
need_file "$ROOT/sdk/registry/setup.sh"

# ── Aiko README: client install surface ──────────────────────────────
need_grep "$ROOT/README.md" 'scripts/contract-runtime\.sh install' 'source install command'
need_grep "$ROOT/README.md" 'aiko login' 'session login'
need_grep "$ROOT/README.md" 'aiko login aiko' 'explicit Aiko login provider'
need_grep "$ROOT/README.md" 'aiko login grok' 'Grok login provider'
need_grep "$ROOT/README.md" 'aiko login openai' 'OpenAI login provider'
need_grep "$ROOT/README.md" 'aiko login codex' 'Codex login compatibility'
need_grep "$ROOT/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md" \
  'aiko login aiko' 'embedded authentication guide Aiko provider'
need_grep "$ROOT/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md" \
  'aiko login grok' 'embedded authentication guide Grok provider'
need_grep "$ROOT/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md" \
  'aiko login openai' 'embedded model guide OpenAI provider'
need_grep "$ROOT/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md" \
  'aiko login codex' 'embedded model guide Codex compatibility'
need_grep "$ROOT/README.md" 'aiko\.theclarityproject\.net' 'public proxy host'
need_grep "$ROOT/README.md" 'Surplus' 'Surplus upstream name'
need_grep "$ROOT/README.md" 'AIKO_CONTRACT_REPO|in-tree|../contract' 'in-tree contract path'
need_grep "$ROOT/README.md" 'rust-toolchain|Rust' 'Rust prerequisite'
need_grep "$ROOT/README.md" 'Zig' 'Zig prerequisite'
need_grep "$ROOT/README.md" 'AIKO_BIN_DIR|~/bin' 'binary install dir'
need_grep "$ROOT/README.md" 'AIKO_HOME|~/\.aiko' 'runtime home'
need_grep "$ROOT/README.md" 'target/aiko-package' 'package output dir'
need_grep "$ROOT/README.md" './install\.sh' 'portable install.sh'
need_grep "$ROOT/README.md" 'sdk/registry/setup\.sh' 'registry setup'
need_grep "$ROOT/README.md" 'PATH' 'PATH note for ~/bin'
need_grep "$ROOT/README.md" 'GITEA_TOKEN|GITEA_URL|registry' 'optional registry bootstrap'
need_grep "$ROOT/README.md" 'scripts/prep-installer\.sh' 'canonical macOS installer command'
need_grep "$ROOT/README.md" 'apps/aiko-app/package\.json.*version' 'desktop release version alignment check'
need_grep "$ROOT/README.md" 'pnpm --dir apps/aiko-app install --frozen-lockfile' 'desktop dependency install command'
need_grep "$ROOT/README.md" 'pnpm --dir apps/aiko-app runtime:prepare' 'native sidecar preparation command'
need_grep "$ROOT/README.md" 'pnpm --dir apps/aiko-app exec tauri build --bundles app' 'desktop app bundle build command'
need_grep "$ROOT/README.md" 'dist/Aiko-Installer-<version>\.pkg' 'versioned macOS installer output'
need_grep "$ROOT/README.md" 'Aiko-macOS\.pkg' 'stable CI/CD product installer asset'
need_grep "$ROOT/README.md" 'APPLE_INSTALLER_CERTIFICATE' 'installer signing secret'

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
need_grep "$ROOT/scripts/prep-installer.sh" 'Aiko-Installer-\$CLI_VERSION\.pkg' 'installer uses the CLI release version'
need_grep "$ROOT/scripts/prep-installer.sh" 'stage_app' 'installer recreates the staged app'
need_grep "$ROOT/scripts/prep-installer.sh" 'unzip -tq' 'installer verifies its zip'
need_grep "$ROOT/scripts/prep-installer.sh" 'installer/macos' 'installer uses tracked source templates'
need_grep "$ROOT/scripts/check-installer-ci.sh" 'release\.yml' 'CI/CD witness inspects release workflow'
need_file "$ROOT/apps/aiko-app/README.md"
need_grep "$ROOT/sdk/registry/setup.sh" 'GITEA_TOKEN' 'setup token'
need_grep "$ROOT/sdk/registry/setup.sh" 'GITEA_URL' 'setup Gitea URL'

# ── aiko-proxy operator docs (when explicitly requested) ─────────────
if [[ -n "${PROXY_ROOT:-}" && -d "$PROXY_ROOT" ]]; then
  need_file "$PROXY_ROOT/README.md"
  need_file "$PROXY_ROOT/scripts/deploy.sh"
  need_file "$PROXY_ROOT/wrangler.toml"
  need_grep "$PROXY_ROOT/README.md" 'CODEGRAFF_API_KEY' 'proxy Codegraff secret'
  need_grep "$PROXY_ROOT/README.md" 'gateway\.codegraff\.com' 'Codegraff base URL'
  need_grep "$PROXY_ROOT/README.md" 'wrangler deploy|bash scripts/deploy\.sh' 'deploy command'
  need_grep "$PROXY_ROOT/README.md" 'aiko-openai-compat' 'compat binding note'
  need_grep "$PROXY_ROOT/scripts/deploy.sh" 'CODEGRAFF_API_KEY' 'deploy.sh Codegraff secret'
  need_grep "$PROXY_ROOT/wrangler.toml" 'gateway\.codegraff\.com' 'wrangler upstream base'
  # The gateway publishes one model id; docs that still name an upstream slug
  # as the client-facing default would send users to a model the gate refuses.
  need_grep "$PROXY_ROOT/README.md" '\bbest\b' 'published model id'
  # Aiko routes to Codegraff and nothing else; a documented second upstream
  # would tell an operator to configure a provider the worker will not use.
  if rg -q 'api\.surplusintelligence\.ai' "$PROXY_ROOT/README.md"; then
    fail "aiko-proxy README still documents api.surplusintelligence.ai as an upstream"
  fi
  ok "aiko-proxy docs name Codegraff upstream and the published model id"
else
  echo "note: set AIKO_PROXY_ROOT to include aiko-proxy operator docs" >&2
fi

# ── REPOSITORY-GUIDE packaging map still lists install ───────────────
if [[ -f "$ROOT/docs/REPOSITORY-GUIDE.md" ]]; then
  need_grep "$ROOT/docs/REPOSITORY-GUIDE.md" 'scripts/contract-runtime\.sh install' 'guide install'
fi

echo
echo "ALL INSTALL DOC CHECKS PASSED"
exit 0
