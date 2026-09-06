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

The library's bundled `memoryPackage` adapter targets Tardie **0.5**. It is not imported into Aiko. Instead, the version-independent core and existing log adapter are mounted through **0.22 native tools**. The upstream `lib/index.ts` was extended to publicly export the existing log adapter without importing the legacy Tardie package. The declared optional legacy peer warning is expected; dependency inspection confirms that Aiko still installs only Tardie 0.22.0.

## Reproducible dependency

- Package: `vendor/entity-learn-0.2.0.tgz`, installed through the normal pnpm dependency/lockfile.
- Origin: the actual local working tree, including its pre-existing changes—not a substituted registry package or an invented classic API.
- Provenance: `vendor/entity-learn-0.2.0.provenance.json`, with the upstream HEAD, library/build hashes and artifact digest.
- Updates are deliberate rebuild/repack/test steps. A later edit in the sibling checkout does not silently change the running dependency. See `vendor/README.md`.

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

## Verification

Saved under `artifacts/aiko-entity-learn/`:

- **142 project tests pass:** 100 Vitest plus 42 Bun-native tests. **33 database-dependent tests remain skipped**, not passed.
- **41 upstream entity-learn tests pass**, including its own legacy-adapter tests; Aiko's separate suite proves the current-version integration.
- Workspace typecheck, web/backend build, native build and frozen install pass.
- The actual native-host crash test commits memory, fails before `ToolReturned`, closes the host, then recovers with the **same observation ID and exactly one memory revision**.
- Integration tests cover cross-thread sharing, tenant isolation, foreign citations, replay conflicts, exact corrections, historical reads, dependency staleness, forget suppression, disabled-source behavior, byte caps, cancellation, credential rejection, unsafe files, log composition and no command replay.
- The real GLM adapter is exercised with a mocked stream that advertises these native tools. **No paid inference or live provider call is implied.**
- **Four console browser checks pass** through browser-harness, including an actual note write and cited recall. Layout checked at 320/390/768/1440 viewport widths; **four axe scans have no violations**. Only an isolated local fixture with a deliberately public test token was used; no real credentials were entered into the browser.
- Production dependency audit reports no known vulnerabilities. Provenance and known-secret scan receipts are saved alongside the verification record.

The original `docs/aiko-implementation.html` is the earlier UI/foundation snapshot; this document supersedes its memory-specific claims. OAuth, Supabase RLS and live app data remain **unimplemented/configuration-blocked**, and are not made functional by this memory integration. Real sign-in must be verified separately once the chosen Supabase project and BotFather credentials are configured.
