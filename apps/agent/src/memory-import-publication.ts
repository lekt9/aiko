import { createHash } from "node:crypto";
import type { Memory, MemoryStorage } from "entity-learn/cloudflare";
import { sameMemoryAuthorityValue as same } from "./memory-authority.ts";
import type { MemoryPublicationReader } from "./memory-restore-authority.ts";
import { MEMORY_EXECUTION_TABLE } from "./memory-write-authority.ts";
import { guardedMemoryStorage } from "./memory-restore.ts";

/** Publication witness for /control/import's native threads + memory ONLY.
 * This cannot attest account KV, remote VM/browser state, a cancelled import,
 * or bytes outside the verified native account snapshot. Supply the same native
 * SQLite connection as the account host/memory journal and hold its owner gate.
 * No import or remote lifecycle execution occurs here. The optional local fence
 * closes only executor-control metadata after verifying the original import. */
export function nativeMemoryImportPublication(options: {
  memory: Memory;
  storage: MemoryStorage;
  owner: string;
  operationId: string;
  fingerprint: string;
  importId: string;
  archive: unknown;
  histories: unknown;
  /** Synchronous native account host exportHistory, never remote execution. */
  history(): unknown;
  /** Required when the host mounts all-write executor custody. Verifies this
   * native receipt and revokes that original execution in the same transaction. */
  withExecutionFence?: <T>(verify: () => T | undefined) => Promise<T | undefined>;
}): MemoryPublicationReader {
  const { memory, storage, owner, operationId, fingerprint, importId, history } = options;
  const archive = structuredClone(options.archive), histories = structuredClone(options.histories);
  if (memory.scope !== `aiko:${owner}`) throw Error("Foreign native import publication");
  if (guardedMemoryStorage(memory) !== storage) throw Error("Native import publication requires the same native connection");
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Must match native host importHistory's existing immutable receipt identity.
  const nativeDigest = sha([histories, sha(archive)]);
  return {
    async receipt(request) {
      if (request.owner !== owner || request.operationId !== operationId || request.fingerprint !== fingerprint)
        throw Error("Foreign or changed native import publication request");
      const verify = (closed: boolean) => memory.journal.read(() => {
        const row = storage.prepare("SELECT id,digest FROM aiko_history_import WHERE singleton=1").get();
        if (!row) return undefined;
        if (row.id !== importId || row.digest !== nativeDigest) throw Error("Native account import receipt conflict");
        if (closed && storage.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(MEMORY_EXECUTION_TABLE)) {
          const execution = storage.prepare(`SELECT token,receipt FROM ${MEMORY_EXECUTION_TABLE} WHERE scope=? AND key=?`).get(memory.scope, operationId);
          if (!execution || execution.token !== "" || !execution.receipt) throw Error("Native import executor is not durably fenced");
        }
        const checked = memory.checkArchiveErasure(archive);
        if (!same(checked.fence, request.fence) || !same(memory.exportArchive(), archive) || !same(history(), histories))
          throw Error("Native account import state does not match its original receipt");
        return { status: "published" as const, operationId, fingerprint, fence: structuredClone(checked.fence),
          reference: `native-account-import:${importId}`, digest: sha(["aiko.native-import-publication/v1", owner, importId, nativeDigest, checked.fence]) };
      });
      if (!options.withExecutionFence) return verify(true);
      const receipt = await options.withExecutionFence(() => verify(false));
      if (!receipt) return undefined;
      // Recheck closed custody and the exact native snapshot together. Omitting
      // or miswiring the fence callback cannot acknowledge an active executor.
      const confirmed = verify(true);
      if (!same(receipt, confirmed)) throw Error("Native import publication changed during fencing");
      return confirmed;
    },
  };
}
