import { createHash } from "node:crypto";
import { Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { Router } from "tardie/core/communication/router";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { childCreated, childLineageOf, threadCreatedOf } from "tardie/core/thread";
import type { Event } from "tardie/core/event";

/**
 * Integration: mount executionGraphComponent on a dedicated graph thread and
 * executionGraphWorker on executionGraphChildThread(parent, attempt) children.
 * Compose executionGraphEventKey and executionGraphAppendAllowed into the host.
 * Authorize configure/invalidate/cancel commands before appending their events;
 * reject internal graph events from public ingress using ExternalEventAllowed.
 * Only trusted native Router delivery may append Work/Returned, and only the
 * native checker effect may append Checked. Inspector uses executionGraphView.
 *
 * Contracts are immutable per thread. A new contract/check version needs a new
 * graph thread; invalidation retries the existing contract and its descendants.
 * Delivery/execution is at-least-once: executors must deduplicate by attempt in
 * their parent-thread scope. Cancellation fences progress, not already-started
 * child side effects. This module never creates a driver, timer or provider.
 */
export interface GraphNode {
  id: string;
  dependsOn: string[];
  reads: string[];
  writes: string[];
  outputs: string[];
  check: { id: string; version: string };
  task: string;
}
export interface ExecutionGraph { id: string; version: string; nodes: GraphNode[] }
export interface EvidenceReceipt {
  schemaVersion: 1;
  graphVersion: string;
  contractDigest: string;
  node: string;
  attempt: string;
  check: GraphNode["check"];
  passed: boolean;
  evidence: string[];
}
type NodeState = { generation: number; status: "pending" | "dispatched" | "returned" | "passed" | "failed"; receipt?: EvidenceReceipt };
export interface GraphState { graph?: ExecutionGraph; cancelled: boolean; nodes: Record<string, NodeState> }
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const identity = (x: unknown): x is string => typeof x === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:/-]{0,127}$/.test(x);
const ordered = (xs: string[]) => [...xs].sort();
const overlaps = (a: string, b: string) => a === b || a.startsWith(b.replace(/\/$/, "") + "/") || b.startsWith(a.replace(/\/$/, "") + "/");

