# Aiko feature delivery plan

Date: 2026-09-06. Status: implementation in progress, not product acceptance.

For the owner-clarified product direction and proposed delivery sequence, see [Product prioritisation: the universal connector](product-prioritisation.md): identity-led app discovery, authenticated browser indexing, API graph memory and reusable actions across apps and socials. The full requirements and acceptance gates in this brief remain intact.

## Source and scope

The owner supplied a 20-item brief and approved its implementation. The brief
describes its items as receipted wishes; their individual observation IDs still
need reconciliation. Do not invent receipts or turn this document into proof
that the requested features are delivered.

Owner clarification: Steve's memory is already incorporated in ../entity-learn.
Reuse that library natively. No separate Steve MCP service, Neo4j/MariaDB memory
store, or project-selection decision is required. Aiko currently imports the
workspace entity-learn package; verify its correspondence with the sibling
library before adapting APIs. Wiki pages are projections of native observations,
links, sources, revision history and scoped retrieval, not a new memory system.

## Invariants

- One Aiko persona and one foreground conversation per owner.
- Hidden native threads for independent research, indexing, execution and review.
- Tardigrade events/effects/router/alarms remain execution authority.
- entity-learn remains memory authority. Relationship links are not evidence or grants.
- Credentials stay in owner-controlled custody; only opaque grants reach tools.
- Consequential actions require a human tap against an immutable final payload.
- Ordinary Aiko replies to their requesting owner are not third-party actions.
- ThinkFeel/personalisation precedes approval; approved content is never rewritten.
- Cancellation, revoked access and ambiguous external outcomes stop dispatch.
- Source content cannot grant authority, promote code, or certify its own checks.
- Secular product/runtime terminology: execution graphs, verification gates,
  objectives, checks, reviewers and iterations. Plugin names are compatibility
  identifiers only; religious prompts and a second controller daemon are excluded.

## Feature coverage and acceptance

| ID | Owner wish | Required result / acceptance |
|---|---|---|
| 1 | Self-built tooling | Missing catalog capability becomes a sandbox-tested versioned tool; execution remains grant-bound. Existing read-only builder is only a baseline. |
| 2 | Parallel subagents | Independent native child invocations overlap; fan-in consumes verified outputs; recovery does not duplicate work. |
| 3 | Wiki memory | Native observation pages, links/backlinks, corrections, source citations, search and forgetting; cross-owner reads fail. |
| 4 | Bulk connect | One checklist launches individual authorization flows with per-service progress and retry. No bundled blanket consent. |
| 5 | Seamless logins | Real authorized sessions survive reuse, refresh, expiry and revocation without exposing credentials. |
| 6 | Cerebras browser inference | Existing model-routing seam selects Cerebras for browser work; actual tool-call/stream/cancellation canary passes. |
| 7 | Connect-triggered deep indexing | Verified connection emits a durable indexing request; authorized scope is indexed with checkpoints and truthful partial coverage. |
| 8 | Pointers and fresh fetch | Native request-memory stores evidence-backed pointers and rehydrates fresh values in the owner's session; bodies are not permanent snapshots by default. |
| 9 | Memory as environment | Bounded relevant native memory context is injected automatically with provenance and stale/coverage labels. |
| 10 | User API-key vault | User can add/revoke provider credentials through secure UI; model/log/browser inspection cannot reveal values. |
| 11 | Learned harnesses | Real task traces compile into versioned executable workflows; independent held-out checks gate promotion. |
| 12 | Optional skills, hidden plumbing | Friendly user actions resolve to typed capabilities; production execution does not depend on pasted skill prose. |
| 13 | Cerebras-backed calls | Real consented audio transport, transcription, inference and synthesis; interruption/disconnect tested. Native Telegram user calling is not assumed to be a Bot API capability. |
| 14 | Steve memory | Already incorporated in entity-learn per owner; verify and expose the existing native APIs, not an additional MCP deployment. |
| 15 | Multiplayer | Explicit per-person shared workspace grants; private memory stays private; revocation and participant removal tested. |
| 16 | Mode-aware offers | Offers depend on measured/declared capabilities and pending work; never offer a call when call transport is unavailable. |
| 17 | Style mining | Owner-consented conversation examples form editable/forgettable native style memory; facts and identity remain distinct. |
| 18 | Approval queue | Mini App and Telegram buttons resolve the same durable approval; tampering, double-taps, expiry, stale grants and unknown results fail safely. |
| 19 | Video UGC workflow | Declarative scenes compile to generation/render/review/delivery steps with asset provenance, explicit paid-action approval and a real playable artifact. |
| 20 | One persona | Aiko identity remains stable across channels and roles; role instructions change tasks, not claimed identity. |

