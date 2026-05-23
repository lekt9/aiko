#!/usr/bin/env bash
# deepwiki source: when topic looks like "org/repo", attempt to fetch
# wiki contents via the deepwiki MCP. Substrate has no direct MCP call
# from a shell script — so this source emits a SOURCE-HINT envelope
# telling the orchestrating agent which MCP call to make and what to
# pipe back via --from-stdin --refresh.
#
# Non-binding: when topic isn't org/repo shaped, exits 1 silently and
# the orchestrator falls through to the next source.
set -e

TOPIC="${1:-${CONTEXT_TOPIC:-}}"
SLUG="${CONTEXT_SLUG:-topic}"

# Heuristic: only fire on org/repo style
case "$TOPIC" in
  */* ) ;;
  * ) exit 1 ;;
esac

# Sanity: not a path with too many slashes (org/repo only)
N_SLASH=$(printf '%s' "$TOPIC" | tr -cd '/' | wc -c | tr -d ' ')
[ "$N_SLASH" = "1" ] || exit 1

python3 - "$TOPIC" "$SLUG" <<'PY'
import json, sys
topic, slug = sys.argv[1], sys.argv[2]
env = {
    "topic": topic,
    "slug": slug,
    "source": "deepwiki",
    "body": (
        f"DeepWiki MCP can fetch context for {topic!r}.\n"
        "The agent should call mcp__deepwiki__read_wiki_contents or "
        f"mcp__deepwiki__ask_question with repo='{topic}', capture the "
        "result, then re-cache it with:\n"
        f"  cat <deepwiki-output> | contract context-of '{topic}' "
        "--from-stdin --refresh\n"
        "This source is intentionally a HINT — the substrate doesn't "
        "carry MCP credentials; the agent does."
    ),
    "refs": [f"https://deepwiki.com/{topic}", f"https://github.com/{topic}"],
    "hint_mcp_call": {
        "tool": "mcp__deepwiki__read_wiki_contents",
        "args": {"repoName": topic},
    },
}
print(json.dumps(env))
PY
