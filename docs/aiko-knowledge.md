# Native compiled knowledge and optional semantic memory

Aiko now composes the library's **raw evidence → compiled pages → cited answers → inert HTML** primitives with its existing Tardie 0.22 tools and `WikiMemory` host adapter. No new agent loop, wiki database, daemon or source scheduler was added.

The existing admin panel now includes **`/control` → Node graph**, with separate canonical-knowledge and browser-indexing lanes. See [graph inspection and limits](aiko-memory-graph.md).

## Native surface

- `memory_scan`: bounded current-record keyset pages, with `nextAfter`, `sourceVersion` and partial-coverage reasons. A nonzero cursor excludes a prefix; restart a multi-call scan if the source version changes.
- `memory_publish_page`: compile/save 1–24 stated/inferred claims, each with original observation ID, JSON payload path and verbatim quote. Native actor/thread/turn/call identity supplies the write key and producer. Exact `supersedes` is required for edits.
- `memory_page`: pinned compiled page, evidence status/provenance and private view API path. Quote presence is checked, **not** entailment or semantic truth.
- `memory_lint_pages`: bounded structural/staleness audit. Inferred claims are flagged for review; this is not an LLM correctness grader.
- Optional `memory_index`: one explicitly requested batch of up to eight current observations. No automatic bulk ingestion or embedding on remember/refresh.
- Optional `memory_semantic_recall`: explicitly embed the query, then hybrid-search recorded lexical/vector evidence. Requires a similarity floor; it is not calibrated confidence. Missing vectors and resource/policy exclusions remain visible. Ordinary `memory_recall` remains provider-free.

`WikiMemory.compile`, `compiled`, `compiledHtml` and `lint` delegate to entity-learn, retaining owner checks and redaction. Its existing search, revisions, backlinks and context bundles remain intact. Private style-example consent now follows transitive evidence into derived pages. Revocation excludes those pages from automatic bundles, cloud indexing and semantic tool results; owner-only views remain separately readable. This is metadata/provenance enforcement, not semantic DLP over uncited copies.

Do not merge different conferences/projects/people merely because they are similar. Verify dates, actors, roles and requested event identity against the original source. Preserve useful inferences as qualified inferences; abstain on unsupported particulars. Source corrections stale compiled pages; suppression hides cited descendants. Neither mechanism physically erases logs, artifacts, downloaded HTML or backups.

## Authenticated HTML and SDK

```ts
const view = await client.memory.page(observationId);
// view.page: validated claims and citation metadata
// view.html: escaped static HTML with a restrictive CSP
```

The existing account-authenticated `GET /v1/memory/knowledge/{observationId}` returns `{ page, html }`, with `Cache-Control: no-store`. Foreign or suppressed observations return 404; missing credentials return 401. There is no public artifact link or credential in a URL. Render snapshots in an **empty-sandbox iframe**, not through `innerHTML` in the application DOM. Native `<details>` controls expose evidence; there are no scripts, forms, remote assets or arbitrary generated widgets. A downloaded snapshot does not automatically reflect later corrections or forgetting.

Compilation/editing remains an explicit native tool/library write, not a mutation performed by the HTML. Telegram can identify the page, but the private API URL is not a public share link. An interactive editor may submit exact-head page revisions through an authenticated host; arbitrary model-authored executable editors were deliberately not mounted.

## Optional OpenRouter setup — disabled by default

This is **separate** from paid chat inference and from the existing local request-pointer/response-value embedding provider and retention policy. The separate [browser graph follow-up](aiko-memory-graph.md) improves pointer enumeration and receipts without changing that local provider. The Node host mounts cloud memory tools only in explicitly allowlisted foreground accounts, never in log followers/reflections. Worker hosts may inject an owner-bound `EmbeddingProvider` and durable allowance through `MemoryBinding`; the Worker configuration was not given an implicit cloud grant.

Required host configuration:

