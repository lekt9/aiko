# @unbrowse/browser-harness

Reuse the playground's browser setup from a Bun application, without React.
`runBrowserTask` calls the same controller as the remote playground: pinned
agent-browser, optional verified CloakBrowser, native Tardigrade inference and
compaction, strict CLI tools, structural tracing, useful-read indexing and
settled cleanup. This is a Bun 1.4+ server library, not a browser/Node.js bundle.

## Install privately

From this repository's `runtime/` directory:

```sh
bun run library:pack
```

This creates `unbrowse-browser-harness-0.2.0.tgz`. In another Bun project:

```sh
bun add --ignore-scripts /path/to/unbrowse-browser-harness-0.2.0.tgz
bun add -d @types/bun
```

The package remains private and unpublished. Its allowlist excludes environment
files, databases, traces, browser binaries, fixtures, node_modules and React UI
files. Do not enable agent-browser's upstream postinstall. Run the existing
verified installer explicitly instead:

```sh
bun -e 'import { installPinnedAgentBrowser } from "@unbrowse/browser-harness/install-agent-browser"; await installPinnedAgentBrowser();'
```

Use the standard Bun server TypeScript configuration (`lib: ["ESNext"]`,
`types: ["bun"]`, `moduleResolution: "bundler"`). Keep this server library out
of a frontend/DOM compilation: it ships TypeScript source, including the pinned
Tardigrade source types, rather than pretending to support browser globals.

The stock backend requires a supported local Chrome/Chromium installation.
For the same optional CloakBrowser setup as the playground (Linux x64 only):

```sh
bun -e 'import { installPinnedCloakBrowser } from "@unbrowse/browser-harness/install-cloakbrowser"; await installPinnedCloakBrowser();'
```

Both installers accept `{ verifyOnly: true }` to check without downloading.
CloakBrowser is downloaded directly from its vendor, never redistributed in
this package. Its pinned older community build is for the reviewed isolated
evaluation setup; third-party browser-control hosting needs the separate vendor
license. Setup needs a writable installation; perform it before making a
deployment read-only. No browser, service, installer or database starts on import.

## Run a task

Structural evidence still needs a local Tardigrade inspector. Reuse the existing
playground inspector or create `actor.ts` in your application:

```ts
export { default } from "@unbrowse/browser-harness/actor"
```

With your own `TARDIGRADE_TOKEN` set in the server environment, start it in a
separate terminal:

```sh
bun run tdg dev --port 4242
```

Then run this from your trusted application server with `TARDIGRADE_TOKEN` and
`CEREBRAS_API_KEY` supplied through its environment:

```ts
import { runBrowserTask } from "@unbrowse/browser-harness"
import { HarnessRegistry } from "@unbrowse/browser-harness/index-store"

using indexStore = new HarnessRegistry({ database: ".state/browser-index.sqlite" })
const stop = new AbortController() // Call stop.abort() from your own Stop handler.

const result = await runBrowserTask({
  prompt: "Inspect the page and describe its main public interface.",
  targetUrl: "https://example.com/",
  allowedDomains: ["example.com"],
  browserBackend: "cloakbrowser", // Omit to use stock Chrome/Chromium.
  baseUrl: "http://127.0.0.1:4242",
  actor: "har-website-inspector",
  token: process.env.TARDIGRADE_TOKEN!,
  model: "qwen-3.8-27b",
  browserAgent: {
    apiKey: process.env.CEREBRAS_API_KEY!,
    gatewayUrl: "https://api.cerebras.ai"
  },
  indexStore,
  signal: stop.signal,
  onNdjson: (line) => { process.stdout.write(line + "\n") }
})

console.log(result)
```

Omitting `threadId` allocates a new opaque ID; explicit IDs require one writer.
Each call starts a fresh isolated browser and resolves only after final capture
and cleanup. A task's `result.success` means controller completion, not
independent verification of the agent's answer. Aborting also waits for bounded
active operations/cleanup to settle. Do not automatically retry a task that
could have performed a mutation.

`onNdjson` receives structural, value-free trace lines after canonical append.
For assistant replies and bounded tool output, explicitly provide `onDebug` to
an authenticated, transient display. A final answer has `kind: "assistant"` and
a `Tardigrade TurnCompleted\n` prefix; it can arrive before cleanup finishes.
Debug can contain sensitive page text. Do not persist it as application logs.

Trusted library callers may set `allowedDomains: ["*"]` to browse across
websites. This controller-only sentinel omits the native domain filter; direct
HTTP(S) navigation still rejects credentials, literal IPs and internal hostnames.
It is not network-level isolation. Use concrete patterns for domain containment.
The remote form selects this mode only for blank targets under the host `*`
policy; entering a target retains its domain restriction.

The model, endpoint, credentials, domains, spend policy and optional adapters
are trusted host configuration. Never spread untrusted request JSON into
`runBrowserTask`. The library does not load this playground's `.dev.vars` files.
Custom durable storage integrations may supply `traceSink`; it receives the
same structural tool, network, graph-checkpoint and draft events as the
playground. Maintain canonical append-before-result and manifest validation.
An in-memory/no-op sink is a test adapter, not durable production
tracing.

