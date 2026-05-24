#!/usr/bin/env bash
# verb-gate: identify + rbac — internet-identity enrichment + role-based access control.
#
# Catches regressions where:
#   - identify silently skips network without ttl check (would re-probe every call)
#   - cache HIT path returns stale ttl_until without surfacing the cache (un-debuggable)
#   - identify_resolved ledger row not appended (no audit trail)
#   - rbac check allows action without grant (security regression)
#   - rbac deny doesn't emit RBAC DENIED block (silent failure)
#   - rbac grant/revoke don't persist to roles.json
#   - missing args exit 0 (silent)
#   - role with '*' wildcard doesn't allow arbitrary actions
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks"

# === Phase 1: identify with stub → resolved block + ttl + audit row ===
cat > "$TD/stub.json" <<'EOF'
{"kind":"handle","avatar_url":"https://avatars.example/x.png","sources":["stub-test"]}
EOF
OUT1=$("$CLI" identify @testhandle --from-stub "$TD/stub.json" 2>&1)
echo "$OUT1" | grep -q "resolved:  STUB"                || { echo "FAIL P1: stub not noted. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "sources:   stub-test"           || { echo "FAIL P1: stub source not surfaced. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "ttl_until: "                    || { echo "FAIL P1: no ttl_until line. OUT=$OUT1"; exit 1; }
PROFILE="$TD/.contracts/identities/@testhandle.json"
[ -f "$PROFILE" ]                                       || { echo "FAIL P1: profile not written"; exit 1; }
HAS_RESOLVED=$(python3 -c "
import json
p = json.load(open('$PROFILE'))
r = p.get('resolved', {})
print('OK' if r.get('kind') == 'handle' and r.get('avatar_url') and r.get('ttl_until') else f'FAIL: {r}')
")
[ "$HAS_RESOLVED" = "OK" ]                              || { echo "FAIL P1: resolved block wrong: $HAS_RESOLVED"; exit 1; }
# Audit row appended
HAS_AUDIT=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'identity_resolved' and r.get('id') == '@testhandle']
print('OK' if matches else 'FAIL: no identity_resolved row')
")
[ "$HAS_AUDIT" = "OK" ]                                 || { echo "FAIL P1: $HAS_AUDIT"; exit 1; }

# === Phase 2: second call → cache HIT (no re-probe, no new audit row) ===
ROWS_BEFORE=$(wc -l < "$CONTRACTS_STORE" | tr -d ' ')
OUT2=$("$CLI" identify @testhandle 2>&1)
echo "$OUT2" | grep -q "cache HIT"                      || { echo "FAIL P2: cache HIT not surfaced. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "result:    PASS (cached, no network)" || { echo "FAIL P2: no cached-PASS line. OUT=$OUT2"; exit 1; }
ROWS_AFTER=$(wc -l < "$CONTRACTS_STORE" | tr -d ' ')
[ "$ROWS_AFTER" = "$ROWS_BEFORE" ]                      || { echo "FAIL P2: ledger row added on cache HIT (was $ROWS_BEFORE, now $ROWS_AFTER)"; exit 1; }

# === Phase 3: --refresh forces re-probe + new audit row ===
cat > "$TD/stub2.json" <<'EOF'
{"kind":"handle","avatar_url":"https://avatars.example/v2.png","sources":["stub-refreshed"]}
EOF
OUT3=$("$CLI" identify @testhandle --refresh --from-stub "$TD/stub2.json" 2>&1)
echo "$OUT3" | grep -q "stub-refreshed"                 || { echo "FAIL P3: refresh didn't pick new stub. OUT=$OUT3"; exit 1; }
ROWS_P3=$(wc -l < "$CONTRACTS_STORE" | tr -d ' ')
[ "$ROWS_P3" -gt "$ROWS_AFTER" ]                        || { echo "FAIL P3: --refresh didn't append a new audit row"; exit 1; }

# === Phase 4: rbac grant + assign + check (allow path) ===
"$CLI" rbac grant editor "publish" "edit" > /dev/null
"$CLI" rbac assign @testhandle editor > /dev/null
OUT4=$("$CLI" rbac check @testhandle publish 2>&1)
echo "$OUT4" | grep -qE "result:.*PASS.*allowed"        || { echo "FAIL P4: allowed check didn't PASS. OUT=$OUT4"; exit 1; }
echo "$OUT4" | grep -q "role:      editor"              || { echo "FAIL P4: role not surfaced. OUT=$OUT4"; exit 1; }

# === Phase 5: rbac check (deny) → RBAC DENIED block + exit 1 ===
set +e
OUT5=$("$CLI" rbac check @testhandle delete-prod 2>&1)
RC5=$?
set -e
[ "$RC5" = "1" ]                                        || { echo "FAIL P5: deny exited $RC5, expected 1"; exit 1; }
echo "$OUT5" | grep -q "=== RBAC DENIED ==="            || { echo "FAIL P5: no RBAC DENIED block. OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "granted:   edit, publish"       || { echo "FAIL P5: granted set not listed. OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "fix:       contract rbac grant" || { echo "FAIL P5: no fix hint. OUT=$OUT5"; exit 1; }

# === Phase 6: rbac grant persists to roles.json + audit row ===
ROLES="$TD/.contracts/rbac/roles.json"
[ -f "$ROLES" ]                                         || { echo "FAIL P6: roles.json not written"; exit 1; }
ROLES_OK=$(python3 -c "
import json
r = json.load(open('$ROLES'))
print('OK' if 'publish' in r.get('editor', []) and 'edit' in r.get('editor', []) else f'FAIL: {r}')
")
[ "$ROLES_OK" = "OK" ]                                  || { echo "FAIL P6: roles.json content wrong: $ROLES_OK"; exit 1; }
# rbac_grant audit row
HAS_GRANT=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'rbac_grant' and r.get('id') == 'editor']
print('OK' if matches else 'FAIL: no rbac_grant row')
")
[ "$HAS_GRANT" = "OK" ]                                 || { echo "FAIL P6: $HAS_GRANT"; exit 1; }

# === Phase 7: wildcard '*' grants any action ===
"$CLI" rbac grant superadmin "*" > /dev/null
"$CLI" rbac assign root@example.com superadmin > /dev/null
OUT7=$("$CLI" rbac check root@example.com nuke-everything 2>&1)
echo "$OUT7" | grep -qE "result:.*PASS"                 || { echo "FAIL P7: wildcard didn't allow arbitrary action. OUT=$OUT7"; exit 1; }

# === Phase 8: missing args → exit 2 ===
set +e
OUT_I=$("$CLI" identify 2>&1); RC_I=$?
OUT_R=$("$CLI" rbac check 2>&1); RC_R=$?
set -e
[ "$RC_I" = "2" ]                                       || { echo "FAIL P8a: empty identify didn't exit 2 (got $RC_I)"; exit 1; }
[ "$RC_R" = "2" ]                                       || { echo "FAIL P8b: empty rbac check didn't exit 2 (got $RC_R)"; exit 1; }
echo "$OUT_I" | grep -q "usage: contract identify"      || { echo "FAIL P8a: no usage line"; exit 1; }

# === Phase 9: no-role identity → deny with helpful 'assign a role' hint ===
set +e
OUT9=$("$CLI" rbac check unknown@stranger.example deploy 2>&1)
RC9=$?
set -e
[ "$RC9" = "1" ]                                        || { echo "FAIL P9: no-role didn't deny (got $RC9)"; exit 1; }
echo "$OUT9" | grep -q "role:      (no role assigned)"  || { echo "FAIL P9: no 'no role' surface. OUT=$OUT9"; exit 1; }
echo "$OUT9" | grep -q "rbac assign"                    || { echo "FAIL P9: no assign-hint. OUT=$OUT9"; exit 1; }

echo "PASS: identify+rbac gate — identify caches resolved block + ttl + audit row, second call cache HIT (no re-probe, no new row), --refresh re-probes + new row, rbac grant persists to roles.json + audit row, allow exits 0, deny exits 1 + RBAC DENIED block + fix hint + granted list, wildcard '*' allows any action, missing args exit 2 with usage, no-role identity gets 'assign a role' hint"
