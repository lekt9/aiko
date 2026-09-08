# @unlock/sdk · 0.2.0

Unpublished workspace package: ESM, TypeScript declarations and native fetch. Use a patched Node 24 LTS for host/CLI code; metadata/owner clients also work in modern browsers. Built against `@unlock/protocol` (Zod schemas) and `openid-client` for OAuth. No credentials are bundled.

```sh
pnpm build:backend
```

## Entry points and trust boundaries

| Import | Purpose | Intended caller |
|---|---|---|
| `@unlock/sdk/aiko` | Account-bound Aiko messages, cancellation, memory reads and browser approval | Trusted agents with an account credential; Telegram-independent |
| `@unlock/sdk/vault` | Owner metadata, profiles, assignments, OAuth client registration | Trusted owner UI |
| `@unlock/sdk/owner` | Passwords, full CSVs, source authorization, private session/SSO imports | Trusted owner UI, **never model tools** |
| `@unlock/sdk/sources` | Password manager source builders for 1Password, Keeper, HashiCorp Vault and Doppler | Trusted owner UI, **never model tools** |
| `@unlock/sdk/agent` | Destination session retrieval/sync, maintenance request, browser bridge | Trusted runtime, **never model tools** |
| `@unlock/sdk/cdp` | Scoped cookie adapter for an isolated Chromium context | Trusted runtime |
| `@unlock/sdk/oauth` | Agent PKCE, refresh/revocation, private token stores | Trusted host/CLI |
| `@unlock/sdk/tools` | `unlock_logins` metadata tool and MCP registration helper | Model-facing allowlist |
| `@unlock/sdk`, `@unlock/sdk/runtime` | Original **synthetic demo** protocol | Existing preview only |

The original entry points are preserved, not silently repointed at the real service. Their historical guide is `docs/sdk-demo.md` in the workspace. The web preview still uses those fixtures.

## Password manager sources

Connections can resolve their password from a natively supported password manager instead of a stored credential. Add a source with `owner.addSource`, then reference one of its validated references when creating a connection (`sourceId` + `sourceReference`). The provider token is sealed server-side and never returned by the API; source-backed connections refuse native password overwrites.

```ts
import { passwordManagers } from '@unlock/sdk/sources'

// 1Password service account token, references like op://vault/item/field
const source = await owner.addSource(
  passwordManagers.onePassword({
    name: '1Password',
    token: process.env.OP_SERVICE_ACCOUNT_TOKEN!,
    references: ['op://Vault/service/password'],
  }),
)

// Keeper Secrets Manager one-line config, references like keeper://RECORD_UID/field/NAME
passwordManagers.keeper({ name: 'Keeper', token: ksmConfig, references: ['keeper://abcdefghijklmnopqrstuv/field/password'] })

// HashiCorp Vault KV v2, references like vault://MOUNT/PATH#FIELD
// (the cluster address is operator server configuration, not per-source)
passwordManagers.hashicorpVault({ name: 'Vault', token: vaultToken, references: ['vault://secret/data/app/token#value'] })

// Doppler service token (project/config scoped), references like doppler://SECRET_NAME
passwordManagers.doppler({ name: 'Doppler', token: dopplerToken, references: ['doppler://API_KEY'] })

await owner.add({
  name: 'Work account', identity: 'owner@company.test',
  website: 'https://service.test', domains: ['service.test'],
  credential: undefined,
  sourceId: source.id, sourceReference: 'op://Vault/service/password',
  recipeId: 'operator-approved-recipe', maintenance: true,
})
```

Each builder validates the kind's reference syntax locally before anything is sent to the service. The server resolves references through the matching provider SDK (official 1Password and Keeper SDKs; documented REST APIs for Vault KV v2 and Doppler) during renewal, and every resolution failure collapses to `SOURCE_UNAVAILABLE` so provider internals never leak. Reconnection cannot change a source's kind. Model tools never see this plane: resolution happens inside the trusted runtime only.

## Aiko account plane

