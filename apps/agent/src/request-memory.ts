import { Memory, validateNoSecrets, type MemoryStorage, type Json } from "entity-learn/cloudflare";
import { responseSemanticEvidenceOf } from "@unbrowse/browser-harness/response-semantics";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import type { NativeTool } from "tardie/component/tool";
import type { Event } from "tardie/core/event";
import { ownedNetworkDefinitions } from "./capability-builder-network.ts";
import { endpointInterface, ownedEndpointDescriptions } from "./observed-endpoint.ts";
import { canonicalStringify, sha256 } from "@unbrowse/browser-harness/har";
import { validateNetworkToolDefinition, networkToolDigest, type NetworkToolDefinition } from "@unbrowse/browser-harness/network-tool-catalog";
import { validateSiteHarnessArtifact, SITE_HARNESS_SCHEMA_VERSION, SITE_HARNESS_EXECUTOR_ABI } from "@unbrowse/browser-harness/harness-artifact";
import { executeHarnessAction, type HarnessJsonValue, type HarnessTransport } from "@unbrowse/browser-harness/harness-runtime";

export interface RequestEmbeddingProvider {
  /** Immutable model/version identity. Different dimensions/models never mix. No lexical fallback. */
  model: string;
  dimensions: number;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<readonly (readonly number[])[]>;
}
export interface RequestMemoryBinding {
  owner: string;
  storage: MemoryStorage;
  readOwnedEvents(): Promise<readonly Event[]>;
  embedding: RequestEmbeddingProvider;
  /** Host-bound transport MUST enforce SSRF/DNS policy, owner session isolation and manual redirects. */
  transport: HarnessTransport;
  authorizeSession?(requirements: readonly string[], origins: readonly string[]): Promise<boolean>;
  /** Explicit opt-in: only configure with a trusted local embedding provider. */
  embedResponseValues?: boolean;
  /** Transient analysis sink. Do not append bodies or value-derived summaries to pointer memory/tool logs. */
  consume?(response: { pointerId: string; stepId: string; body: HarnessJsonValue | undefined }, signal?: AbortSignal): Promise<void>;
  /** Durable native log bridge. Contains hashes and status only, never response values. */
  record?(event: Event): Promise<void>;
}
type Shape = { path: string; type: string };
type Pointer = { version: 1; owner: string; definition: NetworkToolDefinition; concepts: string[]; shapes: Record<string, Shape[]>; model: string; embedding: number[] };
const safeLabel = /^[a-z][a-z _-]{0,79}$/i;
/** Type-only projection. No enum/default/examples, array lengths, scalar values or dynamic map keys. */
export function responseShape(body: unknown): Shape[] {
  const text = JSON.stringify(body);
  if (typeof text !== "string" || text.length > 1000000) throw new Error("Response exceeds shape budget");
  const semantics = responseSemanticEvidenceOf({mimeType:"application/json",text,truncated:false});
  return semantics.fields.flatMap(field => field.types.map(type => ({path:field.path,type})));
}
/** Bounded transient embedding document. Secret fields/credential-shaped scalars never reach the model. */
function responseDocument(body: unknown): string {
  let nodes = 0;
  const scrub = (v: unknown, depth: number): unknown => {
    if (++nodes > 512 || depth > 8) return null;
    if (v && typeof v === "object") return Array.isArray(v) ? v.slice(0,32).map(x=>scrub(x,depth+1)) : Object.fromEntries(Object.entries(v).filter(([k])=>!/token|secret|password|cookie|authorization|api.?key|session/i.test(k)).slice(0,64).map(([k,x])=>[k,scrub(x,depth+1)]));
    try { validateNoSecrets(v); return typeof v === "string" ? v.slice(0,1000) : v; } catch { return null; }
  };
  return JSON.stringify(scrub(body,0)).slice(0,12000);
}

