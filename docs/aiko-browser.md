# Aiko: the playground browser, on the native harness

Aiko now mounts the actual **29-tool agent-browser client from `/home/deck/work/unbrowse-playground`**, through **Tardie 0.22.0** native tools. It does not run the playground's older Tardie 0.17 agent/model loop. Entity-learn remains the real memory engine.

This is an opt-in **local public-web browser**, not authenticated account access or a hosted user VM. Public browsing was tested against real websites with stock Chromium and deterministic inference; no paid model, ThinkFeel, real-account, payment or Telegram-provider request was made.

## Run

```sh
pnpm install --frozen-lockfile
pnpm aiko:init
pnpm aiko:browser:init
# The last command verifies/downloads the exact official agent-browser 0.36.0
# native asset. It neither installs nor launches Chromium.

AIKO_BROWSER_ENABLED=true \
AIKO_BROWSER_EXECUTABLE=/absolute/path/to/chrome \
AIKO_TOOL_CALL_LIMIT=unlimited \
pnpm aiko:dev
```

Supply a maintained, trusted **Chromium executable**, not the agent-browser launcher. The path must be absolute, a regular executable file, and not group/world writable. Resolve symlinks explicitly. In this workstation's isolated verification we used `/home/deck/.cache/ms-playwright/chromium-1187/chrome-linux/chrome`; that test path is not a portable or automatic update policy.

The installer can reuse an existing official asset without downloading:

```sh
pnpm aiko:browser:init --source /path/to/agent-browser-linux-x64
```

The asset's exact size and SHA-256 are checked on installation and use; existing mismatches are not overwritten. No npm install hook, CloakBrowser download, provisioning, profile import or public tunnel is run.

Open `http://127.0.0.1:4242`, unlock with your private operator token, and choose **Public website**, or send `Browse https://example.com`. Demo mode performs actual native navigation, snapshot, body-text and current-URL reads, but does not use an LLM. Expand **Browser · observations & approvals** to inspect the evidence. Your existing runtime/configuration has not been explicitly reconfigured by this build; restart it with the flags above to enable the feature.

Free-form GLM planning still requires the separate explicit paid-inference configuration in [the agent README](../apps/agent/README.md). Enabling the browser does not enable paid inference or ThinkFeel.

## Less task-specific, without a second loop

- Default public mode can move between public sites, rather than being fixed to one entry domain or HAR-authoring task.
- `AIKO_BROWSER_ALLOWED_DOMAINS=example.com,*.example.com` optionally narrows browsing. Default: `*`. A wildcard must stand alone and requires the host's filtering proxy.
- Tool calls are **unlimited by default**. `AIKO_TOOL_CALL_LIMIT=unlimited` overrides a previous numeric limit; positive safe integers explicitly opt into a native budget. See [unlimited execution and remaining safeguards](aiko-unlimited.md).
- Native compaction, repair, cancellation, event persistence, recovery and delivery remain in control. Repeated identical observations no longer stop the turn; there is no automatic restart loop.
- Browser evidence stays bounded: the most recent two observations are hydrated into model context; larger observations are explicitly excerpted. A rendered-request byte guard omits oversized transient expansion without terminating the task; earlier native compaction keeps history within the finite model window. Save useful non-secret findings as explicit entity-learn **agent claims**, not as verified source observations.
- Long replies retain whole recent receipts, disclose omissions and remain within Telegram's text limit. An earlier uncertain browser outcome remains disclosed even if its individual receipt is omitted. Cancellation/failure after browser activity no longer falsely promises that nothing changed.

## Approval and recovery

Clicks, double-clicks, key presses, form edits, checkbox/selection changes **and form-value reads** need a fresh human decision. The owner sees exact arguments, the current page URL and a bounded snapshot. A changed URL or snapshot, oversized preview, denial, expiry, wrong owner or cancellation prevents the requested interaction. Credential entry is not supported; never put passwords or cookies in chat or approve credential fields.

