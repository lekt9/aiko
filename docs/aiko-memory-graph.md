# Inspect browser indexing and knowledge

Open the existing Aiko host's **`/control`** page, unlock it with an operator or account token, then choose **Node graph**. No new service, public dashboard, or model tool is required.

- **Account knowledge:** current observations, compiled pages, pinned citations, corrections, relationships and referenced source status. Select a node to inspect its metadata. A stale page remains visibly stale; suppressed evidence and its dependent nodes disappear on the next successful read.
- **Browser indexing:** native recorded request DAGs, request dependencies, pending evidence, indexing receipts and failures. These are historical events, not an assertion that the pointer still exists or can currently replay. After `AikoRequestMemoryIndexed`, public GET/HEAD DAGs also appear in the tool router as `observed_network_run` skills and execute on host HTTP without opening Chromium.
- Use **Filter loaded nodes**, **Show list / Show diagram**, **Next window**, and **First window**. Keyboard users can navigate tabs and activate ordinary node buttons; the relationship list names edge direction. Narrow screens initially use the list.
- The existing five-second refresh rereads the selected window. Windows are not accumulated or silently treated as complete. Advance through a long history to reach later browser events. A failed graph refresh clears the previous graph, rather than presenting stale private data as current.

## API and privacy

`GET /api/control/memory-graph` uses the existing control authentication. Optional query fields are `account`, `after` (knowledge observation cursor), and `browserAfter` (nonnegative native event sequence). An account cannot select another owner. Node operators can inspect known accounts; Cloudflare retains the selected per-account Durable Object boundary. Responses are `no-store`; credentials stay only in tab memory.

The knowledge lane delegates to `entity-learn`'s `memoryGraph`: 32 current roots, up to 128 total nodes, 384 edges and 128 KiB; canonical evidence checks apply to every displayed endpoint. Source recipes, payloads and embeddings are not included. Unreferenced source registrations can still be inspected in **Entity memory → Source state**.

The browser lane reads at most 1,024 foreground log events and 4 MiB of native structural events. It uses `ownedNetworkDefinitions`, including native checkpoint/evidence validation, rather than interpreting model text. Missing prerequisites outside the window are disclosed. The diagram displays at most 64 matching nodes; the list covers all loaded nodes. Details never include response bodies, query values, headers, cookies or vectors. Neither pane establishes semantic truth.

Inspection does not allocate a VM, start a browser, perform embeddings, or replay a request. The lanes are independent snapshots. Browser pointer availability is explicitly `not-checked`, so dormant or deleted VM data is never labeled currently available from an old receipt. Existing owner views are distinct from model-context/private-example consent. Suppression does not erase historical logs or independently downloaded copies.

## Browser indexing connection

The actual browser driver still uses `BrowserLearning → RequestMemory.index → entity-learn` with the pinned local MiniLM provider. Raw response values remain transient; no personal knowledge is copied into browser memory or sent to OpenRouter.

Successful automatic indexing now records `AikoRequestMemoryIndexed` with the native occurrence ID, tool digest, pointer receipt and local model identity. Failures record `AikoRequestMemoryIndexUnavailable`; a write may have succeeded before receipt delivery failed, so failure is not an erasure claim. Both Node and Worker native hosts key these events, preserving idempotency when the VM event queue redelivers. Older histories without success receipts are not backfilled as successes. A deployed runner must contain the new code before new success events can appear; this change itself does not deploy it.

Pointer search now uses the library's bounded keyset scan instead of only 100 recalled pointers. It checks model/dimensions, suppression and available native definition evidence; hydration still separately rechecks session/execution authority. The scan caps at 10,000 pointers or 16 MiB; results cap at 24,000 bytes and expose partial-coverage reasons. The local provider/value-retention policy is unchanged. This is not a measured answer-quality improvement.

## Verification status

Offline library, pointer, native-log, graph API and Worker-storage tests cover the connection with synthetic data. The full-workspace check passed typechecking and both builds but retained two unrelated delivery/reply expectations failing in `runtime.test.ts` and `production.test.ts`; the working tree is not certified wholly green. Real Chromium/embedding tests remain skipped without explicit browser permission. No paid inference, personal-memory upload, deployment, live-service restart or commit was performed.

See [request memory](request-memory-and-workflows.md), [compiled knowledge](aiko-knowledge.md), and `packages/entity-learn/lib/graph.ts` for the boundaries and implementation.
