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
  for (const { event: e } of rows) {
    if (e.type === "AikoToolDefinitionRecorded" && digest(e.digest) && digest(e.schemaDigest)) {
      const id = `artifact:${e.digest}`, schema = `artifact:${e.schemaDigest}`;
      add({id,kind:"tool-definition",label:String(e.tool).slice(0,128),status:"recorded",details:{digest:e.digest}});
      add({id:schema,kind:"tool-schema",label:"Input schema",status:"recorded",details:{digest:e.schemaDigest}});
      edge(id,schema,"depends_on");
    }
    if (e.type === "AikoCodeWorkflowSaved" && digest(e.digest) && Array.isArray(e.dependencies)) {
      const id = `artifact:${e.digest}`;
      add({id,kind:"code-workflow",label:String(e.workflowId).slice(0,128),status:"verified run recorded",details:{digest:e.digest,execId:String(e.execId),availability:"recheck current tools"}});
      for (const d of e.dependencies.slice(0,32)) if (d && digest(d.digest)) {
        const child = `artifact:${d.digest}`;
        add({id:child,kind:"tool-schema",label:String(d.tool).slice(0,128),status:"referenced",details:{digest:d.digest}});
        edge(id,child,"depends_on");
      }
    }
    if(e.type==="AikoCodeDataRetained"&&digest(e.ref)) {
      const id=`artifact:${e.ref}`;
      add({id,kind:"working-data",label:"Retained working data",status:"private handle",details:{digest:e.ref,bytes:Number(e.bytes),availability:"recheck current source authority"}});
      if(Array.isArray(e.dependencies))for(const dependency of e.dependencies.slice(0,32))if(dependency&&digest(dependency.digest)) {
        const source=`artifact:${dependency.digest}`;
        add({id:source,kind:"tool-definition",label:String(dependency.tool).slice(0,128),status:"referenced",details:{digest:dependency.digest}});
        edge(id,source,"derived_from");
      }
    }
    if (e.type === "AikoNetworkRequestSettled" && digest(e.requestDigest) && digest(e.definitionDigest)) {
      const id = `artifact:${e.requestDigest}`, parent = `artifact:${e.definitionDigest}`;
      add({id:parent,kind:"request-definition",label:"Request DAG",status:"referenced",details:{digest:e.definitionDigest}});
      add({id,kind:"request",label:String(e.method).slice(0,10),status:"checked",details:{checkedAt:Number(e.at),status:Number(e.status),changed:e.changed===true}});
      edge(id,parent,"executed_from");
    }
  }
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
  return ["AikoToolDefinitionRecorded", "AikoCodeWorkflowSaved", "AikoCodeDataRetained", "AikoNetworkRequestSettled", "NetworkFactObserved", "NetworkGraphCheckpointPrepared", "BrowserNetworkToolPrepared", "AikoRequestMemoryIndexed", "AikoRequestMemoryIndexUnavailable", "AikoBrowserLearningPending"].includes(event.type) || event.type.startsWith("Har");
}
