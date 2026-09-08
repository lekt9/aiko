import { harnessExperimentState, harnessExperimentKnownCost, harnessExperimentStatus, type ExperimentState } from "./harness-experiment-log.ts";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { intent } from "tardie/core/intent";
import { actorMethod } from "tardie/core/method/method";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { turnHead } from "tardie/code/execution/turns";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { HarnessExperimentTrials, type HarnessExperimentTrialResult } from "./harness-experiment-trials.ts";
import {
  HarnessLibrary, harnessDigest, harnessLibraryState, validateHarnessArtifact,
  type HarnessArtifact, type HarnessCase, type HarnessDigest, type HarnessJournal,
  type HarnessLibraryBinding, type HarnessWitness,
} from "./harness-library.ts";
import {
  compareHarnessTrials, harnessDominates, harnessNoQualityRegression, harnessParetoFrontier,
  selectHarnessFrontier, validateHarnessComparisonPolicy,
  type HarnessComparison, type HarnessComparisonPolicy, type HarnessTrial,
} from "./harness-pareto.ts";

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const isDigest = (v: unknown): v is HarnessDigest => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
// Measurement identity only. It grants no execution/recovery authority. A new
// process cannot report elapsed time from another process's monotonic clock.
// Workers allow randomness inside a request, not during module evaluation.
let trialClockEpoch: string | undefined;
const currentTrialClockEpoch = () => trialClockEpoch ??= randomUUID();
export interface HarnessExperimentLimits {
  candidates: number; runs: number; wallMs: number;
  proposalTokens: number; costUsd: number;
}
export interface HarnessExperimentRequest {
  id: string;
  baselineDigest: HarnessDigest;
  mutableFiles: string[];
  repeats: number;
  policy: HarnessComparisonPolicy;
  limits: HarnessExperimentLimits;
}
export interface HarnessExperimentBrief extends HarnessExperimentRequest {
  version: 1;
  contractDigest: HarnessDigest; verifierDigest: HarnessDigest; evaluatorDigest: HarnessDigest;
  datasetDigest: HarnessDigest; contextDigest: HarnessDigest; regimeDigest: HarnessDigest;
  initialGeneration: number; routeKey: HarnessDigest; deadlineAt: number;
}
export interface HarnessDevelopmentFeedback {
  harnessDigest: HarnessDigest;
  comparison: HarnessComparison;
  /** No fixture input/output or held-out trajectory is supplied to reflection. */
  evidence: { operationId: string; caseId: string; repeat: number; status: HarnessWitness["status"]; evidence: string[] }[];
}
export interface HarnessExperimentBinding {
  library: HarnessLibraryBinding;
  /** Production hosts supply native child trials. Standalone controller callers
   * without this adapter retain the existing local execution/recovery behavior. */
  trials?: HarnessExperimentTrials;
  /** Pin fixture reset protocol, input revision, model settings and cold/warm state. */
  regime: Record<string, string>;
  authorize(action: "start" | "advance" | "propose" | "promote" | "cancel", brief: HarnessExperimentBrief, signal: AbortSignal): Promise<boolean>;
  /** Called once per reserved trial, before the candidate. Reset mutable resources
   * and establish the declared cache regime; an interrupted reset is not repeated. */
  prepare(input: { experimentId: string; operationId: string; fixture: HarnessCase; regimeDigest: HarnessDigest }, signal: AbortSignal): Promise<{ regimeDigest: HarnessDigest; evidence: string[]; costUsd: number | null; measurements?: HarnessWitness["measurements"] }>;
  /** Trusted host adapter uses its existing model/effect transport. Honor maxTokens
   * and signal. Candidate code cannot access this binding or the fixed checker. */
  propose(input: { experimentId: string; operationId: string; parent: HarnessArtifact; parentDigest: HarnessDigest; mutableFiles: string[]; feedback: HarnessDevelopmentFeedback[]; maxTokens: number }, signal: AbortSignal): Promise<{
    hypothesis: string;
    files: Record<string, string> | null;
    tokens: number | null;
    costUsd: number | null;
  }>;
  /** Read an already retained proposal only. This path never opens another model
   * attempt when its original acknowledgement or controller settlement was lost. */
  recoverProposal?(input: { experimentId: string; operationId: string; parentDigest: HarnessDigest; maxTokens: number }, signal: AbortSignal): Promise<Awaited<ReturnType<HarnessExperimentBinding["propose"]>> | undefined>;
  /** Conservative maximum total cost of one prepare+run/check or proposal.
   * Missing ceilings use fixed run/call/token caps; measured cost stays unavailable. */
  costCeilingUsd?: { trial: number; proposal: number };
}
export { harnessExperimentState, harnessExperimentAppendAllowed } from "./harness-experiment-log.ts";
async function bounded<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => { abort = () => reject(Error("Experiment interrupted")); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }), cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
const nonnegative = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const validCost = (v: unknown): v is number | null => v === null || nonnegative(v);
const retainedTrialElapsed = (prepared: Event): number | null => {
  if (prepared.clockEpoch !== currentTrialClockEpoch() || !nonnegative(prepared.startedAtMonotonic)) return null;
  const elapsed = performance.now() - prepared.startedAtMonotonic;
  return nonnegative(elapsed) ? elapsed : null;
};
const trialAccounting = (prepared: Event, witness: HarnessWitness, elapsedMs: number | null): HarnessTrial["accounting"] => {
  const measurement = prepared.measurements as HarnessWitness["measurements"];
  const sum = (a: unknown, b: unknown) => nonnegative(a) && nonnegative(b) ? a + b : null;
  return { latencyMs: elapsedMs, costUsd: sum(prepared.costUsd, witness.costUsd),
    networkRequests: sum(measurement?.networkRequests, witness.measurements?.networkRequests),
    browserStarts: sum(measurement?.browserStarts, witness.measurements?.browserStarts),
    modelCalls: sum(measurement?.modelCalls, witness.measurements?.modelCalls), tokens: sum(measurement?.tokens, witness.measurements?.tokens),
  };
};

