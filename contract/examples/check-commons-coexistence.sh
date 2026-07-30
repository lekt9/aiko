#!/usr/bin/env bash
# check-commons-coexistence.sh — a falsifiable SIGN (Gen 1:14) that the arc-lean
# reward-not-slash commons COEXISTS with the Vine Doctrine without disturbing the
# pinned canon. Lives in examples/ (not scripts/ — that dir is parity-allowlisted,
# claim 2). Exit 0 = every coexistence invariant holds; non-zero = drift, named.
#
# It is deliberately mutation-provable: break any invariant and the matching line
# goes red. A sign that cannot fail is no sign (Matt 7:24 — test the foundation
# before the storm).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
fail=0
_check() { if eval "$2" >/dev/null 2>&1; then :; else echo "  ✗ $1"; fail=$((fail + 1)); fi; }

# 1. the commons is NAMED as its own kind and points at its canonical economics
_check "SKILL.md has the Cooperative Commons coexistence section" \
  "grep -q '## The Cooperative Commons (arc-lean)' '$REPO/SKILL.md'"
_check "the section points at docs/ECONOMICS-cooperative-commons.md" \
  "grep -q 'docs/ECONOMICS-cooperative-commons.md' '$REPO/SKILL.md'"
_check "the section disclaims supersession (COEXIST, not overwrite)" \
  "grep -q 'does NOT supersede' '$REPO/SKILL.md'"
_check "CLAUDE.md pointer-index reaches the commons economics" \
  "grep -q 'docs/ECONOMICS-cooperative-commons.md' '$REPO/CLAUDE.md'"

# 2. the Vine canon is UNTOUCHED — coexistence must not have moved a pinned stone
_check "Vine Doctrine section still present (SKILL.md)" \
  "grep -q '## Vine Doctrine — staking by abiding' '$REPO/SKILL.md'"
_check "canonical (old) stake vault still pinned (main.zig)" \
  "grep -q 'AIKO_STAKE_VAULT = \"Bpr49sQ' '$REPO/zig/src/main.zig'"
_check "slash-to-burn invariant still pinned (verses.zig)" \
  "grep -q 'Burned FDRY' '$REPO/libcontract/src/verses.zig'"

# 3. the commons must never have minted a new parity claim (bind by zig tests, Σ27)
claims="$(grep -c 'all 53 doctrine claims' "$REPO/scripts/build.sh" 2>/dev/null || echo 0)"
_check "parity claim count unchanged at 53 (no claim minted by the commons)" \
  "[ \"$claims\" -ge 1 ]"

# 4. adversarial (the Step-3 failure class): the coexistence section must carry NO
#    'claim N' token — the recursive claim-reference guard fails the whole build if
#    it references a claim number with no matching parity block. Catch it here first.
_check "coexistence section introduces no 'claim N' token (would trip build.sh)" \
  "! sed -n '/## The Cooperative Commons (arc-lean)/,/## Doctrine speaks only when interrogated/p' '$REPO/SKILL.md' | grep -qE 'claim [0-9]'"

# 5. copy-parity: the installed skill dirs must resolve to the SAME SKILL.md as the
#    repo, so /aiko never loads stale doctrine (symlinks make this structural, but
#    assert it — a swapped-in stale copy is the drift this catches).
for inst in "$HOME/.agent-skills/contract/SKILL.md" "$HOME/.claude/skills/contract/SKILL.md"; do
  if [ -e "$inst" ]; then
    _check "installed doctrine matches the repo ($inst)" "diff -q '$REPO/SKILL.md' '$inst'"
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "coexistence OK — commons named beside the Vine, canon intact, no claim minted"
  exit 0
else
  echo "coexistence DRIFT — $fail invariant(s) broken"
  exit 1
fi