## Passive network logging (0.2)

There is no browser HAR file or separate capture/import workflow. A host-only
listener attaches to the isolated browser before navigation. It mechanically
records HTTP(S) requests, joined response metadata and background traffic in
the tool run's Tardigrade log. The playground's existing DAG and Harness
assembly consume checkpoints of that log. An explicit source-ID mapping keeps
completed reads discoverable even if an earlier request is still pending.
Body values and cookies remain in transient controller memory, not the log.
Missing wire metadata/body evidence is not invented or approved for replay.

Version 0.2 removes `captureId`, `captureThread`, `harImporter` and
`beforePrivateHarRead` browser options; passing them fails explicitly. Manual
HAR import in Capture Lab is unchanged. Rebuild/restart the inspector as well
as the browser service to register the additive `net1:` event keys.

Ordinary browser actions and initial navigation have no outer deadline by
default. Set `browserAgent.limits.actionTimeMs` to a positive number if needed;
the remote service reads the equivalent host-only
`BROWSE_HARNESS_ACTION_TIME_LIMIT_MS=none|positive-ms`. Stop still cancels and
settles active work. Native agent-browser operation/IPC waits, model I/O,
cleanup, spend and storage protections remain finite. A timed-out durable
append is indeterminate: no later action is started, but a remote write already
accepted by a custom sink cannot be revoked by a local timer.

`bun run test:browse:passive` runs the pinned real browser against a local test
page, including GET/POST observation and native Tardigrade tool calls. Its
model is scripted and it spends no provider tokens; it does not prove a live
Qwen task or website replay.

## Public modules

| Import | Purpose |
| --- | --- |
| `@unbrowse/browser-harness` | `runBrowserTask`, errors/types, 29 CLI tool descriptors/definitions and strict tool-call decoder. |
| `…/protocol` | The existing `browse-harness/1` contract, four index tool descriptors and bounded debug helpers. |
| `…/server` | `BrowseHarnessController`, `browseHarnessFetch`, environment config and confined static-asset loader for an authenticated remote service. |
| `…/index-store` | Existing SQLite `HarnessRegistry`; explicitly construct and dispose it on the trusted host. |
| `…/actor` | The unchanged structural inspector actor and its methods. |
| `…/install-agent-browser` | Explicit `installPinnedAgentBrowser({ verifyOnly? })`. |
| `…/install-cloakbrowser` | Explicit `installPinnedCloakBrowser({ verifyOnly? })`. |

The server module does not bind a port on import. Embed its fetch handler only
on loopback, behind an authenticated HTTPS reverse proxy for remote access.
Supply your own `staticAssets` loader if you want the playground UI; UI assets
are deliberately not packaged. Provide an explicit index store to retain shared
drafts across restarts. The existing environment parser and domain/authentication
rules are unchanged; see the repository's `docs/observatory-ui.md` for that host
configuration. The run-to-playground link expects the observatory at the same
origin's `/`; the standalone remote server does not include that UI.

Tool definitions are descriptions, not permission to execute raw commands. No
shell, generic CDP/eval, upstream chat, arbitrary launcher, model-selected
filesystem path or live HTTP replay tool is added. Runtime controls, finite
cumulative token spending, per-request context/I/O bounds and native integrity
checks are unchanged. Shared read-tool drafts still require independent
verification, approval and value/session bindings before direct execution;
packaging does not implement POST replay or resolve Eatigo's missing inputs.

## Verify in this repository

```sh
bun run test:library
bun run verify
```

The library gate packs and installs the tarball outside the workspace, checks
its file allowlist and TypeScript entrypoints, and tests import/setup safety.
The browser controller regressions run through the public `runBrowserTask` API.

## Shared source with Unlock

The sibling `../unlock` repository uses relative `link:` dependencies on this
package's low-level exports. It imports the actual `/client`, `/trace`,
`/network-listener`, `/network-observation`, `/network-compiler`, `/network-facts`,
`/har`, `/response-semantics`, `/harness-runtime`, `/harness-artifact` and
`/network-tool-catalog` modules. It has no copied browser-runtime source.
Shared edits take effect on the consumer's next restart/build; a running
Codegraff VM receives a rebuilt runner through its normal checked update path.
Application UI and each application's native agent loop remain separate.

`har-facts.ts`, `trusted-network.ts` and `observed-network.ts` hold the shared
pure facts, trusted transient preparation and read compiler. Existing
`har-component.ts`, `import-har.ts` and `browse-thread.ts` re-export their
established contracts and use that same implementation. No actor receives raw
HAR or session values. The low-level paths do not instantiate the Tardie 0.17
actor; Unlock continues to use its Tardie 0.22 host.

Trusted adapters may opt into `rollingTrace` only if each published command is
durably flushed before advancing. `requirePublicProxy: true` requires a valid
host-owned loopback `publicProxy`. `nativeAssetDirectory` relocates the exact
pinned executable for a standalone bundle and retains the same size/SHA-256
verification. These options do not change the playground controller's defaults.
The optional compiler browser-session binding records explicit unmounted
session requirements and value-free resolution evidence; it grants no live
transport or approval authority by itself.
