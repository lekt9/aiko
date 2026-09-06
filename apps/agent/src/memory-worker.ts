import { MemoryError, type Memory, type SourceRunner } from "entity-learn/cloudflare";

/** Worker memory always comes from the authenticated account's Durable Object. */
export function openHostMemory(_path: string, _scope: string, _adapters: Record<string, SourceRunner>): Memory {
  throw new MemoryError("storage_unavailable", "Worker memory requires an account-bound storage factory");
}
