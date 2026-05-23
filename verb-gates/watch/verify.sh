#!/usr/bin/env bash
# verb-gate: watch (Ψ4) — async watcher closes the loop between an external
# condition and a dependent /contract. Register a probe; tick runs the probe
# on a wall-clock interval; on probe-PASS the substrate auto-iterates the
# contract, writes an inbox event, removes the watcher (one-shot).
#
# Composed with Ω1: the auto-iterate fires the propagation wavefront on the
# eventual mark, which re-surfaces every HOLD'd dependent for re-judgement.
# So waiting → completion → wavefront → unblocked dependent is one chain,
# triggered programmatically by external state flipping, not by the agent
# remembering to poll.
#
# Catches regressions where:
#   - register on a phantom id silently succeeds (substrate would forget)
#   - tick fires before interval elapses (busy-loops, breaks rate limits)
#   - probe-FAIL fires the contract anyway (false-witness — contract satisfies
#     even though its external condition didn't flip)
#   - probe-PASS doesn't write the inbox event (consumers can't tail)
#   - probe-PASS doesn't auto-iterate (Ω1 wavefront never fires)
#   - watcher isn't removed on fire (zombie watcher keeps polling)
#   - tick on no-probe watcher doesn't auto-iterate (the receptor-shape case)
#   - stop verb leaves watcher running
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"

# === Phase 0: register refuses on phantom id ===
OUT_PHANTOM=$("$CLI" watch deadbeef --probe "true" --interval 1 2>&1 || true)
echo "$OUT_PHANTOM" | grep -q "contract deadbeef not found" \
  || { echo "FAIL: register on phantom id didn't refuse. OUT=$OUT_PHANTOM"; exit 1; }

