import { Effect } from "effect";
import type { NativeTool } from "tardie/component/tool";
import type { Event } from "tardie/core/event";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { HarnessStep, ValueProducer } from "@unbrowse/browser-harness/harness-artifact";
import type { WorkerBinding, WorkerGrant, workerGrantOf } from "./code-agents.ts";
import { executableObservedReads, ownedObservedActions } from "./capability-builder-network.ts";
import { endpointInterface, ownedEndpointDescriptions } from "./observed-endpoint.ts";
import { rankToolCandidates } from "./tool-router.ts";

const digestPattern = "^sha256:[a-f0-9]{64}$";
const blocked = (error: string) => ({ status: "blocked", error });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const resultBudget = 24_000;

/** Project only validated definitions inside the grant, before ranking or graph disclosure.
 * An indexed pointer is a historical citation, not proof its private storage is available. */
function catalog(events: readonly Event[], grant: WorkerGrant) {
  const allowed = (steps: readonly HarnessStep[], digest: string) =>
    steps.length > 0 && steps.every(step => grant.origins.includes(step.origin)) &&
    (!grant.actions.length || grant.actions.includes(digest));
  const reads = executableObservedReads(events).filter(row => allowed(row.definition.steps, row.toolDigest));
  const actions = ownedObservedActions(events).filter(row => allowed(row.artifact.actions[0]!.steps, row.artifactDigest));
  const descriptions = ownedEndpointDescriptions(events, reads, actions);
  const pointers = new Map<string, string>();
  for (const event of events) if (event.type === "AikoRequestMemoryIndexed" && typeof event.toolDigest === "string" &&
    typeof event.pointerId === "string" && /^obs_[a-f0-9]{64}$/.test(event.pointerId)) pointers.set(event.toolDigest, event.pointerId);
  return [
    ...reads.map(row => ({
      reference: row.toolDigest, steps: row.definition.steps,
      definition: {
        kind: "read" as const, toolDigest: row.toolDigest, sourceTraceDigest: row.sourceTraceDigest,
        pointerId: pointers.get(row.toolDigest), inputs: row.definition.inputs,
        origins: [...new Set(row.definition.steps.map(step => step.origin))], evidence: row.definition.evidence,
        sessionRequired: false, endpoint: endpointInterface(row.definition.steps, descriptions.get(row.toolDigest)),
        executeWith: "observed_network_run" as const,
      },
    })),
    ...actions.map(row => ({
      reference: row.artifactDigest, steps: row.artifact.actions[0]!.steps,
      definition: {
        kind: row.effect, artifactDigest: row.artifactDigest, sourceTraceDigest: row.importDigest,
        inputs: row.artifact.actions[0]!.inputs, origins: [...new Set(row.artifact.actions[0]!.steps.map(step => step.origin))],
        sessionRequired: row.sessionRequired,
        endpoint: endpointInterface(row.artifact.actions[0]!.steps, descriptions.get(row.artifactDigest)),
        executeWith: "observed_network_run" as const,
      },
    })),
  ];
}

/** Symbolic producers only. Even a validated action may contain host-authored constants;
 * neither those values nor module bodies belong in retrieval context. */
function bindingOf(value: ValueProducer): Record<string, unknown> {
  switch (value.kind) {
    case "input": return { kind: value.kind, name: value.name };
    case "response_json": return { kind: value.kind, stepId: value.stepId, pointer: value.pointer };
    case "response_header": return { kind: value.kind, stepId: value.stepId, name: value.name };
    case "clock": return { kind: value.kind, format: value.format };
    case "uuid": return { kind: value.kind };
    case "constant": return { kind: value.kind, valueOmitted: true };
    case "object": return { kind: value.kind, fields: bindingsOf(value.fields) };
    case "array": return { kind: value.kind, items: value.items.map(bindingOf) };
    case "wasm": case "js": return { kind: value.kind, args: value.args.map(bindingOf), implementationOmitted: true };
  }
}
const bindingsOf = (values: Readonly<Record<string, ValueProducer>>) =>
  Object.fromEntries(Object.entries(values).map(([name, value]) => [name, bindingOf(value)]));
const stepOf = (step: HarnessStep) => ({
  id: step.id, dependsOn: step.dependsOn, method: step.method, origin: step.origin, path: step.path,
  pathParameters: bindingsOf(step.pathParameters), query: bindingsOf(step.query), headers: bindingsOf(step.headers),
  ...(step.body ? { body: bindingOf(step.body) } : {}), expectedStatuses: step.expectedStatuses,
});

