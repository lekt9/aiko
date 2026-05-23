#!/usr/bin/env bash
# verb-gate: session (Σ6) — multi-client presence + claim semantics.
#
# Catches regressions where:
#   - register doesn't write a presence row (clients invisible to list)
#   - list returns stale rows past TTL (false-positive presence → wrong UX)
#   - aliases NOT resolved (clients registered under lekt8 invisible to lewis@...)
#   - claim is not first-write-wins (two devices both render the same modal)
#   - second claim by SAME client_id is incorrectly refused (idempotency)
#   - missing flags don't emit usage / non-zero exit
set -euo pipefail

# Capture REAL home BEFORE we swap HOME into a tempdir for isolation
REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# === Phase 0: missing required flags exit non-zero ===
"$CLI" session register --canonical lewis 2>/dev/null && { echo "FAIL: register without --transport/--client-id should fail"; exit 1; } || true
"$CLI" session list 2>/dev/null && { echo "FAIL: list without --canonical should fail"; exit 1; } || true
"$CLI" session claim req-x 2>/dev/null && { echo "FAIL: claim without --client-id should fail"; exit 1; } || true

# === Phase 1: register + list happy path ===
"$CLI" session register --canonical "lewis@getfoundry.app" --transport tg     --client-id "tg-phone"  --ttl 600 >/dev/null
"$CLI" session register --canonical "lewis@getfoundry.app" --transport web    --client-id "web-mac"   --ttl 600 >/dev/null
OUT_LIST=$("$CLI" session list --canonical "lewis@getfoundry.app" --ttl 600)
echo "$OUT_LIST" | grep -q "tg-phone"    || { echo "FAIL: tg-phone not in list. OUT=$OUT_LIST"; exit 1; }
echo "$OUT_LIST" | grep -q "web-mac"     || { echo "FAIL: web-mac not in list. OUT=$OUT_LIST"; exit 1; }

# === Phase 2: TTL — stale rows drop out ===
# Register with ttl=1, sleep 2, expect empty list
"$CLI" session register --canonical "stale@example" --transport tg --client-id "stale-c" --ttl 1 >/dev/null
sleep 2
OUT_STALE=$("$CLI" session list --canonical "stale@example" --ttl 1)
echo "$OUT_STALE" | grep -q "no active clients" || { echo "FAIL: expired session still in list. OUT=$OUT_STALE"; exit 1; }

# === Phase 3: Σ3 alias resolution — register under alias resolves to canonical ===
"$CLI" alias "lewis@getfoundry.app" "lekt8" >/dev/null 2>&1
"$CLI" session register --canonical "lekt8" --transport mobile --client-id "lekt8-iphone" --ttl 600 >/dev/null
OUT_VIA_CANON=$("$CLI" session list --canonical "lewis@getfoundry.app" --ttl 600)
echo "$OUT_VIA_CANON" | grep -q "lekt8-iphone" || { echo "FAIL: alias-registered client invisible via canonical lookup. OUT=$OUT_VIA_CANON"; exit 1; }

# === Phase 4: claim — first wins, second refused with non-zero exit ===
"$CLI" session claim "req-payment-42" --client-id "tg-phone" 2>&1 | grep -q "claimed:" \
  || { echo "FAIL: first claim did not succeed"; exit 1; }
OUT_DOUBLE=$("$CLI" session claim "req-payment-42" --client-id "web-mac" 2>&1 || true)
echo "$OUT_DOUBLE" | grep -q "ALREADY CLAIMED" || { echo "FAIL: second claim not refused. OUT=$OUT_DOUBLE"; exit 1; }
echo "$OUT_DOUBLE" | grep -q "claimed by:  tg-phone" || { echo "FAIL: refusal doesn't name original claimant. OUT=$OUT_DOUBLE"; exit 1; }

# Verify the refusal exited non-zero so the calling transport can branch
if "$CLI" session claim "req-payment-42" --client-id "panel-mac" 2>/dev/null; then
  echo "FAIL: refused claim exited 0 (transport adapter can't detect)"; exit 1
fi

# === Phase 5: idempotent re-claim by same client_id is fine (no spurious refusal) ===
# Same client re-claiming its own block should NOT be refused
if "$CLI" session claim "req-payment-42" --client-id "tg-phone" 2>&1 | grep -q "ALREADY CLAIMED"; then
  echo "FAIL: same-client re-claim wrongly refused (should be idempotent)"; exit 1
fi

echo "PASS: session gate (Σ6) — register/list/claim work, TTL drops stale, Σ3 aliases resolve, claim is first-write-wins + same-client idempotent"
