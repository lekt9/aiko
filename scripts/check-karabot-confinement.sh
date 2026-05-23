#!/usr/bin/env bash
# Corpus audit — every send_message / sendMessage call targeting the
# algamer/eggsy/lekt9 supergroup (-1003661261221, or legacy -5137678004)
# must carry message_thread_id=2738 (the Karabot topic) within the same
# call. A bare send to the group is a confinement violation.
#
# This is the mechanical binding of the standing rule (contract 0c3fcd65,
# parent f85216af).
set -u

KARABOT_TOPIC=${KARABOT_TOPIC_ID:-2738}
SCOPE="$HOME/Projects"

# Strict-mode IDs (numeric, no whitespace ambiguity). Both the current
# supergroup and the legacy basic-group id from the 2026-05-23 migration.
GROUP_IDS=(-1003661261221 -5137678004 1003661261221 5137678004)

# Files we DON'T want to scan: third-party caches, archived/historical dirs,
# raw chat-history captures (those record incoming messages, not outgoing).
EXCLUDE_RE='(/node_modules/|/\.archived/|/archive/|/\.git/|/dist/|/build/|/tool-results/|aiko-v2/fractal-cells/archive|tmp_lekt9_chats|raw_tool_model\.json|mined_reasoning_patterns\.json|home-extension-manifest\.json|history\.jsonl|/research/|/sundayservice/|/bible-significance-plan/|CLAUDE\.md|README\.md)'

# Collect candidate violators: any file that mentions a group id AND contains
# send_message / sendMessage / send_text / bot.sendMessage style call.
violators=()
candidates=$(
  for gid in "${GROUP_IDS[@]}"; do
    grep -rlE "$gid" "$SCOPE" 2>/dev/null
  done | sort -u | grep -vE "$EXCLUDE_RE" || true
)

if [ -z "$candidates" ]; then
  echo "  ✓ no candidate files reference the algamer/eggsy group ids"
  exit 0
fi

for f in $candidates; do
  # Does this file actually look like it SENDS to the group (vs just listing
  # it in docs or a tour artifact)? Heuristic: it contains a Telegram send
  # primitive somewhere in the file.
  if ! grep -qE '(send_message|sendMessage|sendText|sendPhoto|sendVideo|api\.telegram\.org/bot[^/]+/(sendMessage|sendPhoto|sendVideo))' "$f" 2>/dev/null; then
    continue
  fi
  # Within the file, look for any line that mentions a group id WITHOUT a
  # message_thread_id in the same call. Approximate: line OR within 4 lines.
  bad=$(awk -v IDS="-1003661261221|-5137678004|1003661261221|5137678004" -v TID="$KARABOT_TOPIC" '
    BEGIN { hits=0 }
    {
      lines[NR] = $0
    }
    END {
      for (i = 1; i <= NR; i++) {
        line = lines[i]
        if (line ~ IDS) {
          # Window: this line + next 4 lines (typical multi-line send body).
          ctx = line
          for (j = 1; j <= 4 && (i+j) <= NR; j++) ctx = ctx "\n" lines[i+j]
          if (ctx !~ ("message_thread_id[^0-9]*" TID) && ctx !~ ("KARABOT_TOPIC_ID")) {
            printf("    %d: %s\n", i, line)
            hits++
          }
        }
      }
      exit (hits > 0 ? 1 : 0)
    }
  ' "$f")
  if [ -n "$bad" ]; then
    echo "  ✗ $f"
    echo "$bad" | head -6
    violators+=("$f")
  fi
done

if [ "${#violators[@]}" -eq 0 ]; then
  echo "  ✓ all live bot files that touch the algamer/eggsy supergroup confine to message_thread_id=$KARABOT_TOPIC"
  exit 0
fi
echo ""
echo "  ✗ ${#violators[@]} file(s) violate karabot-confinement (must include message_thread_id=$KARABOT_TOPIC on every send to -1003661261221)"
exit 1
