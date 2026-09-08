# Native Cloudflare storage

`entity-learn/cloudflare` runs the existing Memory, Journal and recall algorithms over the SQLite storage of a Durable Object. It does not implement a parallel entity recognizer or alter observation identities. Node/Bun callers can keep `new Memory({ path, scope })` unchanged.

```ts
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";

const memory = new Memory({
  storage: cloudflareStorage(ctx.storage),
  scope: authenticatedOwnerScope,
  adapters: hostBoundSourceRunners,
});
```

Bind scope from authenticated host configuration, never model arguments. A per-owner Durable Object may create fresh Memory handles for multiple actor threads over the same storage. Close only releases the handle: DO storage remains host-owned. Await `ctx.storage.sync()` before acknowledging a committed operation to an external caller. Source refresh is asynchronous, but each journal change retains the native synchronous transaction and source-revision check.

The Worker entry has no filesystem or Node SQLite imports. It requires Worker `nodejs_compat` for the standard crypto/Buffer facilities. File sources require an explicitly supplied host file capability; adapter sources remain the normal Worker integration point. Package condition `workerd` selects this entry automatically. `validateRememberInput`, `validateSourceInput`, and `validatePayload` expose the exact native admission checks without opening a database; these do not confer producer authority or validate evidence availability.

## Operator-only migration

`memory.exportArchive()` captures the complete native journal and content-addressed artifacts from a dedicated single-scope store. This includes forgotten payloads, historical citations, request receipts, source approvals, revocations and failures. It is a backup operation, **not a retrieval API or model tool**. Protect the resulting bytes as private owner data.

`memory.importArchive(archive)` accepts only an empty destination memory store with the exact same host-bound scope. It validates format, canonical bytes, artifact and journal digests, observation IDs, source recipes and the final chain root, then restores native rows and rebuilds disposable projections in one transaction. A rejected import rolls back completely. It never executes a source, changes observation IDs, or revives forgotten data. Unrelated tables in the same Durable Object are untouched. Import is intentionally not merge/overwrite/upsert.

Atomic archives are limited to 8 MiB serialized and 16,384 rows in each authoritative table. Larger stores fail closed without partial exports; they require a separately verified paged migration. Do not delete or replace the source when this limit is reached.

For cutover, pause owner writes, export from the source, verify the returned root, import into the empty destination, await durable storage sync, then compare exported archives/roots and verify recall, history and revoked sources before routing traffic. Keep the original database available for recovery. An export is a consistent point-in-time snapshot, not live replication.

Verification: `bun test tests/cloudflare.test.ts` checks backend parity over real SQLite, native rollback, scope isolation, archive fidelity and a Worker dependency-graph build. The strict DO-contract test adapter is not a workerd runtime; production hosts must additionally exercise their actual DO binding.

## Explicit whole-scope erasure

`memory.eraseScope(expectedVersion, key)` is a host-authorized operation distinct
from `forget`. The host must explicitly authorize **all memory in this scope**
being erased and permanently retired. Obtain `expectedVersion` from
`memory.journal.scopeVersion(memory.scope)`; intervening writes fail with
`scope_conflict`. Retry the same version/key after an uncertain return. Changed
request identity conflicts; subsequent writes and old receipt hydration fail with
`erased`. Selective erasure is available through the separate API below.

Within one native SQLite transaction, up to 4096 scope journal entries become
metadata-free tombstones, scope observations/heads/sources/derived data are
removed, and payload artifacts with no remaining journal references are deleted.
Other scopes keep their bytes and original receipts, including shared payloads.
Scope identity and opaque cryptographic commitments remain. A new native erasure
receipt commits to each replacement. Original chain digests/links remain; rebuild
verifies replacement commitments against that receipt, rather than pretending it
can recompute an erased plaintext event. This is a deliberate extension of the
journal integrity model, not proof that removed plaintext remains recoverable.
Old runtimes cannot verify these tombstones and must not open an erased archive.

