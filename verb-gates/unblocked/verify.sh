#!/usr/bin/env bash
# verb-gate: unblocked (Ω1) — HOLD verdicts with typed blockers re-surface
# when the blocker satisfies. End-to-end: judge writes a `judged` event row
# with `blocked_by`; _mark satisfied on the blocker surfaces UNBLOCK-REWAKE;
# `contract unblocked` lists every now-actionable rejudge candidate.
#
# Catches regressions where:
#   - judge doesn't record blocker ids → unblock surface never fires
#   - propagation skips judged-HOLD scan → wavefront forgets dependents
#   - `unblocked` lists wrong rows (waiting ones leak into ready, or vice versa)
#   - already-satisfied contracts spuriously surface (idempotency)
set -euo pipefail

REAL_HOME="$HOME"
CLI="$REAL_HOME/.claude/skills/contract/scripts/contract"
[ -f "$CLI" ] || { echo "FAIL: cannot locate contract CLI at $CLI"; exit 1; }

TD=$(mktemp -d)
trap 'rm -rf "$TD"; jobs -p | xargs -r kill 2>/dev/null' EXIT
export HOME="$TD"
export CONTRACTS_STORE="$TD/contracts.jsonl"
export CONTRACT_LLM_VIA=codex
export PATH="$TD/shim:$PATH"

# Mock codex shim — verdict line + reason text we control via env files
mkdir -p "$TD/shim"
cat > "$TD/shim/codex" <<'SHIM'
#!/usr/bin/env bash
set -e
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in --output-last-message) OUT="$2"; shift 2 ;; *) shift ;; esac
done
if [ -n "$OUT" ] && [ -f "${CODEX_NEXT_OUTPUT:-/tmp/none}" ]; then
  cp "$CODEX_NEXT_OUTPUT" "$OUT"
fi
cat >/dev/null
exit 0
SHIM
chmod +x "$TD/shim/codex"

# Declare the blocker contract Y (a simple cell)
Y=$("$CLI" declare "blocker Y: must hold first" --action "true" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
[ -n "$Y" ] || { echo "FAIL: blocker Y declare empty"; exit 1; }
"$CLI" iterate "$Y" >/dev/null 2>&1

# Declare the dependent contract X
X=$("$CLI" declare "dependent X: blocked by Y" --action "agent-judges" --no-drive 2>&1 \
  | grep -oE "declared: [a-f0-9]{8}" | awk '{print $2}' | head -1)
"$CLI" iterate "$X" >/dev/null 2>&1

# === Phase 1: judge X as HOLD with reason naming Y as blocker ===
OUTFILE="$TD/codex_out.txt"
printf 'HOLD\nblocked on %s — waiting for blocker Y to satisfy first\n' "$Y" > "$OUTFILE"
CODEX_NEXT_OUTPUT="$OUTFILE" "$CLI" judge "$X" >/dev/null 2>&1 || true

# Verify the judged event row was written with blocked_by populated
python3 -c "
import json, sys
rows = [json.loads(l) for l in open('$CONTRACTS_STORE') if l.strip()]
jrows = [r for r in rows if r.get('event') == 'judged' and r.get('id') == '$X']
assert jrows, 'no judged row for X'
last = jrows[-1]
assert last.get('verdict') == 'HOLD', f'verdict not HOLD: {last.get(\"verdict\")}'
assert '$Y' in (last.get('blocked_by') or []), f'Y not in blocked_by: {last.get(\"blocked_by\")}'
" || { echo "FAIL: judge didn't record blocked_by Y for X"; exit 1; }

# === Phase 2: contract unblocked shows X under WAITING (Y not yet satisfied) ===
OUT_WAIT=$("$CLI" unblocked 2>&1)
echo "$OUT_WAIT" | grep -q "STILL WAITING"     || { echo "FAIL: WAITING section missing. OUT=$OUT_WAIT"; exit 1; }
echo "$OUT_WAIT" | grep -q "$X"                || { echo "FAIL: X not in WAITING. OUT=$OUT_WAIT"; exit 1; }
echo "$OUT_WAIT" | grep -q "(no HOLD/REJECT"   || echo "$OUT_WAIT" | grep -q "🔓 $X" && {
  # If X already showed as ready, that's wrong — Y isn't satisfied
  if echo "$OUT_WAIT" | grep -q "🔓 $X"; then
    echo "FAIL: X showed as ready before Y satisfied"; exit 1
  fi
}

# === Phase 3: satisfy Y — propagation block should surface X as UNBLOCK-REWAKE ===
OUT_MARK=$("$CLI" _mark "$Y" satisfied --proof "blocker Y resolved for unblock-rewake test" 2>&1)
echo "$OUT_MARK" | grep -q "Ω1 UNBLOCK-REWAKE" || { echo "FAIL: UNBLOCK-REWAKE block missing on Y satisfy. OUT=$OUT_MARK"; exit 1; }
echo "$OUT_MARK" | grep -q "🔓 $X"             || { echo "FAIL: X not surfaced as unblocked. OUT=$OUT_MARK"; exit 1; }
echo "$OUT_MARK" | grep -q "contract judge $X" || { echo "FAIL: re-judge hint missing for X"; exit 1; }

# === Phase 4: contract unblocked shows X under READY now ===
OUT_READY=$("$CLI" unblocked 2>&1)
echo "$OUT_READY" | grep -q "Ω1 UNBLOCKED"     || { echo "FAIL: UNBLOCKED header missing"; exit 1; }
echo "$OUT_READY" | grep -q "🔓 $X"            || { echo "FAIL: X not in ready list. OUT=$OUT_READY"; exit 1; }
echo "$OUT_READY" | grep -q "blocker $Y"       || { echo "FAIL: blocker linkage missing"; exit 1; }

# === Phase 5: --json output is parseable + has ready list with X ===
OUT_JSON=$("$CLI" unblocked --json 2>&1)
echo "$OUT_JSON" | python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ready_ids = [r['id'] for r in d.get('ready', [])]
assert '$X' in ready_ids, f'X not in ready: {ready_ids}'
" || { echo "FAIL: --json didn't list X as ready"; exit 1; }

# === Phase 6: idempotency — satisfying X removes it from ready (no longer pending) ===
"$CLI" _mark "$X" satisfied --proof-skip "test: X done after Y unblocked" >/dev/null 2>&1
OUT_DONE=$("$CLI" unblocked 2>&1)
echo "$OUT_DONE" | grep -q "🔓 $X" && { echo "FAIL: X still listed after being satisfied"; exit 1; } || true

echo "PASS: unblocked gate (Ω1) — judge records blocked_by ids, mark-satisfied surfaces UNBLOCK-REWAKE on dependents, contract unblocked separates ready/waiting, --json parseable, idempotent on dependent satisfy"
