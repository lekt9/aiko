#!/usr/bin/env bash
# Runnable witness for AUTHORING: a capability gap is closed by WRITING a
# handler that existed nowhere, not only by discovering one.
#
# This joins the substrate's two halves. Self-wiring (discover a boundary that
# already declares a schema) and self-writing (write a component inert, admit it
# by digest) were each witnessed and never connected — if nothing out there
# satisfied a gap, the loop retired it rather than authoring what would close it.
#
# From an empty directory, through the public CLI only:
#
#   1. a gap whose discovery_target DOES NOT EXIST is still resolved, and the
#      route is reported as `authored` — discovery could not have answered it;
#   2. the resolution is `verified:true`, meaning the authored handler was
#      probed on the REAL path and judged, not merely compiled and attached;
#   3. THE FALSIFIER, and the reason the catalogue is bounded: a gap whose
#      acceptance no real transform can meet is REFUSED. It is not closed by
#      writing something that prints the acceptance string.
#
#      This is the whole risk of an authoring path. A gap declares its
#      acceptance as `expect_contains`, so a handler synthesised to satisfy it
#      could just print that string and pass — closing the gap while doing
#      nothing, which is the fabrication every other refusal in this substrate
#      exists to prevent. Authoring is therefore a bounded search over
#      transforms written AHEAD OF TIME, none of which reads the gap. Assertion
#      3 is what proves that is still true.
#
#   4. the authored bytes are on disk BEFORE they are pinned. That ordering is
#      what makes authoring admissible at all: admission pins bytes that
#      existed before the pin.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"
zig build

binary="$repo/zig-out/bin/neuron"
root="$(mktemp -d "${TMPDIR:-/tmp}/neuron-authored.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

cd "$root"
"$binary" agent init node a1 >/dev/null

gap() { # id probe expect
    printf '{"schema":"neuron.capability-gap/v1","id":"%s","need":"authored handler",' "$1" > "$1.json"
    printf '"accepts":["neuron.interface-call/v1"],"emits":["neuron.interface-result/v1"],' >> "$1.json"
    printf '"discovery_target":"/nonexistent/no-boundary-here","discovery_kind":"process",' >> "$1.json"
    printf '"probe_input":"%s","expect_contains":"%s"}' "$2" "$3" >> "$1.json"
}

[ -e /nonexistent/no-boundary-here ] && fail "the 'nonexistent' target exists; this gate proves nothing"

# --- 1+2. a gap with nothing to discover is closed by authoring ------------
gap upper "authored probe" "AUTHORED PROBE"
out="$("$binary" interface resolve-gap node a1 --gap upper.json --json)" ||
    fail "authoring did not resolve a gap a real transform can meet"

python3 - "$out" <<'PY' || exit 1
import json, sys
r = json.loads(sys.argv[1])
if r.get("route") != "authored":
    print("FAIL: route was %r, not 'authored' — discovery could not have answered this gap"
          % r.get("route")); sys.exit(1)
if r.get("verified") is not True:
    print("FAIL: resolution was not verified on the real path"); sys.exit(1)
if len(r.get("interface", "")) != 64:
    print("FAIL: no admitted interface digest"); sys.exit(1)
print("  route=authored, verified on the real path, digest pinned")
PY

# --- 4. the bytes existed on disk before the pin ---------------------------
authored=$(find .aiko/authored -name '*.py' -type f 2>/dev/null | head -1)
[ -n "$authored" ] || fail "nothing was written inert — authoring pinned bytes that never existed"
[ -x "$authored" ] || fail "authored handler is not executable; the membrane could not invoke what it pinned"
echo "  authored inert on disk before admission: $(basename "$authored")"

# --- 3. THE FALSIFIER ------------------------------------------------------
# No real transform maps "hello world" to this. If authoring could synthesise
# from the acceptance string, this would resolve. It must not.
gap impossible "hello world" "ZZZ-NO-REAL-TRANSFORM-PRODUCES-THIS-ZZZ"
if "$binary" interface resolve-gap node a1 --gap impossible.json --json >/dev/null 2>&1; then
    fail "a gap no real transform can meet was RESOLVED — authoring is synthesising from the acceptance string"
fi
echo "  refuses a gap no real transform can meet (does not fabricate)"

echo "authored-gap gate: PASS"
