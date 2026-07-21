# Generative UI — durable, pointer-bound, contract-checkable

Aiko does **not** treat generative UI as throwaway chat chrome. Every complete
`json-render` block is stored, addressable, and re-openable.

## Pointers (API-like traversal)

| Pointer | Resolves to |
|---------|-------------|
| `aiko:ui/<id>` | Full component `{ meta, spec, state, bindings }` |
| `aiko:ui/<id>/spec` | Spec only |
| `aiko:ui/<id>/state` | Materialized state |
| `aiko:ui/<id>/bindings` | Pointer map |
| `aiko:ui/<id>/meta` | Metadata |
| `aiko:data/<sha256>` | Content-addressed JSON blob |
| `aiko:ui/<id>/state#/path` | Fragment within state |

## On-disk layout (`~/.aiko/ui`)

```
index.jsonl                 # append-only catalog
routes.json                 # /ui/<slug> → id
by-id/<id>/
  meta.json
  spec.json
  state.json
  bindings.json
data/<hh>/<sha256>.json     # content-addressed payloads
```

Contract check for a surface:

```bash
test -f ~/.aiko/ui/by-id/<id>/spec.json
```

Register after save:

```bash
contract task begin "ui:Revenue board" --check "test -f ~/.aiko/ui/by-id/<id>/spec.json"
```

## Desktop

- Chat: renders + **auto-persists** complete blocks
- **Surfaces** (⌘4): library, routes, reopen with bound state
- Tauri commands: `ui_store_{list,get,put,put_data,resolve,routes,root}`

## Agent

System prompt section `<generative_ui>` requires durable fences, titles, and
pointer-aware state. Catalog guide: `generativeUiAgentGuide()`.
