# Aiko providers

Aiko supports any OpenAI-compatible, xAI Responses, or Anthropic Messages
endpoint through BYOK (Bring Your Own Key) model entries in `config.toml`.

## Quick start

```sh
# List currently configured providers
scripts/setup-providers.sh list

# Add a provider (appends to ~/.aiko/config.toml)
scripts/setup-providers.sh grok       # direct xAI API
scripts/setup-providers.sh codex      # OpenAI
scripts/setup-providers.sh anthropic  # Anthropic Claude
scripts/setup-providers.sh deepseek   # DeepSeek

# Use a specific model
aiko --model grok-direct
```

## Files

| File | Purpose |
|---|---|
| `config/default_models.json` | Built-in default model catalog (embedded in the Rust host at build time) |
| `docs/providers/gateway.md` | The Aiko provider gateway — OAuth-authenticated, provider-neutral inference |
| `docs/providers/byok-config.md` | Full BYOK config.toml field reference with examples |
| `scripts/setup-providers.sh` | One-command provider setup script |

## How it works

```
config.toml [model.<id>]   →   credential resolution   →   sampler config   →   API request
       │                              │                         │                   │
  base_url                    api_key/env_key           api_backend            POST /v1/...
  env_key                     session token             auth_scheme            Auth header
  api_backend                 XAI_API_KEY fallback      extra_headers          streaming SSE
```

### Credential priority

1. `model.api_key` (plaintext — not recommended)
2. `model.env_key` (first set, non-blank env var wins)
3. OAuth session token (from `aiko login`)
4. `XAI_API_KEY` env var (fallback for default endpoint)

### API backends

| Backend | Endpoint | Providers |
|---|---|---|
| `chat_completions` | `/v1/chat/completions` | OpenAI, xAI, DeepSeek, most |
| `responses` | `/v1/responses` | xAI Responses API |
| `messages` | `/v1/messages` | Anthropic |

### Auth schemes

| Scheme | Header | Providers |
|---|---|---|
| `bearer` (default) | `Authorization: Bearer <key>` | OpenAI, xAI, DeepSeek |
| `x_api_key` | `x-api-key: <key>` | Anthropic |

## Provider gateway (default)

Without any `[model.*]` entries, Aiko routes through the authenticated provider
gateway at `https://aiko.theclarityproject.net/v1`. The gateway owns upstream
credentials and accounts usage to the OAuth bearer token. Clients never receive
an upstream API key. See `gateway.md` for the full specification.
