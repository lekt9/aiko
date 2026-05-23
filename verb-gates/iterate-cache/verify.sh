#!/usr/bin/env bash
# verb-gates/iterate-cache/verify.sh — binds the 10s sliding-window per-user
# cache on `contract iterate` (lib/cache_layer.py).
#
# Scope reminder: cache fires for api + x402 pointer types ONLY (network-billed
# coalescing). cli / harness / machine / agent-judges / composition shapes
# bypass — they're the deliberate re-iterate paths where caching would freeze
# stale verdicts during iterate-fix-iterate workflows.
#
# Phases:
#   1. api pointer — second iterate within 10s is a HIT
#   2. Per-user keying — same contract, different CONTRACT_USER, MISS
#   3. --stdin — different stdin → different cache slot
#   4. cli pointer (default) bypassed — local-binary re-check stays fresh
#   5. agent-judges bypass — composition/judgment shapes excluded
#   6. --no-cache — forces fresh run even when cache is warm
#   7. Cached event row appended on HIT (audit trail intact, wave not incremented)
set -e

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export CONTRACTS_STORE="$TD/ledger.jsonl"
CLI="$HOME/.claude/skills/contract/scripts/contract"

# api-shaped action: starts with 'curl ', 'http://', 'https://', or 'wget '.
# Use 'curl true' style — we just need _infer_pointer_type to bucket it as api;
# the substring command runs as a normal shell command underneath.
API_ACTION='curl --version >/dev/null'

# Phase 1 — api pointer, miss then hit within 10s
CID=$(CONTRACT_USER=anon "$CLI" declare "cache phase1 api" --action "$API_ACTION" --no-drive 2>&1 \
        | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
[ -n "$CID" ] || { echo "FAIL(1): could not declare api cell"; exit 1; }
CONTRACT_USER=anon "$CLI" iterate "$CID" >/dev/null 2>&1 || { echo "FAIL(1): first iterate errored"; exit 1; }
HIT_OUT=$(CONTRACT_USER=anon "$CLI" iterate "$CID" 2>&1)
echo "$HIT_OUT" | grep -q 'cache_hit_from: wave 1' || { echo "FAIL(1): second iterate did not HIT"; echo "$HIT_OUT"; exit 1; }
echo "PASS(1): api pointer — second iterate within 10s = HIT"

# Phase 2 — different user MISS
MISS_OUT=$(CONTRACT_USER=public "$CLI" iterate "$CID" 2>&1)
echo "$MISS_OUT" | grep -q 'cache_hit_from' && { echo "FAIL(2): different user should not HIT anon's cache"; echo "$MISS_OUT"; exit 1; }
echo "PASS(2): per-user keying — public MISSed anon's cache slot"

# Phase 3 — stdin keying on api pointer
CID3=$(CONTRACT_USER=anon "$CLI" declare "cache phase3 api stdin" --action "$API_ACTION" --no-drive 2>&1 \
        | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
echo "alpha" | CONTRACT_USER=anon "$CLI" iterate "$CID3" --stdin >/dev/null 2>&1
A2=$(echo "alpha" | CONTRACT_USER=anon "$CLI" iterate "$CID3" --stdin 2>&1)
echo "$A2" | grep -q 'cache_hit_from' || { echo "FAIL(3a): same stdin should HIT"; echo "$A2"; exit 1; }
B1=$(echo "beta" | CONTRACT_USER=anon "$CLI" iterate "$CID3" --stdin 2>&1)
echo "$B1" | grep -q 'cache_hit_from' && { echo "FAIL(3b): different stdin should MISS"; echo "$B1"; exit 1; }
echo "PASS(3): --stdin keying — same payload HIT, different payload MISS"

# Phase 4 — cli pointer bypass (local-binary, deliberate re-iterate path)
CID4=$(CONTRACT_USER=anon "$CLI" declare "cache phase4 cli bypass" --action "true" --no-drive 2>&1 \
        | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
CONTRACT_USER=anon "$CLI" iterate "$CID4" >/dev/null 2>&1
C2=$(CONTRACT_USER=anon "$CLI" iterate "$CID4" 2>&1)
echo "$C2" | grep -q 'cache_hit_from' && { echo "FAIL(4): cli pointer should bypass cache (iterate-fix-iterate path)"; echo "$C2"; exit 1; }
echo "PASS(4): cli pointer bypassed (re-iterate stays fresh for local-binary actions)"

# Phase 5 — agent-judges bypass
CID5=$(CONTRACT_USER=anon "$CLI" declare "cache phase5 judges" --action "agent-judges" --no-drive 2>&1 \
        | grep -oE '^declared: [0-9a-f]+' | awk '{print $2}')
CONTRACT_USER=anon "$CLI" iterate "$CID5" >/dev/null 2>&1
J2=$(CONTRACT_USER=anon "$CLI" iterate "$CID5" 2>&1)
echo "$J2" | grep -q 'cache_hit_from' && { echo "FAIL(5): agent-judges shape should bypass cache"; echo "$J2"; exit 1; }
echo "PASS(5): agent-judges shape bypassed"

# Phase 6 — --no-cache on api pointer
N6=$(CONTRACT_USER=anon "$CLI" iterate "$CID" --no-cache 2>&1)
echo "$N6" | grep -q 'cache_hit_from' && { echo "FAIL(6): --no-cache should force fresh run"; echo "$N6"; exit 1; }
echo "PASS(6): --no-cache forces fresh run despite warm cache"

# Phase 7 — cached event rows
CACHED_COUNT=$(grep -c '"event": "cached"' "$CONTRACTS_STORE" || true)
[ "$CACHED_COUNT" -ge 2 ] || { echo "FAIL(7): expected ≥2 cached event rows, got $CACHED_COUNT"; exit 1; }
echo "PASS(7): cached event rows present on every HIT (audit trail intact)"

echo
echo "verb-gates/iterate-cache: PASS"
exit 0