function argumentsOf(input: unknown, describe: boolean) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const args = input as Record<string, unknown>;
  const keys = describe ? ["toolDigest", "artifactDigest", "offset", "limit"] : ["query", "offset", "limit"];
  if (Object.keys(args).some(key => !keys.includes(key))) return undefined;
  if (describe) {
    if ((typeof args.toolDigest === "string") === (typeof args.artifactDigest === "string")) return undefined;
    if (![args.toolDigest, args.artifactDigest].every(value => value === undefined || typeof value === "string" && new RegExp(digestPattern).test(value))) return undefined;
  } else if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 1000)) return undefined;
  const offset = args.offset ?? 0, limit = args.limit ?? (describe ? 4 : 8);
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > (describe ? 8 : 32)) return undefined;
  return { toolDigest: typeof args.toolDigest === "string" ? args.toolDigest : undefined,
    artifactDigest: typeof args.artifactDigest === "string" ? args.artifactDigest : undefined,
    query: String(args.query ?? "").trim(), offset: Number(offset), limit: Number(limit) };
}

/** Uses the native worker's invocation/log/budget, not another retrieval agent or VM. */
export function createWorkerIndexTools(binding: WorkerBinding, resolveGrant: typeof workerGrantOf): NativeTool<Self | EventLog>[] {
  const current = Effect.gen(function* () {
    const self = yield* Self, log = yield* EventLog;
    if (self.actor !== "aiko" || self.thread !== binding.thread) return undefined;
    const child = yield* log.read, parent = yield* Effect.promise(binding.readParent);
    const grant = resolveGrant(binding, parent, child);
    return grant?.scope === "browser" ? catalog(parent, grant) : undefined;
  });
  return [false, true].map(describe => ({
    spec: {
      name: describe ? "worker_index_describe" : "worker_index_search",
      description: describe
        ? "Inspect a granted recorded endpoint and its pinned request dependency graph. Returns paged topological steps and fresh-input/response bindings, never captured values. Does not execute, authorize a session or approve writes."
        : "Search the owner's granted endpoint descriptions, observed output fields, routes and input contracts. Ranked lexical retrieval; refine queries and inspect matches with worker_index_describe before observed_network_run. No browser or request is started; pointer IDs are historical citations.",
      inputSchema: {
        type: "object",
        properties: {
          ...(describe ? { toolDigest: { type: "string", pattern: digestPattern }, artifactDigest: { type: "string", pattern: digestPattern } } : { query: { type: "string", maxLength: 1000 } }),
          offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: describe ? 8 : 32 },
        },
        ...(describe ? { oneOf: [{ required: ["toolDigest"] }, { required: ["artifactDigest"] }] } : {}),
        additionalProperties: false,
      },
    },
    run: input => Effect.gen(function* () {
      const args = argumentsOf(input, describe);
      if (!args) return blocked("Invalid index arguments; use the discovered input contract");
      const entries = yield* current;
      if (!entries) return blocked("Browser worker grant required");
      if (describe) {
        const entry = entries.find(row => args.toolDigest ? "toolDigest" in row.definition && row.definition.toolDigest === args.toolDigest
          : "artifactDigest" in row.definition && row.definition.artifactDigest === args.artifactDigest);
        if (!entry) return blocked("Recorded endpoint is unavailable within this grant; search again or request the missing scope");
        const steps = entry.steps.slice(args.offset, args.offset + args.limit).map(stepOf);
        const result = {
          definition: entry.definition,
          graph: { steps, order: "topological", totalSteps: entry.steps.length, offset: args.offset,
            nextOffset: args.offset + steps.length < entry.steps.length ? args.offset + steps.length : null,
            verification: "recorded-structure-only", capturedValues: false },
        };
        return bytes(result) <= resultBudget ? result : blocked("Graph page exceeds the context budget; request fewer steps with limit");
      }
      // Reuse the router's multi-view ranker, but only after resource filtering. This
      // is lexical retrieval over observed semantics, not an embedding-model claim.
      const byReference = new Map(entries.map(row => [row.reference, row.definition]));
      const ranked = args.query ? rankToolCandidates({ id: "worker-index", query: args.query }, entries.map(({ reference, definition: d }) => ({
        id: reference, name: d.endpoint.name,
        description: `${d.endpoint.description} ${JSON.stringify(d.endpoint.output.fields)}`,
        parent: d.origins.join(" "), provider: "observed", domains: d.origins.map(origin => new URL(origin).hostname),
        inputSchema: { type: "object", properties: Object.fromEntries(d.inputs.map(i => [i.name, { type: i.type }])), required: d.inputs.filter(i => i.required).map(i => i.name) },
        requirements: { effect: d.kind }, connected: false,
      })), new Map()).map(hit => ({ ...byReference.get(hit.id)!, score: hit.score }))
        : entries.map(row => row.definition);
      const definitions: typeof ranked = [];
      let next = args.offset, used = 0, omitted = 0;
      while (next < ranked.length && definitions.length < args.limit) {
        const candidate = ranked[next]!, size = bytes(candidate);
        if (size > resultBudget - 1000) { omitted++; next++; continue; }
        if (used + size > resultBudget - 1000) break;
        definitions.push(candidate); used += size; next++;
      }
      return { definitions, total: ranked.length, offset: args.offset, nextOffset: next < ranked.length ? next : null,
        coverage: args.offset || next < ranked.length || omitted ? "partial" : "complete", omitted,
        retrieval: "ranked-lexical", pointerAvailability: "not-checked" };
    }),
  }));
}
