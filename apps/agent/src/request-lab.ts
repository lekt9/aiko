import type { MemoryStorage, MemoryHit } from "entity-learn/cloudflare";
import type { Event } from "tardie/core/event";
import type { HarnessJsonValue } from "@unbrowse/browser-harness/harness-runtime";
import { BrowserLearning } from "./browser-learning.ts";
import { ownedNetworkDefinitions } from "./capability-builder-network.ts";
import { RequestMemory } from "./request-memory.ts";
import { ToolWorkflows, type WorkflowDefinition, type WorkflowReceipt } from "./tool-workflows.ts";
import { createWorkflowStore, type WorkflowKV } from "./workflow-host.ts";

export const REQUEST_LAB_SCENARIOS = ["baseline", "unchanged", "changed", "missing_dependency"] as const;
export type RequestLabScenario = typeof REQUEST_LAB_SCENARIOS[number];
type Freshness = MemoryHit["freshness"];
export interface RequestLabReport {
  version: 1; id: string; scenario: RequestLabScenario; mode: "controlled-fixture";
  startedAt: number; elapsedMs: number; status: "passed" | "failed"; summary: string;
  checks: { id: string; label: string; passed: boolean; detail: string }[];
  capture: { requests: number; events: number; prepared: number; toolDigest: string; sourceTraceDigest: string };
  pointer: { id: string; cacheReused: boolean; embeddingModel: string; embeddingCalls: number };
  replays: {
    phase: "baseline" | "comparison"; status: string; code: string; changed: boolean | null;
    observationId?: string; responseDigest?: string; durationMs: number;
    result?: { caption: string; queued: number };
    requests: { stepId: string; method: string; url: string; status: number; durationMs: number }[];
  }[];
  workflow: {
    id: string; digest: string; reusable: boolean; source: "fixed-example"; idempotentReuse: boolean;
    runs: { phase: "baseline" | "comparison"; runId: string; status: WorkflowReceipt["status"]; calls: number; steps: WorkflowReceipt["steps"] }[];
  };
  derived: { id: string; before: Freshness; after: Freshness; recomputedId?: string; final: Freshness };
  nodes: { id: string; label: string; kind: string; state: string }[];
  edges: { from: string; to: string; relation: string }[];
  evidence: { source: "fixture-component-events"; events: Event[] };
  limits: { realNetwork: false; realBrowser: false; realModel: false; nativeActorRun: false; notes: string[] };
}

