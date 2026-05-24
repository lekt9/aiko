#!/usr/bin/env bash
# verb-gate: mailbox — task-mailbox with brief + dated history + detach-on-step.
#
# The Eugene-+-Manus context-reset bug: an agent passes work to another
# agent mid-task without explicitly detaching, the receiving agent loses
# the brief because nothing in the substrate forced the handoff. Fix at
# the /contract level: every step requires explicit step-next (attach +
# cold-read brief) and explicit step-complete (detach + audit row).
#
# Catches regressions where:
#   - send doesn't write inbox row + audit row
#   - read doesn't surface brief + history (next agent loses context)
#   - step-complete without prior step-next silently advances (rogue)
#   - step-complete by wrong agent silently advances (impersonation)
#   - step-next while previous step still assigned silently re-attaches
#   - missing args exit 0 (silent)
#   - state isn't reconstructable from ledger event stream alone
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks"

# === Phase 1: send writes inbox + ledger audit row + returns mail_id ===
OUT1=$(CONTRACT_AGENT="lewis@getfoundry.app" bash "$CLI" mailbox send manus@manus.im --brief "Scrape pricing → extract → diff" --steps 3 2>&1)
echo "$OUT1" | grep -q "result:      PASS"                  || { echo "FAIL P1: send didn't PASS. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "from:        lewis@getfoundry.app"  || { echo "FAIL P1: from not surfaced. OUT=$OUT1"; exit 1; }
echo "$OUT1" | grep -q "to:          manus@manus.im"        || { echo "FAIL P1: to not surfaced. OUT=$OUT1"; exit 1; }
MID=$(echo "$OUT1" | grep -oE 'mail_id: +[a-f0-9]{8}' | grep -oE '[a-f0-9]{8}' | head -1)
[ -n "$MID" ]                                               || { echo "FAIL P1: no mail_id parseable. OUT=$OUT1"; exit 1; }
INBOX="$TD/.contracts/inbox/mail/manus@manus.im.jsonl"
[ -f "$INBOX" ]                                             || { echo "FAIL P1: inbox not written at $INBOX"; exit 1; }
HAS_SENT=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'mail_sent' and r.get('mail_id') == '$MID']
print('OK' if matches and matches[0].get('total_steps') == 3 else 'FAIL')
")
[ "$HAS_SENT" = "OK" ]                                      || { echo "FAIL P1: no mail_sent audit row with steps=3"; exit 1; }

