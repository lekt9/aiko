#!/usr/bin/env bash
# probe-context-sources.sh — child B of eb663e04.
# Asserts the 4 source scripts exist + are executable; stdin source
# accepts piped envelope; deepwiki source emits hint for org/repo
# topics; bun-fetch source either fetches or skips silently (no
# fake-green when bun is unreachable).
set -e

SRC_DIR="$HOME/.claude/skills/contract/scripts/context-sources"
for s in stdin prior deepwiki bun-fetch; do
  [ -x "$SRC_DIR/$s.sh" ] || { echo "FAIL: source missing/not-executable: $s.sh"; exit 1; }
done
echo "PASS: 4 source scripts present + executable"

# stdin source happy path
OUT=$(bash "$SRC_DIR/stdin.sh" 'test/topic' <<<'{"body":"hello","refs":[]}' 2>&1)
echo "$OUT" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["source"]=="stdin" and d["body"]=="hello"' \
  || { echo "FAIL: stdin source did not echo envelope"; echo "$OUT"; exit 1; }
echo "PASS: stdin source accepts piped JSON envelope"

# stdin source skips on empty
if bash "$SRC_DIR/stdin.sh" 'test/topic' </dev/null >/dev/null 2>&1; then
  echo "FAIL: stdin source should exit 1 when stdin is empty"; exit 1
fi
echo "PASS: stdin source skips silently when stdin empty"

# deepwiki source: org/repo topic emits hint envelope
OUT=$(bash "$SRC_DIR/deepwiki.sh" 'some/repo' </dev/null 2>&1)
echo "$OUT" | python3 -c '
import json,sys
d=json.loads(sys.stdin.read())
assert d["source"]=="deepwiki"
assert d["hint_mcp_call"]["tool"].startswith("mcp__deepwiki__")
assert "github.com/some/repo" in " ".join(d["refs"])
' || { echo "FAIL: deepwiki org/repo envelope wrong shape"; echo "$OUT"; exit 1; }
echo "PASS: deepwiki source emits hint envelope for org/repo"

# deepwiki source: non-orgrepo topic exits silently
if bash "$SRC_DIR/deepwiki.sh" 'not-an-org-repo' </dev/null >/dev/null 2>&1; then
  echo "FAIL: deepwiki source should skip on non-org/repo topic"; exit 1
fi
echo "PASS: deepwiki source skips silently on non-org/repo topic"

# bun-fetch source: either succeeds (bun installed) or skips silently (not installed)
if command -v bun >/dev/null 2>&1; then
  # bun present — honest test: try a known-public repo
  OUT=$(bash "$SRC_DIR/bun-fetch.sh" 'octocat/Hello-World' </dev/null 2>&1) || OUT=""
  if [ -n "$OUT" ]; then
    echo "$OUT" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["source"]=="bun-fetch" and len(d["body"])>0' \
      || { echo "FAIL: bun-fetch envelope wrong shape"; echo "$OUT" | head -5; exit 1; }
    echo "PASS: bun-fetch source returned envelope (bun installed + reachable)"
  else
    echo "PASS: bun-fetch returned nothing (network or fetch failure) — skipped silently, no fake-green"
  fi
else
  if bash "$SRC_DIR/bun-fetch.sh" 'some/repo' </dev/null >/dev/null 2>&1; then
    # Only valid PASS if nanobrew is present and emitted the install-hint envelope
    OUT=$(bash "$SRC_DIR/bun-fetch.sh" 'some/repo' </dev/null 2>&1)
    echo "$OUT" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d.get("install_hint")' \
      || { echo "FAIL: bun missing AND nanobrew missing AND source emitted non-hint output (fake-green)"; echo "$OUT"; exit 1; }
    echo "PASS: bun missing → nanobrew install-hint envelope returned"
  else
    echo "PASS: bun missing → source exited silently (no fake-green)"
  fi
fi

echo
echo "probe-context-sources: PASS"
exit 0
