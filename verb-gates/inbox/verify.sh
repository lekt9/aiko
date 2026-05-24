#!/usr/bin/env bash
# verb-gate: inbox — locality-aware inbox routing + cross-scope guard.
#
# Per Locality doctrine 79c2d656: inboxes follow the same scope walk as
# the ledger (env > <cwd>/.claude/inbox/ > ~/.contracts/inbox/). Writes
# from a project cwd land in the project's inbox, NOT the global. Reading
# a different scope requires explicit --scope <kind> and writes an
# inbox_cross_scope_read audit row.
#
# Catches regressions where:
#   - mailbox send leaks to global from inside a project (cross-tenant data bleed)
#   - permission request leaks to global from inside a project (same)
#   - cross-scope inbox read silently succeeds without audit row (un-traceable)
#   - inbox scopes verb doesn't surface the active scope (un-debuggable)
#   - env override (CONTRACTS_INBOX_ROOT) doesn't win precedence
#   - bad channel/name args don't exit 2
#   - container-style isolation broken (HOME swap should isolate inboxes)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/global-ledger.jsonl"
unset CONTRACTS_INBOX_ROOT 2>/dev/null || true

# === Phase 1: from a project cwd, mailbox send routes to project inbox ===
PROJ="$TD/proj"
mkdir -p "$PROJ/.claude"
cd "$PROJ"
OUT1=$(CONTRACT_AGENT="lewis@x.com" bash "$CLI" mailbox send manus@x.com --brief "scoped" --steps 1 2>&1)
echo "$OUT1" | grep -q "$PROJ/.claude/inbox/mail/manus@x.com.jsonl"  || { echo "FAIL P1: mailbox send didn't surface project path. OUT=$OUT1"; exit 1; }
[ -f "$PROJ/.claude/inbox/mail/manus@x.com.jsonl" ]                   || { echo "FAIL P1: project inbox file missing"; exit 1; }
[ ! -d "$TD/.contracts/inbox/mail" ]                                  || { echo "FAIL P1: leaked to global inbox"; exit 1; }

