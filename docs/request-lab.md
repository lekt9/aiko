# Request lab

Run `pnpm aiko:lab`, then open <http://127.0.0.1:4246/control>. The local
demonstration automatically opens the Request lab tab using a public fixture
credential. Set `REQUEST_LAB_PORT` to use another port. Stop with Ctrl+C.

The same tab is part of the existing control dashboard. On Node hosts,
authenticated accounts with write access can run the controlled checks. Other
hosts report that the local lab is required. The Node graph and event timeline
continue to expose recorded account evidence independently.

The lab runs the actual `BrowserLearning` compiler, request DAG executor,
`RequestMemory`, entity-learn, and existing `ToolWorkflows` executor. Request
observations, responses and embeddings are deterministic examples. Each button
starts an isolated experiment with fresh disposable SQLite storage. A fixed
example workflow is promoted after a successful run and its run-ID deduplication
is checked; the agent does not generate this example program.

| Control | What the experiment measures |
| --- | --- |
| Baseline | Two captured requests become a compiled dependency, an indexed pointer, and a reusable example workflow. The second request uses a fresh ID from the first response. |
| Unchanged response | The response digest stays the same. Current request-check heads still advance, making a directly dependent observation stale. The lab exposes this limitation and explicitly recomputes the derived record. |
| Changed response | The example queue changes from three items to four. The response digest changes, the old derived record becomes stale, and explicit recomputation follows the new check. |
| Missing dependency | The first response omits the value required by the second request. Execution stops after one request and no successful comparison check is written. The old record's freshness alone does not establish that this refresh succeeded. |

Inspect a node for its identity and relationships, compare the baseline and
comparison receipts, and read the measured assertions. A successful test of a
blocked operation is different from a successful operation.

The reports include structural component events and measured local durations.
They do not represent a native actor run, real browser capture, real network
traffic, model inference, social publishing, or Telegram delivery. Cached pointer
and workflow reuse are verified within each isolated experiment. These checks do
not establish persistence between lab runs or a production speedup.

`GET /api/control/request-lab?account=…` reports availability without running any
checks. `POST /api/control/request-lab` accepts exactly `{account, scenario}`.
The four scenario names are `baseline`, `unchanged`, `changed`, and
`missing_dependency`. Owner boundaries and write scope are enforced; arbitrary
URLs, request bodies, credentials, or programs are not accepted. The runtime
allocates an empty database and closes it in `finally`; the experiment refuses
pre-existing storage.

The next implementation steps remain in [the architecture plan](browser-request-skills-plan.md):
separate value heads from freshness checks, strengthen primitive version pinning,
add durable skill inputs and scheduled invocation, and connect updates to SDK
subscriptions.

The associated transport repair now permits trusted current-session and
response-derived headers through the real HTTP adapter. A separate controlled
HTTP-server integration test verifies cookie domain/path/expiry selection,
rotation, deletion, CSRF forwarding, and manual redirects. Captured credentials
remain forbidden in artifacts. That test supplies an explicit native CSRF
binding: automatic inference of the captured CSRF header remains unverified.

Verification: 53 focused tests passed, including control API authorization and
unchanged personal-memory/native-thread assertions. The Node agent typecheck
passed. Browser checks exercised all four scenarios, keyboard tabs, a stopped-host
failure, and clearing results on lock. At 390 px and 320 px there was no document
overflow; desktop and mobile axe checks reported no WCAG A/AA violations in the
Request lab panel. The full Worker typecheck is currently blocked by concurrent,
unrelated `zoho-vault.ts` argument-type errors.

Evidence is in [artifacts/request-lab](../artifacts/request-lab/). The local demo
does not deploy or restart the production Worker.