/** One durable state transition per advance. Native effects provide scheduling;
 * this controller has no timers, work queue or process-local recovery authority. */
export class HarnessExperiment {
  readonly library: HarnessLibrary;
  constructor(readonly binding: HarnessExperimentBinding, readonly journal: HarnessJournal) {
    if (binding.trials && (!(binding.trials instanceof HarnessExperimentTrials) || binding.trials.options.binding !== binding.library)) throw Error("Experiment trial library mismatch");
    this.library = new HarnessLibrary(binding.library, journal);
  }
  private async emit(type: string, id: string, experimentId: string, data: object = {}) {
    await this.journal.append([{ type: `AikoHarnessExperiment${type}`, id, experimentId, owner: this.binding.library.owner, at: Date.now(), ...data }]);
  }
  private async state(id: string) { return harnessExperimentState(await this.journal.read(), this.binding.library.owner, id); }
  private async brief(id: string) {
    const state = await this.state(id);
    if (!state.registered) throw Error("Owned experiment unavailable");
    const brief = await this.binding.library.blobs.get(this.binding.library.owner, state.registered.briefRef as HarnessDigest) as HarnessExperimentBrief;
    if (harnessDigest(brief) !== state.registered.briefDigest || brief.id !== id) throw Error("Experiment brief integrity mismatch");
    return brief;
  }
  private async current(brief: HarnessExperimentBrief, action: Parameters<HarnessExperimentBinding["authorize"]>[0], signal: AbortSignal) {
    signal.throwIfAborted();
    if (!await this.binding.authorize(action, structuredClone(brief), signal) || harnessDigest(this.binding.regime) !== brief.regimeDigest) throw Error("Current experiment authority or regime unavailable");
    const { artifact, contract, verifier } = await this.library.resolve(brief.baselineDigest);
    if (artifact.contractDigest !== brief.contractDigest || contract.verifierDigest !== brief.verifierDigest || contract.evaluatorDigest !== brief.evaluatorDigest || harnessDigest(verifier.cases) !== brief.datasetDigest || harnessDigest(await this.binding.library.context(signal)) !== brief.contextDigest) throw Error("Frozen experiment evaluation changed");
    signal.throwIfAborted();
    if (action !== "start" && action !== "cancel" && (await this.state(brief.id)).cancelled) throw Error("Experiment cancelled");
    return { artifact, contract, verifier };
  }
  async start(raw: HarnessExperimentRequest, signal: AbortSignal) {
    const request = structuredClone(raw);
    if (!identifier.test(request.id) || !isDigest(request.baselineDigest) || !Array.isArray(request.mutableFiles) || !request.mutableFiles.length || request.mutableFiles.length > 16 || new Set(request.mutableFiles).size !== request.mutableFiles.length || !Number.isSafeInteger(request.repeats) || request.repeats < 2 || request.repeats > 8) throw Error("Invalid experiment request");
    validateHarnessComparisonPolicy(request.policy);
    const limits = request.limits;
    if (!limits || !Number.isSafeInteger(limits.candidates) || limits.candidates < 1 || limits.candidates > 3 || !Number.isSafeInteger(limits.runs) || limits.runs < 1 || limits.runs > 48 || !Number.isSafeInteger(limits.wallMs) || limits.wallMs < 1 || limits.wallMs > 1200000 || !Number.isSafeInteger(limits.proposalTokens) || limits.proposalTokens < 1 || limits.proposalTokens > 32768 || !nonnegative(limits.costUsd)) throw Error("Invalid bounded experiment limits");
    if (this.binding.costCeilingUsd && !Object.values(this.binding.costCeilingUsd).every(nonnegative)) throw Error("Invalid trusted cost ceiling");
    const prior = await this.state(request.id);
    if (prior.registered) {
      if (prior.registered.requestDigest !== harnessDigest(request)) throw Error("Experiment identity conflict");
      return this.status(request.id);
    }
    const { artifact, contract, verifier } = await this.library.resolve(request.baselineDigest);
    if (request.mutableFiles.some(path => !Object.hasOwn(artifact.files, path))) throw Error("Mutable surface outside baseline files");
    const cases = verifier.cases;
    if (!cases.length || cases.length > 16 || !cases.some(c => c.split === "development") || !cases.some(c => c.split === "held-out") || new Set(cases.map(c => c.id)).size !== cases.length || cases.some(c => !identifier.test(c.id))) throw Error("Fixed development and held-out cases required");
    if (limits.runs < cases.length * request.repeats * 2) throw Error("Insufficient budget for baseline and one complete comparison");
    this.binding.library.guard(request);
    const contextDigest = harnessDigest(await this.binding.library.context(signal));
    const routeKey = harnessDigest([artifact.name, artifact.contractDigest, contextDigest]);
    const head = harnessLibraryState(await this.journal.read(), this.binding.library.owner).heads.get(routeKey);
    if (head?.type !== "AikoHarnessPromoted" || head.harnessDigest !== request.baselineDigest) throw Error("Current stable baseline required");
    const brief: HarnessExperimentBrief = { ...request, version: 1, contractDigest: artifact.contractDigest, verifierDigest: contract.verifierDigest, evaluatorDigest: contract.evaluatorDigest, datasetDigest: harnessDigest(cases), contextDigest, regimeDigest: harnessDigest(this.binding.regime), initialGeneration: Number(head.generation), routeKey, deadlineAt: Date.now() + limits.wallMs };
    await this.current(brief, "start", signal);
    const briefRef = await this.binding.library.blobs.putPrivate(this.binding.library.owner, brief);
    signal.throwIfAborted();
    await this.emit("Registered", request.id, request.id, { briefRef, briefDigest: harnessDigest(brief), requestDigest: harnessDigest(request), baselineDigest: brief.baselineDigest, contractDigest: brief.contractDigest, verifierDigest: brief.verifierDigest, evaluatorDigest: brief.evaluatorDigest, datasetDigest: brief.datasetDigest, contextDigest, regimeDigest: brief.regimeDigest, limits, deadlineAt: brief.deadlineAt });
    if ((await this.state(request.id)).registered?.requestDigest !== harnessDigest(request)) throw Error("Experiment identity conflict");
    return this.status(request.id);
  }
  async status(id: string) {
    if (!identifier.test(id)) throw Error("Invalid experiment identity");
    return harnessExperimentStatus(await this.journal.read(), this.binding.library.owner, id);
  }
  async cancel(id: string, signal: AbortSignal) {
    const brief = await this.brief(id);
    if (!await this.binding.authorize("cancel", brief, signal)) throw Error("Experiment cancellation authority unavailable");
    await this.emit("Cancelled", id, id);
    return this.status(id);
  }
  private async settle(brief: HarnessExperimentBrief, status: string, reason: string, extra: object = {}) {
    await this.emit("Settled", brief.id, brief.id, { status, reason, ...extra });
    return this.status(brief.id);
  }
  private async reserve(brief: HarnessExperimentBrief, id: string, kind: "trial" | "proposal", data: object, signal: AbortSignal) {
    signal.throwIfAborted();
    const state = await this.state(brief.id);
    if (state.settled || state.cancelled || state.noHypothesis || state.tokenExceeded || state.budgetDenied || Date.now() >= brief.deadlineAt) return "stopped";
    if (state.reservations.has(id)) return "uncertain";
    const all = [...state.reservations.values()], max = kind === "trial" ? brief.limits.runs : brief.limits.candidates;
    const ceiling = this.binding.costCeilingUsd?.[kind] ?? null;
    const knownCost = harnessExperimentKnownCost(await this.journal.read(), this.binding.library.owner, brief.id);
    if (all.filter(r => r.kind === kind).length >= max || knownCost >= brief.limits.costUsd || ceiling !== null && (knownCost + ceiling > brief.limits.costUsd || all.reduce((sum, r) => sum + Number(r.costCeilingUsd ?? 0), 0) + ceiling > brief.limits.costUsd)) return "budget";
    const claimId = randomUUID();
    await this.emit("Reserved", id, brief.id, { kind, claimId, costCeilingUsd: ceiling, ...data });
    return (await this.state(brief.id)).reservations.get(id)?.claimId === claimId ? "owned" : "uncertain";
  }
  private trialId(brief: HarnessExperimentBrief, hash: HarnessDigest, fixture: HarnessCase, repeat: number) { return `experiment:${harnessDigest([brief.id, hash, fixture.split, fixture.id, repeat]).slice(7)}`; }
  private async comparisons(brief: HarnessExperimentBrief, state: ExperimentState, cases: readonly HarnessCase[], hashes = state.candidates): Promise<HarnessComparison[]> {
    const library = harnessLibraryState(await this.journal.read(), this.binding.library.owner);
    return hashes.map(hash => {
      const trials: HarnessTrial[] = [];
      for (const c of cases) for (let repeat = 0; repeat < brief.repeats; repeat++) {
        const id = this.trialId(brief, hash, c, repeat), retained = state.trials.get(id), witness = library.witnesses.get(id);
        if (!retained || !witness || retained.witnessDigest !== harnessDigest(witness)) continue;
        trials.push({ phase: c.split, caseId: c.id, repeat, witness, accounting: retained.accounting as HarnessTrial["accounting"] });
      }
      return compareHarnessTrials({ harnessDigest: hash, contextDigest: brief.contextDigest, evaluatorDigest: brief.evaluatorDigest, datasetDigest: brief.datasetDigest, regimeDigest: brief.regimeDigest, policy: brief.policy, cases: cases.map(c => ({ id: c.id, split: c.split })), repeats: brief.repeats, trials });
    });
  }
  private async childTrial(brief: HarnessExperimentBrief, hash: HarnessDigest, fixture: HarnessCase, repeat: number, prepared: Event, signal: AbortSignal) {
    const trials = this.binding.trials!, id = this.trialId(brief, hash, fixture, repeat), owner = this.binding.library.owner;
    await this.current(brief, "advance", signal);
    if (harnessExperimentKnownCost(await this.journal.read(), owner, brief.id) >= brief.limits.costUsd ||
      this.binding.costCeilingUsd && prepared.costUsd !== null && Number(prepared.costUsd) > this.binding.costCeilingUsd.trial)
      return this.settle(brief, "budget-exhausted", "preparation-cost-limit-reached");
    let result: HarnessExperimentTrialResult;
    try {
      result = await bounded(() => trials.request({ experimentId: brief.id, harnessDigest: hash, phase: fixture.split,
        caseId: fixture.id, repeat, operationId: id, contextDigest: brief.contextDigest, deadlineAt: brief.deadlineAt }, signal), signal);
    } catch {
      // Requested/Work may already be retained. Native child receipt or the
      // experiment's absolute deadline owns recovery; never dispatch a fallback.
      return { ...await this.status(brief.id), status: "unknown", reason: "native-trial-needs-retained-evidence-or-deadline" };
    }
    if (result.status === "pending") return this.status(brief.id);
    if (result.status !== "checked") return this.settle(brief, result.status, `native-trial-${result.status}`);
    await this.current(brief, "advance", signal);
    const { witness } = result;
    const rows = await this.journal.read(), joined = rows.find(e => e.type === "AikoHarnessTrialJoined" && e.owner === owner && e.id === id);
    const childRows = await trials.options.readThread(result.childThread);
    const started = childRows.find(e => e.type === "AikoHarnessRunStarted" && e.owner === owner && e.id === id);
    if (!joined || joined.experimentId !== brief.id || joined.status !== "checked" || joined.childThread !== result.childThread ||
      joined.witnessRef !== result.witnessRef || joined.witnessDigest !== harnessDigest(witness) || joined.inputRef !== started?.inputRef ||
      started?.harnessDigest !== hash || started.caseId !== fixture.id || started.contextDigest !== brief.contextDigest || !isDigest(started.inputRef) ||
      witness.harnessDigest !== hash || witness.contractDigest !== brief.contractDigest || witness.operationId !== id ||
      witness.contextDigest !== brief.contextDigest || witness.evaluatorDigest !== brief.evaluatorDigest || witness.verifierDigest !== brief.verifierDigest ||
      harnessDigest(await this.binding.library.blobs.get(owner, result.witnessRef)) !== harnessDigest(witness) ||
      harnessDigest(await this.binding.library.blobs.get(owner, started.inputRef)) !== harnessDigest(fixture.input)) throw Error("Native trial witness join unavailable");
    await this.current(brief, "advance", signal);
    await this.emit("TrialWitness", id, brief.id, { harnessDigest: hash, phase: fixture.split, caseId: fixture.id, repeat,
      inputRef: started.inputRef, childThread: result.childThread, briefRef: joined.briefRef,
      witnessRef: result.witnessRef, witnessDigest: harnessDigest(witness), witness });
    const retained = harnessLibraryState(await this.journal.read(), owner).witnesses.get(id);
    if (!retained || harnessDigest(retained) !== harnessDigest(witness)) throw Error("Native trial witness projection unavailable");
    const costUsd = prepared.costUsd === null || witness.costUsd === null ? null : Number(prepared.costUsd) + witness.costUsd;
    await this.emit("TrialSettled", id, brief.id, { harnessDigest: hash, phase: fixture.split, caseRef: harnessDigest(fixture.id), repeat,
      childThread: result.childThread, witnessRef: result.witnessRef, witnessDigest: harnessDigest(witness), status: witness.status,
      costUsd, executionCostUsd: witness.costUsd, accounting: trialAccounting(prepared, witness, retainedTrialElapsed(prepared)) });
    if (this.binding.costCeilingUsd && costUsd !== null && costUsd > this.binding.costCeilingUsd.trial) return this.settle(brief, "budget-exhausted", "trusted-trial-cost-ceiling-exceeded");
    if (witness.status === "unknown") return this.settle(brief, "unknown", "trial-outcome-unconfirmed");
    return this.status(brief.id);
  }
  private async trial(brief: HarnessExperimentBrief, hash: HarnessDigest, fixture: HarnessCase, repeat: number, signal: AbortSignal) {
    const id = this.trialId(brief, hash, fixture, repeat);
    const reservation = await this.reserve(brief, id, "trial", { harnessDigest: hash, phase: fixture.split, caseRef: harnessDigest(fixture.id), repeat }, signal);
    if (reservation === "uncertain") {
      // A concurrent owner may still be running. Only retained checked evidence
      // can close this trial; a follower cannot overwrite the owner's outcome.
      const events = await this.journal.read(), owner = this.binding.library.owner;
      const prepared = events.find(e => e.type === "AikoHarnessExperimentPrepared" && e.owner === owner && e.experimentId === brief.id && e.id === id);
      if (this.binding.trials) {
        if (prepared?.regimeDigest !== brief.regimeDigest || !validCost(prepared.costUsd)) return { ...await this.status(brief.id), status: "unknown", reason: "existing-trial-needs-retained-preparation" };
        try { return await this.childTrial(brief, hash, fixture, repeat, prepared, signal); }
        catch { return { ...await this.status(brief.id), status: "unknown", reason: "native-trial-needs-retained-evidence-or-deadline" }; }
      }
      const started = events.find(e => e.type === "AikoHarnessRunStarted" && e.owner === owner && e.id === id);
      const witness = harnessLibraryState(events, owner).witnesses.get(id);
      if (prepared?.regimeDigest === brief.regimeDigest && validCost(prepared.costUsd) && started?.harnessDigest === hash && started.caseId === fixture.id && started.contextDigest === brief.contextDigest && witness?.harnessDigest === hash && witness.contextDigest === brief.contextDigest && witness.evaluatorDigest === brief.evaluatorDigest && witness.verifierDigest === brief.verifierDigest) {
        await this.emit("TrialSettled", id, brief.id, { harnessDigest: hash, phase: fixture.split, caseRef: harnessDigest(fixture.id), repeat, witnessDigest: harnessDigest(witness), status: witness.status, executionCostUsd: witness.costUsd, costUsd: prepared.costUsd === null || witness.costUsd === null ? null : prepared.costUsd + witness.costUsd, accounting: trialAccounting(prepared, witness, null) });
        if (witness.status === "unknown") return this.settle(brief, "unknown", "trial-outcome-unconfirmed");
        return this.status(brief.id);
      }
      return { ...await this.status(brief.id), status: "unknown", reason: "existing-trial-needs-retained-evidence" };
    }
    if (reservation !== "owned") return this.settle(brief, reservation === "budget" ? "budget-exhausted" : "unknown", `trial-${reservation}`);
    try {
      const beganAt = performance.now();
      await this.current(brief, "advance", signal);
      const { artifact, contract } = await this.library.resolve(hash);
      const fixtureAllowed = async () => artifact.contractDigest === brief.contractDigest && await this.binding.library.authorizeEvaluation?.(structuredClone(artifact), structuredClone(contract), await this.binding.library.context(signal), structuredClone(fixture), signal) === true;
      if (!await fixtureAllowed()) return this.settle(brief, "blocked", "controlled-fixture-authorization-required");
      const preparation = await bounded(() => this.binding.prepare({ experimentId: brief.id, operationId: id, fixture: structuredClone(fixture), regimeDigest: brief.regimeDigest }, signal), signal);
      if (preparation.regimeDigest !== brief.regimeDigest || !preparation.evidence.length || !validCost(preparation.costUsd)) throw Error("Fixture preparation evidence mismatch");
      this.binding.library.guard(preparation.evidence);
      if (preparation.measurements && Object.values(preparation.measurements).some(v => v !== null && (!Number.isSafeInteger(v) || v < 0))) throw Error("Invalid preparation measurement");
      const prepared: Event = { type: "AikoHarnessExperimentPrepared", regimeDigest: preparation.regimeDigest, evidence: preparation.evidence, costUsd: preparation.costUsd,
        clockEpoch: currentTrialClockEpoch(), startedAtMonotonic: beganAt, ...(preparation.measurements ? { measurements: preparation.measurements } : {}) };
      const { type: _type, ...preparationData } = prepared;
      await this.emit("Prepared", id, brief.id, preparationData);
      if (harnessExperimentKnownCost(await this.journal.read(), this.binding.library.owner, brief.id) >= brief.limits.costUsd || this.binding.costCeilingUsd && preparation.costUsd !== null && preparation.costUsd > this.binding.costCeilingUsd.trial) return this.settle(brief, "budget-exhausted", "preparation-cost-limit-reached");
      if (!await fixtureAllowed()) return this.settle(brief, "blocked", "controlled-fixture-authorization-revoked");
      await this.current(brief, "advance", signal);
      if ((await this.state(brief.id)).cancelled) throw Error("Experiment cancelled");
      if (this.binding.trials) {
        try { return await this.childTrial(brief, hash, fixture, repeat, prepared, signal); }
        catch { return { ...await this.status(brief.id), status: "unknown", reason: "native-trial-needs-retained-evidence-or-deadline" }; }
      }
      const witness = await this.library.run(hash, fixture.input, id, signal, { caseId: fixture.id, expectedContext: brief.contextDigest });
      const retained = harnessLibraryState(await this.journal.read(), this.binding.library.owner).witnesses.get(id);
      if (!retained || harnessDigest(retained) !== harnessDigest(witness)) throw Error("Trial witness unavailable");
      const costUsd = preparation.costUsd === null || witness.costUsd === null ? null : preparation.costUsd + witness.costUsd;
      await this.emit("TrialSettled", id, brief.id, { harnessDigest: hash, phase: fixture.split, caseRef: harnessDigest(fixture.id), repeat, witnessDigest: harnessDigest(witness), status: witness.status, costUsd, executionCostUsd: witness.costUsd, accounting: trialAccounting(prepared, witness, performance.now() - beganAt) });
      if (this.binding.costCeilingUsd && costUsd !== null && costUsd > this.binding.costCeilingUsd.trial) return this.settle(brief, "budget-exhausted", "trusted-trial-cost-ceiling-exceeded");
      if (witness.status === "unknown") return this.settle(brief, "unknown", "trial-outcome-unconfirmed");
      return this.status(brief.id);
    } catch {
      return this.settle(brief, (await this.state(brief.id)).cancelled ? "cancelled" : "unknown", "trial-preparation-or-execution-unconfirmed");
    }
  }
  private async proposal(brief: HarnessExperimentBrief, state: ExperimentState, cases: readonly HarnessCase[], comparisons: HarnessComparison[], signal: AbortSignal) {
    const baseline = comparisons[0]!;
    const pool = comparisons.filter(c => c.harnessDigest === baseline.harnessDigest || harnessNoQualityRegression(c, baseline, brief.policy));
    const parent = selectHarnessFrontier(pool, brief.policy) ?? baseline;
    const id = `proposal:${harnessDigest([brief.id, state.proposals.size]).slice(7)}`;
    const reservation = await this.reserve(brief, id, "proposal", { parentDigest: parent.harnessDigest, maxTokens: brief.limits.proposalTokens }, signal);
    const lookup = { experimentId: brief.id, operationId: id, parentDigest: parent.harnessDigest, maxTokens: brief.limits.proposalTokens };
    const recovered = reservation === "uncertain" && this.binding.recoverProposal ? await this.binding.recoverProposal(lookup, signal).catch(() => undefined) : undefined;
    if (reservation === "uncertain" && !recovered) return { ...await this.status(brief.id), status: "unknown", reason: "existing-proposal-needs-retained-evidence" };
    if (reservation !== "owned" && !recovered) return this.settle(brief, reservation === "budget" ? "budget-exhausted" : "unknown", `proposal-${reservation}`);
    try {
      await this.current(brief, "propose", signal);
      const { artifact } = await this.library.resolve(parent.harnessDigest);
      const library = harnessLibraryState(await this.journal.read(), this.binding.library.owner);
      const feedback: HarnessDevelopmentFeedback[] = comparisons.map(comparison => ({ harnessDigest: comparison.harnessDigest, comparison, evidence: cases.flatMap(c => Array.from({ length: brief.repeats }, (_, repeat) => {
        const operationId = this.trialId(brief, comparison.harnessDigest, c, repeat), w = library.witnesses.get(operationId)!;
        return { operationId, caseId: c.id, repeat, status: w.status, evidence: w.evidence };
      })) }));
      this.binding.library.guard(feedback);
      const feedbackRef = await this.binding.library.blobs.putPrivate(this.binding.library.owner, feedback);
      const response = structuredClone(recovered ?? await bounded(() => this.binding.propose(structuredClone({ experimentId: brief.id, operationId: id, parent: artifact, parentDigest: parent.harnessDigest, mutableFiles: brief.mutableFiles, feedback, maxTokens: brief.limits.proposalTokens }), signal), signal));
      await this.emit("ProposalMeasured", id, brief.id, { costUsd: validCost(response.costUsd) ? response.costUsd : null, tokens: Number.isSafeInteger(response.tokens) && Number(response.tokens) >= 0 ? response.tokens : null });
      await this.current(brief, "propose", signal);
      if ((await this.state(brief.id)).cancelled) throw Error("Experiment cancelled");
      if (!validCost(response.costUsd) || !(response.tokens === null || Number.isSafeInteger(response.tokens) && response.tokens >= 0 && response.tokens <= brief.limits.proposalTokens) || typeof response.hypothesis !== "string" || response.hypothesis.length > 4000) throw Error("Invalid proposal measurement or hypothesis");
      this.binding.library.guard(response);
      if (this.binding.costCeilingUsd && response.costUsd !== null && response.costUsd > this.binding.costCeilingUsd.proposal) throw Error("Proposal cost ceiling exceeded");
      const hypothesisRef = await this.binding.library.blobs.putPrivate(this.binding.library.owner, response.hypothesis);
      if (response.files === null || !response.hypothesis.trim()) {
        await this.emit("ProposalSettled", id, brief.id, { parentDigest: parent.harnessDigest, feedbackRef, hypothesisRef, tokens: response.tokens, costUsd: response.costUsd, status: "no-hypothesis" });
        return this.settle(brief, "retained-baseline", "no-supported-hypothesis");
      }
      if (typeof response.files !== "object" || Array.isArray(response.files) || !Object.keys(response.files).length || Object.keys(response.files).some(path => !brief.mutableFiles.includes(path) || typeof response.files![path] !== "string")) throw Error("Proposal changed frozen surface");
      const files = { ...artifact.files, ...response.files };
      const candidate = validateHarnessArtifact({ ...artifact, files, dependencies: artifact.dependencies.map(d => Object.hasOwn(response.files!, d.name) ? { ...d, digest: harnessDigest(files[d.name]) } : d) });
      if (harnessDigest(candidate) === parent.harnessDigest || state.candidates.includes(harnessDigest(candidate))) {
        await this.emit("ProposalSettled", id, brief.id, { parentDigest: parent.harnessDigest, feedbackRef, hypothesisRef, tokens: response.tokens, costUsd: response.costUsd, status: "unchanged" });
        await this.closeSearch(brief, comparisons);
        return this.status(brief.id);
      }
      const sourceDiffRef = await this.binding.library.blobs.putPrivate(this.binding.library.owner, Object.keys(response.files).map(path => ({ path, before: artifact.files[path], after: files[path] })));
      const candidateDigest = await this.library.record(candidate);
      await this.emit("ProposalSettled", id, brief.id, { harnessDigest: candidateDigest, parentDigest: parent.harnessDigest, feedbackRef, hypothesisRef, sourceDiffRef, tokens: response.tokens, costUsd: response.costUsd, status: "candidate" });
      return this.status(brief.id);
    } catch {
      const interrupted = await this.state(brief.id);
      if (interrupted.cancelled) return this.settle(brief, "cancelled", "owner-cancelled");
      if (interrupted.budgetDenied) return this.settle(brief, "budget-exhausted", "daily-model-budget-exhausted");
      if (interrupted.tokenExceeded) return this.settle(brief, "budget-exhausted", "proposal-token-limit-exceeded");
      if (this.binding.recoverProposal && !(await this.state(brief.id)).cancelled) return { ...await this.status(brief.id), status: "unknown", reason: "proposal-needs-retained-evidence-or-deadline" };
      return this.settle(brief, (await this.state(brief.id)).cancelled ? "cancelled" : "unknown", "proposal-unconfirmed-or-frozen-surface-rejected");
    }
  }
  private async closeSearch(brief: HarnessExperimentBrief, comparisons: HarnessComparison[]) {
    const baseline = comparisons[0]!;
    const eligible = comparisons.filter(c => c.harnessDigest === baseline.harnessDigest || harnessNoQualityRegression(c, baseline, brief.policy));
    const survivors = [...new Set([baseline.harnessDigest, ...harnessParetoFrontier(eligible, brief.policy).map(c => c.harnessDigest)])];
    await this.emit("SearchClosed", brief.id, brief.id, { survivors, policyDigest: harnessDigest(brief.policy), developmentComparisonRef: await this.binding.library.blobs.putPrivate(this.binding.library.owner, comparisons) });
  }
  async advance(id: string, callerSignal: AbortSignal) {
    const brief = await this.brief(id);
    let state = await this.state(id);
    if (state.settled) return this.status(id);
    if (state.cancelled) return this.settle(brief, "cancelled", "owner-cancelled");
    // The proposal receipt is itself a stop boundary, including a crash before
    // settlement. Do not expose the held-out set merely to retain the baseline.
    if (state.noHypothesis) return this.settle(brief, "retained-baseline", "no-supported-hypothesis");
    if (state.tokenExceeded) return this.settle(brief, "budget-exhausted", "proposal-token-limit-exceeded");
    if (state.budgetDenied) return this.settle(brief, "budget-exhausted", "daily-model-budget-exhausted");
    if (Date.now() >= brief.deadlineAt) return this.settle(brief, "budget-exhausted", "absolute-deadline-expired");
    const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(Math.max(1, brief.deadlineAt - Date.now()))]);
    let cases: readonly HarnessCase[];
    try { cases = structuredClone((await this.current(brief, "advance", signal)).verifier.cases); }
    catch { return this.settle(brief, (await this.state(id)).cancelled ? "cancelled" : "blocked", "current-authority-or-frozen-context-unavailable"); }
    if (harnessExperimentKnownCost(await this.journal.read(), this.binding.library.owner, id) >= brief.limits.costUsd) return this.settle(brief, "budget-exhausted", "measured-cost-limit-reached");
    const development = cases.filter(c => c.split === "development");
    if (!state.closed) {
      for (const hash of state.candidates) for (const fixture of development) for (let repeat = 0; repeat < brief.repeats; repeat++) {
        if (!state.trials.has(this.trialId(brief, hash, fixture, repeat))) return this.trial(brief, hash, fixture, repeat, signal);
      }
      const comparisons = await this.comparisons(brief, state, development);
      if (!comparisons[0]?.eligible) return this.settle(brief, "retained-baseline", "baseline-development-contract-failed");
      if (state.proposals.size < brief.limits.candidates) return this.proposal(brief, state, development, comparisons, signal);
      await this.closeSearch(brief, comparisons);
      return this.status(id);
    }
    const survivors = state.closed.survivors as HarnessDigest[];
    const events = await this.journal.read();
    const opened = events.find(e => e.type === "AikoHarnessExperimentHeldOutOpened" && e.owner === this.binding.library.owner && e.datasetDigest === brief.datasetDigest && e.evaluatorDigest === brief.evaluatorDigest);
    if (opened && opened.experimentId !== id) return this.settle(brief, "blocked", "held-out-set-already-exposed-use-new-final-set");
    if (!opened) {
      await this.emit("HeldOutOpened", harnessDigest([brief.datasetDigest, brief.evaluatorDigest]), id, { datasetDigest: brief.datasetDigest, evaluatorDigest: brief.evaluatorDigest, survivors });
      return this.status(id);
    }
    for (const hash of survivors) for (const fixture of cases.filter(c => c.split === "held-out")) for (let repeat = 0; repeat < brief.repeats; repeat++) {
      if (!state.trials.has(this.trialId(brief, hash, fixture, repeat))) return this.trial(brief, hash, fixture, repeat, signal);
    }
    state = await this.state(id);
    const comparisons = await this.comparisons(brief, state, cases, survivors), baseline = comparisons.find(c => c.harnessDigest === brief.baselineDigest)!;
    const eligible = comparisons.filter(c => c.harnessDigest === baseline.harnessDigest || harnessNoQualityRegression(c, baseline, brief.policy));
    const frontier = harnessParetoFrontier(eligible, brief.policy);
    const selected = selectHarnessFrontier(frontier, brief.policy);
    const comparisonRef = await this.binding.library.blobs.putPrivate(this.binding.library.owner, comparisons);
    const report = { comparisonRef, policyDigest: harnessDigest(brief.policy), frontier: frontier.map(c => c.harnessDigest), selectedDigest: selected?.harnessDigest ?? brief.baselineDigest, baselineDigest: brief.baselineDigest, uncertainty: "observed-repeat-range-not-confidence-interval" };
    if (!selected || selected.harnessDigest === baseline.harnessDigest || !harnessDominates(selected, baseline, brief.policy)) return this.settle(brief, "retained-baseline", "held-out-gate-or-insufficient-comparable-improvement", report);
    await this.current(brief, "advance", signal);
    if (!await this.binding.authorize("promote", structuredClone(brief), signal)) return this.settle(brief, "review-required", "private-promotion-policy-unavailable", report);
    if ((await this.state(id)).cancelled || Date.now() >= brief.deadlineAt) return this.settle(brief, "cancelled", "cancelled-before-promotion", report);
    const evaluationId = `experiment:${harnessDigest([id, selected.harnessDigest, "final"]).slice(7)}`;
    const witnessIds = cases.flatMap(c => Array.from({ length: brief.repeats }, (_, repeat) => this.trialId(brief, selected.harnessDigest, c, repeat)));
    await this.journal.append([{ type: "AikoHarnessEvaluated", id: evaluationId, owner: this.binding.library.owner, at: Date.now(), harnessDigest: selected.harnessDigest, contractDigest: brief.contractDigest, evaluatorDigest: brief.evaluatorDigest, datasetDigest: brief.datasetDigest, contextDigest: brief.contextDigest, eligible: true, witnessIds, experimentId: id, comparisonRef, latencyMs: selected.metrics.latencyMs?.mean ?? null, costUsd: selected.metrics.costUsd?.mean ?? null }]);
    try {
      await this.current(brief, "promote", signal);
      const head = await this.library.promote(selected.harnessDigest, evaluationId, brief.initialGeneration, signal);
      return this.settle(brief, "promoted", "fixed-held-out-comparison-passed", { ...report, evaluationId, generation: head.generation });
    } catch { return this.settle(brief, (await this.state(id)).cancelled ? "cancelled" : "retained-baseline", "promotion-authority-or-route-changed", report); }
  }
}