- `GET /api/browser`: authenticated owner's transient observations and pending approvals.
- `POST /api/browser/approval`: `{ "id": "<pending-id>", "approve": true }`; owner comes exclusively from authentication. No scope/owner selector is accepted.
- Browser arguments become opaque handles **before native `ToolCalled` persistence**. Handles bind owner, native thread, turn and operation. Raw arguments are not reconstructed from durable logs after restart.
- Persisted action-start without completion becomes **unknown**, never an automatic replay. If a restart loses an unstarted request's transient arguments, it is blocked. A completed command is not proof of a completed purchase, booking, message or deletion.
- Cancellation interrupts the native turn, rejects pending approval and closes its browser after already-running command settlement. It cannot guarantee that an in-flight interaction had no effect.
- Profiles are account-isolated, never imported from personal browsers. Local profiles are temporary; hosted Codegraff profiles persist in their owner VM. At most eight account sessions are admitted. Tasks have host-selected tabs (up to 16 per account); native select + dispatch stays queued because the pinned daemon has one active-tab channel. Task cleanup preserves siblings. Account profiles retire after four idle minutes unless a task or watch holds them. See [task tabs and their limits](shared-browser-runtime.md#concurrent-tasks-and-account-tabs).

Automatic navigation/read operations are not a universal no-side-effect guarantee: websites can execute scripts and GET requests can change server state. Human confirmation binds the proposed interaction and snapshot, not a guaranteed business outcome or atomic website transaction.

## Privacy and network boundary

The linked `@unbrowse/browser-harness` package retains the real process adapter, pinned executable verification, strict schemas/argv, value-free telemetry and bounded transport. Aiko does not expose shell/CLI strings, JavaScript evaluation, file access, cookie export, arbitrary flags or imported profiles to the model.

Page excerpts and model interpretations are retrievable from bounded process memory for up to 15 minutes (and may be evicted earlier); the console displays the latest eight. Expired entries are pruned on access/shutdown, not securely erased on a timer. Chromium can cache pages in its private temporary profile; abrupt process loss can leave private temporary files requiring operator cleanup. Browser tool persistence contains metadata and receipts, not automatic page-body/typed-value transcripts. Live mode sends hydrated excerpts to the configured model provider. ThinkFeel still never receives them. Explicit memory writes can persist selected non-secret claims. User messages themselves remain durable: redaction is defense in depth, **not comprehensive DLP**. Lock clears the console's token and evidence, not server memory or an active task; use Cancel to interrupt work. Profile idle/shutdown cleanup and observation expiry are separate.

The public-web proxy allows ordinary HTTP/HTTPS public IPv4 destinations on default ports. It rejects literal IP URLs, credentials in URLs, local/internal-style names, private/reserved DNS answers and custom ports. DNS answers are validated, then a checked numeric address is used for the connection. Connections, DNS waits, time and bytes are bounded. Chromium's implicit loopback proxy bypass, QUIC and nonproxied WebRTC UDP are disabled.

**This proxy and profile separation are not an OS sandbox or a certified egress boundary.** IPv6-only destinations are currently unavailable. Browser vulnerabilities, alternative transports, hostile page behavior, operational cleanup failures and multi-user hosting require independent containment/security review. Do not expose this local console publicly or use this slice for authenticated customer browsing.

Supabase Auth/RLS, website Telegram OAuth, personal account/custody linking, secure human sign-in, CloakBrowser SaaS rights, independently enforced VM egress and Codegraff VM persistence remain separate gates. They have not become live because public browsing works. HAR/compiler modules copied as the client's dependency closure are not a mounted HAR-to-API learning or classic-Contract integration.

## Verification

- Run `pnpm test` for the current project suite; database-dependent skips are reported separately. See the [unlimited execution receipt](../artifacts/aiko-unlimited/verification.json) for updated counts.
- Native regressions cover sixteen tool calls, bounded truthful replies, opaque argument logging, transient page/model output through the actual GLM adapter with a mocked provider stream, signed fixture-owner isolation, approval/denial/stale snapshots, cancellation, continued execution across unchanged results and configuration/egress rejection.
- A real native host restores a log at the action-start/pre-finish boundary and produces an unknown receipt without opening a browser or repeating the interaction.
- `scripts/aiko_browser_qa.py`, run through **browser-harness**, uses actual agent-browser/Chromium to read `example.com` then `iana.org` in one session. No mocked browser is used for those checks.
- Public-browser and approval layouts are checked at 320/390/768/1440, including actual viewport-width assertions. Approve/deny buttons and hostile-looking snapshot text are tested separately with a synthetic browser driver. Existing console/memory QA is rerun with isolated data. Combined: **11 browser checks and 8 clean axe scans**.

Historical browser-integration evidence: [`artifacts/aiko-browser/verification.json`](../artifacts/aiko-browser/verification.json), logs, review and screenshots. Current source linkage: [shared browser runtime](shared-browser-runtime.md).
