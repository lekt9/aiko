#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MOD="$ROOT/contract/libcontract/src/delegation_capability.zig"
BUILD="$ROOT/contract/libcontract"

grep -q 'contract_delegation_issue_json' "$BUILD/src/c_abi.zig"
grep -q 'contract_delegation_adopt_json' "$BUILD/src/c_abi.zig"
grep -q 'contract_delegation_revoke_json' "$BUILD/src/c_abi.zig"
grep -q 'verifyCurrentExecution' "$BUILD/src/c_abi.zig"
(cd "$BUILD" && zig build test)

# Falsifier: removing tenant or current-fence refusal must make the module's
# adversarial tests red. Mutations happen only in an isolated copy.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cp "$MOD" "$tmp/delegation_capability.zig"
python3 - "$tmp/delegation_capability.zig" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); s=p.read_text()
old='if (!std.mem.eql(u8, request.tenant, grant.tenant)) return Error.WrongTenant;'
assert old in s
p.write_text(s.replace(old, 'if (false) return Error.WrongTenant;', 1))
PY
if (cd "$BUILD" && zig test "$tmp/delegation_capability.zig" -lc >/dev/null 2>&1); then
  echo 'falsifier failed: wrong-tenant adoption survived' >&2; exit 1
fi
cp "$MOD" "$tmp/delegation_capability.zig"
python3 - "$tmp/delegation_capability.zig" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1]); s=p.read_text()
old='request.current_lease_id, grant.issuing_lease_id) or request.current_fence != grant.issuing_fence) return Error.StaleFence;'
assert old in s
p.write_text(s.replace(old, 'request.current_lease_id, grant.issuing_lease_id)) return Error.StaleFence;', 1))
PY
if (cd "$BUILD" && zig test "$tmp/delegation_capability.zig" -lc >/dev/null 2>&1); then
  echo 'falsifier failed: stale-fence adoption survived' >&2; exit 1
fi

echo 'contract delegation substrate gate: ok'
