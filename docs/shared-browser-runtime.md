# Shared browser runtime

Unlock references `../unbrowse-playground/runtime` directly as the private
`@unbrowse/browser-harness` package. Both `package.json` and
`apps/agent/package.json` declare a relative `link:` dependency. pnpm creates
symlinks to that checkout; there is no vendored `packages/browser-harness` or
`packages/browser-runtime` implementation and no copy/sync step.

Keep the two repositories beside each other:

```text
work/
  unbrowse-playground/runtime/
  unlock/
```

From Unlock, install each repository's locked dependencies explicitly:

```sh
(cd ../unbrowse-playground/runtime && bun install --frozen-lockfile --ignore-scripts)
pnpm install --frozen-lockfile --ignore-scripts
```

pnpm does not install dependencies inside a `link:` target. Native installation
remains explicit (`pnpm aiko:browser:init`), with the pinned size/SHA-256 checks.
No package lifecycle downloads a browser. A missing sibling fails setup; there
is no fallback to an older local copy.

Unlock imports the package's low-level `/client`, `/trace`, `/network-*`,
`/har`, `/response-semantics`, `/harness-runtime`, `/harness-artifact`, and
`/network-tool-catalog` exports. The same source files serve the playground.
Its Tardie 0.17 actor assembly stays separate from Unlock's Tardie 0.22 actor.
The full playground controller and UI are not part of Unlock's agent loop.

The shared client supports explicit host options for rolling trace windows,
a required filtering proxy, a fixed private screenshot path and a relocated,
still-verified native binary. Unlock's proxy, owner/session handling, private
login, Codegraff lifecycle and transport remain in `apps/agent/src`. Unlock's
background-event listener lives in `apps/agent/src/cdp-background-listener.ts`
and its tests in `apps/agent/test/`; its private BackgroundService capture is
not mounted into the playground. It uses the shared public network-listener
socket types and endpoint validator. The shared read compiler accepts an
explicit trusted browser-session requirement; no
session transport or approval is mounted by importing it.

Editing shared source in the playground is visible to Unlock's next import, restart or build
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
reintroduced vendored fallback or the playground's Tardie 0.17 agent loop. It
also injects a temporary shared-client edit into the build loader, without
writing source or executing the result, and requires the runner digest to
change. Both the root tooling and agent package must resolve every public
export to the actual sibling source.

On 2026-09-08, the user requested restoration of this direct link after Unlock
had switched to a workspace snapshot. The snapshot was removed and Unlock's
local background listener was preserved in the agent application. Older
snapshot provenance/evaluation receipts describe historical inputs, not the
new linked build; rerun the relevant gates before release.

Restoration checks passed: frozen offline install, 35 shared-client tests,
50 focused Unlock tests (including import identity, bundle edit propagation,
background listener/runner and channel source), and the package's external
install/type/import-safety test. Opt-in live browser tests were skipped. The
broader Unlock run and both full type gates encountered failures in other
in-progress changes; this migration is not a full-suite or deployment pass.

CI checks out `unbrowse-ai/playground` beside Unlock, installs both lockfiles
with lifecycle scripts disabled, and builds the currently checked-out source.
For a private playground repository, configure the read-only
`PLAYGROUND_READ_TOKEN` Actions secret; the default job token cannot normally
read another private repository. Secret-less fork jobs cannot access that
checkout and do not fall back to a stale copy. Updating playground alone does
not trigger an Unlock deployment: run Unlock's build/CI against the desired
checkout, then deploy separately with approval.

The 2026-09-06 reference migration passed 536 agent tests, both repositories'
typechecks, the shared package's external-install check, 326 playground tests,
actor lint/build and a Cloudflare deployment dry run. A controlled in-memory
shared-client edit changed the resulting runner digest without modifying either
checkout. The dedicated Codegraff probe passed both wait tools, missing-selector
recovery, cross-site navigation, 1280×1000 screenshot capture, stale-bundle
rejection, same-VM restart, private handoff reconnect and settled cancellation.
It recorded 196 structural trace events and stopped the test VM afterward.
These are test results; production was not deployed by this migration.

## Isolated verification worktrees

An Unlock worktree also needs an isolated sibling runtime. Preserve the relative
layout above and pin both source revisions; linking an isolated Unlock tree to
the live playground still lets concurrent runtime edits change its test input.
Do not vendor browser source into Unlock to avoid setting up the sibling.
Verify the resolved module paths from both the root and agent package before
running source-bound checks.

Start from the relevant dirty source baseline, not just HEAD, without resetting,
stashing or changing the user's index. Keep pre-existing edits separate from the
worker's delta. Install both pinned dependency trees with scripts disabled, or
use a verified independent dependency cache. Never hardlink writable dependency
files directly to a live checkout. If workers share a private cache, mount it
read-only; workspace package links must still resolve to each worker's source.

For Pi continuations, `cd WORKTREE && pi --session ORIGINAL` is not enough:
this installed CLI restores the session's recorded working directory. Use its
native full-history fork when moving to another worktree, retaining
`parentSession` and a pinned continuation ID; do not rewrite the original history.
Recheck the installed CLI contract when changing launch behavior.

Execution receipts must distinguish dispatch, a live process, new task activity,
completion and integration. Bind process status to boot identity and process
start time, not a reusable PID. Inherited tool calls in a fork are not new work.
After a restart, reconcile both original and fork writers before any continuation;
never remove a dispatch fence to force a retry. The local 2026-09-08 recovery
fixtures checked these boundaries and filesystem write denial; they are not
application or deployed-provider acceptance evidence.