# === Phase 1: register against a real contract ===
SENTINEL="$TD/sentinel"
T=$("$CLI" declare "external thing we wait for" --action "test -f $SENTINEL" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$T" ] || { echo "FAIL: declare empty"; exit 1; }

"$CLI" watch "$T" --probe "test -f $SENTINEL" --interval 1 >/dev/null 2>&1 \
  || { echo "FAIL: watch register exited non-zero"; exit 1; }
[ -f "$TD/.contracts/watchers/$T.json" ] \
  || { echo "FAIL: watcher state file not created"; exit 1; }

# === Phase 2: list shows the watcher ===
OUT_LIST=$("$CLI" watch list 2>&1)
echo "$OUT_LIST" | grep -q "$T"             || { echo "FAIL: watch list missing id. OUT=$OUT_LIST"; exit 1; }
echo "$OUT_LIST" | grep -q "every 1s"       || { echo "FAIL: watch list missing interval. OUT=$OUT_LIST"; exit 1; }

OUT_JSON=$("$CLI" watch list --json 2>&1)
echo "$OUT_JSON" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
assert d['count'] == 1, f'count={d[\"count\"]}'
assert d['watchers'][0]['contract_id'] == '$T'
assert d['watchers'][0]['interval_s'] == 1
" || { echo "FAIL: --json shape wrong"; exit 1; }

# === Phase 3: tick with probe-FAIL does NOT fire ===
OUT_TICK1=$("$CLI" watch tick --verbose 2>&1)
echo "$OUT_TICK1" | grep -q "exit 1"         || { echo "FAIL: probe-FAIL tick didn't log exit 1. OUT=$OUT_TICK1"; exit 1; }
echo "$OUT_TICK1" | grep -qE "fired=0"       || { echo "FAIL: probe-FAIL still showed fired>0. OUT=$OUT_TICK1"; exit 1; }
[ -f "$TD/.contracts/watchers/$T.json" ]    || { echo "FAIL: watcher removed on probe-FAIL (should persist)"; exit 1; }
[ ! -f "$TD/.contracts/inbox/watcher/$T.jsonl" ] \
  || { echo "FAIL: inbox event written on probe-FAIL (false witness!)"; exit 1; }

# === Phase 4: tick within interval is skipped ===
OUT_SKIP=$("$CLI" watch tick --verbose 2>&1)
echo "$OUT_SKIP" | grep -qE "skipped=1"     || { echo "FAIL: tick within interval not skipped. OUT=$OUT_SKIP"; exit 1; }
echo "$OUT_SKIP" | grep -qE "polled=0"      || { echo "FAIL: tick within interval still polled. OUT=$OUT_SKIP"; exit 1; }

# === Phase 5: probe-PASS fires (auto-iterate + inbox event + watcher removed) ===
touch "$SENTINEL"
sleep 1.1   # let interval elapse
OUT_FIRE=$("$CLI" watch tick --verbose 2>&1)
echo "$OUT_FIRE" | grep -q "FIRED"          || { echo "FAIL: probe-PASS tick didn't FIRE. OUT=$OUT_FIRE"; exit 1; }
echo "$OUT_FIRE" | grep -qE "fired=1"       || { echo "FAIL: fired=1 missing. OUT=$OUT_FIRE"; exit 1; }
[ ! -f "$TD/.contracts/watchers/$T.json" ] || { echo "FAIL: watcher not removed after fire"; exit 1; }

# Inbox event is well-formed JSON with the expected fields
INBOX="$TD/.contracts/inbox/watcher/$T.jsonl"
[ -f "$INBOX" ] || { echo "FAIL: inbox event file not created"; exit 1; }
python3 -c "
import json
row = json.loads(open('$INBOX').read().strip().splitlines()[0])
assert row['event'] == 'flipped', f'event={row[\"event\"]}'
assert row['contract_id'] == '$T'
assert row['probe_exit'] == 0
assert row['attempts'] >= 1
" || { echo "FAIL: inbox event shape wrong"; exit 1; }

# The auto-iterate should have appended an iterated row to the ledger
python3 -c "
import json
rows = [json.loads(l) for l in open('$CONTRACTS_STORE') if l.strip()]
its = [r for r in rows if r.get('event')=='iterated' and r.get('id')=='$T']
assert its, 'no iterated row for $T after fire'
last = its[-1]
assert last.get('action_result') == 'pass', f'auto-iterate not PASS: {last.get(\"action_result\")}'
" || { echo "FAIL: auto-iterate didn't write a PASS row"; exit 1; }

# === Phase 6: no-probe watcher (the receptor-shape case) ===
T2=$("$CLI" declare "no-probe watcher target" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
"$CLI" watch "$T2" --interval 1 >/dev/null 2>&1
sleep 1.1
OUT_NP=$("$CLI" watch tick --verbose 2>&1)
echo "$OUT_NP" | grep -q "FIRED"            || { echo "FAIL: no-probe watcher didn't FIRE. OUT=$OUT_NP"; exit 1; }
[ ! -f "$TD/.contracts/watchers/$T2.json" ]|| { echo "FAIL: no-probe watcher not removed"; exit 1; }

# === Phase 7: stop removes the watcher without firing ===
T3=$("$CLI" declare "stop-test target" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
"$CLI" watch "$T3" --probe "false" --interval 1 >/dev/null 2>&1
[ -f "$TD/.contracts/watchers/$T3.json" ]   || { echo "FAIL: stop-test watcher not registered"; exit 1; }
"$CLI" watch stop "$T3" >/dev/null 2>&1
[ ! -f "$TD/.contracts/watchers/$T3.json" ]|| { echo "FAIL: stop didn't remove watcher"; exit 1; }
# No inbox event for stopped watcher
[ ! -f "$TD/.contracts/inbox/watcher/$T3.jsonl" ] \
  || { echo "FAIL: stop wrote a phantom inbox event"; exit 1; }

# stop on a non-existent watcher exits non-zero (no silent success)
"$CLI" watch stop deadbeef 2>/dev/null \
  && { echo "FAIL: stop on missing watcher should fail"; exit 1; } || true

echo "PASS: watch gate (Ψ4) — register refuses phantom ids, list surfaces watchers (pretty + --json), tick respects interval, probe-FAIL doesn't fire (no false-witness inbox row), probe-PASS fires (auto-iterates contract with PASS row + writes inbox event + removes watcher one-shot), no-probe watcher fires on schedule, stop cleanly removes without firing, stop on missing watcher refuses"