This erases live logical SQLite contents, **not forensic disk/WAL pages, snapshots,
old exports, remote backups, host logs, tool/continuation blobs or in-flight process
memory**. No encryption-key shredding is implemented. The host still needs an
owner-bound deletion operation for those stores, backup/restore suppression and
final dispatch cancellation. Do not promise selective fact deletion by silently
calling this whole-scope API. Existing `forget()` continues to report `erased:false`.

## Selective subject erasure

`memory.eraseSubject({ subject, expectedHead, expectedScopeVersion, key })` is a
separate host-authorized operation. It does **not** retire or erase the owner's
whole scope. The expected head and scope version must match before mutation;
retry the original arguments after a lost return. The result is
`{ scope, erased: true, retired: false, subjects, observations, observationIds, replacements }`.
The counts and observation IDs identify the removed closure for host cleanup.

The bounded closure includes every historical version of the target subject and
all versions of known dependent subjects reached through `supports` and
`dependsOn`. Ordinary `links` are navigational, not evidence dependencies. Limits are 4096 scope journal rows, 16384 observations
and 256 closure subjects; excess fails atomically. Unrelated observations in the
same scope or even the same refresh row keep their IDs, payloads and source
recipe. Other scopes and their shared artifact references remain intact.

Affected rows retain the original chain commitment but replace removed metadata
and observation entries. Each erasure commits to the new row body and, on repeat
replacement, its previous replacement commitment. Rebuild and archive import
validate that cumulative proof chain. Old affected operation receipts/replays
fail with `erased`; they never dispatch a source again. New refresh operations
filter fenced subjects and still admit unrelated records. Ordinary writes cannot
reintroduce a fenced subject. Native manifests retain domain-separated hashed
subject fences and removed observation IDs, not raw subject names or deleted
quotes. These hashes are admission identities, not encryption or a promise of
resistance to offline guessing of identifiers.

The disposable derived cache is cleared for this scope; late writes keyed by a
removed observation ID are fenced. Other scopes' caches are untouched. Artifact
collection removes bytes only when no journal observation anywhere still refers
to them. This does not discover unlinked paraphrases, identical data retained by
unrelated authorized observations, application blobs, logs, or backups. Shared
source configuration is retained rather than guessed to be private fact data.

Hosts must authorize the specific subject and known-dependent closure, serialize
against current scope version, cancel/fence pending dispatch using the returned
observation IDs, and purge associated private blobs through their own owner-bound
custody interface. Restore must honor deletion receipts retained outside any old
backup being restored. No whole-scope fallback is permitted for a selective
request. The forensic storage and external-copy limitations of scope erasure
above also apply here. Full journal verification and artifact GC inspect the
store; this synchronous maintenance operation is bounded but not O(1).

Archive import checks destination emptiness within its native transaction before
inspecting candidate archive fields or artifacts. A target retaining erasure
journal receipts refuses an older archive even if its disposable projections
were removed. Rebuild reconstructs selective admission fences and partial rows
from that journal. A fresh empty store without those receipts can still import a
structurally valid pre-erasure archive: hosts must preserve and consult current
erasure authority before replacing a store from backup. This is rollback
prevention for retained native state, not physical backup deletion.

Navigational links to erased subjects are removed while independent payloads and
history remain. Because links participate in observation identity, sanitized
observations receive new canonical IDs. Existing `supersedes`, `supports` and
`dependsOn` references to those records are rebound in journal order, with new
canonical IDs where required. Native erasure receipts record each
`replacements: [{ previous, observation }]` mapping and cumulative row commitments;
old IDs are unavailable rather than silently aliased to changed content. Rebuild
and archive import still validate every retained observation's canonical ID.
New writes filter links to erased subjects before assigning IDs. Old affected
operation replay fails without rerunning its source. Late cache writes keyed by
removed or replaced observation IDs are fenced.

Hosts must distinguish `observationIds` (deleted evidence closure) from
`replacements` (preserved facts with changed metadata/references). Invalidate old
citations and stale serialized wrappers containing removed links, but do not
indiscriminately delete the independent payloads of rewritten facts. Previously
completed erasures under an older implementation are not automatically reversed;
this change does not recover bytes that were already deleted. Untracked copied
text, source configuration, forensic storage and backup limitations remain as
stated above.

