import { Schema } from "effect";
import { actorMethod } from "tardie/core/method/method";
import type { Event } from "tardie/core/event";
import { HarnessLibrary, harnessDigest, harnessLibraryState, type HarnessLibraryBinding, type HarnessJournal } from "./harness-library.ts";
import { harnessAcquisitionTask, type HarnessTaskAssociation } from "./harness-acquisition.ts";
import { harnessSourcePin, sourceAwareHarnessBinding } from "./harness-sources.ts";
import { openMemory, type MemoryBinding } from "./memory.ts";
import { workNoticeCurrent } from "./commitments.ts";

/** A contribution is a proposed owner update, not an execution grant. The
 * producer binds timing and identity to retained evidence, outside model text. */
export interface ProactiveContribution {
  version: 2;
  topic: string;
  trigger: string;
  triggerSupports: string[];
  createdAt: number;
  expiresAt: number;
  notBefore: number;
  action: "notify" | "propose";
}
export const CONTRIBUTION_POLICY = "aiko-contributions/v2";
export const CONTRIBUTION_LIMIT = 16;
export type ContributionMode = "disabled" | "shadow" | "enabled";

/** Rollback is a retained cutoff, so reenabling cannot resurrect old work. */
export function contributionRolloutStatus(events: readonly Event[], owner: string, decisionId: string) {
  const position = events.findIndex(e => e.type === "AikoProactiveDecision" && e.id === decisionId && e.owner === owner);
  const policies = events.filter(e => e.type === "AikoProactiveContributionPolicy" && e.owner === owner);
  if (!policies.length) return undefined; // Unmanaged/legacy test assemblies.
  const current = policies.at(-1)!;
  if (current.mode !== "enabled") return current.mode === "shadow" ? "contribution-shadow" : "contribution-disabled";
  const initial = events.slice(0, position).findLast(e => e.type === "AikoProactiveContributionPolicy" && e.owner === owner);
  if (initial && initial.mode !== "enabled" || events.slice(position + 1).some(e =>
    e.type === "AikoProactiveContributionPolicy" && e.owner === owner && e.mode !== "enabled")) return "contribution-policy-retired";
  return undefined;
}

export function validContribution(value: unknown, at: number): value is ProactiveContribution {
  if (!value || typeof value !== "object") return false;
  const c = value as ProactiveContribution;
  return keys(c, ["version", "topic", "trigger", "triggerSupports", "createdAt", "expiresAt", "notBefore", "action"]) &&
    c.version === 2 && digest(c.topic) && typeof c.trigger === "string" && c.trigger.length > 0 && c.trigger.length <= 256 &&
    Array.isArray(c.triggerSupports) && c.triggerSupports.length > 0 && c.triggerSupports.length <= 8 &&
    new Set(c.triggerSupports).size === c.triggerSupports.length && c.triggerSupports.every(id => typeof id === "string" && id.length > 0 && id.length <= 256) &&
    integer(c.createdAt, 0, at) && integer(c.expiresAt, c.createdAt + 1, Math.min(Number.MAX_SAFE_INTEGER, c.createdAt + DAY)) &&
    integer(c.notBefore, c.createdAt, c.expiresAt - 1) && ["notify", "propose"].includes(c.action);
}

/** Pending foreground invocations are reconstructed by identity and epoch.
 * A terminal event from a prior epoch cannot release a resumed conversation. */
