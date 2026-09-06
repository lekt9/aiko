import type { Memory } from "./memory-core.js";
import { byteLength as bytes, fail, number, object } from "./codec.js";
import type { MemoryHit } from "./types.js";

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  status: string;
  /** Display metadata only; never payloads, vectors, source recipes or execution arguments. */
  details: Record<string, string | number | boolean | null>;
}
export interface GraphEdge { from: string; to: string; relation: string }
export interface MemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nextAfter: string | null;
  scanned: number;
  sourceVersion: number;
  coverage: "complete" | "partial";
  reasons: string[];
  bytes: number;
  verification: "recorded-structure-only";
}
export interface GraphInput { after?: string; limit?: number }

/** Bounded, canonical evidence view. Links are not entailment or authority. Never executes a source/provider. */
export function memoryGraph(memory: Memory, input: GraphInput = {}): MemoryGraph {
  object(input, ["after", "limit"]);
  const limit = number(input.limit ?? 32, "limit", 1, 64);
  return memory.journal.read(() => {
    const page = memory.scan({ ...input, limit });
    const reasons = new Set(page.reasons);
    const nodes = new Map<string, GraphNode>();
    const edges: GraphEdge[] = [];
    const hits: MemoryHit[] = [];
    const clip = (value: string, bound = 160) => {
      if (value.length <= bound) return value;
      reasons.add("labels_shortened"); return value.slice(0, bound) + "…";
    };
    const addHit = (hit: MemoryHit) => {
      const o = hit.observation;
      if (nodes.has(o.id)) return true;
      if (nodes.size >= 128) { reasons.add("node_budget"); return false; }
      nodes.set(o.id, { id: o.id, kind: ["knowledge-source", "knowledge-page", "request-pointer"].includes(o.type) ? o.type : "observation",
        label: clip(o.title), status: hit.freshness === "stale" ? "stale" : hit.state,
        details: { subject: clip(o.subject, 256), type: clip(o.type), kind: o.kind, state: hit.state, freshness: hit.freshness,
          observedAt: o.observedAt, recordedAt: o.recordedAt, producerKind: o.producer.kind, producerReference: clip(o.producer.reference, 256),
          refreshError: !!hit.refreshError } });
      hits.push(hit); return true;
    };
    const edge = (from: string, to: string, relation: string) => {
      if (edges.length >= 384) { reasons.add("edge_budget"); return; }
      if (!edges.some(e => e.from === from && e.to === to && e.relation === relation)) edges.push({ from, to, relation: clip(relation, 80) });
    };
    for (const hit of page.items) addHit(hit);
    // Traverse only within the explicit node/edge bounds. Pinned historical evidence uses get(), never head substitution.
    for (let i = 0; i < hits.length; i++) {
      const o = hits[i]!.observation;
      for (const [relation, ids] of [["supports", o.supports], ["depends_on", o.dependsOn], ["supersedes", o.supersedes ? [o.supersedes] : []]] as const) {
        for (const id of ids) {
          if (edges.length >= 384) { reasons.add("edge_budget"); break; }
          if (!nodes.has(id) && nodes.size >= 128) { reasons.add("node_budget"); continue; }
          const target = memory.get(id);
          if (!target) { reasons.add("evidence_unavailable"); continue; }
          if (addHit(target)) edge(o.id, id, relation);
        }
      }
      for (const link of o.links) {
        if (edges.length >= 384 || nodes.size >= 128) { reasons.add("graph_budget"); break; }
        const head = memory.journal.head(memory.scope, link.subject);
        const target = head ? memory.get(head.id) : null;
        if (!target) { reasons.add("related_unavailable"); continue; }
        if (addHit(target)) edge(o.id, target.observation.id, "related:" + link.relation);
      }
      if (o.producer.sourceId) {
        const source = memory.journal.source(memory.scope, o.producer.sourceId);
        if (!source) { reasons.add("source_unavailable"); continue; }
        const id = "source:" + source.id;
        if (!nodes.has(id)) {
          if (nodes.size >= 128) { reasons.add("node_budget"); continue; }
          nodes.set(id, { id, kind: "source", label: clip(source.namespace),
            status: source.error ? "error" : !source.enabled ? "disabled" : !source.lastSuccess ? "unobserved" : source.coverage?.complete === false ? "partial" : "observed",
            details: { revision: source.revision, enabled: source.enabled, failures: source.failures, lastAttemptAt: source.lastAttemptAt } });
        }
        edge(o.id, id, o.producer.sourceRevision === source.revision ? "produced_by" : "prior_source_revision");
      }
    }
    const result: MemoryGraph = { nodes: [...nodes.values()], edges, nextAfter: page.nextAfter, scanned: page.scanned,
      sourceVersion: page.sourceVersion, coverage: "complete", reasons: [], bytes: 0, verification: "recorded-structure-only" };
    // Bound the actual serialized view, not just its node count. Removed endpoints never leave dangling edges.
    while (true) {
      result.reasons = [...reasons]; result.coverage = reasons.size ? "partial" : "complete";
      let size = bytes(result); while (size !== result.bytes) { result.bytes = size; size = bytes(result); }
      if (size <= 131072) return result;
      if (!result.nodes.length) return fail("graph_budget", "Graph metadata exceeds its byte bound");
      const removed = result.nodes.pop()!;
      result.edges = result.edges.filter(e => e.from !== removed.id && e.to !== removed.id);
      reasons.add("byte_budget");
    }
  });
}
