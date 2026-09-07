import { canonicalStringify, sha256 } from "@unbrowse/browser-harness/har";
import { executableObservedReads, ownedNetworkDefinitions, ownedObservedActions } from "./capability-builder-network.ts";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { actor } from "tardie";
import { handles } from "tardie/core/actor";
import { actorMethod } from "tardie/core/method";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import type { ConnectorEngine } from "./connectors.ts";
import { replayCapabilities } from "./capability-builder.ts";
import { validateWorkflowDefinition, type WorkflowRecord } from "./tool-workflows.ts";

export const ROUTER_VERSION = "aiko-tool-router/8";
export type RouterMethod = "discover" | "describe" | "route" | "status";
export type RouteState = "ready" | "needs_connection" | "needs_discovery" | "catalog_unavailable";
export type AtomicTask = { id: string; query: string; domain?: string; arguments?: Record<string, unknown> };
export interface ToolRouterBinding {
  owner: string;
  engine: Pick<ConnectorEngine, "listCatalog" | "describe" | "search" | "connections">;
  /** Trusted host reads exactly this owner's foreground log. Text/nested tool results are never authoritative history. */
  readOwnedEvents?: () => Promise<readonly Event[]>;
  listWorkflows?: () => Promise<WorkflowRecord[]>;
  /** Host-approved Unlock vault domains for this owner. Never session material. */
  vaultDomains?: () => Promise<readonly string[]>;
  redact?: (text: string) => string;
}
type Candidate = {
  id: string; name: string; description: string; parent: string; provider: "arcade" | "generated" | "observed" | "workflow"; reviewRequired?: boolean;
  domains: string[]; inputSchema: Record<string, unknown>; requirements: Record<string, unknown>;
  connectionId?: string; connected: boolean; evidenceId?: string;
};
export type RoutedTool = Candidate & { score: number; missingArguments: string[]; history: "none" | "succeeded" | "failed" | "unknown" };
export type TaskRoute = { taskId: string; state: RouteState; tools: RoutedTool[]; fallbackAllowed: boolean; reason: string };
export type RouteDecision = { id: string; owner: string; version: string; snapshot: string; state: RouteState; tasks: TaskRoute[]; authority: { domain: string; signature: string }[]; createdAt: number; previousDecisionId?: string };
type E = Event & Record<string, unknown>;
const hashCanonicalWorkflow = (value: unknown) => sha256(canonicalStringify(validateWorkflowDefinition(value)));
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const routerThread = (owner: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(owner)) throw new Error("Invalid router owner");
  return `router-${owner}`;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const safeString = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
function parseTasks(input: unknown): { tasks: AtomicTask[]; previousDecisionId?: string } {
  if (!object(input) || Object.keys(input).some(k => !["tasks", "previousDecisionId"].includes(k)) || !Array.isArray(input.tasks) || !input.tasks.length || input.tasks.length > 8) throw new Error("Expected one to eight atomic tasks");
  if (input.previousDecisionId !== undefined && !safeString(input.previousDecisionId, 100)) throw new Error("Invalid previous decision");
  const ids = new Set<string>();
  const tasks = input.tasks.map(task => {
    if (!object(task) || Object.keys(task).some(k => !["id", "query", "domain", "arguments"].includes(k)) || !safeString(task.id, 64) || !safeString(task.query, 1000) || ids.has(task.id)) throw new Error("Invalid atomic task");
    ids.add(task.id);
    if (task.arguments !== undefined && (!object(task.arguments) || JSON.stringify(task.arguments).length > 4000)) throw new Error("Invalid arguments");
    if (task.domain !== undefined && (!safeString(task.domain, 253) || !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/i.test(task.domain))) throw new Error("Invalid domain");
    return task as AtomicTask;
  });
  return { tasks, ...(input.previousDecisionId ? { previousDecisionId: input.previousDecisionId as string } : {}) };
}
const stop = new Set("a an and are as at be by for from get i in is it me my of on please the to with".split(" "));
function tokens(text: string) {
  return [...new Set(text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1 && !stop.has(w)).map(w => w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w))];
}
function historyFor(owner: string, events: readonly Event[]) {
  const history = new Map<string, "succeeded" | "failed" | "unknown">();
  for (const e of events) if (e.type === "AikoConnectorExecutionSettled" && e.owner === owner && typeof e.toolId === "string" && typeof e.callId === "string" && ["succeeded", "failed", "unknown"].includes(String(e.status))) history.set(e.toolId, e.status as "succeeded" | "failed" | "unknown");
  return history;
}
/** Multi-view lexical baseline: fine-grained names + descriptions + exact schemas, with explicit parent traversal.
 * Inspired by AnyTool §4, Tool-to-Agent §2, ACE-Router §3.5 and CRAFT §2; no trained-router claims. */
