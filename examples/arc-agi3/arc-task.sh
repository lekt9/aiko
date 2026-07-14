#!/bin/bash
# ARC-AGI-3 Phase 5 — the SUBSTRATE solves grid tasks end-to-end.
#
# The MASTER-PLAN's Success Target, distinct from the other arc-validate-*.sh
# (which test substrate MECHANICS). Here the substrate itself computes each
# answer: a `python:` solver neuron transforms the input grid; a `fulfil:` root
# adopts the produced grid and surfaces it as its own satisfied result. The test
# never computes or injects the answer — it only asserts the surfaced result
# equals the task's expected output. declare -> resolve (leaf computes) ->
# fulfilment (value handoff) -> root satisfied with the correct grid.
#
# Each task in tasks/*.json is self-describing: {input, expected, solver}, where
# `solver` is quote-free python operating on `g` (the input). Backfill runs
# through the `contract` persona (aiko is the remote LLM-compile persona; offline
# leaf execution + backfill live in the native binary). Pass a task file to run
# just one; with no arg, runs every tasks/*.json.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
CONTRACT="$ARC_ROOT/scripts/contract"
TASKS_DIR="$ARC_ROOT/examples/arc-agi3/tasks"

arc_latest_value() {   # latest real data on id's OWN rows (skips hold*/pass/fail)
  python3 - "$ARC_LEDGER" "$1" <<'PY'
import sys, json
val = ""
for line in open(sys.argv[1]):
    try: r = json.loads(line)
    except Exception: continue
    if r.get("id") != sys.argv[2]: continue
    res = r.get("action_result")
    if res and res not in ("hold", "pass", "fail") and not res.startswith("hold:"):
        val = res
print(val)
PY
}

run_task() {
  local task_file="$1"
  arc_init
  local name input expect solver
  name=$(python3 -c "import json;print(json.load(open('$task_file'))['task'])")
  input=$(python3 -c "import json;print(json.dumps(json.load(open('$task_file'))['input'],separators=(',',':')))")
  expect=$(python3 -c "import json;print(json.dumps(json.load(open('$task_file'))['expected'],separators=(',',':')))")
  solver=$(python3 -c "import json;print(json.load(open('$task_file'))['solver'])")
  echo "--- task $name  input=$input  expected=$expect ---"

  local P R
  P=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
  R=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
  # Solver neuron: bind the input as g, then the task's quote-free python rule.
  local PY="python:g=$input;$solver"
  {
    printf '%s\n' "{\"event\":\"declared\",\"id\":\"$P\",\"plan\":\"arc $name solver\",\"action\":\"$PY\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:00Z\"}"
    printf '%s\n' "{\"event\":\"declared\",\"id\":\"$R\",\"plan\":\"arc $name root\",\"action\":\"fulfil:$P\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:01Z\"}"
  } >> "$ARC_LEDGER"
  for i in 1 2 3 4; do "$CONTRACT" declare "arc drill $name $i" >/dev/null 2>>"$ARC_EV" || true; done

  local got; got=$(arc_latest_value "$R")
  if [ "$got" != "$expect" ]; then
    echo "FAIL($name): root surfaced '$got', expected '$expect' — substrate did not solve the task"
    arc_cleanup; return 1
  fi
  if ! arc_is_satisfied "$P"; then
    echo "FAIL($name): solver never satisfied — the leaf did not execute"
    arc_cleanup; return 1
  fi
  # re-solve must not drift (signature-chain keyed, not re-derived to a new answer)
  "$CONTRACT" declare "arc re-solve $name" >/dev/null 2>>"$ARC_EV" || true
  local got2; got2=$(arc_latest_value "$R")
  if [ "$got2" != "$expect" ]; then
    echo "FAIL($name): re-solve drifted to '$got2'"
    arc_cleanup; return 1
  fi
  echo "PASS($name): substrate solved end-to-end + surfaced correct output ($got); solver satisfied; re-solve stable"
  arc_cleanup; return 0
}

echo "=== ARC-AGI-3 Phase 5: substrate solves grid tasks end-to-end ==="
fail=0
if [ $# -ge 1 ]; then
  run_task "$1" || fail=1
else
  for tf in "$TASKS_DIR"/*.json; do run_task "$tf" || fail=1; done
fi
if [ "$fail" -ne 0 ]; then echo "=== ARC E2E: FAIL ==="; exit 1; fi
echo "=== ARC E2E: all tasks solved through the substrate ==="