function vector(value: readonly number[], size: number): number[] {
  if (!Array.isArray(value) || value.length !== size || !value.every(Number.isFinite)) throw new Error("Invalid embedding");
  const norm = Math.hypot(...value); if (!norm || !Number.isFinite(norm)) throw new Error("Empty embedding");
  return value.map(v => v / norm);
}
export function artifact(definition: NetworkToolDefinition) {
  const d = validateNetworkToolDefinition(definition);
  // Vault/session execution belongs to the host's separately authorized connector path.
  if (d.inputs.some(i => i.source !== "caller") || d.steps.some(s => Object.keys(s.headers).length)) throw new Error("Session replay unavailable");
  return validateSiteHarnessArtifact({ schemaVersion: SITE_HARNESS_SCHEMA_VERSION, executorAbi: SITE_HARNESS_EXECUTOR_ABI,
    siteId: d.siteId, version: "request-memory-1", sourceCaptureDigest: d.sourceTraceDigest, allowedOrigins: [...new Set(d.steps.map(s => s.origin))],
    actions: [{ id: d.actionId, inputs: d.inputs.map(({ name, type, required }) => ({ name, type, required })), steps: d.steps.map(s => ({ ...s,
      pathParameters: Object.fromEntries(Object.entries(s.pathParameters).map(([k,v]) => [k, v.kind === "input" ? { kind: v.kind, name: v.name } : v])),
      query: Object.fromEntries(Object.entries(s.query).map(([k,v]) => [k, v.kind === "input" ? { kind: v.kind, name: v.name } : v])),
    })) }] });
}

