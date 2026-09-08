import { harnessDigest, type HarnessDigest, type HarnessWitness } from "./harness-library.ts";

export type HarnessMetric = "latencyMs" | "costUsd" | "networkRequests" | "browserStarts" | "modelCalls" | "tokens";
export interface HarnessObjective { metric: HarnessMetric; direction: "min" | "max"; tolerance: number }
export interface HarnessComparisonPolicy {
  version: 1;
  /** Ordered preferences select among nondominated candidates. */
  objectives: HarnessObjective[];
  qualityTolerance: number;
}
export interface HarnessTrial {
  phase: "development" | "held-out";
  caseId: string;
  repeat: number;
  witness: HarnessWitness;
  /** Independently retained trial accounting can include reset/admission overhead.
   * An explicitly missing measurement must not fall back to a narrower one. */
  accounting?: Partial<Record<HarnessMetric, number | null>>;
}
/** Observed range, not a confidence interval or a tail-latency estimate. */
export interface ObservedRange { min: number; max: number; mean: number; n: number }
export interface HarnessComparison {
  harnessDigest: HarnessDigest;
  comparisonContext: HarnessDigest;
  eligible: boolean;
  qualityByCase: Record<string, ObservedRange | null>;
  metrics: Record<HarnessMetric, ObservedRange | null>;
  statuses: Record<HarnessWitness["status"], number>;
}
const metrics: HarnessMetric[] = ["latencyMs", "costUsd", "networkRequests", "browserStarts", "modelCalls", "tokens"];
const range = (values: (number | null | undefined)[]): ObservedRange | null =>
  !values.length || values.some(v => typeof v !== "number" || !Number.isFinite(v)) ? null : {
    min: Math.min(...values as number[]), max: Math.max(...values as number[]),
    mean: (values as number[]).reduce((a, b) => a + b, 0) / values.length, n: values.length,
  };
export function validateHarnessComparisonPolicy(policy: HarnessComparisonPolicy) {
  if (policy?.version !== 1 || !Array.isArray(policy.objectives) || !policy.objectives.length || policy.objectives.length > metrics.length ||
      new Set(policy.objectives.map(o => o.metric)).size !== policy.objectives.length ||
      policy.objectives.some(o => !metrics.includes(o.metric) || !["min", "max"].includes(o.direction) || !Number.isFinite(o.tolerance) || o.tolerance < 0) ||
      !Number.isFinite(policy.qualityTolerance) || policy.qualityTolerance < 0) throw Error("Invalid fixed comparison policy");
  return structuredClone(policy);
}

