#!/usr/bin/env bash
# Runnable witness for the Zig doctrine in CLAUDE.md.
#
# CLAUDE.md tells every future agent which Zig 0.16 APIs exist and which were
# removed — `std.process.argsAlloc` is gone, use `std.process.Args`; there is no
# `std.time.milliTimestamp`, use `std.Io.Timestamp`. That guidance is load
# bearing: both facts cost real time precisely because they were invisible from
# reading and only surfaced on `zig build`.
#
# And nothing checked any of it. A toolchain bump could delete or restore any of
# those declarations and the document would go on asserting the old world with
# total confidence, misleading every agent that read it. That is the same defect
# a package's SKILL.md has when it sits outside the digest: a claim with no way
# to be found false.
#
# So this gate does not restate the doctrine — restating it would only create a
# second copy that can disagree with the first. It PARSES the ```zig-doctrine
# block out of CLAUDE.md, generates a `@hasDecl` probe from whatever that block
# currently says, and compiles it against the installed toolchain.
#
#   claim says `absent`  -> @hasDecl must be false
#   claim says `present` -> @hasDecl must be true
#
# The falsifier is therefore the document itself: change any line to something
# untrue and this gate fails. That is the only arrangement in which the prose
# and the compiler cannot drift apart.
#
# Deliberately NOT bound here: an external Zig skill from the registry. The
# best-installed one targets 0.15.2 while this repo pins 0.16.0 in all three
# manifests, so importing it would mean adopting an unchecked claim — the exact
# thing this gate exists to refuse.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
doc="$repo/CLAUDE.md"
[ -f "$doc" ] || { echo "FAIL: CLAUDE.md not found at $doc"; exit 1; }

root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-zigdoc.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# --- 1. extract the doctrine block ----------------------------------------
python3 - "$doc" "$root/claims.txt" <<'PY' || exit 1
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"```zig-doctrine\n(.*?)```", src, re.S)
if not m:
    print("FAIL: CLAUDE.md has no ```zig-doctrine block — the doctrine this gate "
          "guards was deleted or renamed, so nothing is being checked")
    sys.exit(1)

claims = []
for line in m.group(1).splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    parts = line.split()
    if len(parts) != 2 or parts[1] not in ("absent", "present"):
        print("FAIL: malformed doctrine line %r (want '<decl.path> absent|present')" % line)
        sys.exit(1)
    claims.append((parts[0], parts[1]))

if not claims:
    print("FAIL: the doctrine block is empty — a gate over zero claims always passes")
    sys.exit(1)

with open(sys.argv[2], "w", encoding="utf-8") as f:
    for path, expect in claims:
        f.write("%s %s\n" % (path, expect))
print("  parsed %d claims from CLAUDE.md" % len(claims))
PY

# --- 2. generate a probe that asserts exactly those claims -----------------
{
    echo 'const std = @import("std");'
    echo 'pub fn main() void {'
    echo '    var bad: u32 = 0;'
    while read -r path expect; do
        [ -n "$path" ] || continue
        # Split "std.process.argsAlloc" -> container "std.process", decl "argsAlloc".
        container="${path%.*}"
        decl="${path##*.}"
        want=$([ "$expect" = "present" ] && echo "true" || echo "false")
        cat <<EOF
    if (@hasDecl($container, "$decl") != $want) {
        std.debug.print("  CLAIM FALSE: CLAUDE.md says $path is $expect, toolchain disagrees\n", .{});
        bad += 1;
    }
EOF
    done < "$root/claims.txt"
    echo '    if (bad != 0) std.process.exit(1);'
    echo '}'
} > "$root/probe.zig"

# --- 3. compile and run it against the installed toolchain -----------------
# A compile error is a failure too: it means a claim names a container that does
# not exist at all, which the document also should not be asserting.
if ! ( cd "$root" && zig run probe.zig ) > "$root/out.txt" 2>&1; then
    echo "--- probe output ---"
    tail -12 "$root/out.txt"
    fail "CLAUDE.md's Zig doctrine does not match $(zig version)"
fi

echo "  every doctrine claim holds against zig $(zig version)"
echo "zig-doctrine gate: PASS"
