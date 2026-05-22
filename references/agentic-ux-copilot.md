# Agentic UX — the standing default for /contract-built sites

Every site shipped through `/contract` that has a web UI embeds an
**agentic copilot** by default. The copilot's tools are the site's own
indexed APIs; its knowledge is the site's own indexed static page
content. The site becomes self-explaining and self-operating: a visitor
asks, the copilot answers from live data and real page content.

This is not a bolt-on chatbot. It is the same truth-telling discipline
the contract primitive enforces, applied to the end user: the copilot
only ever surfaces what the site **declares** (its OpenAPI surface) and
what the site **actually says** (its indexed pages). It never invents.

## Architecture (pointer-not-payload, invariant)

All intelligence is server-side. The client embed is empty of value.

```
copilot.config.json   ──▶  index-site.mjs  ──▶  copilot-registry.json
  (declares the surface)     (build-time)         (server-held registry)
                                                       │
browser embed  ──POST messages──▶  /copilot/chat  ──loads registry──┘
  (opaque pointer only)             (Claude agent loop, server-side)
                                     ├─ executes API tools (real fetch)
                                     └─ searches indexed page content
```

- **`copilot.config.json`** — the declarant's surface. `openapi` (API
  spec → one tool per operation) + `pages` (sources → text chunks) +
  `systemPrompt`. The declarant expresses what the copilot may touch;
  the substrate never synthesizes a tool that was not declared.
- **`index-site.mjs`** — build-time indexer. Parses the OpenAPI into
  tool definitions; strips page sources (`.tsx/.jsx/.html/.md` or URLs)
  into chunks. Emits `copilot-registry.json`. Tells the truth about the
  config; adds nothing.
- **`/copilot/chat`** — the server. Loads the registry, runs the Claude
  agentic loop, executes tool calls (real same-origin `fetch` to the
  site's APIs; keyword search over chunks), returns reply + tool trace.
  Runs inference on the keyless Cloudflare Workers AI binding (`env.AI`)
  — no API key, nothing to provision, nothing to pay an LLM vendor.
- **client embed** — a chat panel. Holds only the endpoint path. Zero
  copilot logic. Fully decompiled it reveals a transport, nothing more.

## Reference implementation

`getfoundry.app` is the canonical reference. Copy and adapt:

| File | Role |
|---|---|
| `fdry/frontend/copilot.config.json` | declared surface |
| `fdry/frontend/public/openapi.json` | the indexable API spec |
| `fdry/scripts/copilot/index-site.mjs` | build-time indexer |
| `fdry/frontend/functions/copilot/chat.ts` | server-held agent loop |
| `fdry/frontend/functions/api/vaults.ts` | an example indexable API |
| `fdry/frontend/src/components/Copilot.tsx` | thin client embed |

Wiring: add `index-site.mjs` to the build script before `vite build`
(so the registry lands in `public/` → `dist/`), gitignore the generated
`copilot-registry.json`, mount `<Copilot />` once at the app root, set
the `ANTHROPIC_API_KEY` deploy secret.

## Why this is a contract, not a feature

A site that ships without the copilot has a **truth-telling gap**: it
has declared APIs and real content a visitor cannot reach
conversationally. The default closes that gap at its source. Declaring
the organ `agentic UX for every /contract-built site` and driving its
children to satisfied is how the default stays real rather than
aspirational.