# === Phase 2: inbox scopes verb surfaces ACTIVE = project ===
OUT2=$(bash "$CLI" inbox scopes 2>&1)
echo "$OUT2" | grep -q "ACTIVE  kind=project"                         || { echo "FAIL P2: active scope not surfaced as project. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "available  kind=global"                       || { echo "FAIL P2: global not listed as available. OUT=$OUT2"; exit 1; }

# === Phase 3: inbox locate (auto) resolves to project ===
OUT3=$(bash "$CLI" inbox locate mail manus@x.com 2>&1)
echo "$OUT3" | grep -q "scope:    auto"                               || { echo "FAIL P3: scope label missing. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "exists:   yes"                                || { echo "FAIL P3: file should exist. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "$PROJ/.claude/inbox/mail/manus@x.com.jsonl"   || { echo "FAIL P3: wrong path. OUT=$OUT3"; exit 1; }

# === Phase 4: inbox list shows the row ===
OUT4=$(bash "$CLI" inbox list mail manus@x.com 2>&1)
echo "$OUT4" | grep -q "mail_sent"                                    || { echo "FAIL P4: row not surfaced. OUT=$OUT4"; exit 1; }
echo "$OUT4" | grep -q "from=lewis@x.com"                             || { echo "FAIL P4: from missing. OUT=$OUT4"; exit 1; }
echo "$OUT4" | grep -q "to=manus@x.com"                               || { echo "FAIL P4: to missing. OUT=$OUT4"; exit 1; }

# === Phase 5: BUG GUARD — cross-scope read requires --scope + writes audit row ===
OUT5=$(bash "$CLI" inbox list mail manus@x.com --scope global 2>&1)
echo "$OUT5" | grep -q "CROSS-SCOPE READ"                             || { echo "FAIL P5: no cross-scope warning. OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "audit row appended"                           || { echo "FAIL P5: no audit row note. OUT=$OUT5"; exit 1; }
HAS_AUDIT=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'inbox_cross_scope_read' and r.get('channel') == 'mail' and r.get('scope_kind') == 'global']
print('OK' if matches else 'FAIL: no audit row')
")
[ "$HAS_AUDIT" = "OK" ]                                               || { echo "FAIL P5: $HAS_AUDIT"; exit 1; }

# === Phase 6: env override (CONTRACTS_INBOX_ROOT) wins precedence ===
CUSTOM="$TD/custom-inbox"
OUT6=$(CONTRACTS_INBOX_ROOT="$CUSTOM" bash "$CLI" inbox scopes 2>&1)
echo "$OUT6" | grep -q "ACTIVE  kind=env"                             || { echo "FAIL P6: env didn't win precedence. OUT=$OUT6"; exit 1; }
echo "$OUT6" | grep -q "$CUSTOM"                                      || { echo "FAIL P6: custom root missing. OUT=$OUT6"; exit 1; }

# === Phase 7: env scope routes mailbox writes to the custom root ===
CONTRACTS_INBOX_ROOT="$CUSTOM" CONTRACT_AGENT="lewis@x.com" \
  bash "$CLI" mailbox send envtarget@x.com --brief "env-routed" --steps 1 > /dev/null
[ -f "$CUSTOM/mail/envtarget@x.com.jsonl" ]                           || { echo "FAIL P7: env route didn't write to custom root"; exit 1; }

# === Phase 8: HOME swap (container-style) isolates inboxes — write under HOME_A, read under HOME_B sees nothing ===
HOME_A="$TD/hostA"; HOME_B="$TD/hostB"
mkdir -p "$HOME_A" "$HOME_B"
cd /tmp  # leave the project cwd so global resolution wins
HOME="$HOME_A" CONTRACT_AGENT="lewis@x.com" CONTRACTS_STORE="$HOME_A/ledger.jsonl" \
  bash "$CLI" mailbox send isolated@x.com --brief "host A" --steps 1 > /dev/null
[ -f "$HOME_A/.contracts/inbox/mail/isolated@x.com.jsonl" ]           || { echo "FAIL P8a: host A write missing"; exit 1; }
[ ! -f "$HOME_B/.contracts/inbox/mail/isolated@x.com.jsonl" ]         || { echo "FAIL P8b: host B sees host A's inbox (isolation broken)"; exit 1; }

# === Phase 9: bad args → exit 2 with usage ===
set +e
OUT_E=$(bash "$CLI" inbox 2>&1); RC_E=$?
OUT_L=$(bash "$CLI" inbox locate 2>&1); RC_L=$?
OUT_R=$(bash "$CLI" inbox list mail 2>&1); RC_R=$?
set -e
[ "$RC_E" = "2" ]                                                     || { echo "FAIL P9a: empty inbox didn't exit 2 (got $RC_E)"; exit 1; }
[ "$RC_L" = "2" ]                                                     || { echo "FAIL P9b: empty locate didn't exit 2 (got $RC_L)"; exit 1; }
[ "$RC_R" = "2" ]                                                     || { echo "FAIL P9c: list with missing name didn't exit 2 (got $RC_R)"; exit 1; }

# === Phase 10: permission request also follows scope (project cwd → project inbox) ===
cd "$PROJ"
CONTRACT_AGENT="eugene@x.com" bash "$CLI" permission request lewis@x.com wipe-prod --context "test" > /dev/null 2>&1 || true
[ -f "$PROJ/.claude/inbox/permission-request/lewis@x.com.jsonl" ]     || { echo "FAIL P10: permission request didn't route to project scope"; exit 1; }
[ ! -d "$TD/.contracts/inbox/permission-request" ]                    || { echo "FAIL P10: permission leaked to global"; exit 1; }

cd /
echo "PASS: inbox gate — mailbox + permission writes route to project scope when cwd has .claude/, never leak to global; inbox scopes verb surfaces ACTIVE; locate/list resolve correctly; cross-scope read requires --scope + writes inbox_cross_scope_read audit row; CONTRACTS_INBOX_ROOT env wins precedence; HOME swap isolates host A from host B (container-style); bad args exit 2"
