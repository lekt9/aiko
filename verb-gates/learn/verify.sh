#!/usr/bin/env bash
# verb-gate: learn — crystallizes an insight into a memory file + Outline doc.
# Proves:
#   1. learn writes a learned row to the ledger
#   2. learn writes a memory file under the Claude Code memory folder
#   3. Outline push is opt-out via CONTRACT_CRYSTALLIZE_NO_OUTLINE=1 (no network needed for the gate)
set -uo pipefail
C="$HOME/.claude/skills/contract/scripts/contract"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Sandbox: redirect HOME so memory writes go to the tempdir, not the real one.
export HOME="$TMP/home"
mkdir -p "$HOME/.claude/projects" "$HOME/.contracts"
# Re-resolve ledger inside the sandbox
export CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl"
export CONTRACT_CRYSTALLIZE_NO_OUTLINE=1

INSIGHT="verb-gate test insight $$"
OUT=$(bash "$C" learn "$INSIGHT" --source "verb-gate" 2>&1)

# 1. learned row in ledger
grep -q "\"event\": \"learned\"" "$CONTRACTS_STORE" \
  || { echo "FAIL: no learned row in ledger"; echo "$OUT"; cat "$CONTRACTS_STORE" 2>/dev/null || true; exit 1; }
echo "evidence: learned row appended to ledger  OK"

# 2. memory file under sandboxed HOME/.claude (the crystallize hook writes there)
N_FILES=$(find "$HOME/.claude" -name "*.md" -newer "$TMP" 2>/dev/null | wc -l | tr -d ' ')
if [ "$N_FILES" -lt 1 ]; then
  # also accept memory under a projects subdir
  N_FILES=$(find "$HOME" -path "*.claude*" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
fi
[ "$N_FILES" -ge 1 ] || { echo "FAIL: no memory file written under sandboxed HOME"; echo "$OUT"; exit 1; }
echo "evidence: $N_FILES memory file(s) written under sandboxed HOME  OK"

# 3. Outline opt-out honored — output must not show a successful outline push (URL)
echo "$OUT" | grep -qiE "outline:.*https?://" && {
  echo "FAIL: Outline push happened despite CONTRACT_CRYSTALLIZE_NO_OUTLINE=1"
  echo "$OUT"
  exit 1
}
echo "evidence: Outline push skipped under opt-out env var  OK"

echo "PASS: learn — ledger row + memory file; Outline opt-out honored."
exit 0