/** Uses the caller's disposable SQLite connection; never a live account database. */
function workflowKV(storage: MemoryStorage): WorkflowKV {
  storage.exec("CREATE TABLE IF NOT EXISTS request_lab_workflows (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const get = (key: string): unknown => {
    const row = storage.prepare("SELECT value FROM request_lab_workflows WHERE key=?").get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  };
  const put = (key: string, value: unknown) => storage.prepare("INSERT INTO request_lab_workflows(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value));
  return {
    get: async key => get(key), put: async (key, value) => put(key, value),
    list: async prefix => storage.prepare("SELECT value FROM request_lab_workflows WHERE substr(key,1,?)=? ORDER BY key").all(prefix.length, prefix).map(row => JSON.parse(String(row.value))),
    claim: async (key, value) => storage.transaction(() => {
      if (get(key) !== undefined) return false;
      put(key, value); return true;
    }),
    update: async (key, change) => storage.transaction(() => put(key, change(get(key)))),
  };
}

/** Real compiler, pointer store, request executor and entity-learn; explicitly synthetic I/O.
 * The caller must supply fresh disposable storage and close it in finally. No storage is closed here.
 */
export async function runRequestLab(options: { scenario: RequestLabScenario; storage: MemoryStorage; signal?: AbortSignal }): Promise<RequestLabReport> {
  if (!REQUEST_LAB_SCENARIOS.includes(options.scenario)) throw new Error("Unknown request lab scenario");
  options.signal?.throwIfAborted();
  if (options.storage.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get())
    throw new Error("Request lab requires fresh disposable storage; account or reused databases are not accepted");
  const startedAt = Date.now(), start = performance.now();
  const id = `request-lab-${crypto.randomUUID()}`, owner = id;
  const events: Event[] = [], checks: RequestLabReport["checks"] = [], replays: RequestLabReport["replays"] = [];
  let sequence = 0, embeddingCalls = 0;
  const responseShapes = new Map<string, Record<string, unknown>>();
  const learning = new BrowserLearning({
    threadId: id, nextSequence: () => ++sequence, emit: async event => { events.push(event); },
    onPrepared: async (event, responses) => { responseShapes.set(event.toolDigest, responses); },
  });
  const entry = (url: string, body: unknown, index: number) => {
    const text = JSON.stringify(body);
    return { startedDateTime: new Date(1000 + index * 100).toISOString(), time: 20, _observationComplete: true,
      request: { method: "GET", url, headers: [], cookies: [] },
      response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: text.length, text } } };
  };
  const capturedItem = "captured-fixture-item";
  const entries = [entry("https://api.example.com/items", { item: capturedItem }, 0),
    entry(`https://api.example.com/details?item=${capturedItem}`, { caption: "captured-fixture-caption", queued: 2 }, 1)];
  for (let i = 0; i < entries.length; i++) { options.signal?.throwIfAborted(); await learning.observe(entries[i]!, i, true); }
  const compiled = await learning.compile(entries, [{ callId: "fixture-navigation", action: "navigate", startedAtMs: 999, endedAtMs: 1250, direct: true, resultObserved: true }], "https://api.example.com");
  const selected = ownedNetworkDefinitions(events).sort((a, b) => b.definition.steps.length - a.definition.steps.length)[0];
  if (!selected || selected.definition.steps.length !== 2) throw new Error("Fixture did not compile its expected two-request dependency");
  const captureEvents = events.length;
  const input = Object.fromEntries(selected.definition.inputs.map(item => [item.name, item.name.includes("0001") ? "items" : "details"]));
  let phase: "baseline" | "comparison" = "baseline";
  let activeRequests: RequestLabReport["replays"][number]["requests"] = [];
  let replayBody: { caption: string; queued: number } | undefined;
  const memory = new RequestMemory({
    owner, storage: options.storage, readOwnedEvents: async () => events,
    embedding: { model: "fixture-deterministic-embedding-v1", dimensions: 3, embed: async texts => { options.signal?.throwIfAborted(); embeddingCalls++; return texts.map(() => [1, 0, 0]); } },
    record: async event => { events.push(event); },
    consume: async ({ body }) => {
      const value = body as Record<string, HarnessJsonValue> | undefined;
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.caption === "string" && typeof value.queued === "number")
        replayBody = { caption: value.caption, queued: value.queued };
    },
    transport: { send: async request => {
      options.signal?.throwIfAborted();
      const requestStart = performance.now(), url = new URL(request.url);
      // A closed fixture transport: this function never calls fetch, sockets or a browser.
      if (url.origin !== "https://api.example.com" || request.method !== "GET" || !["/items", "/details"].includes(url.pathname)) throw new Error("Request outside fixture transport");
      let body: HarnessJsonValue;
      if (url.pathname === "/items") body = phase === "comparison" && options.scenario === "missing_dependency" ? { missing: true } : { item: `fresh-${phase}-item` };
      else {
        if (url.searchParams.get("item") !== `fresh-${phase}-item`) throw new Error("Downstream call did not bind the fresh upstream result");
        body = { caption: "synthetic-replay-caption", queued: phase === "comparison" && options.scenario === "changed" ? 4 : 3 };
      }
      activeRequests.push({ stepId: request.stepId, method: request.method, url: request.url, status: 200, durationMs: performance.now() - requestStart });
      return { status: 200, headers: {}, classification: "application", body };
    } },
  });
  const indexed = await memory.index(selected.toolDigest, ["posting queue"], responseShapes.get(selected.toolDigest), options.signal);
  const cached = await memory.index(selected.toolDigest, ["posting queue"], responseShapes.get(selected.toolDigest), options.signal);
  events.push({ type: "AikoRequestMemoryIndexed", owner, toolDigest: selected.toolDigest, pointerId: indexed.pointerId, model: indexed.model, at: Date.now() });
  const search = await memory.search("posting queue", 1, options.signal);
  const addCheck = (checkId: string, label: string, passed: boolean, detail: string) => checks.push({ id: checkId, label, passed, detail });
  addCheck("compiled_dependency", "Capture compiles to a request dependency", selected.definition.steps[1]!.dependsOn.includes(selected.definition.steps[0]!.id), `${selected.definition.steps.length} steps; ${selected.definition.dependencies.length} exact bindings`);
  addCheck("pointer_cache", "Identical contract reuses its pointer", cached.cached && cached.pointerId === indexed.pointerId && embeddingCalls === 2, "One indexing embedding and one search embedding; cached indexing makes no embedding call.");
  addCheck("pointer_search", "Pointer is retrievable", search.items[0]?.pointerId === indexed.pointerId, "Uses the real RequestMemory search with an explicitly synthetic embedding adapter.");

  const store = createWorkflowStore(workflowKV(options.storage));
  const program: WorkflowDefinition = { version: 1, id: "fixture-hydrate-inspect", parameters: ["pointer"], limits: { maxCalls: 2, maxConcurrency: 1, timeoutMs: 5000 }, steps: [
    { id: "hydrate", toolId: "fixture-request-hydrate", dependsOn: [], arguments: { pointer: { kind: "input", name: "pointer" } } },
    { id: "inspect", toolId: "fixture-receipt-inspect", dependsOn: ["hydrate"], arguments: { observation: { kind: "result", step: "hydrate", path: ["observationId"] } } },
  ] };
  const workflows = new ToolWorkflows({ owner, store, dispatcher: { resolve: async ({ owner: caller, toolId }) => {
    if (caller !== owner || !["fixture-request-hydrate", "fixture-receipt-inspect"].includes(toolId)) return undefined;
    const field = toolId === "fixture-request-hydrate" ? "pointer" : "observation";
    return { owner, id: toolId, effect: "read", inputSchema: { type: "object", properties: { [field]: { type: "string" } }, required: [field], additionalProperties: false },
      validate: args => Object.keys(args).length === 1 && typeof args[field] === "string",
      authorize: async ({ owner: caller }) => caller === owner,
      execute: async call => {
        call.signal.throwIfAborted();
        if (field === "observation") return memory.memory.get(String(call.input.observation)) ? { status: "succeeded", output: { verifiedReceipt: true } } : { status: "failed" };
        const replayStart = performance.now(); activeRequests = []; replayBody = undefined;
        const result = await memory.hydrate(String(call.input.pointer), input, call.signal);
        const hit = result.observationId ? memory.memory.get(result.observationId) : null;
        const responseDigest = hit ? String((hit.observation.payload as Record<string, unknown>).responseDigest) : undefined;
        replays.push({ phase, status: result.status, code: result.code ?? "", changed: result.changed ?? null,
          ...(result.observationId ? { observationId: result.observationId, responseDigest } : {}), ...(replayBody ? { result: replayBody } : {}), durationMs: performance.now() - replayStart, requests: activeRequests });
        return result.status === "completed" && result.observationId ? { status: "succeeded", output: { observationId: result.observationId } } : { status: "failed" };
      },
    };
  } } });
  const definition = await workflows.define(program);
  const runs: RequestLabReport["workflow"]["runs"] = [];
  const run = async () => {
    const receipt = await workflows.run({ workflowId: program.id, runId: `${id}-${phase}`, input: { pointer: indexed.pointerId }, signal: options.signal });
    runs.push({ phase, runId: receipt.runId, status: receipt.status, calls: receipt.calls, steps: receipt.steps });
    return receipt;
  };
  const baseline = await run();
  if (baseline.status !== "succeeded" || !replays[0]?.observationId) throw new Error("Baseline fixture replay failed");
  const promoted = await workflows.crystallize({ workflowId: program.id, runId: baseline.runId });
  const replayCount = replays.length;
  const repeated = await workflows.run({ workflowId: program.id, runId: baseline.runId, input: { pointer: indexed.pointerId }, signal: options.signal });
  const idempotentReuse = repeated.status === "succeeded" && replays.length === replayCount;
  addCheck("workflow_receipt", "Fixed example harness is reusable after success", promoted.reusable && idempotentReuse, "Existing ToolWorkflows executor binds the hydration receipt to its inspection step; same run ID does not issue another request.");
  const firstCheck = replays[0].observationId;
  const derived = memory.memory.remember({ subject: "fixture-derived-queue-view", title: "Fixture queue view", type: "fixture-derived-view", payload: { check: firstCheck }, supports: [firstCheck], dependsOn: [firstCheck], ttlSeconds: 300 }, { key: "fixture-derived-baseline", producer: { kind: "tool", reference: "request-lab-fixed-example-v1" } });
  const before = memory.memory.get(derived.id)!.freshness;
  if (options.scenario !== "baseline") { phase = "comparison"; await run(); }
  options.signal?.throwIfAborted();
  const after = memory.memory.get(derived.id)!.freshness;
  const comparison = replays[1];
  if (comparison) {
    const missing = options.scenario === "missing_dependency";
    addCheck("comparison_outcome", missing ? "Missing producer value blocks downstream" : "Comparison fingerprint reflects response content", missing
      ? comparison.status !== "completed" && comparison.requests.length === 1 && !comparison.observationId
      : comparison.status === "completed" && comparison.changed === (options.scenario === "changed"), missing ? "Only the upstream request executes; no successful check is written." : `changed=${String(comparison.changed)}`);
    addCheck("derived_invalidation", "Entity-learn reports actual dependency freshness", after === (missing ? "fresh" : "stale"), missing
      ? "The failed replay leaves the prior check head unchanged; freshness alone is not evidence of a successful refresh."
      : "The check head advances on every successful hydration, including unchanged responses; its dependent observation becomes stale.");
  }
  addCheck("fresh_binding", "Downstream requests use fresh upstream values", replays.every(replay => replay.requests.filter(request => new URL(request.url).pathname === "/details").every(request => request.url.includes(`fresh-${replay.phase}-item`) && !request.url.includes(capturedItem))), "The compiler's response binding is executed by the existing request DAG runtime.");
  let recomputedId: string | undefined;
  if (after === "stale" && comparison?.observationId) {
    recomputedId = memory.memory.remember({ subject: derived.subject, title: derived.title, type: derived.type, payload: { check: comparison.observationId }, supersedes: derived.id, supports: [comparison.observationId], dependsOn: [comparison.observationId], ttlSeconds: 300 }, { key: "fixture-derived-recomputed", producer: { kind: "tool", reference: "request-lab-fixed-example-v1" } }).id;
  }
  const final = memory.memory.get(recomputedId ?? derived.id)!.freshness;
  const archive = JSON.stringify(memory.memory.exportArchive());
  addCheck("value_separation", "Pointer journal contains structure and receipts", !/captured-fixture-caption|synthetic-replay-caption|fresh-baseline-item|fresh-comparison-item/.test(archive), "Transient response values do not enter entity-learn pointer memory.");
  const displayedReplay = comparison ?? replays[0]!;
  const nodes: RequestLabReport["nodes"] = selected.definition.steps.map(step => {
    const recorded = replays[0]!.requests.find(request => request.stepId === step.id);
    const executed = displayedReplay.requests.find(request => request.stepId === step.id);
    return { id: step.id, label: step.method + " " + (recorded ? new URL(recorded.url).pathname : step.path),
      kind: "request", state: executed ? `HTTP ${executed.status}` : "blocked" };
  });
  const edges: RequestLabReport["edges"] = selected.definition.steps.flatMap(step => step.dependsOn.map(from => ({ from, to: step.id, relation: "feeds" })));
  nodes.push({ id: selected.toolDigest, label: "Compiled request contract", kind: "definition", state: "validated" }, { id: indexed.pointerId, label: "Cached executable pointer", kind: "pointer", state: "indexed" }, { id: derived.id, label: "Derived queue view", kind: "derived", state: after });
  edges.push({ from: selected.toolDigest, to: indexed.pointerId, relation: "indexed_as" });
  for (const step of selected.definition.steps) edges.push({ from: step.id, to: selected.toolDigest, relation: "compiled_into" });
  for (const replay of replays) if (replay.observationId) {
    nodes.push({ id: replay.observationId, label: `${replay.phase} response check`, kind: "check", state: replay.changed === null ? "baseline" : replay.changed ? "changed" : "unchanged" });
    edges.push({ from: indexed.pointerId, to: replay.observationId, relation: "checked_as" });
  }
  edges.push({ from: firstCheck, to: derived.id, relation: "current_input" });
  if (recomputedId && comparison?.observationId) {
    nodes.push({ id: recomputedId, label: "Recomputed queue view", kind: "derived", state: final });
    edges.push({ from: comparison.observationId, to: recomputedId, relation: "current_input" }, { from: derived.id, to: recomputedId, relation: "superseded_by" });
  }
  const summary = options.scenario === "missing_dependency" ? "Missing upstream data prevents the dependent request; prior memory remains available with no new successful refresh."
    : options.scenario === "unchanged" ? "The response is unchanged, but advancing the check head still invalidates its dependent view; explicit recomputation restores freshness."
    : options.scenario === "changed" ? "A changed fresh response invalidates the prior derived view; explicit recomputation follows the new observation."
    : "Captured fixture requests compile into a cached pointer and execute with fresh dependency values through a reusable fixed example workflow.";
  return { version: 1, id, scenario: options.scenario, mode: "controlled-fixture", startedAt, elapsedMs: performance.now() - start,
    status: checks.every(check => check.passed) ? "passed" : "failed", summary, checks,
    capture: { requests: entries.length, events: captureEvents, prepared: compiled.prepared, toolDigest: selected.toolDigest, sourceTraceDigest: selected.sourceTraceDigest },
    pointer: { id: indexed.pointerId, cacheReused: cached.cached, embeddingModel: indexed.model, embeddingCalls }, replays,
    workflow: { id: program.id, digest: definition.digest, reusable: promoted.reusable, source: "fixed-example", idempotentReuse, runs },
    derived: { id: derived.id, before, after, ...(recomputedId ? { recomputedId } : {}), final }, nodes, edges,
    evidence: { source: "fixture-component-events", events },
    limits: { realNetwork: false, realBrowser: false, realModel: false, nativeActorRun: false, notes: [
      "Fixture request/response data and deterministic embeddings; no Instagram or TikTok connection, browser, HTTP request or model invocation.",
      "Uses existing BrowserLearning, request DAG executor, RequestMemory, ToolWorkflows and entity-learn. The workflow is a fixed example, not generated code.",
      "Evidence contains emitted component events in memory; the lab does not run a native actor or claim durable native thread execution.",
      "Explicit derived recomputation is fixture glue. Production request-check heads currently advance even when the response fingerprint is unchanged.",
    ] } };
}
