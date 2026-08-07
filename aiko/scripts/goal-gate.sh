#!/usr/bin/env bash
# Mechanical witness for Aiko's goal (docs/GOAL.md): zero setup, one-shot
# prompts, native tooling, Unbrowse for integration — nothing the user installs.
#
#   scripts/goal-gate.sh
#
# The goal is not just prose; this gate makes it checkable, in the same spirit as
# every other witness in the repo — "never claim something happened when it
# didn't." It exits 0 only when the goal is stated canonically, linked from the
# surfaces that steer work, AND the product still leans the way the goal says.
#
# Reactive: this is wired as a git pre-commit hook (scripts/install-goal-hook.sh),
# so it re-fires whenever the tree moves — the same idea as the runtime's
# invalidation loop (a node re-fires when the thing it was derived from changes),
# applied to the north star. A commit that quietly adds a setup step goes red
# here before it lands.
#
# Falsifier: delete a pillar from docs/GOAL.md, drop a link, or make the desktop
# user path require an install, and the matching check goes red.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok: $*"; }
need_file() { [[ -f "$1" ]] || fail "missing file $1"; }
# has <file> [-i] <pattern> [label]
has() {
  local file=$1; shift
  local ci=""
  [[ "$1" == "-i" ]] && { ci="-i"; shift; }
  local pattern=$1 label=${2:-$1}
  rg -q $ci -- "$pattern" "$file" || fail "$file missing: $label"
  ok "$file — $label"
}

GOAL="$ROOT/docs/GOAL.md"

# ── A. the goal is stated canonically, with all four pillars ──────────────────
need_file "$GOAL"
has "$GOAL" 'one prompt'                         'one-shot prompts pillar'
has "$GOAL" -i 'zero setup'                       'zero-setup pillar'
has "$GOAL" -i 'native'                           'native-tooling pillar'
has "$GOAL" -i 'Unbrowse'                         'Unbrowse-integration pillar'
# The sharp differentiator, stated as a REFUSAL (not merely mentioning skills):
# the user never installs a skill or an MCP. Checking the refusal framing, not
# just the phrase, so a doc that flips to "install skills freely" fails here.
has "$GOAL" -i 'install a skill or'               'names the skill/MCP install ceremony'
has "$GOAL" -i 'product refuses|never installs'   'frames user-install as refused (anti-goal)'
# It must be a decision gate, not just aspiration.
has "$GOAL" -i 'against the goal|decides scope|the test for any' 'scope-decision gate'
# The goal documents its own reactive enforcement (doc + gate stay coupled).
has "$GOAL" 'goal-gate\.sh'                        'documents its runnable gate'
has "$GOAL" -i 'reactive|re-fires|invalidation'    'documents reactive re-firing'

# ── B. it is linked from the surfaces that steer work ─────────────────────────
has "$ROOT/README.md"             'docs/GOAL\.md'    'README links the goal'
has "$ROOT/README.md"             -i 'zero setup'    'README states the goal'
has "$ROOT/docs/README.md"        'GOAL\.md'         'docs map links the goal'
has "$ROOT/AGENTS.md"             'docs/GOAL\.md'    'AGENTS.md gates on the goal'
has "$ROOT/AGENTS.md"             -i 'setup step|against the product' 'AGENTS.md carries the gate question'
has "$ROOT/apps/desktop/README.md" 'docs/GOAL\.md'   'desktop README links the goal'

# every GOAL.md link target must resolve
for pair in "README.md:docs/GOAL.md" "docs/README.md:docs/GOAL.md" \
            "AGENTS.md:docs/GOAL.md" "apps/desktop/README.md:docs/GOAL.md"; do
  tgt="$ROOT/${pair##*:}"
  [[ -f "$tgt" ]] || fail "broken goal link from ${pair%%:*}"
done
ok "all goal links resolve"

# ── C. the product still leans the way the goal says (falsifiable proxies) ────
# Zero-setup user path: the desktop app stands up its own stack (adopt-or-start)
# and bundles the runtime, rather than handing the user a setup checklist.
has "$ROOT/apps/desktop/src-tauri/src/stack.rs" 'fn ensure'          'desktop self-hosts its stack (adopt-or-start)'
has "$ROOT/apps/desktop/src-tauri/tauri.conf.json" 'externalBin'      'desktop bundles the aiko runtime sidecar'
# One-shot: the CLI takes a prompt as a positional, not a wizard.
has "$ROOT/README.md" 'aiko "' 'one-shot prompt usage documented'

echo
echo "GOAL GATE PASSED — zero setup, one shot, nothing to install (docs + product aligned)"
exit 0
