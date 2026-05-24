#!/usr/bin/env bash
# verb-gate: permission — the "Eugene-got-stuck" fix.
#
# Catches regressions where:
#   - request doesn't write to target's inbox (bot can't surface to role-owner)
#   - request doesn't return PERMISSION REQUESTED block (transports can't render)
#   - request exits 0 (would silently let bot proceed without permission)
#   - grant/deny without matching req_id silently succeeds
#   - resolve doesn't write to permission-resolve inbox (bot can't wake)
#   - show lists resolved requests (would re-pester Lewis with done items)
#   - for_contract isn't preserved through the round-trip (Ω1 can't re-iterate)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks"

# === Phase 1: request writes inbox row + emits PERMISSION REQUESTED block + exit 1 ===
set +e
OUT1=$(CONTRACT_AGENT="eugene@example.com" "$CLI" permission request lewis@getfoundry.app wipe-prod --context "eugene asks" --for-id eugene-c-1234 2>&1)
RC1=$?
set -e
[ "$RC1" = "1" ]                                          || { echo "FAIL P1: request exited $RC1, expected 1 (FAIL — awaiting grant)"; exit 1; }
echo "$OUT1" | grep -q "=== PERMISSION REQUESTED ==="     || { echo "FAIL P1: no PERMISSION REQUESTED block. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "target:      lewis@getfoundry"    || { echo "FAIL P1: target not surfaced. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "action:      wipe-prod"           || { echo "FAIL P1: action not surfaced. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "requester:   eugene@example.com"  || { echo "FAIL P1: requester not surfaced. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "for_contract: eugene-c-1234"      || { echo "FAIL P1: for_contract not surfaced. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "Aiko voice"                       || { echo "FAIL P1: no Aiko-voice prompt for Eugene. OUT=$OUT1"; exit 1; }
REQ_ID=$(echo "$OUT1" | grep -E "^  req_id:" | grep -oE "[a-f0-9]{8}" | head -1)
[ -n "$REQ_ID" ]                                          || { echo "FAIL P1: no req_id parseable"; exit 1; }

INBOX="$TD/.contracts/inbox/permission-request/lewis@getfoundry.app.jsonl"
[ -f "$INBOX" ]                                           || { echo "FAIL P1: inbox row not written at $INBOX"; exit 1; }
ROW_OK=$(python3 -c "
import json
r = json.loads(open('$INBOX').readline())
print('OK' if r['action']=='wipe-prod' and r['requester']=='eugene@example.com' and r['for_contract']=='eugene-c-1234' and r['req_id']=='$REQ_ID' else f'FAIL: {r}')
")
[ "$ROW_OK" = "OK" ]                                      || { echo "FAIL P1: inbox row wrong: $ROW_OK"; exit 1; }

# === Phase 2: show surfaces the pending request ===
OUT2=$("$CLI" permission show lewis@getfoundry.app 2>&1)
echo "$OUT2" | grep -q "pending permission requests: 1"   || { echo "FAIL P2: pending count wrong. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "$REQ_ID"                          || { echo "FAIL P2: req_id missing from show. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "wipe-prod"                        || { echo "FAIL P2: action missing from show. OUT=$OUT2"; exit 1; }

# === Phase 3: grant writes resolve row + names for_contract for Ω1 ===
OUT3=$(CONTRACT_AGENT="lewis@getfoundry.app" "$CLI" permission grant "$REQ_ID" "ok once" 2>&1)
echo "$OUT3" | grep -q "verdict:   GRANT"                 || { echo "FAIL P3: verdict not surfaced. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "Ω1 hint:"                         || { echo "FAIL P3: Ω1 hint missing. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "eugene-c-1234"                    || { echo "FAIL P3: for_contract not surfaced. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "result:    PASS"                  || { echo "FAIL P3: no PASS line. OUT=$OUT3"; exit 1; }

RESOLVE="$TD/.contracts/inbox/permission-resolve/lewis@getfoundry.app.jsonl"
[ -f "$RESOLVE" ]                                         || { echo "FAIL P3: resolve inbox not written"; exit 1; }
R_OK=$(python3 -c "
import json
r = json.loads(open('$RESOLVE').readline())
print('OK' if r['verdict']=='grant' and r['resolver']=='lewis@getfoundry.app' and r['for_contract']=='eugene-c-1234' and r['req_id']=='$REQ_ID' else f'FAIL: {r}')
")
[ "$R_OK" = "OK" ]                                        || { echo "FAIL P3: resolve row wrong: $R_OK"; exit 1; }

# === Phase 4: after grant, show pending = 0 (resolved requests filtered out) ===
OUT4=$("$CLI" permission show lewis@getfoundry.app 2>&1)
echo "$OUT4" | grep -q "pending permission requests: 0"   || { echo "FAIL P4: resolved request still showing as pending. OUT=$OUT4"; exit 1; }

# === Phase 5: deny path also works + records reason ===
set +e
OUT_D=$(CONTRACT_AGENT="eugene2@example.com" "$CLI" permission request lewis@getfoundry.app delete-account 2>&1)
DENY_RC=$?
set -e
[ "$DENY_RC" = "1" ] || { echo "FAIL P5a: request exit wrong"; exit 1; }
REQ2=$(echo "$OUT_D" | grep -E "^  req_id:" | grep -oE "[a-f0-9]{8}" | head -1)
OUT5=$(CONTRACT_AGENT="lewis@getfoundry.app" "$CLI" permission deny "$REQ2" "not safe" 2>&1)
echo "$OUT5" | grep -q "verdict:   DENY"                  || { echo "FAIL P5b: deny verdict not surfaced. OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "reason:    not safe"              || { echo "FAIL P5b: reason not surfaced. OUT=$OUT5"; exit 1; }

# === Phase 6: grant on unknown req_id exits 1 with clear error ===
set +e
OUT_BAD=$("$CLI" permission grant "deadbeef" 2>&1)
RC_BAD=$?
set -e
[ "$RC_BAD" = "1" ]                                       || { echo "FAIL P6: unknown req_id exited $RC_BAD, expected 1"; exit 1; }
echo "$OUT_BAD" | grep -q "no permission_request found"   || { echo "FAIL P6: no clear error. OUT=$OUT_BAD"; exit 1; }

# === Phase 7: missing args → exit 2 with usage ===
set +e
OUT_U=$("$CLI" permission 2>&1); RC_U=$?
OUT_R=$("$CLI" permission request 2>&1); RC_R=$?
set -e
[ "$RC_U" = "2" ]                                         || { echo "FAIL P7a: empty permission didn't exit 2 (got $RC_U)"; exit 1; }
[ "$RC_R" = "2" ]                                         || { echo "FAIL P7b: empty request didn't exit 2 (got $RC_R)"; exit 1; }

# === Phase 8: permission_request + permission_resolve audit rows in ledger ===
HAVE_BOTH=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
events = sorted({r.get('event') for r in rows if r.get('event','').startswith('permission_')})
print(','.join(events))
")
[[ "$HAVE_BOTH" == *"permission_request"* ]]              || { echo "FAIL P8: no permission_request audit row (got: $HAVE_BOTH)"; exit 1; }
[[ "$HAVE_BOTH" == *"permission_resolve"* ]]              || { echo "FAIL P8: no permission_resolve audit row (got: $HAVE_BOTH)"; exit 1; }

echo "PASS: permission gate — request writes inbox + emits PERMISSION REQUESTED block + exit 1, show lists pending only, grant writes resolve row + names for_contract for Ω1 re-iterate, deny path works with reason, unknown req_id → exit 1 with clear error, missing args → exit 2, audit rows in ledger for both events"
