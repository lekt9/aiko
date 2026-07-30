#!/bin/bash
# ARC-AGI-3 F3 regression: a parent must inherit a PURGED child's death.
#
# THE LOST SHEEP (fork F3). A neuron/funnel parent inherits a child's death via
# isDead. isDead was blind to `purged` (recognized only `died`), so a child that
# was satisfied-then-purged was neither dead (isDead blind) nor satisfied
# (isSatisfied nulls it) → the parent HELD FOREVER. Day 5 routed isDead through
# the terminal authority (terminal.nullifies = dead||purged); now purge inherits.
#
# Construction mirrors the reproduction: hand-write a single declared row per
# contract (parent_id links the child to the parent), so the resolver sees the
# child as the parent's child — NOT arc_declare, which would leave the child a
# rootless second declared row. Child is a CHILDLESS neuron so re-resolution
# yields `hold`, not a real executor that the Decalogue apoptoses into a genuine
# `died` row (which would make isDead true via the OTHER path and mask the bug).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

echo "=== ARC-AGI-3 F3: parent inherits a purged child's death ==="
arc_init

P=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
C=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
TS='2026-07-14T00:00:00Z'
# Parent neuron (root); child neuron linked by parent_id; child satisfied then PURGED.
{
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$P\",\"plan\":\"parent neuron\",\"action\":\"neuron\",\"parent_id\":null,\"ts\":\"$TS\"}"
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$C\",\"plan\":\"child\",\"action\":\"neuron\",\"parent_id\":\"$P\",\"ts\":\"$TS\"}"
  printf '%s\n' "{\"event\":\"satisfied\",\"id\":\"$C\",\"wave\":1,\"action_exit\":0,\"action_result\":\"CHILDVAL\",\"ts\":\"$TS\"}"
  printf '%s\n' "{\"event\":\"purged\",\"id\":\"$C\",\"wave\":2,\"commandment\":1,\"ts\":\"2026-07-14T00:00:02Z\"}"
} >> "$ARC_LEDGER"
echo "parent  $P   child $C = satisfied-then-PURGED (no died row)"

# Drive the backfill sweep over the unresolved parent.
"$ARC_AIKO" 'trigger backfill sweep' --private >/dev/null 2>"$ARC_EV" || true

# The parent must inherit death (a died row, or a result naming the inherited
# death) and must NOT be stuck at hold/fail. A control-free check: purge is the
# only terminal on the child, so any parent death here can only come from
# isDead recognizing `purged`.
if arc_is_satisfied "$P"; then
  echo "FAIL: parent $P resolved satisfied over a purged child (should inherit death)"
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
    if "inherit" in blob or "child_dead" in blob or "stage_dead" in blob: inherited = True
print("yes" if (died or inherited) else "no")
PY
)
if [ "$inherited" != "yes" ]; then
  echo "FAIL: parent $P did NOT inherit the purged child's death — held forever (fork F3)"
  exit 1
fi
echo "PASS: parent inherited the purged child's death — isDead routes through the one terminal authority"