/** One native method deadline keeps idle experiments wakeable across host restarts.
 * Its state is a log projection; expiry never depends on process-local timers. */
export const harnessExperimentWaitMethod = actorMethod({
  input: Schema.Struct({ experimentId: Schema.String }), output: Schema.String,
  event: call => ({ type: "AikoHarnessExperimentDeadline", id: call.invocation.id,
    experimentId: call.input.experimentId, at: call.at,
    call: { invocation: call.invocation, deadlineAt: call.deadlineAt } }),
  projection: {
    initial: () => [] as Event[], step: (s: Event[], e: Event) => [...s, e],
    output: events => ({ currentEpoch: () => 0, invocationState: invocation => {
      const record = events.find(e => e.type === "AikoHarnessExperimentDeadline" && (e.call as any)?.invocation.id === invocation.id);
      if (!record) return undefined;
      const state = harnessExperimentState(events, String(record.owner), String(record.experimentId));
      return state.settled || state.cancelled || events.some(e => e.type === "AlarmFired" && Number(e.at) >= Number((record.call as any).deadlineAt))
        ? { status: "completed" as const, output: "settled" } : { status: "pending" as const };
    } }),
  },
});

/** Optional trusted mount. The host supplies reflection and controlled fixture
 * adapters; merely exposing an experiment tool creates no grant or provider call. */
