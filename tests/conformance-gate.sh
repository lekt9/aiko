#!/usr/bin/env bash
# Runnable witness for CONFORMANCE.md — the report of the Aiko architecture
# document against the running system.
#
# WHAT THIS GATE IS FOR, and what it deliberately is NOT.
#
# It does NOT assert that the system implements the document. Parts of that
# document are absent by design and parts are deliberately rejected — a float
# `confidence` that cannot sit inside a deterministic identity, a stored
# `cache_status` that would be a second source of truth, a SemVer that can drift
# from its content. A gate demanding all of it could never go green, and arming
# a loop on an unreachable condition is the non-termination this repository
# refuses everywhere else.
#
# What it asserts is narrower and actually checkable: EVERY VERDICT IN THE
# REPORT IS STILL REPRODUCIBLE. Each row names a command and the exit code that
# command must produce. The gate runs them. A report that drifts from the
# system — because the system changed, or because a verdict was written without
# running anything — goes red here.
#
# That makes the report falsifiable rather than decorative, which is the same
# move `SKILL.md` makes for a package and `zig-doctrine` makes for prose about
# the language: the document is the source of truth and something mechanical is
# the judge.
#
# Three vacuity guards, all learned the hard way in this repository:
#   - the block is missing        -> a gate whose subject vanished reports green
#                                    while checking nothing
#   - the block is empty          -> a gate over zero claims always passes
#   - a row cites no command      -> a verdict with no evidence is exactly the
#                                    defect the report exists to prevent
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
doc="$repo/CONFORMANCE.md"
[ -f "$doc" ] || { echo "FAIL: CONFORMANCE.md not found at $doc"; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/aiko-conf.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT

# --- 1. extract the machine-readable block --------------------------------
python3 - "$doc" "$tmp/rows.tsv" <<'PY' || exit 1
import re, sys
src = open(sys.argv[1], encoding="utf-8").read()
m = re.search(r"```conformance\n(.*?)```", src, re.S)
if not m:
    print("FAIL: CONFORMANCE.md has no ```conformance block — the verdicts this "
          "gate exists to re-verify were deleted or renamed, so nothing is checked")
    sys.exit(1)

rows = []
for i, line in enumerate(m.group(1).splitlines(), 1):
    line = line.rstrip()
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    parts = line.split("\t")
    parts = [p for p in parts if p != ""]
    if len(parts) < 5:
        print("FAIL: row %d has %d tab-separated fields, want 5 "
              "(verdict, section, expect_exit, claim, command): %r" % (i, len(parts), line[:120]))
        sys.exit(1)
    verdict, section, expect_exit, claim, command = parts[0], parts[1], parts[2], parts[3], "\t".join(parts[4:])
    if verdict not in ("PRESENT", "PARTIAL", "ABSENT", "REJECTED"):
        print("FAIL: row %d has unknown verdict %r" % (i, verdict)); sys.exit(1)
    if expect_exit not in ("0", "nonzero"):
        print("FAIL: row %d expect_exit must be 0 or nonzero, got %r" % (i, expect_exit)); sys.exit(1)
    if not command.strip():
        # A verdict with no command is precisely the defect this report exists
        # to prevent: a claim nobody can re-run.
        print("FAIL: row %d (%s) cites no command" % (i, claim[:60])); sys.exit(1)
    rows.append((verdict, section, expect_exit, claim, command))

if not rows:
    print("FAIL: the conformance block is empty — a gate over zero claims always passes")
    sys.exit(1)

with open(sys.argv[2], "w", encoding="utf-8") as f:
    for r in rows:
        f.write("\t".join(r) + "\n")
print("  parsed %d verdicts from CONFORMANCE.md" % len(rows))
PY

# --- 2. re-run every cited command ----------------------------------------
# Each command runs from the repo root with the binaries on PATH, in a scrubbed
# HOME, because the ledger is discovered cwd-first and a probe must not write
# into the working tree.
fails=0
checked=0
while IFS=$'\t' read -r verdict section expect_exit claim command; do
    [ -n "${verdict:-}" ] || continue
    checked=$((checked + 1))
    sandbox="$tmp/run.$checked"
    mkdir -p "$sandbox/.contracts"
    set +e
    ( cd "$repo" && HOME="$sandbox" PATH="$repo/zig-out/bin:$PATH" \
        timeout 600 bash -c "$command" ) >"$tmp/out.$checked" 2>&1
    rc=$?
    set -e
    if [ "$expect_exit" = "0" ]; then
        ok=$([ "$rc" -eq 0 ] && echo yes || echo no)
    else
        ok=$([ "$rc" -ne 0 ] && echo yes || echo no)
    fi
    if [ "$ok" != "yes" ]; then
        fails=$((fails + 1))
        echo "FAIL: [$section] $claim" >&2
        echo "      verdict $verdict expects exit $expect_exit, command exited $rc" >&2
        echo "      \$ $command" >&2
        sed -n '1,4p' "$tmp/out.$checked" | sed 's/^/      | /' >&2
    fi
done < "$tmp/rows.tsv"

if [ "$fails" -ne 0 ]; then
    echo "FAIL: $fails of $checked verdicts no longer reproduce. CONFORMANCE.md has drifted from the system." >&2
    exit 1
fi

echo "  all $checked verdicts reproduce against the running system"
echo "conformance gate: PASS"
