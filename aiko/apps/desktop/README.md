# Aiko Desktop

**This is the zero-setup user path** — the product's north star made concrete:
open the app and it works. It stands up its own runtime, adopts or starts the
backend and databases, and degrades honestly when something is missing — no
config, no keys, no side services, no skills or MCPs to install. A task is one
prompt; integration into other systems is [Unbrowse](https://github.com/Unbrowse),
not bespoke wiring. See [the goal](../../docs/GOAL.md).

The Tauri shell around Aiko. Since the one-to-one UI replacement, the window
renders the **same web frontend as `apps/frontend/frontend`** (the Vue app) —
the desktop app no longer ships its own React UI. One UI, three doors:

```
apps/frontend/frontend (Vue SPA, built once)
        │
        ├── desktop window   → served by the app's own webhost (127.0.0.1:17870)
        ├── LAN / localhost  → same webhost, or docker `./run.sh` (port 5173)
        └── public website   → Cloudflare quick tunnel over either origin
```

## How it fits together

- **`src-tauri/src/webhost.rs`** — the app self-hosts the built frontend over
  real HTTP and mirrors the frontend container's nginx contract exactly:
  SPA with `index.html` fallback, `/api/*` reverse-proxied (including
  WebSocket upgrades) to the backend. The window and any tunnel point at this
  one origin, so "in the app" and "on the website" are the same bytes.
- **`src-tauri/src/tunnel.rs`** — opt-in public exposure through
  `cloudflared`'s quick tunnel. Never starts on its own: set `AIKO_TUNNEL=1`
  at launch, or call the `start_tunnel` command from the UI. `tunnel_status`
  returns the `https://*.trycloudflare.com` URL, `stop_tunnel` closes it.
- **`src-tauri/src/runtime.rs`** — unchanged: spawns the `aiko` sidecar
  (`native serve` + `agent leader`), which is what the Manus backend's
  `AIKO_LOCAL=true` integration talks to.
- **`src-tauri/src/console.rs`** — the web face of the CLI and the runtime,
  rendered by the frontend's `/console` page:
  - `/cli/verbs`, `/cli/run`, `/cli/jobs/{id}` — a fixed catalog of CLI verbs
    run as polled jobs (fixed argv only, never composed command lines). Sign-in
    uses `aiko login --device-auth`; the page surfaces the verification URL and
    code as they stream.
  - `/native/v1/*` — reverse proxy to the daemon discovered via
    `~/.aiko/native/api.json`, bearer token injected server-side. The page
    renders every interface in the live `/v1/manifest` plus a request runner.
  - Both surfaces refuse any request whose Host is not loopback, so tunnel
    visitors get the UI and the Manus API but never the raw daemon or the CLI
    (`AIKO_EXPOSE_NATIVE=1` overrides, deliberately and loudly).

- **`src-tauri/src/stack.rs`** — what makes the app self-contained. On launch
  it adopts a backend already answering at `AIKO_BACKEND_URL`, otherwise it
  ensures the `aiko-mongo`/`aiko-redis` containers (podman or docker), writes a
  default `backend/.env` if none exists (`AUTH_PROVIDER=none` — no SMTP/email
  dependency), spawns the backend with `uv`, and reports ready **only when the
  backend answers**. Missing prerequisites are named, never papered over; the
  UI's outage state renders them. Runnable witness:
  `cargo run --bin aiko-stack` (exit 0 iff the backend answers when it exits).

Backend source resolution: bundled `resources/backend` → `AIKO_BACKEND_DIR` →
the repo's `apps/frontend/backend`. Prerequisites on the host: `uv` and a
container engine (podman or docker). Alternatively run the stack yourself with
`apps/frontend/run-native.sh` or Docker `./run.sh` — the app adopts it.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AIKO_WEB_ADDR` | `127.0.0.1:17870` | webhost bind address (use `0.0.0.0:…` for LAN) |
| `AIKO_BACKEND_URL` | `http://127.0.0.1:8000` | where `/api` is proxied |
| `AIKO_FRONTEND_DIST` | bundled resource | override the served frontend build |
| `AIKO_TUNNEL` | unset | `1` starts a Cloudflare quick tunnel at launch |

## External links

A webview has no browser to hand a link to: `target="_blank"` opens nothing and
a plain external href navigates the app away from its own UI. The webhost
therefore injects a click shim into every HTML page it serves; the shim posts
external URLs to **`POST /open`**, and the host opens them in the real browser.
Same origin, so it needs no Tauri IPC and behaves identically in a browser
viewing the app. `/open` is loopback-only and accepts **http/https only** — a
`file:`/`javascript:` URL is refused, and a failed hand-off answers 502 rather
than a 204 it never verified.

## Develop / build / verify

```sh
npm run tauri dev      # window on the Vue dev server (5173) with /api proxy
npm run tauri build    # builds apps/frontend/frontend and bundles its dist
cd src-tauri && cargo test --lib   # webhost + tunnel witnesses
npm run test:links     # drives real Chrome against the running app and CLICKS
```

`test:links` is the UI witness: it launches Chrome against the app's origin,
clicks a synthetic external link, clicks the shipped Settings → Get help link,
and asserts each reaches `POST /open` while internal links do not and the app
never navigates away. Falsify it by serving `frontend/dist` without the shim
(`python3 -m http.server` + `AIKO_WEB_ORIGIN=…`) — it must exit 1.

The old React UI tree is deleted; the Vue frontend is the only UI. Its
history (including the pre-port telegram-bridge and contract-daemon TS) lives
in git if anything needs recovering.

Server-only self-hosting without the app: in `apps/frontend`,
`docker compose --profile tunnel up -d` serves the identical frontend and
prints its public URL in the `tunnel` service logs.
