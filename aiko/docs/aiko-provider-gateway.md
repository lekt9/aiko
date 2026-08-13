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

Codegraff is the **only** upstream. Keep its key on the server:

```text
POST https://gateway.codegraff.com/v1/chat/completions
Authorization: Bearer ${CODEGRAFF_API_KEY}
```

A missing `CODEGRAFF_API_KEY` is a 503, not a fallback to some other vendor.
Failing over to a second provider would keep the gateway serving while looking
healthy, which is the one failure nobody notices from outside.

## The model gate: one published id

The gateway publishes **exactly one model id, `best`**, and binds it
server-side to a concrete upstream slug (`BEST_MODEL` / `DEFAULT_MODEL` in the
worker's config; today `muse-spark-1.2-contributor`). Three things follow, and
they are the point of the gate:

1. **Re-pointing `best` at a newer model is a var change plus a deploy.** Every
   installed client follows without updating. A client that hard-coded the
   upstream slug would keep pinning yesterday's model after the binding moved.
2. **`/v1/models` is synthesized, never proxied.** Returning the upstream's full
   catalog would list models the gate then refuses — the listing and the routing
   would disagree about what Aiko serves.
3. **An id the catalog does not publish is refused with 400, not forwarded.**
   The one exception is a compatibility set (`deepseek-v4-pro`,
   `deepseek-v4-flash`, `kimi-k3`, `auto`, `default`, empty) that older
   installed clients still send; those resolve to the bound model. Dropping an
   entry from that set breaks every client pinned to it until it updates.

`best` exists **only inside this worker**. A caller holding a direct Codegraff
key must name the upstream slug outright — sending `best` to
`gateway.codegraff.com` is a 400. That is why `xai_aiko_providers` carries both
`GATEWAY_MODEL` (`best`, session path) and `GATEWAY_UPSTREAM_MODEL` (the slug,
direct-key path).

The models response is a standard OpenAI list carrying the optional routing
metadata Aiko understands:

```json
{
  "object": "list",
  "data": [
    {
      "id": "best",
      "model": "best",
      "name": "Best",
      "contextWindow": 1048576,
      "apiBackend": "chat_completions",
      "baseUrl": "https://aiko.theclarityproject.net/v1"
    }
  ]
}
```

Additional providers require only another server-side registry entry and
adapter. The client continues to use the Aiko OAuth token and the same
OpenAI-compatible gateway surface.