export class RequestMemory {
  readonly memory: Memory;
  constructor(readonly binding: RequestMemoryBinding) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(binding.owner) || !binding.embedding.model || !Number.isInteger(binding.embedding.dimensions) || binding.embedding.dimensions < 1 || binding.embedding.dimensions > 4096) throw new Error("Invalid binding");
    this.memory = new Memory({ storage: binding.storage, scope: `request-memory:${binding.owner}` });
  }
  private async definition(digest: string, events?: readonly Event[]) {
    const observed = ownedNetworkDefinitions(events ?? await this.binding.readOwnedEvents()).find(e => e.toolDigest === digest);
    if (!observed) throw new Error("Owned network evidence unavailable");
    artifact(observed.definition);
    if (observed.definition.sessionRequirements.length && !await this.binding.authorizeSession?.(observed.definition.sessionRequirements,[...new Set(observed.definition.steps.map(step=>step.origin))])) throw new Error("Session replay unavailable");
    return observed.definition;
  }
  /** Host ingestion API: optional bodies exist only during type extraction, never in the journal. */
  async index(toolDigest: string, concepts: string[], responses: Record<string, unknown> = {}, signal?: AbortSignal) {
    if (!Array.isArray(concepts) || !concepts.length || concepts.length > 16 || concepts.some(c => typeof c !== "string" || !safeLabel.test(c))) throw new Error("Use bounded concept labels, never response summaries");
    validateNoSecrets(concepts);
    const events = await this.binding.readOwnedEvents();
    const definition = await this.definition(toolDigest, events);
    const endpoint = endpointInterface(definition.steps, ownedEndpointDescriptions(events, ownedNetworkDefinitions(events)).get(toolDigest));
    const shapes: Record<string, Shape[]> = {};
    for (const [step, body] of Object.entries(responses)) {
      if (!definition.steps.some(s => s.id === step)) throw new Error("Unknown response step");
      shapes[step] = responseShape(body);
    }
    const structural = { definition, concepts: [...new Set(concepts)].sort(), shapes, endpoint };
    validateNoSecrets(structural);
    const document = canonicalStringify({concepts:structural.concepts,shapes,inputs:definition.inputs}).slice(0,3500);
    const transient = this.binding.embedResponseValues ? Object.values(responses).map(responseDocument).join("\n").slice(0,12000) : "";
    // Reuse the indexed request contract before spending another embedding call. Response values
    // contribute only an owner-scoped fingerprint when explicitly using local response embeddings.
    const indexDigest = sha256(canonicalStringify({owner:this.binding.owner,structural,model:this.binding.embedding.model,
      dimensions:this.binding.embedding.dimensions,responseDigest:sha256(canonicalStringify({owner:this.binding.owner,transient}))}));
    const subject = `request:${indexDigest}`;
    const head = this.memory.journal.head(this.memory.scope,subject);
    if (head) {
      const cached = this.memory.get(head.id);
      if (!cached) throw new Error("Request pointer is suppressed");
      return {pointerId:cached.observation.id,requestIds:definition.evidence.map(e=>e.requestId),model:this.binding.embedding.model,cached:true};
    }
    // Small encoders truncate by tokens: response semantics must precede verbose DAG/schema metadata.
    const vectors = await this.binding.embedding.embed([`${endpoint.name}\n${structural.concepts.join(" ")}\n${transient}\n${endpoint.description}\n${document}`], signal);
    if (vectors.length !== 1) throw new Error("Embedding count mismatch");
    const payload: Pointer = { version: 1, owner: this.binding.owner, ...structural, model: this.binding.embedding.model, embedding: vector(vectors[0]!, this.binding.embedding.dimensions) };
    const saved = this.memory.remember({ subject, title: structural.concepts.join(" "), type: "request-pointer", payload: payload as unknown as Json }, { key: `index:${indexDigest}`, producer: { kind: "tool", reference: toolDigest } });
    return { pointerId: saved.id, requestIds: definition.evidence.map(e => e.requestId), model: payload.model, cached:false };
  }
  private pointer(id: string): Pointer {
    const hit = this.memory.get(id);
    if (!hit || hit.observation.type !== "request-pointer") throw new Error("Owned pointer unavailable");
    const p = hit.observation.payload as unknown as Pointer;
    if (p.owner !== this.binding.owner || p.version !== 1) throw new Error("Invalid pointer");
    artifact(p.definition); return p;
  }
  async search(query: string, limit = 5, signal?: AbortSignal) {
    if (typeof query !== "string" || !query.trim() || query.length > 2000 || !Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("Invalid search");
    validateNoSecrets(query);
    const vectors = await this.binding.embedding.embed([query], signal);
    if (vectors.length !== 1) throw new Error("Embedding count mismatch");
    const q = vector(vectors[0]!, this.binding.embedding.dimensions);
    signal?.throwIfAborted();
    // Evidence must still be present. Retrieval does not authorize a session or replay any request.
    const events = await this.binding.readOwnedEvents(), reads = ownedNetworkDefinitions(events);
    const definitions = new Map(reads.map(e => [e.toolDigest, e]));
    const descriptions = ownedEndpointDescriptions(events, reads);
    return this.memory.journal.read(() => {
      const reasons = new Set<string>();
      let after: string | undefined, scanned = 0, corpusBytes = 0;
      type Item = { pointerId: string; toolId: string; endpoint: ReturnType<typeof endpointInterface>; toolDigest: string; sourceTraceDigest: string; observedAt: number; freshness: "requires-check"; score: number; concepts: string[]; shapes: Record<string, Shape[]>; requestIds: string[]; inputs: NetworkToolDefinition["inputs"] };
      let items: Item[] = [];
      do {
        signal?.throwIfAborted();
        const page = this.memory.scan({ type: "request-pointer", after, limit: Math.min(128, 10000 - scanned) });
        scanned += page.scanned;
        for (const reason of page.reasons) if (!["page_limit", "page_window"].includes(reason)) reasons.add(reason);
        for (const hit of page.items) {
          corpusBytes += new TextEncoder().encode(JSON.stringify(hit.observation)).length;
          if (corpusBytes > 16 * 1024 * 1024) { reasons.add("corpus_byte_budget"); break; }
          try {
            const p = this.pointer(hit.observation.id);
            const definition = definitions.get(networkToolDigest(p.definition));
            if (!definition) { reasons.add("evidence_unavailable"); continue; }
            if (p.model !== this.binding.embedding.model || p.embedding.length !== q.length) { reasons.add("embedding_space_mismatch"); continue; }
            const v = vector(p.embedding, q.length);
            items.push({ pointerId: hit.observation.id, toolId: definition.toolId,
              endpoint: endpointInterface(definition.definition.steps, descriptions.get(definition.toolDigest)), toolDigest: networkToolDigest(p.definition), sourceTraceDigest:p.definition.sourceTraceDigest,
              observedAt:hit.observation.observedAt, freshness:"requires-check", score: q.reduce((sum,x,i) => sum + x*v[i]!, 0), concepts: p.concepts, shapes: p.shapes, requestIds: p.definition.evidence.map(e => e.requestId), inputs: p.definition.inputs });
          } catch { reasons.add("invalid_pointer"); }
        }
        // Keep only the best requested candidates in memory, not the entire corpus/vector array.
        items.sort((a,b) => b.score-a.score || a.pointerId.localeCompare(b.pointerId));
        if (items.length > limit) reasons.add("result_budget");
        items = items.slice(0, limit);
        after = page.nextAfter ?? undefined;
      } while (after && scanned < 10000 && corpusBytes <= 16 * 1024 * 1024);
      if (after && scanned >= 10000) reasons.add("candidate_budget");
      while (new TextEncoder().encode(JSON.stringify(items)).length > 24000) { items.pop(); reasons.add("result_byte_budget"); }
      return { items, model: this.binding.embedding.model, coverage: reasons.size ? "partial" as const : "complete" as const,
        reasons: [...reasons], scanned, sourceVersion: this.memory.journal.scopeVersion(this.memory.scope) };
    });
  }
  /** Recompute dependencies once in native topological order. Only a value-free receipt is returned. */
  async hydrate(id: string, inputs: Record<string, HarnessJsonValue> = {}, signal?: AbortSignal) {
    const p = this.pointer(id);
    await this.definition(networkToolDigest(p.definition)); // Revoked/missing source evidence fails closed.
    validateNoSecrets(inputs);
    const requestDigest = sha256(canonicalStringify({owner:this.binding.owner,toolDigest:networkToolDigest(p.definition),inputs}));
    const subject = `request-check:${requestDigest}`;
    const prior = this.memory.recall({subject,type:"request-check",includeStale:true,limit:1}).items[0]?.observation;
    let terminal: { stepId: string; body: HarnessJsonValue | undefined } | undefined;
    const result = await executeHarnessAction({ artifact: artifact(p.definition), actionId: p.definition.actionId, input: inputs,
      adapters: { clock: { now: () => new Date() }, uuid: { next: () => crypto.randomUUID() }, transport: { send: async request => {
        signal?.throwIfAborted();
        if (!["GET", "HEAD"].includes(request.method)) throw new Error("Read-only replay");
        const response = await this.binding.transport.send(request);
        signal?.throwIfAborted();
        terminal = { stepId: request.stepId, body: response.body };
        return response;
      } } } });
    let check: { observationId: string; checkedAt: number; changed: boolean | null } | undefined;
    if (result.status === "completed" && terminal) {
      signal?.throwIfAborted();
      const checkedAt = Date.now();
      const responseDigest = sha256(canonicalStringify({owner:this.binding.owner,body:terminal.body ?? null}));
      const changed = prior ? (prior.payload as Record<string, Json>).responseDigest !== responseDigest : null;
      const observation = this.memory.remember({subject,title:p.concepts.join(" ")+" request update check",type:"request-check",kind:"episode",
        payload:{pointerId:id,toolDigest:networkToolDigest(p.definition),requestDigest,responseDigest,changed,checkedAt},
        observedAt:checkedAt,ttlSeconds:300,supports:[id],dependsOn:[id],...(prior?{supersedes:prior.id}:{})},
        {key:`check:${crypto.randomUUID()}`,producer:{kind:"tool",reference:networkToolDigest(p.definition)}});
      check = {observationId:observation.id,checkedAt,changed};
      await this.binding.record?.({type:"AikoRequestMemoryChecked",id:crypto.randomUUID(),owner:this.binding.owner,
        pointerId:id,toolDigest:networkToolDigest(p.definition),requestDigest,responseDigest,...check,at:checkedAt});
      if (this.binding.consume) await this.binding.consume({ pointerId: id, ...terminal }, signal);
    }
    return { pointerId: id, status: result.status, code: result.code, counts: result.counts, ...check, consumed: result.status === "completed" && !!this.binding.consume };
  }
}

