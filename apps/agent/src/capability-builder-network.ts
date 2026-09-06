import type { Event } from "tardie/core/event";
import { decodeBrowserTraceEvent, type BrowserNetworkToolPrepared } from "@unbrowse/browser-harness/trace";
import { assertNetworkSnapshotBackedByLog, networkGraphCheckpointOf, validatedHarCaptureFactsOf } from "@unbrowse/browser-harness/network-facts";

/** Events must come from the host-bound owner log. Native browser identities are per-VM trace IDs, not account IDs.
 * Validate the compiler digest AND graph manifest AND acknowledged network-fact prefix; nested copies are ignored. */
export function ownedNetworkDefinitions(events: readonly Event[]): BrowserNetworkToolPrepared[] {
  const definitions = new Map<string, BrowserNetworkToolPrepared>();
  for (const raw of events) {
    if (raw.type !== "BrowserNetworkToolPrepared") continue;
    const event = decodeBrowserTraceEvent(raw);
    if (event?.type !== "BrowserNetworkToolPrepared") continue;
    const checkpoint = events.find(e => e.type === "NetworkGraphCheckpointPrepared" && e.threadId === event.threadId && e.importDigest === event.sourceTraceDigest && networkGraphCheckpointOf(e));
    if (!checkpoint) continue;
    try {
      const graph = events.filter(e => e.captureId === checkpoint.captureId);
      const facts = events.filter(e => e.type === "NetworkFactObserved" && e.threadId === event.threadId && Number(e.sequence) < Number(checkpoint.sourceNetworkSequence));
      assertNetworkSnapshotBackedByLog(facts, event.threadId, graph, checkpoint.sourceRequestIds as string[], Number(checkpoint.sourceNetworkSequence));
      const validated = validatedHarCaptureFactsOf(graph, String(checkpoint.captureId));
      if (validated.status !== "completed" || !event.definition.evidence.every(e => validated.capture.exchanges.some(exchange => exchange.requestId === e.requestId && exchange.response.status === 200))) continue;
      definitions.set(event.toolDigest, event);
    } catch { /* Invalid or incomplete observed traces cannot become capabilities. */ }
  }
  return [...definitions.values()];
}
/** Only a fixed GET with no caller/vault inputs, headers, dependencies or session requirements can use public transport. */
export function fixedNetworkReads(events: readonly Event[]) {
  return ownedNetworkDefinitions(events).flatMap(event => {
    const d = event.definition, step = d.steps[0];
    if (!step || d.steps.length !== 1 || d.inputs.length || d.sessionRequirements.length || d.dependencies.length || step.method !== "GET" || Object.keys(step.pathParameters).length || Object.keys(step.query).length || Object.keys(step.headers).length || !step.expectedStatuses.includes(200)) return [];
    return [{ reference: event.toolDigest, url: `${step.origin}${step.path}`, method: "GET" as const }];
  });
}
