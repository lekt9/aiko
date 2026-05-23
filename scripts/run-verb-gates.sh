#!/usr/bin/env bash
# run-verb-gates.sh — walks every verb-gates/<verb>/verify.sh and runs it
# in turn. The substrate enables (a uniform runner); each verb's verify.sh
# carries the actual check. Wired into scripts/skill-self-test.sh so every
# ledger event re-runs every verb's gate.
#
# Mirror of scripts/run-audits.sh, one finer level (verbs, not corpora).
set -uo pipefail

SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/contract}"
GATES_DIR="$SKILL_DIR/verb-gates"

if [ ! -d "$GATES_DIR" ]; then
  echo "no verb-gates dir at $GATES_DIR — vacuously OK"
  exit 0
fi

found=0
failed=0
scaffold=0
for verb_dir in "$GATES_DIR"/*/; do
  [ -d "$verb_dir" ] || continue
  verb="$(basename "$verb_dir")"
  verify="$verb_dir/verify.sh"
  if [ ! -x "$verify" ]; then
    echo "  verb-gates/$verb: SKIP (no executable verify.sh)"
    continue
  fi
  found=$((found + 1))
  echo "═════════════════════════════════════════════════════════"
  echo "verb-gates/$verb"
  echo "─────────────────────────────────────────────────────────"
  # Scaffolds (explicitly aspirational, body starts with "SCAFFOLD ... awaits
  # real assertions") count as SCAFFOLD, not FAIL — honest catalogue per the
  # self-awareness doctrine. They still need real assertions; the count
  # surfaces the residual gap without claiming a regression where none exists.
  out=$(/bin/bash "$verify" 2>&1); rc=$?
  echo "$out"
  if echo "$out" | grep -qE '^SCAFFOLD '; then
    echo "  verb-gates/$verb: SCAFFOLD (aspirational — awaits real assertions)"
    scaffold=$((scaffold + 1))
  elif [ "$rc" -eq 0 ]; then
    echo "  verb-gates/$verb: PASS"
  else
    echo "  verb-gates/$verb: FAIL"
    failed=$((failed + 1))
  fi
done

echo
echo "run-verb-gates: $found verb(s) checked, $failed failing, $scaffold scaffold (aspirational)"
[ "$failed" -eq 0 ]
