# Aiko Desktop

**Status:** the Tauri shell source has been removed from the tree; this
directory currently ships only the sidecar binary
(`src-tauri/binaries/aiko-*`, the aiko CLI itself). The app is the Vue SPA at
`apps/frontend/frontend`, which runs in a browser or any future shell. What
follows documents how that app reaches the local aiko CLI — all of it
witnessed by `aiko-flow/e2e/aiko-app-native-gate.sh`.

## Native wiring — the app speaks aiko's own primitives

- **Discovery + bearer** — a same-origin `/native/*` reverse proxy (vite
  `server.proxy` in dev; the FastAPI `native_routes` mount when served) reads
  `~/.aiko/native/api.json` per request and injects the bearer server-side.
  The native API has no CORS by design; the browser never sees the token or
  the port. An absent or stale discovery doc fails closed as a named 503,
  never a silent 200.
- **Typed client** — `src/api/native.ts`, pinned to `aiko.native.v1`.
- **ACP agent mail** — the page obtains its WebSocket URL from
  `GET /native/ws-url` and completes the `aiko.acp.v1` initialize handshake
  itself. A leader must be resident (`aiko agent leader --relay-on-demand`);
  the native serve alone answers HTTP but not agent mail.
- **Session login — same login as aiko.** `GET /native/v1/auth` (whoami)
  reflects the CLI's own login decision path (`aiko login`, persisted
  `BuiltinLoginProvider`); the response is an explicit struct that never
  carries token material. There is no separate app login and no grok OAuth on
  the app path — the gate asserts zero grok issuer hosts (auth.x.ai,
  accounts.x.ai) across the served bundle.

## Run the witness

```sh
bash aiko-flow/e2e/aiko-app-native-gate.sh           # green: exit 0
GATE_FALSIFY=1 bash aiko-flow/e2e/aiko-app-native-gate.sh  # must exit nonzero
```

The gate drives headless Chromium against a hermetic `native serve` +
`agent leader` from the built binary, asserts the signed-in identity in the
DOM, page-context `/native/v1/manifest` and `/native/v1/auth` round-trips,
the browser-completed ACP handshake, bundle hygiene, and the fail-closed
path with the serve dead.
