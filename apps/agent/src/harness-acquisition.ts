import { Effect } from "effect";
import { Validator } from "@cfworker/json-schema";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { builtinHarnessDefinitions, type BuiltinHarnessDefinition } from "./harness-builtins.ts";
import { HarnessLibrary, harnessDigest, harnessLibraryState, validateHarnessArtifact, type HarnessArtifact, type HarnessDigest, type HarnessJournal, type HarnessLibraryBinding } from "./harness-library.ts";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const maxCases = 16;
/** Fixed trusted cases each have an invocation ceiling. This bounds the whole
 * acquisition; per-execution host grants and caller cancellation still apply. */
export function harnessAcquisitionLimits(timeoutMs: number, caseCount: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000 || !Number.isInteger(caseCount) || caseCount < 1 || caseCount > maxCases) throw Error("Acquisition case or invocation budget exceeded");
  return { maxCases, wallMs: Math.min(1800000, Math.max(30000, timeoutMs * caseCount)) };
}
export interface HarnessAcquireInput { name: string; operationId: string; candidate?: HarnessArtifact }

export interface HarnessTaskAssociation { version: 1; thread: string; turn: string; callId: string; epoch?: number }
/** Native invocation context establishes causality; candidate arguments cannot
 * attach an acquisition to a different message or manufacture a task. */
export function harnessAcquisitionTask(events: readonly Event[], owner: string, thread: string,
  call: { turn?: string; callId: string }): HarnessTaskAssociation | undefined {
  if (thread !== `user-${owner}` || typeof call.turn !== "string" || !call.turn || !call.callId) return undefined;
  const retained = events.findLast(e => e.callId === call.callId && e.turn === call.turn &&
    (e.type === "ToolCalled" && e.name === "harness_acquire" ||
      e.type === "AikoCodeToolStarted" && e.owner === owner && e.tool === "harness_acquire"));
  if (!retained) return undefined;
  // CodeHarness retains its native package call identity. Resolve the epoch from
  // that call when older Started receipts omit it. Legacy initial turns use 0.
  const parent = retained.type === "AikoCodeToolStarted"
    ? events.findLast(e => e.type === "PackageCalled" && e.callId === call.callId && e.turn === call.turn) : undefined;
  const epoch = retained.epoch ?? parent?.epoch ?? 0;
  if (!Number.isSafeInteger(epoch) || Number(epoch) < 0 ||
    !events.some(e => e.type === "MessageReceived" && e.id === call.turn && (e.epoch ?? 0) === epoch && (e.owner === undefined || e.owner === owner))) return undefined;
  return { version: 1, thread, turn: call.turn, callId: call.callId, ...(epoch === 0 ? {} : { epoch: Number(epoch) }) };
}

/** Acquisition is an ordinary native package effect over the existing journal.
 * Shared evaluation identities coalesce builds; each requesting operation keeps
 * its own receipt. A pending/unknown execution is inspected, never redispatched. */
