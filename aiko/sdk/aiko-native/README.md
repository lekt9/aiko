# `@theclarityproject/aiko-native`

Typed, dependency-free client for Aiko's authenticated local frontend API.

```ts
import { connectToAiko } from "@theclarityproject/aiko-native/node";

const aiko = await connectToAiko();
console.log(await aiko.health());
console.log(await aiko.scheduledContracts());

// Cloud login state (whoami) — signed_in, persisted provider ("aiko"|"grok"|null),
// and account label/email/expiry. Never contains token material.
const { signed_in, provider, accounts } = await aiko.auth();

const mail = new WebSocket(aiko.browserAgentMailUrl(), "aiko.acp.v1");
mail.addEventListener("open", () => {
  mail.send(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
    },
  }));
});
```

`browserAgentMailUrl()` is the ACP agent/session transport. Disposable Internet
email uses the explicit `agentMailInboxes()`, `agentMailThreads()`, and
`agentMailThread()` methods. Paid methods require a literal confirmation:

```ts
const inbox = await aiko.createAgentMailInbox({
  name: "Release Bot",
  confirmPurchase: true, // currently $2.00 through the local Pay rail
});
```

The browser URL contains the same-user token as a query parameter because the
browser WebSocket API cannot set an Authorization header. Electron main,
Swift, and other native clients should use `discovery.agentMailUrl` and send
the bearer header instead.

See [`../../docs/aiko-native-api.md`](../../docs/aiko-native-api.md) for the
wire contract and security model.
