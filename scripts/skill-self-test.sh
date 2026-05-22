#!/usr/bin/env bash
# skill-self-test.sh — runs every structural invariant the /contract skill
# enforces on its own code. This is the substrate that REPLACES one-off
# iteration of 18 skill-self contracts (silent-fallback check, cwd binding,
# drive-no-autosatisfy, crystallize, INLINE DRIVE presence, etc.). Wired as
# pre-commit on ~/.contracts/.git so every ledger event auto-revalidates.
#
# Exit non-zero if ANY invariant fails. The shipping verdict is in-thread
# (substrate enables; agent judges) — this script only collects evidence.
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
    printf "FAIL  %s (cmd: %s)\n" "$name" "$*"
    sed 's/^/      | /' /tmp/_sst_out | head -5
    fail=$((fail + 1))
  fi
}

# 1. Bash syntax of the CLI itself
check "cli/bash-syntax" bash -n "$CLI"

# 2. Python imports of contract_core
check "core/import" env PYTHONPATH="$SCRIPTS/lib" python3 -c 'import contract_core'

# 3. contract_dir / contracts_d_root present (folder substrate, contract a2290c19)
check "core/folder-substrate" env PYTHONPATH="$SCRIPTS/lib" python3 -c \
  'from contract_core import contract_dir, contracts_d_root; assert contracts_d_root()'

# 4. No silent fallbacks in any skill script
[ -f "$SCRIPTS/check-no-silent-fallback.py" ] && \
  check "guard/no-silent-fallback" python3 "$SCRIPTS/check-no-silent-fallback.py"

[ -f "$SCRIPTS/check-crystallize.sh" ] && \
  check "guard/crystallize" bash "$SCRIPTS/check-crystallize.sh" module

# 6. Drive never auto-marks a contract satisfied
check "cli/inline-drive-block" python3 -c "import sys; sys.exit(0 if 'INLINE DRIVE' in open('$CLI').read() else 1)"
  check "guard/drive-no-autosatisfy" python3 "$SCRIPTS/check-drive-no-autosatisfy.py"

# 7. Crystallize machinery is wired
[ -f "$SCRIPTS/check-crystallize.sh" ] && \
  check "guard/crystallize" bash "$SCRIPTS/check-crystallize.sh"

# 8. INLINE DRIVE block is present in the CLI (was contract e76293a6)
check "cli/inline-drive-block" zigrep -q 'INLINE DRIVE' "$CLI"

# 9. Stop hook is folder-aware (was contract a2290c19 / replaces eb845091 band-aid)
[ -f "$HOME/.claude/hooks/contract-drive.py" ] && \
  check "hook/folder-aware" zigrep -q 'contracts_d_root' "$HOME/.claude/hooks/contract-drive.py"

# 10. Internal drive-advance hook exists and is executable
[ -x "$HOOK_DIR/drive-advance.sh" ] && \
  check "hook/drive-advance-exec" test -x "$HOOK_DIR/drive-advance.sh"

if [ $fail -gt 0 ]; then
  printf "\nSKILL-SELF-TEST: %d FAIL(S) — block commit / abort\n" "$fail" >&2
  exit 1
fi
echo
echo "SKILL-SELF-TEST: ALL PASS"
exit 0