export function harnessExperimentComponent(binding: HarnessExperimentBinding) {
  return experimentComponent(binding.library.owner, binding);
}

/** Retained deadlines and cancellation outlive permission to execute. Hosts mount
 * this projection when reflection, the sandbox or its execution grant is absent.
 * It needs no private brief, model, library or sandbox and cannot start work. */
export function harnessExperimentLifecycle(owner: string) {
  return experimentComponent(owner);
}

function experimentComponent(owner: string, binding?: HarnessExperimentBinding) {
  return component({ name: "aiko.harness-experiments", initial: () => [] as Event[], step: (s: Event[], e: Event) => [...s, e],
    output: events => {
      const ids = [...new Set(events.filter(e => e.type === "AikoHarnessExperimentRegistered" && e.owner === owner).map(e => String(e.experimentId)))];
      const live = ids.map(id => ({ id, state: harnessExperimentState(events, owner, id) })).filter(r => !r.state.settled);
      const deadlines = live.flatMap(({ id, state }) => {
        if (events.some(e => e.type === "AikoHarnessExperimentDeadline" && e.owner === owner && e.experimentId === id)) return [];
        return [intent({ key: `aiko-harness:${owner}:AikoHarnessExperimentDeadline:${id}`, input: { id, deadlineAt: Number(state.registered!.deadlineAt) },
          events: (input, at) => [{ ...harnessExperimentWaitMethod.event({ invocation: { method: "harnessExperimentWait", id: input.id, epoch: 0 }, input: { experimentId: input.id }, deadlineAt: input.deadlineAt, at }), owner }] })];
      });
      const terminal = live.find(({ state }) => state.cancelled || state.noHypothesis || state.tokenExceeded || state.budgetDenied || events.some(e => e.type === "AlarmFired" && Number(e.at) >= Number(state.registered!.deadlineAt)));
      if (terminal) return { view: undefined, transitions: [...deadlines, intent({ key: `aiko-harness:${owner}:AikoHarnessExperimentSettled:${terminal.id}`,
        input: { id: terminal.id, cancelled: !!terminal.state.cancelled, noHypothesis: !!terminal.state.noHypothesis, tokenExceeded: !!terminal.state.tokenExceeded, budgetDenied: !!terminal.state.budgetDenied }, events: (input, at) => [{ type: "AikoHarnessExperimentSettled", id: input.id, experimentId: input.id, owner, at,
          status: input.cancelled ? "cancelled" : input.noHypothesis ? "retained-baseline" : "budget-exhausted", reason: input.cancelled ? "owner-cancelled" : input.noHypothesis ? "no-supported-hypothesis" : input.tokenExceeded ? "proposal-token-limit-exceeded" : input.budgetDenied ? "daily-model-budget-exhausted" : "absolute-deadline-expired" }] })] };
      // Arm deadlines even while foreground work is active; it must not postpone
      // cancellation or leave an uncertain reservation asleep past its budget.
      if (!binding || turnHead(events)) return { view: undefined, transitions: deadlines };
      const pending = ids.filter(id => !harnessExperimentState(events, owner, id).settled).map(id => ({ id,
        deadlineAt: Number(harnessExperimentState(events, owner, id).registered!.deadlineAt),
        progressId: harnessDigest([id, events.filter(e => e.owner === owner && e.experimentId === id && e.type !== "AikoHarnessExperimentAdvanced").length]),
      })).find(p => !events.some(e => e.type === "AikoHarnessExperimentAdvanced" && e.id === p.progressId && e.owner === owner));
      if (!pending) return { view: undefined, transitions: deadlines };
      const { id, progressId, deadlineAt } = pending;
      return { view: undefined, transitions: [...deadlines, effect({ key: `aiko-harness:${owner}:AikoHarnessExperimentAdvanced:${progressId}`, input: { id, progressId, deadlineAt },
        interrupts: (input, event) => event.type === "AikoHarnessExperimentCancelled" && event.owner === owner && event.experimentId === input.id || event.type === "AlarmFired" && Number(event.at) >= input.deadlineAt,
        act: (input, signal) => Effect.gen(function* () {
        const self = yield* Self, log = yield* EventLog;
        if (self.actor !== "aiko" || self.thread !== binding.library.thread) throw Error("Experiment actor scope mismatch");
        const experiment = new HarnessExperiment(binding, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) });
        const result = yield* Effect.tryPromise({ try: () => experiment.advance(input.id, signal), catch: () => Error("Experiment unavailable") }).pipe(Effect.catch(() => Effect.succeed({ status: "unavailable" })));
        return [{ type: "AikoHarnessExperimentAdvanced", owner, experimentId: input.id, id: input.progressId, status: result.status, at: Date.now() }];
      }) })] };
    },
  });
}
export function harnessExperimentTools(binding: HarnessExperimentBinding): NativeTool<Self | EventLog>[] {
  const boundedInteger = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });
  const requestSchema = { type: "object", properties: {
    id: { type: "string", pattern: identifier.source }, baselineDigest: { type: "string", pattern: "^sha256:[a-f0-9]{64}$" },
    mutableFiles: { type: "array", minItems: 1, maxItems: 16, uniqueItems: true, items: { type: "string" } }, repeats: boundedInteger(2, 8),
    policy: { type: "object", properties: { version: { const: 1 }, qualityTolerance: { type: "number", minimum: 0 }, objectives: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", properties: { metric: { enum: ["latencyMs", "costUsd", "networkRequests", "browserStarts", "modelCalls", "tokens"] }, direction: { enum: ["min", "max"] }, tolerance: { type: "number", minimum: 0 } }, required: ["metric", "direction", "tolerance"], additionalProperties: false } } }, required: ["version", "qualityTolerance", "objectives"], additionalProperties: false },
    limits: { type: "object", properties: { candidates: boundedInteger(1, 3), runs: boundedInteger(1, 48), wallMs: boundedInteger(1, 1200000), proposalTokens: { ...boundedInteger(1, 32768), description: "Maximum generated model tokens per proposal; a count, not a credential." }, costUsd: { type: "number", minimum: 0 } }, required: ["candidates", "runs", "wallMs", "proposalTokens", "costUsd"], additionalProperties: false },
  }, required: ["id", "baselineDigest", "mutableFiles", "repeats", "policy", "limits"], additionalProperties: false };
  return (["start", "status", "cancel"] as const).map(method => ({
    spec: { name: `harness_experiment_${method}`, description: method === "start" ? "Register a bounded experiment over a current stable harness. Preserve fixed contracts and fixture sets; specify file-only mutation scope, repeat count, resource objectives/tolerances and limits. Trusted host policy controls preparation, reflection and private promotion. Native effects advance it after the foreground turn." : `Read or cancel this owner's durable harness experiment. No input/output fixtures are returned.`, inputSchema: method === "start" ? { type: "object", properties: { request: requestSchema }, required: ["request"], additionalProperties: false } : { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
    run: (raw: unknown) => Effect.gen(function* () {
      const self = yield* Self, log = yield* EventLog;
      if (self.actor !== "aiko" || self.thread !== binding.library.thread) return { status: "rejected" };
      const experiment = new HarnessExperiment(binding, { read: () => Effect.runPromise(log.read), append: events => Effect.runPromise(log.append(events)).then(() => undefined) });
      return yield* Effect.tryPromise({ try: signal => method === "start" ? experiment.start((raw as any).request, signal) : method === "cancel" ? experiment.cancel((raw as any).id, signal) : experiment.status((raw as any).id), catch: () => Error("Experiment unavailable") }).pipe(Effect.catch(() => Effect.succeed({ status: "unavailable" })));
    }),
  }));
}
