import type { Event } from "tardie/core/event";
import type { BrowserNetworkToolPrepared } from "@unbrowse/browser-harness/trace";
import { canonicalStringify, sha256 } from "@unbrowse/browser-harness/har";
import { validateResponseSemanticEvidence, type ResponseSemanticEvidence } from "@unbrowse/browser-harness/response-semantics";
import type { ObservedActionPrepared } from "./capability-builder-network.ts";

export const ENDPOINT_DESCRIPTION_REVISION = "observed-endpoint/1";
type Target = { kind: "read" | "action"; reference: string; threadId: string; sourceTraceDigest: string; requestId: string };
export type EndpointDescriptionEvent = Event & Target & {
  type: "AikoObservedEndpointDescribed"; revision: typeof ENDPOINT_DESCRIPTION_REVISION; id: string;
  response: ResponseSemanticEvidence;
};
export const readEndpointTarget = (event: BrowserNetworkToolPrepared): Target => {
  const step = event.definition.steps.at(-1);
  const request = event.definition.evidence.find(e => e.stepId === step?.id);
  if (!request) throw Error("Endpoint evidence unavailable");
  return { kind: "read", reference: event.toolDigest, threadId: event.threadId, sourceTraceDigest: event.sourceTraceDigest, requestId: request.requestId };
};
export const actionEndpointTarget = (event: Pick<ObservedActionPrepared, "artifact" | "actionId" | "artifactDigest" | "threadId" | "importDigest">): Target => {
  const step = event.artifact.actions.find(a => a.id === event.actionId)?.steps.at(-1);
  if (!step) throw Error("Endpoint action unavailable");
  return { kind: "action", reference: event.artifactDigest, threadId: event.threadId, sourceTraceDigest: event.importDigest, requestId: step.id };
};

/** Called only after the corresponding structural definition is durably appended.
 * No response values, arbitrary model descriptions or execution authority enter this event. */
export function endpointDescriptionEventOf(target: Target, response: ResponseSemanticEvidence): EndpointDescriptionEvent {
  const fields = { type: "AikoObservedEndpointDescribed" as const, revision: ENDPOINT_DESCRIPTION_REVISION as typeof ENDPOINT_DESCRIPTION_REVISION,
    ...target, response: validateResponseSemanticEvidence(response) };
  return { ...fields, id: `endpoint-${sha256(canonicalStringify(fields))}` };
}

/** Stable redelivery key for the trusted browser ingress; does not validate source authority. */
export function endpointDescriptionEventKey(event: Event): string | undefined {
  if (event.type !== "AikoObservedEndpointDescribed" || !["read", "action"].includes(event.kind as string) ||
    typeof event.reference !== "string" || !/^sha256:[a-f0-9]{64}$/.test(event.reference) ||
    typeof event.sourceTraceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(event.sourceTraceDigest) ||
    typeof event.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(event.threadId) ||
    typeof event.requestId !== "string" || !/^req-\d{4}$/.test(event.requestId)) return undefined;
  try {
    const expected = endpointDescriptionEventOf({ kind: event.kind as Target["kind"], reference: event.reference,
      threadId: event.threadId, sourceTraceDigest: event.sourceTraceDigest, requestId: event.requestId }, event.response as ResponseSemanticEvidence);
    const { at: _at, ...actual } = event;
    return canonicalStringify(actual) === canonicalStringify(expected) ? `aiko-endpoint:${expected.id}` : undefined;
  } catch { return undefined; }
}

/** Definitions/actions must be from the existing owner-log manifest validators.
 * Descriptions cannot create a target, change its schema or make it executable. */
export function ownedEndpointDescriptions(events: readonly Event[], reads: readonly BrowserNetworkToolPrepared[], actions: readonly ObservedActionPrepared[] = []) {
  const targets = new Map([...reads.map(readEndpointTarget), ...actions.map(actionEndpointTarget)].map(t => [t.reference, t]));
  const descriptions = new Map<string, ResponseSemanticEvidence>();
  const allowed = new Set(["type", "revision", "kind", "reference", "threadId", "sourceTraceDigest", "requestId", "response", "id", "at"]);
  for (const event of events) {
    if (event.type !== "AikoObservedEndpointDescribed" || Object.keys(event).some(k => !allowed.has(k))) continue;
    const target = targets.get(String(event.reference));
    if (!target) continue;
    try {
      const expected = endpointDescriptionEventOf(target, event.response as ResponseSemanticEvidence);
      const { at: _at, ...actual } = event;
      if (canonicalStringify(actual) !== canonicalStringify(expected)) continue;
      descriptions.set(target.reference, expected.response);
    } catch { /* Invalid metadata is unavailable, not authority or a substitute for source evidence. */ }
  }
  return descriptions;
}

/** Human/search description of an existing executable recipe, not generated executable code.
 * The last topologically ordered step is the selected action; prerequisites remain in its pinned DAG. */
export function endpointInterface(
  steps: readonly { method: string; origin: string; path: string; dependsOn: readonly string[] }[],
  response?: ResponseSemanticEvidence,
) {
  const target = steps.at(-1);
  if (!target) throw Error("Endpoint steps unavailable");
  const semantics = response && validateResponseSemanticEvidence(response);
  const effect = steps.some(s => !["GET", "HEAD"].includes(s.method)) ? "write" : "read";
  const concepts = semantics?.concepts.slice(0, 6) ?? [];
  const noun = concepts.length ? concepts.join(" / ") : "JSON response";
  const name = `${effect === "read" ? "Read" : target.method} ${noun}`.slice(0, 128);
  const outputFields = semantics?.fields.map(f => ({ path: f.path, types: [...f.types] })) ?? [];
  const description = `${name} (${semantics?.shape ?? "unavailable"}) via ${target.method} ${target.origin}${target.path}. ` +
    `Recompute ${Math.max(0, steps.length - 1)} prerequisite request(s) with fresh inputs and current authorized session material. ` +
    (outputFields.length ? `Observed fields: ${outputFields.slice(0, 6).map(f => f.path).join(", ")}. ` : "Response shape is unavailable. ") +
    "Observation is not an independent correctness guarantee or execution permission.";
  return { name, description, effect, concepts,
    output: { shape: semantics?.shape ?? "unavailable", fields: outputFields, truncated: semantics?.truncated ?? true, coverage: "observed-only" },
    recomputation: { stepCount: steps.length, dependencyCount: steps.reduce((n, s) => n + s.dependsOn.length, 0),
      freshInputs: true, capturedValues: false, dependencyResolution: "pinned-dag" },
  };
}
