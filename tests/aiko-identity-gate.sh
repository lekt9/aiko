#!/usr/bin/env bash
# Aiko is the only FDE name on user-facing surfaces.
# Crate paths, model ids, ~/.grok, grok.com, and competitor benches may still
# contain the word grok.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

# Product-name strings that must not appear on first-party surfaces.
FORBIDDEN_PATTERNS=(
  'Grok Build'
  'Sign in to Grok'
  "Couldn't start Grok"
  'Grok Crash Report'
  'Grok agent server starting'
  'Grok crashed during your last session'
  'Grok Build User Guide'
  'Sign in to Grok'
)

# Paths where a leftover is a product-identity bug.
SURFACES=(
  README.md
  CLAUDE.md
  docs/SOURCE-OF-TRUTH.md
  aiko/README.md
  aiko/docs/GOAL.md
  aiko/docs/REPOSITORY-GUIDE.md
  aiko/crates/codegen/xai-grok-pager/docs/user-guide/README.md
  aiko/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md
  aiko/crates/codegen/xai-grok-pager-minimal/src/welcome.rs
  aiko/crates/codegen/xai-grok-pager-minimal/src/auth.rs
  aiko/crates/codegen/xai-grok-pager-bin/src/main.rs
  aiko/crates/codegen/xai-crash-handler/src/symbolicate.rs
  aiko/crates/codegen/xai-grok-mcp/src/oauth.rs
  aiko/crates/codegen/xai-grok-agent/src/config.rs
)

for pat in "${FORBIDDEN_PATTERNS[@]}"; do
  if git grep -n -F -- "$pat" -- "${SURFACES[@]}" >/dev/null 2>&1; then
    git grep -n -F -- "$pat" -- "${SURFACES[@]}" || true
    fail "forbidden product string: $pat"
  fi
done
ok "listed surfaces free of Grok FDE strings"

# Broader: no "Grok Build" outside historical benches, changelogs, lockfiles, vendor.
if git grep -n -F 'Grok Build' -- \
    ':!aiko/apps/frontend/**' \
    ':!**/node_modules/**' \
    ':!aiko/.agents/**' \
    ':!**/changelogs/**' \
    ':!aiko/crates/codegen/xai-grok-shell/CHANGELOG.md' \
    ':!aiko/docs/AIKO-VS-GROK*' \
    ':!aiko/docs/GROK-*' \
    ':!aiko/docs/GROK-VS-AIKO*' \
    ':!**/*.json' \
    >/dev/null 2>&1; then
  git grep -n -F 'Grok Build' -- \
    ':!aiko/apps/frontend/**' \
    ':!**/node_modules/**' \
    ':!aiko/.agents/**' \
    ':!**/changelogs/**' \
    ':!aiko/crates/codegen/xai-grok-shell/CHANGELOG.md' \
    ':!aiko/docs/AIKO-VS-GROK*' \
    ':!aiko/docs/GROK-*' \
    ':!aiko/docs/GROK-VS-AIKO*' \
    ':!**/*.json' || true
  fail "Grok Build still appears outside historical/vendor paths"
fi
ok "Grok Build gone from live product sources"

# User guide must not title the product Grok.
if rg -q 'Grok Build' aiko/crates/codegen/xai-grok-pager/docs/user-guide; then
  fail "user-guide still says Grok Build"
fi
ok "user-guide has no Grok Build"

need_grep() {
  rg -q -- "$2" "$1" || fail "$1 missing /$2/"
  ok "$1 has /$2/"
}
need_grep aiko/crates/codegen/xai-grok-pager-minimal/src/welcome.rs 'Aiko'
need_grep aiko/crates/codegen/xai-grok-pager-minimal/src/auth.rs 'Sign in to Aiko'
need_grep aiko/crates/codegen/xai-grok-mcp/src/oauth.rs 'Aiko'
need_grep docs/SOURCE-OF-TRUTH.md 'forward-deployed engineer'

echo
echo "aiko-identity-gate: PASS"
