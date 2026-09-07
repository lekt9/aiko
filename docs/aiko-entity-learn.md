# Aiko: actual entity-learn on native Tardie

Aiko now uses the actual **entity-learn 0.2.0** engine from `/home/deck/work/entity-learn`. The temporary Aiko pointer/BM25 implementation is gone. Tardie **0.22.0** still owns inference, native tool effects, cancellation, durable scheduling, recovery and delivery. There is no second agent loop, shell replay, Smithers or Cell runtime orchestration. The [account gateway](aiko-gateway.md) now also mounts a native automatic log follower and exposes authenticated, account-bound memory reads to the portable SDK.

## What is integrated

| Capability | Implementation |
| --- | --- |
| Scoped durable memory | Actual `Memory` core; a private SQLite database per host-authenticated owner, plus an explicit owner scope |
| Retrieval | Native `memory_recall`, `memory_get`, `memory_history`, `memory_sources`; immutable observation IDs, freshness, provenance and coverage |
| Writes | Native `memory_remember` and `memory_forget`; agent claims, conditional corrections, exact supporting observations, dependency invalidation and suppression |
| Source reads | Explicit sample-app/issue tools use the engine's approved-source refresh, normalization and immutable observations; receipts cite the resulting IDs |
| Thread composition | Actual `tardigradeLogSource` follows bounded native log windows into cited user-message/metadata episodes; a separate explicit metadata-only projection retains relationship hints |
| Crash recovery | Write keys derive from native actor/instance/thread identity, native turn, persisted tool-call ID and operation—not model arguments |
| Expression | ThinkFeel still receives only fixed neutral wording; memory receipts do not cross that boundary |

`apps/agent/src/memory.ts` is the current-version tool/policy adapter, **not another storage, search, normalization or journaling engine**. Only native effects open storage or observe sources; assembling/projecting the tool surface does neither.

The library's bundled `memoryPackage` adapter targets Tardie **0.5** and is **not exported** from this workspace copy (`entity-learn/tardigrade` does not resolve). Aiko mounts the version-independent core and `tardigradeLogSource` through **0.22 native tools**. Dependency inspection confirms Tardie **0.22.0** and Effect **4.0.0-rc.110**.

## Tool artifacts and request cache

Code-mode tool calls record the current tool-definition and input-schema hashes in native Tardigrade events. Verified code-workflow saves record the source digest, dependency hashes and successful execution reference. The log follower imports bounded structural receipts into entity-learn and writes content-addressed artifact references with exact observation dependencies. The existing graph endpoint includes tool, schema and code-workflow nodes. Source code remains in the owner workflow store and native code-dispatch history; execution inputs and results remain transient.

The Cloudflare code-mode router now discovers mounted native tools and verified saved code workflows. It returns the exact `tools.call` or `code_workflow_run` invocation mapping. Route status checks include current contracts; changed dependency schemas and tampered saved source exclude workflows from the shortlist. Execution still rechecks the owner and current tool schemas.

Observed network requests are reusable cached tool definitions. Re-indexing an unchanged definition, structural evidence and embedding model reuses its immutable entity-learn pointer without another embedding call. Search returns the tool digest, source trace, observation time and `requires-check` freshness. Hydration performs a fresh read and writes an immutable, cited update check with an owner-scoped response fingerprint and `changed` (`null` on the first check). Check history survives reopening the store. Host HTTP replay also logs individual request starts and settlements, tied to their learned DAG and prior response fingerprints.

This cache retains request contracts, structural evidence, embeddings and check receipts. It does not retain raw response bodies or substitute historical responses for live reads. Capture applies to the existing browser-learning and observed HTTP paths; it is not a process-wide interceptor for provider SDK or arbitrary network traffic. No deployment or retrospective import of earlier omitted tool metadata is implied.

## Reproducible dependency

