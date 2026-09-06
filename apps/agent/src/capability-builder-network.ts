import type { Event } from "tardie/core/event";
import { decodeBrowserTraceEvent, type BrowserNetworkToolPrepared } from "@unbrowse/browser-harness/trace";
import { assertNetworkSnapshotBackedByLog, networkGraphCheckpointOf, validatedHarCaptureFactsOf } from "@unbrowse/browser-harness/network-facts";
import { canonicalStringify, sha256 } from "@unbrowse/browser-harness/har";
import { validateSiteHarnessArtifact, type SiteHarnessArtifact } from "@unbrowse/browser-harness/harness-artifact";
import { validateNoSecrets } from "entity-learn/cloudflare";

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

function indexedDigests(events: readonly Event[]) {
  return new Set(events.flatMap(e => e.type === "AikoRequestMemoryIndexed" && typeof e.toolDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(e.toolDigest) ? [e.toolDigest] : []));
}

/** Merkle-backed GET/HEAD DAGs that were indexed as request pointers and need no browser session.
 * Caller inputs and result bindings are allowed; writes, headers, vault/session material are not. */
export function executableObservedReads(events: readonly Event[]): BrowserNetworkToolPrepared[] {
  const indexed = indexedDigests(events);
  return ownedNetworkDefinitions(events).filter(event => {
    if (!indexed.has(event.toolDigest)) return false;
    const d = event.definition;
    if (!d.steps.length || d.steps.length > 16 || d.sessionRequirements.length || d.inputs.some(i => i.source !== "caller"))
      return false;
    return d.steps.every(step =>
      ["GET", "HEAD"].includes(step.method) &&
      !Object.keys(step.headers).length &&
      step.expectedStatuses.includes(200));
  });
}

export interface ObservedActionPrepared {
  type: "AikoObservedActionPrepared";
  threadId: string;
  captureId: string;
  importDigest: string;
  actionId: string;
  artifactDigest: string;
  effect: "read" | "write";
  sessionRequired: boolean;
  /** Hostnames of the artifact's allowed origins; no credentials. */
  domains: readonly string[];
  artifact: SiteHarnessArtifact;
}

export function artifactDigestOf(artifact: SiteHarnessArtifact) {
  return `sha256:${sha256(canonicalStringify(validateSiteHarnessArtifact(artifact)))}`;
}

function mutating(artifact: SiteHarnessArtifact) {
  return artifact.actions.some(action => action.steps.some(step => !["GET", "HEAD"].includes(step.method)));
}

/** Merkle-backed site harness drafts. Cookies/passwords are never in the artifact. */
export function ownedObservedActions(events: readonly Event[]): ObservedActionPrepared[] {
  const actions = new Map<string, ObservedActionPrepared>();
  for (const raw of events) {
    if (raw.type !== "AikoObservedActionPrepared") continue;
    const event = raw as Event & ObservedActionPrepared;
    if (typeof event.threadId !== "string" || typeof event.captureId !== "string" || typeof event.importDigest !== "string" ||
      typeof event.actionId !== "string" || typeof event.artifactDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(event.artifactDigest))
      continue;
    const checkpoint = events.find(e => e.type === "NetworkGraphCheckpointPrepared" && e.threadId === event.threadId && e.importDigest === event.importDigest && networkGraphCheckpointOf(e));
    if (!checkpoint) continue;
    try {
      validateNoSecrets(event.artifact);
      const artifact = validateSiteHarnessArtifact(event.artifact);
      if (artifactDigestOf(artifact) !== event.artifactDigest || artifact.sourceCaptureDigest !== event.importDigest) continue;
      const graph = events.filter(e => e.captureId === checkpoint.captureId);
      const facts = events.filter(e => e.type === "NetworkFactObserved" && e.threadId === event.threadId && Number(e.sequence) < Number(checkpoint.sourceNetworkSequence));
      assertNetworkSnapshotBackedByLog(facts, event.threadId, graph, checkpoint.sourceRequestIds as string[], Number(checkpoint.sourceNetworkSequence));
      const validated = validatedHarCaptureFactsOf(graph, String(checkpoint.captureId));
      if (validated.status !== "completed") continue;
      const effect = mutating(artifact) ? "write" : "read";
      if (event.effect !== effect) continue;
      actions.set(event.artifactDigest, {
        type: "AikoObservedActionPrepared",
        threadId: event.threadId,
        captureId: event.captureId,
        importDigest: event.importDigest,
        actionId: event.actionId,
        artifactDigest: event.artifactDigest,
        effect,
        sessionRequired: event.sessionRequired === true,
        domains: [...new Set(artifact.allowedOrigins.map(origin => new URL(origin).hostname))],
        artifact,
      });
    } catch { /* Incomplete mutating drafts cannot become skills. */ }
  }
  return [...actions.values()];
}
