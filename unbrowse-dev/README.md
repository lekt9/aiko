# unbrowse-dev

A thin, credential-injecting proxy that fronts [codegraff](https://codegraff.com)'s
OpenAI-compatible gateway. Clients (e.g. `aiko-cli`) point at unbrowse and send **no
API key** — this server holds the codegraff `cg_sk_` key and injects it upstream, so
the credential never ships in the client.

## What it does

- Forwards every `/v1/*` request to `https://gateway.codegraff.com/v1/*`, streaming
  the response back unchanged (SSE token streaming works).
- Injects `Authorization: Bearer $CODEGRAFF_API_KEY` on the way out; ignores whatever
  auth (if any) the client sent.
- Rewrites a placeholder model id (`default`, `auto`, `unbrowse`, empty) to
  `DEFAULT_MODEL` on `/v1/chat/completions`, so callers never pick a model.
- Collapses `/v1/models` to a single `unbrowse-default` entry.

## Run locally

```bash
CODEGRAFF_API_KEY=cg_sk_... bun server.ts     # listens on :8787
curl -s localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"default","messages":[{"role":"user","content":"hi"}]}'
```

No `Authorization` header needed from the client — the proxy adds it.

## Deploy (Cloudflare Worker)

`unbrowse.ai` is already on Cloudflare, so the natural target is a Worker:

```bash
bun install
wrangler secret put CODEGRAFF_API_KEY   # paste the cg_sk_ key (a secret, not a var)
wrangler deploy                          # publishes src/worker.ts
```

Then route `unbrowse.ai/v1/*` to the Worker (uncomment the `[[routes]]` block in
`wrangler.toml`). Both entrypoints — `src/worker.ts` (Cloudflare) and `server.ts`
(Bun) — call the same `handleRequest` in `src/proxy.ts`.

## Config

| Var                 | Default                          | Notes                                  |
| ------------------- | -------------------------------- | -------------------------------------- |
| `CODEGRAFF_API_KEY` | —                                | **Secret.** Required. The upstream key.|
| `UPSTREAM_BASE`     | `https://gateway.codegraff.com`  | Override the upstream.                 |
| `DEFAULT_MODEL`     | `deepseek-v4-pro`                | What placeholder model ids resolve to. |
