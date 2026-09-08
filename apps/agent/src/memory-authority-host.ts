import { createHash, randomBytes } from "node:crypto";
import { Layer } from "effect";
import { createCloudflareAccountHost, type AccountStorage } from "./cloudflare-host.ts";
import { memoryScope } from "./memory.ts";
import { safeUserId } from "./security.ts";
import { memoryAuthorityAppendAllowed, memoryAuthorityEventKey, projectMemoryAuthority,
  type MemoryAuthorityEvent } from "./memory-authority.ts";

const prefix = "memory-authority-";
const scopeOf = (owner: string) => {
  if (!safeUserId(owner)) throw Error("Invalid owner");
  return { owner, scope: memoryScope(owner) };
};
class AdmissionFull extends Error {}

/** Registry control metadata lives outside each account's database and archive.
 * Tardigrade supplies the log, identity, deduplication and atomic append. This
 * host has no actor, tools, timer or executable ingress. */
export async function createMemoryAuthorityRegistry(storage: AccountStorage, writer: number) {
  if (!Number.isSafeInteger(writer) || writer < 1) throw Error("Invalid account writer generation");
  storage.sql.exec("CREATE TABLE IF NOT EXISTS accounts(owner TEXT PRIMARY KEY,created_at INTEGER NOT NULL)");
  // Independent control custody, never included in account archives or events.
  // Lost keys are not silently regenerated: retained request HMACs would change.
  storage.sql.exec("CREATE TABLE IF NOT EXISTS aiko_memory_authority_keys(owner TEXT PRIMARY KEY,secret TEXT NOT NULL)");
  const registered = (owner: string) => storage.sql.exec("SELECT 1 FROM accounts WHERE owner=?", owner).toArray().length > 0;
  const host = await createCloudflareAccountHost({ storage,
    actorName: "aiko-memory-authority", actorInstance: "registry-v1",
    ownsThread: thread => thread.startsWith(prefix) && safeUserId(thread.slice(prefix.length)),
    actorFor: () => undefined, layersFor: () => Layer.empty,
    keyOf: memoryAuthorityEventKey,
    canAppend: (thread, events, read) => {
      const scope = scopeOf(thread.slice(prefix.length));
      return memoryAuthorityAppendAllowed(read(), events, scope);
    },
  });
  const read = async (owner: string) => {
    const scope = scopeOf(owner);
    return projectMemoryAuthority(await host.read(prefix + owner), scope);
  };
  const append = async (owner: string, event: MemoryAuthorityEvent) => {
    const scope = scopeOf(owner);
    await host.appendControl(prefix + owner, [event]);
    const rows = await host.read(prefix + owner);
    // The projection enforces structural replay equality. An accepted zero
    // append without our intended retained event must never acknowledge work.
    if (!rows.some(row => memoryAuthorityEventKey(row) === memoryAuthorityEventKey(event)) ||
        !memoryAuthorityAppendAllowed(rows, [event], scope)) throw Error("Memory authority transition could not be confirmed");
    return projectMemoryAuthority(rows, scope)!;
  };
  return {
    async admit(owner: string, maximum?: number): Promise<boolean> {
      const scope = scopeOf(owner);
      if (maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < 0)) throw Error("Invalid account limit");
      // Legacy membership does not prove a zero erasure history. Preserve its
      // admission but leave authority unavailable until a trusted live migration.
      if (registered(owner)) return true;
      if (await read(owner)) throw Error("Account inventory conflicts with retained memory authority");
      const fence = { version: 1 as const, scope: scope.scope, seq: 0, digest: "0".repeat(64) };
      const event = { ...scope, type: "AikoMemoryAuthorityInitialized", writer, key: "initial-admission",
        at: Date.now(), expectedRevision: 0, fence,
        bootstrap: { reference: "new-account-admission", digest: createHash("sha256")
          .update(JSON.stringify(["aiko.memory-authority.admission/v1", owner, fence])).digest("hex") },
      } as const;
      try {
        await host.appendControl(prefix + owner, [event], { sidecar: () => {
          const count = storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM accounts").toArray()[0]!.count;
          if (maximum !== undefined && count >= maximum) throw new AdmissionFull();
          storage.sql.exec("INSERT INTO accounts VALUES(?,?)", owner, event.at);
          storage.sql.exec("INSERT INTO aiko_memory_authority_keys VALUES(?,?)", owner, Buffer.from(randomBytes(32)).toString("hex"));
        } });
      } catch (error) { if (error instanceof AdmissionFull) return false; throw error; }
      // Concurrent first admissions may deduplicate or reject a changed retry.
      // Membership AND a valid retained checkpoint are the acknowledgement.
      if (!registered(owner) || !await read(owner)) throw Error("Account admission could not be confirmed");
      return true;
    },
    read,
    /** Trusted account host only. Keep in process memory, never account KV/logs
     * or candidate archives. Independent registry backup must preserve it. */
    async key(owner: string): Promise<string> {
      scopeOf(owner);
      if (!registered(owner) || !await read(owner)) throw Error("Memory authority unavailable");
      const row = storage.sql.exec<{ secret: string }>("SELECT secret FROM aiko_memory_authority_keys WHERE owner=?", owner).toArray()[0];
      if (!row || !/^[a-f0-9]{64}$/.test(row.secret)) throw Error("Independent memory authority key unavailable");
      return row.secret;
    },
    /** Exact immutable control event, for acknowledgement-loss reconciliation.
     * A current projection alone cannot attest which terminal was retained. */
    async event(owner: string, key: string): Promise<MemoryAuthorityEvent | undefined> {
      const scope = scopeOf(owner), rows = await host.read(prefix + owner);
      projectMemoryAuthority(rows, scope);
      const event = rows.find(row => memoryAuthorityEventKey(row) ===
        `aiko-memory-authority:${JSON.stringify([owner, scope.scope, key])}`);
      return event ? structuredClone(event) as MemoryAuthorityEvent : undefined;
    },
    async erasureClaim(owner: string, receiptKey: string) {
      const scope = scopeOf(owner), rows = await host.read(prefix + owner);
      projectMemoryAuthority(rows, scope);
      const claims = rows.filter((row): row is import("./memory-authority.ts").MemoryAuthorityClaim =>
        row.type === "AikoMemoryAuthorityClaimed" && (row as import("./memory-authority.ts").MemoryAuthorityClaim).native?.receiptKey === receiptKey);
      if (claims.length > 1) throw Error("Conflicting erasure receipt authority");
      return claims[0] ? structuredClone(claims[0]) : undefined;
    },
    /** Deployment-owned account generation, never supplied by an archive or
     * model. Pending work prevents takeover; rollback cannot re-enable writers. */
    async advanceWriter(owner: string) {
      const scope = scopeOf(owner), current = await read(owner);
      if (!registered(owner) || !current) throw Error("Memory authority unavailable");
      if (current.writer === writer) return current;
      if (current.writer > writer || current.pending) throw Error("Account writer is fenced by retained memory authority");
      return append(owner, { ...scope, type: "AikoMemoryAuthorityWriterAdvanced", key: `writer:${writer}`,
        writer: current.writer, nextWriter: writer, at: Date.now(), expectedRevision: current.revision });
    },
    /** Trusted host-only transition. The calling host must verify native and
     * remote evidence before constructing a terminal; never expose this as
     * arbitrary HTTP, model-tool or archive ingress. */
    async append(owner: string, event: MemoryAuthorityEvent) {
      const scope = scopeOf(owner);
      const terminal = event.type === "AikoMemoryAuthorityEraseCommitted" || event.type === "AikoMemoryAuthorityEraseAborted" || event.type === "AikoMemoryAuthorityRestoreSettled" || event.type === "AikoMemoryAuthorityWriteClosed";
      // A newer deployment may reconcile OLD committed work, but cannot admit
      // a new claim under an older generation. The native append guard still
      // requires the exact pending claim or exact historical terminal replay.
      if (!registered(owner) || event.owner !== owner || event.scope !== scope.scope ||
          event.writer !== writer && !(terminal && event.writer < writer))
        throw Error("Memory authority writer denied");
      if (event.type === "AikoMemoryAuthorityInitialized" || event.type === "AikoMemoryAuthorityWriterAdvanced")
        throw Error("Memory authority bootstrap or writer migration requires its trusted host path");
      return append(owner, event);
    },
    list: async () => storage.sql.exec<{ owner: string; created_at: number }>("SELECT owner,created_at FROM accounts ORDER BY owner").toArray(),
    close: host.close,
  };
}
