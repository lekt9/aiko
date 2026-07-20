# Native application runtime

Aiko owns a focused Rust CDP runtime below its tool-dispatch boundary. Browser
and Electron access does not link or invoke an external automation package,
CLI, daemon, socket protocol, or MCP adapter.

The model receives two primitives:

- `application_observe` is read-only. It attaches over a CDP URL/port and
  retrieves accessibility snapshots, DOM/React structure, tabs, logs, errors,
  and application API request/response metadata.
- `application_act` is permission-gated as execution. It navigates, interacts
  through stable accessibility refs, controls tabs and input, and can evaluate
  calls against APIs intentionally exposed by an Electron preload bridge.

Both primitives share one in-process session. The native runtime exposes a
closed allowlist containing only Aiko's application capabilities; unknown
commands fail closed. Before the first model sample, Contract
returns typed capability cells with tool, action, requirements, permission,
confidence, freshness, availability, and dependency sequence. The same route
is installed into the prompt-scoped tool dispatcher; it is not merely pasted
into a system prompt.

Aiko discovers local CDP endpoints on the standard loopback ports. When a
routed sequence requires it, the dispatcher can perform the safe read-only
prerequisites (`attach`, then `snapshot`) itself. Write actions still pass
through the normal permission boundary. A user can still provide a CDP URL or
port explicitly, but does not need to call Contract or manually prepare its
route.

After execution, Aiko records a shape-only v2 outcome through Contract's
persistent native ABI. Feedback includes application identity, permission
outcome, duration, availability, result schema, success/failure, and fractal
parent lineage. User-entered values, expressions, URLs, response bodies, page
contents, and window titles are not written into the learned exemplar.
Successful outcomes become routable; failures inhibit the cell. Old evidence
is marked `verified_stale` and cannot auto-route.

The primitive implementation lives in
`crates/common/xai-application-runtime`. It owns CDP WebSocket request
correlation, local Chrome launch, direct Electron attachment, accessibility
snapshots and refs, DOM actions, tabs, network/API capture, console/errors, and
React inspection. Agent Browser's CLI crate is not present in Aiko's Cargo
graph. `UPSTREAM.md` in that crate records the upstream behavior reference used
for compatibility audits.

Machine prewarming is metadata-only: NSWorkspace supplies frontmost/running
application identities, local CDP probing supplies endpoint availability, and
recent Aiko trajectories contribute capability names only. No system log
ingestion is used. Set `AIKO_MACHINE_CONTEXT=off` to disable automatic machine
context for an ungrounded control turn.

## Distribution and linked development

Contract is a separately maintained repository and a packaged Aiko runtime
component. A release package contains the Aiko executable beside
`lib/libcontract.dylib`, plus a manifest that pins SHA-256 hashes and the
Contract source commit. Aiko resolves Contract in this order:

1. `AIKO_CONTRACT_LIBRARY`
2. `../lib/libcontract.dylib` relative to the running executable
3. `~/.aiko/lib/libcontract.dylib`
4. the sibling development repository's `zig-out` library

Every candidate must export Contract ABI version 2. Aiko skips missing or
incompatible libraries before resolving any function pointers, so a linked
Contract experiment cannot accidentally call a mismatched native interface.

`scripts/contract-runtime.sh build-aiko` (and the script with no command)
refreshes the combined package by default. Run
`scripts/contract-runtime.sh package` explicitly for the same packaging
workflow or
`scripts/contract-runtime.sh install` to build, verify, and atomically install
both components.

During development, `scripts/contract-runtime.sh dev-link` points the installed
runtime at the Contract repository's build output. Run
`scripts/contract-runtime.sh watch` while editing Contract to rebuild on source
changes. The symlink remains stable, so each new Aiko process sees the newest
successful Contract build immediately.
