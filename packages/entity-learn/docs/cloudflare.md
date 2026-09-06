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