export class HarnessAcquisition {
  readonly library: HarnessLibrary;
  constructor(readonly binding: HarnessLibraryBinding, readonly journal: HarnessJournal,
    readonly definitions: readonly BuiltinHarnessDefinition[] = builtinHarnessDefinitions()) {
    this.library = new HarnessLibrary(binding, journal);
  }
  private emit(type: string, id: string, data: object) {
    return this.journal.append([{ type, id, owner: this.binding.owner, at: Date.now(), ...data }]);
  }
  async catalog() {
    const registered = harnessLibraryState(await this.journal.read(), this.binding.owner);
    return {
      capabilities: this.definitions.map(({ artifact, contract, verifier }) => ({
        name: artifact.name, contractDigest: harnessDigest(contract), contract: structuredClone(contract),
        seedDigest: harnessDigest(artifact), runtime: artifact.runtime,
        status: this.binding.verifiers.get(verifier.digest)?.evaluatorDigest === verifier.evaluatorDigest ? "trusted-template" : "unavailable",
      })),
      active: [...registered.heads.values()].filter(e => e.type === "AikoHarnessPromoted"),
      scope: "fixed-contract-catalog", runtimeChecked: false,
    };
  }
  async acquire(raw: HarnessAcquireInput, signal: AbortSignal, task?: HarnessTaskAssociation): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const beganAt = Date.now();
    const input = structuredClone(raw);
    if (!identifier.test(input.operationId) || !identifier.test(input.name)) throw Error("Invalid acquisition identity");
    this.binding.guard(input);
    const definition = this.definitions.find(d => d.artifact.name === input.name);
    if (!definition) return { status: "unavailable", name: input.name, reason: "trusted-outcome-contract-unavailable", next: "Discover relevant source guidance; a new outcome needs an independently registered contract before executable promotion." };
    const contract = structuredClone(definition.contract), contractDigest = harnessDigest(contract);
    const trusted = this.binding.verifiers.get(contract.verifierDigest);
    if (!trusted || trusted.evaluatorDigest !== contract.evaluatorDigest || harnessDigest(trusted.cases) !== harnessDigest(definition.verifier.cases)) throw Error("Trusted acquisition evaluator unavailable");
    const limits = harnessAcquisitionLimits(contract.timeoutMs, trusted.cases.length);
    const candidate = validateHarnessArtifact(input.candidate ?? definition.artifact);
    if (candidate.name !== input.name || candidate.contractDigest !== contractDigest) throw Error("Candidate must preserve the fixed capability contract");
    this.binding.guard(candidate);
    const context = await this.binding.context(signal), contextDigest = harnessDigest(context);
    const routeKey = harnessDigest([input.name, contractDigest, contextDigest]);
    const requestDigest = harnessDigest([input.name, input.candidate ? harnessDigest(candidate) : null, contextDigest, limits]);
    let events = await this.journal.read();
    if (task && harnessDigest(harnessAcquisitionTask(events, this.binding.owner, this.binding.thread, task) ?? null) !== harnessDigest(task))
      throw Error("Native acquisition task unavailable");
    const request = events.find(e => e.type === "AikoHarnessAcquisitionRequested" && e.owner === this.binding.owner && e.id === input.operationId);
    if (request && request.requestDigest !== requestDigest) throw Error("Acquisition operation identity conflict");
    if (request && task && harnessDigest(request.task ?? null) !== harnessDigest(task)) throw Error("Acquisition task identity conflict");
    signal.throwIfAborted();
    if (!request) await this.emit("AikoHarnessAcquisitionRequested", input.operationId, { requestDigest, name: input.name, contractDigest, contextDigest, candidateDigest: input.candidate ? harnessDigest(candidate) : null, limits, deadlineAt: beganAt + limits.wallMs, ...(task ? { task } : {}) });
    events = await this.journal.read();
    const retainedRequest = events.find(e => e.type === "AikoHarnessAcquisitionRequested" && e.owner === this.binding.owner && e.id === input.operationId);
    if (retainedRequest?.requestDigest !== requestDigest) throw Error("Acquisition operation identity conflict");
    if (harnessDigest(retainedRequest.task ?? null) !== harnessDigest(task ?? null)) throw Error("Acquisition task identity conflict");
    const state = harnessLibraryState(events, this.binding.owner);
    const head = state.heads.get(routeKey);
    const previous = events.find(e => e.type === "AikoHarnessAcquisitionSettled" && e.owner === this.binding.owner && e.id === input.operationId);
    const readiness = async (receipt: Record<string, unknown>): Promise<Record<string, unknown>> => {
      signal.throwIfAborted();
      // Settled acquisition is a historical verification fact. Present readiness
      // is a query over that fact, current permission and the current route.
      // Accept old "ready" receipts as historical facts for compatibility.
      if (receipt.status !== "verified" && receipt.status !== "ready") return receipt;
      const resolved = await this.library.resolve(receipt.harnessDigest as HarnessDigest);
      const example = trusted.cases.find(c => c.split === "development");
      if (!example || !await this.binding.authorize(resolved.artifact, resolved.contract, context, structuredClone(example.input), signal)) return { ...receipt, status: "unavailable", reason: "current-execution-authority-unavailable" };
      signal.throwIfAborted();
      if (harnessDigest(await this.binding.context(signal)) !== contextDigest) return { ...receipt, status: "unavailable", reason: "acquisition-context-changed" };
      const current = harnessLibraryState(await this.journal.read(), this.binding.owner).heads.get(routeKey);
      signal.throwIfAborted();
      if (current?.type !== "AikoHarnessPromoted" || current.harnessDigest !== receipt.harnessDigest || current.generation !== receipt.generation) return { ...receipt, status: "unavailable", reason: "selected-route-retired-or-superseded" };
      return { ...receipt, status: "ready", readiness: "current-route-and-authority-checked" };
    };
    if (previous) return readiness({ ...previous, freshness: "historical-acquisition" });
    const settle = async (data: Record<string, unknown>) => {
      signal.throwIfAborted();
      if (harnessDigest(await this.binding.context(signal)) !== contextDigest) return { status: "unavailable", reason: "acquisition-context-changed", operationId: input.operationId };
      // Never persist unconditional present readiness: retirement may race this
      // append. Verification remains true; readiness is projected after commit.
      await this.emit("AikoHarnessAcquisitionSettled", input.operationId, { requestDigest, name: input.name, contractDigest, contextDigest, ...data, status: data.status === "ready" ? "verified" : data.status });
      const receipt = (await this.journal.read()).find(e => e.type === "AikoHarnessAcquisitionSettled" && e.owner === this.binding.owner && e.id === input.operationId);
      return readiness({ ...receipt, operationId: input.operationId });
    };
    if (head?.type === "AikoHarnessPromoted" && (!input.candidate || head.harnessDigest === harnessDigest(candidate))) {
      const resolved = await this.library.resolve(head.harnessDigest as HarnessDigest);
      const example = trusted.cases.find(c => c.split === "development");
      if (!example || !await this.binding.authorize(resolved.artifact, resolved.contract, context, structuredClone(example.input), signal)) return { status: "unavailable", reason: "current-execution-authority-unavailable" };
      return settle({ status: "ready", harnessDigest: head.harnessDigest, evaluationId: head.evaluationId, generation: head.generation, reused: true });
    }
    if (head?.type === "AikoHarnessRetired") return { status: "unavailable", reason: "capability-retired-requires-explicit-repair", name: input.name };
    // A restart must not buy another full acquisition window. Older retained
    // requests use their original acceptance timestamp and recorded ceiling.
    const recordedDeadline = retainedRequest.deadlineAt;
    const deadlineAt = typeof recordedDeadline === "number" ? recordedDeadline
      : recordedDeadline === undefined && typeof retainedRequest.at === "number" ? retainedRequest.at + limits.wallMs : NaN;
    if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) throw Error("Acquisition deadline expired; inspect retained execution");
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))]);
    deadline.throwIfAborted();
    const evaluationId = `acquire:${harnessDigest([contractDigest, harnessDigest(candidate), contextDigest, limits]).slice(7)}`;
    if (!state.contracts.has(contractDigest)) await this.library.registerContract(contract);
    const artifactDigest = harnessDigest(candidate);
    if (!state.candidates.has(artifactDigest)) await this.library.record(candidate);
    deadline.throwIfAborted();
    const evaluation = await this.library.evaluate(artifactDigest, evaluationId, deadline);
    if (evaluation.type === "AikoHarnessEvaluationPending") return { status: "pending", name: input.name, operationId: input.operationId, harnessDigest: artifactDigest, evaluationId, reason: "existing-evaluation-unsettled" };
    if (evaluation.eligible !== true) {
      const witnesses = harnessLibraryState(await this.journal.read(), this.binding.owner).witnesses;
      const uncertain = (evaluation.witnessIds as string[]).some(id => !witnesses.has(id) || witnesses.get(id)?.status === "unknown");
      return settle({ status: uncertain ? "unknown" : "failed", harnessDigest: artifactDigest, evaluationId, reason: uncertain ? "evaluation-outcome-unconfirmed" : "fixed-contract-evaluation-failed", reused: false });
    }
    const currentHead = harnessLibraryState(await this.journal.read(), this.binding.owner).heads.get(routeKey);
    // A concurrently promoted different implementation is a separate decision.
    // Do not overwrite a winner using a newly read generation as a blank cheque.
    if (currentHead && (currentHead.type !== "AikoHarnessPromoted" || currentHead.harnessDigest !== artifactDigest) && currentHead.generation !== head?.generation) return { status: "unavailable", reason: "acquisition-route-changed", harnessDigest: artifactDigest, evaluationId };
    const promoted = await this.library.promote(artifactDigest, evaluationId, Number(head?.generation ?? 0), deadline);
    return settle({ status: "ready", harnessDigest: artifactDigest, evaluationId, generation: promoted.generation, reused: false });
  }
}

