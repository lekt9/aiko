#!/usr/bin/env bash
# verb-gate: stale — apoptosis primitive. Proves:
#   1. happy path: a satisfied contract older than --since surfaces in the report
#   2. fresh contracts (younger than --since) do NOT surface
#   3. --json emits valid structured output with 'count' and 'stale' fields
#   4. invalid --since string is refused with non-zero exit (not silently treated as 0)
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export CONTRACTS_STORE="$TMP/ledger.jsonl"

# 1. declare + satisfy two contracts; backdate one in the ledger to simulate age.
OLD=$(bash "$C" declare "stalegate old contract" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
NEW=$(bash "$C" declare "stalegate fresh contract" --action true --no-drive 2>/dev/null | awk '/^declared:/{print $2}')
[ -n "$OLD" ] && [ -n "$NEW" ] || { echo "FAIL: declare"; exit 1; }
bash "$C" _mark "$OLD" satisfied --proof "test backdate" >/dev/null 2>&1
bash "$C" _mark "$NEW" satisfied --proof "test fresh" >/dev/null 2>&1

# Rewrite the OLD contract's satisfied row to a ts 30 days in the past.
python3 - "$CONTRACTS_STORE" "$OLD" <<'PY'
import json, sys
from datetime import datetime, timezone, timedelta
path, target_id = sys.argv[1], sys.argv[2]
old_ts = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat().replace('+00:00','Z')
out = []
for line in open(path).read().splitlines():
    if not line.strip(): continue
    r = json.loads(line)
    if r.get('event') == 'satisfied' and r.get('id') == target_id:
        r['ts'] = old_ts
    out.append(json.dumps(r))
open(path, 'w').write('\n'.join(out) + '\n')
PY

# 2. stale --since 7d should surface OLD but not NEW
OUT=$(bash "$C" stale --since 7d 2>&1)
echo "$OUT" | grep -q "$OLD" || { echo "FAIL: 30-day-old satisfied row not surfaced by stale --since 7d"; echo "$OUT"; exit 1; }
if echo "$OUT" | grep -q "$NEW"; then
  echo "FAIL: fresh satisfied row incorrectly surfaced by stale --since 7d"; echo "$OUT"; exit 1
fi
echo "evidence: old satisfied row surfaces, fresh does not  OK"

# 3. --json emits structured output
JSON=$(bash "$C" stale --since 7d --json 2>&1)
echo "$JSON" | python3 -c "
import sys, json
r = json.load(sys.stdin)
assert 'stale' in r and 'count' in r and 'since' in r, f'missing field: {list(r.keys())}'
assert r['count'] >= 1, f'count should be >= 1, got {r[\"count\"]}'
ids = [x['id'] for x in r['stale']]
assert '$OLD' in ids, f'$OLD not in stale ids: {ids}'
" || { echo "FAIL: --json output malformed"; echo "$JSON"; exit 1; }
echo "evidence: --json emits {since,count,stale} with the stale id  OK"

# 4. invalid --since refused
set +e
ERR_OUT=$(bash "$C" stale --since "not-a-duration" 2>&1)
EC=$?
set -e
if [ "$EC" -eq 0 ]; then
  echo "FAIL: invalid --since silently accepted (exit 0)"; echo "$ERR_OUT"; exit 1
fi
echo "evidence: invalid --since rejected (exit $EC)  OK"

echo "PASS: stale — surfaces aged satisfied contracts, ignores fresh, structured --json, refuses bad --since."
exit 0