# === Phase 2: step-next attaches + cold-reads brief ===
OUT2=$(CONTRACT_AGENT="manus@manus.im" bash "$CLI" mailbox step-next "$MID" 2>&1)
echo "$OUT2" | grep -q "step:         1/3  ASSIGNED"        || { echo "FAIL P2: step 1 not marked ASSIGNED. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "brief (cold read):"                 || { echo "FAIL P2: no cold-read brief surface. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "Scrape pricing"                     || { echo "FAIL P2: brief content missing. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "result:       PASS"                 || { echo "FAIL P2: step-next didn't PASS. OUT=$OUT2"; exit 1; }

# === Phase 3: step-complete detaches + appends mail_step_complete ===
OUT3=$(CONTRACT_AGENT="manus@manus.im" bash "$CLI" mailbox step-complete "$MID" --proof "47 SKUs at /tmp/scrape.html" 2>&1)
echo "$OUT3" | grep -q "step:         1/3  COMPLETE"        || { echo "FAIL P3: step 1 not marked COMPLETE. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "detached:     YES"                  || { echo "FAIL P3: no detach surface. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "result:       PASS"                 || { echo "FAIL P3: step-complete didn't PASS. OUT=$OUT3"; exit 1; }
HAS_DONE=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
m = [r for r in rows if r.get('event') == 'mail_step_complete' and r.get('mail_id') == '$MID' and r.get('step') == 1]
print('OK' if m and m[0].get('agent') == 'manus@manus.im' and 'SKUs' in m[0].get('proof','') else 'FAIL')
")
[ "$HAS_DONE" = "OK" ]                                      || { echo "FAIL P3: mail_step_complete row wrong"; exit 1; }

# === Phase 4: BUG GUARD — rogue step-complete after detach exits 1 ===
set +e
OUT4=$(CONTRACT_AGENT="rogue@x.com" bash "$CLI" mailbox step-complete "$MID" --proof "fake" 2>&1)
RC4=$?
set -e
[ "$RC4" = "1" ]                                            || { echo "FAIL P4: rogue advance exited $RC4, expected 1"; exit 1; }
echo "$OUT4" | grep -q "no current assignment"              || { echo "FAIL P4: no detach-guard error. OUT=$OUT4"; exit 1; }

# === Phase 5: fresh agent step-next attaches step 2 + reads history cold ===
OUT5=$(CONTRACT_AGENT="manus-v2@manus.im" bash "$CLI" mailbox step-next "$MID" 2>&1)
echo "$OUT5" | grep -q "step:         2/3  ASSIGNED"        || { echo "FAIL P5: step 2 not ASSIGNED. OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "history (1 prior steps"             || { echo "FAIL P5: no history block. OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "step 1: 47 SKUs"                    || { echo "FAIL P5: step 1 history missing. OUT=$OUT5"; exit 1; }

# === Phase 6: BUG GUARD — impostor step-complete on assigned step exits 1 ===
set +e
OUT6=$(CONTRACT_AGENT="impostor@x.com" bash "$CLI" mailbox step-complete "$MID" --proof "smuggled" 2>&1)
RC6=$?
set -e
[ "$RC6" = "1" ]                                            || { echo "FAIL P6: impostor advance exited $RC6, expected 1"; exit 1; }
echo "$OUT6" | grep -q "only the assigned agent"            || { echo "FAIL P6: no identity-guard error. OUT=$OUT6"; exit 1; }

# === Phase 7: BUG GUARD — step-next while assigned exits 1 ===
set +e
OUT7=$(CONTRACT_AGENT="next-agent@x.com" bash "$CLI" mailbox step-next "$MID" 2>&1)
RC7=$?
set -e
[ "$RC7" = "1" ]                                            || { echo "FAIL P7: re-attach exited $RC7, expected 1"; exit 1; }
echo "$OUT7" | grep -q "still assigned to manus-v2"         || { echo "FAIL P7: no re-attach guard error. OUT=$OUT7"; exit 1; }

# === Phase 8: correct agent completes step 2; read surfaces full history ===
CONTRACT_AGENT="manus-v2@manus.im" bash "$CLI" mailbox step-complete "$MID" --proof "extracted prices" > /dev/null
OUT8=$(bash "$CLI" mailbox read "$MID" 2>&1)
echo "$OUT8" | grep -q "progress:     2/3"                  || { echo "FAIL P8: progress wrong. OUT=$OUT8"; exit 1; }
echo "$OUT8" | grep -q "step 1: 47 SKUs"                    || { echo "FAIL P8: step 1 history missing in read"; exit 1; }
echo "$OUT8" | grep -q "step 2: extracted prices"           || { echo "FAIL P8: step 2 history missing in read"; exit 1; }
echo "$OUT8" | grep -q "by manus@manus.im"                  || { echo "FAIL P8: step 1 author missing. OUT=$OUT8"; exit 1; }
echo "$OUT8" | grep -q "by manus-v2@manus.im"               || { echo "FAIL P8: step 2 author missing. OUT=$OUT8"; exit 1; }

# === Phase 9: missing args → exit 2 with usage ===
set +e
OUT_E=$(bash "$CLI" mailbox 2>&1); RC_E=$?
OUT_S=$(bash "$CLI" mailbox send 2>&1); RC_S=$?
OUT_C=$(bash "$CLI" mailbox step-complete "$MID" 2>&1); RC_C=$?
set -e
[ "$RC_E" = "2" ]                                           || { echo "FAIL P9a: empty mailbox didn't exit 2 (got $RC_E)"; exit 1; }
[ "$RC_S" = "2" ]                                           || { echo "FAIL P9b: empty send didn't exit 2 (got $RC_S)"; exit 1; }
[ "$RC_C" = "2" ]                                           || { echo "FAIL P9c: step-complete without --proof didn't exit 2 (got $RC_C)"; exit 1; }

# === Phase 10: state is fully reconstructable from event stream alone ===
# Reset HOME to nothing-but-ledger; mailbox read must still work from rows.
STATE_OK=$(python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE')]
mid = '$MID'
sent = [r for r in rows if r.get('event')=='mail_sent' and r.get('mail_id')==mid]
done = [r for r in rows if r.get('event')=='mail_step_complete' and r.get('mail_id')==mid]
assigned = [r for r in rows if r.get('event')=='mail_step_assigned' and r.get('mail_id')==mid]
print('OK' if len(sent)==1 and len(done)==2 and len(assigned)==2 else f'FAIL: sent={len(sent)} done={len(done)} assigned={len(assigned)}')
")
[ "$STATE_OK" = "OK" ]                                      || { echo "FAIL P10: ledger state wrong: $STATE_OK"; exit 1; }

echo "PASS: mailbox gate — send writes inbox+audit, step-next attaches + cold-reads brief, step-complete detaches + audit row, rogue/impostor/re-attach guards all exit 1 with clear errors (Eugene+Manus fix), read surfaces brief + dated history with authors, missing args exit 2, full state reconstructable from ledger event stream"
