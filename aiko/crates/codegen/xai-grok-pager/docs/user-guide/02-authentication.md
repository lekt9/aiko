# Authentication

> **Aiko TUI docs.** The user binary is `aiko`. Crate/`~/.grok/` names are compatibility identifiers.

Aiko supports interactive login, enterprise single sign-on (SSO), and headless
CI/CD runners. The default user path is `aiko login` through the public Aiko
proxy. You do not paste a Surplus or provider key for ordinary use.

The crate name `xai-grok-*` and some `~/.grok/` paths are compatibility
identifiers, not a second product.

---

## Browser Login (Default)

```bash
aiko login
aiko
```

The provider is also available as a native, typed argument:

| Command | Account provider |
|---|---|
| `aiko login` or `aiko login aiko` | Aiko (default) |
| `aiko login grok` | Grok through xAI OAuth |
| `aiko login openai` | OpenAI through ChatGPT OAuth |
| `aiko login codex` | Compatibility spelling for OpenAI |

`aiko login grok` uses the OAuth issuer, public client, scopes, referrer, and
token header synchronized from `xai-org/grok-build`; it does not require local
environment overrides. `--oauth` and `--device-auth` select the transport for
the Aiko and Grok flows, not the provider.

After a successful explicit Aiko or Grok login, Aiko remembers that built-in
profile for later launches. Bare `aiko login` remains configuration-aware, so
enterprise OIDC and external authentication keep their existing precedence.

Aiko stores the session and reuses it across launches. When the session cannot
be refreshed, run `aiko login` again.

### Re-authenticate

To switch accounts or resolve an authentication problem, run:

```bash
aiko login
```

`aiko login` replaces the cached session. Device-code and OIDC flags remain
available for enterprise and headless environments. Compatibility: some
builds still accept `aiko login` as an alias.

To sign out from the active Aiko/Grok profile, run `aiko logout`. Explicit
provider forms are also available: `aiko logout aiko`, `aiko logout grok`,
`aiko logout openai`, and the compatible `aiko logout codex` spelling.

---

## API Key

Ordinary use does **not** need a client provider key. For CI/CD or BYOK,
see [`docs/providers`](../../../../../docs/providers/README.md).

```bash
# example only — prefer aiko login
export XAI_API_KEY="..."
aiko
```

A stored session from `aiko login` takes precedence over an environment key.

---

## OIDC (Customer SSO)

Authenticate developers through your own Identity Provider (IdP) -- such as Okta, Azure AD, or Auth0 -- instead of grok.com.

### 1. Register a public client in your IdP

