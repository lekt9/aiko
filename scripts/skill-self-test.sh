#!/usr/bin/env bash
# skill-self-test.sh — runs every structural invariant the /contract skill
# enforces on its own code. Substrate that REPLACES one-off iteration of
# 18+ skill-self contracts. Wired as pre-commit on ~/.contracts/.git so
# every ledger event auto-revalidates. Contracts 02471746 + 33c188dc.
set -uo pipefail
SKILL_DIR="${SKILL_DIR:-$HOME/.claude/skills/contract}"
SCRIPTS="$SKILL_DIR/scripts"
HOOK_DIR="${HOOK_DIR:-$HOME/.contracts/hooks}"
CLI="$SCRIPTS/contract"
fail=0

check() {
  local name="$1"; shift
  if "$@" >/tmp/_sst_out 2>&1; then
    printf "PASS  %s\n" "$name"
  else
    printf "FAIL  %s\n" "$name"
    sed 's/^/      | /' /tmp/_sst_out | head -5
    fail=$((fail + 1))
  fi
}

# ── Structural invariants (was 18 individual contracts) ──────────────────────
check "cli/bash-syntax"            bash -n "$CLI"
check "core/import"                env PYTHONPATH="$SCRIPTS/lib" python3 -c 'import contract_core'
check "core/folder-substrate"      env PYTHONPATH="$SCRIPTS/lib" python3 -c \
                                     'from contract_core import contract_dir, contracts_d_root; assert contracts_d_root()'
[ -f "$SCRIPTS/check-no-silent-fallback.py" ] && \
  check "guard/no-silent-fallback" python3 "$SCRIPTS/check-no-silent-fallback.py"
[ -f "$SCRIPTS/check-cwd-binding.sh" ] && \
  check "guard/cwd-binding"        bash "$SCRIPTS/check-cwd-binding.sh"
[ -f "$SCRIPTS/check-drive-no-autosatisfy.py" ] && \
  check "guard/drive-no-autosatisfy" python3 "$SCRIPTS/check-drive-no-autosatisfy.py"
[ -f "$SCRIPTS/check-crystallize.sh" ] && \
  check "guard/crystallize"        bash "$SCRIPTS/check-crystallize.sh" module
check "cli/inline-drive-block"     python3 -c \
                                     "import sys; sys.exit(0 if 'INLINE DRIVE' in open('$CLI').read() else 1)"
[ -f "$HOME/.claude/hooks/contract-drive.py" ] && \
  check "hook/folder-aware"        python3 -c \
                                     "import sys; sys.exit(0 if 'contracts_d_root' in open('$HOME/.claude/hooks/contract-drive.py').read() else 1)"
[ -x "$HOOK_DIR/drive-advance.sh" ] && \
  check "hook/drive-advance-exec"  test -x "$HOOK_DIR/drive-advance.sh"

# ── Setup verbs (was ~50 skill-existence + 13 default + activation rows) ─────
check "verb/init-dry"              env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" init --dry-run
check "verb/skills-sync"           bash "$CLI" skills sync --json
check "verb/install-hooks-dry"     env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" install-hooks --dry-run
check "verb/export-hooks-json"     env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" export-hooks --format json
check "verb/drive-watch-missing"   env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" drive-watch nonexistent-id-XXXX

# Binding substrate (contract ae1340a6)
check "binding/declare-bind-to"    env PYTHONPATH="$SCRIPTS/lib" python3 -c \
                                     "from contract_core import declare; import inspect; assert 'bind_to' in inspect.signature(declare).parameters"
check "binding/get-surfaces-it"    env PYTHONPATH="$SCRIPTS/lib" python3 -c \
                                     "from contract_core import get; import inspect; src = inspect.getsource(get); assert 'bind_to' in src"
check "binding/verify-foreign"     env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" bash "$CLI" verify __nonexistent_surface_xyz__

