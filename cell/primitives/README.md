# Primitives — fixed cells that ship with the harness

> Maximal action space, then restrict. The spec stays minimal (`Cell = membrane + (run | organelles+wiring)`, three executors). Everyday wiring — especially API reverse-engineering — reuses frozen membranes in `primitives/` that you compose like any other cell.

They are part of the spec the way `string` is: **frozen I/O, ordinary implementation**. No new syntax — just blessed `*.cell.yaml` you wire in. If a target needs HMAC/OAuth/signing, add one function to `primitives/neurons/request.py` and rerun (same self-heal as `helpers.py`).

| Primitive | Membrane | Use |
|---|---|---|
| `session` | `base_url (+headers?) -> session` | Holds session state (cookies, headers). One per api-rev-eng run. |
| `auth` | `session + credentials -> session` | Login / token exchange, enriches session with `Authorization` or cookie. Fail-closed. |
| `request` | `session + method? + url (+headers,+body?) -> response` | Merges session auth into raw HTTP call. Thin — add HMAC/OAuth to `request.py` and rerun. |

Schemas: `schemas/session.v1.json`, `schemas/response.v1.json`.

```yaml
# api_reveng — session holds state, auth enriches it, requests reuse it
organelles:
  - { name: session, cell: ../primitives/session.cell.yaml }
  - { name: auth,    cell: ../primitives/auth.cell.yaml }
  - { name: fetch,   cell: ../primitives/request.cell.yaml }
  - { name: extract, cell: ./extract.cell.yaml }
wiring:
  - { from: membrane.base_url,    to: session.base_url }
  - { from: session.session,      to: auth.session }
  - { from: membrane.credentials, to: auth.credentials }
  - { from: auth.session,         to: fetch.session }
  - { from: membrane.path,        to: fetch.url }
```

Live demo: `patterns/api-reveng/` — captures `session -> auth -> request -> http-skill`.

Non-primitives (prompt formatting, retrieval loops, orchestrator-workers) stay as **patterns** in `patterns/` — examples you copy, not frozen membranes.
