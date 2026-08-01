#!/usr/bin/env bash
# Runnable witness for the minimal tree: neuron, contract, and the aiko-doctor
# glue — nothing else.
#
# WHAT "ONLY NEURON AND CONTRACT" CANNOT MEAN.
#
# `src/` is three files, and it is `aiko-doctor`: the MCP surface Hermes mounts,
# the bridge that turns a firing into a W6H-gated ledger row, and the tick loop.
# Deleting it would delete `aiko.claim.register`, `aiko.claim.observe` and every
# other verb — the door itself. It stays. `tests/` is the root gate suite and
# stays for the same reason: the acceptance criterion is not optional baggage.
#
# What goes is the 6.2 GB Rust host under `aiko/` and the two `unbrowse` trees.
# None is in the Zig build, and the build.zig header already says the host is
# deliberately excluded because its test build exhausts this machine — an
# unverifiable build step is worse than an absent one.
#
# Four assertions:
#
#   1. THE HEAVY SUBTREES ARE GONE. Not gitignored, not emptied — absent.
#
#   2. WHAT REMAINS STILL BUILDS. A tree that is small and broken is not an
#      improvement on a tree that is large and works.
#
#   3. THE WIRE BINDINGS STILL VERIFY. `generate_wire_bindings.py` used to write
#      a Rust binding into the host unconditionally, so removing the host would
#      have made `--check` fail forever on a tree that deliberately does not
#      contain it. The Rust output is now conditional on the host directory
#      existing. Note the generator hashes ITSELF into the package digest
#      (tools/generate_wire_bindings.py is in package_digest's file list), so
#      changing it correctly invalidates every binding it produces — that is the
#      pin working, not a bug.
#
#   4. THE MCP STILL ANSWERS. The point of keeping `src/` is the door; assert it
#      opens and still advertises the claim verbs, so a "cleanup" that quietly
#      removed the surface would be caught here.
#
# Assertion 2 is the falsifier that matters: delete one directory too many and
# the build goes red rather than the tree merely looking tidy.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- 1. the heavy subtrees are absent -------------------------------------
for gone in aiko unbrowse unbrowse-dev; do
    [ -e "$repo/$gone" ] && fail "$gone/ still exists — the tree was not reduced"
    git ls-files "$gone" | head -1 | grep -q . && fail "$gone/ is still tracked in git"
done
echo "  aiko/, unbrowse/, unbrowse-dev/ are absent and untracked"

# --- 2. what remains still builds -----------------------------------------
for kept in neuron contract src tests build.zig build.zig.zon; do
    [ -e "$repo/$kept" ] || fail "$kept is MISSING — the reduction went too far"
done
zig build >/dev/null 2>&1 || fail "the reduced tree does not build"
[ -x "$repo/zig-out/bin/aiko" ] || fail "zig-out/bin/aiko was not produced"
[ -x "$repo/zig-out/bin/aiko-doctor" ] || fail "zig-out/bin/aiko-doctor was not produced"
echo "  neuron + contract + aiko-doctor still build"

# --- 3. the wire bindings still verify without the host -------------------
( cd "$repo/neuron" && python3 tools/generate_wire_bindings.py --check ) >/dev/null 2>&1 \
    || fail "generate_wire_bindings --check fails with the Rust host removed — the Rust output is not conditional on the host existing"
echo "  wire bindings verify with the Rust host absent"

# --- 4. the MCP door still opens and still carries the claim verbs ---------
probe="$(mktemp -d "${TMPDIR:-/tmp}/aiko-min.XXXXXX")"
trap 'rm -rf -- "$probe"' EXIT
mkdir -p "$probe/.contracts"
{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
} | ( cd "$probe" && HOME="$probe" PATH="$repo/zig-out/bin:$PATH" \
      timeout 120 "$repo/zig-out/bin/aiko-doctor" mcp ) >"$probe/out.jsonl" 2>/dev/null || true

python3 - "$probe/out.jsonl" <<'PY' || exit 1
import json, sys
want = {"aiko.claim.register", "aiko.claim.observe", "aiko.ledger.read",
        "aiko.port.publish", "aiko.port.attach", "aiko.gap.resolve",
        "aiko.redrive", "aiko.bridge"}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get("id") != 2:
        continue
    got = {t["name"] for t in (r.get("result") or {}).get("tools", [])}
    if got != want:
        print("FAIL: the MCP surface changed.\n  missing: %s\n  unexpected: %s"
              % (sorted(want - got), sorted(got - want)))
        sys.exit(1)
    print("  the MCP door opens and still advertises all %d verbs" % len(got))
    sys.exit(0)
print("FAIL: the mcp server returned no tools/list response")
sys.exit(1)
PY

echo "minimal-tree gate: PASS"