| Setting | Meaning |
| --- | --- |
| `AIKO_MEMORY_CLOUD_EMBEDDINGS=true` | Explicit personal-memory cloud egress opt-in; live mode and its existing inference grant are also required |
| `OPENROUTER_EMBEDDING_API_KEY` | Dedicated, rotated environment/private-config credential; never paste it into chat |
| `AIKO_MEMORY_EMBEDDING_OWNERS` | Comma-separated actual account IDs (`local`, numeric Telegram IDs or valid `acct_…` IDs); no wildcard |
| `AIKO_MEMORY_EMBEDDING_MAX_USD_PER_DAY` | Explicit **global** daily cap across enabled owners, positive and at most $10; there is no default allocation |
| `AIKO_MEMORY_EMBEDDING_REVISION` | Host version for provider/model/config identity; bump when semantics change |

These settings are configuration documentation, **not authorization or instructions to enable a running service**. This change did not modify secret files, enable egress, deploy or restart a live host.

The adapter fixes the endpoint/model to OpenRouter `google/gemini-embedding-2`, defaults to 3,072 dimensions, and uses Google's documented asymmetric text prefixes (`task: search result | query: …` / `title: none | text: …`), not `task_type`. Prefix format, model, host revision, dimensions and document format partition the cache. Model aliases are not immutable vendor attestations.

Public catalog text rate was $0.20/M tokens, with an EU route at $0.22. Routing is capped at $0.20/M, no per-request/completion fee, ZDR and no-data-collection; unsupported routing fails closed. Inputs are at most eight × 4,096 UTF-8 bytes before prefixes; no truncation, redirects, retries or fallback models. Responses are bounded and indexed/model/dimension/usage checked. Whole-request timeout is 30 seconds.

`EmbeddingBudget` stores content-free request reservations in the host's private `embedding-budget.sqlite`, outside disposable memory projections and evidence archives. It reserves a conservative byte-based ceiling **before** every request, retains uncertain/failed reservations, refuses previously reserved call keys across restart/day boundaries, and permanently stops admission on an observed overrun pending operator reconciliation. Rebuild and archive import cannot reset the allowance. Accounting is a conservative token-rate ceiling, not a reconciled invoice or credit-purchase fee calculation.

## Verification and current limits

The focused memory/wiki/SDK/gateway/Worker checks remain in `apps/agent/test/knowledge-integration.test.ts` and `entity-memory.test.ts`. The latest full Unlock gate (`pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm aiko:build`) exited 0. A separate Tardie CLI witness compiles a cited page, restarts, replays the seed call with no extra events, and reads the original observation by ID; see [native CLI witness](aiko-entity-learn.md#native-cli-witness). The HTML browser check remains permission-blocked; no screenshot or browser accessibility pass is claimed.

New offline tests: `apps/agent/test/knowledge-integration.test.ts`; existing `entity-memory`, `wiki-memory`, gateway and Worker portability tests remain part of the gate. They cover native call replay/CAS, citation failure/suppression, authenticated SDK/HTML isolation, explicit embedding grants and purposes, private-example consent propagation, redaction, durable global allowance/replay refusal, and strict opt-in configuration. Library tests additionally cover vector dimensions/content integrity, corpus bounds, weak matches, rollback, late provider responses, source races and DO transaction parity.

The deterministic fixture tests are **not an accuracy benchmark or live provider verification**. No paid OpenRouter call or personal-memory upload was performed. A rotated environment-bound key and explicit live-test spending cap are still required. The earlier unfavorable entity-learn GLM smoke scores remain unchanged; this work does not retroactively improve or rescore them.

Current package resolution is `packages/entity-learn` via `workspace:*`. The eight changed library files were synchronized from the sibling implementation only after hash/concurrent-edit checks; existing storage/Cloudflare work was preserved. The older vendor tarball is historical and was not repacked. No unlicensed memory-index implementation was copied. The sibling library's `docs/knowledge.md` documents the primitives and public research references.
