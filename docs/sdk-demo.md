# @unlock/sdk · local 0.1.0

Unpublished workspace package. ESM, TypeScript declarations, native fetch, no runtime dependencies. Requires an environment with `fetch`, `AbortController` and `Response` (Node 22+ / modern browsers).

```sh
pnpm --filter @unlock/sdk build
```

## Management metadata

```ts
import { createUnlockClient, UnlockError } from '@unlock/sdk'

const unlock = createUnlockClient({
  baseUrl: 'http://127.0.0.1:4173/api',
  timeoutMs: 15_000,
  // Optional production hook; the demo does not validate tokens:
  // token: () => protectedTokenStore.get(),
  // transport: customFetch,
})
const logins = await unlock.connections.list()
await unlock.connections.update('github', { name: 'GitHub work', favorite: true })
await unlock.connections.assign('github', ['builder', 'research'])
// Session metadata is support/runtime tooling, not everyday vault UI.
const sessions = await unlock.sessions.list()
await unlock.profiles.update('builder', { connectionIds: ['github', 'linear'] })

const abort = new AbortController()
try {
  await unlock.workspace({ signal: abort.signal })
} catch (error) {
  if (error instanceof UnlockError) {
    // Stable safe fields: code, status, message. No raw response body.
  }
}
```

Methods: `workspace`, `connections.list/connect/importCsv/update/assign/action`, `sessions.list/action`, `profiles.list/create/update`, `sources.list/update`, `clients.create`, `settings.update`, `reset`.

`update` saves a display name, synthetic username or favorite flag; it does not accept passwords. `assign` atomically replaces the profiles with access to one saved item. Profile creation accepts optional `avatar` and `connectionIds`. Switching the owner's visible profile is local navigation and does not call these authorization methods.

`connect`, client registration and reset model the **synthetic demo contract**, not production credential ingestion or OAuth token issuance. Types distinguish native snapshots, live references and SSO destination sessions. Success JSON is typed but not runtime-schema-validated by the client; the demo server validates inputs. Add response validation for untrusted/custom transports in production.

Tokens resolve per request; timeout includes token resolution and response parsing. Signals are cleaned up. No automatic retries, including writes. Cancellation cannot guarantee a server-side write did not already execute: inspect state before retrying. Transport and server error details are deliberately sanitized rather than reflected or logged.

## CSV batch metadata

```ts
const result = await unlock.connections.importCsv({
  rows: [
    { row: 2, name: 'Work', domain: 'work.example.test', identity: 'user@demo.example' },
    { row: 3, name: 'Other account', domain: 'work.example.test', identity: 'other@demo.example' },
  ],
})
// result.imported / duplicates / invalid, plus a safe result for every submitted row.
```

This method takes **already-projected demo metadata, not CSV bytes or passwords**. The app parses a local file, drops recognized sensitive columns and projects the selected name/website/username fields. The API validates again. Up to 1,000 rows are accepted per batch; unknown fields (including password fields) are rejected. Rows use unique CSV record numbers starting at 2.

Duplicates match canonical hostname + trimmed case-sensitive username. No existing login or profile assignment is overwritten. A capacity violation (`VAULT_FULL`, HTTP 409) rejects the batch before writes; the demo permits 2,000 retained records. Per-row invalid/duplicate results are explicit. Repeating a batch without intervening identity edits/deletions skips saved rows; it is not a general idempotency-key protocol.

Imported items have `passwordUnavailable: true`, snapshot provenance and no usable session. They are private to My vault until explicitly assigned to profiles. No real passwords are saved or returned. Ordinary request bodies remain limited to 16 KiB; CSV batches allow 1 MiB and profile writes 128 KiB for larger assignment lists, all bounded while streaming.

## Private runtime entry point

```ts
import { createRuntimeClient, createSessionBridge, type BrowserAdapter } from '@unlock/sdk/runtime'

const runtime = createRuntimeClient({ baseUrl: 'http://127.0.0.1:4173/api' })
const adapter: BrowserAdapter = {
  async replaceCookies(cookies, domains) {
    // Implement privately in a DEDICATED browser context.
    // Replace only the allowed destination domains; never the whole browser.
  },
  async exportCookies(domains) {
    // Read ONLY cookies for the allowed destination domains.
    return [] // Replace this illustrative stub with a real trusted adapter.
  },
}
const bridge = createSessionBridge(runtime, adapter, {
  connectionId: 'github', profileId: 'builder',
})
await bridge.initialize() // idempotent hydration before initial navigation
// Delegate existing browser tools here. Do not rehydrate per click.
await bridge.sync()       // compare-and-swap; conflict fails, not retried
// await bridge.recover() // explicit initialization/recovery only
```

Never expose `retrieve`, `sync`, cookie material, the bridge, token stores or adapter arguments/results as LLM tools. This is a **trust contract**, not a sandbox or execution proxy. The bridge serializes its lifecycle operations; the host must also coordinate browser activity and exclude concurrent untrusted cookie modifications during capture/import. Exact-domain filtering intentionally fails closed; production multi-domain providers require an explicit reviewed allowlist. One bridge/adapter per profile+connection context.

`retrieve` and `sync` re-check demo standing access. Disabled/unassigned profiles, revoked connections, expired/challenged sessions and stale revisions fail. A paused but unexpired session remains usable. Source reconnection requires explicit destination recovery. The API accepts only a fixed synthetic cookie fixture; no real session material is stored.

Revocation stops future vault retrieval/sync. It does not delete cookies already handed to the browser or force upstream logout. The user/host must invalidate destination sessions with the provider where supported.

## Scope

Real vault cryptography, tenant authorization, OAuth issuer, external source authorization, provider login recipes, scheduled maintenance, CLI/MCP and a browser-harness-specific adapter remain production work. The management module does not import or export the runtime material APIs.
