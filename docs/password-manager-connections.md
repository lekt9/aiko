# Password manager connections

Unlock stores password-manager references and authorizes remote MCP access with OAuth. Users do not paste API keys, service-account tokens, or master passwords. The host calls the configured reference-reading tool privately when filling a sign-in. It never registers upstream MCP tools with the assistant. Native browser custody stores the reference and verified session, not a second copy of the manager's password. Expired website sessions require another reference fill; native password renewal cannot reuse a copied external password.

## Provider support

Provider names are labels, not claims of a built-in hosted integration. Only operator-configured connections appear in the setup screen. There are no fabricated provider URLs or generic SSO-to-vault assumptions.

- [1Password's official Environments MCP](https://www.1password.dev/environments/mcp-server) runs locally through the desktop app, requires stdio, and does not return secret values. It cannot be plugged into this remote reference-reading adapter. Its environment mounts or Secure Agentic Autofill require a separate local integration.
- [Bitwarden's official MCP](https://github.com/bitwarden/mcp-server) uses a local CLI and native unlock dialog. It explicitly prohibits public/network hosting. Do not expose it as a remote OAuth endpoint.
- [The MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x) supplies Streamable HTTP, OAuth discovery, client registration, PKCE, resource indicators and refresh. An actual compatible remote vault service must expose OAuth and a reference-reading tool before an operator enables it here.

This change implements the remote OAuth/MCP adapter. It does not implement local stdio adapters, 1Password environment mounts, or provider-specific REST OAuth APIs. Verification uses the real SDK against a synthetic OAuth/MCP network; no live personal vault was connected.

## Host configuration

Both the Bun server and Cloudflare host read `AIKO_MANAGER_PROVIDERS_JSON` and `AIKO_MANAGER_KEY`. The latter is a base64 encoding of 32 random bytes for local AES-256-GCM encryption, **not a provider API key**. Keep it in private host configuration and retain it across restarts.

Example schema only; these domains and tool names are placeholders:

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

Use the exact reference tool name, argument name and output path from the service's documented schema. Unlock verifies that `tools/list` advertises that tool and argument before saving a completed connection or resolving a reference. `valuePath` selects a string from `structuredContent` or from one JSON text block; an empty path accepts a single plain-text value. No other tools are called. The adapter currently supports one reference argument and no additional required tool arguments.

Register the exact callback URL as a public OAuth client using authorization-code + PKCE and refresh tokens. `clientId` may be omitted when the server supports dynamic client registration; client secrets and client-credentials grants are not accepted configuration. The callback origin must equal the origin hosting the setup screen. The callback asset is included in both the web build and the connector mini-app build.

Allowlist the exact origins needed for discovery, registration, authorization and token exchange. All URLs require HTTPS. Network redirects are rejected. Changing the provider's configuration invalidates its existing grants: disconnect and reconnect them.

## User flow

1. Open Password managers, select a configured connection, and name it.
2. Add references and labels. Bind each login to its website when possible; the server enforces that binding.
3. Continue to the password manager and authorize access there.
4. Return to Unlock. The callback uses same-origin messaging, with a copy-and-paste connection-result fallback for a separate browser. Authorization state is owner-bound, expires after ten minutes and can be used once.
5. Select the saved login in a private sign-in. Unlock resolves it, submits the transient password, and returns only sign-in status.

OAuth client registrations, access/refresh tokens, and PKCE verifiers are sealed with owner- and manager-bound authenticated encryption. Listings expose metadata only. Disconnect erases the sealed grant and tombstones the record so an in-flight resolution fails closed. Disconnecting the manager does not revoke already established website sessions; disconnect those apps separately when needed.

Old service-token records can be listed and removed, but cannot fill sign-ins. They must be replaced with an available supported connection. The former 1Password, Keeper, Vault and Doppler API-key resolver implementations and the SDK/WASM runner bridge have been removed.
