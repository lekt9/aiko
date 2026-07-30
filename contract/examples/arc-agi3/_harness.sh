#!/bin/bash
# Shared harness for the ARC-AGI-3 validators.
#
# Two invariants the earlier scripts got wrong, both load-bearing:
#
#   1. LEDGER ISOLATION IS BY CWD, NOT $HOME.
#      ledger.zig:resolvePath walks <cwd>/.claude/contracts.jsonl first, and
#      only falls back to $HOME/.contracts/ (not $HOME/.claude/). Exporting
#      HOME=$tmp while running from the repo root sends every row into the
#      repo's own 37MB ledger. arc_init cd's into the sandbox so the binary
#      and the test agree on which file they are talking about.
#
#   2. THE CONTRACT ID IS THE BARE 8-HEX LINE ON STDOUT.
#      Evidence ("result: PASS — ...") goes to stderr. `tail -c 8` over merged
#      output returns the tail of whatever prose printed last — e.g. "frontier
#      stuck" yields the id "ierstuck". arc_id reads stdout only.
#
# A validator that cannot find an id must FAIL. It must never invent one, and
# it must never assert on bytes it appended itself.

set -euo pipefail

ARC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARC_CONTRACT="$ARC_ROOT/scripts/contract"

# arc_init — create an isolated ledger sandbox and cd into it.
arc_init() {
  ARC_TMP=$(mktemp -d)
  mkdir -p "$ARC_TMP/.claude"
  ARC_LEDGER="$ARC_TMP/.claude/contracts.jsonl"
  ARC_EV="$ARC_TMP/evidence.txt"   # set here: arc_declare runs in a subshell
  : > "$ARC_LEDGER"
  : > "$ARC_EV"
  export HOME="$ARC_TMP"
  cd "$ARC_TMP"
  echo "ledger: $ARC_LEDGER"
}

arc_cleanup() { rm -rf "${ARC_TMP:-}"; }

# arc_id — read a contract id from stdout. Fails loudly rather than guessing.
arc_id() {
  local id
  id=$(grep -oE '^[0-9a-f]{8}$' | head -1) || true
  if [ -z "$id" ]; then
    echo "harness: no contract id on stdout" >&2
    return 1
  fi
  printf '%s' "$id"
}

# arc_declare <plan> [action] — declare, echo the id, evidence to $ARC_EV.
#
# Registration returns a bare id without entering the legacy resolver.
arc_declare() {
  local out
  out=$("$ARC_CONTRACT" declare "$@" --register 2>"$ARC_EV") || true
  printf '%s\n' "$out" | arc_id
}

# arc_satisfy <id> <bytes> — mark a contract terminal with a concrete result.
arc_satisfy() {
  printf '%s\n' "{\"event\":\"satisfied\",\"id\":\"$1\",\"wave\":1,\"action_exit\":0,\"action_result\":\"$2\",\"ts\":\"2026-07-14T00:00:00Z\"}" >> "$ARC_LEDGER"
}

# arc_result_of <id> — the action_result carried by that id's OWN rows, if any.
# This is the only honest assertion: it never sees rows belonging to another id.
arc_result_of() {
  python3 - "$ARC_LEDGER" "$1" <<'PY'
import sys, json
path, want = sys.argv[1], sys.argv[2]
for line in open(path):
    try: row = json.loads(line)
    except Exception: continue
    if row.get("id") != want: continue
    res = row.get("action_result")
    if res and res not in ("hold", "pass", "fail"):
        print(res)
        break
PY
}

# arc_is_satisfied <id> — did this id reach a satisfied terminal?
arc_is_satisfied() {
  python3 - "$ARC_LEDGER" "$1" <<'PY'
import sys, json
path, want = sys.argv[1], sys.argv[2]
ok = False
for line in open(path):
    try: row = json.loads(line)
    except Exception: continue
    if row.get("id") != want: continue
    if row.get("event") == "satisfied": ok = True
    if row.get("event") in ("died", "purged"): ok = False
sys.exit(0 if ok else 1)
PY
}