/** All trials, including failures, contribute metrics. Missing observations stay null. */
export function compareHarnessTrials(input: {
  harnessDigest: HarnessDigest; contextDigest: HarnessDigest; evaluatorDigest: HarnessDigest;
  datasetDigest: HarnessDigest; regimeDigest: HarnessDigest; policy: HarnessComparisonPolicy;
  cases: { id: string; split: HarnessTrial["phase"] }[]; repeats: number; trials: HarnessTrial[];
}): HarnessComparison {
  const policy = validateHarnessComparisonPolicy(input.policy), { trials, cases, repeats } = input;
  if (!Number.isSafeInteger(repeats) || repeats < 1 || !cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw Error("Invalid trial design");
  const byKey = new Map(trials.map(t => [harnessDigest([t.phase, t.caseId, t.repeat]), t]));
  const expected = cases.flatMap(c => Array.from({ length: repeats }, (_, repeat) => harnessDigest([c.split, c.id, repeat])));
  if (byKey.size !== trials.length || new Set(trials.map(t => t.witness.operationId)).size !== trials.length || trials.some(t => !expected.includes(harnessDigest([t.phase, t.caseId, t.repeat])) ||
      t.witness.harnessDigest !== input.harnessDigest || t.witness.contextDigest !== input.contextDigest || t.witness.evaluatorDigest !== input.evaluatorDigest)) throw Error("Trial identity or context mismatch");
  const complete = expected.every(key => byKey.has(key));
  const statuses = { satisfied: 0, violated: 0, unknown: 0, blocked: 0 };
  for (const trial of trials) statuses[trial.witness.status]++;
  const qualityByCase = Object.fromEntries(cases.map(c => {
    const matching = trials.filter(t => t.phase === c.split && t.caseId === c.id);
    return [harnessDigest([c.split, c.id]), matching.length === repeats ? range(matching.map(t => t.witness.quality)) : null];
  }));
  const measured = Object.fromEntries(metrics.map(metric => {
    const samples = Array.from({ length: repeats }, (_, repeat) => {
      const matching = trials.filter(t => t.repeat === repeat);
      if (matching.length !== cases.length) return null;
      const values = matching.map(t => t.accounting && Object.hasOwn(t.accounting, metric) ? t.accounting[metric]
        : metric === "latencyMs" || metric === "costUsd" ? t.witness[metric] : t.witness.measurements?.[metric]);
      return values.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0) ? (values as number[]).reduce((a, b) => a + b, 0) : null;
    });
    return [metric, complete ? range(samples) : null];
  })) as Record<HarnessMetric, ObservedRange | null>;
  return {
    harnessDigest: input.harnessDigest,
    comparisonContext: harnessDigest([input.contextDigest, input.evaluatorDigest, input.datasetDigest, input.regimeDigest, policy, cases, repeats]),
    eligible: complete && trials.length > 0 && statuses.satisfied === trials.length,
    qualityByCase, metrics: measured, statuses,
  };
}
export function harnessNoQualityRegression(candidate: HarnessComparison, baseline: HarnessComparison, policy: HarnessComparisonPolicy) {
  return candidate.eligible && baseline.eligible && candidate.comparisonContext === baseline.comparisonContext &&
    harnessDigest(Object.keys(candidate.qualityByCase).sort()) === harnessDigest(Object.keys(baseline.qualityByCase).sort()) &&
    Object.entries(baseline.qualityByCase).every(([key, before]) => {
      const after = candidate.qualityByCase[key];
      return before !== null && after !== null && after !== undefined && after.min >= before.max - policy.qualityTolerance;
    });
}
export function harnessDominates(a: HarnessComparison, b: HarnessComparison, policy: HarnessComparisonPolicy) {
  if (!harnessNoQualityRegression(a, b, policy)) return false;
  let better = false;
  for (const objective of policy.objectives) {
    const av = a.metrics[objective.metric], bv = b.metrics[objective.metric];
    if (!av || !bv) return false;
    // Conservative observed-range dominance. Tolerance defines meaningful gain,
    // not permission to call a numerically worse resource outcome dominant.
    if (objective.direction === "min") {
      if (av.max > bv.min) return false;
      better ||= av.max < bv.min - objective.tolerance;
    } else {
      if (av.min < bv.max) return false;
      better ||= av.min > bv.max + objective.tolerance;
    }
  }
  return better;
}
export function harnessParetoFrontier(candidates: HarnessComparison[], policy: HarnessComparisonPolicy) {
  validateHarnessComparisonPolicy(policy);
  const eligible = candidates.filter(c => c.eligible);
  return eligible.filter(c => !eligible.some(other => other !== c && harnessDominates(other, c, policy)));
}
/** Preferences only rank fully measured frontier members within one context. */
export function selectHarnessFrontier(candidates: HarnessComparison[], policy: HarnessComparisonPolicy) {
  const contexts = new Set(candidates.map(c => c.comparisonContext));
  if (contexts.size > 1) throw Error("Incomparable evaluation contexts");
  return harnessParetoFrontier(candidates, policy).filter(c => Object.values(c.qualityByCase).every(q => q !== null) && policy.objectives.every(o => c.metrics[o.metric] !== null)).sort((a, b) => {
    for (const o of policy.objectives) {
      const delta = a.metrics[o.metric]!.mean - b.metrics[o.metric]!.mean;
      if (Math.abs(delta) > o.tolerance) return o.direction === "min" ? delta : -delta;
    }
    return a.harnessDigest.localeCompare(b.harnessDigest);
  })[0];
}
