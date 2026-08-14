# Aiko Native API

Aiko exposes one versioned, authenticated loopback API for desktop and local
web frontends. It is a façade over Aiko-owned interfaces rather than a second
agent, task, or permission system:

- agent/session mail is the existing full-duplex ACP/JSON-RPC leader protocol;
- disposable Internet email is exposed separately under `/v1/agentmail`;
- Contract remains the ledger and durable-task authority;
- application actions still execute inside an agent session and therefore keep
  Aiko's permission and Contract routing;
- the API adds discovery, authentication, stable schemas, and documentation.

## Start and discover

The installed Contract LaunchAgent starts the API with the background worker on
`127.0.0.1:19420`. It writes a mode-`0600` discovery document:

```text
~/.aiko/native/api.json
```

For development:

```sh
aiko native serve
aiko native serve --addr 127.0.0.1:19421
aiko native discovery
aiko native manifest
```

The discovery document contains the active `baseUrl`, `agentMailUrl`, process
id, API version, and a same-user bearer token. Treat it like a local
credential. HTTP calls send:

```http
Authorization: Bearer <token>
```

The server refuses non-loopback bindings. It does not enable permissive CORS,
so a browser-only UI should use its trusted desktop/backend process as the
bridge. Swift and Electron main-process clients can call it directly.

## Contract example

```ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

const discovery = JSON.parse(
  await readFile(`${homedir()}/.aiko/native/api.json`, "utf8"),
);
const headers = {
  authorization: `Bearer ${discovery.authorization.token}`,
  "content-type": "application/json",
};

const health = await fetch(`${discovery.baseUrl}/v1/health`, { headers }).then(
  (response) => response.json(),
);
const tasks = await fetch(
  `${discovery.baseUrl}/v1/contracts/scheduled`,
  { headers },
).then((response) => response.json());

await fetch(`${discovery.baseUrl}/v1/signals`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    name: "frontend.import.finished",
    cwd: "/path/to/workspace",
    detail: "Import completed with 12 records",
  }),
});
```

## Login state (whoami)

`GET /v1/auth` reports whether the machine's Aiko CLI holds a cloud login,
using the same decision path as `aiko login`/`aiko logout`: the effective disk
config (including the persisted built-in provider) selects the auth scope, and
`auth.json` is consulted through the CLI's own auth readers.

```json
{
  "schema": "aiko.native.v1",
  "signed_in": true,
  "provider": null,
  "accounts": [
    {
      "label": "Aiko",
      "email": "user@example.com",
      "expires_at": "2026-09-12T09:49:07.316454596+00:00"
    }
  ]
}
```

`provider` is the persisted `BuiltinLoginProvider` (`"aiko"` or `"grok"`), or
`null` when none has been persisted — the CLI then defaults to Aiko at login
time. The response is an explicit allowlist of fields: access tokens, refresh
tokens, and API keys are never serialized, and signed-out state is simply
`signed_in: false` with an empty `accounts` array. Frontends (e.g. the desktop
onboarding flow) should treat this as the single truth for "is the CLI signed
in" instead of parsing CLI output.

## Agent/session mail (ACP)

Connect a WebSocket to `agentMailUrl`, using the `aiko.acp.v1` subprotocol.
Desktop clients should send the bearer header. Browser WebSocket clients can
append the discovery token as `?token=...`.

Every text frame is an ACP JSON-RPC 2.0 message. The bridge validates JSON but
does not translate or reinterpret it. That preserves Aiko's existing request
ids, streaming updates, permissions, replay, cancellation, and leader
multi-client behavior.

A typical frontend flow is:

1. connect;
2. send `initialize`;
3. send `session/new` or `session/load`;
4. send `session/prompt`;
5. render `session/update`, `_x.ai/session/update`, tool, permission, and
   `x.ai/session_notification` events;
6. finish the turn on `x.ai/session/prompt_complete`.

Use `GET /v1/leaders` for diagnostics when the WebSocket reports
`leader_unavailable`. The API deliberately does not invent an alternate
transcript or mailbox database.

## Disposable email and paid capabilities

`/v1/agentmail/*` exposes AgentMail disposable inboxes, threads, and
verification-code polling. This is intentionally separate from the ACP
`/v1/agent-mail` WebSocket:

- `/v1/agent-mail` is Aiko agent/session communication;
- `/v1/agentmail/*` is Internet email for an agent.

Creating an inbox currently costs $2.00 through the local Pay rail. The API and
SDK reject creation unless the request contains `"confirmPurchase": true`.
Likewise, `/v1/captcha/solve` requires the same explicit confirmation before
submitting an approximately $0.01 solve. Read and polling routes do not require
purchase confirmation. A frontend should show the stated price and obtain a
fresh user confirmation before setting the flag; it must not persist or infer
the confirmation.

```ts
const inbox = await aiko.createAgentMailInbox({
  name: "Release Bot",
  confirmPurchase: true,
});
const threads = await aiko.agentMailThreads();
```

All paid execution remains subject to the local Pay authorization flow. Aiko
never exposes wallet credentials through discovery or API responses.

## Source contracts

- Interface registry: [`aiko-native-interfaces.json`](aiko-native-interfaces.json)
- OpenAPI 3.1: [`aiko-native-api.openapi.json`](aiko-native-api.openapi.json)
- Native application runtime: [`native-application-runtime.md`](native-application-runtime.md)
- Contract runtime: [`contract-agency-runtime.md`](contract-agency-runtime.md)

Additive fields may appear within `aiko.native.v1`; clients must ignore unknown
fields. Breaking route or semantic changes require a new API version.
