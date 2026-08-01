#!/bin/sh
# setup-providers.sh — configure BYOK LLM providers in ~/.aiko/config.toml
#
# Usage:
#   scripts/setup-providers.sh                    # interactive
#   scripts/setup-providers.sh grok               # configure grok (direct xAI)
#   scripts/setup-providers.sh codex              # configure codex (OpenAI)
#   scripts/setup-providers.sh anthropic          # configure Claude (Anthropic)
#   scripts/setup-providers.sh deepseek           # configure DeepSeek
#   scripts/setup-providers.sh list               # show configured providers
#
# This script appends [model.<id>] entries to config.toml. It does NOT
# overwrite existing entries — edit config.toml by hand to change them.
set -eu

CONFIG="${AIKO_HOME:-$HOME/.aiko}/config.toml"

PROVIDERS="grok codex anthropic deepseek"

usage() {
    cat <<EOF
Usage: $0 [provider]

Providers:
  grok       Direct xAI API (api.x.ai) — needs XAI_API_KEY
  codex      OpenAI API — needs OPENAI_API_KEY
  anthropic  Anthropic Messages API — needs ANTHROPIC_API_KEY
  deepseek   DeepSeek API — needs DEEPSEEK_API_KEY
  list       Show currently configured [model.*] entries

The script appends to $CONFIG.
Existing entries are never overwritten — edit the file to change them.
EOF
}

show_providers() {
    if [ ! -f "$CONFIG" ]; then
        echo "No config.toml at $CONFIG"
        return 1
    fi
    echo "Configured providers in $CONFIG:"
    grep '^\[model\.' "$CONFIG" 2>/dev/null || echo "  (none)"
    echo ""
    echo "Default model:"
    grep '^default' "$CONFIG" 2>/dev/null | head -1 || echo "  (not set)"
}

add_grok() {
    cat >> "$CONFIG" <<'TOML'

[model.grok-direct]
model = "grok-4"
base_url = "https://api.x.ai/v1"
api_backend = "responses"
context_window = 200000
env_key = ["XAI_API_KEY", "LC_XAI_API_KEY"]
agent_type = "grok-build"
TOML
    echo "Added [model.grok-direct] — set XAI_API_KEY in your environment."
    echo "  export XAI_API_KEY=..."
    echo "  aiko --model grok-direct"
}

add_codex() {
    cat >> "$CONFIG" <<'TOML'

[model.codex]
model = "codex"
base_url = "https://api.openai.com/v1"
api_backend = "chat_completions"
context_window = 200000
env_key = "OPENAI_API_KEY"
agent_type = "codex"
TOML
    echo "Added [model.codex] — set OPENAI_API_KEY in your environment."
    echo "  export OPENAI_API_KEY=..."
    echo "  aiko --model codex"
}

add_anthropic() {
    cat >> "$CONFIG" <<'TOML'

[model.claude]
model = "claude-sonnet-4-20250514"
base_url = "https://api.anthropic.com/v1"
api_backend = "messages"
auth_scheme = "x_api_key"
context_window = 200000
env_key = "ANTHROPIC_API_KEY"
extra_headers = { "anthropic-version" = "2023-06-01" }
agent_type = "grok-build"
TOML
    echo "Added [model.claude] — set ANTHROPIC_API_KEY in your environment."
    echo "  export ANTHROPIC_API_KEY=..."
    echo "  aiko --model claude"
}

add_deepseek() {
    cat >> "$CONFIG" <<'TOML'

[model.deepseek]
model = "deepseek-chat"
base_url = "https://api.deepseek.com/v1"
api_backend = "chat_completions"
context_window = 64000
env_key = "DEEPSEEK_API_KEY"
TOML
    echo "Added [model.deepseek] — set DEEPSEEK_API_KEY in your environment."
    echo "  export DEEPSEEK_API_KEY=..."
    echo "  aiko --model deepseek"
}

CMD=${1:-}
case "$CMD" in
    grok)       add_grok ;;
    codex)      add_codex ;;
    anthropic)  add_anthropic ;;
    deepseek)   add_deepseek ;;
    list)       show_providers ;;
    -h|--help|help|"") usage ;;
    *) echo "Unknown provider: $CMD" >&2; usage >&2; exit 2 ;;
esac