/** Resource identities are opaque, case-sensitive names; slash descendants overlap. */
export function validateExecutionGraph(raw: unknown): asserts raw is ExecutionGraph {
  const g = raw as ExecutionGraph;
  if (!g || !identity(g.id) || !identity(g.version) || !Array.isArray(g.nodes) || !g.nodes.length || g.nodes.length > 128) throw new Error("Invalid graph");
  const ids = new Set<string>();
  for (const n of g.nodes) {
    if (!n || !identity(n.id) || ids.has(n.id) || typeof n.task !== "string" || !n.task.trim() || n.task.length > 8000 || !identity(n.check?.id) || !identity(n.check?.version)) throw new Error("Invalid node identity/task/check");
    ids.add(n.id);
    for (const field of [n.dependsOn, n.reads, n.writes, n.outputs]) if (!Array.isArray(field) || field.length > 128 || field.some(x => !identity(x) || x.split("/").some(p => p === "." || p === "..")) || new Set(field).size !== field.length) throw new Error("Invalid resource/dependency declaration");
  }
  const ancestors = new Map<string, Set<string>>();
  function visit(id: string, active = new Set<string>()): Set<string> {
    if (active.has(id)) throw new Error("Dependency cycle");
    if (ancestors.has(id)) return ancestors.get(id)!;
    const n = g.nodes.find(n => n.id === id);
    if (!n) throw new Error("Missing dependency");
    const next = new Set(active).add(id), result = new Set<string>();
    for (const dep of n.dependsOn) { result.add(dep); for (const a of visit(dep, next)) result.add(a); }
    ancestors.set(id, result); return result;
  }
  for (const n of g.nodes) visit(n.id);
  for (const a of g.nodes) for (const b of g.nodes) {
    if (a.id === b.id) continue;
    const before = ancestors.get(b.id)!.has(a.id), after = ancestors.get(a.id)!.has(b.id);
    if (!before && !after && [...a.writes, ...a.outputs].some(w => [...b.writes, ...b.outputs].some(v => overlaps(w, v)))) throw new Error("Conflicting writes require an ordering edge");
    if (!before && !after && a.writes.some(w => b.reads.some(r => overlaps(w, r)))) throw new Error("Missing read/write dependency edge");
    if (a.outputs.some(o => b.reads.some(r => overlaps(o, r))) && !before) throw new Error("Missing output dependency edge");
  }
}
export function executionGraphDigest(g: ExecutionGraph) {
  validateExecutionGraph(g);
  return digest({ id: g.id, version: g.version, nodes: [...g.nodes].sort((a,b) => a.id.localeCompare(b.id)).map(n => ({ id: n.id, task: n.task, dependsOn: ordered(n.dependsOn), reads: ordered(n.reads), writes: ordered(n.writes), outputs: ordered(n.outputs), check: { id: n.check.id, version: n.check.version } })) });
}
const prefix = "execution-graph:";
const kinds = new Set(["ExecutionGraphConfigured", "ExecutionGraphInvalidated", "ExecutionGraphCancelled", "ExecutionGraphDispatched", "ExecutionGraphReturned", "ExecutionGraphChecked", "ExecutionGraphWork", "ExecutionGraphWorkSent"]);
export const executionGraphEventKey = (e: Event) => kinds.has(e.type) && typeof e.id === "string" ? `${prefix}${e.type}:${e.id}` : undefined;
export const executionGraphAttempt = (s: GraphState, node: string) => digest([executionGraphDigest(s.graph!), node, s.nodes[node]!.generation]);
export const executionGraphChildThread = (parentThread: string, attempt: string) => `execution-${digest([parentThread, attempt])}`;
const initial = (): GraphState => ({ cancelled: false, nodes: Object.create(null) });
function step(s: GraphState, e: Event): GraphState {
  if (e.type === "ExecutionGraphConfigured") {
    validateExecutionGraph(e.graph);
    // Graph IDs/versions are immutable within a thread; use invalidation to retry.
    if (s.graph) return s;
    return { graph: structuredClone(e.graph), cancelled: false, nodes: Object.fromEntries(e.graph.nodes.map(n => [n.id, { generation: 0, status: "pending" as const }])) };
  }
  if (!s.graph || e.graph !== s.graph.id) return s;
  if (e.type === "ExecutionGraphCancelled") return { ...s, cancelled: true };
  if (s.cancelled) return s;
  if (e.type === "ExecutionGraphInvalidated" && typeof e.node === "string" && Object.hasOwn(s.nodes, e.node)) {
    const affected = new Set([e.node]);
    let size = 0;
    while (size !== affected.size) { size = affected.size; for (const n of s.graph.nodes) if (n.dependsOn.some(d => affected.has(d))) affected.add(n.id); }
    const nodes = { ...s.nodes };
    for (const id of affected) nodes[id] = { generation: nodes[id]!.generation + 1, status: "pending" };
    return { ...s, nodes };
  }
  if (typeof e.node !== "string" || !Object.hasOwn(s.nodes, e.node) || e.attempt !== executionGraphAttempt(s, e.node)) return s;
  const prior = s.nodes[e.node]!, node = s.graph.nodes.find(n => n.id === e.node)!;
  let next = prior;
  if (e.type === "ExecutionGraphDispatched" && prior.status === "pending") next = { ...prior, status: "dispatched" };
  if (e.type === "ExecutionGraphReturned" && ["pending", "dispatched"].includes(prior.status) && node.dependsOn.every(d => s.nodes[d]?.status === "passed")) next = { ...prior, status: "returned" };
  if (e.type === "ExecutionGraphChecked" && prior.status === "returned") {
    const r = e.receipt as EvidenceReceipt;
    if (r?.schemaVersion === 1 && r.graphVersion === s.graph.version && r.contractDigest === executionGraphDigest(s.graph) && r.node === node.id && r.attempt === e.attempt && r.check?.id === node.check.id && r.check.version === node.check.version && typeof r.passed === "boolean" && Array.isArray(r.evidence) && r.evidence.length > 0 && r.evidence.every(v => typeof v === "string" && v.length > 0)) next = { ...prior, status: r.passed ? "passed" : "failed", receipt: structuredClone(r) };
  }
  return next === prior ? s : { ...s, nodes: { ...s.nodes, [node.id]: next } };
}
export function executionGraphState(events: readonly Event[]) { return events.reduce(step, initial()); }
export function executionGraphReady(s: GraphState): string[] {
  return !s.graph || s.cancelled ? [] : s.graph.nodes.filter(n => s.nodes[n.id]?.status === "pending" && n.dependsOn.every(d => s.nodes[d]?.status === "passed")).map(n => n.id).sort();
}
export function executionGraphView(events: readonly Event[]) {
  const s = executionGraphState(events);
  return { ...s, ready: executionGraphReady(s), complete: !!s.graph && !s.cancelled && Object.values(s.nodes).every(n => n.status === "passed") };
}
export function configureExecutionGraph(graph: ExecutionGraph): Event {
  return { type: "ExecutionGraphConfigured", id: executionGraphDigest(graph), graph: structuredClone(graph) };
}
export function invalidateExecutionGraph(graph: string, node: string, requestId: string): Event {
  return { type: "ExecutionGraphInvalidated", id: requestId, graph, node };
}
export function cancelExecutionGraph(graph: string, requestId: string): Event {
  return { type: "ExecutionGraphCancelled", id: requestId, graph };
}
/** Install on trusted ingress: check receipts are exclusively native effect output, never tool/model input. */
export function executionGraphExternalEventAllowed(e: Event) { return !kinds.has(e.type); }
/** Compose into host canAppend to fence async checks against cancellation/invalidation. */
export function executionGraphAppendAllowed(events: readonly Event[], read: () => readonly Event[]) {
  const s = executionGraphState(read());
  return events.every(e => !["ExecutionGraphChecked", "ExecutionGraphDispatched"].includes(e.type) || (!!s.graph && !s.cancelled && e.graph === s.graph.id && typeof e.node === "string" && Object.hasOwn(s.nodes, e.node) && e.attempt === executionGraphAttempt(s, e.node)));
}
export interface ExecutionGraphHostAdapter {
  /** Host code must run an independently registered check; never interpret model 'passed' output. */
  check(input: { graph: ExecutionGraph; node: GraphNode; attempt: string }, signal: AbortSignal): Promise<{ passed: boolean; evidence: string[] }>;
}
/** One graph per native thread. Host Router owns delivery, storage and recovery. */
export function executionGraphComponent(adapter: ExecutionGraphHostAdapter) {
  return component({ name: "execution-graph", keys: { prefixes: [prefix], keyOf: executionGraphEventKey }, initial, step,
    output: s => ({ view: s, transitions: !s.graph || s.cancelled ? [] : [...executionGraphReady(s), ...Object.keys(s.nodes).filter(n => s.nodes[n]?.status === "returned").sort()].map(id => {
      const graph = s.graph!, node = graph.nodes.find(n => n.id === id)!, attempt = executionGraphAttempt(s, id), checking = s.nodes[id]!.status === "returned";
      const type = checking ? "ExecutionGraphChecked" : "ExecutionGraphDispatched";
      return effect({ key: `${prefix}${type}:${attempt}`, input: { graph, node, attempt },
        interrupts: (_, e) => e.graph === graph.id && ["ExecutionGraphCancelled", "ExecutionGraphInvalidated"].includes(e.type),
        act: input => Effect.gen(function* () {
          const log = yield* EventLog, self = yield* Self;
          const history = yield* log.read;
          if (!executionGraphAppendAllowed([{ type, id: attempt, graph: graph.id, node: id, attempt }], () => history)) return [];
          if (checking) {
            const result = yield* Effect.tryPromise({ try: signal => adapter.check(structuredClone(input), signal), catch: () => new Error("Host check failed") }).pipe(Effect.catch(() => Effect.succeed({ passed: false, evidence: ["host-check-error"] })));
            const receipt: EvidenceReceipt = { schemaVersion: 1, graphVersion: graph.version, contractDigest: executionGraphDigest(graph), node: id, attempt, check: node.check, passed: result.passed === true && result.evidence.length > 0, evidence: result.evidence.length ? result.evidence : ["missing-evidence"] };
            return [{ type, id: attempt, graph: graph.id, node: id, attempt, receipt }];
          }
          const router = yield* Router, created = threadCreatedOf(yield* log.read);
          if (!created) throw new Error("Execution graph requires native ThreadCreated");
          const target = { ...self, thread: executionGraphChildThread(self.thread, attempt) }, lineage = childLineageOf(created, "colocated");
          yield* log.append([childCreated(`execution:${attempt}`, target, lineage, Date.now())]);
          yield* router.send(envelopeOf(linkOf(self, target), { type: "ExecutionGraphWork", id: attempt, at: Date.now(), graph: graph.id, node: id, attempt, contract: node }, lineage));
          return [{ type, id: attempt, graph: graph.id, node: id, attempt }];
        }) });
    }) }) });
}
/** Optional native worker for host-owned jobs. Executors must deduplicate by attempt. */
export function executionGraphWorker(execute: (node: GraphNode, attempt: string, signal: AbortSignal) => Promise<void>) {
  return component({ name: "execution-graph-worker", keys: { prefixes: [prefix], keyOf: executionGraphEventKey },
    initial: () => ({ work: undefined as Event | undefined, sent: false }),
    step: (s, e) => e.type === "ExecutionGraphWork" ? { ...s, work: s.work ?? e } : e.type === "ExecutionGraphWorkSent" ? { ...s, sent: true } : s,
    output: s => ({ view: undefined, transitions: !s.work || s.sent ? [] : [effect({ key: `${prefix}ExecutionGraphWorkSent:${s.work.id}`, input: s.work,
      act: work => Effect.gen(function* () {
        yield* Effect.tryPromise({ try: signal => execute(work.contract as GraphNode, String(work.attempt), signal), catch: () => new Error("Graph worker failed") }).pipe(Effect.orDie);
        const log = yield* EventLog, self = yield* Self, router = yield* Router;
        const parent = threadCreatedOf(yield* log.read)?.parent;
        if (!parent) throw new Error("Execution worker requires a native parent");
        yield* router.send(envelopeOf(linkOf(self, parent), { type: "ExecutionGraphReturned", id: work.attempt, graph: work.graph, node: work.node, attempt: work.attempt }));
        return [{ type: "ExecutionGraphWorkSent", id: work.attempt }];
      }) })] }) });
}