/** A fixed catalog gives the actor actionable schemas. Acquisition accepts code
 * for one of those outcomes, but never accepts a verifier, dataset or new grant. */
export function harnessAcquisitionTools(binding: HarnessLibraryBinding, definitions = builtinHarnessDefinitions()): NativeTool<Self | EventLog>[] {
  const schemas = {
    catalog: { type: "object", properties: {}, additionalProperties: false },
    acquire: { type: "object", properties: { name: { type: "string" }, operationId: { type: "string" }, candidate: { type: "object" } }, required: ["name", "operationId"], additionalProperties: false },
  };
  return (["catalog", "acquire"] as const).map(method => ({
    spec: {
      name: method === "catalog" ? "harness_capabilities" : "harness_acquire",
      description: method === "catalog" ? "Inspect trusted capability contracts and retained active routes without starting a VM. Cases and evaluation answers are private to the checker." : "Acquire a reusable capability under an existing fixed contract: reuse a current verified route, or build/evaluate/promote its seed or your immutable candidate in the sandbox. Supply name and operationId, optionally candidate. Check status; unavailable means a trusted contract or current authority is missing. Acquisition does not execute the user's input. Use harness_run/call and harness_output after ready.",
      inputSchema: schemas[method],
    },
    run: (raw: unknown, call) => Effect.gen(function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.thread || !new Validator(schemas[method] as never).validate(raw).valid) return { status: "rejected" };
      const acquisition = new HarnessAcquisition(binding, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) }, definitions);
      const task = method === "acquire" && call ? harnessAcquisitionTask(yield* log.read, binding.owner, binding.thread, call) : undefined;
      return yield* Effect.tryPromise({ try: signal => method === "catalog" ? acquisition.catalog() : acquisition.acquire(raw as HarnessAcquireInput, signal, task), catch: () => Error("Acquisition unconfirmed; inspect existing receipts before repair") }).pipe(Effect.catch(() => Effect.succeed({ status: "unavailable", reason: "acquisition-unconfirmed", instruction: "Inspect the retained operation; do not replay an uncertain execution." })));
    }),
  }));
}
