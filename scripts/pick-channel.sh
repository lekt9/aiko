#!/usr/bin/env bash
# pick-channel.sh — pick the best contact channel for the user RIGHT NOW.
#
# Inputs (all optional, sane defaults):
#   --urgency  low|normal|high   (default: normal)
#   --kind     hint-of-content-shape: status|question|alert|delivery (default: status)
#   --json     emit full picked channel JSON (default: emit just the id)
#
# Algorithm (substrate-faithful — composable, no judgment baked in):
#   1. Read channels.sh registry
#   2. Filter by status != "down"
#   3. Score each channel:
#        score = weight + situational_bonus
#      where situational_bonus depends on:
#        - urgency=high: push-notification + telegram +20, email -30
#        - kind=question: session +30 (questions belong in-thread)
#        - time-of-day in user's TZ (Asia/Singapore for Lewis):
#          - session work-hours (08-22 SGT): session +20
#          - asleep (00-07 SGT): telegram +0, email +10, push -50
#          - off-hours (22-00, 07-08): telegram +10
#   4. Pick the highest-scoring live channel
#   5. Emit the channel id (default) or the full JSON (--json)
#
# Designed to be wrapped by aiko: each pick is itself a contract:
#   aiko "channel:pick urgency=<u> kind=<k>" --local
# records the pick on the local ledger, which lets the next iteration
# learn from outcomes (did the user respond? did they pick a different
# channel?).

set -uo pipefail

URGENCY="normal"
KIND="status"
EMIT_JSON="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --urgency) URGENCY="$2"; shift 2 ;;
    --kind)    KIND="$2"; shift 2 ;;
    --json)    EMIT_JSON="true"; shift ;;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

CHANNELS_SCRIPT="${BASH_SOURCE%/*}/channels.sh"
if [[ ! -x "$CHANNELS_SCRIPT" ]]; then
  echo "missing channels.sh at $CHANNELS_SCRIPT" >&2
  exit 2
fi

# Time-of-day in Lewis's TZ (Asia/Singapore = SGT).
HOUR_SGT=$(TZ=Asia/Singapore date +%H)

python3 - "$URGENCY" "$KIND" "$HOUR_SGT" "$EMIT_JSON" "$CHANNELS_SCRIPT" <<'PY'
import json, subprocess, sys
urgency, kind, hour_str, emit_json, channels_script = sys.argv[1:]
hour = int(hour_str)
emit_json = (emit_json == "true")

raw = subprocess.run(["bash", channels_script], capture_output=True, text=True, check=True).stdout
channels = json.loads(raw)
channels = [c for c in channels if c.get("status") != "down"]

def score(c):
    s = c.get("weight", 0)
    kind_id = c.get("kind", "")
    cid = c.get("id", "")
    # urgency
    if urgency == "high":
        if kind_id in ("push", "telegram"): s += 20
        if kind_id == "email": s -= 30
    elif urgency == "low":
        if kind_id == "email": s += 10
    # content kind
    if kind == "question":
        if cid == "channel:claude-code-session": s += 30
    if kind == "alert":
        if kind_id == "push": s += 20
    # time-of-day in SGT
    if 8 <= hour < 22:  # work hours
        if cid == "channel:claude-code-session": s += 20
    elif 0 <= hour < 7:  # asleep
        if kind_id == "telegram": s += 0  # silent telegram still ok
        if kind_id == "email": s += 10
        if kind_id == "push": s -= 50
    else:  # 22-00, 7-08 off-hours
        if kind_id == "telegram": s += 10
    c["_score"] = s
    return s

channels.sort(key=score, reverse=True)
pick = channels[0] if channels else None

if pick is None:
    sys.exit(3)

if emit_json:
    print(json.dumps(pick, indent=2))
else:
    print(pick["id"])
PY