/** Low-level adapter: production must wrap model input with BrowserController.inference to keep
 * query/input values out of native ToolCalled events. BrowserController supplies its own wrapped tools. */
export function createRequestMemoryTools(memory: RequestMemory): NativeTool<Self>[] {
  const specs = [
    { name: "request_memory_index", description: "Index an owned observed request DAG by digest and concept labels. Stores structural pointers only.", properties: { toolDigest: {type:"string"}, concepts: {type:"array",items:{type:"string"}} }, required:["toolDigest","concepts"] },
    { name: "request_memory_search", description: "Semantic retrieval of owned request pointers, endpoint contracts and toolIds for tool_router_describe. No cached response values; retrieval grants no execution authority.", properties: {query:{type:"string"}}, required:["query"] },
    { name: "request_memory_hydrate", description: "Recompute a read-only request DAG. Responses go to transient host analysis; only a receipt enters the log.", properties: {pointerId:{type:"string"},inputs:{type:"object"}}, required:["pointerId"] },
  ];
  return specs.map(spec => ({ spec: {name:spec.name,description:spec.description,inputSchema:{type:"object",properties:spec.properties,required:spec.required,additionalProperties:false}}, run: (input,context) => Effect.gen(function* () {
    const self = yield* Self;
    if (self.actor !== "aiko" || self.thread !== `user-${memory.binding.owner}`) return {status:"rejected",reason:"owner_binding_mismatch"};
    return yield* Effect.tryPromise(async () => {
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !Object.hasOwn(spec.properties,k))) throw new Error("Invalid input");
      const a = input as Record<string, any>;
      return spec.name === "request_memory_index" ? memory.index(a.toolDigest,a.concepts,{},context.signal) : spec.name === "request_memory_search" ? memory.search(a.query,5,context.signal) : memory.hydrate(a.pointerId,a.inputs,context.signal);
    }).pipe(Effect.catch(() => Effect.succeed({status:"rejected",reason:"Request memory input, evidence, embedding or replay unavailable"})));
  }) }));
}
