# Application runtime provenance

This crate is Aiko-owned and has no source or build dependency on Agent Browser.

Its initial compatibility surface was derived from the behavior of the Apache-2.0 licensed `vercel-labs/agent-browser` native CDP runtime at local source commit:

```text
6ede7a9470ac4b681cabf838af8668b9aa99e957
```

That checkout also contained the uncommitted embedded adapter used during the
initial comparison. Relevant source hashes were:

```text
cli/src/lib.rs                 15be86d7a23fc53a0f965d1a9c72f352a674473c5a0e74edbf8dc5683137bb9b
cli/src/native/actions.rs      90d2df8e3af48bf7adae98b58aa3fd3732bed30dd6a4fc195b5cc009b4cdd5e5
cli/src/native/cdp/client.rs   20d5b53fca3a66a315cfe4d356279864d0aecbc68694fd212c7e9e10ebca7663
```

The implementation was reduced to the primitives Aiko uses:

- WebSocket CDP request correlation and event delivery
- local Chrome launch and direct browser or Electron attachment
- accessibility snapshots with stable element references
- DOM interaction and JavaScript evaluation
- tab lifecycle
- console, exception, request, response-body, and React inspection

Agent Browser's CLI parser, daemon, socket protocol, MCP adapter, plugin system, provider integrations, recording, WebDriver backends, persistence, and unrelated commands are deliberately excluded.

When Agent Browser changes, compare its native CDP behavior against the focused tests in this crate. Port behavior intentionally; do not restore a path dependency on the upstream CLI crate.
