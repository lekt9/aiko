**Native harness parity — implementation and evidence**

Updated 8 September 2026. This replaces the open tracker for the 21 requirements derived from the supplied CodeGraff audit. “Implemented” means the behavior below exists in the current source and has direct local verification; it does not claim arbitrary provider compatibility or a live deployment.

Tardie owns execution, delegation, cancellation, subscriptions, scheduling and recovery through its existing actors, methods, packages and journals. The checked-in [Tardie patch](../patches/tardie@0.22.0.patch) extends those primitives. Private blobs retain inputs, results and context; they do not supply execution authority or introduce another scheduler. Browser request graphs, entity-learn memory, approvals and the existing capability registry remain the shared discovery and execution path.

| # | Requirement | Implemented behavior and source | Direct evidence and limits |
|---|---|---|---|
| 1 | Preserve every native tool call in a model response | Native `Action.calls` decoding retains ordered calls, validates the batch before dispatch, records each call and attributes inference usage once. [Native patch](../patches/tardie@0.22.0.patch). | [Decoder, concurrent siblings, failure, cancellation and cold replay tests](../apps/agent/test/native-tool-batches.test.ts). Malformed batches or reused call identities launch no partial batch. |
| 2 | Fast branches continue before slow siblings | The [segment runner](../apps/agent/src/code-sandbox-runner.ts) and [sandbox adapter](../apps/agent/src/code-sandbox.ts) propagate completion order and stable native ordinals. | [Fast continuation, held sibling, replay, `Promise.race`, cancellation and bundled evaluator tests](../apps/agent/test/code-sandbox-completion.test.ts). A segment cannot settle while it still owns running work. |
| 3 | A parked execution does not block unrelated ready executions | The native code reactor selects ready work independently of a parked sibling. [Native patch](../patches/tardie@0.22.0.patch). | [Parked execute beside ready execute](../apps/agent/test/native-tool-batches.test.ts#L146). [Legacy replay](../apps/agent/test/code-sandbox-upgrade.test.ts) preserves earlier `aiko-code/1` identities and behavior. |
| 4 | Eligible execution during model generation | [Speculation parsing](../apps/agent/src/code-speculation.ts), [private harness integration](../apps/agent/src/code-harness.ts) and native speculation events authorize and adopt an exact streamed read prefix. | [Real streamed tool arguments, early read, later write, adoption, cancellation and cold replay](../apps/agent/test/code-speculation.test.ts). Only explicitly marked safe reads and closed literal prefixes qualify: up to eight candidates/statements and 64 KiB source. Arbitrary writes or dynamic programs do not speculate. |
| 5 | General-purpose scoped workers | [Native worker package and child actor](../apps/agent/src/code-agents.ts) support `research`, `browser`, `compute` and `coding` with durable owner grants. Mounted tools recheck the grant and resources on each effect and retained-result read. | [Worker scope, actual indexed reads/writes, compute and resource-denial tests](../apps/agent/test/code-workers.test.ts); [native coding worker](../apps/agent/test/coding-workspace.test.ts). Only host-mounted capabilities are available; child text cannot install tools or inherit unrelated account actions. |
| 6 | Background workers and durable handles | `agents.run({background:true})` returns the native call handle. `agents.status`, `agents.result` and `agents.cancel` inspect, await or cancel owned work. Native invocation links retain ownership after the parent replies. [Worker package](../apps/agent/src/code-agents.ts). | [Background completion, parent-terminal cancellation, failed cleanup, revocation, result-source checks and recovery](../apps/agent/test/code-workers.test.ts). Outstanding worker count and budgets are bounded. Uncertain process cleanup is recorded as unknown, not success. |
| 7 | Per-worker provider, model and effort | [Routing](../apps/agent/src/model-routing.ts) exposes configured role/fallback routes and explicit effort policies; [worker grants](../apps/agent/src/code-agents.ts) pin the selected reference and effort. | [Production Cloudflare assembly checks actual model and effort fields](../apps/agent/test/code-workers-cloudflare.test.ts#L99); [route, override and budget tests](../apps/agent/test/model-routing.test.ts). Endpoints and credentials are host configuration. An explicit worker model does not silently fall back. |
| 8 | Bun and Cloudflare worker parity | Both [Bun service](../apps/agent/src/server.ts) and [Cloudflare account assembly](../apps/agent/src/cloudflare.ts) resolve native children, mount their scopes and retain owner-bound storage. [Cloudflare host](../apps/agent/src/cloudflare-host.ts) validates and atomically restores child lineage. | [Actual Bun service and cold restart](../apps/agent/test/code-workers.test.ts#L500), [production Cloudflare bundle](../apps/agent/test/code-workers-cloudflare.test.ts), and [forged/default-denied/import rollback cases](../apps/agent/test/code-workers.test.ts#L1183). Cloudflare platform storage and provider I/O use local test fixtures; this is not a deployed-Worker test. |
| 9 | Child page inspection, indexed actions and memory | Research workers receive public page/search tools, cited owner memory and `worker_browser_inspect({origin,publicOnly:true})` for the parent's existing public page. The [browser controller](../apps/agent/src/browser.ts#L138) shares the parent session gate and returns bounded snapshot, visible text, title, URL and same-origin links. Browser scope requires `publicOnly:false` plus an explicit origin grant. | [Actual Bun parent navigation → child inspection and cold restart](../apps/agent/test/code-workers.test.ts#L500), [controller grant/session/cancellation checks](../apps/agent/test/browser.test.ts#L51), [actual driver inspection](../apps/agent/test/browser-replay.test.ts#L115), [hosted transport](../apps/agent/test/codegraff.test.ts#L806). Inspection never provisions or navigates a browser; research rejects authenticated, pending sign-in or previously private sessions even after cookie revocation. Authenticated retained results require the same live parent session and current source authority; after restart they remain unavailable until that session is restored. |
| 10 | Persistent working bindings across executions | [Working data](../apps/agent/src/code-data.ts) stores private immutable values and journal-backed names through [native harness methods](../apps/agent/src/code-harness.ts). Names have replacement generations and optimistic conflict checks. | [Native execute, cold restart, simultaneous binding conflicts and source revocation](../apps/agent/test/code-data.test.ts). Working bindings belong to one owner and thread; JavaScript lexical variables themselves still end with an execution. |
| 11 | Large result handles and slice/filter/project | `tools.retain`, `tools.bind`, `tools.load` and `tools.query` provide bounded handles and JSON-pointer queries. Source-specific authorization remains attached to derived values. [Working data implementation](../apps/agent/src/code-data.ts). | [Multi-MiB result, cold query, fabricated handles, prototype paths and input-specific revocation](../apps/agent/test/code-data.test.ts). Values are capped at 32 MiB and query results at 64 KiB. Querying reconstructs a bounded value in host memory; this is not an out-of-core database. |
| 12 | Model-aware context policy | [Actor](../apps/agent/src/actor.ts) and [worker](../apps/agent/src/code-agents.ts) compaction receive route-aware context policies instead of an unconditional 32K window. [Routing](../apps/agent/src/model-routing.ts) accounts for configured context and output limits. | [Worker route/context tests](../apps/agent/test/model-worker-routing.test.ts) and [native provider checkpoint/recovery tests](../apps/agent/test/native-provider-compaction.test.ts). Unconfigured behavior retains the existing default; provider limits must be explicitly configured correctly. |
| 13 | Provider-specific prompt caching | [Model capabilities](../apps/agent/src/model-capabilities.ts) and [routing](../apps/agent/src/model-routing.ts) apply configured OpenAI-compatible cache fields, scope keys to the owner/thread/model/prompt prefix and preserve usage accounting. | [Cache and protocol wire tests](../apps/agent/test/model-capabilities.test.ts). Cache controls are deployment capabilities, not assumed model features; unsupported Cerebras protocol/cache combinations are rejected. A cache hint does not guarantee a provider cache hit. |
| 14 | Native provider server compaction | Native `Infer.compact` checkpoints retain private provider state through [provider custody](../apps/agent/src/model-compaction.ts), [code/source custody](../apps/agent/src/code-harness.ts) and exact historic-model [role routing](../apps/agent/src/inference-routing.ts). | [Full provider output, repeated compaction, cold rehydration, scope and revocation](../apps/agent/test/model-compaction.test.ts); [source, workflow and chained-result compaction custody](../apps/agent/test/code-data.test.ts); [native scheduled checkpoints, usage, model switches and failure recovery](../apps/agent/test/native-provider-compaction.test.ts). Requires an explicitly configured Responses route. Failed compaction retains the prior context/checkpoint. |
| 15 | General MCP management | [General MCP](../apps/agent/src/general-mcp.ts) exposes configured server lifecycle, tool discovery and schema-checked calls; [HTTP](../apps/agent/src/general-mcp-http.ts) and [local stdio](../apps/agent/src/general-mcp-stdio.ts) are trusted transport adapters. | [Actual SDK discovery/calls, native code-mode receipts, disconnect/reconnect, replacement and stdio environment tests](../apps/agent/test/general-mcp.test.ts). Workers need explicit server/tool grants pinned to the configured revision. Upstream annotations do not grant effect authority. |
| 16 | Project instructions, skills and plugins | [Project context](../apps/agent/src/project-instructions.ts) reads applicable root-to-cwd `AGENTS.md`/`CLAUDE.md` afresh, discovers scoped skills and loads selected bodies. Plugin/MCP manifests supply bounded metadata. [Filesystem source](../apps/agent/src/project-instructions-node.ts) confines access to an explicit root. | [Precedence, fresh reads, explicit skill loading, plugin metadata, traversal/symlink and budget tests](../apps/agent/test/project-instructions.test.ts); production-host project integration in both worker suites. Discovery does not install plugins, start servers, run hooks or grant filesystem/network access. |
| 17 | Worker worktrees and merge lifecycle | [Coding runner](../apps/agent/src/coding-workspace-runner.ts) creates owner/thread worktrees with durable operation receipts; [host transport](../apps/agent/src/coding-workspace-host.ts) runs the trusted bundle through existing compute. | [Real Git worktree/restart and fresh-test merge tests](../apps/agent/test/coding-workspace.test.ts), including dirty-target preservation. Mutation, tests, merge and close require the creating native thread; same-owner other threads may inspect. Merge is fast-forward only and refuses moved/dirty/conflicting targets. There is no automatic conflict resolution or remote PR publication. |
| 18 | Repository editing and code intelligence | `coding_workspace` offers bounded list/read/edit/index/query operations under explicit repository grants. Edits require expected content hashes; the runner maintains a lexical text/symbol index. [Tools](../apps/agent/src/coding-workspace.ts), [runner](../apps/agent/src/coding-workspace-runner.ts). | [Real edits/index/query, replay guards, confinement and hosted bundled CLI](../apps/agent/test/coding-workspace.test.ts). This is lexical symbol extraction, not a language server or codedb replacement. Repository roots are trusted VM configuration, never tool-supplied host paths. |
| 19 | Turn-level undo | The coding runner retains private before-images and restores a named turn with conflict checks. Unknown acknowledgements remain unknown and can still be explicitly undone. [Runner](../apps/agent/src/coding-workspace-runner.ts). | [Turn undo across restart](../apps/agent/test/coding-workspace.test.ts) and [lost edit acknowledgement](../apps/agent/test/coding-workspace.test.ts). Restoration is bounded and refuses conflicting later changes; it is not a global machine rollback. |
| 20 | Completion requires fresh tests | [Coding verification events and inference gate](../apps/agent/src/coding-workspace.ts) reject completion/final responses until all modified workspaces have fresh successful checks and every effectful coding operation has settled or been explicitly reconciled. A terminal reply cannot share a native batch with further tool work. Merge separately checks the exact unchanged revision. | [Native worker refusal/pass and cold replay](../apps/agent/test/coding-workspace.test.ts), [pending/stale/failed checks](../apps/agent/test/coding-workspace.test.ts), and [hostile check isolation](../apps/agent/test/coding-workspace.test.ts). Unknown outcomes stay pending; [fresh process confirmation](../apps/agent/test/sandbox-compute-terminal.test.ts) never trusts cancellation acknowledgement or repeats a command. Configured checks run in a mandatory filesystem/PID/network sandbox. Tests cannot use external services or unrelated workspaces. |
| 21 | Browser indexing is the common discovery/memory path | Real capture produces a Merkle-backed request definition and a persisted [request pointer](../apps/agent/src/request-memory.ts). [Native log following](../apps/agent/src/log-memory.ts) makes source observations citable; worker discovery returns pointer/digest/provenance for authorized execution. | [Complete native child chain](../apps/agent/test/code-workers.test.ts#L1307): capture → actual pointer index → reopen/search → native source ingestion → memory citation → worker discovery → observed request → terminal/recovery. Provider/embedding/HTTP transports are deterministic fixtures. Fresh response values do not enter the pointer archive or public native history. |

**Boundaries that apply across the matrix**

- Independent placement means distinct native lineage, thread history and workspace within the same owner's physical Bun process or account Durable Object. Inspection reports `physicalPlacement: "account-host"`; it does not imply another DO or another compute machine.
- Memory is owner-scoped and deliberately shared with that owner's workers. Browser origin/action grants restrict execution targets; they do not create a separate memory visibility policy. Exact worker lineage, full source/target addresses and owner bindings are checked separately.
- Browser workers discover and reuse recorded requests/actions. Research and browser workers can inspect the parent's existing page through the same serialized controller; research requires a public session, and browser scope requires an explicit origin grant. New navigation and UI actions remain with the primary controller. Learned writes use the parent's approval journal and match consent to the exact action digest, inputs and current connection revision. Credentials remain in trusted host/session adapters.
- Compute and coding are separate scopes. Coding workers cannot bypass repository/action/check grants by calling arbitrary `sandbox_exec`. They use the same trusted coding runner on Bun and Cloudflare through existing owner compute.
- Project and MCP mounts are trusted host factories. Text in a page, repository instruction, skill, plugin manifest or upstream MCP description cannot create a capability grant. Retained results recheck current source authority, including worker resources and MCP revisions.
- Speculation adopts only the exact validated final call and physical inference attempt. An abandoned or cancelled attempt may have performed an authorized read; a later unadopted attempt may perform that read again. Adopted calls replay under their recorded identities without another effect.

**Worker usage inside `execute`**

Inspect what this host actually mounts before choosing a scope or model:

```js
const catalog = await agents.models({});
return catalog; // configured model refs/efforts, scopes and MCP resources
```

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

Later executions use the returned handle:

```js
return await agents.result({ id: "<returned callId>" });
// Or: return await agents.cancel({ id: "<returned callId>" });
```

`agents.result` parks using the native response protocol while the worker runs. `agents.status` returns current terminal evidence without waiting. API cancellation of the owning turn also reaches its background workers after the parent has replied. Default delegation remains foreground research. There may be at most four pending workers; requests cannot enable unconfigured budget escalation.

For explicit selection, pass a `{provider, model_id}` listed by `agents.models`, and an `effort` listed for that exact model. Deployment configuration uses the existing conversation/RAG/browser role and fallback settings plus `AIKO_MODEL_EFFORTS`, for example:

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

Code mode requires its existing configured registry/sandbox transport (`AIKO_CODE_MODE=true`). These additional callbacks are application bindings, not model arguments or Wrangler string variables:

| Capability | Bun `createService(config, overrides)` | Cloudflare application binding |
|---|---|---|
| Additional scoped native tools | `overrides.workerTools(owner, thread)` | `AIKO_WORKER_TOOLS(owner, thread)` |
| MCP server grants and connector | `overrides.mcp(owner, thread)` returning `McpBinding` | `AIKO_MCP(owner, thread)` returning `McpBinding` |
| Project instructions/skills/plugins | `overrides.projectContext(owner, thread)` returning `ProjectContextOptions` | `AIKO_PROJECT_CONTEXT(owner, thread)` returning `ProjectContextOptions` |

A Bun project mount can return `source: projectFilesystemSource(trustedRoot)` from [project-instructions-node.ts](../apps/agent/src/project-instructions-node.ts), with explicit `owner`, `thread`, `redact` and optional project-relative `cwd`. A Cloudflare mount supplies the portable `read(path, signal)` / `list(path, signal)` source. Neither host searches arbitrary global skill/plugin directories. `project_context_manifest` discovers the bounded catalogue; `project_context_load` loads an explicitly selected discovered file.

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

Test totals and build results should be taken from the final verification run, not summed from overlapping focused suites. The original audit's baseline test count is not evidence that these new requirements were already present.

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
