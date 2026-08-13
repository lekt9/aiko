#!/usr/bin/env bash
# Runnable witness for the MCP dispatch — the single surface Hermes mounts.
#
# From an empty directory, over real JSON-RPC on stdio, against a real neuron
# substrate and a real contract ledger:
#
#   1. the server identifies as `aiko`, not as the layer whose wire protocol it
#      borrows. A door announcing someone else's name while serving this
#      catalog is misidentifying itself;
#   2. every tool in the catalog is advertised — asserted as an exact set, so a
#      tool silently dropped from TOOLS fails here rather than going unnoticed;
#   3. a tool that spans BOTH layers works end to end: `aiko.bridge` mirrors
#      neuron firings into contract rows, and `aiko.ledger.read` reads them back
#      out. One call each, one surface, both substrates;
#   4. a refusal names the offending field. `isError` is true AND the text says
#      which argument was missing — an agent composing a call unattended cannot
#      act on "invalid arguments", which is the entire premise of a single API.
#
# Assertion 2 is the falsifier: without it the others could all pass while the
# catalog quietly shrank, and the one thing a mounted door must not do is stop
# offering something an agent still believes is there.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

aiko="$repo/zig-out/bin/aiko"
doctor="$repo/zig-out/bin/aiko-doctor"
[ -x "$aiko" ] && [ -x "$doctor" ] || { echo "FAIL: build first (zig build)"; exit 1; }

root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-dispatch.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

export HOME="$root"
export PATH="$repo/zig-out/bin:$PATH"
mkdir -p "$root/.contracts"

# A real substrate with real committed firings.
"$aiko" agent init "$root/n" a1 >/dev/null
"$aiko" agent run "$root/n" a1 --goal "dispatch gate probe" --json >/dev/null

{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"aiko.bridge","arguments":{"state_dir":"%s/n/state","agent":"a1"}}}\n' "$root"
  echo '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"aiko.ledger.read","arguments":{}}}'
  echo '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"aiko.port.publish","arguments":{"node":"x"}}}'
  echo '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"aiko.claim.register","arguments":{"statement":"w1 attends shift 306","refuted_by":"no reply by shift start","expect_by":"2"}}}'
  echo '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"aiko.claim.register","arguments":{"statement":"something will happen"}}}'
} | timeout 120 "$doctor" mcp > "$root/out.jsonl" 2>"$root/err.txt" || true

# 5. A MISSING BINARY NAMES THE FIX, NOT THE SYMPTOM.
# Both sibling binaries are resolved by bare name through the ambient PATH, so a
# host that mounts this server without zig-out/bin on PATH gets a runtime
# failure on a tool it invoked correctly. "FileNotFound" tells that caller
# nothing, and zero setup is the product's stated requirement — the one setup
# step it does have must announce itself. Launch the server with a PATH that
# deliberately excludes the binaries and read the refusal.
{
  echo '{"jsonrpc":"2.0","id":8,"method":"initialize","params":{}}'
  printf '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"aiko.bridge","arguments":{"state_dir":"%s/n/state","agent":"a1"}}}\n' "$root"
} | env PATH=/usr/bin:/bin "$(command -v timeout)" 60 "$doctor" mcp > "$root/nopath.jsonl" 2>/dev/null || true
python3 - "$root/nopath.jsonl" <<'PY2' || exit 1
import json, sys
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    if r.get("id") != 9:
        continue
    c = (r.get("result") or {}).get("content") or [{}]
    t = c[0].get("text", "")
    if "PATH" not in t:
        print("FAIL: a missing binary refused without naming PATH — the caller "
              "cannot act on it: %r" % t[:160])
        sys.exit(1)
    print("  a missing binary refuses by naming PATH, not FileNotFound")
    sys.exit(0)
print("FAIL: no response to the no-PATH probe")
sys.exit(1)
PY2

[ -s "$root/out.jsonl" ] || fail "the mcp server produced no output: $(head -2 "$root/err.txt")"

python3 - "$root/out.jsonl" <<'PY' || exit 1
import json, sys
rows = {}
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except Exception:
        continue
    rows[r.get("id")] = r

def result(i):
    r = rows.get(i) or {}
    return r.get("result", {})

def text(i):
    c = result(i).get("content") or [{}]
    return c[0].get("text", "")

# 1. identity
info = result(1).get("serverInfo", {})
if info.get("name") != "aiko":
    print("FAIL: server identifies as %r, not 'aiko'" % info.get("name")); sys.exit(1)
print("  identifies as aiko")

# 2. THE FALSIFIER — the catalog is an exact set, not a minimum.
expected = {
    "aiko.ledger.read", "aiko.port.publish", "aiko.port.attach",
    "aiko.gap.resolve", "aiko.redrive", "aiko.bridge",
    # The two verbs VISION.md names as the whole simplification. Asserted as
    # part of the EXACT set, so a caller that believes they are there cannot be
    # silently wrong.
    "aiko.claim.register", "aiko.claim.observe",
}
got = {t["name"] for t in result(2).get("tools", [])}
if got != expected:
    print("FAIL: catalog drifted.\n  missing: %s\n  unexpected: %s"
          % (sorted(expected - got), sorted(got - expected))); sys.exit(1)
print("  catalog advertises exactly %d tools" % len(got))

# 3. one call spanning BOTH layers
if result(3).get("isError"):
    print("FAIL: aiko.bridge errored: %s" % text(3)[:200]); sys.exit(1)
if "contract=" not in text(3):
    print("FAIL: aiko.bridge declared no contract row: %s" % text(3)[:200]); sys.exit(1)
if result(4).get("isError"):
    print("FAIL: aiko.ledger.read errored: %s" % text(4)[:200]); sys.exit(1)
if "neuron firing" not in text(4):
    print("FAIL: the ledger does not carry the mirrored firing"); sys.exit(1)
print("  bridge -> ledger round trip across both layers")

# 4. a refusal names the field
if not result(5).get("isError"):
    print("FAIL: a call missing a required argument was ACCEPTED"); sys.exit(1)
if "document" not in text(5):
    print("FAIL: refusal did not name the missing field: %r" % text(5)[:120]); sys.exit(1)
print("  refusal names the offending field")

# 6+7. A CLAIM IS DURABLE, AND AN UNFALSIFIABLE ONE IS REFUSED.
# The claim verbs go through the same W6H-gated `contract.declare` the bridge
# uses, so a registered claim is a durable row rather than a second store that
# can disagree with the ledger.
if result(6).get("isError"):
    print("FAIL: aiko.claim.register errored: %s" % text(6)[:160]); sys.exit(1)
if "claim=" not in text(6):
    print("FAIL: register returned no claim id: %r" % text(6)[:120]); sys.exit(1)
print("  a claim registers as a durable row")

# The same refusal a gap gets and a package gets: no refutation condition means
# nothing about the claim could turn out to be false.
if not result(7).get("isError"):
    print("FAIL: a claim declaring NO refutation condition was ACCEPTED"); sys.exit(1)
if "refuted_by" not in text(7):
    print("FAIL: the refusal did not name refuted_by: %r" % text(7)[:120]); sys.exit(1)
print("  a claim with no refutation condition is refused, naming the field")
PY

echo "dispatch gate: PASS"