- Current package: `packages/entity-learn`, resolved by `workspace:*`, with native Node and `workerd` entry points only.
- Source pin: `packages/entity-learn/provenance.json` names [lekt9/entity-learn-private](https://github.com/lekt9/entity-learn-private) commit `44ca591bc45835d5cd8e9c599f7e60f685d2eed9` and SHA-256 hashes for every `lib/*.ts` file. `bun scripts/check-entity-learn.ts` (and `--upstream /home/deck/work/entity-learn`) verifies identity, hashes, the missing legacy adapter export, and the installed Tardie/Effect versions. Hashes detect drift; they are not a signature of a rewritten manifest.
- Sibling edits do not automatically update this workspace copy or an already running process.
- `vendor/entity-learn-0.2.0.tgz` is a retained historical artifact, not the current resolution.
- See [the knowledge integration](aiko-knowledge.md) for compiled pages and optional embeddings.

## Try it without provider spend

```sh
pnpm install --frozen-lockfile
pnpm aiko:init
pnpm aiko:dev
```

Open <http://127.0.0.1:4242> and use the operator token from your private configuration file locally. Do not paste it into chat.

1. `Remember: Use UTC for the launch`
2. Restart Aiko with the same state directory.
3. `Search memory for UTC`
4. `Show sample GitHub issues`, then `Search memory for calendar`
5. `Refresh logs`

The note in steps 1–3 is actually written by the engine, not supplied as fixture data. The default inference adapter routes these explicit demo commands deterministically; it is not paid GLM inference. More general corrections, pinned inspection and forgetting are exposed as native tools and tested directly/native-host-side, not implemented as an additional free-form demo language parser.

## Security and operating boundaries

- The HTTP host authorizes an owner before constructing the actor/memory binding. The operator accesses only `local`; verified private Telegram senders follow the configured allowlist/public-onboarding policy; SDK grants bind exactly one account. Non-local accounts have separate private log and memory directories. These are **not Supabase sessions**.
- Memory location and scope are assigned by the host. Arguments cannot select a tenant, path, producer, source recipe, executable command or permission. Cross-owner reads/citations fail; authorized threads can share their owner's memory.
- Remembered material is an **agent claim**, not verified truth, a user attestation or proof of an app action. Retrieved instructions and relationship hints confer no authority.
- Recall never refreshes. Model-callable source reads are limited to declared fixtures and the caller's native log window. No arbitrary files, URLs, browser actions or shell commands are exposed.
- Logs are read as data. No message bodies or recursive tool-result bodies are copied. Original-event digests and sequence references identify evidence; they do not authenticate it. Links are hints, not proof.
- Recall is bounded to 10 matches, 12 KB, depth 2, 24 graph nodes and 2,000 candidates. Source windows contain at most 25 events and disclose partial coverage/cursors. Source registration is capped at 64; the source listing shows at most 16 and discloses its total.
- Existing disabled/quarantined sources are never silently approved again. If a process dies between first registration and approval, the source remains disabled: a trusted operator must inspect and approve its exact current revision through the core API. This conservative bootstrap failure is not reported as a successful refresh.
- Memory directories are 0700 and SQLite files are 0600. Unsafe files and symlinks are rejected. Handles are closed after each operation. State remains under the host's existing single-process lock.
- This memory and the Tardie transcript are **not encrypted custody records** and are not a place for credentials. Known-secret redaction and the engine's credential-pattern rejection are defense in depth, not comprehensive DLP.
- Forgetting suppresses future retrieval, including cited/derived claims. It does **not** physically erase journal payloads, earlier chat/tool logs, already supplied context or backups. It must not be presented as secure deletion.
- This does not import legacy command pointers, auto-read the operator's separate personal memory database, implement classic Contract admission, or activate a source scheduler. The unavailable classic branch remains unavailable.

## Knowledge and optional embeddings

Native compilation, citation checks, safe HTML views and optional explicitly budgeted OpenRouter embeddings now compose with this same engine and the existing `WikiMemory` policy adapter. Local request-pointer/response-value embeddings are unchanged. Cloud personal-memory egress is **off by default** and is not mounted in background followers/reflections. See [configuration, APIs and tests](aiko-knowledge.md).

## Native CLI witness

The production Tardie 0.22 CLI, not a second host, compiles, serves, calls, restarts and replays a synthetic memory actor:

```sh
bun scripts/check-entity-learn.ts --upstream /home/deck/work/entity-learn
python3 /home/deck/work/aiko/cell/run.py run scripts/native-memory-witness.cell.yaml --inputs '{}' --out /tmp/unlock-native-memory-witness
```

`apps/agent/scripts/audit-native-memory.ts` is a fixture-only entry. It mounts the same `memoryTools` adapter, injects `Infer`, and never installs a provider, browser, log-import grant or embedding capability. A local catalog fixture is the only loopback HTTP. After restart, replaying `seed-1` adds no events. The later `read` turn scans the compiled page, opens it, and returns `UTC [<source observation id>]` from the original payload. Build digest: `sha256:9a7006cdac7201f684c4c6b7981a3bf8957a81c4d18d76bfe67d727a07baf370`. Paid model calls: 0. Provider tokens: unavailable (deterministic `Infer` layer). The Voyager URL is local to that `tdg dev` process and is not a durable public trace.

| Measure | This witness |
| --- | --- |
| Direct dependencies | `tardie@0.22.0`, `effect@4.0.0-rc.110`, `entity-learn@workspace:*` |
| Paid model calls | 0 |
| Provider tokens / cost | unavailable (injected `Infer`) |
| Restart / replay | seed output and event log unchanged |
| Cited evidence | original observation ID and payload text |

## Verification

Latest offline workspace gate (`scripts/aiko-gateway-verify.cell.yaml`): **pnpm typecheck, pnpm test, pnpm build, pnpm aiko:build all exit 0**. Focused memory tests: **24 pass** across `entity-learn-dependency`, `knowledge-integration` and `entity-memory`, including the durable host crash recovery that recommits the same observation ID. Upstream pin comparison: 23 hashed library files match commit `44ca591`.

The following counts describe an earlier integration snapshot, not this gate. Saved under `artifacts/aiko-entity-learn/`:

- **142 project tests pass:** 100 Vitest plus 42 Bun-native tests. **33 database-dependent tests remain skipped**, not passed.
- **41 upstream entity-learn tests pass**, including its own legacy-adapter tests; Aiko's separate suite proves the current-version integration.
- The actual native-host crash test commits memory, fails before `ToolReturned`, closes the host, then recovers with the **same observation ID and exactly one memory revision**.
- Integration tests cover cross-thread sharing, tenant isolation, foreign citations, replay conflicts, exact corrections, historical reads, dependency staleness, forget suppression, disabled-source behavior, byte caps, cancellation, credential rejection, unsafe files, log composition and no command replay.
- The real GLM adapter is exercised with a mocked stream that advertises these native tools. **No paid inference or live provider call is implied.**
- **Four console browser checks pass** through browser-harness, including an actual note write and cited recall. Layout checked at 320/390/768/1440 viewport widths; **four axe scans have no violations**. Only an isolated local fixture with a deliberately public test token was used; no real credentials were entered into the browser.
- Production dependency audit reports no known vulnerabilities. Provenance and known-secret scan receipts are saved alongside the verification record.

The original `docs/aiko-implementation.html` is the earlier UI/foundation snapshot; this document supersedes its memory-specific claims. OAuth, Supabase RLS and live app data remain **unimplemented/configuration-blocked**, and are not made functional by this memory integration. Real sign-in must be verified separately once the chosen Supabase project and BotFather credentials are configured.
