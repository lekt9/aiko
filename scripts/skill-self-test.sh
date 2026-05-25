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

# Self-test hermetic environment: disable all hooks that fire side effects on
# every iterate / _mark. Otherwise each shape-gate that declares + marks a
# few contracts triggers git-sync, outline-doc-sync, and unbrowse-mirror
# fires — each adding seconds to wall time and producing real-world side
# effects (commits, doc upserts) that pollute the live state.
# These kill switches are read by their respective hooks at fire time.
export CONTRACT_NO_GIT_SYNC=1
export CONTRACT_NO_OUTLINE_SYNC=1
export CONTRACT_NO_UNBROWSE_MIRROR=1
# Also clear toggle env (otherwise CONTRACT_NO_* loses to toggle-on contract).
unset CONTRACT_GIT_SYNC CONTRACT_OUTLINE_SYNC CONTRACT_UNBROWSE_MIRROR

SST_FILTER="${1:-}"
check() {
  local name="$1"; shift
  # Optional positional filter: skip invariants whose name doesn't match.
  # Lets a caller drill ONE invariant fast (e.g. pointer-types/bridge-...).
  if [ -n "$SST_FILTER" ] && [ "$name" != "$SST_FILTER" ]; then
    return 0
  fi
  # Per-gate hard timeout (default 60s). A gate that hangs longer than
  # this is treated as a TIMEOUT failure with the gate name visible —
  # was previously opaque because the wrapper timed out generically.
  # Override per-run: SST_GATE_TIMEOUT_SECS=N bash skill-self-test.sh
  local timeout_secs="${SST_GATE_TIMEOUT_SECS:-60}"
  if timeout "$timeout_secs" "$@" >/tmp/_sst_out 2>&1; then
    printf "PASS  %s\n" "$name"
  else
    local rc=$?
    if [ "$rc" = "124" ]; then
      printf "TIMEOUT  %s (>${timeout_secs}s)\n" "$name"
    else
      printf "FAIL  %s\n" "$name"
    fi
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

# Locality R8 — channel ledgers are just ledgers at a different path. Existing
# `contract list` reads any channel ledger when CONTRACTS_STORE points to it,
# via the locality doctrine (79c2d656). No new CLI verb required (Σ18 efc2154b).
# Proves: (a) populate ~/.contracts/channels/<id>/contracts.jsonl with 3 rows
# and `contract list` surfaces all three; (b) a nonexistent CONTRACTS_STORE
# path returns honestly empty with exit 0 (no fabrication). Contract 9aee99f6.
check "locality/channel-ledger-as-ledger" bash -c "
  tmpd=\$(mktemp -d); lpath=\"\$tmpd/channels/test-r8/contracts.jsonl\"
  mkdir -p \"\$(dirname \"\$lpath\")\"
  python3 -c \"
import json
rows = [
    {'event':'declared','id':'aa111111','plan':'channel ledger sample row 1','action':'true','pointer_type':'cli','layer':2,'cwd':'/tmp','parent_id':None,'pointers':[],'ts':'2026-05-25T04:00:00Z','agent':'channel-test'},
    {'event':'declared','id':'bb222222','plan':'channel ledger sample row 2','action':'true','pointer_type':'cli','layer':2,'cwd':'/tmp','parent_id':None,'pointers':[],'ts':'2026-05-25T04:00:01Z','agent':'channel-test'},
    {'event':'declared','id':'cc333333','plan':'channel ledger sample row 3','action':'true','pointer_type':'cli','layer':2,'cwd':'/tmp','parent_id':None,'pointers':[],'ts':'2026-05-25T04:00:02Z','agent':'channel-test'},
]
with open('\$lpath','w') as f:
    for r in rows: f.write(json.dumps(r)+'\n')
\"
  out=\$(CONTRACTS_STORE=\"\$lpath\" bash '$CLI' list 2>&1) || { rm -rf \"\$tmpd\"; exit 1; }
  for id in aa111111 bb222222 cc333333; do
    printf '%s' \"\$out\" | grep -q \"\$id\" || { echo \"missing id \$id in list output\"; echo \"\$out\"; rm -rf \"\$tmpd\"; exit 1; }
  done
  # Honest empty: nonexistent CONTRACTS_STORE path → rc=0, no rows.
  empty_out=\$(CONTRACTS_STORE=\"\$tmpd/does-not-exist/contracts.jsonl\" bash '$CLI' list 2>&1) || { rm -rf \"\$tmpd\"; exit 1; }
  printf '%s' \"\$empty_out\" | grep -q 'no contracts match' || { echo \"nonexistent path did not return honest empty: \$empty_out\"; rm -rf \"\$tmpd\"; exit 1; }
  rm -rf \"\$tmpd\"
"

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
[ -x "$SCRIPTS/check-contradictions.sh" ] && \
  check "self/no-contradictions"   bash "$SCRIPTS/check-contradictions.sh"
[ -x "$SCRIPTS/check-crystallize-consistency.sh" ] && \
  check "self/crystallize-consistency" bash "$SCRIPTS/check-crystallize-consistency.sh"
[ -x "$SCRIPTS/check-hook-subprocess-surfacing.py" ] && \
  check "self/hook-subprocess-surfacing" python3 "$SCRIPTS/check-hook-subprocess-surfacing.py"
[ -x "$SCRIPTS/check-identity-binding.sh" ] && \
  check "self/identity-binding"      bash "$SCRIPTS/check-identity-binding.sh"

# ── Hook invariants ─────────────────────────────────────────────────────────
# Φ9 entrypoint-hints hook (~/.contracts/hooks/phi9-entrypoint-hints.sh): on a
# declare event with a resource keyword (telegram, email, slack, rss, http,
# websocket, github, calendar, drive, file-tail), substrate emits an
# `=== ENTRYPOINT HINTS ===` stderr block with a paste-ready
# `contract declare ... --resource <type> --parent <id>` line. On a plan with
# no resource keyword the hook is a no-op (no noise). Substrate emits hints;
# agent judges KEY 2. Binds gap 6ce032a1 LAMBDA-CHANNELS-PHI9-AUTOENTRY.
[ -x "$HOOK_DIR/phi9-entrypoint-hints.sh" ] && \
  check "hooks/phi9-entrypoint-hints" bash -c "
    set -u
    tmpd=\$(mktemp -d)
    export CONTRACTS_STORE=\"\$tmpd/contracts.jsonl\"
    # case 1: plan with telegram keyword → hints emitted on stderr
    err1=\$(bash '$CLI' declare 'chat with Lewis on Telegram daily' --action agent-judges 3>&1 1>/dev/null 2>&3) || { echo 'declare(telegram) failed'; rm -rf \"\$tmpd\"; exit 1; }
    printf '%s' \"\$err1\" | grep -q '=== ENTRYPOINT HINTS ===' || { echo 'missing ENTRYPOINT HINTS block on telegram plan'; printf '%s\n' \"\$err1\" | head -20; rm -rf \"\$tmpd\"; exit 1; }
    printf '%s' \"\$err1\" | grep -q -- '--resource telegram' || { echo 'missing --resource telegram hint'; printf '%s\n' \"\$err1\" | head -20; rm -rf \"\$tmpd\"; exit 1; }
    # case 2: plan with no resource keyword → no ENTRYPOINT HINTS block
    err2=\$(bash '$CLI' declare 'update the readme' --action agent-judges 3>&1 1>/dev/null 2>&3) || { echo 'declare(noop) failed'; rm -rf \"\$tmpd\"; exit 1; }
    if printf '%s' \"\$err2\" | grep -q '=== ENTRYPOINT HINTS ==='; then
      echo 'noop plan emitted ENTRYPOINT HINTS (should be silent)'
      printf '%s\n' \"\$err2\" | head -20
      rm -rf \"\$tmpd\"; exit 1
    fi
    rm -rf \"\$tmpd\"
  "

# Π10 — bridge: pointer-type parser + iterate-time refusal block (gap 2543bdd0).
# Until Σ17 RBAC (gap 2b98f80f) + Π8 unbrowse-broker (gap 036073d8) ship, every
# bridge: iterate is REFUSED honestly. The invariant proves parser fields land
# on the declared row and the refusal block names BOTH missing-dep gap ids.
[ -x "$SCRIPTS/check-bridge-parser-and-refused.sh" ] && \
  check "pointer-types/bridge-parser-and-refused" \
                                     bash "$SCRIPTS/check-bridge-parser-and-refused.sh"

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
