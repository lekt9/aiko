import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openMemoryAuthorityRegistry } from "../src/memory-authority-node.ts";
import { memoryRestoreGate } from "../src/memory-restore.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { memoryObservationDependency } from "../src/retained-result-dependencies.ts";
import type { MemoryBinding } from "../src/memory.ts";

/** Explicit synthetic authority for native tool fixtures. Nothing is opened by
 * constructing the tool surface. Real private SQLite + the existing registry and
 * copy store are used when erasure is actually requested; no safety bypass. */
export function memoryTestAuthority(directory: string) {
  let registry: ReturnType<typeof openMemoryAuthorityRegistry> | undefined;
  let copies: Database | undefined;
  const gates = new Map<string, ReturnType<typeof memoryRestoreGate>>();
  return {
    binding(owner: string): Pick<MemoryBinding, "erasureAuthority" | "withErasure" | "eraseCopies"> {
      let gate = gates.get(owner);
      if (!gate) gates.set(owner, gate = memoryRestoreGate());
      return {
        withErasure: gate,
        erasureAuthority: async () => {
          const control = await (registry ??= openMemoryAuthorityRegistry(join(directory, "independent-control/authority.sqlite"), 1));
          await control.admit(owner);
          return control.binding(owner);
        },
        eraseCopies: (observations, operationId) => {
          const blobs = harnessBlobStore(sqliteWorkflowKV(copies ??= new Database(join(directory, "synthetic-copies.sqlite"))));
          return blobs.eraseDependencies!(owner, observations.map(memoryObservationDependency), operationId);
        },
      };
    },
    async close() { await (await registry)?.close(); copies?.close(); },
  };
}
