# Playground browser runtime, reused by Aiko

Internal source reuse from `/home/deck/work/unbrowse-playground/runtime`, recorded in `provenance.json`. The source checkout was dirty; original file hashes, not its commit alone, identify the imported material. No credentials, browser profiles, captures, databases or older agent loop were copied.

The package exports the actual `agent-browser-client.ts` and the playground's passive network listener, native evidence schemas, normalizer, and read-route compiler. The client's original tests are retained; additional tests cover cancellation and unbounded action duration.

Aiko-specific changes to the client are limited to:

- Recognize a standalone `*` public-domain policy.
- Require a host-supplied, valid-port loopback filtering proxy for that policy.
- Set proxy configuration and disable implicit loopback bypass rather than passing `*` to native `--allowed-domains`.
- Add opt-in `rollingTrace` for Aiko's long-running sessions. The host persists emitted events before its next command; acknowledged completed correlation is retired, late/unresolved results remain tracked within safety bounds, and flood/byte counters apply between settled commands rather than across the lifetime. Original full-capture behavior is unchanged.
- Port the playground's current native nullable action deadline and abort handling. Aiko passes no action deadline; fixed control-plane I/O retains deadlines.
- Expose host-only discovery of this isolated browser's CDP endpoint and fixed-command PNG capture inside its private temporary directory. Neither gives the model arbitrary shell or filesystem access.

Passive observation uses the original `CdpNetworkListener`, `prepareTrustedNetworkEntries`, `inferBoundedHarAssociations`, and `compileObservedReadNetworkTools`. `trusted-network.ts` and `observed-network.ts` extract those pure primitives from the playground's CLI entry points; `har-component.ts` retains its native schemas, validation, projections, and keys without mounting the old runtime component. Imported full modules have only a trailing-newline normalization, plus the documented Worker type adaptations. Provenance records both source and adapted hashes.

Aiko's adapter commits bodyless native facts before deriving a graph. Evidence-complete first-party GET/HEAD JSON routes may produce schema-validated `BrowserNetworkToolPrepared` definitions; incomplete, ambiguous, or credential-dependent candidates remain rejected or pending. Definitions are retained in the owner's VM, and only bounded validated summaries enter the same owner's native entity memory through the foreground hook and hidden indexer. Raw request headers, query values, and response bodies never enter this event stream. Compiling a definition does not authorize replay.

The VM's SQLite transport queue retains every unacknowledged event across runner restarts. Cloudflare appends events to the native foreground journal before acknowledging the queue. Native occurrence keys deduplicate a repeated transport batch; compiled drafts remain in the VM after transport acknowledgement.

Execution remains the client's pinned, exact-size/SHA-256 verified agent-browser **0.36.0** asset. Run `pnpm aiko:browser:init` before the client's tests; it downloads the official release or copies an independently verified `--source` asset. The binary is local installation state under ignored `node_modules`, not a committed executable. No Chromium binary is bundled.

The CLI is Vercel's Apache-2.0 work; its license is included in `agent-browser.LICENSE`. This notice does not assign a new license to the internal playground code or confer CloakBrowser distribution rights.

See [Aiko browser setup and boundaries](../../docs/aiko-browser.md). Tardie 0.22 owns inference, tool calls and recovery; the playground's Tardie 0.17 runtime is not imported or installed.
