import type { Memory } from "./memory-core.js";
import { digest, fail, safePayload, text } from "./codec.js";
import { contractEvidence, normalizeSource } from "./sources.js";
import type { Source } from "./types.js";

/** Copies a digest-checked Contract observation. Does not claim signature or policy verification. */
export function importContract(memory: Memory, value: unknown): { imported: string[] } {
  const evidence = contractEvidence(value);
  if (evidence.length === 0) fail("invalid_evidence", "No supported Contract evidence settlement found");
  const imported = evidence.map(item => memory.remember({ subject: `contract/settlement/${item.settlementDigest}`,
    title: `Contract evidence ${item.evidenceDigest.slice(0, 12)}`, type: "contract_evidence", kind: "episode", payload: item.data,
  }, { key: `contract-import:${item.settlementDigest}`, producer: { kind: "contract", reference: item.reference } }).id);
  return { imported };
}

/** Explicit, cache-only migration. Never stores or executes legacy command strings. */
export function importLegacy(memory: Memory, value: unknown): { imported: string[]; skipped: number } {
  if (!value || typeof value !== "object") fail("invalid_input", "Expected a v1 pointer store");
  const store = value as Record<string, unknown>;
  if (store.version !== 1 || !Array.isArray(store.pointers) || !store.cache || typeof store.cache !== "object") fail("invalid_input", "Expected a v1 pointer store");
  const cache = store.cache as Record<string, { data: unknown; fetched_at: string }>;
  const imported: string[] = []; let skipped = 0;
  for (const entry of store.pointers as Record<string, unknown>[]) {
    const id = text(entry.id, "pointer id", 160); const cached = Object.hasOwn(cache, id) ? cache[id] : undefined;
    if (!cached) { skipped++; continue; }
    const observedAt = Date.parse(cached.fetched_at);
    if (!Number.isFinite(observedAt) || observedAt > memory.now()) fail("invalid_input", "Legacy cache has an invalid timestamp");
    const source: Source = { id, namespace: `legacy/${encodeURIComponent(id)}`, type: text(entry.entity_type, "entity_type", 80),
      resolver: "adapter", locator: "legacy-disabled", format: "json", ttlSeconds: 0,
      schema: { ...(typeof entry.id_field === "string" ? { id: entry.id_field } : {}), ...(typeof entry.title_field === "string" ? { title: entry.title_field } : {}) },
      revision: "legacy", enabled: false, lastSuccess: null, lastAttemptAt: null, error: null, failures: 0 };
    const data = safePayload(cached.data);
    // In keyed maps, the map key—not the object's position or content hash—is the identity.
    const items = entry.result_shape === "object_of_objects" && data && typeof data === "object" && !Array.isArray(data)
      ? Object.entries(data).flatMap(([key, payload]) => normalizeSource({ ...source, schema: { title: source.schema?.title } }, [payload]).map(item => ({
        ...item, subject: `${source.namespace}/${encodeURIComponent(source.type)}/${encodeURIComponent(key)}`,
      }))) : normalizeSource(source, data);
    for (const item of items) {
      const record = { ...item, observedAt, ttlSeconds: 0 };
      const key = `legacy:${digest("entity-learn.legacy/v1", { id, record })}`;
      const o = memory.remember(record, { key, producer: { kind: "legacy", reference: `legacy-pointer:${id}` } });
      imported.push(o.id);
    }
  }
  return { imported, skipped };
}
