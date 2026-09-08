import { createHash } from "node:crypto";
import type { Memory, MemoryStorage } from "entity-learn/cloudflare";
import { sameMemoryAuthorityValue as same } from "./memory-authority.ts";
import type { MemoryPublicationReader } from "./memory-restore-authority.ts";

/** Read-only publication witness for /control/import's native threads + memory
 * transaction ONLY. This cannot attest account KV, remote VM/browser state, a
 * cancelled import, or bytes outside the verified native account snapshot.
 * Supply the same native SQLite connection as the account host/memory journal,
 * and hold its owner gate. No write, import or lifecycle execution occurs here. */
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
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  // Must match native host importHistory's existing immutable receipt identity.
  const nativeDigest = sha([histories, sha(archive)]);
  return {
    async receipt(request) {
      if (request.owner !== owner || request.operationId !== operationId || request.fingerprint !== fingerprint)
        throw Error("Foreign or changed native import publication request");
      const verify = () => memory.journal.read(() => {
        const row = storage.prepare("SELECT id,digest FROM aiko_history_import WHERE singleton=1").get();
        if (!row) return undefined;
        if (row.id !== importId || row.digest !== nativeDigest) throw Error("Native account import receipt conflict");
        const checked = memory.checkArchiveErasure(archive);
        if (!same(checked.fence, request.fence) || !same(memory.exportArchive(), archive) || !same(history(), histories))
          throw Error("Native account import state does not match its original receipt");
        return { status: "published" as const, operationId, fingerprint, fence: structuredClone(checked.fence),
          reference: `native-account-import:${importId}`, digest: sha(["aiko.native-import-publication/v1", owner, importId, nativeDigest, checked.fence]) };
      });
      return options.withExecutionFence ? options.withExecutionFence(verify) : verify();
    },
  };
}
