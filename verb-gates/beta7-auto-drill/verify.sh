#!/bin/bash
# Β7 auto-drill-gaps hook gate: marking an organ root fires
# ~/.contracts/hooks/auto-drill-gaps.sh which spawns drill children for open gaps.
set -e
[ -x ~/.contracts/hooks/auto-drill-gaps.sh ] || { echo "FAIL: hook missing"; exit 1; }
[ -x ~/.claude/skills/aiko/scripts/aiko ] || { echo "FAIL: aiko CLI missing"; exit 1; }
# the hook contract: fires only on mark + RC=0 + organ-root + only once per session via env guard
grep -q 'CONTRACT_AUTODRILL_FIRED' ~/.contracts/hooks/auto-drill-gaps.sh || { echo "FAIL: no recursion guard"; exit 1; }
grep -q 'parent_id' ~/.contracts/hooks/auto-drill-gaps.sh || { echo "FAIL: no organ-root check"; exit 1; }
grep -q 'aiko drill-gaps' ~/.contracts/hooks/auto-drill-gaps.sh || { echo "FAIL: doesn't call aiko drill-gaps"; exit 1; }
# live test: mark a leaf (which should NOT fire — has parent), then mark its root (should fire)
TMP=$(mktemp -d); export CONTRACTS_STORE="$TMP/s.jsonl"
C=~/.claude/skills/contract/scripts/contract
ROOT=$($C declare "beta7 organ root probe" --action funnel --no-drive 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
LEAF=$($C declare "beta7 leaf probe" --action "true" --parent "$ROOT" 2>/dev/null | grep -Eo '\b[a-f0-9]{8}\b' | head -1)
$C iterate "$LEAF" >/dev/null 2>&1
# spy hook BEFORE marks
SPY=~/.contracts/hooks/zz-beta7-spy-$$.sh
echo '#!/bin/bash' > $SPY
echo '[ "$1" = "mark" ] && echo "spy-saw-mark-$2" >> /tmp/beta7-spy.log' >> $SPY
chmod +x $SPY
rm -f /tmp/beta7-spy.log
# mark leaf (should NOT trigger autodrill since it has a parent)
$C _mark "$LEAF" satisfied --proof "leaf test" >/dev/null 2>&1
sleep 1
# mark root (organ root: parent_id is None; should trigger autodrill)
$C _mark "$ROOT" satisfied --proof "root test" >/dev/null 2>&1
sleep 2
rm -f $SPY
# both marks fired (spy saw both)
grep -q "spy-saw-mark-$LEAF" /tmp/beta7-spy.log && grep -q "spy-saw-mark-$ROOT" /tmp/beta7-spy.log || { echo "FAIL: spy didn't see both marks"; cat /tmp/beta7-spy.log; exit 1; }
echo "PASS: Β7 hook present, guarded, fires on organ-root marks via bus"
