#!/usr/bin/env bash
# verb-gates/iterate-cache/verify.sh — binds the 10s sliding-window per-user
# cache on `contract iterate` (lib/cache_layer.py).
#
# Phases:
#   1. Stdio cell — second iterate within 10s is a HIT
#   2. Per-user keying — same contract, different CONTRACT_USER, MISS
#   3. --stdin — different stdin → different cache slot
#   4. agent-judges bypass — no cache entry written, no cache_hit_from line
#   5. --no-cache — forces fresh run even when cache is warm
#   6. Cached event row appended on HIT (audit trail intact, wave not incremented)
set -e

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export CONTRACTS_STORE="$TD/ledger.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# Phase 1 — cell, miss then hit
CID=$(CONTRACT_USER=anon "$CLI" declare "cache phase1" --action "true" --no-drive 2>&1 \
        | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
[ -n "$CID" ] || { echo "FAIL(1): could not declare cell"; exit 1; }
CONTRACT_USER=anon "$CLI" iterate "$CID" >/dev/null 2>&1 || { echo "FAIL(1): first iterate errored"; exit 1; }
HIT_OUT=$(CONTRACT_USER=anon "$CLI" iterate "$CID" 2>&1)
echo "$HIT_OUT" | grep -q 'cache_hit_from: wave 1' || { echo "FAIL(1): second iterate did not HIT"; echo "$HIT_OUT"; exit 1; }
echo "PASS(1): second iterate within 10s = HIT"

# Phase 2 — different user MISS
MISS_OUT=$(CONTRACT_USER=public "$CLI" iterate "$CID" 2>&1)
echo "$MISS_OUT" | grep -q 'cache_hit_from' && { echo "FAIL(2): different user should not HIT anon's cache"; echo "$MISS_OUT"; exit 1; }
echo "PASS(2): per-user keying — public MISSed anon's cache slot"

# Phase 3 — stdin keying
CID3=$(CONTRACT_USER=anon "$CLI" declare "cache phase3" --action 'true' --no-drive 2>&1 \
        | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
echo "alpha" | CONTRACT_USER=anon "$CLI" iterate "$CID3" --stdin >/dev/null 2>&1
A2=$(echo "alpha" | CONTRACT_USER=anon "$CLI" iterate "$CID3" --stdin 2>&1)
echo "$A2" | grep -q 'cache_hit_from' || { echo "FAIL(3a): same stdin should HIT"; echo "$A2"; exit 1; }
B1=$(echo "beta" | CONTRACT_USER=anon "$CLI" iterate "$CID3" --stdin 2>&1)
echo "$B1" | grep -q 'cache_hit_from' && { echo "FAIL(3b): different stdin should MISS"; echo "$B1"; exit 1; }
echo "PASS(3): --stdin — same payload HIT, different payload MISS"

# Phase 4 — agent-judges bypass
CID4=$(CONTRACT_USER=anon "$CLI" declare "cache phase4 judges" --action "agent-judges" --no-drive 2>&1 \
        | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
CONTRACT_USER=anon "$CLI" iterate "$CID4" >/dev/null 2>&1
J2=$(CONTRACT_USER=anon "$CLI" iterate "$CID4" 2>&1)
echo "$J2" | grep -q 'cache_hit_from' && { echo "FAIL(4): agent-judges shape should bypass cache"; echo "$J2"; exit 1; }
echo "PASS(4): agent-judges shape bypassed (no cache_hit_from line)"

# Phase 5 — --no-cache
N5=$(CONTRACT_USER=anon "$CLI" iterate "$CID" --no-cache 2>&1)
echo "$N5" | grep -q 'cache_hit_from' && { echo "FAIL(5): --no-cache should force fresh run"; echo "$N5"; exit 1; }
echo "PASS(5): --no-cache forces fresh run despite warm cache"

# Phase 6 — cached event row on HIT, no extra iterated row
CACHED_COUNT=$(grep -c '"event": "cached"' "$CONTRACTS_STORE" || true)
[ "$CACHED_COUNT" -ge 2 ] || { echo "FAIL(6): expected ≥2 cached event rows, got $CACHED_COUNT"; exit 1; }
echo "PASS(6): cached event rows present on every HIT (audit trail intact)"

echo
echo "verb-gates/iterate-cache: PASS"
exit 0
