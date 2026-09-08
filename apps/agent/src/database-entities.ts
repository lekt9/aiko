import { createHash } from "node:crypto";
import { MemoryError, type Memory, type MemoryHit, type Observation, type RememberInput, type Producer } from "entity-learn";
import { canonical, DataError, label, type QueryDependency } from "../../../packages/structured-data/src/index.ts";
import { openMemory, type MemoryStoreBinding } from "./memory.ts";
import type { DatabaseSource } from "./database-refresh.ts";

export interface EntityReference { subject?: string; observationId?: string }
type Evidence = Extract<NonNullable<QueryDependency["source"]>, { kind: "entity" }>;
export interface DatabaseEntities {
  resolve(reference: EntityReference, signal: AbortSignal): Promise<DatabaseSource>;
  authorize(evidence: Evidence): void;
  state(evidence: Evidence): "fresh" | "stale" | "changed";
  head(subject: string): MemoryHit | null;
  get(observationId: string): MemoryHit;
  remember(input: RememberInput, key: string, producer: Producer): Observation;
  receipt(key: string): { observationId: string; subject: string } | undefined;
}

/** Exact entity-learn reads. This adapter has no source runners, embedding egress,
 * inferred identity matching, or separate memory store. */
export function databaseEntities(binding: MemoryStoreBinding): DatabaseEntities {
  const use = <T>(run: (memory: Memory) => T): T => {
    const memory = openMemory(binding);
    try { return run(memory); } finally { memory.close(); }
  };
  const admitted = (memory: Memory, id: string, subject?: string): MemoryHit => {
    let hit: MemoryHit | null;
    try { hit = memory.get(id); } catch { throw new DataError("forbidden", "Entity evidence unavailable"); }
    if (!hit || subject !== undefined && hit.observation.subject !== subject) throw new DataError("forbidden", "Entity evidence unavailable");
    // get() enforces suppression through supports/dependsOn. Source approval
    // and revision are an additional database serving boundary, including snapshots.
    const queue = [hit.observation], seen = new Set<string>();
    while (queue.length) {
      const observation = queue.pop()!;
      if (seen.has(observation.id)) continue;
      seen.add(observation.id);
      if (seen.size > 256) throw new DataError("limit", "Entity evidence budget exceeded");
      if (observation.producer.sourceId) {
        const source = memory.journal.source(memory.scope, observation.producer.sourceId);
        if (!source?.enabled || source.revision !== observation.producer.sourceRevision) throw new DataError("forbidden", "Entity source authority changed");
      }
      for (const reference of [...observation.supports, ...observation.dependsOn]) {
        const dependency = memory.get(reference);
        if (!dependency) throw new DataError("forbidden", "Entity supporting evidence unavailable");
        queue.push(dependency.observation);
      }
    }
    return hit;
  };
  const read = (memory: Memory, reference: EntityReference): MemoryHit => {
    if (reference.subject !== undefined) label(reference.subject);
    const head = reference.subject ? memory.journal.head(memory.scope, reference.subject) : undefined;
    if (head?.forgotten) throw new DataError("forbidden", "Entity subject is forgotten");
    const id = reference.observationId ?? head?.id;
    if (!id) throw new DataError("unavailable", "Entity observation has not been recorded");
    const hit = admitted(memory, id, reference.subject);
    if (!reference.observationId && hit.state !== "current") throw new DataError("unavailable", "Entity is no longer current in its source");
    return hit;
  };
  const authorize = (evidence: Evidence) => use(memory => {
    if (evidence.observationId) { admitted(memory, evidence.observationId, evidence.subject); return; }
    if (evidence.subject && memory.journal.head(memory.scope, evidence.subject)?.forgotten) throw new DataError("forbidden", "Entity subject is forgotten");
  });
  return {
    authorize,
    get: observationId => use(memory => admitted(memory, observationId)),
    head: subject => use(memory => {
      label(subject); const head = memory.journal.head(memory.scope, subject);
      if (head?.forgotten) throw new DataError("forbidden", "Entity subject is forgotten");
      return head ? admitted(memory, head.id, subject) : null;
    }),
    remember: (input, key, producer) => use(memory => {
      for (const id of [...(input.supports ?? []), ...(input.dependsOn ?? [])]) admitted(memory, id);
      try { return memory.remember(input, { key, producer }); }
      catch (error) {
        if (error instanceof MemoryError) throw new DataError(["head_conflict", "idempotency_conflict"].includes(error.code) ? "conflict" : ["forgotten", "erased", "evidence_unavailable"].includes(error.code) ? "forbidden" : "invalid", "Memory publication could not be committed");
        throw error;
      }
    }),
    receipt: key => use(memory => {
      const receipt = memory.journal.receipt(memory.scope, key);
      const observation = receipt?.event.operation === "remember" ? receipt.event.observations[0] : undefined;
      return observation ? { observationId: observation.id, subject: observation.subject } : undefined;
    }),
    state: evidence => use(memory => {
      if (!evidence.observationId) return "fresh";
      const hit = admitted(memory, evidence.observationId, evidence.subject);
      if (evidence.followHead && hit.state !== "current") return "changed";
      return hit.freshness === "stale" || hit.state !== "current" ? "stale" : "fresh";
    }),
    resolve: async (reference, signal) => {
      signal.throwIfAborted();
      const initial = use(memory => read(memory, reference));
      const generation = initial.observation.id;
      const digest = `entity:${createHash("sha256").update(canonical(reference)).digest("hex")}`;
      return {
        digest, generation, inputs: [], stepIds: ["entity"],
        observation: { observedAt: initial.observation.observedAt, freshness: initial.freshness === "stale" || initial.state !== "current" ? "stale" : "fresh" },
        execute: async (_inputs, consume, signal, budget) => {
          signal.throwIfAborted();
          const current = use(memory => read(memory, reference));
          if (current.observation.id !== generation) throw new DataError("conflict", "Entity observation changed during evaluation");
          const bytes = new TextEncoder().encode(canonical(current.observation.payload)).length;
          if (bytes > budget.maxBytes) throw new DataError("limit", "Entity response exceeds byte budget");
          consume("entity", current.observation.payload);
          signal.throwIfAborted();
          return { calls: 0, bytes };
        },
      };
    },
  };
}
