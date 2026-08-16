#!/usr/bin/env bash
set -euo pipefail
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
BUILD="$ROOT/contract/libcontract"
MOD="$BUILD/src/execution_recovery.zig"

# Published Zig surface and full libcontract inventory, not a source-only toy.
grep -Fq 'pub const execution_recovery = @import("execution_recovery.zig");' "$BUILD/src/contract.zig"
grep -Fq '"src/execution_recovery.zig"' "$BUILD/build.zig"
grep -Fq 'execution_recovery_failure_classified' "$MOD"
grep -Fq 'execution_recovery_attempt_claimed' "$MOD"
git -C "$ROOT" diff --check -- contract/libcontract/src/execution_recovery.zig contract/libcontract/src/contract.zig contract/libcontract/build.zig tests/contract-execution-recovery-kernel-gate.sh
(cd "$BUILD" && zig build test)

# Destructive falsifiers run against an isolated module and its storage imports.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp "$BUILD/src/ledger.zig" "$BUILD/src/cross_journal_retention.zig" "$tmp/"
mutate_and_require_red() {
  local name="$1" old="$2" new="$3"
  cp "$MOD" "$tmp/execution_recovery.zig"
  python3 - "$tmp/execution_recovery.zig" "$old" "$new" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); old=sys.argv[2]; new=sys.argv[3]
assert old in s, f"mutation target missing: {old}"
p.write_text(s.replace(old, new, 1))
PY
  if (cd "$BUILD" && zig test "$tmp/execution_recovery.zig" -lc >/dev/null 2>&1); then
    echo "falsifier survived: $name" >&2; exit 1
  fi
}
mutate_and_require_red 'uncertain crossed effect retried' \
  'if (state.effect_prepared or state.failure == .uncertain_crossed)' \
  'if (false)'
mutate_and_require_red 'attempt budget exceeded' \
  'if (state.exhausted or state.attempt >= limits.max_attempts)' \
  'if (false)'
mutate_and_require_red 'permanent failure retried' \
  'if (state.permanent) return .{ .action = .refuse_permanent };' \
  'if (false) return .{ .action = .refuse_permanent };'
mutate_and_require_red 'stale fence accepted' \
  'if (current.fence != token.fence or state.fence != token.fence) return Error.StaleFence;' \
  'if (false) return Error.StaleFence;'
mutate_and_require_red 'commit order bypassed' \
  'if (at.commit_ordinal != state.last_commit_ordinal + 1) return Error.CommitOrder;' \
  'if (false) return Error.CommitOrder;'

printf 'contract-execution-recovery-kernel gate: ok\n'
