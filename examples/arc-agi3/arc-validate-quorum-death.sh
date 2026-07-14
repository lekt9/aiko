#!/bin/bash
# ARC-AGI-3 F4/F5: a quorum inherits death when its threshold is UNREACHABLE.
#
# quorum never consulted isDead — it only summed isSatisfied. So a dead/purged
# child was merely "not satisfied", the quorum failed generically and re-fired
# every sweep FOREVER (never apoptosed). The fix counts dead children and
# inherits death once too few live children remain to reach `need` — preserving
# k-of-n fault tolerance (a single death must not kill a quorum that can still
# reach threshold) while ending the infinite HOLD when it provably cannot.
#
# Test: quorum:1 over ONE child; child satisfied-then-purged. 1 child, 1 dead,
# need 1 → 0 live < 1 → unreachable → parent must inherit death, not hold forever.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

echo "=== ARC-AGI-3 F4/F5: quorum inherits death when unreachable ==="
arc_init

P=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
C=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
TS='2026-07-14T00:00:00Z'
{
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$P\",\"plan\":\"quorum parent\",\"action\":\"quorum:1\",\"parent_id\":null,\"ts\":\"$TS\"}"
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$C\",\"plan\":\"child\",\"action\":\"neuron\",\"parent_id\":\"$P\",\"ts\":\"$TS\"}"
  printf '%s\n' "{\"event\":\"satisfied\",\"id\":\"$C\",\"wave\":1,\"action_exit\":0,\"action_result\":\"CHILDVAL\",\"ts\":\"$TS\"}"
  printf '%s\n' "{\"event\":\"purged\",\"id\":\"$C\",\"wave\":2,\"commandment\":1,\"ts\":\"2026-07-14T00:00:02Z\"}"
} >> "$ARC_LEDGER"
echo "quorum:1  $P   child $C = satisfied-then-PURGED (0 live, threshold unreachable)"

"$ARC_AIKO" 'trigger backfill sweep' --private >/dev/null 2>"$ARC_EV" || true

if arc_is_satisfied "$P"; then
  echo "FAIL: quorum $P resolved satisfied with a purged (dead) sole child"
  exit 1
fi
inherited=$(python3 - "$ARC_LEDGER" "$P" <<'PY'
import sys, json
path, pid = sys.argv[1], sys.argv[2]
died = inherited = False
for line in open(path):
    try: r = json.loads(line)
    except Exception: continue
    if r.get("id") != pid: continue
    if r.get("event") == "died": died = True
    blob = ((r.get("action_result") or "") + " " + (r.get("result") or "")).lower()
    if "child_dead" in blob or "inherit" in blob: inherited = True
print("yes" if (died or inherited) else "no")
PY
)
if [ "$inherited" != "yes" ]; then
  echo "FAIL: quorum $P did NOT inherit death — held forever with an unreachable threshold (F4)"
  exit 1
fi
echo "PASS: quorum inherited death when its threshold became unreachable"
