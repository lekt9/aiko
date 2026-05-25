#!/usr/bin/env bash
# ship-to-channel.sh — route an escalation payload to the contact channel
# that pick-channel.sh chose.
#
# Channel-id is a contract neuron id of shape `channel:<kind>:<addr>`.
# Each known channel dispatches to its real send-endpoint:
#
#   channel:claude-code-session      → stdout (the orchestrator reads it
#                                       next turn as in-thread context)
#   channel:telegram:lekt8           → aiko-tg-send <chat_id> <payload>
#   channel:telegram:getfoundry      → aiko-tg-send <chat_id> <payload>
#   channel:x-dm:lekt8_              → x-cli dm send @lekt8_ <payload>
#   channel:x-dm:getfoundry          → x-cli dm send @getFoundry <payload>
#   channel:email:lewistham9x        → resend send
#   channel:push-notification        → emits the PushNotification-formatted
#                                       JSON to stdout; orchestrator picks it up
#
# Usage:
#   ship-to-channel.sh <channel-id> <payload>
#   echo "<payload>" | ship-to-channel.sh <channel-id> -
#
# Returns 0 on successful ship, 1 on channel-specific failure, 2 on unknown
# channel-id. Every ship appends a row to ~/.contracts/channel-ships.jsonl
# so the iterate loop can read prior ships and avoid double-pinging.

set -uo pipefail

CHANNEL_ID="${1:-}"
PAYLOAD="${2:-}"

if [[ -z "$CHANNEL_ID" ]]; then
  echo "usage: ship-to-channel.sh <channel-id> <payload | ->" >&2
  exit 2
fi

if [[ "$PAYLOAD" == "-" ]]; then
  PAYLOAD="$(cat)"
fi

LEDGER="$HOME/.contracts/channel-ships.jsonl"
mkdir -p "$(dirname "$LEDGER")"

# Lewis's known Telegram chat ids (cached for the canonical channels).
# Lookup is a contract-shaped indirection: real address pinned in
# ~/.contracts/people/lewis/telegram-chats.json when discovered;
# fallback to env vars for now.
TG_CHAT_LEKT8="${TG_CHAT_LEKT8:-}"
TG_CHAT_GETFOUNDRY="${TG_CHAT_GETFOUNDRY:-}"

ship_log() {
  local channel="$1" status="$2" preview="$3"
  printf '{"ts":"%s","channel":"%s","status":"%s","bytes":%d,"preview":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$channel" \
    "$status" \
    "${#PAYLOAD}" \
    "$(printf '%s' "$preview" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:200]))')" \
    >> "$LEDGER"
}

case "$CHANNEL_ID" in
  channel:claude-code-session)
    # Stdout = the orchestrator's next-turn context. Prefix with a sentinel
    # so the orchestrator's parser knows this is an escalation payload.
    printf '\n=== ESCALATION (channel:claude-code-session) ===\n%s\n=== END ESCALATION ===\n' "$PAYLOAD"
    ship_log "$CHANNEL_ID" "shipped" "$PAYLOAD"
    ;;

  channel:telegram:lekt8|channel:telegram:getfoundry)
    addr_for() {
      case "$1" in
        channel:telegram:lekt8)      printf '%s' "${TG_CHAT_LEKT8:-}";;
        channel:telegram:getfoundry) printf '%s' "${TG_CHAT_GETFOUNDRY:-}";;
      esac
    }
    chat_id="$(addr_for "$CHANNEL_ID")"
    if [[ -z "$chat_id" ]]; then
      # try the discovery cache
      cache="$HOME/.contracts/people/lewis/telegram-chats.json"
      if [[ -f "$cache" ]]; then
        key="${CHANNEL_ID#channel:telegram:}"
        chat_id="$(python3 -c "import json; d=json.load(open('$cache')); print(d.get('$key',''))" 2>/dev/null || true)"
      fi
    fi
    if [[ -z "$chat_id" ]]; then
      echo "ship-to-channel: $CHANNEL_ID has no chat_id (set TG_CHAT_LEKT8 / TG_CHAT_GETFOUNDRY or populate ~/.contracts/people/lewis/telegram-chats.json)" >&2
      ship_log "$CHANNEL_ID" "no_chat_id" "$PAYLOAD"
      exit 1
    fi
    if ~/.claude/skills/aiko/scripts/aiko-tg-send "$chat_id" "$PAYLOAD" >&2; then
      ship_log "$CHANNEL_ID" "shipped" "$PAYLOAD"
    else
      ship_log "$CHANNEL_ID" "send_failed" "$PAYLOAD"
      exit 1
    fi
    ;;

  channel:x-dm:lekt8_|channel:x-dm:getfoundry)
    handle="${CHANNEL_ID#channel:x-dm:}"
    if command -v x-cli >/dev/null 2>&1; then
      if echo "$PAYLOAD" | x-cli dm send "@${handle}" - >&2; then
        ship_log "$CHANNEL_ID" "shipped" "$PAYLOAD"
      else
        ship_log "$CHANNEL_ID" "send_failed" "$PAYLOAD"
        exit 1
      fi
    else
      echo "ship-to-channel: x-cli not on PATH" >&2
      ship_log "$CHANNEL_ID" "x_cli_missing" "$PAYLOAD"
      exit 1
    fi
    ;;

  channel:email:lewistham9x)
    if command -v resend >/dev/null 2>&1; then
      printf '%s' "$PAYLOAD" | resend send --to lewistham9x@gmail.com --subject "Aiko escalation: substrate HOLD" --stdin >&2 && \
        ship_log "$CHANNEL_ID" "shipped" "$PAYLOAD" || { ship_log "$CHANNEL_ID" "send_failed" "$PAYLOAD"; exit 1; }
    else
      echo "ship-to-channel: resend not on PATH; falling back to log only" >&2
      ship_log "$CHANNEL_ID" "no_transport" "$PAYLOAD"
      exit 1
    fi
    ;;

  channel:push-notification)
    # PushNotification is an orchestrator-side primitive. Emit a JSON payload
    # the orchestrator can read + invoke directly.
    cat <<JSON
{"action":"push_notification","title":"Aiko escalation","body":$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()[:200]))')}
JSON
    ship_log "$CHANNEL_ID" "queued_for_orchestrator" "$PAYLOAD"
    ;;

  *)
    echo "ship-to-channel: unknown channel id: $CHANNEL_ID" >&2
    ship_log "$CHANNEL_ID" "unknown" "$PAYLOAD"
    exit 2
    ;;
esac
