import type { Event } from "tardie/core/event";
import type { HarnessDigest } from "./harness-library.ts";
import type { HarnessExperimentLimits } from "./harness-experiment.ts";
import { isModelBudgetDenial } from "./model-budget-denial.ts";
const isDigest = (v: unknown): v is HarnessDigest => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
export type ExperimentState = {
  registered?: Event;
  candidates: HarnessDigest[];
  trials: Map<string, Event>;
  reservations: Map<string, Event>;
  proposals: Map<string, Event>;
  noHypothesis?: Event;
  tokenExceeded?: Event;
  budgetDenied?: Event;
  closed?: Event;
  cancelled?: Event;
  settled?: Event;
};

/** Validate the exact already-admitted proposal, not merely an owner-matched
 * error body. Public ingress cannot mint these reserved native receipt types. */
export function harnessReflectionBudgetDenial(event: Event, history: readonly Event[]) {
  if (event.type !== "AikoHarnessReflectionSettled" || event.status !== "budget-exhausted" ||
    !isModelBudgetDenial(event.denial) || event.denial.owner !== event.owner ||
    event.physicalCalls !== 0 || event.tokens !== null || event.costUsd !== null ||
    typeof event.at !== "number" || !Number.isSafeInteger(event.at) ||
    Object.hasOwn(event, "responseRef") || Object.hasOwn(event, "responseDigest")) return false;
  const rows = history.filter(e => e.owner === event.owner && e.experimentId === event.experimentId);
  const registered = rows.find(e => e.type === "AikoHarnessExperimentRegistered");
  const reservation = rows.find(e => e.type === "AikoHarnessExperimentReserved" && e.id === event.id);
  const request = rows.find(e => e.type === "AikoHarnessReflectionRequested" && e.id === event.id);
  return !!registered && !!reservation && !!request && reservation.kind === "proposal" &&
    typeof reservation.claimId === "string" && request.reservationClaimId === reservation.claimId &&
    event.reservationClaimId === reservation.claimId && request.claimId === event.claimId &&
    typeof event.claimId === "string" && isDigest(event.parentDigest) &&
    request.parentDigest === event.parentDigest && reservation.parentDigest === event.parentDigest &&
    isDigest(event.requestDigest) && request.requestDigest === event.requestDigest &&
    isDigest(event.policyDigest) && request.policyDigest === event.policyDigest &&
    request.requestedMaxTokens === reservation.maxTokens && event.requestedMaxTokens === reservation.maxTokens &&
    request.deadlineAt === registered.deadlineAt && event.at >= Number(request.at) && event.at < Number(registered.deadlineAt) &&
    !rows.some(e => ["AikoHarnessExperimentCancelled", "AikoHarnessExperimentSettled", "AikoHarnessExperimentSearchClosed"].includes(e.type)) &&
    !rows.some(e => e.id === event.id && (e.type === "AikoHarnessReflectionSettled" ||
      e.type === "AikoHarnessExperimentProposalSettled" ||
      e.type === "AikoHarnessExperimentProposalMeasured" && Number(e.physicalCalls) > 0));
}
/** Metadata projection only. It never invokes preparation, inference or execution. */
export function harnessExperimentState(events: readonly Event[], owner: string, id: string): ExperimentState {
  const result: ExperimentState = { candidates: [], trials: new Map(), reservations: new Map(), proposals: new Map() };
  const reflectionCaps = new Map<string, number>();
  const history: Event[] = [];
  for (const e of events) {
    if (e.owner !== owner || e.experimentId !== id) continue;
    if (e.type === "AikoHarnessExperimentRegistered") { result.registered ??= e; if (isDigest(e.baselineDigest)) result.candidates.push(e.baselineDigest); }
    if (e.type === "AikoHarnessExperimentReserved") result.reservations.set(String(e.id), e);
    if (e.type === "AikoHarnessReflectionRequested" && typeof e.maxTokens === "number" && Number.isSafeInteger(e.maxTokens) && e.maxTokens > 0) reflectionCaps.set(String(e.id), e.maxTokens);
    if (e.type === "AikoHarnessExperimentProposalMeasured" && result.registered) {
      const limit = Math.min(Number((result.registered.limits as HarnessExperimentLimits | undefined)?.proposalTokens ?? Infinity),
        Number(result.reservations.get(String(e.id))?.maxTokens ?? Infinity), reflectionCaps.get(String(e.id)) ?? Infinity);
      if (typeof e.tokens === "number" && Number.isSafeInteger(e.tokens) && e.tokens > limit) result.tokenExceeded ??= e;
    }
    if (e.type === "AikoHarnessExperimentTrialSettled") result.trials.set(String(e.id), e);
    if (e.type === "AikoHarnessExperimentProposalSettled") {
      result.proposals.set(String(e.id), e);
      if (e.status === "no-hypothesis") result.noHypothesis ??= e;
      if (isDigest(e.harnessDigest) && !result.candidates.includes(e.harnessDigest)) result.candidates.push(e.harnessDigest);
    }
    if (e.type === "AikoHarnessExperimentSearchClosed") result.closed ??= e;
    if (e.type === "AikoHarnessExperimentCancelled") result.cancelled ??= e;
    if (e.type === "AikoHarnessExperimentSettled") result.settled ??= e;
    if (harnessReflectionBudgetDenial(e, history)) result.budgetDenied ??= e;
    history.push(e);
  }
  return result;
}

