#!/usr/bin/env bash
# iterate-until.sh — chain-by-containment loop runner.
#
# Models a HOLD-is-non-terminal contract as a parent-child DAG:
#
#   parent: <truth-claim>
#   ├─ wave-1: <run gate; if HOLD, this wave returns next-action>
#   ├─ wave-2: <parent_id=wave-1; fires next resolver>
#   ├─ wave-N: <…>
#   └─ escalation: <fires when guards trip; ships payload to picked channel>
#
# The loop terminates only on:
#   (1) gate PROMOTE  (truth claim satisfied — biological STOP codon)
#   (2) apoptosis     (user-named stop — see APOPTOSIS section)
#   (3) emergency-only recursion guards (MAX_WAVES, MAX_WALL_SECS) — these
#       trigger escalation, NOT termination. Escalation ships to the
#       best-channel-right-now per scripts/pick-channel.sh, then the loop
#       continues waiting for the user reply (which arrives as a fresh
#       resolver-wave child of the parent).
#
# APOPTOSIS — how the user names the stop:
#   - Create   ~/.contracts/apoptosis/<parent-id>   (touch is enough)
#   - Or send  SIGUSR1 to the iterate-until.sh process (PID printed at start)
#   - Or set   ITERATE_APOPTOSIS=1 in the env
#
# Usage:
#   iterate-until.sh <parent-claim-id-or-text> -- <gate-command...> [-- <resolver-command...>]
#
# Example:
#   iterate-until.sh "ship the unbrowse landing banger v3" -- \
#       bash scripts/four-dim-gate.sh --candidate http://localhost:3320/ --baseline https://www.unbrowse.ai/ -- \
#       bash scripts/resolve-gate-hold.sh
#
# Substrate contract: this loop IS a contract. Each iteration declares a
# child neuron via aiko with parent_id = the prior wave. Recursion guard
# strips parent_id at the escalation boundary so the channel-ship doesn't
# inherit the chain.

set -uo pipefail

PARENT_CLAIM=""
GATE_CMD=()
RESOLVER_CMD=()

stage=parent
while [[ $# -gt 0 ]]; do
  arg="$1"; shift
  if [[ "$arg" == "--" ]]; then
    case "$stage" in
      parent)   stage=gate ;;
      gate)     stage=resolver ;;
      resolver) RESOLVER_CMD+=("$arg") ;;  # nested literal --
    esac
    continue
  fi
  case "$stage" in
    parent)   PARENT_CLAIM="$arg" ;;
    gate)     GATE_CMD+=("$arg") ;;
    resolver) RESOLVER_CMD+=("$arg") ;;
  esac
done

