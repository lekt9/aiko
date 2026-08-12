#!/bin/bash
# fractal-grind.sh — Stop-hook: keep grinding til completion fractally.
# Hook-based: every PostToolUse already validated the changed leaf; this Stop
# hook checks the whole forest's Merkle and blocks exit while any cell is red.
# Unbounded on progress (witness changes -> reset), bounded on stagnation (CAP=7).
set -euo pipefail
HOOK_INPUT=$(cat 2>/dev/null || echo "{}")
STATE=".claude/jesus-ralph.local.md"
CELL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$CELL_ROOT/.." 2>/dev/null || cd "$CELL_ROOT"

FAIL=0
RED=""
for f in $(find cell -name "*.cell.yaml" 2>/dev/null | head -n 100); do
  if ! python3 cell/run.py build "$f" >/dev/null 2>&1; then
    FAIL=$((FAIL+1)); RED="$RED $f:build"; continue
  fi
  if python3 -c "
import yaml, pathlib, sys
p=pathlib.Path(sys.argv[1])
try:
 d=yaml.safe_load(p.read_text())
except: d=None
r=(d.get('spec') or {}).get('run') or {} if isinstance(d,dict) else {}
if r.get('kind')=='python' and r.get('code'):
 compile(r['code'], str(p), 'exec')
" "$f" 2>/dev/null; then :; else
    rc=$?
    if python3 -c "import yaml,sys; d=yaml.safe_load(open(sys.argv[1]).read()) if True else {}; r=(d.get('spec') or {}).get('run') or {}; raise SystemExit(0 if r.get('kind')=='python' and r.get('code') else 1)" "$f" 2>/dev/null; then
      # was a python code leaf that failed compile
      if [[ $rc -ne 0 ]]; then FAIL=$((FAIL+1)); RED="$RED $f:python-compile"; fi
    fi
  fi
done
if [[ -f "cell/example/pipeline.cell.yaml" && -f "cell/example/inputs.json" ]]; then
  if ! python3 cell/run.py check cell/example/pipeline.cell.yaml --inputs cell/example/inputs.json >/tmp/cell-fractal-grind.log 2>&1; then
    FAIL=$((FAIL+1)); RED="$RED cell/example/pipeline.cell.yaml:check"
  fi
fi
# optional tree gate if present (skip silently when absent)
if [[ -f "cell/tests/tree_gate.py" ]]; then
  if python3 cell/tests/tree_gate.py 2>/tmp/cell-tree-gate.log; then :; else
    rc=$?; if [[ $rc -ne 0 ]]; then FAIL=$((FAIL+1)); RED="$RED tree_gate"; cat /tmp/cell-tree-gate.log >&2; fi
  fi
fi

if [[ $FAIL -eq 0 ]]; then exit 0; fi
REASON="🌀 cell fractal-grind: $FAIL still red — keep grinding fractally. Red:$RED
Each red leaf was validated on PostToolUse; this Stop re-checks the whole Merkle.
Fix one leaf (itself a spawned harness reusing existing cells), then re-drive."
if [[ -f "$STATE" ]]; then echo "$REASON" >&2; exit 1; fi
STOP_ACTIVE=$(echo "$HOOK_INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('stop_hook_active', False))" 2>/dev/null || echo "False")
if [[ "$STOP_ACTIVE" == "True" || "$STOP_ACTIVE" == "true" ]]; then
  CAP="${CLAUDE_CODE_STOP_HOOK_BLOCK_CAP:-7}"
  CUR_SIG=$(printf '%s' "$REASON" | cksum | awk '{print $1"_"$2}')
  SIG_FILE="/tmp/cell-fractal-grind.sig"; CNT_FILE="/tmp/cell-fractal-grind.cnt"
  LAST_SIG=$(cat "$SIG_FILE" 2>/dev/null || echo ""); LAST_CNT=$(cat "$CNT_FILE" 2>/dev/null || echo 0)
  [[ "$LAST_CNT" =~ ^[0-9]+$ ]] || LAST_CNT=0
  if [[ "$CUR_SIG" != "$LAST_SIG" ]]; then echo "$CUR_SIG" > "$SIG_FILE"; echo 0 > "$CNT_FILE"; else CNT=$((LAST_CNT+1)); echo "$CNT" > "$CNT_FILE"; if [[ $CNT -ge $CAP ]]; then echo "🕊 cell fractal-grind: RESTING unchanged $CAP passes — stays armed; edit resumes." >&2; exit 0; fi; fi
  python3 -c "import json,sys; print(json.dumps({'decision':'block','reason':sys.argv[1]}))" "$REASON"; exit 0
fi
echo "$REASON" >&2; exit 0