# Self-awareness: SKILL.md matches live state (no drift). Contract 5d2ad5a5.
# Ψ2 working-memory cap: 'When to invoke' table ≤ 8 data rows (Miller's 7±2 upper edge)
check "psych/working-memory-cap"   python3 -c "
import re, sys
t = open('$SKILL_DIR/SKILL.md').read()
m = re.search(r'## When to invoke\s*\n+\| Trigger.*?\n((?:\|.*\n)+)', t)
rows = [r for r in m.group(1).strip().split('\n') if r.startswith('|') and not r.startswith('|---')]
data = [r for r in rows if not r.lstrip('|').strip().startswith('Trigger')]
sys.exit(0 if len(data) <= 8 else 1)
"
# Ψ1 abstraction layers named explicitly in SKILL.md
check "psych/abstraction-layers"   python3 -c \
                                     "import sys; t=open('$SKILL_DIR/SKILL.md').read(); sys.exit(0 if all(L in t for L in ['L0','L1','L2','L3','L4']) and 'abstraction layers' in t.lower() else 1)"
# Humanlike (Ε/Σ/Α) — emotion, sociology, aesthetics dimensions in SKILL.md (contract 5cc21029)
check "humanlike/dimensions"       python3 -c \
                                     "import sys; t=open('$SKILL_DIR/SKILL.md').read().lower(); sys.exit(0 if all(d in t for d in ['humanlike','emotion','sociology','aesthetics']) and all(g in t.lower() for g in ['ε1','ε2','σ1','α1']) else 1)"
check "humanlike/agent-attribution" env PYTHONPATH="$SCRIPTS/lib" CONTRACTS_STORE="$(mktemp)" CONTRACT_AGENT="skill-self-test" python3 -c \
                                     "import json, os; from contract_core import declare; cid=declare('attribution row must carry agent','true'); row=json.loads(open(os.environ['CONTRACTS_STORE']).readline()); assert row['id']==cid and row.get('agent')=='skill-self-test'"
check "humanlike/plan-quality"      bash -c \
                                     "CONTRACTS_STORE=\"\$(mktemp)\" bash '$CLI' declare 'fix ui' --action true --no-drive 2>&1 | grep -q 'plan text reads as a task'"
check "humanlike/failure-streak"    bash -c \
                                     "tmp=\$(mktemp); out=\$(CONTRACTS_STORE=\"\$tmp\" bash '$CLI' declare 'failure streak probe contract' --action false --no-drive); id=\$(printf '%s\n' \"\$out\" | awk '/^declared:/ {print \$2}'); CONTRACTS_STORE=\"\$tmp\" bash '$CLI' iterate \"\$id\" >/dev/null; CONTRACTS_STORE=\"\$tmp\" bash '$CLI' iterate \"\$id\" >/dev/null; CONTRACTS_STORE=\"\$tmp\" bash '$CLI' iterate \"\$id\" 2>&1 | grep -q 'failure-streak escalation'"
check "humanlike/over-iteration"    bash -c \
                                     "tmp=\$(mktemp); out=\$(CONTRACTS_STORE=\"\$tmp\" bash '$CLI' declare 'over iteration probe contract' --action true --no-drive); id=\$(printf '%s\n' \"\$out\" | awk '/^declared:/ {print \$2}'); CONTRACTS_STORE=\"\$tmp\" bash '$CLI' iterate \"\$id\" >/dev/null; CONTRACTS_STORE=\"\$tmp\" bash '$CLI' iterate \"\$id\" >/dev/null; CONTRACTS_STORE=\"\$tmp\" bash '$CLI' iterate \"\$id\" 2>&1 | grep -q 'over-iteration warning'"
check "self/no-drift"              env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" python3 -c \
                                     "import json, subprocess, sys; r=subprocess.run(['bash','$CLI','self','--json'],capture_output=True,text=True); d=json.loads(r.stdout); sys.exit(0 if d['drift']==[] else 1)"

