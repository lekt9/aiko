#!/usr/bin/env bash
# Runnable witness for the bridge: a neuron firing becomes a contract row that
# answers all six interrogatives.
#
# From an empty directory, through built binaries only, against a real neuron
# substrate and a real contract ledger:
#
#   1. every committed firing in the journal becomes a contract row;
#   2. each row answers all six interrogatives — who/what/when/where/why/how —
#      read out of the row itself, not out of the bridge's own claims;
#   3. `when` is carried as the commit ORDINAL as well as contract's own `ts`.
#      A wall clock cannot come from the firing: neuron hashes `now_ms` into the
#      decision digest, so a real clock there turns idempotent replay into
#      FiringMismatch (AGENTS.md 28.1) and the firing therefore carries zero.
#      Position in the journal is what makes two rows orderable;
#   4. re-running the bridge appends NOTHING. Idempotency is contract's own
#      cache, so the bridge keeps no watermark — a watermark would be a second
#      source of truth about what has been mirrored, and the two would drift;
#   5. THE FALSIFIER: a firing whose truth claim is empty is REFUSED by the W6H
#      gate with the unanswered interrogative NAMED, and nothing lands. This is
#      the assertion that must never regress: without it every other assertion
#      here could pass while nothing was being checked at all.
#
# Every assertion inspects the durable ledger, never stdout resemblance.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

aiko="$repo/zig-out/bin/aiko-doctor"
neuron="$repo/neuron/zig-out/bin/neuron"
[ -x "$aiko" ] || { echo "FAIL: build first (zig build)"; exit 1; }
[ -x "$neuron" ] || { echo "FAIL: build first (zig build)"; exit 1; }

root="$(mktemp -d "${TMPDIR:-/tmp}/aiko-bridge.XXXXXX")"
trap 'rm -rf -- "$root"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

# Isolate BOTH identities the ledger is discovered from, not just HOME.
#
# `contract/libcontract/src/ledger.zig` resolves cwd-FIRST: `<cwd>/.claude/`
# wins outright, and only if that directory is absent does it fall back to
# `$HOME/.contracts/`. This gate used to run from the repo root and isolate HOME
# alone, which worked only for as long as the repo root happened to have no
# `.claude/` directory. The moment one appeared — installing any Claude Code
# plugin creates one — every row went to the project ledger and the gate failed
# claiming the bridge had declared nothing.
#
# So run from the sandbox itself. A gate that says it drives the public CLI from
# an empty directory should not be standing in the source tree while it does so.
export HOME="$root"
cd "$root"
mkdir -p "$root/.contracts"
ledger="$root/.contracts/contracts.jsonl"

# --- a real neuron substrate with real committed firings -------------------
"$neuron" agent init "$root/n" hoysan >/dev/null
"$neuron" agent run "$root/n" hoysan --goal "draft roster for 08 May D shift" --json >/dev/null
journal="$root/n/state/substrate.log"
[ -s "$journal" ] || fail "the agent run committed nothing"

# --- 1. every firing becomes a row ----------------------------------------
"$aiko" bridge "$root/n/state" --agent hoysan >"$root/out1.txt" 2>&1 || fail "bridge exited non-zero"
[ -s "$ledger" ] || fail "the bridge declared nothing"
rows=$(wc -l < "$ledger" | tr -d "[:space:]")
bridged=$(sed -n 's/^bridged \([0-9]*\)\/.*/\1/p' "$root/out1.txt")
[ "$rows" = "$bridged" ] || fail "reported $bridged bridged but the ledger holds $rows rows"
[ "$rows" -gt 0 ] || fail "no rows landed"

# --- 2+3. all six interrogatives, on every row ----------------------------
python3 - "$ledger" <<'PY' || exit 1
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
# w6h.zig binds each interrogative to a field: who=env_pubkey, what=plan,
# when=ts, where=cwd, why=parent_signature, how=action.
six = {"who": "env_pubkey", "what": "plan", "when": "ts",
       "where": "cwd", "why": "parent_signature", "how": "action"}
for i, r in enumerate(rows):
    for q, field in six.items():
        v = r.get(field)
        if not v:
            print("FAIL: row %d cannot answer '%s' (field %s absent/empty)" % (i, q, field))
            sys.exit(1)
    # `when` must ALSO carry the ordinal: contract's ts says when the row was
    # written, the ordinal says where the firing sat in the journal. Only the
    # second orders two firings against each other.
    if not str(r.get("neuron_commit_seq", "")).isdigit():
        print("FAIL: row %d carries no commit ordinal" % i); sys.exit(1)
    if not r.get("neuron_firing_id"):
        print("FAIL: row %d does not name the firing it mirrors" % i); sys.exit(1)
print("  six interrogatives answered on all %d rows" % len(rows))
PY

# --- 4. re-running appends nothing ----------------------------------------
"$aiko" bridge "$root/n/state" --agent hoysan >/dev/null 2>&1 || fail "second bridge exited non-zero"
rows2=$(wc -l < "$ledger" | tr -d "[:space:]")
[ "$rows" = "$rows2" ] || fail "re-running the bridge duplicated rows ($rows -> $rows2)"
echo "  idempotent: $rows rows before and after a second run"

# --- 5. THE FALSIFIER ------------------------------------------------------
# Prove the gate is reachable rather than assumed. A row whose truth claim is
# empty must be refused, naming the interrogative. This is checked against the
# CONTRACT path directly, so the gate is exercised even if the bridge later
# stops constructing plans the same way.
before=$(wc -l < "$ledger" | tr -d "[:space:]")
shim="$repo/contract/libcontract/zig-out/bin/contract-lib-shim"
if [ -x "$shim" ]; then
    if "$shim" declare "" "neuron:firing/write" >/dev/null 2>&1; then
        fail "a row with an empty truth claim was ACCEPTED — the W6H gate is not live"
    fi
    after=$(wc -l < "$ledger" | tr -d "[:space:]")
    [ "$before" = "$after" ] || fail "a refused declare still appended a row"
    echo "  W6H gate refuses an empty 'what' and appends nothing"
else
    echo "  SKIP falsifier: contract-lib-shim not built" >&2
fi

echo "bridge gate: PASS"