export function proactiveForegroundBusy(events: readonly Event[], owner: string) {
  const pending = new Set<string>();
  for (const e of events) {
    if (e.owner !== undefined && e.owner !== owner) continue;
    if (e.type === "MessageReceived" && e.source !== "background" && typeof e.id === "string" && !e.id.startsWith("proactive:"))
      pending.add(`${e.id}:${e.epoch ?? 0}`);
    if (e.type === "TurnResumed" && typeof e.turn === "string" && !e.turn.startsWith("proactive:"))
      pending.add(`${e.turn}:${e.epoch ?? 0}`);
    if (["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(e.type)) pending.delete(`${e.turn}:${e.epoch ?? 0}`);
  }
  return pending.size > 0;
}

/** Structural/current-task checks are shared by admission and the final send.
 * Memory freshness is independently checked by proactiveEvidence at both sites. */
export function contributionStatus(events: readonly Event[], owner: string, id: string, now: number) {
  const row = events.find(e => e.type === "AikoProactiveDecision" && e.id === id && (e.owner === undefined || e.owner === owner));
  if (row?.contribution === undefined) return undefined; // Legacy contract.
  if (!validContribution(row.contribution, Number(row.at))) return "invalid-contribution";
  const c = row.contribution;
  const rollout = contributionRolloutStatus(events, owner, id);
  if (rollout) return rollout;
  if (!Array.isArray(row.supports) || c.triggerSupports.some(id => !(row.supports as unknown[]).includes(id))) return "invalid-contribution-evidence";
  if (now >= c.expiresAt) return "contribution-expired";
  if (row.work !== undefined && !workNoticeCurrent(events, owner, row.work, now)) return "contribution-task-changed";
  const position = events.indexOf(row);
  if (events.slice(position + 1).some(e => e.type === "AikoProactiveDecision" && e.owner === owner &&
    validContribution(e.contribution, Number(e.at)) && e.contribution.topic === c.topic && e.id !== row.id)) return "contribution-superseded";
  // The first bounded set is admitted deterministically; overflow remains a
  // terminal decision rather than silently returning later after capacity frees.
  const pending = new Map<string, { id: unknown; expiresAt: number }>();
  for (let i = 0; i < position; i++) {
    const e = events[i]!;
    if (e.owner !== owner && !(e.type === "AikoDeliverySettled" && e.owner === undefined)) continue;
    if (e.type === "AikoProactiveDecision" && validContribution(e.contribution, Number(e.at))) {
      for (const [topic, p] of pending) if (p.expiresAt <= Number(e.at)) pending.delete(topic);
      if (pending.has(e.contribution.topic) || pending.size < CONTRIBUTION_LIMIT)
        pending.set(e.contribution.topic, { id: e.id, expiresAt: e.contribution.expiresAt });
    } else if (e.type === "AikoProactiveSuppressed" || e.type === "AikoDeliverySettled") {
      for (const [topic, p] of pending) if (e.type === "AikoProactiveSuppressed" ? p.id === e.id : e.turn === `proactive:${p.id}`) pending.delete(topic);
    }
  }
  for (const [topic, p] of pending) if (p.expiresAt <= Number(row.at)) pending.delete(topic);
  if (!pending.has(c.topic) && pending.size >= CONTRIBUTION_LIMIT) return "contribution-capacity";
  return "current";
}

export interface ProactivePreferences {
  version: 1;
  enabled: boolean;
  quietHours: null | { timeZone: string; startMinute: number; endMinute: number };
  cooldownMs: number;
  dailyLimit: number;
  batchWindowMs: number;
  dismissedTopics: string[];
}
export const defaultProactivePreferences: ProactivePreferences = {
  version: 1, enabled: true, quietHours: null, cooldownMs: 0,
  dailyLimit: 8, batchWindowMs: 0, dismissedTopics: [],
};
const digest = (v: unknown): v is string => typeof v === "string" && /^sha256:[a-f0-9]{64}$/.test(v);
const integer = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const keys = (v: object, expected: string[]) => Object.keys(v).sort().join(",") === expected.sort().join(",");
const DAY = 86_400_000;
// Legacy native settlement rows can omit owner inside an owner-bound journal.
// An explicit other owner must not settle this owner's decision or reservation.
const ownerMatches = (event: Event, owner: string | undefined) => owner === undefined || event.owner === undefined || event.owner === owner;
const same = (a: unknown, b: unknown) => { try { return harnessDigest(a as any) === harnessDigest(b as any); } catch { return false; } };

export interface ProactiveAcquisitionOutcome {
  version: 1;
  kind: "harness-acquisition";
  operationId: string;
  identity: string;
  task: HarnessTaskAssociation;
}
/** Stable semantic identity shared by the producer and source-provenance check. */
export function proactiveAcquisitionIdentity(owner: string, receipt: Event) {
  const routeKey = harnessDigest([receipt.name, receipt.contractDigest, receipt.contextDigest]);
  return harnessDigest(["aiko-capability-outcome/v1", owner, routeKey, receipt.harnessDigest, receipt.generation]);
}
/** A readiness notice needs the native task, current route and every fixed
 * evaluation witness. A promotion name or a generated readiness claim is insufficient. */
export function proactiveAcquisitionOutcome(events: readonly Event[], owner: string, operationId: string): ProactiveAcquisitionOutcome | undefined {
  const receipt = events.find(e => e.type === "AikoHarnessAcquisitionSettled" && e.owner === owner && e.id === operationId);
  const request = events.find(e => e.type === "AikoHarnessAcquisitionRequested" && e.owner === owner && e.id === operationId);
  if (!receipt || !request || !["verified", "ready"].includes(String(receipt.status)) || receipt.reused !== false ||
    receipt.requestDigest !== request.requestDigest || receipt.name !== request.name || receipt.contractDigest !== request.contractDigest ||
    receipt.contextDigest !== request.contextDigest || !digest(receipt.harnessDigest) || !digest(receipt.contractDigest) || !digest(receipt.contextDigest)) return undefined;
  const task = request.task as HarnessTaskAssociation | undefined;
  if (!task || !same(harnessAcquisitionTask(events, owner, task.thread, task), task) ||
    events.some(e => e.type === "TurnCancelled" && e.turn === task.turn && (e.epoch ?? 0) === (task.epoch ?? 0) ||
      e.type === "CancellationRequested" && (e.invocation as any)?.method === "message" &&
      (e.invocation as any)?.id === task.turn && ((e.invocation as any)?.epoch ?? 0) === (task.epoch ?? 0))) return undefined;
  const state = harnessLibraryState(events, owner);
  const route = state.heads.get(harnessDigest([receipt.name, receipt.contractDigest, receipt.contextDigest]));
  const contract = state.contracts.get(receipt.contractDigest), evaluation = state.evaluations.get(String(receipt.evaluationId));
  if (!route || route.type !== "AikoHarnessPromoted" || route.harnessDigest !== receipt.harnessDigest || route.generation !== receipt.generation ||
    route.evaluationId !== receipt.evaluationId || !contract || !evaluation || evaluation.eligible !== true ||
    evaluation.harnessDigest !== receipt.harnessDigest || evaluation.contextDigest !== receipt.contextDigest || evaluation.evaluatorDigest !== contract.evaluatorDigest ||
    !Array.isArray(evaluation.witnessIds) || !evaluation.witnessIds.length || evaluation.witnessIds.some(id => {
      const witness = state.witnesses.get(String(id));
      return !witness || witness.status !== "satisfied" || witness.harnessDigest !== receipt.harnessDigest || witness.contractDigest !== receipt.contractDigest ||
        witness.contextDigest !== receipt.contextDigest || witness.verifierDigest !== contract.verifierDigest || witness.evaluatorDigest !== contract.evaluatorDigest;
    })) return undefined;
  return { version: 1, kind: "harness-acquisition", operationId, task,
    identity: proactiveAcquisitionIdentity(owner, receipt) };
}

export function currentProactiveOutcome(events: readonly Event[], owner: string, outcome: unknown) {
  if (!outcome || typeof outcome !== "object" || (outcome as any).kind !== "harness-acquisition") return false;
  return same(proactiveAcquisitionOutcome(events, owner, String((outcome as any).operationId)), outcome);
}

/** Present readiness is an effect-time query over the current host grant and
 * runtime context, separate from the retained historical verification fact. */
export async function proactiveOutcomeAvailable(events: readonly Event[], owner: string, outcome: ProactiveAcquisitionOutcome,
  binding: HarnessLibraryBinding | undefined, signal: AbortSignal, sourceJournal?: HarnessJournal) {
  if (!binding || binding.owner !== owner || binding.thread !== `user-${owner}` || !currentProactiveOutcome(events, owner, outcome)) return false;
  try {
    const currentBinding = sourceJournal ? sourceAwareHarnessBinding(binding, sourceJournal) : binding;
    signal.throwIfAborted();
    const receipt = events.find(e => e.type === "AikoHarnessAcquisitionSettled" && e.owner === owner && e.id === outcome.operationId)!;
    const library = new HarnessLibrary(currentBinding, { read: async () => events, append: async () => { throw Error("Readiness query cannot append"); } });
    const { artifact, contract, verifier } = await library.resolve(receipt.harnessDigest as `sha256:${string}`);
    const artifactDigest = harnessDigest(artifact);
    const sourcePin = sourceJournal ? harnessSourcePin(await sourceJournal.read(), owner, artifactDigest) : undefined;
    const context = await currentBinding.context(signal), fixture = verifier.cases.find(c => c.split === "development");
    if (harnessDigest(context) !== receipt.contextDigest || !fixture ||
      !await currentBinding.authorize(artifact, contract, context, structuredClone(fixture.input), signal)) return false;
    signal.throwIfAborted();
    const current = await currentBinding.context(signal);
    signal.throwIfAborted();
    if (harnessDigest(current) !== receipt.contextDigest) return false;
    // Authorization validated a particular retained source head. The final
    // context query must not allow a newer dependency/license head to slip past
    // that result. A changed pin requires a fresh readiness query.
    if (sourceJournal && sourcePin !== harnessSourcePin(await sourceJournal.read(), owner, artifactDigest)) return false;
    return !signal.aborted;
  } catch { return false; }
}
export function validateProactivePreferences(raw: unknown): ProactivePreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Invalid proactive preferences");
  const p = raw as ProactivePreferences;
  if (!keys(p, ["version", "enabled", "quietHours", "cooldownMs", "dailyLimit", "batchWindowMs", "dismissedTopics"]) ||
    p.version !== 1 || typeof p.enabled !== "boolean" || !integer(p.cooldownMs, 0, 7 * DAY) ||
    !integer(p.dailyLimit, 0, 200) || !integer(p.batchWindowMs, 0, 3_600_000) ||
    !Array.isArray(p.dismissedTopics) || p.dismissedTopics.length > 128 ||
    !p.dismissedTopics.every(digest) || new Set(p.dismissedTopics).size !== p.dismissedTopics.length)
    throw Error("Invalid proactive preferences");
  if (p.quietHours !== null) {
    const q = p.quietHours;
    if (!q || !keys(q, ["timeZone", "startMinute", "endMinute"]) || typeof q.timeZone !== "string" || q.timeZone.length > 100 ||
      !integer(q.startMinute, 0, 1439) || !integer(q.endMinute, 0, 1439) || q.startMinute === q.endMinute)
      throw Error("Invalid quiet hours");
    new Intl.DateTimeFormat("en-GB", { timeZone: q.timeZone }).format(0);
  }
  return structuredClone(p);
}

/** Projection only. Owner selection comes from the host, never a notification. */
export function proactivePreferences(events: readonly Event[], owner: string) {
  let revision = "default", preferences = structuredClone(defaultProactivePreferences);
  for (const e of events) {
    if (e.type !== "AikoProactivePreferencesSet" || e.owner !== owner || e.previousRevision !== revision || typeof e.id !== "string") continue;
    try {
      const candidate = validateProactivePreferences(e.preferences);
      if (e.preferencesDigest !== harnessDigest(candidate)) continue;
      preferences = candidate; revision = e.id;
    } catch { /* Invalid imported facts cannot silently change policy. */ }
  }
  return { revision, preferences };
}
export function proactiveEventKey(e: Event) {
  if (typeof e.owner !== "string" || typeof e.id !== "string") return undefined;
  if (["AikoProactiveContributionPolicy", "AikoProactivePreferencesSet", "AikoProactiveDeferred", "AikoProactiveEvaluated", "AikoProactiveDispatchAuthorized"].includes(e.type))
    return `aiko-proactive:${e.owner}:${e.type}:${e.id}`;
  return undefined;
}

export function proactiveEvidence(binding: MemoryBinding, supports: unknown) {
  if (!Array.isArray(supports) || !supports.length || supports.length > 8 || new Set(supports).size !== supports.length ||
    !supports.every(v => typeof v === "string")) return undefined;
  let memory: ReturnType<typeof openMemory> | undefined;
  try {
    memory = openMemory(binding);
    const hits = supports.map(id => memory!.get(id));
    if (hits.some(hit => !hit || hit.state !== "current" || hit.freshness === "stale")) return undefined;
    return { topics: [...new Set(hits.map(hit => harnessDigest(["aiko-proactive-topic/v1", binding.owner, hit!.observation.subject])))].sort() };
  } catch { return undefined; } finally { memory?.close(); }
}

function quietUntil(now: number, quiet: ProactivePreferences["quietHours"]) {
  if (!quiet) return now;
  const format = new Intl.DateTimeFormat("en-GB", { timeZone: quiet.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const inside = (at: number) => {
    const parts = format.formatToParts(at);
    const minute = Number(parts.find(p => p.type === "hour")!.value) * 60 + Number(parts.find(p => p.type === "minute")!.value);
    return quiet.startMinute < quiet.endMinute ? minute >= quiet.startMinute && minute < quiet.endMinute
      : minute >= quiet.startMinute || minute < quiet.endMinute;
  };
  if (!inside(now)) return now;
  // Calendar evaluation only; no polling task or timer. Covers a DST fall-back day.
  const start = Math.floor(now / 60_000) * 60_000;
  for (let minute = 1; minute <= 26 * 60; minute++) if (!inside(start + minute * 60_000)) return start + minute * 60_000;
  return now + 26 * 3_600_000;
}
type Decision = { id: string; at: number; topics: readonly string[]; batchAt?: number };
export type ProactivePolicyResult = { revision: string; status: "allow" | "suppress" | "defer"; reason: string; dueAt?: number };
export function proactivePolicy(events: readonly Event[], owner: string, decision: Decision, now: number, stage: "admission" | "dispatch" = "admission"): ProactivePolicyResult {
  const { revision, preferences: p } = proactivePreferences(events, owner);
  const result = (status: ProactivePolicyResult["status"], reason: string, dueAt?: number) => ({ revision, status, reason, ...(dueAt !== undefined ? { dueAt } : {}) });
  if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || !integer(decision.at, 0, now) || !decision.topics.length || !decision.topics.every(digest))
    return result("suppress", "invalid-policy-input");
  if (!p.enabled || !p.dailyLimit) return result("suppress", "notifications-disabled");
  if (events.findLast(e => e.type === "AikoHooksConfigured")?.paused === true) return result("suppress", "hooks-paused");
  if (decision.topics.some(t => p.dismissedTopics.includes(t))) return result("suppress", "topic-dismissed");
  if (now >= decision.at + DAY) return result("suppress", "notification-expired");
  const contribution = events.find(e => e.type === "AikoProactiveDecision" && e.id === decision.id && e.owner === owner)?.contribution;
  const status = contributionStatus(events, owner, decision.id, now);
  if (status !== undefined && status !== "current") return result("suppress", status);
  const expiry = validContribution(contribution, decision.at) ? contribution.expiresAt : decision.at + DAY;
  const dispatched = events.filter(e => e.type === "AikoProactiveDispatchAuthorized" && e.owner === owner);
  const own = dispatched.find(e => e.decisionId === decision.id);
  if (own) return result("suppress", "delivery-already-reserved");
  const today = Math.floor(now / DAY);
  const todaySpend = dispatched.filter(e => Math.floor(Number(e.at) / DAY) === today).length;
  const activeReservations = events.filter(e => e.type === "AikoProactiveAccepted" && e.owner === owner && e.chat === owner && e.id !== decision.id &&
    Number(e.decisionAt ?? e.at) + DAY > now && !dispatched.some(d => d.decisionId === e.id) &&
    !events.some(d => ownerMatches(d, owner) && d.type === "AikoDeliverySettled" && d.turn === `proactive:${e.id}`));
  let dueAt = quietUntil(now, p.quietHours), reason = dueAt > now ? "quiet-hours" : "eligible";
  if (validContribution(contribution, decision.at)) {
    if (contribution.notBefore > dueAt) { dueAt = contribution.notBefore; reason = "contribution-deferred"; }
    // Native turn settlement wakes the wait early. Expiry is a final cleanup
    // deadline, never a timer that repeatedly asks a model whether to speak.
    if (proactiveForegroundBusy(events, owner)) return result("defer", "foreground-busy", expiry);
  }
  const last = dispatched.at(-1);
  if (last && Number(last.at) + p.cooldownMs > dueAt) { dueAt = Number(last.at) + p.cooldownMs; reason = "cooldown"; }
  // Pending admissions reserve capacity; the serialized dispatch guard spends it.
  if (todaySpend + (stage === "admission" ? activeReservations.length : 0) >= p.dailyLimit) {
    // Pending work can release capacity before midnight. Wake and recheck then;
    // a retained physical dispatch remains spent for its entire UTC day.
    const capacityAt = todaySpend >= p.dailyLimit ? (today + 1) * DAY :
      Math.min((today + 1) * DAY, ...activeReservations.map(e => Number(e.decisionAt ?? e.at) + DAY));
    if (capacityAt > dueAt) { dueAt = capacityAt; reason = "daily-interruption-budget"; }
  }
  const batchAt = decision.batchAt ?? decision.at;
  if (!integer(batchAt, 0, decision.at)) return result("suppress", "invalid-batch-window");
  if (stage === "admission" && batchAt + p.batchWindowMs > dueAt) { dueAt = batchAt + p.batchWindowMs; reason = "batch-window"; }
  if (dueAt >= expiry) return result("suppress", "notification-expired-before-eligible");
  return dueAt > now ? result("defer", reason, dueAt) : result("allow", "eligible");
}

/** The first retained window anchors later observations of the same topic. */
export function proactiveBatchAt(events: readonly Event[], owner: string, decision: Decision) {
  return events.reduce((first, e) => e.owner === owner &&
    ["AikoProactiveDeferred", "AikoProactiveAccepted", "AikoProactiveSuppressed"].includes(e.type) &&
    Array.isArray(e.topics) && e.topics.some(t => decision.topics.includes(String(t))) &&
    integer(e.batchAt, 0, decision.at) && integer(e.batchWindowMs, 1, 3_600_000) &&
    Number(e.batchAt) + Number(e.batchWindowMs) >= decision.at ? Math.min(first, Number(e.batchAt)) : first, decision.at);
}

const wakeAfter = (e: Event, wait: Event, owner: string | undefined) => ownerMatches(e, owner) && (
  (e.type === "AikoProactiveContributionPolicy" && e.owner === owner) ||
  (e.type === "AikoProactivePreferencesSet" && e.owner === owner) ||
  (e.type === "AikoHooksConfigured" && (e.owner === undefined || e.owner === owner)) ||
  (e.type === "AikoProactiveDispatchAuthorized" && e.owner === owner) ||
  e.type === "AikoDeliverySettled" ||
  (wait.contributionVersion === 2 && (e.owner === undefined || e.owner === owner) &&
    ["MessageReceived", "TurnResumed", "TurnCompleted", "TurnFailed", "TurnCancelled", "AikoWorkTransition", "AikoWorkContactHandling", "AikoProactiveDecision"].includes(e.type)) ||
  (e.type === "AlarmFired" && Number(e.at) >= Number((wait.call as any)?.deadlineAt)));

/** Select work from retained facts only; wall-clock time never drives projection. */
export function proactiveEligibility(events: readonly Event[], owner: string, decisionId: string) {
  if (events.some(e => ownerMatches(e, owner) && ["AikoProactiveAccepted", "AikoProactiveSuppressed"].includes(e.type) && e.id === decisionId)) return undefined;
  const index = events.findLastIndex(e => e.type === "AikoProactiveDeferred" && e.owner === owner && e.decisionId === decisionId);
  const wait = events[index];
  const wake = wait ? events.findLastIndex((e, i) => i > index && wakeAfter(e, wait, owner)) : -1;
  if (wait && wake < 0) return undefined;
  return harnessDigest(["aiko-proactive-evaluation/v1", owner, decisionId, proactivePreferences(events, owner).revision, wait?.id ?? "initial", wake]);
}

/** Accepted contributions can wait again before the outbox reserves a send. */
export function proactiveDispatchEligibility(events: readonly Event[], owner: string, decisionId: string) {
  const index = events.findLastIndex(e => e.type === "AikoProactiveDeferred" && e.stage === "dispatch" && e.owner === owner && e.decisionId === decisionId);
  const wait = events[index];
  const wake = wait ? events.findLastIndex((e, i) => i > index && wakeAfter(e, wait, owner)) : -1;
  return wait && wake < 0 ? undefined : harnessDigest(["aiko-proactive-dispatch-wait/v2", owner, decisionId, wait?.id ?? "initial", wake]);
}

/** Pure host commit fence. Final effect also verifies that its claim actually
 * committed: some native hosts return zero appended rows on a rejected batch. */
export function proactiveAppendAllowed(batch: readonly Event[], read: () => readonly Event[], thread?: string) {
  const history = [...read()];
  for (const e of batch) {
    if (e.type.startsWith("AikoProactive") && thread && typeof e.owner === "string" && thread !== `user-${e.owner}`) return false;
    if (e.type === "AikoProactiveContributionPolicy") {
      const previous = history.findLast(r => r.type === e.type && r.owner === e.owner);
      if (e.version !== 2 || !["disabled", "shadow", "enabled"].includes(String(e.mode)) ||
        e.previous !== (previous?.id ?? null) || e.id !== harnessDigest([CONTRIBUTION_POLICY, e.owner, e.previous, e.mode])) return false;
    }
    if (e.type === "AikoProactivePreferencesSet") {
      if (!proactiveEventKey(e) || !integer(e.at, 0, Number.MAX_SAFE_INTEGER) || history.some(r => r.type === e.type && r.owner === e.owner && r.id === e.id)) return false;
      try {
        const p = validateProactivePreferences(e.preferences);
        if (e.preferencesDigest !== harnessDigest(p) || e.previousRevision !== proactivePreferences(history, String(e.owner)).revision) return false;
      } catch { return false; }
    }
    if (e.type === "AikoProactiveAccepted") {
      if (typeof e.owner !== "string") return false;
      if (e.outcome !== undefined && !currentProactiveOutcome(history, e.owner, e.outcome)) return false;
      const decision = history.find(d => d.type === "AikoProactiveDecision" && d.id === e.id);
      if (!decision || decision.owner !== undefined && decision.owner !== e.owner || !Array.isArray(e.topics) ||
        e.text !== decision.text || e.decisionAt !== decision.at || !Array.isArray(e.supports) || !same(e.supports, decision.supports) ||
        e.sourceThread !== decision.sourceThread || e.root !== decision.root || !same(e.outcome ?? null, decision.outcome ?? null) || e.chat !== undefined && e.chat !== e.owner ||
        !same(e.contribution ?? null, decision.contribution ?? null) || !same(e.work ?? null, decision.work ?? null) ||
        history.some(r => ["AikoProactiveAccepted", "AikoProactiveSuppressed"].includes(r.type) && r.id === e.id)) return false;
      const check = proactivePolicy(history, String(e.owner), { id: String(e.id), at: Number(decision.at), topics: e.topics as string[], batchAt: Number(e.batchAt) }, Number(e.at));
      if (check.status !== "allow" || check.revision !== e.policyRevision) return false;
    }
    if (e.type === "AikoProactiveDispatchAuthorized") {
      if (!proactiveEventKey(e) || typeof e.claimId !== "string" || !e.claimId || e.id !== e.decisionId) return false;
      const accepted = history.find(d => d.type === "AikoProactiveAccepted" && d.id === e.decisionId && (d.owner === e.owner || d.owner === undefined));
      if (!accepted || !Array.isArray(e.topics) || e.turn !== `proactive:${e.decisionId}` || e.chat !== e.owner || accepted.chat !== e.chat ||
        !same(e.topics, accepted.topics) || !same(e.supports, accepted.supports) ||
        !batch.some(d => d.type === "AikoDeliveryStarted" && d.turn === e.turn && d.epoch === 0 && d.proactiveClaimId === e.claimId) ||
        history.some(d => ["AikoDeliveryStarted", "AikoDeliverySettled"].includes(d.type) && d.turn === e.turn)) return false;
      const check = proactivePolicy(history, String(e.owner), { id: String(e.decisionId), at: Number(accepted.decisionAt ?? accepted.at), topics: e.topics as string[] }, Number(e.at), "dispatch");
      if (check.status !== "allow" || check.revision !== e.policyRevision) return false;
    }
    if (e.type === "AikoDeliveryStarted" && String(e.turn).startsWith("proactive:")) {
      if (!batch.some(d => d.type === "AikoProactiveDispatchAuthorized" && d.turn === e.turn && d.claimId === e.proactiveClaimId && d.owner === d.chat)) return false;
    }
    history.push(e);
  }
  return true;
}

/** A deferred decision uses the installed native method deadline machinery. */
export const proactiveWaitMethod = actorMethod({
  input: Schema.Struct({ decisionId: Schema.String }), output: Schema.String,
  event: call => ({ type: "AikoProactiveDeferred", id: call.invocation.id, decisionId: call.input.decisionId, at: call.at,
    call: { invocation: call.invocation, deadlineAt: call.deadlineAt } }),
  projection: { initial: () => [] as Event[], step: (s: Event[], e: Event) => [...s, e],
    output: events => ({ currentEpoch: () => 0, invocationState: invocation => {
      const index = events.findIndex(e => e.type === "AikoProactiveDeferred" && (e.call as any)?.invocation.id === invocation.id);
      const row = events[index];
      if (!row) return undefined;
      const owner = typeof row.owner === "string" ? row.owner : undefined;
      return events.some(e => ownerMatches(e, owner) && ((e.type === "AikoProactiveSuppressed" || row.stage !== "dispatch" && e.type === "AikoProactiveAccepted") && e.id === row.decisionId ||
          e.type === "AikoDeliverySettled" && e.turn === `proactive:${row.decisionId}`)) ||
        events.slice(index + 1).some(e => wakeAfter(e, row, owner))
        ? { status: "completed" as const, output: "recheck" } : { status: "pending" as const };
    } }),
  },
});
