import { harnessDigest } from "./harness-library.ts";
import { CONTRIBUTION_POLICY, type ProactiveContribution } from "./proactive-policy.ts";
import type { openMemory } from "./memory.ts";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";

export function isContributionInference(request: InferRequest, owner?: string) {
  const retained = request.trajectory.findLast(e => e.type === "MessageReceived" && e.id === request.identity.turn)?.output;
  return (owner ? request.identity.thread === `background-${owner}-reflection` : /^background-.+-reflection$/.test(request.identity.thread)) &&
    !!retained && typeof retained === "object" && "name" in retained && retained.name === "aiko_contributions_v2";
}

/** Select a bounded native provider using the retained invocation contract. */
export function withContributionInference(base: Layer.Layer<Infer>, bounded: Layer.Layer<Infer>) {
  return Layer.effect(Infer, Effect.gen(function* () {
    const original = yield* Infer;
    return { ...original, react: (request: InferRequest, key?: string, signal?: AbortSignal) => isContributionInference(request)
      ? Effect.gen(function* () { return yield* (yield* Infer).react(request, key, signal); }).pipe(Effect.provide(bounded))
      : original.react(request, key, signal) };
  })).pipe(Layer.provide(base));
}

const score = { type: "integer" } as const;
export const CONTRIBUTION_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    version: { type: "integer" }, reason: { type: "string" },
    contributions: { type: "array", items: {
      type: "object", properties: {
        decision: { type: "string", enum: ["notify", "defer", "propose"] },
        text: { type: "string" },
        reason: { type: "string" },
        supports: { type: "array", items: { type: "string" } },
        delayMs: { type: "integer" },
        relevance: score, usefulness: score, urgency: score, novelty: score, interruptionCost: score,
      },
      required: ["decision", "text", "reason", "supports", "delayMs", "relevance", "usefulness", "urgency", "novelty", "interruptionCost"],
      additionalProperties: false,
    } },
  },
  required: ["version", "reason", "contributions"], additionalProperties: false,
} as const;

export interface ReflectionCandidate {
  decision: "notify" | "defer" | "propose";
  text: string;
  reason: string;
  supports: string[];
  delayMs: number;
  relevance: number;
  usefulness: number;
  urgency: number;
  novelty: number;
  interruptionCost: number;
}
export interface RetainedContribution {
  id: string;
  text: string;
  reason: string;
  supports: string[];
  policyVersion: typeof CONTRIBUTION_POLICY;
  contribution: ProactiveContribution;
  assessment: Pick<ReflectionCandidate, "relevance" | "usefulness" | "urgency" | "novelty" | "interruptionCost">;
}

/** Called only after output-contract validation. Ranking never supplies
 * authority, freshness or a confidence probability. All proposed citations
 * must occur in the exact retained context and include new trigger evidence. */
export function retainContributions(candidates: ReflectionCandidate[], input: {
  owner: string; cause: string; at: number; now: number;
  changed: readonly string[]; allowed: readonly string[];
  memory: ReturnType<typeof openMemory>; redact(text: string): string;
}): { contributions: RetainedContribution[]; omitted: string[] } {
  const contributions: RetainedContribution[] = [], omitted: string[] = [];
  if (candidates.length > 3 || candidates.some(c => !c.text.trim() || c.text.length > 1200 || !c.reason.trim() || c.reason.length > 500 ||
    c.supports.length < 1 || c.supports.length > 8 || new Set(c.supports).size !== c.supports.length ||
    !Number.isInteger(c.delayMs) || c.delayMs < 0 || c.delayMs > 3_600_000 ||
    [c.relevance, c.usefulness, c.urgency, c.novelty, c.interruptionCost].some(s => !Number.isInteger(s) || s < 0 || s > 4)))
    return { contributions, omitted: ["invalid-contribution-bounds"] };
  if (!Number.isSafeInteger(input.at) || input.at < 0 || input.now >= input.at + 86_400_000 || input.at > input.now)
    return { contributions, omitted: ["trigger-expired-or-invalid"] };
  const ranked = candidates.map((c, order) => ({ c, order, value: c.relevance + c.usefulness + c.urgency + c.novelty - c.interruptionCost }))
    .sort((a, b) => b.value - a.value || a.order - b.order);
  for (const { c, value } of ranked.slice(0, 3)) {
    if (c.relevance < 2 || c.usefulness < 2 || value < 6) { omitted.push("insufficient-usefulness"); continue; }
    const triggerSupports = c.supports.filter(id => input.changed.includes(id));
    if (!triggerSupports.length || c.supports.some(id => !input.allowed.includes(id)) || input.redact(JSON.stringify(c)) !== JSON.stringify(c)) {
      omitted.push("unsupported-contribution"); continue;
    }
    const hits = c.supports.map(id => input.memory.get(id));
    if (hits.some(h => !h || h.state !== "current" || h.freshness === "stale")) { omitted.push("stale-contribution"); continue; }
    // Identity uses subjects and observations, never generated wording. Changes
    // to the same subjects can replace an unsent older proposal.
    const subjects = [...new Set(triggerSupports.map(id => input.memory.get(id)!.observation.subject))].sort();
    const topic = harnessDigest(["aiko-reflection-contribution/v2", input.owner, subjects]);
    if (contributions.some(p => p.contribution.topic === topic)) { omitted.push("duplicate-topic"); continue; }
    const id = harnessDigest(["aiko-contribution/v2", input.owner, topic, [...c.supports].sort()]);
    contributions.push({ id, text: c.text, reason: c.reason, supports: c.supports, policyVersion: CONTRIBUTION_POLICY,
      assessment: { relevance: c.relevance, usefulness: c.usefulness, urgency: c.urgency, novelty: c.novelty, interruptionCost: c.interruptionCost },
      contribution: { version: 2, topic, trigger: input.cause, triggerSupports,
        createdAt: input.at,
        notBefore: input.at + (c.decision === "defer" ? Math.max(1, c.delayMs) : 0), expiresAt: input.at + 86_400_000,
        action: c.decision === "propose" ? "propose" : "notify" },
    });
  }
  return { contributions, omitted };
}
