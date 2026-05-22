#!/usr/bin/env bash
# skill-self-test.sh — runs every structural invariant the /contract skill
# enforces on its own code. Substrate that REPLACES one-off iteration of
# 18+ skill-self contracts. Wired as pre-commit on ~/.contracts/.git so
# every ledger event auto-revalidates. Contracts 02471746 + 33c188dc.
set -uo pipefail
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/contract}"
SCRIPTS="$SKILL_DIR/scripts"
HOOK_DIR="${HOOK_DIR:-$HOME/.contracts/hooks}"
CLI="$SCRIPTS/contract"
fail=0

check() {
  local name="$1"; shift
  if "$@" >/tmp/_sst_out 2>&1; then
    printf "PASS  %s\n" "$name"
  else
    printf "FAIL  %s\n" "$name"
    sed 's/^/      | /' /tmp/_sst_out | head -5
    fail=$((fail + 1))
  fi
}

# ── Structural invariants (was 18 individual contracts) ──────────────────────
check "cli/bash-syntax"            bash -n "$CLI"
check "core/import"                env PYTHONPATH="$SCRIPTS/lib" python3 -c 'import contract_core'
check "core/folder-substrate"      env PYTHONPATH="$SCRIPTS/lib" python3 -c \
                                     'from contract_core import contract_dir, contracts_d_root; assert contracts_d_root()'
[ -f "$SCRIPTS/check-no-silent-fallback.py" ] && \
  check "guard/no-silent-fallback" python3 "$SCRIPTS/check-no-silent-fallback.py"
[ -f "$SCRIPTS/check-cwd-binding.sh" ] && \
  check "guard/cwd-binding"        bash "$SCRIPTS/check-cwd-binding.sh"
[ -f "$SCRIPTS/check-drive-no-autosatisfy.py" ] && \
  check "guard/drive-no-autosatisfy" python3 "$SCRIPTS/check-drive-no-autosatisfy.py"
[ -f "$SCRIPTS/check-crystallize.sh" ] && \
  check "guard/crystallize"        bash "$SCRIPTS/check-crystallize.sh" module
check "cli/inline-drive-block"     python3 -c \
                                     "import sys; sys.exit(0 if 'INLINE DRIVE' in open('$CLI').read() else 1)"
[ -f "$HOME/.claude/hooks/contract-drive.py" ] && \
  check "hook/folder-aware"        python3 -c \
                                     "import sys; sys.exit(0 if 'contracts_d_root' in open('$HOME/.claude/hooks/contract-drive.py').read() else 1)"
[ -x "$HOOK_DIR/drive-advance.sh" ] && \
  check "hook/drive-advance-exec"  test -x "$HOOK_DIR/drive-advance.sh"

# ── Setup verbs (was ~50 skill-existence + 13 default + activation rows) ─────
check "verb/init-dry"              env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" init --dry-run
check "verb/skills-sync"           bash "$CLI" skills sync --json
check "verb/install-hooks-dry"     env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" install-hooks --dry-run
check "verb/export-hooks-json"     env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" export-hooks --format json
check "verb/drive-watch-missing"   env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" drive-watch nonexistent-id-XXXX

if [ $fail -gt 0 ]; then
  printf "\nSKILL-SELF-TEST: %d FAIL(S)\n" "$fail" >&2
  exit 1
fi
echo
echo "SKILL-SELF-TEST: ALL PASS"
exit 0
