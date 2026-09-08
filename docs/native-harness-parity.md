**Native harness parity — implementation and evidence**

Aiko can run independent work at the same time, continue tasks in the background, and reuse data across turns. Workers start with recorded browser knowledge and can use explicitly granted browser controls when a page needs interaction. Coding tasks automatically load project guidance, get recoverable workspaces, and must pass checks before being reported complete.

Updated 8 September 2026. This replaces the open tracker for the 21 requirements derived from the supplied CodeGraff audit. “Implemented” means the behavior below exists in the current source and has direct local verification; it does not claim arbitrary provider compatibility or a live deployment.

Tardie owns execution, delegation, cancellation, subscriptions, scheduling and recovery through its existing actors, methods, packages and journals. The checked-in [Tardie patch](../patches/tardie@0.22.0.patch) extends those primitives. Private blobs retain inputs, results and context; they do not supply execution authority or introduce another scheduler. Browser request graphs, entity-learn memory, approvals and the existing capability registry remain the shared discovery and execution path.

| # | Requirement | Implemented behavior and source | Direct evidence and limits |
|---|---|---|---|
| 1 | Preserve every native tool call in a model response | Native `Action.calls` decoding retains ordered calls, validates the batch before dispatch, records each call and attributes inference usage once. [Native patch](../patches/tardie@0.22.0.patch). | [Decoder, concurrent siblings, failure, cancellation and cold replay tests](../apps/agent/test/native-tool-batches.test.ts). Malformed batches or reused call identities launch no partial batch. |
| 2 | Fast branches continue before slow siblings | The [segment runner](../apps/agent/src/code-sandbox-runner.ts) and [sandbox adapter](../apps/agent/src/code-sandbox.ts) propagate completion order and stable native ordinals. | [Fast continuation, held sibling, replay, `Promise.race`, cancellation and bundled evaluator tests](../apps/agent/test/code-sandbox-completion.test.ts). A segment cannot settle while it still owns running work. |
| 3 | A parked execution does not block unrelated ready executions | The native code reactor selects ready work independently of a parked sibling. [Native patch](../patches/tardie@0.22.0.patch). | [Parked execute beside ready execute](../apps/agent/test/native-tool-batches.test.ts#L146). [Legacy replay](../apps/agent/test/code-sandbox-upgrade.test.ts) preserves earlier `aiko-code/1` identities and behavior. |
| 4 | Eligible execution during model generation | [Speculation parsing](../apps/agent/src/code-speculation.ts), [private harness integration](../apps/agent/src/code-harness.ts) and native speculation events authorize and adopt an exact streamed read prefix. | [Real streamed tool arguments, early read, later write, adoption, cancellation and cold replay](../apps/agent/test/code-speculation.test.ts). Only explicitly marked safe reads and closed literal prefixes qualify: up to eight candidates/statements and 64 KiB source. Arbitrary writes or dynamic programs do not speculate. |
| 5 | General-purpose scoped workers | [Native worker package and child actor](../apps/agent/src/code-agents.ts) support `research`, `browser`, `compute` and `coding` with durable owner grants. Browser workers can navigate and interact through the existing controller with explicit operation/origin grants. Mounted tools recheck grants on each effect and retained-result read. | [Worker scope, actual indexed reads/writes, compute and Bun browser control](../apps/agent/test/code-workers.test.ts); [scoped browser consent, proxy, driver, cancellation and replay](../apps/agent/test/worker-browser-control.test.ts); [native coding worker](../apps/agent/test/coding-workspace.test.ts). Child text cannot install tools or inherit unrelated account actions. |
| 6 | Background workers and durable handles | `agents.run({background:true})` returns the native call handle. `agents.status`, `agents.result` and `agents.cancel` inspect, await or cancel owned work. Native invocation links retain ownership after the parent replies. [Worker package](../apps/agent/src/code-agents.ts). | [Background completion, parent-terminal cancellation, failed cleanup, revocation, result-source checks and recovery](../apps/agent/test/code-workers.test.ts). Outstanding worker count and budgets are bounded. Uncertain process cleanup is recorded as unknown, not success. |
| 7 | Per-worker provider, model and effort | [Routing](../apps/agent/src/model-routing.ts) exposes configured role/fallback routes and explicit effort policies; [worker grants](../apps/agent/src/code-agents.ts) pin the selected reference and effort. | [Production Cloudflare assembly checks actual model and effort fields](../apps/agent/test/code-workers-cloudflare.test.ts#L99); [route, override and budget tests](../apps/agent/test/model-routing.test.ts). Endpoints and credentials are host configuration. An explicit worker model does not silently fall back. |
| 8 | Bun and Cloudflare worker parity | Both [Bun service](../apps/agent/src/server.ts) and [Cloudflare account assembly](../apps/agent/src/cloudflare.ts) resolve native children, mount their scopes and retain owner-bound storage. [Cloudflare host](../apps/agent/src/cloudflare-host.ts) validates and atomically restores child lineage. | [Actual Bun service and cold restart](../apps/agent/test/code-workers.test.ts#L500), [production Cloudflare bundle](../apps/agent/test/code-workers-cloudflare.test.ts), and [forged/default-denied/import rollback cases](../apps/agent/test/code-workers.test.ts#L1183). Cloudflare platform storage and provider I/O use local test fixtures; this is not a deployed-Worker test. |
| 9 | Child page inspection, indexed actions and memory | Research workers receive public page/search tools, cited owner memory and `worker_browser_inspect({origin,publicOnly:true})` for the parent's existing public page. The [browser controller](../apps/agent/src/browser.ts#L138) shares the parent session gate and returns bounded snapshot, visible text, title, URL and same-origin links. Browser scope requires `publicOnly:false` plus an explicit origin grant. | [Actual Bun parent navigation → child inspection and cold restart](../apps/agent/test/code-workers.test.ts#L500), [controller grant/session/cancellation checks](../apps/agent/test/browser.test.ts#L51), [actual driver inspection](../apps/agent/test/browser-replay.test.ts#L115), [hosted transport](../apps/agent/test/codegraff.test.ts#L806). Inspection never provisions or navigates a browser; research rejects authenticated, pending sign-in or previously private sessions even after cookie revocation. Authenticated retained results require the same live parent session and current source authority; after restart they remain unavailable until that session is restored. |
| 10 | Persistent working bindings across executions | [Working data](../apps/agent/src/code-data.ts) stores private immutable values and journal-backed names through [native harness methods](../apps/agent/src/code-harness.ts). Names have replacement generations and optimistic conflict checks. | [Native execute, cold restart, simultaneous binding conflicts and source revocation](../apps/agent/test/code-data.test.ts). Working bindings belong to one owner and thread; JavaScript lexical variables themselves still end with an execution. |
| 11 | Large result handles and slice/filter/project | `tools.retain`, `tools.bind`, `tools.load` and `tools.query` provide bounded handles and JSON-pointer queries. Source-specific authorization remains attached to derived values. [Working data implementation](../apps/agent/src/code-data.ts). | [Multi-MiB result, cold query, fabricated handles, prototype paths and input-specific revocation](../apps/agent/test/code-data.test.ts). Values are capped at 32 MiB and query results at 64 KiB. Querying reconstructs a bounded value in host memory; this is not an out-of-core database. |
| 12 | Model-aware context policy | [Actor](../apps/agent/src/actor.ts) and [worker](../apps/agent/src/code-agents.ts) compaction receive route-aware context policies instead of an unconditional 32K window. [Routing](../apps/agent/src/model-routing.ts) accounts for configured context and output limits. | [Worker route/context tests](../apps/agent/test/model-worker-routing.test.ts) and [native provider checkpoint/recovery tests](../apps/agent/test/native-provider-compaction.test.ts). Unconfigured behavior retains the existing default; provider limits must be explicitly configured correctly. |
| 13 | Provider-specific prompt caching | [Model capabilities](../apps/agent/src/model-capabilities.ts) and [routing](../apps/agent/src/model-routing.ts) apply configured OpenAI-compatible cache fields, scope keys to the owner/thread/model/prompt prefix and preserve usage accounting. | [Cache and protocol wire tests](../apps/agent/test/model-capabilities.test.ts). Cache controls are deployment capabilities, not assumed model features; unsupported Cerebras protocol/cache combinations are rejected. A cache hint does not guarantee a provider cache hit. |
| 14 | Native provider server compaction | Native `Infer.compact` checkpoints retain private provider state through [provider custody](../apps/agent/src/model-compaction.ts), [code/source custody](../apps/agent/src/code-harness.ts) and exact historic-model [role routing](../apps/agent/src/inference-routing.ts). | [Full provider output and cold rehydration](../apps/agent/test/model-compaction.test.ts); [workflow and chained-result custody](../apps/agent/test/code-data.test.ts); [automatic project guidance and current-source revocation](../apps/agent/test/code-context-custody.test.ts); [native scheduled checkpoints and failure recovery](../apps/agent/test/native-provider-compaction.test.ts). Requires an explicitly configured Responses route. Unverifiable legacy opaque windows are discarded; raw history remains available. |
| 15 | General MCP management | [General MCP](../apps/agent/src/general-mcp.ts) exposes configured server lifecycle, tool discovery and schema-checked calls; [HTTP](../apps/agent/src/general-mcp-http.ts) and [local stdio](../apps/agent/src/general-mcp-stdio.ts) are trusted transport adapters. | [Actual SDK discovery/calls, native code-mode receipts, disconnect/reconnect, replacement and stdio environment tests](../apps/agent/test/general-mcp.test.ts). Workers need explicit server/tool grants pinned to the configured revision. Upstream annotations do not grant effect authority. |
| 16 | Project instructions, skills and plugins | Configured coding repositories automatically mount [project context](../apps/agent/src/project-instructions.ts) in both hosts through the existing [coding runtime](../apps/agent/src/coding-workspace-host.ts). Each inference reads applicable root-to-cwd `AGENTS.md`/`CLAUDE.md`, discovers scoped skills, and records a native preparation receipt. Explicit tool calls load selected skill bodies. | [Actual stock Bun and Cloudflare hosts, uploaded CLI and cold recovery](../apps/agent/test/project-host.test.ts); [scope/precedence, plugin metadata, confinement and budgets](../apps/agent/test/project-instructions.test.ts); [source custody through compaction](../apps/agent/test/code-context-custody.test.ts). Discovery does not install plugins, start servers, run hooks or grant access. |
| 17 | Worker worktrees and merge lifecycle | [Coding runner](../apps/agent/src/coding-workspace-runner.ts) creates owner/thread worktrees with durable operation receipts; [host transport](../apps/agent/src/coding-workspace-host.ts) runs the trusted bundle through existing compute. | [Real Git worktree/restart and fresh-test merge tests](../apps/agent/test/coding-workspace.test.ts), including dirty-target preservation. Mutation, tests, merge and close require the creating native thread; same-owner other threads may inspect. Merge is fast-forward only and refuses moved/dirty/conflicting targets. There is no automatic conflict resolution or remote PR publication. |
| 18 | Repository editing and code intelligence | `coding_workspace` offers bounded list/read/edit/index/query operations under explicit repository grants. Edits require expected content hashes; the runner maintains a lexical text/symbol index. [Tools](../apps/agent/src/coding-workspace.ts), [runner](../apps/agent/src/coding-workspace-runner.ts). | [Real edits/index/query, replay guards, confinement and hosted bundled CLI](../apps/agent/test/coding-workspace.test.ts). This is lexical symbol extraction, not a language server or codedb replacement. Repository roots are trusted VM configuration, never tool-supplied host paths. |
| 19 | Turn-level undo | The coding runner retains private before-images and restores a named turn with conflict checks. Unknown acknowledgements remain unknown and can still be explicitly undone. [Runner](../apps/agent/src/coding-workspace-runner.ts). | [Turn undo across restart](../apps/agent/test/coding-workspace.test.ts) and [lost edit acknowledgement](../apps/agent/test/coding-workspace.test.ts). Restoration is bounded and refuses conflicting later changes; it is not a global machine rollback. |
| 20 | Completion requires fresh tests | [Coding verification events and inference gate](../apps/agent/src/coding-workspace.ts) reject completion/final responses until all modified workspaces have fresh successful checks and every effectful coding operation has settled or been explicitly reconciled. A terminal reply cannot share a native batch with further tool work. Merge separately checks the exact unchanged revision. | [Native worker refusal/pass and cold replay](../apps/agent/test/coding-workspace.test.ts), [pending/stale/failed checks](../apps/agent/test/coding-workspace.test.ts), and [hostile check isolation](../apps/agent/test/coding-workspace.test.ts). Unknown outcomes stay pending; [fresh process confirmation](../apps/agent/test/sandbox-compute-terminal.test.ts) never trusts cancellation acknowledgement or repeats a command. Configured checks run in a mandatory filesystem/PID/network sandbox. Tests cannot use external services or unrelated workspaces. |
| 21 | Browser indexing is the common discovery/memory path | Real capture produces a Merkle-backed request definition and a persisted [request pointer](../apps/agent/src/request-memory.ts). [Native log following](../apps/agent/src/log-memory.ts) makes source observations citable; worker discovery returns pointer/digest/provenance for authorized execution. | [Complete native child chain](../apps/agent/test/code-workers.test.ts#L1307): capture → actual pointer index → reopen/search → native source ingestion → memory citation → worker discovery → observed request → terminal/recovery. Provider/embedding/HTTP transports are deterministic fixtures. Fresh response values do not enter the pointer archive or public native history. |

**Boundaries that apply across the matrix**

- Independent placement means distinct native lineage, thread history and workspace within the same owner's physical Bun process or account Durable Object. Inspection reports `physicalPlacement: "account-host"`; it does not imply another DO or another compute machine.
- Memory is owner-scoped and deliberately shared with that owner's workers. Browser origin/action grants restrict execution targets; they do not create a separate memory visibility policy. Exact worker lineage, full source/target addresses and owner bindings are checked separately.
- Browser workers discover and reuse recorded requests/actions. Research and browser workers can inspect the parent's existing page through the same serialized controller. Browser control additionally requires explicit `browserOperations` and origin grants; older grants with no operations permit no UI control. Navigation and interactions use the same controller, proxy, capture/index pipeline and native receipts. Interactions require the owner's exact preview approval. Tabs are excluded, current page ownership is checked, and proxy egress stays within granted origins. Learned writes use the parent's approval journal and match the action digest, inputs and current connection revision. Credentials remain in trusted host/session adapters.
- Compute and coding are separate scopes. Coding workers cannot bypass repository/action/check grants by calling arbitrary `sandbox_exec`. They use the same trusted coding runner on Bun and Cloudflare through existing owner compute.
- Project and MCP mounts come from trusted owner configuration, with optional custom host factories. Text in a page, repository instruction, skill, plugin manifest or upstream MCP description cannot create a capability grant. Retained results and opaque context recheck current source authority, including worker resources and MCP revisions.
- Speculation adopts only the exact validated final call and physical inference attempt. An abandoned or cancelled attempt may have performed an authorized read; a later unadopted attempt may perform that read again. Adopted calls replay under their recorded identities without another effect.

## Browser specialist delegated from chat

Decision, 8 September 2026: use the existing native child machinery for a dedicated browser-specialist profile, rather than nesting Browser Use, Kuri or another agent loop inside Tardigrade. The [specialist definition](../apps/agent/src/browser-actor.ts) keeps agent-browser and the owner-bound controller/session infrastructure underneath. Chat owns the request, conversation and synthesis; the child owns multi-step website work and returns concise evidence.

New `agents.run({scope:"browser", ...})` calls pin `profile: "browser-v1"` in the durable `AikoWorkerGranted` event. Both Bun and Cloudflare select its instructions from the currently authorized grant in `workerInference`, including an explicitly selected model route. This is a specialized native child actor, not a new actor address, service, scheduler or VM. Keep the `aiko` identity and native child addresses stable: existing lineage, tool authorization, cancellation, private context and recovery depend on them. Preserve each released profile's behavior; use a new profile version for a future incompatible specialist change. Unknown profiles fail closed. Legacy grants without a profile retain the generic worker and original output contract.

When code mode mounts browser scope, chat is instructed to delegate multi-step website tasks and interactions by default. It discovers exact origins first, sends a self-contained brief and bounded budget, and grants only the needed operations or recorded actions. A quick read, search, screenshot delivery or secure sign-in can keep its existing path. This is model-facing routing guidance, not a keyword router or a guarantee that every real model will choose delegation. Reconsider that balance if measured task success, delegation rate or latency shows it is unhelpful; do not remove direct tools merely to force routing.

The specialist uses a native retrieve → inspect → execute → verify loop, falls back to explicitly granted UI operations, and returns the native `browser_result_v1` contract unless the caller supplies an explicit output override:

```ts
type BrowserTaskResult = {
  status: "completed" | "blocked" | "uncertain",
  summary: string,
  sources: { url: string, finding: string }[],
  receipts: { reference: string, status: "completed" | "blocked" | "unknown" }[],
  nextStep: string
}
```

Foreground `agents.run` and background `agents.result` expose this as `result.output`. The native output validator rejects malformed results. A native completed terminal means the child returned; it does **not** mean the website task succeeded. Read `output.status`, preserve partial findings and explain `nextStep` for blocked or uncertain work. Sources and receipt references in this object remain model claims, not newly authorized or independently verified receipts. Original native receipts and current source authority stay authoritative. Never respawn an uncertain action or retry it through a different route.

[Profile/contract checks](../apps/agent/test/browser-actor.test.ts) cover dispatch, replay compatibility, custom outputs, unavailable profiles and grant-bound inference. The [actual Bun host checks](../apps/agent/test/code-workers.test.ts) cover chat → specialist → result, rejected output, denied consent, owner cancellation and lost acknowledgements without repeated effects. The [production Cloudflare assembly fixture](../apps/agent/test/code-workers-cloudflare.test.ts) checks specialist prompts, model/effort, the native contract and cold recovery. These use synthetic models and browser/provider transports: they verify wiring and boundaries, not autonomous model quality or a live deployed browser journey.

The initial browser-specialist verification, before the index expansion below, passed **132 tests across 13 files, 1,085 assertions, no failures**: the four suites above plus `code-harness`, `code-data`, `code-context-custody`, `model-worker-routing`, `native-tool-batches`, `code-sandbox-upgrade`, `browser`, `browser-tabs` and `channel-response`. Agent and Worker typechecks, the normal agent build (including entity-learn integrity), and Wrangler's deployment dry run also passed. This is not a full monorepo pass, a live-model comparison or a deployment; do not add these overlapping counts to the earlier matrix baseline below.

### Native endpoint retrieval and graph inspection

The [worker index tools](../apps/agent/src/worker-index.ts) reuse the existing owner-log Merkle validators, endpoint descriptions and router ranker. They do not start a browser, replay a request, read cached response bodies, or introduce another agent loop or graph database.

- `worker_index_search({query, offset?, limit?})` ranks endpoint concepts, observed output fields, route descriptions and input contracts **after** filtering every prerequisite origin and optional action digest against the worker grant. This is lexical retrieval over observed semantic metadata, not the browser VM's vector search. Refine a query or use the granted origin when response semantics are unavailable. An empty query lists accessible definitions.
- Results retain `toolDigest`/`artifactDigest`, caller `inputs`, provenance and historical `pointerId` where available, and add `endpoint`, `executeWith`, pagination and coverage. A pointer receipt does not prove current private pointer availability. Search defaults to eight results, permits up to 32 per page and bounds returned context to 24 KB; `omitted` reports individually oversized entries.
- `worker_index_describe({toolDigest?, artifactDigest?, offset?, limit?})` accepts exactly one digest. It returns the endpoint and paged topological graph: prerequisite IDs, origins, route templates and symbolic caller/response producers. Constants and module implementations are omitted. Follow `graph.nextOffset`; graph pages default to four steps and allow at most eight, within 24 KB. Current grant and source checks also fence retained graph reads.
- Call `observed_network_run` with that exact digest and fresh caller inputs. Its existing executor resolves response bindings from current upstream results; a missing producer stops the dependent request. Provider routing, current session availability, owner approval and uncertain-effect recovery remain execution checks, not discovery claims. In particular, a native signed-in browser is **not** an implicit host-HTTP cookie grant; see [request fidelity and session boundaries](request-memory-and-workflows.md#request-fidelity-instagram-readiness-and-login-reuse).

Inside the browser child's `execute`, discovery and inspection look like this:

```js
const found = await tools.call({
  name: "worker_index_search", arguments: { query: "restaurant rating", limit: 4 }
});
const candidate = found.definitions?.[0]; // Inspect relevance, effect and required inputs first.
if (!candidate) return found; // Refine the query or report the missing route.
const selector = candidate.toolDigest
  ? { toolDigest: candidate.toolDigest } : { artifactDigest: candidate.artifactDigest };
return await tools.call({ name: "worker_index_describe", arguments: selector });
// Inspect all graph pages, then call observed_network_run with selector + fresh inputs.
// Never reconstruct raw HTTP or repeat an uncertain effect through UI.
```

[Retrieval checks](../apps/agent/test/worker-index.test.ts) cover output-concept search, paged dependency bindings, fresh producer execution, missing producers, invalid metadata, grants, cancellation and constant omission. The native child [capture/index/citation/replay test](../apps/agent/test/code-workers.test.ts) also exercises graph discovery and recovery; the [Cloudflare assembly fixture](../apps/agent/test/code-workers-cloudflare.test.ts) checks the mounted graph contract and empty-index fallback. These are synthetic execution checks, not a live-model evaluation or a promise that every recorded endpoint can be replayed.

The index-expansion regression run on 8 September 2026 passed **110 of 111 tests across 12 files**. The remaining `worker-browser-control` driver fixture also fails in isolation: its unmocked `ownedTabs` call fails with agent-browser `process_failed`. No driver/runtime changes were made for this index work. Agent and Worker typechecks, the agent build, and Wrangler's deployment dry run passed; no deployment or live-site replay was performed.

**Worker usage inside `execute`**

These JavaScript examples run inside the primary agent's `execute` tool. Inspect what this host actually mounts before choosing a scope or model:

```js
const catalog = await agents.models({});
return catalog; // items, scopes, browserOperations and mcp
```

`items` contains the configured model routes, with `provider`, `model_id` and supported `efforts`. The other fields describe the mounted worker scopes, permitted browser operation names, and owner-configured MCP resources. This is a complete local catalogue; it has no search, pricing or pagination. If `items` is empty, omit `model` to use the host's default. If a scope or browser operation is missing, configure that capability before delegating it.

Start a browser worker that can use only a named HTTPS origin. Optional `actions` further narrows the grant to recorded `sha256:` tool/action digests returned by discovery.

```js
const worker = await agents.run({
  text: "Find the recorded catalog request, cite its memory evidence, and inspect the current catalog.",
  scope: "browser",
  origins: ["https://api.example.com"],
  background: true,
  placement: "independent"
});
return { handle: worker.callId, status: await agents.status({ id: worker.callId }) };
```

For a worker that also needs page controls, pass an explicit list from `catalog.browserOperations`, for example `browserOperations: ["navigate", "click", "fill"]`. This cannot be combined with a narrowed `actions` digest list: granting general UI control would bypass that action restriction. The worker invokes `worker_browser_navigate`, `worker_browser_click`, or the corresponding discovered name through `tools.call({name, arguments})`, including the granted `origin` in its arguments. Interactions pause for the owner's preview approval. Open **Browser · observations & approvals** to review the pending action; the authenticated API exposes the same decision through `GET /api/browser` and `POST /api/browser/approval`. Browser results require the current authorized session; retained private page data remains unavailable after restart until that session is restored.

Later executions use the returned handle:

```js
const result = await agents.result({ id: "<returned callId>" });
return result; // For a new browser task, inspect result.output.status and nextStep.
// Or: return await agents.cancel({ id: "<returned callId>" });
```

`agents.result` parks using the native response protocol while the worker runs. `agents.status` returns current terminal evidence without waiting. API cancellation of the owning turn also reaches its background workers after the parent has replied. Default delegation remains foreground research. There may be at most four pending workers; requests cannot enable unconfigured budget escalation.

For explicit selection, copy just `provider` and `model_id` from the chosen catalogue item; its other fields are discovery metadata. Pass an `effort` only when it is listed for that exact model:

```js
const catalog = await agents.models({});
const selected = catalog.items[0]; // choose the configured route for this task
if (!selected) return { error: "No worker model override is configured; omit model to use the default." };
const { provider, model_id } = selected;
return await agents.run({
  text: "Research the requested topic and cite the sources.",
  model: { provider, model_id },
  scope: "research"
});
```

Deployment configuration uses the existing conversation/RAG/browser role and fallback settings plus `AIKO_MODEL_EFFORTS`, for example:

```json
{
  "codegraff/<configured-worker-model>": ["high"]
}
```

The placeholder must be replaced by an operator-configured, supported model route. The effort map records a deployment capability; it does not establish that a provider supports that effort.

An MCP resource grant is explicit on delegation:

```js
const worker = await agents.run({
  text: "Read the granted project inventory and cite the results.",
  scope: "research",
  background: true,
  mcp: [{ server: "inventory", tools: ["list_projects"] }]
});
return worker;
```

The host must already mount that server/tool for the owner and child. The durable worker grant pins its current revision. Research/browser scopes accept only configured read MCP effects.

**Trusted host mounts**

Start with the [hosted setup guide](aiko-hosted.md) or [local agent setup](../apps/agent/README.md). Code mode requires its existing configured registry/sandbox transport (`AIKO_CODE_MODE=true`). Local page controls also require the [browser setup](aiko-browser.md#run), including `AIKO_BROWSER_ENABLED=true` and an explicit Chromium executable; the hosted account uses its existing owner browser runtime. `catalog.browserOperations` confirms that controls are mounted. Configured coding repositories with `read` and `list` grants automatically supply project guidance; no custom factory is needed. These optional callbacks override the default application bindings:

| Capability | Bun `createService(config, overrides)` | Cloudflare application binding |
|---|---|---|
| Additional scoped native tools | `overrides.workerTools(owner, thread)` | `AIKO_WORKER_TOOLS(owner, thread)` |
| MCP server grants and connector | `overrides.mcp(owner, thread)` returning `McpBinding` | `AIKO_MCP(owner, thread)` returning `McpBinding` |
| Project instructions/skills/plugins | `overrides.projectContext(owner, thread)` returning `ProjectContextOptions` | `AIKO_PROJECT_CONTEXT(owner, thread)` returning `ProjectContextOptions` |

The stock mount reads project files inside the configured coding runtime through a finite read operation with the existing native invocation identity. A sole readable repository is selected automatically. With several repositories, discover and select one through the native tools:

```js
return await tools.call({ name: "project_context_manifest", arguments: {} });
// Then, using a repository ID returned in repositories:
// return await tools.call({
//   name: "project_context_manifest",
//   arguments: { repository: "app", cwd: "src" }
// });
```

`cwd` is relative to the repository root; use `""` for the root. Add `workspace` only for an existing registered coding worktree. A selection with `repository` starts a new context, so omitting `workspace` returns to that repository's root. Successful coding activity follows the active worktree; explicit cwd selection survives later edits. Each inference rereads root-to-cwd guidance. The skill catalogue is automatic; to load a relevant body, call `tools.call({name:"project_context_load", arguments:{path:"<path from manifest.skills>"}})`. Plugin/MCP files expose sanitized metadata and do not start integrations.

Custom Bun mounts can return `source: projectFilesystemSource(trustedRoot)` from [project-instructions-node.ts](../apps/agent/src/project-instructions-node.ts), with explicit `owner`, `thread`, `redact` and optional project-relative `cwd`. A custom Cloudflare mount supplies the portable `read(path, signal)` / `list(path, signal)` source. Provide stable `sourceRevision` and a current `authorizeRetained` callback for authorized context reuse after restart. Otherwise a per-instance revision deliberately invalidates old source custody. Neither host searches arbitrary global skill/plugin directories. Returning no binding from a configured override suppresses the default mount.

Automatic guidance records only owner/thread, native inference identity, tool definition digest and resolved project selector in `AikoProjectContextPrepared`; file bodies remain private. The native harness checks that source before and after inference, carries its permissions through chained provider compaction, and rejects revoked or unverifiable opaque windows. Historical worktree guidance remains readable under the same current repository/worker grant after a worktree closes; closure itself is not a separate history-access revocation.

Repository grants are operator configuration in `AIKO_CODING_REPOSITORIES` (or parsed `config.codingRepositories`), keyed by owner. Paths refer to pre-provisioned repositories inside owner compute:

```json
{
  "123": [{
    "id": "app",
    "root": "/work/projects/app",
    "actions": ["create", "status", "list", "read", "edit", "index", "query", "undo", "test", "merge", "close", "reconcile"],
    "checks": { "unit": ["/usr/bin/python3", "-m", "unittest", "discover"] }
  }]
}
```

Check commands must use an explicit absolute executable available in the isolated runtime. All configured checks must pass. The runner requires Linux namespaces and `bwrap`; it mounts the workspace and approved system runtimes, isolates processes and networking, hides Git administration and runner/credential state, and kills descendants on cancellation. Unsupported isolation fails closed without a host-execution fallback. Dependencies needed by checks must be available inside that permitted filesystem.

```js
return await agents.run({
  text: "In repository app, create workspace fix-one, inspect and fix the failing test, then run coding_workspace test. Report the changed files and verification receipt. Do not merge unless requested.",
  scope: "coding",
  background: true,
  placement: "independent"
});
```

The coding surface accepts repository/workspace identifiers, not arbitrary root paths or command strings. Current bounds include 64 MiB/10,000-file snapshots, 128 KiB per edited file and 16 MiB/200 edits of total retained undo history. Merge requires a fresh passing test operation for the unchanged tree and a clean unmoved target; it is fast-forward only. `close` cleans up the owned worktree through the same receipt protocol. Writable manifests are bound to their creating native thread; a parent or another same-owner thread receives read/status/list/query access only. Older manifests without thread ownership remain read-only. Changing trusted roots, actions or checks invalidates prior completion evidence.

If an effectful coding operation loses its acknowledgement or returns unknown, `status.pendingOperations` exposes its original ID and completion stays blocked. With an explicit `reconcile` grant, call `coding_workspace` with `{action:"reconcile",repository,workspace,operation:<original ID>}` from the creating thread. Reconciliation inspects the owned runner journal under the workspace lock without repeating the effect. An existing final runner receipt or a fresh provider completion observation with an exit code can establish that the original operation is idle. Cancellation acknowledgement alone is insufficient: reconciliation rechecks the original process through its existing compute handle, and a still-running or unavailable process remains unknown.

Reconciliation records an unknown original outcome and reports the current workspace state, including an interrupted creation with no manifest or an already closed worktree. Edits, undo and uncertain checks require fresh passing tests afterwards. Lifecycle reconciliation can preserve an earlier verification only when it confirms the same tree and revision, a closed workspace, or an absent workspace whose creation never completed; it never creates a passing test result. A modified workspace must resolve pending operations and obtain fresh verification before `close`, since closing removes the files needed for testing.

**Verification scope**

The linked tests exercise real native actors, journals, private storage, request compilation, entity-learn memory, the MCP SDK and actual temporary Git/filesystem/process operations. Production Bun and bundled Cloudflare assemblies are included, with deterministic transports where external services would otherwise be required. Hosted coding runs the actual bundled CLI against a local gateway fixture. These checks do not establish live endpoint support, production account grants, deployed Cloudflare behavior or paid-model quality.

The earlier integration baseline passed **413 tests across 38 files**, with **5 live-browser skips**, **0 failures** and **4,328 assertions**. It includes coding recovery, both compute suites, stock project mounts, scoped worker browser control, and automatic context custody with independent review regressions. TypeScript validation and the Cloudflare build (including rebuilt browser, compute and coding assets, and Wrangler's deployment dry run) passed. The normal Bun build, including its required source-integrity check, also passed. No deployment occurred.

Memory validation separately passed **59 Aiko tests across 5 files** (1,370 assertions) and **16 library tests** (246 assertions). `bun scripts/check-entity-learn.ts --upstream /home/deck/work/entity-learn` verified all 23 library files against pinned commit `2e18c86c0fde16a470fc155f64f36120184223cb`. The [memory source pin](../packages/entity-learn/README.md) is a local, unpublished upstream commit; it is not claimed to be remotely retrievable.

A previous run during concurrent source edits failed once in the database read-adapter test. Its cause was not confirmed; the isolated test, its ordered 23-file prefix and the final 38-file run passed on the resulting source. Totals above come from one final run and do not add overlapping focused suites.

On 8 September 2026, a separate real-Chromium run enabled every current live gate in `browser-replay.test.ts` and `browser-session-transport.test.ts`: **24 tests, 134 assertions, 0 failures and 0 skips**. The six gated checks include physical SDK cookie installation/revocation, blank-context installation, native encrypted-custody restoration, real page links, HttpOnly request replay and local learned indexing. The [request-memory witness](../artifacts/request-memory/live-pipeline-witness.json) records two observed requests, two indexed pointers, two semantic matches, a completed two-request replay and transient consumption without response values in the retained archive. This is local isolated-browser evidence, distinct from the earlier integration baseline and from a hosted deployment.

**Reproduce the local real-browser checks**

Use [the existing local HTTPS fixture](../scripts/native-browser-fixture.ts). It supplies the exact replay page, synthetic HttpOnly cookie and read/redirect/error routes. `UNLOCK_FIXTURE_PORT` accepts 0–65535; its default `0` allocates an available port. The older `test/browser-replay-fixture.ts` lacks the current navigation-links page. The following uses a dedicated profile and fixed test ports; choose unused ports and keep the host mapping consistent. These certificate and proxy exceptions apply only to this isolated fixture browser.

```bash
set -euo pipefail
export AIKO_QA_CHROME=/absolute/path/to/chrome
AIKO_QA_DIR=$(mktemp -d /tmp/aiko-parity-browser-XXXXXX)
export AIKO_QA_DIR
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj /CN=replay-fixture.aiko.ai \
  -keyout "$AIKO_QA_DIR/fixture.key" -out "$AIKO_QA_DIR/fixture.crt"
UNLOCK_FIXTURE_TLS_KEY="$AIKO_QA_DIR/fixture.key" \
UNLOCK_FIXTURE_TLS_CERT="$AIKO_QA_DIR/fixture.crt" \
UNLOCK_FIXTURE_PORT=8190 bun scripts/native-browser-fixture.ts &
AIKO_QA_FIXTURE_PID=$!
"$AIKO_QA_CHROME" --headless=new --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9358 --user-data-dir="$AIKO_QA_DIR/profile" \
  --no-first-run --no-default-browser-check --no-proxy-server \
  --ignore-certificate-errors \
  '--host-resolver-rules=MAP replay-fixture.aiko.ai 127.0.0.1:8190' about:blank \
  >"$AIKO_QA_DIR/chrome.log" 2>&1 &
AIKO_QA_CHROME_PID=$!
trap 'kill "$AIKO_QA_CHROME_PID" "$AIKO_QA_FIXTURE_PID" 2>/dev/null; wait "$AIKO_QA_CHROME_PID" "$AIKO_QA_FIXTURE_PID" 2>/dev/null' EXIT
# Wait for this isolated browser to accept CDP connections.
AIKO_REPLAY_TEST_CDP=$(curl --fail --silent --show-error --noproxy '*' \
  --retry 20 --retry-connrefused --retry-delay 1 --max-time 2 \
  http://127.0.0.1:9358/json/version | python3 -c 'import json,sys; print(json.load(sys.stdin)["webSocketDebuggerUrl"])')
export AIKO_REPLAY_TEST_CDP
BU_NAME=aiko-parity-qa BU_CDP_URL=http://127.0.0.1:9358 \
BH_NO_BROWSER_COOKIES=1 browser-harness <<'PY_BROWSER'
new_tab("https://replay-fixture.aiko.ai/")
wait_for_load()
print(page_info())
PY_BROWSER
AIKO_SESSION_TEST_CDP="$AIKO_REPLAY_TEST_CDP" AIKO_REPLAY_TEST_EMBEDDING=1 \
AIKO_NATIVE_SESSION_CHROME="$AIKO_QA_CHROME" \
  bun test apps/agent/test/browser-replay.test.ts apps/agent/test/browser-session-transport.test.ts
```

Keep exactly one tab at the replay origin and run the checks sequentially; duplicate tabs make page ownership ambiguous, and concurrent navigation changes the observed request window. Never attach this recipe to a personal or another worker's browser. Stop only the two recorded process IDs, then remove the dedicated test directory when its logs are no longer needed.

The embedding check uses the pinned local CPU MiniLM model and `/tmp/aiko-request-embedding-qa`; an empty cache may download public model files and exceed the 60-second test deadline. Prewarm that cache through `createRequestEmbedding(...).embed(["fixture"])` if needed, then rerun the actual check. The native encrypted-custody check creates its own temporary profile and navigates to public `https://example.com` with a synthetic fixture cookie; it needs public connectivity. The blank SDK-install check and isolated CDP cookie test need no remote application. None of these checks calls a paid model, provisions a VM or deploys code. `browser-unlock-auth.test.ts` and `observed-network.test.ts` have no live-browser environment gates.

**Working data usage**

Values can survive later executions without putting their complete contents into model history. Discover a real tool and its schema first, then retain and name its result:

```js
const handle = await tools.call({
  name: "<discovered-read-tool>",
  arguments: { /* exact discovered schema */ },
  retain: true
});
return await tools.bind({ name: "catalog", handle, expectedGeneration: 0 });
```

In a later execution, including after host reconstruction:

```js
const binding = await tools.load({ name: "catalog" });
return await tools.query({
  handle: binding.handle,
  path: "/rows",
  filter: { path: "/active", op: "eq", value: true },
  fields: ["/id", "/name"],
  offset: 0,
  limit: 20
});
```

`tools.retain({value})` persists computed JSON; derived values inherit the source permissions of reads in that execution. `tools.drop({name, expectedGeneration})` records a tombstone. Replacing or dropping a binding requires the generation returned by `load`; concurrent stale updates fail. Explicit immutable handles continue to exist under their source grants after a name is dropped. Query pointers use RFC 6901, projections return pointer-keyed fields, and pagination returns `total` and `nextOffset`. Maximum output is 256 rows or 64 KiB per query; maximum stored JSON is 32 MiB, sealed in 32 KiB chunks. An oversized result needs more selective fields or pagination.

Source grants remain authoritative for both handles and private compaction checkpoints. MCP endpoint revisions, delegated browser resources, repository grants and original invocation identities are rechecked. Revoked opaque checkpoints are removed from the inference projection, restoring the original history with unavailable private results represented explicitly. The native journal keeps the original checkpoint receipt for audit/replay. Retained data adds source artifact edges to entity-learn memory and the browser graph; its values and binding names are not copied there.

**Provider capabilities and compaction**

`AIKO_MODEL_CAPABILITIES` is JSON keyed by an already configured `provider/model` route. Set fields only when supported by that endpoint. This illustrative Responses entry is intentionally a placeholder:

```json
{
  "codegraff/<configured-responses-model>": {
    "protocol": "openai-responses",
    "contextWindowTokens": 131072,
    "maxOutputTokens": 8192,
    "parallelToolCalls": true,
    "promptCache": { "kind": "openai", "retention": "24h" },
    "serverCompaction": true
  }
}
```

Output tokens remain capped by the host's configured allowance as well as the per-model capability. Context windows drive both foreground and worker compaction. Explicit provider, model and effort selection never becomes authority to choose an arbitrary endpoint. Missing credentials or unsupported explicit capabilities fail before dispatch. Cache keys include owner, actor instance, thread, model and system/tool prefix; provider-reported cached-token usage is preserved. Cache retention is a request hint.

Server compaction calls the pinned `/responses/compact` endpoint through the existing inference budget. It seals the full returned output window, including retained messages and encrypted compaction items, then supplies the complete window on continuation. This follows the [OpenAI standalone compaction contract](https://developers.openai.com/api/docs/guides/compaction). No output pruning or cross-model checkpoint reuse occurs. Cold restart, repeated compaction, role/fallback selection, source revocation and failure recovery are covered by the native and adapter tests. A configured capability is not live-provider verification.

Cerebras defaults follow the [public model capability API](https://api.cerebras.ai/public/v1/models) snapshot checked on 8 September 2026: `qwen-3.8-27b` and `gemma-4-31b` enable parallel tool calls; `gpt-oss-120b` retains the API's disabled value. Known context ceilings are 65,536 for Qwen and 131,072 for Gemma/GPT-OSS, still bounded by host configuration unless explicitly overridden. Operators can update `parallelToolCalls` and context metadata as provider support changes. Cerebras prompt caching is automatic; the adapter rejects unsupported manual cache controls and Responses compaction.

**MCP configuration and calls**

The stock Bun and Cloudflare hosts accept `AIKO_MCP_SERVERS` as an owner-keyed JSON map:

```json
{
  "123": [{
    "id": "inventory",
    "revision": "v1",
    "description": "Project inventory",
    "url": "https://inventory.example.com/mcp",
    "headerRefs": { "Authorization": "INVENTORY_MCP_AUTHORIZATION" },
    "tools": { "list_projects": "read" }
  }]
}
```

Set `INVENTORY_MCP_AUTHORIZATION` separately as a private environment secret containing the complete header value. Configuration stores its name; credentials are attached only by the pinned transport and redacted from returned data. Unknown owners receive no binding. Missing credential references disable that server. Only explicitly named environment values are retained by the Bun configuration. Change `revision` when changing the endpoint or tool authority. Custom host callbacks take precedence, including when they deliberately return no binding. [Configuration and native SDK tests](../apps/agent/test/general-mcp-config.test.ts) cover validation, owner boundaries, secret rotation and output privacy.

Build a trusted binding with `mcpHttpConnector(() => servers)` or the Bun-only `mcpStdioConnector(() => servers)`. Each server includes an `id`, a revision changed whenever endpoint/authority changes, a description, and an exact `tools: {toolName: "read" | "write"}` grant. HTTP configuration supplies a pinned HTTPS URL and private headers; stdio configuration supplies an absolute executable, cwd, arguments and explicit environment. The transport never takes these values from model tool arguments or plugin text. Supply the binding through the host factories above with the exact owner/thread and a current-authority callback.

```js
const catalogue = await tools.call({
  name: "mcp_server_tools", arguments: { server: "inventory" }
});
const selected = catalogue.tools.find(tool => tool.name === "list_projects");
return await tools.call({
  name: "mcp_server_call",
  arguments: {
    server: "inventory", tool: selected.name,
    schemaDigest: selected.schemaDigest, arguments: {}
  }
});
```

`mcp_server_list`, `mcp_server_connect` and `mcp_server_disconnect` manage native thread connection state. Disconnect blocks future upstream dispatch until reconnect; the host's separate grant controls retained-data visibility. Replacement revisions invalidate old mounted tool definitions and retained source permissions. Missing or changed schemas fail before dispatch. If a call loses acknowledgement or authority after dispatch, its result reports `status: "unknown"` with the native operation ID; inspect remote state before submitting a new write. The same native invocation never becomes an automatic repeated write.
