#!/usr/bin/env bash
# run-audits.sh — walks every audits/<rule>/verify.sh and runs it in
# turn. The substrate enables (a uniform runner); each rule's verify.sh
# carries the actual check. Wired into scripts/skill-self-test.sh so
# every ledger event re-runs every rule's corpus audit.
set -uo pipefail

SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/contract}"
AUDITS_DIR="$SKILL_DIR/audits"

if [ ! -d "$AUDITS_DIR" ]; then
  echo "no audits dir at $AUDITS_DIR — vacuously OK"
  exit 0
fi

found=0
failed=0
for rule_dir in "$AUDITS_DIR"/*/; do
  [ -d "$rule_dir" ] || continue
  rule="$(basename "$rule_dir")"
  verify="$rule_dir/verify.sh"
  if [ ! -x "$verify" ]; then
    echo "  audits/$rule: SKIP (no executable verify.sh)"
    continue
  fi
  found=$((found + 1))
  echo "═════════════════════════════════════════════════════════"
  echo "audits/$rule"
  echo "─────────────────────────────────────────────────────────"
  if /bin/bash "$verify"; then
    echo "  audits/$rule: PASS"
  else
    echo "  audits/$rule: FAIL — run audits/$rule/fix.sh"
    failed=$((failed + 1))
  fi
done

echo
echo "run-audits: $found rule(s) checked, $failed failing"
[ "$failed" -eq 0 ]