function rank(task: AtomicTask, candidates: Candidate[], history: ReturnType<typeof historyFor>): RoutedTool[] {
  const query = tokens(task.query);
  const documents = candidates.map(c => new Set(tokens(`${c.name} ${c.description} ${c.parent} ${JSON.stringify(c.inputSchema)}`)));
  const df = new Map(query.map(q => [q, documents.filter(d => d.has(q)).length]));
  return candidates.flatMap((c, index) => {
    const requested = task.query.toLowerCase();
    const mutation = /\b(send|post|create|update|modify|change|label|mark|delete|remove|archive|move|triage|reply|forward|add|set|write|execute)\b/;
    const reading = /\b(find|search|list|read|fetch|get|show|check|unread|summarize|retrieve|lookup|what|which)\b/;
    const toolWords = (c.provider === "workflow" ? `${c.name} ${String(c.requirements.stepToolNames ?? "")}` : c.name).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9]+/g, " ");
    if (reading.test(requested) && !mutation.test(requested) && (mutation.test(toolWords) || (c.provider === "arcade" && !reading.test(toolWords)))) return [];
    if (task.domain && c.domains.length && !c.domains.some(d => task.domain === d || task.domain!.endsWith(`.${d}`))) return [];
    const name = new Set(tokens(c.name)), description = new Set(tokens(c.description)), schema = new Set(tokens(JSON.stringify(c.inputSchema))), parent = new Set(tokens(c.parent));
    let score = query.reduce((sum, q) => sum + (name.has(q) ? 4 : description.has(q) ? 2 : schema.has(q) ? 1.5 : parent.has(q) ? 1 : 0) * Math.log(1 + candidates.length / (1 + (df.get(q) ?? 0))), 0);
    if (!score || !query.some(q => documents[index].has(q))) return [];
    const required = Array.isArray(c.inputSchema.required) ? c.inputSchema.required.filter((v): v is string => typeof v === "string") : [];
    const missingArguments = required.filter(key => !Object.hasOwn(task.arguments ?? {}, key));
    // Collection discovery should not prefer a single-object lookup whose ID is unknown.
    // Keep these action/argument signals provider-independent; do not infer new endpoints.
    const collectionSearch = /\b(find|search|unread|which|lookup)\b/.test(requested);
    if (collectionSearch && !mutation.test(requested)) {
      if (/\b(search|find)\b/.test(toolWords)) score += 6;
      else if (/\blist\b/.test(toolWords)) score += 2;
      score -= missingArguments.filter(key => /(?:^|_)(?:id|ids)$|Id$|Ids$/.test(key)).length * 8;
      const properties = object(c.inputSchema.properties) ? c.inputSchema.properties : {};
      if (Object.keys(properties).some(key => /^(query|search|search_query|q)$/.test(key))) score += 3;
      // A folder-specific operation is a poor match unless that folder was requested.
      const partitions = ["draft", "sent", "spam", "trash", "archived"];
      for (const partition of partitions) {
        if (tokens(toolWords).includes(partition) && !query.includes(partition)) score -= 12;
      }
    }
    const outcome = history.get(c.id) ?? "none";
    score += c.connected ? 0.5 : 0;
    score += outcome === "succeeded" ? 0.3 : outcome === "failed" ? -2 : outcome === "unknown" ? -4 : 0;
    score += Object.keys(task.arguments ?? {}).filter(k => object(c.inputSchema.properties) && Object.hasOwn(c.inputSchema.properties, k)).length * 0.25;
    return [{ ...c, score, missingArguments, history: outcome } satisfies RoutedTool];
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
async function snapshot(binding: ToolRouterBinding) {
  const [catalogResult, connections, events, vaultDomains] = await Promise.all([binding.engine.listCatalog().catch(() => undefined), binding.engine.connections(), binding.readOwnedEvents?.() ?? Promise.resolve([]), binding.vaultDomains?.() ?? Promise.resolve([])]);
  if (catalogResult !== undefined && (!Array.isArray(catalogResult) || catalogResult.length > 30000)) throw new Error("Invalid catalog");
  const catalog = catalogResult ?? [];
  const catalogAvailable = catalog.length > 0;
  const redact = binding.redact ?? (text => text);
  const candidates: Candidate[] = [];
  const ids = new Set<string>();
  for (const tool of catalog) {
    if (!safeString(tool.id, 512) || !safeString(tool.toolName, 512) || !object(tool.inputSchema) || !object(tool.requirements) || !tool.toolkit?.name || ids.has(tool.id)) throw new Error("Malformed catalog");
    ids.add(tool.id);
    const connection = connections.find(c => (c.connectorId === tool.id || c.toolIds?.includes(tool.id)) && c.provider === "arcade" && c.status === "connected");
    const candidate: Candidate = { id: tool.id, name: tool.toolName, description: tool.description, parent: tool.toolkit.name, provider: "arcade", domains: tool.domains, inputSchema: tool.inputSchema, requirements: tool.requirements, connected: !!connection, ...(connection ? { connectionId: connection.id } : {}) };
    // Never rewrite exact schemas or silently omit poisoned metadata from the catalog version.
    if (redact(JSON.stringify(candidate)) !== JSON.stringify(candidate)) throw new Error("Unsafe catalog metadata");
    candidates.push(candidate);
  }
  const capabilities = replayCapabilities({ owner: binding.owner, thread: `user-${binding.owner}`, redact }, events);
  const uniqueCapabilities = [...new Map(capabilities.map(c => [c.url, c])).values()];
  const generated: Candidate[] = uniqueCapabilities.map(c => ({ id: c.id, name: `GET ${c.url}`, description: `Read ${c.url}`, parent: "owned-capability", provider: "generated", domains: [new URL(c.url).hostname], inputSchema: { type: "object", properties: {}, additionalProperties: false }, requirements: {}, connected: true, evidenceId: c.evidence.id }));
  const learned = executableObservedReads(events);
  // Anti-bot challenges demote host replay for the challenged origin until the vault
  // session is renewed past the challenge; fingerprint-bound origins belong to the browser actor.
  const challengeAt = new Map<string, number>();
  for (const e of events as E[]) {
    if (e.type !== "AikoObservedOriginChallenged" || e.owner !== binding.owner) continue;
    const origin = String(e.origin ?? ""); const at = Number(e.at ?? 0);
    if (origin && Number.isFinite(at)) challengeAt.set(origin, Math.max(challengeAt.get(origin) ?? 0, at));
  }
  const renewedAfterChallenge = new Set<string>();
  for (const e of events as E[]) {
    if (e.type !== "AikoUnlockSessionRenewed" || e.owner !== binding.owner) continue;
    const origin = String(e.domain ?? ""); const at = Number(e.at ?? 0);
    if (origin && Number.isFinite(at) && at > (challengeAt.get(origin) ?? 0)) renewedAfterChallenge.add(origin);
  }
  const hostBlocked = (origin: string) => challengeAt.has(origin) && !renewedAfterChallenge.has(origin);
  const learnedDigests = new Set(learned.map(e => e.toolDigest));
  const observedCandidate = (e: (typeof learned)[number], ready: boolean): Candidate => {
    const domains = [...new Set(e.definition.steps.map(s => new URL(s.origin).hostname))];
    const blocked = domains.some(hostBlocked);
    return {
    id: e.toolId, name: e.actionId, description: e.definition.steps.map(s => `${s.method} ${s.origin}${s.path}`).join("; "), parent: "owned-network", provider: "observed",
    domains,
    inputSchema: { type: "object", properties: Object.fromEntries(e.definition.inputs.filter(i => i.source === "caller").map(i => [i.name, i.type === "json" ? {} : { type: i.type }])), required: e.definition.inputs.filter(i => i.required && i.source === "caller").map(i => i.name), additionalProperties: false },
    requirements: {
      ...(ready
        ? { executeWith: "observed_network_run", merkle: e.toolDigest, sourceTraceDigest: e.sourceTraceDigest, reauthorizeEveryRun: true, execution: { tool: "observed_network_run", arguments: { toolDigest: e.toolDigest }, inputParameter: "inputs", inputEncoding: "json" } }
        : { sessionRequirements: e.definition.sessionRequirements, vaultInputs: e.definition.inputs.filter(i => i.source === "vault").map(i => i.name), approval: "review_required", executable: false }),
      ...(blocked ? { blockedBy: "origin_challenge" } : {}),
    },
    connected: ready && !blocked, reviewRequired: !ready, evidenceId: e.toolDigest,
    };
  };
  for (const e of learned) {
    const candidate = observedCandidate(e, true);
    if (redact(JSON.stringify(candidate)) !== JSON.stringify(candidate) || ids.has(candidate.id)) continue;
    ids.add(candidate.id);
    candidates.push(candidate);
  }
  const observed: Candidate[] = ownedNetworkDefinitions(events).filter(e => !learnedDigests.has(e.toolDigest)).map(e => observedCandidate(e, false));
  for (const action of ownedObservedActions(events)) {
    const domains = [...new Set(action.artifact.allowedOrigins.map(origin => new URL(origin).hostname))];
    const blocked = domains.some(hostBlocked);
    const candidate: Candidate = {
      id: action.artifactDigest, name: action.actionId,
      description: action.artifact.actions.flatMap(a => a.steps.map(s => `${s.method} ${s.origin}${s.path}`)).join("; "),
      parent: "owned-network", provider: "observed",
      domains,
      inputSchema: { type: "object", properties: Object.fromEntries((action.artifact.actions[0]?.inputs ?? []).map(i => [i.name, i.type === "json" ? {} : { type: i.type }])), required: (action.artifact.actions[0]?.inputs ?? []).filter(i => i.required).map(i => i.name), additionalProperties: false },
      requirements: {
        executeWith: "observed_network_run", merkle: action.artifactDigest, sourceTraceDigest: action.importDigest, reauthorizeEveryRun: true,
        effect: action.effect, session: action.sessionRequired ? "unlock-vault" : "none",
        execution: { tool: "observed_network_run", arguments: { artifactDigest: action.artifactDigest }, inputParameter: "inputs", inputEncoding: "json" },
        ...(action.effect === "write" ? { approval: "owner_required" } : {}),
        ...(blocked ? { blockedBy: "origin_challenge" } : {}),
      },
      connected: !blocked && (!action.sessionRequired || domains.every(d => vaultDomains.includes(d))), reviewRequired: action.effect === "write", evidenceId: action.artifactDigest,
    };
    if (redact(JSON.stringify(candidate)) !== JSON.stringify(candidate) || ids.has(candidate.id)) continue;
    ids.add(candidate.id);
    candidates.push(candidate);
  }
  const history = historyFor(binding.owner, events);
  for(const record of await binding.listWorkflows?.()??[]) {
    if(record.owner!==binding.owner||record.reusable!==true||!record.provenance?.runId)continue;
    try { if(hashCanonicalWorkflow(record.definition)!==record.digest)continue; } catch { continue; }
    const stepTools=record.definition.steps.map(step=>[...candidates,...generated,...observed].find(tool=>tool.id===step.toolId));
    if(stepTools.some(tool=>!tool || (tool.provider === "observed" && !tool.connected)))continue;
    // Generated and learned-network steps retain their Arcade absence gate even inside a reusable workflow.
    let allowed = true;
    for(const tool of stepTools) if(tool!.provider === "generated" || tool!.provider === "observed") for(const domain of tool!.domains) {
      const authority = await searchAuthority(binding, domain);
      if(authority.status!=="absent" || !authority.fallbackAllowed) allowed=false;
    }
    if(!allowed)continue;
    const workflow:Candidate={id:`workflow:${record.definition.id}`,name:record.definition.id,description:`Reusable workflow: ${stepTools.map(t=>t!.description).join("; ")}`,parent:"owned-workflow",provider:"workflow",domains:[...new Set(stepTools.flatMap(t=>t!.domains))],inputSchema:{type:"object",properties:Object.fromEntries(record.definition.parameters.map(p=>[p,{}])),required:record.definition.parameters,additionalProperties:false},requirements:{executeWith:"workflow_run",workflowId:record.definition.id,reauthorizeEveryRun:true,stepToolNames:stepTools.map(t=>t!.name).join(" "),provenance:record.provenance,execution:{tool:"workflow_run",arguments:{workflowId:record.definition.id},inputParameter:"input",inputEncoding:"json"}},connected:stepTools.every(t=>t!.connected),evidenceId:record.digest};
    if(redact(JSON.stringify(workflow))!==JSON.stringify(workflow))continue;
    candidates.push(workflow);
  }
  // Observed capabilities are established by the owner's verified network graph,
  // independently of Arcade. A missing catalog still grants no discovery fallback.
  if (!catalogAvailable && !observed.length && !candidates.some(c => c.provider === "observed")) throw new Error("Catalog unavailable");
  return { candidates, generated, observed, history, catalogAvailable, version: hash([ROUTER_VERSION, catalogAvailable, catalog.map(c => [c.id, c.toolkit, c.metadata]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))), [...candidates].sort((a, b) => a.id.localeCompare(b.id)), generated, observed, [...history].sort(), [...vaultDomains].sort()]) };
}
async function searchAuthority(binding: ToolRouterBinding, domain: string) {
  return binding.engine.search(domain).catch(() => ({ status: "unavailable" as const, fallbackAllowed: false, connectors: [], message: "Catalog unavailable" }));
}
function authoritySignature(result: Awaited<ReturnType<ToolRouterBinding["engine"]["search"]>>) { return hash([result.status, result.fallbackAllowed, result.connectors.map(c => c.id).sort()]); }
function overall(tasks: TaskRoute[]): RouteState {
  return (["catalog_unavailable", "needs_discovery", "needs_connection", "ready"] as const).find(state => tasks.some(task => task.state === state)) ?? "needs_discovery";
}
function bounded(tools: RoutedTool[], count: number) {
  const result: RoutedTool[] = [];
  let bytes = 0;
  for (const tool of tools) {
    const size = JSON.stringify(tool).length;
    if (size > 12000 || bytes + size > 16000) continue; // Preserve exact schemas; never truncate JSON.
    result.push(tool); bytes += size;
    if (result.length === count) break;
  }
  return result;
}
async function respond(binding: ToolRouterBinding, method: RouterMethod, input: unknown, log: readonly Event[]) {
  const current = await snapshot(binding);
  if (method === "status") {
    if (!object(input) || Object.keys(input).some(k => k !== "decisionId") || (input.decisionId !== undefined && !safeString(input.decisionId, 100))) throw new Error("Invalid status arguments");
    const prior = [...log].reverse().find(e => e.type === "AikoRouterDecisionRecorded" && e.owner === binding.owner && (!input.decisionId || (e.result as RouteDecision)?.id === input.decisionId));
    const decision = prior?.result as RouteDecision | undefined;
    const authority = decision ? await Promise.all(decision.authority.map(async check => ({ domain: check.domain, signature: authoritySignature(await searchAuthority(binding, check.domain)) }))) : [];
    const version = hash([current.version, authority]);
    return { state: decision?.snapshot === version ? decision.state : "needs_discovery", current: !!decision && decision.snapshot === version, decisionId: decision?.id, snapshot: version, reason: decision ? "Compare snapshot before reuse; changed catalog, auth or execution history requires rerouting" : "No owned route decision" };
  }
  if (method === "describe") {
    if (!object(input) || Object.keys(input).some(k => k !== "toolIds") || !Array.isArray(input.toolIds) || !input.toolIds.length || input.toolIds.length > 6 || input.toolIds.some(id => !safeString(id, 512))) throw new Error("Invalid describe arguments");
    const selected = [...new Set(input.toolIds)].map(id => current.candidates.find(c => c.id === id));
    if (selected.some(c => !c)) return { state: "needs_discovery", tools: [], reason: "Tool is not in current catalog" };
    const tools = bounded(selected.map(c => ({ ...c!, score: 0, missingArguments: [], history: "none" as const })), 6);
    return { state: tools.length === selected.length ? "ready" : "needs_discovery", tools, snapshot: current.version, omitted: selected.length - tools.length };
  }
  const request = parseTasks(input);
  if (request.previousDecisionId && !log.some(e => e.type === "AikoRouterDecisionRecorded" && e.owner === binding.owner && (e.result as RouteDecision)?.id === request.previousDecisionId)) throw new Error("Previous decision is not owned");
  const tasks: TaskRoute[] = [];
  const checks: {domain:string;signature:string}[] = [];
  let remainingBytes = 24000;
  for (const task of request.tasks) {
    let pool = current.candidates;
    let fallbackAllowed = false;
    if (task.domain) {
      const authority = await searchAuthority(binding, task.domain);
      checks.push({domain: task.domain, signature: authoritySignature(authority)});
      fallbackAllowed = authority.status === "absent" && authority.fallbackAllowed;
      if (authority.status === "available") {
        const found = new Set(authority.connectors.map(c => c.id));
        // Include all tools under matched parents, not just the engine's capped search shortlist.
        const parents = new Set(current.candidates.filter(c => found.has(c.id)).map(c => c.parent));
        pool = current.candidates.filter(c => found.has(c.id) || parents.has(c.parent) || c.provider==="workflow"&&c.domains.includes(task.domain!));
      } else pool = [];
    }
    let ranked = rank(task, pool, current.history);
    if (fallbackAllowed) ranked = rank(task, [...current.generated, ...current.observed, ...current.candidates.filter(c=>c.provider==="workflow"||c.provider==="observed")].filter(c => c.domains.includes(task.domain!)), current.history);
    if (!ranked.length) ranked = rank(task, [...current.observed, ...current.candidates.filter(c=>c.provider==="observed")], current.history);
    const tools = bounded(ranked, 2).filter(tool => { const bytes = JSON.stringify(tool).length; if (bytes > remainingBytes) return false; remainingBytes -= bytes; return true; }); // At most 16 exact schemas for eight atomic tasks.
    const state: RouteState = tools.length ? tools.some(t => t.connected && t.history !== "unknown") ? "ready" : tools.every(t => t.history === "unknown" || t.reviewRequired) ? "needs_discovery" : "needs_connection" : current.catalogAvailable ? "needs_discovery" : "catalog_unavailable";
    tasks.push({ taskId: task.id, state, tools, fallbackAllowed, reason: tools.length ? "Ranked fine-grained schemas with parent provider, owned connection state and verified execution history; missingArguments must still be supplied; routing grants no action authority" : fallbackAllowed ? "Arcade confirms provider absence; discover or build a validated capability" : "No safe exact-schema match; refine this atomic task or provider. Absence has not been authorized" });
  }
  const version = hash([current.version, checks]);
  const id = `route_${hash([binding.owner, version, request]).slice(0, 32)}`;
  const existing = log.find(e => e.type === "AikoRouterDecisionRecorded" && e.owner === binding.owner && (e.result as RouteDecision)?.id === id)?.result as RouteDecision | undefined;
  return existing ?? { id, owner: binding.owner, version: ROUTER_VERSION, snapshot: version, state: overall(tasks), tasks, authority: checks, createdAt: Date.now(), ...(request.previousDecisionId ? { previousDecisionId: request.previousDecisionId } : {}) } satisfies RouteDecision;
}
export function routerEventKey(e: Event) {
  if (e.type === "ResponseReceived" && typeof e.from === "string" && /^aiko:[^:]+:router-[A-Za-z0-9_-]+$/.test(e.from) && typeof e.call === "string" && ["discover", "describe", "route", "status"].includes(String(e.method))) return `aiko-router:response:${e.from}:${e.method}:${e.call}`;
  if (!["AikoRouterRequested", "AikoRouterDecisionRecorded", "AikoRouterCancelled", "AikoRouterOpened"].includes(e.type) || typeof e.owner !== "string" || typeof e.id !== "string") return undefined;
  return `aiko-router:${e.owner}:${e.type}:${e.id}`;
}
const invocationKey = (method: string, id: string, epoch: number) => `${method}:${id}:${epoch}`;
/** Actual native durable actor: host mounts this definition for router-OWNER. No function is disguised as an actor. */
export function createToolRouterActor(binding: ToolRouterBinding) {
  routerThread(binding.owner);
  const methods = createToolRouterMethods(binding.owner);
  const handler = component({
    name: "aiko.tool-router", keys: { prefixes: ["aiko-router:"], keyOf: routerEventKey },
    initial: () => ({ pending: new Map<string, E>(), done: new Set<string>() }),
    step: (state, e) => {
      if (e.owner !== binding.owner) return state;
      const next = { pending: new Map(state.pending), done: new Set(state.done) };
      if (e.type === "AikoRouterRequested" && !next.pending.has(String(e.id))) next.pending.set(String(e.id), e);
      if (["AikoRouterDecisionRecorded", "AikoRouterCancelled"].includes(e.type)) next.done.add(String(e.id));
      return next;
    },
    output: state => ({ view: undefined, transitions: [...state.pending.values()].filter(e => !state.done.has(String(e.id))).slice(0, 1).map(request => effect({
      key: `aiko-router:${binding.owner}:AikoRouterDecisionRecorded:${request.id}`, input: request,
      invocation: (request.call as { invocation: import("tardie/core/method").ActorInvocation }).invocation,
      act: input => Effect.gen(function* () {
        const self = yield* Self;
        const log = yield* EventLog;
        const events = yield* log.read;
        const result = self.actor !== "aiko" || self.thread !== routerThread(binding.owner)
          ? { state: "catalog_unavailable", reason: "owner_binding_mismatch" }
          : yield* Effect.tryPromise(() => respond(binding, input.operation as RouterMethod, input.input, events)).pipe(Effect.catch(() => Effect.succeed({ state: "catalog_unavailable", reason: "Catalog, authorization state, or request could not be validated; no fallback authorized", tasks: [] })));
        return [{ type: "AikoRouterDecisionRecorded", owner: binding.owner, id: input.id, operation: input.operation, result, at: Date.now() }];
      }),
    })) }),
  });
  const bound = Object.values(methods).reduce((c, method) => handles(method, c), handler);
  return actor({ name: "aiko", methods, components: [bound] });
}

