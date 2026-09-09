import { Memory, MemoryError, type ErasureFence, type MemoryStorage, type MemoryOptions, type RestoreAuthority, type SourceRunner } from "entity-learn/cloudflare";

/** Host control data: deliberately outside the entity-learn archive and account KV snapshot. */
const TABLE = "aiko_memory_erasure_authority";
const connections = new WeakMap<Memory, MemoryStorage>();
/** Exact native connection identity, never reconstructed from a path/archive. */
export const guardedMemoryStorage = (memory: Memory) => connections.get(memory);
const valid = (scope: string, fence: ErasureFence): boolean => fence.version === 1 && fence.scope === scope &&
  Number.isSafeInteger(fence.seq) && fence.seq >= 0 && /^[a-f0-9]{64}$/.test(fence.digest) &&
  (fence.seq !== 0 || fence.digest === "0".repeat(64));
const same = (a: ErasureFence, b: ErasureFence) => a.scope === b.scope && a.seq === b.seq && a.digest === b.digest;
function localAuthority(storage: MemoryStorage, scope: string): ErasureFence | undefined {
  const row = storage.prepare(`SELECT fence FROM ${TABLE} WHERE scope=?`).get(scope);
  if (!row) return undefined;
  let fence: ErasureFence;
  try { fence = JSON.parse(String(row.fence)); }
  catch { throw new MemoryError("corrupt_store", "Invalid host erasure authority"); }
  if (!fence || !valid(scope, fence)) throw new MemoryError("corrupt_store", "Invalid host erasure authority");
  return fence;
}

/** Read current trusted control state without reparsing the candidate archive.
 * Call under the same owner gate as erasure and restore publication. */
export function memoryRestoreAuthority(storage: MemoryStorage, scope: string, external?: RestoreAuthority): ErasureFence | undefined {
  const retained = localAuthority(storage, scope);
  if (!external) return retained;
  const current = external(scope);
  if (!current || !valid(scope, current) || retained && !same(retained, current)) return undefined;
  return current;
}

/** The native journal invokes this host callback in its own SQL transaction.
 * A failed checkpoint write therefore cannot acknowledge a committed erasure.
 * This table survives archive import, not loss/rollback of the whole host DB. */
export function openGuardedMemory(options: {
  storage: MemoryStorage;
  scope: string;
  adapters?: Readonly<Record<string, SourceRunner>>;
  files?: MemoryOptions["files"];
  /** Separate trusted control-plane authority is required on a fresh recovery target.
   * Never derive it from the candidate archive, request body or imported account state. */
  restoreAuthority?: RestoreAuthority;
  /** Synchronous executor custody checks inside EACH native transaction. The
   * host must supply this for all-write admission, including direct callers. */
  writeAuthority?: { storage: MemoryStorage; check(scope: string): void; after(scope: string): void };
  /** Per-call handles may share a host-owned connection; only its owner closes it. */
  closeStorage?: boolean;
}): Memory {
  const { storage, scope } = options;
  if (options.writeAuthority && options.writeAuthority.storage !== storage)
    throw new MemoryError("forbidden", "Memory write guard requires the same native connection");
  storage.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (scope TEXT PRIMARY KEY, fence TEXT NOT NULL)`);
  const local = () => localAuthority(storage, scope);
  const retain = (fence: ErasureFence) => {
    if (!valid(scope, fence)) throw new MemoryError("corrupt_store", "Foreign or invalid erasure checkpoint");
    const prior = local();
    if (prior && (fence.seq < prior.seq || fence.seq === prior.seq && !same(prior, fence)))
      throw new MemoryError("corrupt_store", "Erasure authority cannot move backward");
    storage.prepare(`INSERT INTO ${TABLE}(scope,fence) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET fence=excluded.fence`)
      .run(scope, JSON.stringify(fence));
  };
  let memory: Memory;
  const authorize = (phase: "check" | "after") => {
    if (!options.writeAuthority) return;
    const result: unknown = options.writeAuthority[phase](scope);
    // TypeScript permits an async function in a void-returning slot. It must
    // never turn a pending RPC into synchronous permission to commit SQL.
    if (result !== undefined) throw new MemoryError("forbidden", "Memory write authority must be synchronous");
  };
  const guardedStorage: MemoryStorage = {
    ...storage,
    ...(options.closeStorage === false ? { close: () => {} } : {}),
    transaction: run => storage.transaction(() => {
      authorize("check");
      // A recovered checkpoint without its journal does not make a fresh write
      // safe. Only a transaction restoring that native erasure history can
      // resume writes; otherwise its new data would omit the subject fences.
      const empty = memory.journal.scopeVersion(scope) === 0;
      const authority = memoryRestoreAuthority(storage, scope, options.restoreAuthority);
      // Existing rows are not continuing authorization. A configured external
      // source must remain current for EVERY native write, not just first boot.
      if (options.restoreAuthority && !authority)
        throw new MemoryError("forbidden", "Restore authority is unavailable for a memory write");
      const recovering = empty && authority && authority.seq > 0;
      const result = run();
      if (recovering && !same(authority, memory.erasureFence()))
        throw new MemoryError("forbidden", "Native erasure history must be restored before new memory writes");
      // Preparation may immediately follow the first write on this same handle.
      // Retain its checkpoint atomically, not only when a later handle opens.
      if (!local() && memory.journal.scopeVersion(scope) > 0) retain(memory.erasureFence());
      authorize("after");
      return result;
    }),
  };
  memory = new Memory({
    storage: guardedStorage, scope, adapters: options.adapters, files: options.files,
    restoreAuthority: requested => {
      if (requested !== scope) return undefined;
      return memoryRestoreAuthority(storage, scope, options.restoreAuthority);
    },
    onErasure: ({ fence }) => retain(fence),
  });
  try {
    // Upgrade an existing authoritative live journal, never an empty target.
    // Check and retain within the same host transaction as the journal snapshot.
    storage.transaction(() => {
      const retained = local();
      if (memory.journal.scopeVersion(scope) > 0) {
        const current = memory.erasureFence();
        if (retained && !same(retained, current))
          throw new MemoryError("corrupt_store", "Live memory conflicts with retained erasure authority");
        if (!retained) retain(current);
      }
    });
    connections.set(memory, storage);
    return memory;
  } catch (error) { memory.close(); throw error; }
}

/** Shares one owner admission mutex across native erasure and asynchronous
 * restore work. Durable authority remains the restart boundary. */
export function memoryRestoreGate() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(operation);
    tail = next.then(() => undefined, () => undefined);
    return next;
  };
}
