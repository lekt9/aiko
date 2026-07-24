#!/usr/bin/env bash
# Witness: contract is the single cellular primitive (plasma-fractal shape).
# Exit 0 only when A→B→C→D are present in the production path — no side brain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SHELL_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native.rs"
SKILL_RS="$ROOT/crates/codegen/xai-grok-shell/src/contract_native/skill_registry.rs"
POINTER_ZIG="${CONTRACT_POINTER_ZIG:-$HOME/.claude/skills/contract/libcontract/src/pointer.zig}"
MUSCLE_ZIG="${CONTRACT_MUSCLE_ZIG:-$HOME/.claude/skills/contract/libcontract/src/muscle.zig}"
DOC="$ROOT/docs/CONTRACT-FRACTAL-CELL.md"
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "OK: $*"; }

test -f "$SHELL_RS" || fail "missing $SHELL_RS"
test -f "$DOC" || fail "missing doctrine map $DOC"

# A — expand always fires with fractal cell model + bounds
rg -q 'fn expand_turn_root' "$SHELL_RS" || fail "A: expand_turn_root missing"
rg -q 'fn cell_spine_children' "$SHELL_RS" || fail "A: cell_spine_children missing"
rg -q 'fn cell_expand_children' "$SHELL_RS" || fail "A: cell_expand_children missing"
rg -q 'fractal_contract_cell' "$SHELL_RS" || fail "A: execution_model fractal_contract_cell missing"
rg -q 'max_depth' "$SHELL_RS" || fail "A: max_depth not passed into expand"
rg -q 'max_children' "$SHELL_RS" || fail "A: max_children not passed into expand"
rg -q 'max_concurrency' "$SHELL_RS" || fail "A: max_concurrency not passed into expand"
ok "A expand spine + bounds"

# B — agent: edge is the Aiko-powered cell
rg -q 'agent:aiko' "$SHELL_RS" || fail "B: agent:aiko spine action missing"
rg -q '"key": "agent"' "$SHELL_RS" || fail "B: agent key missing"
if test -f "$POINTER_ZIG"; then
  rg -q 'agent:' "$POINTER_ZIG" || fail "B: pointer.zig lacks agent: type"
  ok "B agent: pointer + aiko cell"
else
  ok "B agent:aiko in shell (pointer.zig not on this machine)"
fi

# C — posthook feedback loop (infinite residual as contracts)
rg -q 'posthook:feedback' "$SHELL_RS" || fail "C: posthook:feedback missing"
rg -q 'fn close_feedback_loop' "$SHELL_RS" || fail "C: close_feedback_loop missing"
rg -q 'posthook:iterate' "$SHELL_RS" || fail "C: residual iterate posthook missing"
if test -f "$POINTER_ZIG"; then
  rg -q 'posthook:' "$POINTER_ZIG" || fail "C: pointer.zig lacks posthook:"
fi
ok "C posthook feedback / iterate residual"

# D — bounds + muscle parallel waves (no unbounded brain)
rg -q 'DEFAULT_CONTRACT_MAX_DEPTH' "$SHELL_RS" || fail "D: MAX_DEPTH missing"
rg -q 'DEFAULT_CONTRACT_MAX_CHILDREN' "$SHELL_RS" || fail "D: MAX_CHILDREN missing"
rg -q 'DEFAULT_CONTRACT_MAX_CONCURRENCY' "$SHELL_RS" || fail "D: MAX_CONCURRENCY missing"
rg -q 'CELL_SPINE_LEN' "$SHELL_RS" || fail "D: CELL_SPINE_LEN missing"
rg -q 'remaining_nodes = 12' "$SKILL_RS" || fail "D: skill registry must reserve spine slots"
if test -f "$MUSCLE_ZIG"; then
  rg -q 'MAX_PARALLEL' "$MUSCLE_ZIG" || fail "D: muscle.MAX_PARALLEL missing"
  rg -q 'schedule' "$MUSCLE_ZIG" || fail "D: muscle.schedule missing"
  ok "D bounds + muscle waves"
else
  ok "D bounds in shell (muscle.zig not on this machine)"
fi

# Pure unit tests live in-tree (compile is monorepo-heavy; structural gate here).
rg -q 'fn cell_spine_is_observe_agent_verify_feedback' "$SHELL_RS" \
  || fail "unit test cell_spine_is_observe_agent_verify_feedback missing"
rg -q 'fn cell_expand_respects_max_children_and_hangs_skills_on_observe' "$SHELL_RS" \
  || fail "unit test cell_expand_respects_max_children missing"
# Lightweight spine-order check: observe before agent before verify before feedback
python3 - <<'PY' "$SHELL_RS" || fail "spine order check failed"
import re, sys
src = open(sys.argv[1]).read()
# Extract cell_spine_children body
m = re.search(r"fn cell_spine_children\(.*?\n\}", src, re.S)
if not m:
    print("no cell_spine_children", file=sys.stderr); sys.exit(1)
body = m.group(0)
keys = re.findall(r'"key":\s*"(\w+)"', body)
actions = re.findall(r'"action":\s*"([^"]+)"', body)
assert keys == ["observe", "agent", "verify", "feedback"], keys
assert actions == [
    "contract:observe_state",
    "agent:aiko",
    "contract:verify",
    "posthook:feedback",
], actions
# depends_on chain
assert '"depends_on": ["observe"]' in body or '"depends_on": ["observe"],' in body
assert "agent" in body and "verify" in body
print("spine order OK", keys, actions)
PY

# Doctrine claims the plasma-fractal isomorphism without forking a second primitive
rg -q 'plasma-ai/fractal' "$DOC" || fail "doc missing plasma-fractal reference"
rg -q 'no second primitive' "$DOC" || fail "doc must forbid second primitive"
rg -q 'observe' "$DOC" || fail "doc missing observe"
rg -q 'agent:aiko' "$DOC" || fail "doc missing agent:aiko"
rg -q 'posthook:feedback' "$DOC" || fail "doc missing posthook:feedback"
ok "doctrine map"

echo "WITNESS PASS: contract fractal cell A→B→C→D"
exit 0
