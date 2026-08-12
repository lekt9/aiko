#!/usr/bin/env bash
# First-party docs name Aiko and this monorepo; historical files are stamped.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }

need_grep() {
  rg -q -- "$2" "$1" || fail "$1 missing /$2/"
  ok "$1 has /$2/"
}
forbid_grep() {
  if rg -q -- "$2" "$1"; then
    fail "$1 still contains /$2/"
  fi
  ok "$1 free of /$2/"
}

need_grep aiko/crates/codegen/xai-grok-pager/README.md 'Aiko'
need_grep aiko/crates/codegen/xai-grok-shell/README.md 'Aiko'
need_grep aiko/crates/codegen/xai-grok-pager/docs/user-guide/README.md 'Aiko'
need_grep aiko/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md 'scripts/contract-runtime.sh install'
need_grep aiko/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md 'aiko --version'
need_grep aiko/AGENTS.md 'SOURCE-OF-TRUTH'
need_grep neuron/CLAUDE.md 'SOURCE-OF-TRUTH'
need_grep contract/CLAUDE.md 'SOURCE-OF-TRUTH'
need_grep cell/AGENTS.md 'SOURCE-OF-TRUTH'
need_grep aiko/docs/README.md 'Historical reports'

forbid_grep aiko/crates/codegen/xai-grok-shell/README.md 'x.ai/cli/install'
forbid_grep aiko/crates/codegen/xai-grok-pager/docs/user-guide/01-getting-started.md 'curl -fsSL https://x.ai/cli/install'
forbid_grep aiko/crates/codegen/xai-grok-pager/docs/user-guide/README.md 'Grok Build User Guide'
forbid_grep aiko/AGENTS.md 'Sibling repos'

need_grep aiko/docs/AIKO-VS-GROK-HARBOR.md 'Historical'
need_grep neuron/reference/ROADMAP_WAVE1.md 'Historical'
need_grep docs/graph-engineering/REVIEW.md 'Historical'
need_grep aiko/crates/codegen/xai-grok-pager/docs/user-guide/03-keyboard-shortcuts.md 'Aiko TUI docs'

echo
echo "docs-quality-gate: PASS"
