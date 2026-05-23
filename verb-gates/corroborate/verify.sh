#!/usr/bin/env bash
# verb-gate: corroborate — creates a synapse between two contracts.
# Proves:
#   1. corroborate writes a synapse-shaped event (corroborated/synapse) with both ids
#   2. corroborate on missing ids errors (substrate principle: never silent)
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CONTRACTS_STORE="$TMP/ledger.jsonl"

A=$(bash "$C" declare "corroborate_gate A" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
B=$(bash "$C" declare "corroborate_gate B" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$A" ] && [ -n "$B" ] || { echo "FAIL: could not declare both contracts"; exit 1; }

bash "$C" corroborate "$A" "$B" --label "verb-gate test" >/dev/null 2>&1

# 1. ledger contains a synapse-shaped row referencing both
# (Event name varies — corroborated / synapse / synapse_added — accept any of them with both ids)
python3 - "$CONTRACTS_STORE" "$A" "$B" <<'PY' || exit 1
import json, sys
ledger, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
found = False
for line in open(ledger):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except json.JSONDecodeError:
        continue
    ev = r.get('event', '')
    if 'corroborat' in ev or 'synapse' in ev:
        s = json.dumps(r)
        if a in s and b in s:
            found = True
            break
if not found:
    print("FAIL: no corroborate/synapse row referencing both ids")
    sys.exit(1)
print("evidence: corroborate event references both ids  OK")
PY

# 2. corroborate on unknown id must error
set +e
OUT=$(bash "$C" corroborate "ghost_id_xyz" "$B" 2>&1)
EC=$?
set -e
echo "$OUT" | grep -qiE "not found|error|ERROR" || [ "$EC" -ne 0 ] \
  || { echo "FAIL: corroborate on unknown id did not error"; echo "$OUT"; exit 1; }
echo "evidence: corroborate on unknown id errors  OK"

echo "PASS: corroborate — synapse event written between two real ids; unknown ids rejected."
exit 0
