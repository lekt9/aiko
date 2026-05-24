#!/usr/bin/env bash
# verb-gate: ssh-redeploy — always-on bot redeploy via /contract composition.
#
# Aiko-on-tencent reference shape: substrate-as-config gate + ssh restart +
# probe + ledger audit row. Mocks `ssh` and `curl` via stub binaries on PATH
# so the gate runs offline without touching real hosts.
#
# Catches regressions where:
#   - missing args don't exit 2
#   - gate-off path still ssh's (would burn auth attempts on every iterate)
#   - gate-on path doesn't append ssh_redeploy ledger row
#   - probe failure doesn't surface as FAIL
#   - feature-status verb missing → script doesn't crash (safe-OFF)
set -euo pipefail

REAL_HOME="$HOME"
HELPER="$REAL_HOME/.claude/skills/contract/scripts/ssh-redeploy.sh"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -x "$HELPER" ] || { echo "FAIL: helper missing/non-exec at $HELPER"; exit 1; }
[ -f "$CLI" ]    || { echo "FAIL: CLI missing at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
mkdir -p "$TD/.contracts/hooks" "$TD/bin"

# Stub ssh + curl on PATH for offline tests. Both write what-they-were-called-with
# to logs the gate can inspect, then exit 0/1 deterministically.
cat > "$TD/bin/ssh" <<EOF
#!/usr/bin/env bash
echo "stub-ssh called: \$*" >> $TD/ssh.log
exit \${SSH_STUB_RC:-0}
EOF
cat > "$TD/bin/curl" <<EOF
#!/usr/bin/env bash
echo "stub-curl called: \$*" >> $TD/curl.log
# Last arg is the URL by helper's convention
echo "{\"ok\":true,\"result\":{\"id\":1}}"
exit \${CURL_STUB_RC:-0}
EOF
chmod +x "$TD/bin/ssh" "$TD/bin/curl"
export PATH="$TD/bin:$PATH"

# === Phase 1: missing args → exit 2 ===
set +e
"$HELPER" 2>/dev/null
RC1=$?
set -e
[ "$RC1" = "2" ] || { echo "FAIL P1: missing args exited $RC1, expected 2"; exit 1; }

# === Phase 2: gate-off → exit 0 (SKIP), no ssh attempted, no ledger row ===
SSH_LOG_BEFORE=$([ -f "$TD/ssh.log" ] && wc -l < "$TD/ssh.log" | tr -d ' ' || echo 0)
LEDGER_BEFORE=$([ -f "$CONTRACTS_STORE" ] && wc -l < "$CONTRACTS_STORE" | tr -d ' ' || echo 0)
OUT2=$("$HELPER" --host tencent.fake --service aiko-bot 2>&1)
echo "$OUT2" | grep -q "gate 'aiko-bot-deploy' is OFF"  || { echo "FAIL P2: gate-off message missing. OUT=$OUT2"; exit 1; }
echo "$OUT2" | grep -q "result: SKIP (gate off)"        || { echo "FAIL P2: no SKIP result. OUT=$OUT2"; exit 1; }
SSH_LOG_AFTER=$([ -f "$TD/ssh.log" ] && wc -l < "$TD/ssh.log" | tr -d ' ' || echo 0)
[ "$SSH_LOG_AFTER" = "$SSH_LOG_BEFORE" ] || { echo "FAIL P2: gate-off still called ssh ($SSH_LOG_BEFORE → $SSH_LOG_AFTER)"; exit 1; }
LEDGER_AFTER=$([ -f "$CONTRACTS_STORE" ] && wc -l < "$CONTRACTS_STORE" | tr -d ' ' || echo 0)
[ "$LEDGER_AFTER" = "$LEDGER_BEFORE" ]   || { echo "FAIL P2: gate-off wrote a ledger row"; exit 1; }

# === Phase 3: turn the toggle ON, redeploy passes (stub ssh+curl both exit 0) ===
"$CLI" toggle aiko-bot-deploy on > /dev/null
OUT3=$("$HELPER" --host tencent.fake --service aiko-bot --probe https://api.example/getMe 2>&1)
echo "$OUT3" | grep -q "result: PASS"                   || { echo "FAIL P3: redeploy didn't PASS. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "host=tencent.fake"              || { echo "FAIL P3: host not in result line. OUT=$OUT3"; exit 1; }
echo "$OUT3" | grep -q "service=aiko-bot"               || { echo "FAIL P3: service not in result line. OUT=$OUT3"; exit 1; }
# ssh + curl stubs both fired exactly once
SSH_CALLS=$(wc -l < "$TD/ssh.log" | tr -d ' ')
CURL_CALLS=$(wc -l < "$TD/curl.log" | tr -d ' ')
[ "$SSH_CALLS" = "1" ]  || { echo "FAIL P3: expected 1 ssh call, got $SSH_CALLS"; exit 1; }
[ "$CURL_CALLS" = "1" ] || { echo "FAIL P3: expected 1 curl call, got $CURL_CALLS"; exit 1; }
grep -q "tencent.fake" "$TD/ssh.log"                    || { echo "FAIL P3: ssh stub didn't receive host arg"; exit 1; }
grep -q "https://api.example/getMe" "$TD/curl.log"      || { echo "FAIL P3: curl stub didn't receive probe URL"; exit 1; }

# === Phase 4: ssh_redeploy ledger row appended with expected fields ===
HAS_ROW=$(python3 -c "
import json
rows = [json.loads(line) for line in open('$CONTRACTS_STORE')]
matches = [r for r in rows if r.get('event') == 'ssh_redeploy']
if not matches: print('FAIL: no ssh_redeploy row'); exit(0)
r = matches[-1]
ok = (r.get('host') == 'tencent.fake' and r.get('service') == 'aiko-bot' and
      r.get('gate') == 'aiko-bot-deploy' and r.get('restart_rc') == 0 and r.get('probe_rc') == 0)
print('OK' if ok else f'FAIL: {r}')
")
[ "$HAS_ROW" = "OK" ] || { echo "FAIL P4: ssh_redeploy row wrong: $HAS_ROW"; exit 1; }

# === Phase 5: probe failure surfaces as FAIL + non-zero exit ===
rm -f "$TD/ssh.log" "$TD/curl.log"
export CURL_STUB_RC=22  # curl exit 22 = HTTP error
set +e
OUT5=$("$HELPER" --host tencent.fake --service aiko-bot --probe https://api.example/getMe 2>&1)
RC5=$?
set -e
unset CURL_STUB_RC
[ "$RC5" = "1" ] || { echo "FAIL P5: probe failure exited $RC5, expected 1"; exit 1; }
echo "$OUT5" | grep -q "result: FAIL"          || { echo "FAIL P5: no FAIL line. OUT=$OUT5"; exit 1; }
echo "$OUT5" | grep -q "probe_rc:   22"        || { echo "FAIL P5: probe_rc not surfaced. OUT=$OUT5"; exit 1; }

# === Phase 6: restart failure surfaces as FAIL with restart_rc ===
rm -f "$TD/ssh.log" "$TD/curl.log"
export SSH_STUB_RC=255  # ssh connection error
set +e
OUT6=$("$HELPER" --host tencent.fake --service aiko-bot --probe https://api.example/getMe 2>&1)
RC6=$?
set -e
unset SSH_STUB_RC
[ "$RC6" = "1" ] || { echo "FAIL P6: restart failure exited $RC6, expected 1"; exit 1; }
echo "$OUT6" | grep -q "restart_rc: 255"       || { echo "FAIL P6: restart_rc not surfaced. OUT=$OUT6"; exit 1; }

echo "PASS: ssh-redeploy gate — missing args→exit 2, gate-off SKIP without ssh or ledger row, gate-on calls ssh+curl exactly once each + appends ssh_redeploy row with host/service/gate/restart_rc/probe_rc, probe failure → FAIL+exit 1 + probe_rc surfaced, restart failure → FAIL+exit 1 + restart_rc surfaced"
