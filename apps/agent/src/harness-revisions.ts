import type { HarnessArtifact, HarnessDigest, HarnessJson, HarnessLibrary } from "./harness-library.ts";
import { executableObservedReads, ownedObservedActions } from "./capability-builder-network.ts";
import { artifact as observedArtifact } from "./request-memory.ts";

export type HarnessRevisionChanges = Partial<Pick<HarnessArtifact,
  "description" | "runtime" | "runtimeLockDigest" | "entrypoint" | "files" | "dependencies" | "sources" | "contractDigest">>;

/** Erased or incomplete source facts cannot authorize a new use. Historical
 * completed witnesses are returned by the library before artifact resolution. */
export function observedRequestEvidenceAvailable(artifact: HarnessArtifact, events: Parameters<typeof executableObservedReads>[0]) {
  const sources = artifact.sources.filter(source => source.uri.startsWith("aiko-request:"));
  if (!sources.length) return true;
  const current = executableObservedReads(events);
  const actions = ownedObservedActions(events).filter(row => row.effect === "read");
  return sources.every(source => current.some(row => source.uri === `aiko-request:${row.toolDigest}` &&
    source.digest === row.toolDigest && source.revision === row.sourceTraceDigest) || actions.some(row =>
    source.uri === `aiko-request:${row.artifactDigest}` && source.digest === row.artifactDigest && source.revision === row.importDigest));
}

/** An editing facade over the existing native library. No mutable tool store,
 * execution loop, evaluator registration or channel-route mutation lives here. */
export class HarnessRevisions {
  constructor(readonly library: HarnessLibrary) {}

  /** The owner's existing validated, indexed request graph is the only source.
   * A registered independent contract must also classify this exact operation;
   * a GET observation is not evidence that the endpoint is semantically read-only.
   * Session reads require the explicit observed-network host binding; writes retain its approval adapter. */
  async fromRequest(toolDigest: HarnessDigest, name: string, contractDigest: HarnessDigest, signal: AbortSignal) {
    signal.throwIfAborted();
    const events = await this.library.journal.read();
    const observed = executableObservedReads(events).find(row => row.toolDigest === toolDigest);
    const action = ownedObservedActions(events).find(row => row.artifactDigest === toolDigest && row.effect === "read");
    if (!observed && !action) return { status: "unavailable", reason: "owned-observed-read-unavailable",
      next: "Recall a supported captured read. Session reads require an explicitly configured current host session; writes retain observed_network_run approval." };
    const { contract } = await this.library.resolveContract(contractDigest);
    const classification = contract.applicability.observedRequest;
    if (contract.effect !== "read" || !classification || typeof classification !== "object" || Array.isArray(classification) ||
      classification.version !== 1 || classification.toolDigest !== toolDigest || classification.effect !== "read")
      throw Error("Trusted contract must independently classify this exact observed operation as read-only");
    const graph = observed ? observedArtifact(observed.definition) : action!.artifact;
    const artifact: HarnessArtifact = { version: 1, name, description: contract.outcome, runtime: "network", entrypoint: "request.json",
      files: { "request.json": JSON.stringify({ graph, actionId: observed?.actionId ?? action!.actionId }) }, dependencies: [], contractDigest,
      sources: [{ uri: `aiko-request:${toolDigest}`, revision: observed?.sourceTraceDigest ?? action!.importDigest, digest: toolDigest, license: "NOASSERTION" }] };
    signal.throwIfAborted();
    const digest = await this.library.record(artifact);
    return { status: "candidate", digest, toolDigest, contractDigest, inputSchema: contract.inputSchema,
      execution: "Requires current network authority and independent fixed-case evaluation; capture is not a passing execution.",
      next: "Inspect or revise the candidate, then evaluate and promote under the registered contract." };
  }

  async inspect(digest: HarnessDigest, signal: AbortSignal) {
    signal.throwIfAborted();
    const { artifact, contract } = await this.library.resolve(digest);
    const procedure = await this.library.procedure(digest, signal);
    const route = (await this.library.list()).routes.find(row => row.name === artifact.name &&
      row.contractDigest === artifact.contractDigest && row.contextDigest === procedure.initiation.contextDigest) ?? null;
    const result = { status: "inspectable", digest, artifact, contract, procedure,
      route, expectedGeneration: Number(route?.generation ?? 0),
      lineage: artifact.revision ?? null,
      authority: "rechecked-for-exact-input-at-invocation",
      edits: "A revision preserves captured sources; changed fields describe authored or inferred changes, not new observations." };
    this.library.binding.guard(result);
    return result;
  }

