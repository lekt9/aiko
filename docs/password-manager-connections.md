# Password manager connections

Unlock supports **Zoho Vault through its OAuth API**, and compatible remote password-manager MCP servers through OAuth. Users authorize their password manager and select saved login references. The private host resolves a reference when filling a sign-in; upstream secret-reading operations are never registered as assistant tools.

## Zoho Vault

The built-in provider connects directly to Zoho's accounts and vault services. It implements authorization-code OAuth with PKCE, offline refresh, PBKDF2 vault unlock, personal and shared login selection, and current username/password resolution. It is a password-manager integration, not a generic identity-provider login.

### Operator setup

1. Register an OAuth **server-based application** in [Zoho's API Console](https://api-console.zoho.com/) for the vault's region. Register the exact HTTPS callback URL `https://YOUR_UNLOCK_HOST/password-manager-callback.html`; its origin must match the setup screen. Enable the authorization-code flow with PKCE and the `ZohoVault.secrets.READ` scope. Users grant access through Zoho's consent screen.
2. Set `AIKO_MANAGER_PROVIDERS_JSON` in private host configuration:

```json
[
  {
    "id": "zoho",
    "name": "Zoho Vault",
    "kind": "zoho-vault",
    "region": "us",
    "clientId": "YOUR_REGISTERED_OAUTH_CLIENT_ID",
    "clientSecret": "YOUR_REGISTERED_OAUTH_CLIENT_SECRET",
    "redirectUrl": "https://YOUR_UNLOCK_HOST/password-manager-callback.html"
  }
]
```

3. Set `AIKO_MANAGER_KEY` to the base64 encoding of 32 random bytes. This local AES-256-GCM sealing key protects OAuth grants and derived vault keys. Retain it across restarts and keep both configuration values out of public environment variables, source control and assistant tools.

The OAuth application secret belongs to the host operator. Users do not obtain or paste API keys, service-account credentials or OAuth tokens. Bun and Cloudflare hosts share this configuration parser. Supported region values are `us`, `eu`, `in`, `au`, `ca`, `jp`, and `sa`; each pins its accounts and vault origins. Arbitrary endpoints, token-response `api_domain` values and redirects cannot redirect a grant elsewhere. Changing provider configuration invalidates existing connections.

### User flow

1. Open Password managers, choose Zoho Vault, name the connection, then authorize it with Zoho.
2. Return to Unlock and enter the vault master password in the private setup page. The browser derives the PBKDF2 key; **the master password is never sent to Unlock's server**. Only the derived key is submitted privately, verified against Zoho's encrypted unlock challenge, and sealed with the OAuth grant. The input is cleared immediately.
3. Choose saved logins from the vault and save the selection. The picker shows names and website domains, with pagination. It never receives encrypted record bodies, decrypted passwords, usernames or notes. Selection stores stable references such as `zohovault://12345/password`, labels and domains; the server verifies every selected item against Zoho.
4. In an app's private sign-in panel, select the saved login. Username is read from the same Zoho record as its password; imported or manually supplied usernames cannot change that account pairing. Unlock reads the current record, checks its website against the connection, decrypts it privately and submits it to the native sign-in path. The response contains sign-in status only. Complete MFA in the private panel when requested.

On native website-session renewal, Unlock resolves the authorized reference again, so a password rotated in Zoho is used immediately. The native vault persists the reference and verified session, without a copied external password. If authorization is revoked, the selected item is removed, its website changes, decryption fails or MFA is required, renewal remains pending for the owner. A manually supplied password replaces the reference source.

The connector currently selects the first usable HTTPS website on a login. Records without a usable website or username/password cannot fill sign-ins. PBKDF2_AES vaults are supported; old SHA256 vaults must be upgraded in Zoho before connection. Shared records support Zoho's legacy RSA-1024 wrapping and RSA-4096/OAEP-SHA256 wrapping. After changing a vault master password, use **Unlock again**. This integration does not modify records, approve sharing, or retrieve file attachments.

### Protocol and verification

The integration follows [Zoho's OAuth authorization-code flow](https://www.zoho.com/developer/oauth/web-server-apps/overview.html), [password-management API](https://www.zoho.com/vault/api/password-management.html), [login/unlock operations](https://www.zoho.com/vault/api/supported-operations.html), and [regional endpoints](https://www.zoho.com/vault/api/api-endpoint.html). It uses the provider's `Zoho-oauthtoken` authorization header and passphrase-change metadata, as used by its official browser extension.

Wire-format interoperability was checked against **Zoho Vault's official Firefox extension 6.8.1**, downloaded from [Zoho's published add-on](https://addons.mozilla.org/en-US/firefox/addon/zoho-vault/). The XPI SHA-256 is `f86a5dac895fb06dcbc770146a1d4cb726e9bf4090537e346d6ac40434ff17ba`. The implementation uses WebCrypto PBKDF2-SHA256 and the provider's AES-CTR/CESU-8 format. Independent synthetic ciphertext vectors generated using that extension are in `apps/agent/test/fixtures/zoho-vault-vectors.json`; no provider source or real vault data is included.

Tests exercise actual adapter code against the documented response envelopes, PKCE, sealed grants, owner isolation, private fill, rotation during renewal, both shared key formats, refresh, wrong unlock keys, changed/trashed items, removal during an in-flight read, and API metadata projection. A browser fixture checks the unlock/selection interface. A local workerd check also verifies personal, RSA-1024 shared, and RSA-4096 shared decryption in the actual Worker runtime. **No live Zoho vault has been connected**; live verification requires the operator's registered OAuth application and an account completing consent and unlock.

## Remote MCP providers

Compatible password-manager services can still be configured with `kind: "remote-mcp"`. The real service must expose OAuth and a reference-reading tool:

```json
[
  {
    "id": "company-vault",
    "name": "Company password manager",
    "kind": "remote-mcp",
    "url": "https://vault.example/mcp",
    "redirectUrl": "https://unlock.example/password-manager-callback.html",
    "authorizationOrigins": ["https://identity.example"],
    "clientId": "PUBLIC_OAUTH_CLIENT_ID",
    "scope": "vault:read",
    "tool": "read_secret",
    "referenceArgument": "reference",
    "valuePath": ["login", "password"]
  }
]
```

These MCP domains and tool names are placeholders. Use the service's documented schema. Unlock verifies that `tools/list` advertises the configured tool and argument, and calls only that tool privately. `valuePath` selects a string from `structuredContent` or a single JSON text block; an empty path accepts plain text. One reference argument is supported. For this adapter users enter references and optional website bindings before OAuth; the username is supplied in the sign-in panel. Automatic reference renewal needs a provider that can resolve the username too, currently Zoho Vault.

The remote MCP adapter uses the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) for Streamable HTTP, OAuth discovery, client registration, PKCE and refresh. `clientId` can be omitted for dynamic client registration. This adapter uses public OAuth clients; client secrets are accepted only by the built-in Zoho provider. Configure exact authorization origins; HTTPS is required and network redirects are rejected.

Provider labels alone do not imply a hosted integration. [1Password's official Environments MCP](https://www.1password.dev/environments/mcp-server) is local stdio and does not return secret values. [Bitwarden's official MCP](https://github.com/bitwarden/mcp-server) is local and explicitly prohibits network hosting. Neither can be treated as a remote OAuth secret-reading endpoint.

## Custody and disconnect

Callback state is owner-bound, expires after ten minutes and is consumed before exchanging the code. Same-origin popup messaging has a copy-and-paste connection-result fallback for separate browsers. Listings contain connection metadata only. Private provider errors never echo upstream response bodies.

Disconnect erases the sealed OAuth grant and vault keys, tombstones the connection and prevents an in-flight read from filling a password. It removes Unlock's local access; revoke the OAuth application in Zoho's connected applications to revoke the upstream grant as well. Existing website sessions are separate and can be disconnected individually.

Legacy API-key/service-token rows can be listed and removed but cannot fill sign-ins. Replace them with a supported OAuth connection.

## Reproduce focused checks

```sh
pnpm --filter @unlock/protocol build
bun test apps/agent/test/zoho-vault.test.ts apps/agent/test/password-managers.test.ts
pnpm exec vitest run apps/web/test/connector-proxy.test.ts
pnpm --filter @unlock/agent exec wrangler dev --config test/fixtures/zoho-vault-worker.jsonc --local --port 4181
```

With the local worker running, request `http://127.0.0.1:4181/`. The synthetic interoperability check returns HTTP 200 with `personal`, `1024`, and `4096` all `true`; any failed case returns HTTP 500. This check performs no provider network requests.
