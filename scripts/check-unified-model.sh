#!/usr/bin/env bash
# check-unified-model.sh — guard the action-vs-composition split named in
# SKILL.md's "Everything is stdio" section against drift between the
# documented surfaces and the implementing code.
#
# Catches the failure modes:
#   A. SKILL.md says some action shape exists, no implementing surface on disk
#   B. SKILL.md says some composition shape exists, no implementing case in
#      scripts/contract (so iterate on that action would silently fall through)
#   C. The two tables drift apart — an action listed in the composition table
#      or vice versa.
set -uo pipefail
SKILL="$HOME/.claude/skills/contract/SKILL.md"
CLI="$HOME/.claude/skills/contract/scripts/contract"
SKILL_DIR="$HOME/.claude/skills/contract"
fail=0

# Verify the section exists at all
grep -q '^## Everything is stdio (the unified model)' "$SKILL" || {
  echo "FAIL: SKILL.md missing 'Everything is stdio (the unified model)' section" >&2
  exit 1
}

# Action shapes — each must have an implementing surface
# (gate dir, helper script, or named action prefix the CLI understands)
declare -a ACTION_SHAPES=(cell judgment loop harness tool-guard)
for shape in "${ACTION_SHAPES[@]}"; do
  if [ ! -d "$SKILL_DIR/$shape-gate" ]; then
    echo "FAIL: action shape '$shape' named in unified-model section has no $shape-gate/ dir" >&2
    fail=$((fail+1))
  fi
done

# Receptor needs wait-for-event.py
[ -f "$SKILL_DIR/scripts/wait-for-event.py" ] || {
  echo "FAIL: receptor surface needs scripts/wait-for-event.py (named in unified-model section)" >&2
  fail=$((fail+1))
}

# Stream surface needs the 'tail' verb wired
grep -q '^  tail)' "$CLI" || {
  echo "FAIL: stream surface needs 'contract tail' verb (named in unified-model section)" >&2
  fail=$((fail+1))
}

# Composition shapes — each must have an implementing case branch in the CLI
# (the iterator dispatches on the action string; the cases live in the
# dispatch_iterate / record_iteration paths)
declare -a COMPOSITION_SHAPES=(funnel funnel-first sequence quorum)
CORE="$SKILL_DIR/scripts/lib/contract_core.py"
for shape in "${COMPOSITION_SHAPES[@]}"; do
  case "$shape" in
    quorum)  # quorum:K — match the prefix
      if ! grep -qE "['\"]quorum:|quorum:K|quorum:<K>" "$CORE" "$CLI" 2>/dev/null; then
        echo "FAIL: composition shape 'quorum' named in unified-model section but no implementing match in CLI/core" >&2
        fail=$((fail+1))
      fi
      ;;
    *)
      if ! grep -qE "['\"]$shape['\"]" "$CORE" "$CLI" 2>/dev/null; then
        echo "FAIL: composition shape '$shape' named in unified-model section but no string match in CLI/core" >&2
        fail=$((fail+1))
      fi
      ;;
  esac
done

# contract:<id> resolver — composition pointer
grep -qE "contract:[a-f0-9]|contract:<id>" "$CORE" "$CLI" 2>/dev/null || {
  echo "FAIL: 'contract:<id>' pointer named in unified-model section but no resolver in CLI/core" >&2
  fail=$((fail+1))
}
# Action layer table
m_a = re.search(r"### The action layer[\s\S]*?\| Surface \|[\s\S]*?\n((?:\|[^\n]*\n)+)", text)
# Composition layer table
m_c = re.search(r"### The composition layer[\s\S]*?\| Shape \|[\s\S]*?\n((?:\|[^\n]*\n)+)", text)
import re, sys
text = open("/Users/lekt9/.claude/skills/contract/SKILL.md").read()
# Action layer table
m_a = re.search(r"### The action layer.*?\| Surface \|[\s\S]*?\n((?:\|[^\n]*\n)+)", text)
# Composition layer table
m_c = re.search(r"### The composition layer.*?\| Shape \|[\s\S]*?\n((?:\|[^\n]*\n)+)", text)
if not m_a or not m_c:
    print("could not parse action/composition tables", file=sys.stderr)
    sys.exit(1)
def first_col_tokens(table):
    out = set()
    for row in table.strip().splitlines():
        if not row.startswith("|") or "---" in row:
            continue
        cells = [c.strip() for c in row.strip("|").split("|")]
        if not cells: continue
        for tok in re.findall(r"`([a-z][a-z0-9:<>-]*?)`", cells[0]):
            out.add(tok.split(":")[0].strip("<>"))
    return out
A = first_col_tokens(m_a.group(1))
C = first_col_tokens(m_c.group(1))
overlap = A & C
if overlap:
    print(f"FAIL: shape(s) appear in BOTH action and composition tables: {sorted(overlap)}", file=sys.stderr)
    sys.exit(1)
print(f"clean: {len(A)} action surfaces, {len(C)} composition shapes, no overlap")
PY
)
python3 -c "$PY_BLOCK" || fail=$((fail+1))

if [ $fail -gt 0 ]; then
  echo "" >&2
  echo "unified-model drift detected ($fail issue(s))." >&2
  exit 1
fi
echo "unified-model clean: action layer and composition layer surfaces all resolve, no cross-table overlap."
exit 0