  async derive(predecessorDigest: HarnessDigest, changes: HarnessRevisionChanges, signal: AbortSignal) {
    signal.throwIfAborted();
    const digest = await this.library.revise(predecessorDigest, changes);
    signal.throwIfAborted();
    return { status: "candidate", digest, predecessorDigest, next: "Evaluate this digest against its registered contract before promotion." };
  }

  async evaluate(digest: HarnessDigest, evaluationId: string, signal: AbortSignal) {
    const evaluation = await this.library.evaluate(digest, evaluationId, signal);
    const events = await this.library.journal.read();
    const uncertain = Array.isArray(evaluation.witnessIds) && evaluation.witnessIds.some(id => {
      const witness = events.find(row => row.owner === this.library.binding.owner && row.type === "AikoHarnessChecked" && row.id === id)?.witness as { status?: string } | undefined;
      return !witness || witness.status === "unknown";
    });
    // Failed candidates remain inspectable; an unsettled native run is never
    // restarted by this facade. The library retains its own operation keys.
    return { status: evaluation.type === "AikoHarnessEvaluationPending" ? "pending" : evaluation.eligible ? "eligible" : uncertain ? "unknown" : "failed",
      digest, evaluationId, evaluation,
      next: evaluation.eligible ? "Promote using the inspected route generation." : "Inspect retained evidence; revise known failures and reconcile unknown executions." };
  }

  async promote(digest: HarnessDigest, evaluationId: string, expectedGeneration: number, signal: AbortSignal) {
    const { artifact, contract, verifier } = await this.library.resolve(digest);
    const context = await this.library.binding.context(signal);
    const example = verifier.cases.find(fixture => fixture.split === "development");
    if (!example || !await this.library.binding.authorize(artifact, contract, context, structuredClone(example.input), signal))
      return { status: "unavailable", digest, reason: "current-authority-or-dependencies-unavailable" };
    signal.throwIfAborted();
    const route = await this.library.promote(digest, evaluationId, expectedGeneration, signal);
    return { status: "promoted", digest, route, connections: "Existing connections retain their exact pins; upgrading a watch is a separate explicit operation." };
  }

  /** Discovery resolves the current route and checks the proposed fresh input.
   * This launches no model, capture, verifier or execution. Availability remains
   * a point-in-time check; harness_call/run rechecks at dispatch. */
  async recall(name: string, contractDigest: HarnessDigest, input: HarnessJson, signal: AbortSignal) {
    signal.throwIfAborted();
    let route: Awaited<ReturnType<HarnessLibrary["verifiedRoute"]>>;
    try { route = await this.library.verifiedRoute(name, contractDigest, signal); }
    catch { signal.throwIfAborted(); return { status: "unavailable", reason: "verified-route-or-artifact-unavailable", next: "Inspect the retained version and restore its dependencies or evaluate a revision." }; }
    const { artifact, contract } = await this.library.resolve(route.harnessDigest);
    const context = await this.library.binding.context(signal);
    if (!this.library.inputValid(contract.inputSchema, input)) return { status: "unavailable", reason: "input-schema-mismatch", parameters: contract.inputSchema };
    if (!await this.library.binding.authorize(artifact, contract, context, structuredClone(input), signal))
      return { status: "unavailable", reason: "current-authority-or-dependencies-unavailable", next: "Restore the connection or authorize this exact operation." };
    const procedure = await this.library.procedure(route.harnessDigest, signal);
    const current = await this.library.verifiedRoute(name, contractDigest, signal);
    signal.throwIfAborted();
    if (current.harnessDigest !== route.harnessDigest || current.contextDigest !== route.contextDigest)
      return { status: "unavailable", reason: "route-changed-during-recall", next: "Recall the current version again." };
    return { status: "available", digest: current.harnessDigest, contractDigest, parameters: contract.inputSchema,
      effect: contract.effect, applicability: contract.applicability, dependencies: artifact.dependencies,
      procedure,
      authority: "checked-for-supplied-input-rechecked-at-invocation" };
  }
}