/** Shared native method declarations let the foreground route without importing engine authority. */
export function createToolRouterMethods(owner: string) {
  const taskSchema = Schema.Struct({ id: Schema.String, query: Schema.String, domain: Schema.optional(Schema.String), arguments: Schema.optional(Schema.Unknown) });
  const routeSchema = Schema.Struct({ tasks: Schema.Array(taskSchema), previousDecisionId: Schema.optional(Schema.String) });
  const inputs = { discover: routeSchema, route: routeSchema, describe: Schema.Struct({ toolIds: Schema.Array(Schema.String) }), status: Schema.Struct({ decisionId: Schema.optional(Schema.String) }) };
  const method = (name: RouterMethod) => actorMethod({
    input: inputs[name], output: Schema.Unknown,
    event: call => ({ type: "AikoRouterRequested", owner: owner, id: invocationKey(name, call.invocation.id, call.invocation.epoch), operation: name, input: call.input, call: { invocation: call.invocation, ...(call.parent ? { parent: call.parent } : {}), ...(call.deadlineAt === undefined ? {} : { deadlineAt: call.deadlineAt }) }, at: call.at }),
    cancellation: { event: (cancel, at) => ({
      type: "AikoRouterCancelled", owner, operation: name,
      id: invocationKey(name, cancel.invocation.id, cancel.invocation.epoch),
      invocation: cancel.invocation, cause: cancel.cause,
      ...(cancel.reason ? { reason: cancel.reason } : {}),
      ...(cancel.deadlineAt === undefined ? {} : { deadlineAt: cancel.deadlineAt }), at,
    }) },
    projection: {
      initial: () => new Map<string, E>(),
      step: (prior: Map<string, E>, e: Event) => {
        if (e.owner !== owner || !["AikoRouterRequested", "AikoRouterDecisionRecorded", "AikoRouterCancelled"].includes(e.type) || e.operation !== name) return prior;
        const previous = prior.get(String(e.id));
        if (previous && previous.type !== "AikoRouterRequested") return prior;
        const next = new Map(prior); next.set(String(e.id), { ...e, ...(previous?.call ? { call: previous.call } : {}) }); return next;
      },
      output: (state: Map<string, E>) => ({ currentEpoch: id => Math.max(0, ...[...state.values()].flatMap(e => {
        const invocation = (e.call as any)?.invocation ?? e.invocation;
        return invocation?.id === id ? [Number(invocation.epoch)] : [];
      })), invocationState: (invocation: { id: string; epoch: number }) => {
        const event = state.get(invocationKey(name, invocation.id, invocation.epoch));
        return !event ? undefined : event.type === "AikoRouterCancelled" ? {
          status: "cancelled" as const, cause: event.cause === "deadline" ? "deadline" as const : "requested" as const,
          ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
          ...(typeof event.deadlineAt === "number" ? { deadlineAt: event.deadlineAt } : {}),
        } : event.type === "AikoRouterDecisionRecorded" ? { status: "completed" as const, output: event.result } : { status: "pending" as const };
      } }),
    },
  });
  return { discover: method("discover"), describe: method("describe"), route: method("route"), status: method("status") };
}