# ── Pre-flight self-checks (check yourself before you shrek yourself) ─────────
# Drift between SKILL.md and the implementing code that no other gate catches.
# Each one fails 1 when docs and code disagree; the agent reads the diff.
check "self/heading-ladder"        python3 "$SCRIPTS/check-heading-ladder.py"
check "self/standing-gate-ids"     env CONTRACTS_STORE="$HOME/.contracts/contracts.jsonl" python3 "$SCRIPTS/check-standing-gate-ids.py"
check "self/empathy-flags-wired"   python3 "$SCRIPTS/check-empathy-flags-wired.py"
check "self/shape-catalog"         python3 "$SCRIPTS/check-shape-catalog.py"
check "self/graph-depth"           bash "$SCRIPTS/check-graph-depth.sh"
check "self/streams-convention"    bash "$SCRIPTS/check-streams-convention.sh"
check "self/unified-model"         bash "$SCRIPTS/check-unified-model.sh"
check "self/readme-fresh"          bash "$SCRIPTS/check-readme-fresh.sh"
check "self/honest-bound"          bash "$SCRIPTS/check-honest-bound.sh"
check "self/break-on-resolution"   bash "$SCRIPTS/check-break-on-resolution.sh"
check "self/proof-binding"         bash "$SCRIPTS/check-proof-binding.sh"

# ── Corpus audits (rule-bound checks across all affected artifacts) ──────────
# Every audits/<rule>/verify.sh is a corpus-wide check for one rule. The
# runner walks them all. A failure here means the rule's audits/*/fix.sh
# has not been run; the runner names which one. See contract d4074595
# (audits/ directory convention).
[ -x "$SCRIPTS/run-audits.sh" ] && \
  check "self/audits-pass"         bash "$SCRIPTS/run-audits.sh"
# ── Verb gates (one regression harness per CLI verb) ────────────────────────
# Mirror of shape gates, one finer level. Each verb-gates/<verb>/verify.sh
# exercises one verb in a sandboxed CONTRACTS_STORE. A regression in
# promote / _mark / supersede / corroborate / learn (etc.) is caught by the
# next ledger event. See verb-gates/README.md (contract 2db87011).
[ -x "$SCRIPTS/run-verb-gates.sh" ] && \
  check "self/verb-gates-pass"     bash "$SCRIPTS/run-verb-gates.sh"
# ── Self-organism wraps (/contract follows what it says it does) ────────────
# Every layer claim made in SKILL.md is bound to an executable verifier
# (the self-organism root cc5e8920 pointer-gates on all of these).
[ -x "$SCRIPTS/check-origin-citations.sh" ] && \
  check "self/origin-citations"    bash "$SCRIPTS/check-origin-citations.sh"
[ -x "$SCRIPTS/check-bundled-scripts.sh" ] && \
  check "self/bundled-scripts"     bash "$SCRIPTS/check-bundled-scripts.sh"
[ -x "$SCRIPTS/check-doctrine-binding.sh" ] && \
  check "self/doctrine-binding"    bash "$SCRIPTS/check-doctrine-binding.sh"
[ -x "$SCRIPTS/check-default-contracts.sh" ] && \
  check "self/default-contracts"   bash "$SCRIPTS/check-default-contracts.sh"
# ── Shape gates (regression harnesses for each contract shape) ────────────────
# Each gate's verify.sh proves one shape behaves correctly. They honor an
# external CONTRACTS_STORE, so we run them with a tmpdir ledger to avoid
# polluting the real one. Promoted from orphaned 2026-05-23 (contract 2927a44e).
GATE_TMP=$(mktemp -d)
for gate in audit bm25 budget cell judgment funnel funnel-first loop harness lifecycle propagation quorum sequence tool-guard; do
  gate_path="$SKILL_DIR/$gate-gate/verify.sh"
  [ -f "$gate_path" ] && \
    check "gate/$gate"               env CONTRACTS_STORE="$GATE_TMP/$gate.jsonl" bash "$gate_path"
done
rm -rf "$GATE_TMP"

if [ $fail -gt 0 ]; then
  printf "\nSKILL-SELF-TEST: %d FAIL(S)\n" "$fail" >&2
  exit 1
fi
echo
echo "SKILL-SELF-TEST: ALL PASS"
exit 0
