#!/usr/bin/env bash
# probe-context-of-verb.sh — child A of eb663e04.
# Asserts: verb wired in CLI dispatch; orchestrator script exists +
# executable; cache-hit short-circuits subsequent calls.
set -e

CLI="$HOME/.claude/skills/contract/scripts/contract"
ORCH="$HOME/.claude/skills/contract/scripts/contract-context-of.py"
[ -x "$ORCH" ] || { echo "FAIL: orchestrator missing or not executable: $ORCH"; exit 1; }
grep -q '^  context-of)' "$CLI" || { echo "FAIL: context-of verb not wired in CLI case block"; exit 1; }
echo "PASS: verb wired + orchestrator present"

TMPHOME=$(mktemp -d)
trap 'rm -rf "$TMPHOME"' EXIT
HOME="$TMPHOME"; export HOME

# Fresh cache → stdin path → cached.
OUT1=$("$CLI" context-of 'probe/topic-aaa' --from-stdin --refresh <<<'{"body":"probe body","refs":["x"]}' 2>&1)
echo "$OUT1" | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
src = d["source"]
assert src == "stdin", "expected stdin, got " + str(src)
assert d["body"]=="probe body"
assert d["_cache_hit"] is False, "first call should not be a cache hit"
' || { echo "FAIL: stdin path broken"; echo "$OUT1"; exit 1; }
echo "PASS: stdin source caches envelope"

# Second call with no stdin → cache hit
OUT2=$("$CLI" context-of 'probe/topic-aaa' </dev/null 2>&1)
echo "$OUT2" | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
assert d["_cache_hit"] is True, "second call should be cache hit"
assert d["source"]=="stdin", "cached source must match"
' || { echo "FAIL: cache-hit short-circuit broken"; echo "$OUT2"; exit 1; }
echo "PASS: cache-hit short-circuits second call"

# --cache-only on unknown topic → exit 1, no fetch
if "$CLI" context-of 'never-cached-topic-xyz' --cache-only </dev/null >/dev/null 2>&1; then
  echo "FAIL: --cache-only on uncached topic should exit non-zero"; exit 1
fi
echo "PASS: --cache-only refuses to fetch"

echo
echo "probe-context-of-verb: PASS"
exit 0
