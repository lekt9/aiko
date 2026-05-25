#!/usr/bin/env bash
# channels.sh — emit the user's contact-channel registry as JSON.
#
# Each channel is a contract neuron with:
#   - id          contract-shape id (channel:<kind>:<addr>)
#   - kind        telegram | x-dm | email | session | push
#   - addr        bot-handle or user-handle or email
#   - posthook    the actual send-endpoint (URL or script path)
#   - status      live | quiet | down (best-effort liveness check)
#
# Discovery surfaces queried (best-effort, never fatal):
#   - ~/.contracts/people/lewis/channels.json — canonical user registry
#   - Hardcoded fallback for the canonical Lewis channels below
#
# Output: JSON array on stdout. Consumed by pick-channel.sh.

set -uo pipefail

REGISTRY="$HOME/.contracts/people/lewis/channels.json"

if [[ -f "$REGISTRY" ]]; then
  cat "$REGISTRY"
  exit 0
fi

# Hardcoded fallback — the canonical Lewis (lewistham9x@gmail.com) channels.
# Each entry is contract-shaped: declared once via `aiko "channel:<id>"`
# then resolved here. The agent that ships an escalation reads this list,
# picks one via pick-channel.sh, and fires the posthook.
cat <<'JSON'
[
  {
    "id": "channel:claude-code-session",
    "kind": "session",
    "addr": "current-thread",
    "posthook": "stdout",
    "status": "live",
    "weight": 100,
    "notes": "Highest priority: when the user is actively in this thread, reply in-thread."
  },
  {
    "id": "channel:telegram:lekt8",
    "kind": "telegram",
    "addr": "@lekt8",
    "posthook": "~/.claude/skills/contract/scripts/send-telegram.sh",
    "status": "live",
    "weight": 80,
    "notes": "Aiko Telegram bot. Most-checked channel. Default for async escalations."
  },
  {
    "id": "channel:telegram:getfoundry",
    "kind": "telegram",
    "addr": "@getFoundry",
    "posthook": "~/.claude/skills/contract/scripts/send-telegram.sh",
    "status": "live",
    "weight": 60,
    "notes": "getFoundry bot — for project-shaped escalations specifically about Foundry."
  },
  {
    "id": "channel:x-dm:lekt8_",
    "kind": "x-dm",
    "addr": "@lekt8_",
    "posthook": "x-cli dm send",
    "status": "quiet",
    "weight": 40,
    "notes": "X DMs to founder handle. Quiet because X DM API is sometimes rate-limited."
  },
  {
    "id": "channel:x-dm:getfoundry",
    "kind": "x-dm",
    "addr": "@getFoundry",
    "posthook": "x-cli dm send",
    "status": "quiet",
    "weight": 30,
    "notes": "X DMs to project handle."
  },
  {
    "id": "channel:email:lewistham9x",
    "kind": "email",
    "addr": "lewistham9x@gmail.com",
    "posthook": "~/.claude/skills/resend-cli/send.sh",
    "status": "live",
    "weight": 20,
    "notes": "Email via Resend. Lowest priority for real-time escalations; highest for permanent record."
  },
  {
    "id": "channel:push-notification",
    "kind": "push",
    "addr": "ide",
    "posthook": "PushNotification tool",
    "status": "live",
    "weight": 90,
    "notes": "When user has the IDE/Claude Code open but isn't in this thread. Tool-side, not channel-side."
  }
]
JSON
