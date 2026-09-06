import type { Event } from "tardie/core/event";
import type { GraphNode, GraphEdge } from "entity-learn/cloudflare";
import { ownedNetworkDefinitions } from "./capability-builder-network.ts";

export interface BrowserMemoryGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  coverage: "complete" | "partial";
  reasons: string[];
  verification: "recorded-structure-only";
  pointerAvailability: "not-checked";
}
const digest = (v: unknown): v is string => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);

/** Pure projection of a host-authorized, bounded log window. No VM allocation, embeddings, replay or stored response bodies. */
export function browserMemoryGraph(rows: readonly { seq: number; event: Event }[]): BrowserMemoryGraph {
  if (rows.length > 1024 || new TextEncoder().encode(JSON.stringify(rows)).length > 4 * 1024 * 1024) throw new Error("Browser graph window exceeds bound");
  const nodes = new Map<string, GraphNode>(), edges: GraphEdge[] = [], reasons = new Set<string>();
  const add = (node: GraphNode) => {
    if (nodes.has(node.id)) return true;
    if (nodes.size >= 128) { reasons.add("node_budget"); return false; }
    nodes.set(node.id, node); return true;
  };
  const edge = (from: string, to: string, relation: string) => {
    if (!nodes.has(from) || !nodes.has(to)) return;
    if (edges.length >= 384) { reasons.add("edge_budget"); return; }
    if (!edges.some(e => e.from === from && e.to === to && e.relation === relation)) edges.push({ from, to, relation });
  };
  const events = rows.map(row => row.event);
  const definitions = ownedNetworkDefinitions(events);
  if (events.some(e => e.type === "BrowserNetworkToolPrepared" && !definitions.some(d => d.toolDigest === e.toolDigest))) reasons.add("definition_evidence_outside_window_or_invalid");
  // Definition order is deterministic; latest prepared definitions get the bounded diagram space first.
  for (const prepared of definitions.slice().reverse()) {
    const d = prepared.definition, id = "browser-definition:" + prepared.toolDigest;
    if (!add({ id, kind: "request-definition", label: "Prepared request DAG", status: "prepared",
      details: { toolDigest: prepared.toolDigest, sourceTraceDigest: prepared.sourceTraceDigest,
        steps: d.steps.length, sessionRequired: d.sessionRequirements.length > 0, replayAuthorized: false } })) break;
    const stepIds = new Map<string, string>();
    for (const step of d.steps) {
      const evidence = d.evidence.find(e => e.stepId === step.id)!;
      // Hashes distinguish captures; repeated req-0001 from different browsing sessions must never collide.
      const request = "browser-request:" + JSON.stringify([prepared.threadId, prepared.sourceTraceDigest, evidence.requestId]);
      stepIds.set(step.id, request);
      if (add({ id: request, kind: "request", label: step.method + " · " + evidence.requestId.slice(0, 80), status: "observed",
        details: { method: step.method, requestId: evidence.requestId, traceThread: prepared.threadId, sourceTraceDigest: prepared.sourceTraceDigest, responseValuesStored: false } })) edge(id, request, "observed_request");
    }
    for (const step of d.steps) for (const prerequisite of step.dependsOn) {
      const from = stepIds.get(step.id), to = stepIds.get(prerequisite);
      if (from && to) edge(from, to, "depends_on");
    }
  }
  for (const { seq, event: e } of rows.slice().reverse()) {
    if (!["AikoRequestMemoryIndexed", "AikoRequestMemoryIndexUnavailable"].includes(e.type) || !digest(e.toolDigest)) continue;
    const indexed = e.type === "AikoRequestMemoryIndexed";
    if (indexed && (typeof e.pointerId !== "string" || !/^obs_[a-f0-9]{64}$/.test(e.pointerId) || typeof e.model !== "string" || e.model.length > 256)) { reasons.add("invalid_index_receipt"); continue; }
    const definition = "browser-definition:" + e.toolDigest;
    if (!nodes.has(definition)) {
      reasons.add("receipt_evidence_outside_window");
      add({ id: definition, kind: "request-definition", label: "Referenced request DAG", status: "evidence not in view", details: { toolDigest: e.toolDigest } });
    }
    const id = indexed ? "browser-pointer:" + e.pointerId : "browser-index-error:" + seq;
    if (add({ id, kind: indexed ? "request-pointer" : "index-error", label: indexed ? "Local pointer indexed" : "Index unavailable",
      status: indexed ? "receipt recorded" : "failure recorded",
      details: { eventSequence: seq, toolDigest: e.toolDigest, at: typeof e.at === "number" && Number.isFinite(e.at) ? e.at : null,
        ...(indexed ? { pointerId: String(e.pointerId), model: String(e.model), availability: "not checked; historical receipt" } : { outcome: "index or receipt delivery unavailable; inspect history" }) } })) edge(id, definition, indexed ? "index_receipt_for" : "index_failed_for");
  }
  const pending = rows.filter(row => row.event.type === "AikoBrowserLearningPending");
  if (pending.length) {
    add({ id: "browser-pending", kind: "index-error", label: "Requests need more evidence", status: "pending",
      details: { recordedPendingEvents: pending.length, currentPendingState: "not checked" } });
  }
  const result: BrowserMemoryGraph = { nodes: [...nodes.values()], edges, coverage: reasons.size ? "partial" : "complete", reasons: [...reasons],
    verification: "recorded-structure-only", pointerAvailability: "not-checked" };
  while (new TextEncoder().encode(JSON.stringify(result)).length > 131072 && result.nodes.length) {
    const removed = result.nodes.pop()!;
    result.edges = result.edges.filter(e => e.from !== removed.id && e.to !== removed.id);
    reasons.add("byte_budget"); result.reasons = [...reasons]; result.coverage = "partial";
  }
  return result;
}

/** Keep only native structural events; never recursively mine model messages/tool returns for authority. */
export function browserGraphEvent(event: Event): boolean {
  return ["NetworkFactObserved", "NetworkGraphCheckpointPrepared", "BrowserNetworkToolPrepared", "AikoRequestMemoryIndexed", "AikoRequestMemoryIndexUnavailable", "AikoBrowserLearningPending"].includes(event.type) || event.type.startsWith("Har");
}
