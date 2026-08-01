# BYOK provider configuration

Bring Your Own Key (BYOK) lets you route Aiko to any OpenAI-compatible,
Anthropic-compatible, or xAI Responses-API endpoint by declaring `[model.<id>]`
entries in `~/.aiko/config.toml`. The Rust host reads these at startup and
resolves credentials per request.

## Credential resolution priority

```
1. model.api_key        (plaintext in config — not recommended for shared machines)
2. model.env_key         (first set, non-blank env var wins)
3. session OAuth token   (when authenticated via `aiko login`)
4. XAI_API_KEY           (fallback env var for the default xAI endpoint)
```

When `env_key` lists multiple names, the **first set, non-blank** value wins.
This supports SSH `AcceptEnv LC_*` forwarding of secrets.

## api_backend

| Value | Endpoint shape | Use for |
|---|---|---|
| `chat_completions` (default) | `POST /v1/chat/completions` | OpenAI, xAI, DeepSeek, most providers |
| `responses` | `POST /v1/responses` | xAI Responses API |
| `messages` | `POST /v1/messages` | Anthropic |

## auth_scheme

| Value | Header | Use for |
|---|---|---|
| `bearer` (default) | `Authorization: Bearer <key>` | OpenAI, xAI, DeepSeek |
| `x_api_key` | `x-api-key: <key>` | Anthropic (when not using Messages API native auth) |

## Example: grok-build (default, via Aiko gateway)

```toml
[models]
default = "grok-build"

# No [model.grok-build] entry needed — the built-in default routes through
# the Aiko provider gateway at https://aiko.theclarityproject.net/v1
# using the OAuth session token.
```

## Example: codex (OpenAI-compatible)

```toml
[model.codex]
model = "codex"
base_url = "https://api.openai.com/v1"
api_backend = "chat_completions"
context_window = 200000
env_key = "OPENAI_API_KEY"
agent_type = "codex"
```

## Example: grok (direct xAI API, BYOK)

```toml
[model.grok-direct]
model = "grok-4"
base_url = "https://api.x.ai/v1"
api_backend = "responses"
context_window = 200000
env_key = ["XAI_API_KEY", "LC_XAI_API_KEY"]
agent_type = "grok-build"
```

## Example: anthropic (Messages API)

```toml
[model.claude]
model = "claude-sonnet-4-20250514"
base_url = "https://api.anthropic.com/v1"
api_backend = "messages"
auth_scheme = "x_api_key"
context_window = 200000
env_key = "ANTHROPIC_API_KEY"
extra_headers = { "anthropic-version" = "2023-06-01" }
agent_type = "grok-build"
```

## Example: deepseek (OpenAI-compatible)

```toml
[model.deepseek]
model = "deepseek-chat"
base_url = "https://api.deepseek.com/v1"
api_backend = "chat_completions"
context_window = 64000
env_key = "DEEPSEEK_API_KEY"
```

## Full field reference

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | yes | The routing slug sent in API requests |
| `base_url` | string | yes | Provider base URL (e.g. `https://api.x.ai/v1`) |
| `context_window` | integer | yes | Total context window in tokens |
| `api_backend` | enum | no | `chat_completions` (default), `responses`, `messages` |
| `auth_scheme` | enum | no | `bearer` (default), `x_api_key` |
| `api_key` | string | no | Plaintext API key (prefer `env_key`) |
| `env_key` | string or array | no | Env var name(s) for the API key (first set wins) |
| `name` | string | no | Human-readable display name |
| `description` | string | no | Model description |
| `temperature` | float | no | Sampling temperature |
| `top_p` | float | no | Nucleus sampling probability |
| `max_completion_tokens` | integer | no | Max output tokens |
| `agent_type` | string | no | System prompt identity (`grok-build`, `codex`, etc.) |
| `extra_headers` | table | no | Extra HTTP headers (e.g. `anthropic-version`) |
| `hidden` | bool | no | Exclude from model picker (still usable internally) |
| `supported_in_api` | bool | no | Show in API model picker (default true) |
| `use_concise` | bool | no | Use concise mode (compact system prompt) |
| `inference_idle_timeout_secs` | integer | no | Per-chunk SSE timeout (default 300) |
| `max_retries` | integer | no | Max transient-error retries (default 5) |
| `reasoning_effort` | string | no | Reasoning effort level for reasoning models |
| `stream_tool_calls` | bool | no | Inject `stream_tool_calls: true` for per-chunk deltas |
| `api_base_url` | string | no | Separate base URL for API-key auth vs session auth |

## Default model catalog

The built-in defaults are in `config/default_models.json`. The `default` field
selects the primary model; `web_search`, `image_description`, and
`session_summary` fall back to `default` when not specified.

Resolution precedence at runtime:
```
CLI flag > ENV var > config.toml > remote settings > default_models.json
```