### External restore authority

`Memory.erasureFence()` returns `{ version: 1, scope, seq, digest }` from a verified
native journal (zero sequence/digest explicitly means no erasure). Retain this
checkpoint in trusted owner custody outside the database being restored after
every successful erasure, before acknowledging deletion. No private subjects or
payloads are included. Configure `MemoryOptions.restoreAuthority(scope)` to
synchronously return that current checkpoint. Null/undefined, malformed or foreign
scope authority refuses import before inspecting the archive. Callback exceptions
also refuse import. Do not source authority from the candidate archive.

Guarded import requires the retained erasure checkpoint in the candidate chain;
full native chain/replacement/payload verification still runs transactionally.
Earlier archives are rejected, not repaired. The latest erasure must match exactly;
a newer erasure or scope retirement requires an updated external checkpoint.
This also rejects unapproved appended replacement manifests. Ordinary later
writes may extend the verified chain without changing the erasure checkpoint.
Existing callers without the option retain legacy unguarded portability behavior.
`Journal(storage, restoreAuthority)` exposes the same host-bound guard.

The host must serialize erasure/checkpoint retention and restore admission, and
fail closed while checkpoint publication is pending or unavailable. This API
cannot authenticate the host's storage, detect a stale externally supplied fence,
or atomically commit to an external authority store. It adds no secondary journal.
It does not erase forensic backups, WAL pages, host logs, or unknown copies.

### Atomic authority publication and preflight

`MemoryOptions.onErasure(commit)` is a trusted synchronous callback inside the
native erasure transaction. `commit` contains `fence`, `operation`, and `receipt`
(`key`, `seq`, `digest`, `requestDigest`, original `scopeVersion`). Write an
excluded host authority table using the SAME storage connection/transaction.
Throwing rolls back both native deletion and that table write. Do not perform
network, asynchronous, or independent-storage effects here: those cannot be
rolled back. Promise-returning callbacks are rejected; hosts must never launch
async work in them. Replaying the original erasure reasserts its original receipt
identity with the CURRENT verified fence, not an older checkpoint. Callback
publication alone does not attest completion of external private-copy cleanup.

`Memory.checkArchiveErasure(value)` works against populated or empty stores and
ALWAYS requires configured, valid `restoreAuthority`, before archive access.
It shares import's authority/fence validation and existing bounded archive
structure/artifact checks. It returns only `{scope, fence, journalRows, artifacts,
chainVerified:false}`. It neither imports data nor verifies the complete journal
chain/replacement proofs; actual import still performs that verification. It is
not a whole-account, thread, KV, VM, backup authenticity or deletion proof.
Hosts must recheck authority at activation and serialize with erasure, including
exact-restore retry paths that otherwise skip native import. Legacy unguarded
`importArchive` behavior is unchanged.

### Original subject-erasure operation lookup

`Memory.subjectErasureReceipt(originalKey)` applies the exact native operation-key
transformation used by eraseSubject and verifies the retained journal in one read
snapshot. It returns the original StoredEvent plus original scopeVersion, or
undefined for absence in that verified history. Retired scopes and corrupt chains
reject. A configured restoreAuthority must match the current erasure checkpoint;
unavailable/foreign/mismatched authority rejects. No lookup writes or source runs.
Without independently retained authority, a valid old journal prefix cannot be
distinguished from complete historical state. This is not a forensic truncation
proof. Full retained-chain verification is linear, not an indexed-only O(1) claim.

`Memory.prepareSubjectErasure(input)` validates the exact eraseSubject input and
checks the current head/version (or an exact original committed request) in a read
snapshot. It returns `{scope,key,receiptKey,requestDigest,request}`; `request.subject`
is the native hashed subject fence, not raw subject text. Both prepare and erase
share the canonical identity builder. The host can durably prepare external custody
using this identity before deletion. Preparation performs no writes, reserves
nothing and grants no authority; eraseSubject still checks head/version in its
commit. Do not treat the subject hash as anonymization or publish private keys.
