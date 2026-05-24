#!/usr/bin/env bash
# ssh-redeploy.sh — always-on-service redeploy via /contract composition.
#
# Aiko bot (and any always-on long-running service that lives on a remote
# host) redeploys via this helper, never via manual `ssh + systemctl
# restart`. The substrate composes:
#   - feature-status <gate>          pre-gate, safe-OFF by default
#   - ssh <host> "restart command"   the OS does the restart (no baked deploy logic)
#   - probe <url> with curl          verify the served surface, not the build
#   - append ssh_redeploy ledger row audit trail (Σ1 attribution included)
#
# Usage:
#   ssh-redeploy.sh --host <h> --service <s> [--probe <url>] [--gate <feature>]
#                   [--restart-cmd '<remote-cmd>'] [--ssh-opts '<opts>']
#
# Defaults:
#   --restart-cmd  : 'systemctl --user restart $service || systemctl restart $service'
#   --gate         : "$service-deploy"  (so a deploy can be toggled per-service)
#
# Exit codes: 0 = redeploy + probe PASS; 1 = restart or probe failed; 2 = bad args.
set -euo pipefail

HOST=""; SERVICE=""; PROBE=""; GATE=""; RESTART_CMD=""; SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --host) shift; HOST="${1:-}"; shift ;;
    --service) shift; SERVICE="${1:-}"; shift ;;
    --probe) shift; PROBE="${1:-}"; shift ;;
    --gate) shift; GATE="${1:-}"; shift ;;
    --restart-cmd) shift; RESTART_CMD="${1:-}"; shift ;;
    --ssh-opts) shift; SSH_OPTS="${1:-}"; shift ;;
    *) echo "ERROR: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
if [ -z "$HOST" ] || [ -z "$SERVICE" ]; then
  cat >&2 <<'USAGE'
usage: ssh-redeploy.sh --host <h> --service <s> [--probe <url>] [--gate <feature>]
                       [--restart-cmd '<cmd>'] [--ssh-opts '<opts>']

Defaults:
  --gate         <service>-deploy   (substrate-as-config opt-in)
  --restart-cmd  systemctl --user restart <service> || systemctl restart <service>
USAGE
  exit 2
fi
[ -z "$GATE" ]        && GATE="${SERVICE}-deploy"
[ -z "$RESTART_CMD" ] && RESTART_CMD="systemctl --user restart $SERVICE || sudo systemctl restart $SERVICE"

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$CLI_DIR/contract"

# 1. PRE-gate (substrate-as-config). Hook patch precedent: hook stays OFF
#    until 'contract toggle <gate> on' fires. Safe default.
if ! bash "$CLI" feature-status "$GATE" >/dev/null 2>&1; then
  echo "  redeploy gate '$GATE' is OFF — substrate-as-config opt-in via:"
  echo "    contract toggle $GATE on"
  echo "  result: SKIP (gate off)"
  exit 0
fi

# 2. Allow override of the contract CLI used (tests may want sandboxed home).
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "  pointer(ssh-redeploy): host=$HOST service=$SERVICE gate=$GATE ts=$TS"

# 3. Restart via ssh.
RESTART_LOG="$(mktemp)"
# shellcheck disable=SC2086
if ssh $SSH_OPTS "$HOST" "$RESTART_CMD" >"$RESTART_LOG" 2>&1; then
  RESTART_RC=0
else
  RESTART_RC=$?
fi
RESTART_OUT="$(cat "$RESTART_LOG")"
rm -f "$RESTART_LOG"

# 4. Probe the served surface (if URL provided).
PROBE_RC=0
PROBE_BODY=""
if [ -n "$PROBE" ]; then
  PROBE_LOG="$(mktemp)"
  if curl -fsS --max-time 15 --retry 3 --retry-delay 2 "$PROBE" >"$PROBE_LOG" 2>&1; then
    PROBE_RC=0
  else
    PROBE_RC=$?
  fi
  PROBE_BODY="$(head -c 200 "$PROBE_LOG")"
  rm -f "$PROBE_LOG"
fi

# 5. Append audit row to ledger (Σ1 attribution comes from contract_core).
CLI_DIR="$CLI_DIR" HOST="$HOST" SERVICE="$SERVICE" GATE="$GATE" TS="$TS" \
RESTART_RC="$RESTART_RC" PROBE_RC="$PROBE_RC" PROBE="$PROBE" \
RESTART_OUT_HEAD="$(printf '%s' "$RESTART_OUT" | head -c 200)" \
PROBE_BODY="$PROBE_BODY" python3 - <<'AUDIT_PY'
import os, sys
sys.path.insert(0, os.path.join(os.environ["CLI_DIR"], "lib"))
try:
    from contract_core import _append
except ImportError:
    sys.exit(0)
_append({
    "event": "ssh_redeploy",
    "id": f"ssh-redeploy-{os.environ['HOST']}-{os.environ['SERVICE']}",
    "host": os.environ["HOST"],
    "service": os.environ["SERVICE"],
    "gate": os.environ["GATE"],
    "restart_rc": int(os.environ["RESTART_RC"]),
    "probe_rc": int(os.environ["PROBE_RC"]),
    "probe_url": os.environ.get("PROBE") or None,
    "restart_out_head": os.environ.get("RESTART_OUT_HEAD") or "",
    "probe_body_head": os.environ.get("PROBE_BODY") or "",
    "ts": os.environ["TS"],
})
AUDIT_PY

# 6. Result.
if [ "$RESTART_RC" = "0" ] && [ "$PROBE_RC" = "0" ]; then
  echo "  restart:   OK"
  [ -n "$PROBE" ] && echo "  probe:     OK ($(printf '%s' "$PROBE_BODY" | head -c 80))"
  echo "  result: PASS (host=$HOST service=$SERVICE)"
  exit 0
fi

echo "  restart_rc: $RESTART_RC"
[ -n "$RESTART_OUT" ] && echo "  restart_log_head: $(printf '%s' "$RESTART_OUT" | head -c 200)"
if [ -n "$PROBE" ]; then
  echo "  probe_rc:   $PROBE_RC"
  echo "  probe_body_head: $PROBE_BODY"
fi
echo "  result: FAIL (host=$HOST service=$SERVICE restart_rc=$RESTART_RC probe_rc=$PROBE_RC)"
exit 1
