#!/usr/bin/env bash
# check-cwd-binding — proves `contract iterate` runs a cli/loop action from
# its DECLARE-time cwd, so a relative-path action survives being iterated
# from a different directory.
#
# Without the cwd binding, an action like `node scripts/x.mjs` declared in
# project A but iterated from project B fails (exit 127 / file-not-found) —
# the footgun this guards against. Non-tautological by construction: this
# check FAILS before the fix and PASSES after.
#
# Isolated: uses a throwaway CONTRACTS_STORE, never touches the real ledger.
set -uo pipefail
SELF_DIR=$(cd "$(dirname "$0")" && pwd)
CLI="$SELF_DIR/contract"
TMP=$(mktemp -d)
A="$TMP/declared-here"
B="$TMP/iterated-here"
mkdir -p "$A" "$B"
echo "marker-ok" > "$A/marker.txt"
export CONTRACTS_STORE="$TMP/ledger.jsonl"

# Declare FROM dir A. The action is a RELATIVE-path read that only succeeds
# when run with cwd == A.
cid=$(cd "$A" && bash "$CLI" declare "cwd-binding self-test" \
        --action "cat marker.txt" 2>&1 \
      | grep -oE 'declared: [a-f0-9]+' | awk '{print $2}')
if [ -z "$cid" ]; then
  echo "check-cwd-binding: FAIL — declare produced no contract id"
  rm -rf "$TMP"; exit 1
fi

# Iterate FROM dir B. With the cwd binding the action still runs in A and
# `cat marker.txt` succeeds; without it the action runs in B and fails.
res=$(cd "$B" && bash "$CLI" iterate "$cid" 2>&1 | grep -oE 'result: (PASS|FAIL)' | head -1)
rm -rf "$TMP"

case "$res" in
  *PASS*)
    echo "check-cwd-binding: PASS — a relative-path action declared in dir A"
    echo "  ran correctly when iterated from dir B (bound to declare-time cwd)."
    exit 0 ;;
  *)
    echo "check-cwd-binding: FAIL — the action did not run from its"
    echo "  declare-time cwd (got: ${res:-no result}). Relative-path actions"
    echo "  break when iterated from another directory."
    exit 1 ;;
esac