/** Host append fence, composed with the library's existing key/route fencing. */
export function harnessExperimentAppendAllowed(batch: readonly Event[], read: () => readonly Event[]) {
  const history = [...read()];
  for (const e of batch) {
    if (e.type === "AikoHarnessExperimentSettled" && e.reason === "daily-model-budget-exhausted") {
      const state = harnessExperimentState(history, String(e.owner), String(e.experimentId));
      if (e.status !== "budget-exhausted" || !state.budgetDenied || state.cancelled || state.settled) return false;
    }
    if (e.type === "AikoHarnessReflectionSettled") {
      const previous = history.find(p => p.type === e.type && p.owner === e.owner && p.id === e.id);
      if (e.status === "budget-exhausted" && !harnessReflectionBudgetDenial(e, history) ||
        previous?.status === "budget-exhausted") return false;
    }
    if (e.type === "AikoHarnessExperimentReserved") {
      const state = harnessExperimentState(history, String(e.owner), String(e.experimentId));
      const limits = state.registered?.limits as HarnessExperimentLimits | undefined;
      if (!limits || state.settled || state.cancelled || state.noHypothesis || state.tokenExceeded || state.budgetDenied || !["trial", "proposal"].includes(String(e.kind))) return false;
      if (state.reservations.has(String(e.id))) { history.push(e); continue; }
      const previous = [...state.reservations.values()];
      if (previous.filter(p => p.kind === e.kind).length >= (e.kind === "trial" ? limits.runs : limits.candidates)) return false;
      if (e.kind === "proposal" && state.closed) return false;
      if (typeof e.at !== "number" || e.at >= Number(state.registered?.deadlineAt)) return false;
      if (e.costCeilingUsd !== null && (typeof e.costCeilingUsd !== "number" || !Number.isFinite(e.costCeilingUsd) || e.costCeilingUsd < 0)) return false;
      if (e.costCeilingUsd !== null && previous.reduce((sum, p) => sum + Number(p.costCeilingUsd ?? 0), 0) + e.costCeilingUsd > limits.costUsd) return false;
    }
    if (e.type === "AikoHarnessExperimentHeldOutOpened") {
      const state = harnessExperimentState(history, String(e.owner), String(e.experimentId));
      if (state.noHypothesis || state.tokenExceeded || state.budgetDenied || history.some(p => p.type === e.type && p.owner === e.owner && p.datasetDigest === e.datasetDigest && p.evaluatorDigest === e.evaluatorDigest && p.experimentId !== e.experimentId)) return false;
    }
    if (e.type === "AikoHarnessPromoted") {
      const evaluation = history.find(p => p.type === "AikoHarnessEvaluated" && p.owner === e.owner && p.id === e.evaluationId);
      if (typeof evaluation?.experimentId === "string") {
        const state = harnessExperimentState(history, String(e.owner), evaluation.experimentId);
        if (!state.registered || state.cancelled || state.settled || state.noHypothesis || state.tokenExceeded || state.budgetDenied || !state.closed || typeof e.at !== "number" || e.at >= Number(state.registered.deadlineAt)) return false;
      }
    }
    history.push(e);
  }
  return true;
}

/** Keep known phase costs even if another phase's cost is unavailable. */
export function harnessExperimentKnownCost(events: readonly Event[], owner: string, id: string) {
  return events.filter(e => e.owner === owner && e.experimentId === id).reduce((total, e) => {
    const amount = e.type === "AikoHarnessExperimentPrepared" || e.type === "AikoHarnessExperimentProposalMeasured" ? e.costUsd
      : e.type === "AikoHarnessExperimentTrialSettled" ? e.executionCostUsd : undefined;
    return total + (typeof amount === "number" && Number.isFinite(amount) && amount >= 0 ? amount : 0);
  }, 0);
}

/** One retained snapshot supplies the same metadata to tools and owner control
 * routes, including when no executable library or private brief is available. */
export function harnessExperimentStatus(events: readonly Event[], owner: string, id: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) throw Error("Invalid experiment identity");
  const state = harnessExperimentState(events, owner, id);
  if (!state.registered) throw Error("Owned experiment unavailable");
  const trials = [...state.trials.values()], proposals = [...state.proposals.values()];
  const costs = [...trials, ...proposals].map(row => row.costUsd);
  return {
    id,
    status: state.settled ? String(state.settled.status) : state.cancelled ? "cancelling" : "pending",
    candidates: state.candidates,
    trials: trials.length,
    proposals: proposals.length,
    reservedRuns: [...state.reservations.values()].filter(row => row.kind === "trial").length,
    costUsd: costs.length && costs.every(cost => typeof cost === "number" && Number.isFinite(cost) && cost >= 0)
      ? (costs as number[]).reduce((sum, cost) => sum + cost, 0) : null,
    knownCostUsd: harnessExperimentKnownCost(events, owner, id),
    deadlineAt: state.registered.deadlineAt,
    ...(state.settled ? { result: state.settled } : {}),
  };
}
