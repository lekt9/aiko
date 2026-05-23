#!/usr/bin/env bash
# verb-gates/context-of/verify.sh — binds `contract context-of <topic>`.
#
# Phases:
#   1. Missing topic arg → exit 2
#   2. Unknown --source → exit 2
#   3. Cache miss + no source available → CONTEXT NEEDED block, exit 1
#   4. --from-stdin succeeds + caches; second call is cache hit
#   5. prior source: declare a contract with bind_to context:<topic>,
#      then context-of with --source prior finds it
set -e

TMPDIR_=$(mktemp -d)
trap 'rm -rf "$TMPDIR_"' EXIT
HOME="$TMPDIR_"; export HOME
mkdir -p "$HOME/.contracts"
export CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"
# We need the real CLI on PATH; HOME-rooted .claude doesn't exist
CLI=/Users/lekt9/.claude/skills/contract/scripts/contract

# Phase 1
if "$CLI" context-of 2>/dev/null; then
  echo "FAIL(1): missing topic should exit non-zero"; exit 1
fi
echo "PASS(1): missing topic refused"

# Phase 2
if "$CLI" context-of 'foo' --source phantom-source </dev/null >/dev/null 2>&1; then
  echo "FAIL(2): unknown --source should exit 2"; exit 1
fi
echo "PASS(2): unknown --source refused"

# Phase 3 — non-orgrepo topic, no stdin → CONTEXT NEEDED
OUT=$("$CLI" context-of 'plain-bare-topic-zzz' </dev/null 2>&1) || rc=$?
echo "$OUT" | grep -q 'CONTEXT NEEDED' || { echo "FAIL(3): no CONTEXT NEEDED block on no-source case"; echo "$OUT"; exit 1; }
echo "PASS(3): CONTEXT NEEDED block emitted on no-source case"

# Phase 4 — stdin source caches, second call is cache hit
OUT=$("$CLI" context-of 'gate/topic-bbb' --from-stdin --refresh <<<'{"body":"gated","refs":[]}' 2>&1)
echo "$OUT" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["source"]=="stdin" and d["_cache_hit"] is False' \
  || { echo "FAIL(4a): first stdin call not cached"; echo "$OUT"; exit 1; }
OUT2=$("$CLI" context-of 'gate/topic-bbb' </dev/null 2>&1)
echo "$OUT2" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["_cache_hit"] is True' \
  || { echo "FAIL(4b): second call should be cache hit"; echo "$OUT2"; exit 1; }
echo "PASS(4): stdin source caches; second call is cache hit"

# Phase 5 — prior source finds a contract by bind_to=context:<topic>
DECL=$("$CLI" declare "context bind for prior-source-test" --action "true" --bind-to "context:prior/topic-ccc" --no-drive 2>&1)
PRIOR_CID=$(printf '%s' "$DECL" | grep -oE '^declared: [0-9a-f]+' | head -1 | awk '{print $2}')
[ -n "$PRIOR_CID" ] || { echo "FAIL(5a): could not declare prior contract"; echo "$DECL"; exit 1; }
OUT=$("$CLI" context-of 'prior/topic-ccc' --source prior --refresh </dev/null 2>&1)
echo "$OUT" | python3 -c '
import json,sys,os
d=json.loads(sys.stdin.read())
assert d["source"]=="prior", f"expected prior, got {d[\"source\"]}"
assert d.get("prior_contract_id")=="'"$PRIOR_CID"'", f"wrong prior_contract_id: {d.get(\"prior_contract_id\")}"
' || { echo "FAIL(5b): prior source did not find bound contract"; echo "$OUT"; exit 1; }
echo "PASS(5): prior source resolves bind_to context:<topic>"

echo
echo "verb-gates/context-of: PASS"
exit 0
