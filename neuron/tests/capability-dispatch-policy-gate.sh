#!/usr/bin/env bash
# Runnable witness for the standalone Neuron admission/dispatch choke point.
# It runs the production-wired test step, proves the module has no Contract
# import, then removes one immediate pre-dispatch refusal and requires the
# embedded behavioral tests to catch the mutant.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
fail() { echo "FAIL: $*" >&2; exit 1; }

# Production integration: this step is neuron/build.zig, not a private fixture.
zig build test

policy=src/capability_dispatch_policy.zig
[ -f "$policy" ] || fail "production policy module is missing"
# Standalone is architectural evidence. Contract facts enter as typed verified
# projections; importing its interpreter would erase that evidence.
if grep -Eq '@import\([^)]*[Cc]ontract|contract/' "$policy"; then
    fail "Neuron dispatch policy imports Contract"
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/neuron-policy-mutant.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT
cp "$policy" "$tmp/mutant.zig"
python3 - "$tmp/mutant.zig" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
old = 'if (!authority.subject_verified or !authority.tenant_verified) return .verified_identity_required;'
new = 'if (false and (!authority.subject_verified or !authority.tenant_verified)) return .verified_identity_required;'
if s.count(old) != 1:
    raise SystemExit("FAIL: mutation target moved or is ambiguous")
p.write_text(s.replace(old, new))
PY

# Falsifier: without the repeated verified-identity check, a claim cached while
# authority was good becomes usable after verification disappears. The suite
# must fail; otherwise the gate can pass with the refusal removed.
if zig test "$tmp/mutant.zig" >"$tmp/mutant.log" 2>&1; then
    fail "mutation removing immediate verified-identity refusal survived"
fi
grep -q 'expected .verified_identity_required, found .ok' "$tmp/mutant.log" || \
    fail "mutant failed for an unrelated reason"

echo "capability-dispatch-policy gate: PASS (production-wired, standalone, mutation killed)"