if [[ -z "$PARENT_CLAIM" || ${#GATE_CMD[@]} -eq 0 ]]; then
  cat <<'USAGE' >&2
usage: iterate-until.sh <parent-claim> -- <gate-cmd...> [-- <resolver-cmd...>]

Loop runs:  gate → (if HOLD) resolver → gate → ... → PROMOTE / apoptosis / escalate
USAGE
  exit 1
fi

# Emergency recursion guards (backstop only, NOT canonical break).
MAX_WAVES="${ITERATE_MAX_WAVES:-12}"
MAX_WALL_SECS="${ITERATE_MAX_WALL_SECS:-3600}"

AIKO="$HOME/.claude/skills/contract/scripts/aiko"
PICK="$HOME/.claude/skills/contract/scripts/pick-channel.sh"
SHIP="$HOME/.claude/skills/contract/scripts/ship-to-channel.sh"

LEDGER="$HOME/.contracts/iterate-runs.jsonl"
mkdir -p "$(dirname "$LEDGER")" "$HOME/.contracts/apoptosis"

# Declare the parent contract on aiko (substrate of record). Wrap in timeout
# so an unresponsive Unbrowse endpoint can't block the loop's start.
RUN_ID="iterate-$(date -u +%Y%m%dT%H%M%SZ)-$$"
echo "[iterate] parent: $PARENT_CLAIM  run_id=$RUN_ID pid=$$"
timeout 8 "$AIKO" "$PARENT_CLAIM" --remote >/dev/null 2>&1 || true

# Apoptosis signal handler
APOPTOSIS=0
trap 'APOPTOSIS=1; echo "[iterate] SIGUSR1 received — apoptosis-by-user requested" >&2' USR1

is_apoptosis() {
  if [[ "$APOPTOSIS" -eq 1 ]]; then return 0; fi
  if [[ "${ITERATE_APOPTOSIS:-0}" == "1" ]]; then return 0; fi
  if [[ -f "$HOME/.contracts/apoptosis/$RUN_ID" ]]; then return 0; fi
  # Also accept apoptosis by raw parent claim slug
  local slug
  slug="$(printf '%s' "$PARENT_CLAIM" | tr ' /' '__' | head -c 80)"
  if [[ -f "$HOME/.contracts/apoptosis/$slug" ]]; then return 0; fi
  return 1
}

started_at=$(date +%s)
wave=0
last_gate_stdout=""
last_gate_exit=0

while :; do
  wave=$((wave + 1))
  now=$(date +%s)
  elapsed=$((now - started_at))

  # Apoptosis check at top of every wave
  if is_apoptosis; then
    echo "[iterate] APOPTOSIS — parent declared stop. Exiting with last gate state." >&2
    printf '{"event":"apoptosis","run_id":"%s","wave":%d,"elapsed_s":%d,"parent":%s}\n' \
      "$RUN_ID" "$wave" "$elapsed" "$(printf '%s' "$PARENT_CLAIM" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >> "$LEDGER"
    exit 0
  fi

  echo "[iterate] wave $wave (elapsed ${elapsed}s) — running gate" >&2

  # Run the gate (capture both exit code AND stdout).
  set +e
  last_gate_stdout="$("${GATE_CMD[@]}" 2>&1)"
  last_gate_exit=$?
  set -e

  # Parse the gate output for verdict signal. Two conventions:
  #   - exit 0 + "PROMOTE" in stdout  → truth (chain done)
  #   - exit 0 + "PROMOTE-READY" in stdout → needs taste judgment (chain done — caller decides)
  #   - non-zero exit OR "HOLD" in stdout → HOLD (continue chain)
  if echo "$last_gate_stdout" | grep -qE 'Auto-gate verdict: PROMOTE|Auto-gate verdict:.*PROMOTE-READY'; then
    echo "[iterate] gate verdict: PROMOTE — truth claim satisfied. Exiting." >&2
    printf '{"event":"promote","run_id":"%s","wave":%d,"elapsed_s":%d,"parent":%s}\n' \
      "$RUN_ID" "$wave" "$elapsed" "$(printf '%s' "$PARENT_CLAIM" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >> "$LEDGER"
    exit 0
  fi

  # Recursion-guard backstops (NOT the canonical break). On trip → escalate.
  if [[ $wave -ge $MAX_WAVES || $elapsed -ge $MAX_WALL_SECS ]]; then
    echo "[iterate] backstop guards tripped (wave=$wave/$MAX_WAVES elapsed=${elapsed}/${MAX_WALL_SECS}s) — escalating to user via best channel" >&2
    channel="$($PICK --urgency high --kind alert)"
    payload="aiko escalation: run_id=$RUN_ID parent=\"$PARENT_CLAIM\" wave=$wave elapsed=${elapsed}s — gate still HOLD after backstop. Last gate excerpt:
$(printf '%s' "$last_gate_stdout" | grep -E 'Verdict|Auto-gate|REGRESSED|HOLD' | head -20)
Reply with the next resolver step, or touch ~/.contracts/apoptosis/$RUN_ID to stop."
    printf '%s' "$payload" | "$SHIP" "$channel" -
    printf '{"event":"escalate","run_id":"%s","wave":%d,"elapsed_s":%d,"channel":"%s"}\n' \
      "$RUN_ID" "$wave" "$elapsed" "$channel" >> "$LEDGER"
    # After escalation, exit with code 2 so the caller knows the loop yielded
    # to user-input rather than terminating on its own.
    exit 2
  fi

  # Otherwise: HOLD → fire resolver wave.
  if [[ ${#RESOLVER_CMD[@]} -gt 0 ]]; then
    echo "[iterate] gate HOLD — invoking resolver wave $wave" >&2
    set +e
    CONTRACT_PARENT="$PARENT_CLAIM" \
    CONTRACT_PARENT_ID="$RUN_ID" \
    GATE_STDOUT="$last_gate_stdout" \
      "${RESOLVER_CMD[@]}"
    resolver_exit=$?
    set -e
    printf '{"event":"resolver","run_id":"%s","wave":%d,"exit":%d}\n' \
      "$RUN_ID" "$wave" "$resolver_exit" >> "$LEDGER"
    if [[ $resolver_exit -ne 0 ]]; then
      echo "[iterate] resolver wave $wave returned non-zero ($resolver_exit) — escalating early" >&2
      channel="$($PICK --urgency high --kind alert)"
      payload="aiko escalation: run_id=$RUN_ID parent=\"$PARENT_CLAIM\" wave=$wave — resolver wave failed with exit=$resolver_exit. Last gate excerpt:
$(printf '%s' "$last_gate_stdout" | grep -E 'Verdict|REGRESSED|HOLD' | head -10)
Reply or apoptose."
      printf '%s' "$payload" | "$SHIP" "$channel" -
      exit 2
    fi
  else
    echo "[iterate] no resolver provided — gate is HOLD but loop cannot self-fix; escalating" >&2
    channel="$($PICK --urgency high --kind alert)"
    payload="aiko escalation: run_id=$RUN_ID parent=\"$PARENT_CLAIM\" wave=$wave — gate HOLD and no resolver wired. Reply with fix or apoptose."
    printf '%s' "$payload" | "$SHIP" "$channel" -
    exit 2
  fi

  # Loop back to top — re-gate.
done
