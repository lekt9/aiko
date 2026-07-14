#!/bin/bash
# ARC-AGI-3 F8: the executor must NOT shell-execute a typed doctrine pointer the
# validator blessed. `word:`/`validate:`/`signed:`/... pass validation
# (isKnownAction) but have no executor branch; before the fix they fell through
# to `sh -c "<action>"`, a shell-injection surface. The fix classifies them as
# their real (inert) kinds and default-denies anything but cli/api/loop/harness
# at the exec fall-through. This test uses a REAL injection payload: if the
# action shell-runs, the `;touch` breaks out and drops a sentinel file.
#
# Two properties:
#   A. a word: action carrying an injection is HELD, not executed (sentinel
#      never appears) — the hazard is closed.
#   B. a loop-until: body STILL executes (its sentinel does appear) — the
#      default-deny allow-list did not over-block legitimate execution.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/_harness.sh"
trap arc_cleanup EXIT

echo "=== ARC-AGI-3 F8: no shell-exec of validator-blessed typed pointers ==="
arc_init

PWNED="$ARC_TMP/PWNED_INJECTION"    # created ONLY if word: shell-executes (bad)
LOOPOK="$ARC_TMP/LOOP_RAN"          # created if loop-until: body executes (good)
inj=$(python3 -c 'import secrets; print(secrets.token_hex(4))')
lp=$(python3 -c 'import secrets; print(secrets.token_hex(4))')

{
  # A. word: prefix passes isKnownAction; payload breaks out IF shell-executed.
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$inj\",\"plan\":\"inert-pointer injection\",\"action\":\"word:x;touch $PWNED\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:00Z\"}"
  # B. loop-until: body IS meant to execute — proves the allow-list still runs it.
  printf '%s\n' "{\"event\":\"declared\",\"id\":\"$lp\",\"plan\":\"loop body must run\",\"action\":\"loop-until:x;touch $LOOPOK\",\"parent_id\":null,\"ts\":\"2026-07-14T00:00:01Z\"}"
} >> "$ARC_LEDGER"

"$ARC_AIKO" 'trigger F8 sweep' --private >/dev/null 2>"$ARC_EV" || true

# A. injection sentinel must NOT exist.
if [ -f "$PWNED" ]; then
  echo "FAIL(A): word: action shell-executed — injection sentinel dropped (fork F8 OPEN)"
  exit 1
fi
echo "PASS(A): typed pointer word: was HELD, not shell-executed (no injection)"

# B. loop body sentinel MUST exist (no over-block regression).
if [ ! -f "$LOOPOK" ]; then
  echo "FAIL(B): loop-until: body did NOT execute — default-deny over-blocked a legit executor"
  exit 1
fi
echo "PASS(B): loop-until: body still executes (allow-list intact)"

echo "PASS: F8 closed — inert typed pointers refused, genuine executors run"
