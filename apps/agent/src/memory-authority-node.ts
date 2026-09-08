import { Database } from "bun:sqlite";
import { privateDatabaseFile } from "./accounts.ts";
import { createMemoryAuthorityRegistry } from "./memory-authority-host.ts";
import { memoryAuthorityFingerprint, type MemoryErasureBinding } from "./memory-erasure-authority.ts";

/** Bun host adapter for the SAME native authority log. The caller supplies an
 * independent control database path outside restored account/memory state.
 * Opening an old registry never regenerates lost authority or HMAC keys. */
export async function openMemoryAuthorityRegistry(path: string, writer: number) {
  const db = new Database(privateDatabaseFile(path));
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    const registry = await createMemoryAuthorityRegistry({
      sql: { exec(sql: string, ...args: (string | number | null | ArrayBuffer)[]) {
        const rows = !args.length && sql.trimStart().startsWith("CREATE") ? (db.exec(sql), []) :
          db.query(sql).all(...args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
        return { toArray: () => rows as never, [Symbol.iterator]: () => (rows as Record<string, never>[])[Symbol.iterator]() };
      } },
      transactionSync: run => db.transaction(run)(),
      sync: async () => {}, // SQLite synchronous=FULL is the commit acknowledgement.
      getAlarm: async () => null,
      setAlarm: async () => { throw Error("Authority metadata cannot schedule work"); },
      deleteAlarm: async () => {},
    }, writer);
    let closed = false;
    return {
      ...registry,
      async binding(owner: string): Promise<MemoryErasureBinding> {
        // Key lookup requires existing admitted authority. No implicit admission
        // of a legacy account and no generation takeover from a tool argument.
        const fingerprint = memoryAuthorityFingerprint(await registry.key(owner));
        return { owner, writer, read: registry.read, append: registry.append, event: registry.event,
          erasureClaim: registry.erasureClaim, fingerprint };
      },
      async close() {
        if (closed) return;
        closed = true;
        try { await registry.close(); } finally { db.close(); }
      },
    };
  } catch (error) { db.close(); throw error; }
}
