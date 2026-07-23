# Aiko provider gateway

Aiko clients authenticate to `https://aiko.theclarityproject.net` using OAuth
2.1 Authorization Code with PKCE. They send that access token to the Aiko API;
they never connect to Codegraff directly and never receive an upstream API key.

## Required public endpoints

- `GET /.well-known/openid-configuration`
- `GET /oauth2/authorize`
- `POST /oauth2/token`
- `POST /oauth2/device/code` (for terminal/device login)
- `GET /v1/models`
- `POST /v1/chat/completions`

The Cloudflare adapter at `prod/cf/openai-proxy` transparently forwards the
complete `/v1` API surface, including Responses, streaming SSE, Realtime
WebSockets, multipart file/audio requests, uploads, batches, images,
embeddings, fine-tuning, assistants/threads, vector stores, and future OpenAI
endpoints. It accepts `/openai/v1/*` as an alias and preserves query strings,
OpenAI feature/idempotency headers, request IDs, rate-limit headers, and
upstream status codes. Client credentials and accounting identity headers are
always replaced with trusted server-side values.

Register `aiko-cli` as a public client. Allow loopback redirect URIs and require
PKCE. The default scopes requested by the client are `openid`, `profile`,
`email`, `offline_access`, `aiko:access`, `api:access`, and the Aiko
conversation/workspace scopes.

## Provider routing

The gateway validates the Aiko bearer token, derives the user from the verified
token subject, records usage against that user, and then selects an upstream
provider from its server-side model registry. Do not trust `x-userid` or other
client-supplied identity headers for accounting.

For Codegraff, keep `CODEGRAFF_API_KEY` only on the server and forward an
OpenAI-compatible request to:

```text
POST https://gateway.codegraff.com/v1/chat/completions
Authorization: Bearer ${CODEGRAFF_API_KEY}
```

`deepseek-v4-pro` is Aiko's client-side fallback and should also be the first
or explicitly selected default in the server model catalog.

The models response may be a standard OpenAI list. Aiko also understands the
optional routing metadata shown here:

```json
{
  "data": [
    {
      "id": "deepseek-v4-pro",
      "model": "deepseek-v4-pro",
      "name": "DeepSeek V4 Pro",
      "description": "Codegraff",
      "contextWindow": 1000000,
      "apiBackend": "chat_completions",
      "baseUrl": "https://aiko.theclarityproject.net/v1"
    }
  ]
}
```

Additional providers require only another server-side registry entry and
adapter. The client continues to use the Aiko OAuth token and the same
OpenAI-compatible gateway surface.