## Native execution graph design

Each node declares owner/run/node/revision, dependencies, reads/writes/outputs,
actor/method, grant references, cancellation policy and a versioned check.
Independent frontiers dispatch through native child threads. Conflicting writes
serialize or reconcile through version checks. Completion requires independently
produced evidence for exact inputs and check versions. Changed dependencies or
permissions invalidate affected work. Unknown external outcomes reconcile rather
than retry. Production uses native continuation, not CLI stop hooks.

The plugin supplies the planning/verification method; reusable runtime components
are implemented locally first. No unimplemented public Tardie export is claimed.

## Build order and write ownership

1. Preserve the brief, receipt mapping and existing deployment baseline.
2. Parallel core tracks: execution-graph*.ts, action-approval*.ts, wiki-memory*.ts,
   each with independent tests. Root owns shared actor/host/transport integration.
3. Wire native tools, scoped projections, authenticated human decision ingress,
   and hidden actor dispatch. Test real host restart and import compatibility.
4. Connect/custody and indexing: extend existing connectors and native source
   adapters, not a second auth or memory implementation.
5. Learned tools/workflows and consented style context, with promotion gates.
6. Communication/multiplayer and video pipelines after grants and approvals work.
7. Operator UI and Mini App real-browser checks, then deployment fan-in and live
   acceptance. Persist failures and missing prerequisites honestly.

The existing .claude/jesus-graph.local.json belongs to connector onboarding and
must not be overwritten. This build uses .claude/aiko-feature-graph.json.

## Product gates

Preserve existing login and durable storage; extend full CRUD for rules, graph
runs, approvals and memory views where meaningful. Keep Telegram primary, with
the Mini App for connection/approval management and the operator panel for
debugging. UI checks must exercise login, navigation, actual mutations, rejected
actions, narrow layouts and keyboard focus. API and UI checks both gate release.
Deployment stays on Cloudflare; actual browser/media workloads remain in the
existing owner-isolated sandbox. No new database or runtime is introduced by
default merely to match a generic product template.

The first end-to-end slice is: connect an account, index authorized content,
request work, execute independent background tasks, retrieve fresh evidence,
approve one consequential action, dispatch once, and deliver in the original
Telegram thread. Verify restart, duplicate events, owner isolation and revocation.

## External acceptance prerequisites

- Configured real vault origin and owner-approved runtime/account mapping.
- Privately configured generation provider credentials and approved usage.
- Realtime-call transport and a consented test participant.
- Consent from each multiplayer participant and a real Telegram media recipient.

Cerebras, Arcade and Telegram credentials were found in existing private host
configuration without printing their values. Configuration presence alone is not
a live provider test. Missing credentials or human consent cannot be replaced by
fixture receipts. Model/provider choices are pinned and explicit, with no silent
cross-provider fallback.

## Completion rule

### Response and busy-status implementation — 2026-09-06

Live Bun and Cloudflare hosts require ThinkFeel for composed replies, including
Telegram text, media captions, progress text, synthetic voice-note scripts,
connection prompts, proactive replies and the normal API conversation surface.
Failure produces no raw fallback delivery. Binary attachments and typing signals
are transport events, not persona-generated prose. Future call/video adapters
must use the same composed-script boundary; this does not claim they exist yet.

`/status`, “what's happening?”, “what are you doing?” and “any updates?” enter an
owner-bound native `control-<owner>` lane with no inference/browser tools. It reads
committed foreground activity and pending learning/reflection jobs, composes via
ThinkFeel, delivers to the existing Telegram chat, and mirrors its receipt into
the one foreground conversation. It does not cancel the running task or claim
an estimated completion time. General conversational follow-ups are not yet
independent foreground turns; the status shortcut deliberately matches only
status-only requests.

Verification: blocked-inference Bun test, blocked-effect Cloudflare host test,
restart deduplication, ThinkFeel-before-synthesis and unavailable-provider tests
pass. Full agent suite: 395 passed, 3 browser-dependent tests skipped. A synthetic
live ThinkFeel request returned valid wording with the configured persona; no
Telegram message or real user history was sent. Production deployment of these
changes is not yet verified. Full workspace typecheck currently reports separate
browser-unlock integration errors, so local tests are not a release receipt.

Separate portable contracts gate core implementation and live product outcomes.
Unit tests certify only their stated scope. The full 20-item build stays open
until its real deployed API, browser, connection, approval, memory, Telegram,
call, multiplayer and video checks all pass with current evidence. Do not mark
the product done solely because documentation, a health endpoint, or mocked
adapters are green.