- Grant type: Authorization Code with PKCE (Proof Key for Code Exchange)
- Redirect URI: `http://127.0.0.1/callback` -- a loopback address. Aiko binds a random port at sign-in time, and most IdPs treat the loopback redirect as port-agnostic per [RFC 8252](https://tools.ietf.org/html/rfc8252).
- No client secret. PKCE replaces it.

### 2. Configure the CLI

Via config file:

```toml
# ~/.grok/config.toml
[grok_com_config.oidc]
issuer = "https://acme.okta.com"
client_id = "0oa1b2c3d4e5f6g7h8i9"
```

Or via environment variables:

```bash
export GROK_OIDC_ISSUER="https://acme.okta.com"
export GROK_OIDC_CLIENT_ID="0oa1b2c3d4e5f6g7h8i9"
```

You can also override the API endpoint to point at your own proxy:

```bash
export GROK_CLI_CHAT_PROXY_BASE_URL="https://grok-proxy.acme.com/v1"
```

### 3. Run `aiko`

The CLI discovers endpoints via `{issuer}/.well-known/openid-configuration`, opens the IdP login page, and stores tokens in `~/.grok/auth.json`. Tokens auto-refresh silently via the stored `refresh_token`.

### Optional fields

| Field | Default | Notes |
|-------|---------|-------|
| `scopes` | `["openid", "profile", "email", "offline_access", "api:access"]` | `offline_access` enables silent token refresh |
| `audience` | None | Required by some IdPs (e.g., Auth0) |

---

## External Auth Provider

When browser-based login isn't possible -- for example, on sandboxed VMs, CI runners, or air-gapped networks -- delegate authentication to an external binary or script.

### How It Works

```
+--------------+     sh -c     +------------------------+
|     Aiko     |-------------->|  your auth binary      |
|              |               |                        |
|  reads       |<-- stdout ----|  prints token          |
|  auth.json   |               |                        |
|              |   (stderr)    |  prints status/URLs    |--> surfaced to user
+--------------+               +------------------------+
```

1. Aiko runs your command via `sh -c "<command>"`
2. Your binary runs whatever auth flow it needs (SSO, device code, certificate exchange)
3. **stderr** carries human-readable output, such as login URLs and status messages. Aiko reads stderr and surfaces it to the user; in the TUI, it turns the first `https://` URL into a clickable sign-in link.
4. **stdout** is captured by Aiko and saved as the access token
5. Exit 0 = success; exit non-zero = Aiko falls back to interactive login

### The stdout / stderr Contract

| Stream | What to print | Who sees it |
|--------|---------------|-------------|
| **stdout** | The token -- nothing else | Aiko (parsed and stored in auth.json) |
| **stderr** | Login URLs, status messages, errors | The user (Aiko reads stderr and shows the sign-in URL as a clickable link in the TUI) |

**Do not print anything to stdout except the token.** No progress messages, no debug output. Aiko reads stdout, trims surrounding whitespace, and parses the result as a token.

### stdout Token Format

**Bare string** -- just the raw token:

```
eyJhbGciOiJSUzI1NiIs...
```

**JSON** -- with optional refresh token, expiry, and issuer:

```json
{"access_token": "eyJhbGciOi...", "refresh_token": "ref-tok", "expires_in": 3600, "issuer": "https://idp.example.com"}
```

Use JSON if your tokens expire and you want Aiko to automatically re-run the binary before expiry.

JSON fields:

| Field | Required | Meaning |
|-------|----------|---------|
| `access_token` | yes | Bearer token Aiko sends to the xAI API |
| `refresh_token` | no | Stored for reference. Aiko refreshes by re-running your binary, not with an OAuth refresh grant |
| `expires_in` | no | Token lifetime in seconds; enables proactive refresh before expiry |
| `issuer` | no | Identifies the token's issuer |

### Configuration

Via config file:

```toml
# ~/.grok/config.toml
[auth]
auth_provider_command = "/usr/local/bin/my-auth-provider"
auth_provider_label = "Acme Corp"   # optional -- customizes the TUI login button
auth_token_ttl = 3600               # optional -- token lifetime in seconds
```

Or via environment variables:

```bash
export GROK_AUTH_PROVIDER_COMMAND="/usr/local/bin/my-auth-provider"
export GROK_AUTH_PROVIDER_LABEL="Acme Corp"
export GROK_AUTH_TOKEN_TTL=3600
```

### Token Refresh

When Aiko needs to refresh an expired token, it re-runs your binary with `GROK_AUTH_EXPIRED=1` set in the environment. Each run fully replaces the stored credential, so emit the same JSON fields (such as `issuer`) on every invocation, including refreshes. Your binary can use this to take a faster silent-refresh path:

```bash
#!/bin/sh
if [ "$GROK_AUTH_EXPIRED" = "1" ]; then
    echo "Refreshing token..." >&2
    TOKEN=$(my-company-auth --refresh --silent)
else
    echo "Authenticating via Acme Corp SSO..." >&2
    TOKEN=$(my-company-auth --login --interactive)
fi

if [ -z "$TOKEN" ]; then
    echo "Authentication failed" >&2
    exit 1
fi

echo "{\"access_token\": \"$TOKEN\", \"expires_in\": 3600}"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `GROK_AUTH_PROVIDER_COMMAND` | Path to your auth binary |
| `GROK_AUTH_PROVIDER_LABEL` | Display name on the TUI login screen (e.g., "Acme Corp") |
| `GROK_AUTH_TOKEN_TTL` | Token lifetime in seconds (for bare-string tokens without `expires_in`) |
| `GROK_AUTH_EXPIRED` | Set to `1` by Aiko when re-running the binary for token refresh |
| `GROK_AUTH_EARLY_INVALIDATION_SECS` | Seconds before expiry to proactively refresh (default: 300) |

---

## Device Code Flow

For headless environments (SSH sessions, Docker containers, remote VMs) where no browser is available locally:

```bash
aiko login --device-auth    # or: aiko login --device-code
```

This prints a URL and code to the terminal. Open the URL on any device, enter the code, and complete authentication. Aiko polls until the login is confirmed.

You can also implement the device-code flow through an [External Auth Provider](#external-auth-provider) for full control.

---

## Automatic Credential Refresh

Aiko automatically refreshes expired credentials:

- **Before expiry:** If your auth provider returned `expires_in` (JSON output) or you set `auth_token_ttl`, Aiko re-runs the auth binary ~5 minutes before expiry.
- **On auth error:** If the server returns 401 Unauthorized, Aiko refreshes the credentials and retries the request.
- **OIDC:** If a `refresh_token` is available, Aiko silently refreshes via your IdP without re-opening the browser.

Tune the refresh buffer:

```bash
# Refresh 5 minutes before expiry (default)
export GROK_AUTH_EARLY_INVALIDATION_SECS=300

# Disable the proactive buffer: refresh at expiry or on a 401 (set to 0)
export GROK_AUTH_EARLY_INVALIDATION_SECS=0
```

---

## Hot Reload

Aiko picks up changes to `~/.grok/auth.json` automatically. If you update credentials externally (for example, with a script that writes new tokens), Aiko uses the new credentials on the next API call without a restart.

---

## Auth Precedence

Aiko resolves credentials for each request in this order, highest to lowest:

1. **Per-model `api_key` or `env_key`** -- set under `[model.<name>]` in `config.toml`. Wins whenever present.
2. **Active session token** -- obtained through browser, OIDC/OAuth2, or external-provider login and stored in `~/.grok/auth.json`.
3. **`XAI_API_KEY`** -- fallback when no session token is active.

When more than one login flow is configured, Aiko populates the session token from the first available source, highest to lowest:

1. **External auth provider** (`auth_provider_command`)
2. **Enterprise OIDC** -- when OIDC is configured, through `[grok_com_config.oidc]` in `config.toml` or the `GROK_OIDC_ISSUER` and `GROK_OIDC_CLIENT_ID` environment variables
3. **SpaceXAI OAuth2 browser login** -- the default

During a session, the active method handles all mid-session refreshes.

---

## Troubleshooting

### Debug logging

Set `RUST_LOG` to control the verbosity of the file log and headless stderr output. (The TUI's on-screen tracing pane uses a fixed filter and ignores `RUST_LOG`.) In the TUI, file logging defaults to `DEBUG`; in headless mode (`-p`), `RUST_LOG` defaults to `off` so only the answer is printed — set `RUST_LOG=error` (or broader) to see logs on stderr.

In the TUI, set `GROK_LOG_FILE` to an absolute path to write logs to that file:

```bash
GROK_LOG_FILE=/tmp/grok.log RUST_LOG=debug grok
tail -f /tmp/grok.log
```

`GROK_LOG_FILE` is treated as a literal file path. A relative value such as `1` writes a file named `1` in the current directory.

In headless mode, logs go to stderr. Redirect them to a file:

```bash
RUST_LOG=debug aiko --single "hello" 2> /tmp/grok.log
```

### Common log messages

| Log message | What it means |
|-------------|---------------|
| `auth: running external auth provider` | Aiko is running your binary |
| `auth: external auth provider returned fresh token` | Aiko parsed and stored the token |
| `auth: external auth provider failed` | Binary exited non-zero or stdout was empty |
| `auth: external auth provider timed out (likely needs interactive auth), killing` | Binary did not exit before the timeout and was killed |
| `auth: failed to start external auth provider` | Command could not be spawned (binary not found) |

### Common fixes

- **"Authentication failed"** -- Run `aiko logout` to clear cached credentials, then `aiko login` to sign in again.
- **Token expires too quickly** -- Set `auth_token_ttl` or return `expires_in` in your auth provider's JSON output.
- **OIDC redirect fails** -- Ensure your IdP allows loopback redirect URIs (`http://127.0.0.1/callback`).
- **External auth provider not found** -- Check that the `auth_provider_command` path is correct and the binary is executable.
