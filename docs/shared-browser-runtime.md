# Shared browser runtime

Unlock references `../unbrowse-playground/runtime` directly as the private
`@unbrowse/browser-harness` package. Both `package.json` and
`apps/agent/package.json` declare a relative `link:` dependency. pnpm creates
symlinks to that checkout; there is no vendored `packages/browser-runtime`
implementation or copy/sync step.

Keep the two repositories beside each other:

```text
work/
  unbrowse-playground/runtime/
  unlock/
```

Install the shared package's dependencies with `bun install --ignore-scripts`
inside `unbrowse-playground/runtime`, then run `pnpm install --ignore-scripts`
in Unlock. Native installation remains explicit (`pnpm aiko:browser:init`),
with the pinned size/SHA-256 checks. No package lifecycle downloads a browser.

Unlock imports the package's low-level `/client`, `/trace`, `/network-*`,
`/har`, `/response-semantics`, `/harness-runtime`, `/harness-artifact`, and
`/network-tool-catalog` exports. The same source files serve the playground.
Its Tardie 0.17 actor assembly stays separate from Unlock's Tardie 0.22 actor.
The full playground controller and UI are not part of Unlock's agent loop.

The shared client supports explicit host options for rolling trace windows,
a required filtering proxy, a fixed private screenshot path and a relocated,
still-verified native binary. Unlock's proxy, owner/session handling, private
login, Codegraff lifecycle and transport remain in `apps/agent/src`. The shared
read compiler accepts an explicit trusted browser-session requirement; no
session transport or approval is mounted by importing it.

Editing shared source here is visible to Unlock's next import, restart or build
without copying, publishing, committing a submodule or reinstalling the link.
Running Bun processes keep loaded modules until restart. Codegraff receives a
compiled runner bundle, so production still needs its Worker rebuilt/deployed;
existing VMs install the changed bundle at their next checked wake. Playground
UI changes and agent-specific policies remain in their respective applications.

Checks:

```sh
pnpm --filter @unlock/agent typecheck
pnpm test:aiko
pnpm test:browser-client
bun scripts/probe-codegraff.ts --browser-runtime
```

The live probe rebuilds current shared source, checks the dedicated Codegraff
VM's browsing/recovery/reconnect/cancellation/stop-start behavior, then stops it.
It incurs provider usage. `shared-browser-library.test.ts` verifies actual module
identity and paths, checks the production bundle's source graph, and rejects a
reintroduced vendored fallback or the playground's Tardie 0.17 agent loop.

The 2026-09-06 reference migration passed 536 agent tests, both repositories'
typechecks, the shared package's external-install check, 326 playground tests,
actor lint/build and a Cloudflare deployment dry run. A controlled in-memory
shared-client edit changed the resulting runner digest without modifying either
checkout. The dedicated Codegraff probe passed both wait tools, missing-selector
recovery, cross-site navigation, 1280×1000 screenshot capture, stale-bundle
rejection, same-VM restart, private handoff reconnect and settled cancellation.
It recorded 196 structural trace events and stopped the test VM afterward.
These are test results; production was not deployed by this migration.

## Browser included in Codegraff sandboxes

Checked against the public Codegraff documentation and source on 2026-09-06.
The Cloudflare host already makes the browser available automatically:
`createCloudflareCapabilities` mounts `CodegraffSandbox.browserFactory()`, and
the first operation requiring the VM calls `ensure()`. Users do not install a
browser or run the local `aiko:browser:init` command in a hosted account.

The existing provisioning path in `apps/agent/src/codegraff.ts`:

1. Allocates one owner-bound JavaScript sandbox and records its identity.
2. Uploads `assets/bootstrap.sh` and runs it with asynchronous exec plus polling.
   It installs Bun, Chromium, fonts, media utilities and the local response
   embedding dependency when absent.
3. Uploads the compiled `sandbox-runner.ts` bundle, which includes the shared
   playground browser library. Its install command downloads and verifies the
   pinned native agent-browser executable.
4. Writes the account binding and starts the private loopback runner. Readiness
   requires a successful health check with the expected bundle digest.

The stored digest covers the runner and bootstrap. An unchanged installation is
reused on subsequent wakes; a changed bundle is installed after the previous
runner closes. Stop/start preserves the VM disk and browser profile, while the
runner and browser processes restart. This is automatic installation on first
use, rather than a browser baked into Codegraff's base image.

The [hosted sandbox API](https://codegraff.com/docs/sandboxes) documents creation,
async exec, file transfer and stop/start/delete. It does not document an image,
template or snapshot parameter, or an endpoint for publishing custom images.
The open-source CLI's [snapshot design](https://github.com/justrach/codegraff/blob/main/docs/adr/0051-sandbox-teleport-and-gc.md)
uses local Docker/Apple Container backends and explicitly says Daytona is not a
backend there. That feature is not evidence of hosted gateway image support.

Keep automatic bootstrap and persistent per-account reuse as the supported
default. If Codegraff exposes a custom base image later, bake only the shared
software and public model assets into it, and keep owner bindings, cookies,
passwords and browser profiles out of the image. Unlock session installation
continues at runtime through the existing private browser adapter. A prebuilt
image would remove dependency installation from the cold path; it would still
need account binding, process startup and the health check. Preparing a VM
during onboarding could hide that delay using today's API, but would allocate
resources even for users who never browse.

Run `bun scripts/probe-codegraff.ts --browser-fresh` to verify this default on a
new disposable VM. It builds the production runner, calls the normal browser
factory with no manual setup, checks public navigation and screenshots, then
reconstructs the host and resumes the same VM. It requires exactly one sandbox
allocation, one bootstrap and one native installation across those operations.
The probe deletes only its newly allocated VM in `finally`; its private state
directory retains the VM ID for reconciliation if the process is interrupted.
It incurs provider usage and records content-free evidence at
`artifacts/aiko-cloudflare/browser-fresh.json`.

The 2026-09-06 fresh run passed: 27.1 seconds to initial readiness and 5.1 seconds
to readiness after stop/start, with the browser directory preserved and no
reinstall. These are observations from one run, not latency guarantees. Native
browser downloads now pass the pinned size/hash check before an atomic rename
to the installed path, so interruption cannot publish a partial executable.

After deployment, `bun scripts/verify-aiko-cloudflare.ts --browser-default`
uses the isolated agent-plane canary to navigate and read a public page through
the native actor, then requires its `respond` tool call. It also checks the
deployed sandbox's bundle digest against the local build and confirms the
temporary Cerebras model routing. It records
`artifacts/aiko-cloudflare/browser-default-deployed.json`; it does not send a
Telegram message.

The deployed check passed on 2026-09-06: `agent_browser_navigate` and
`agent_browser_title` returned completed receipts, followed by `respond`, using
Cerebras. The runner digest matched the built artifact. The earlier failed
canary attempt remains in `browser-default-deployed-first.json`; the fresh VM
and deployed actor are separate checks, so a passing isolated VM does not
stand in for a passing deployed actor.