Use `createAikoClient` from `@unlock/sdk/aiko` with the Aiko origin (default `http://127.0.0.1:4242`) and a host-issued account credential. This is independent of custody OAuth and Telegram credentials. See [credential provisioning, SDK examples, endpoint discovery and isolation](../../docs/aiko-gateway.md#agent-sdk-and-credentials). Existing SDK entry points are unchanged.

## Owner setup and standing assignments

Owner authentication is a browser session established through `/auth/login` against the configured upstream OIDC provider. Host the trusted owner client on the API origin; cross-origin CORS is not enabled. Agent OAuth tokens cannot authenticate owner endpoints.

```ts
import { createVaultClient } from '@unlock/sdk/vault'
import { createVaultOwner } from '@unlock/sdk/owner'

let csrf = ''
const options = {
  baseUrl: new URL('/v1', location.origin).href,
  csrf: () => csrf,
  timeoutMs: 60_000, // large encrypted imports can take longer, especially with KMS
}
const vault = createVaultClient(options)
csrf = (await vault.me()).csrf // Keep this inside the trusted owner client.
const owner = createVaultOwner(options)

const login = await owner.add({
  name: 'Work account', identity: 'owner@company.test',
  website: 'https://service.test', domains: ['service.test'],
  credential: { password: passwordFromTrustedOwnerInput },
  recipeId: 'operator-approved-recipe', maintenance: true,
})
const profile = await vault.profiles.create({ name: 'Builder' })
await vault.profiles.assign(profile.id, [login.id])
const runtimeClient = await vault.clients.create({
  name: 'Builder runtime', profileId: profile.id,
  connectionIds: [login.id],
  redirectUris: ['http://127.0.0.1:4567/callback'],
})
```

Assignments are standing policy, not per-run approvals. A client also has an owner-selected login cap: update it explicitly with `clients.updateAccess(id, connectionIds)` when expanding its access. A saved login can be assigned to multiple profiles without duplicating its credential. Switching an owner's visible profile is navigation, not authorization or impersonation.

`connections.update` supports display name, recipe and maintenance policy with an expected `version`. Identity/site bindings are immutable: create a replacement login rather than silently moving a credential to a different destination. `owner.setPassword` updates vault custody only; it does not change the website's password. Live-reference credentials cannot be overwritten through this method.

### Whole CSVs, including passwords

```ts
// These values must never cross ordinary model tool arguments/results.
const preview = await owner.importCsv.preview({ csv: await selectedFile.text() })
const selected = preview.rows.filter(r => r.status === 'ready').map(r => r.row)
// Show the redacted preview to the owner and obtain confirmation first.
const result = await owner.importCsv.commit(preview.id, selected)
```

Up to 1 MiB / 1,000 rows; common headers or explicit `columns: {name,url,username,password}` mapping. HTTPS sites, arbitrary valid usernames, multiple accounts per site, duplicate skipping and per-row diagnostics. Passwords never appear in the preview. CSV input/staging **does** contain passwords: only the trusted owner client may handle it, over TLS. Do not map password/token/note contents into metadata columns.

Staging is encrypted and expires after ten minutes. Commit is atomic on capacity failure; repeating the same selection for a committed preview returns its receipt during that lifetime. Different selections conflict. Existing logins are not overwritten and imports never grant agent access automatically. Cancellation deletes staging. The current **web demo's** CSV dialog still discards passwords; this is a separate API.

### References and SSO

- `owner.addSource` / `reconnectSource`: official 1Password service-account SDK, selected `op://vault/item/field` references, no persistent resolved-password cache. Account authorization remains an operator task.
- `owner.importSession`: private captured destination cookies, bound to `profileId` and registered `runtimeId`; an approved recipe must verify the expected destination identity before publication.
- `owner.addSsoContext` / `reconnectSsoContext`: private parent cookies pinned to an operator runtime. Metadata is visible only to the owner; no agent parent-cookie retrieval endpoint exists. A trusted recipe can checkpoint parent changes with CAS.

## Agent OAuth

```ts
import { readFile } from 'node:fs/promises'
import { createAgentOAuth, EncryptedFileTokenStore } from '@unlock/sdk/oauth'
import { createVaultAgent } from '@unlock/sdk/agent'

const storageKey = await readFile(protectedKeyPath) // 32 raw bytes, provisioned outside the model
const store = new EncryptedFileTokenStore(protectedTokenPath, storageKey)
storageKey.fill(0)
const auth = createAgentOAuth({
  issuer: 'https://vault.company.test/oauth',
  clientId: registeredClientId,
  redirectUri: 'http://127.0.0.1:4567/callback',
  store,
})
// One-time owner connection flow:
const { url } = await auth.begin()
// Send the URL to the human. A trusted loopback callback handler calls:
await auth.finish(callbackUrl)

const agent = createVaultAgent({
  baseUrl: 'https://vault.company.test/v1',
  token: auth.accessToken, // Resolve privately; never print the return value.
})
```

PKCE, state, nonce, exact callback and resource checks; refresh rotation is serialized by the private store. Access tokens last five minutes; refresh tokens seven days, grants thirty days. A refresh with an uncertain outcome clears local authorization rather than blindly replaying a potentially consumed token. A persisted in-flight marker fails closed after interruption. There are no automatic mutation retries.

The default `MemoryTokenStore` is process-only. `EncryptedFileTokenStore` requires a private directory and separate protected 32-byte key, encrypts data, fsyncs/renames atomically, and holds an exclusive file lock across refresh. **After a crash, a stale lock may require operator removal after confirming all users of that store have stopped.** Never remove it automatically while another runtime may be refreshing. For stronger host protection, implement `TokenStore.withLock` using an OS credential service with equivalent cross-process serialization.

`allowLocalHttp: true` permits an explicitly configured loopback issuer for tests. Native HTTP 127.0.0.1 callbacks are allowed independently; they do not disable HTTPS checks on a production issuer.

## Existing browser tools, privately authenticated

```ts
import { createVaultBridge, wrapVaultTools } from '@unlock/sdk/agent'
import { createCdpCookieAdapter } from '@unlock/sdk/cdp'

const adapter = await createCdpCookieAdapter(privateCdpConnection, {
  browserContextId: isolatedContextId,
  targetId: existingToolTargetId,
})
const bridge = createVaultBridge(agent, adapter, {
  connectionId: approvedLoginId,
  profileId: approvedProfileId,
  runtimeId: registeredClientId,
  domains: ['service.test'],
})
await bridge.initialize()
const tools = wrapVaultTools(reviewedOrdinaryBrowserTools, bridge, code => {
  notifyTrustedHostOfRecoveryNeeded(code)
})
```

The CDP connection must support `send(method, params, sessionId?)`. The adapter verifies the target belongs to the named **isolated** context, preserves host-only/domain and partitioned-cookie semantics, and replaces the full scoped jar, including deletions. Unrelated domains are preserved. It does not require a hosted browser or replace the original tool's inputs/results.

One bridge per exclusively controlled task context. Ordinary actions and synchronization are serialized; hydration happens on initialization or explicit recovery, **not every click**. Successful action results are preserved even if later synchronization fails: an error must not cause the agent to replay a purchase, send, or other side effect. Failed actions also trigger best-effort sync. Conflicts, expiry and failed recovery stop subsequent wrapped actions until the trusted host explicitly recovers. Use `agent.requestRenewal(id)` when appropriate, then recover once a verified session is available; owner challenges cannot be bypassed.

Do not expose raw CDP, cookie inspection, arbitrary evaluation, token stores, owner-secret APIs or runtime APIs to the model. This package does **not** sandbox a model with arbitrary shell/file/process access under the credential-owning OS account. Process isolation, OS permissions and a reviewed tool allowlist are required.

## CLI and MCP

```sh
node packages/sdk/dist/cli.js help
node packages/sdk/dist/cli.js schema logins
node packages/sdk/dist/cli.js logins --dry-run
# Operator-provisioned private config:
UNLOCK_AGENT_CONFIG=/private/agent.json node packages/sdk/dist/cli.js status
UNLOCK_ALLOW_AUTH_UI=1 UNLOCK_AGENT_CONFIG=/private/agent.json \
  node packages/sdk/dist/cli.js login
```

CLI config: `{issuer, clientId, redirectUri, tokenFile, keyFile, allowLocalHttp?}`. Config/key files must be private (0600 or stricter); `keyFile` holds 32 raw bytes, not base64. CLI login needs an exact, pre-registered HTTP 127.0.0.1 callback with an unprivileged explicit port. It prints the authorization URL to stderr and waits up to five minutes, never opens personal Chrome automatically. `logout --confirm` also requires operator opt-in. Normal `status` / `logins` output contains metadata only. Installed binary name: `unlock-agent`.

Direct CLI stdout is a versioned JSON envelope; exit codes: 0 success, 1 runtime/storage, 2 authentication/configuration, 3 invalid input. The pnpm convenience wrapper adds its own output, so use the binary or direct Node invocation for machine parsing.

`registerUnlockMetadataTools(hostMcpServer, agent)` registers only `unlock_logins`. The host owns the MCP transport and authentication; no independent MCP HTTP/stdio server is bundled. Browser authentication belongs in the private wrapper, not a cookie-returning MCP tool.

## Errors and revocation

Every new API response is runtime-schema-validated. Transport bounds response bodies, includes cancellation/timeouts, refuses redirects and sanitizes errors. Important codes: `UNAUTHENTICATED`, `FORBIDDEN`, `CONFLICT`, `REAUTH_REQUIRED`, `UNSUPPORTED_PROVIDER`, `RUNTIME_UNAVAILABLE`, `SOURCE_UNAVAILABLE`, `CAPACITY`, `INVALID_RESPONSE`. Inspect state after uncertain writes rather than automatically repeating them.

Revocation blocks future vault authorization/retrieval/sync. It cannot revoke cookies already delivered, terminate in-flight website requests, or guarantee upstream logout. Disconnection purges the current stored source token but does not revoke the upstream 1Password service account. Backup copies follow the operator's retention policy.

## Verification and remaining activation work

See `docs/backend-implementation.html` and `docs/backend-verification.html` in the workspace. Tests use real PostgreSQL/HTTP, controlled identity providers, synthetic credentials and isolated Chromium. No live provider account was accessed.

The shipped configurable recipe handles approved fixed-origin JSON/form authentication APIs. Provider-specific browser SSO, passkeys, MFA and device-bound sessions need reviewed implementations; they are not fabricated by the generic adapter. Production owner IdP, database/TLS, key management, authorized source accounts, provider recipes and independent security/operations review are required. The existing vault UI has not been migrated to this service.

Native app custody can opt into `VaultBinding.includeSubdomains` when its trusted
account binding authorizes the entire app domain. The CDP adapter then exports
and replaces descendant cookies as well, including cookies created on a new
subdomain during an action. The default remains exact `domains` matching.
Custom browser adapters must implement the corresponding optional scope argument
before enabling this option. Native custody supplies its own encrypted store to
`createVaultBridge` through the `retrieve`/`sync` interface; it does not require a
second vault service. See [the native custody guide](../../docs/connector-engine.md)
for its durable checkpoint and recovery rules.