## Concurrent tasks and account tabs

Each Unlock account keeps its existing isolated browser/profile. Native task
threads receive host-selected tab handles through `BrowserDriver.forTab(key)`;
the key is derived from owner + thread, not supplied in model arguments. Up to
16 task tabs can coexist per account, within the controller's existing eight
account limit. Same-account tabs share that account's cookies; they are **not**
separate website-login identities. Overlapping credential scopes still fail closed.

Tasks may remain active together, including while one awaits approval. The
pinned v0.36 client has one active-tab command channel, so **selection and the
complete native operation are queued together**. This is concurrent task access,
not simultaneous native command execution: a long native wait delays the next
queued operation. Codegraff also queues dispatch plus durable event flush. Models
cannot list/switch into another task's tab. Page inspection and read replay pin
an exact CDP target, including when several tabs have the same origin. The
owner's screenshot surface follows the last live task tab.

Closing/cancelling a task releases its tab, not the account VM or sibling tabs.
Account retirement still waits for active tasks and preserves watch leases.
Private sign-in and cookie changes remain account-wide custody operations;
owner sign-in invalidates old task handles. A task requiring native sign-in
renewal stops for the account sign-in flow rather than changing sibling custody
implicitly. Old handles cannot silently adopt a new page. Legacy injected drivers
without `forTab` retain account serialization.

The shared client provides host-only create/list/select/close lifecycle methods.
Ownership is the stable CDP target, never an assumed tab-strip index. In a real
local Chromium check, v0.36 `tab close` failed installing network controls and
lost sibling targets. Cleanup therefore pins a survivor, uses Unlock's existing
private CDP connection for one exact `Target.closeTarget`, waits boundedly for
absence and verifies the surviving targets. It never retries a close whose
outcome is uncertain, and exposes no generic CDP/eval tool.

Tests: `browser-tabs.test.ts`, `browser-tab-transport.test.ts`, the task-wrapper
case in `browser-unlock-factory.test.ts`, and the playground's
`test/agent-browser-tabs.test.ts`. Run the optional real-browser check from Unlock:

```sh
AIKO_TAB_TEST_BROWSER=/absolute/path/to/chrome bun test apps/agent/test/browser-tabs.live.test.ts
```

It uses a fresh temporary profile and public `example.com` reads, without model
calls or personal credentials. The local smoke also received independent
`browser-harness` confirmation that both task pages existed together. This is
not verification of private logins or a deployed Codegraff VM. Rebuild/restart
consumers to load the change; deployment remains a separate action.

### Tab-scoped network learning

The shared observer now reports immutable page ancestry separately from each
exchange. `BrowserLearning` in the production driver requires that ancestry:
only the selected page's completed, acknowledged requests enter its graph
checkpoint. Same-origin siblings cannot donate dependency responses or supply
command evidence. Call ownership is assigned during the queued native dispatch,
not guessed when a later snapshot arrives. The original global clock/order and
ambiguous-window checks run before the page-specific call filter. Associations
remain low-confidence timing hints, never approval or execution authority.

Page targets and CDP session IDs stay transient; the log keeps its existing
bodyless facts, digest-bound checkpoints and sparse source-request mapping.
Unknown ancestry, service-worker traffic and unproven top-level iframe/worker
attachments can remain structural observations but do not become a task's
reusable graph. Explicit nested iframe/dedicated-worker attachments inherit
their proven page root. No URL/opener inference or new CDP command is used.

Each page gets its own 120-fact navigation allowance, within the existing
observer limits; navigating a sibling neither clears nor spends that allowance.
After a settled observer replacement, live source IDs continue increasing and
old page eligibility/command associations are discarded. Local index zero in a
new listener must not refer to an earlier task's request. Accounts still share
cookies across their tabs; this is capture isolation, not account isolation.

Checks from Unlock (no model/provider tokens):

```sh
bun test apps/agent/test/browser-learning.test.ts apps/agent/test/browser-tabs.test.ts \
  apps/agent/test/browser-tab-transport.test.ts apps/agent/test/browser-watch-driver.test.ts
(cd ../unbrowse-playground/runtime && bun test test/cdp-network-listener.test.ts test/agent-browser-tabs.test.ts)
AIKO_TAB_TEST_BROWSER=/absolute/path/to/chrome bun test apps/agent/test/browser-tabs.live.test.ts
```

The 2026-09-08 focused checks cover interleaved same-origin IDs, delayed responses,
redirects, attachment ancestry, detachment/reuse rejection, secret exclusion,
wrong-tab timing/CSRF producer rejection, independent capture allowances and
observer replacement. The real pinned Chromium smoke additionally checks three
successive task targets, page-specific checkpoints and disjoint command IDs,
while confirming that closing one tab preserves its sibling. It uses public
`example.com` pages; it does not establish private-site replay compatibility or
simultaneous native command execution. Verification passed 65 shared and 76
consumer focused tests (four separate opt-in skips), the real-browser smoke,
and the external package install/type/import-safety gate. Full verification
still encounters the unrelated `harness-session-recompute.test.ts`
duplicate-origin type error in the playground; the latest consumer type gate
stopped in an in-progress `native-login-render.test.ts` fixture missing required
view fields. This is not a full-suite pass; recheck all gates before release.

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
