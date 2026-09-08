import type { Event, ThreadEventRow } from "tardie/core/log";
import type { ThreadAddress } from "tardie/core/communication/endpoint";
import { harnessDigest } from "./harness-library.ts";
import type { MemoryBinding } from "./memory.ts";
import { threadBinding } from "./account-binding.ts";

export const LEARNING_ORIGIN_POLICY = "aiko-learning-origin/v2";
const PAGE_SIZE = 64;
const sourceTypes = new Set([
  "AikoHarnessPromoted", "AikoHarnessRetired", "AikoHarnessSkillAvailable",
  "AikoHarnessAcquisitionSettled", "BrowserNetworkToolPrepared",
  "AikoBrowserLearningPending", "AikoLogMemoryFollowed", "AikoConnectionChanged",
  "AikoHookReceived", "AikoIndexRequested", "AikoConnectionIndexRequested",
]);
export interface LearningOrigin {
  version: 1;
  owner: string;
  scope: string;
  source: ThreadAddress;
  projectionVersion: typeof LEARNING_ORIGIN_POLICY;
  sequence: number;
  eventType: string;
  eventIdentity: string;
  eventDigest: string;
  window: { after: number; through: number; digest: string };
}
export interface LearningSourceScan {
  version: 1;
  owner: string;
  thread: string;
  projectionVersion: typeof LEARNING_ORIGIN_POLICY;
  after: number;
  through: number;
  cut: number;
  status: "advanced" | "unavailable";
  origins: LearningOrigin[];
  reason?: string;
}
export const learningEventDigest = (event: Event) => harnessDigest([LEARNING_ORIGIN_POLICY, event]);
export const learningSourceScanId = (owner: string, thread: string, after: number, target: string) =>
  harnessDigest([LEARNING_ORIGIN_POLICY, owner, thread, after, target]);

/** Source lookup progress is distinct from database ingestion. One native keyed
 * effect reads one bounded contiguous window; only the later DB receipt proves
 * that a selected occurrence entered memory. Raw event payloads are not copied. */
export async function scanLearningSources(binding: MemoryBinding, self: ThreadAddress, after: number, signal: AbortSignal, cut: number): Promise<LearningSourceScan> {
  const base = { version: 1, owner: binding.owner, thread: binding.thread,
    projectionVersion: LEARNING_ORIGIN_POLICY, after, cut } as const;
  const unavailable = (reason: string): LearningSourceScan => ({ ...base, through: after, status: "unavailable", origins: [], reason });
  if (self.actor !== "aiko" || self.thread !== binding.thread || threadBinding(self.thread)?.owner !== binding.owner || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(cut) || cut < after)
    return unavailable("source_binding_invalid");
  if (after === cut) return unavailable("retained_source_cause_missing");
  signal.throwIfAborted();
  const limit = Math.min(PAGE_SIZE + 1, cut - after);
  const rows = await binding.readPage(after, limit);
  signal.throwIfAborted();
  if (!Array.isArray(rows) || rows.length > limit) return unavailable("source_page_invalid");
  if (!rows.length) return unavailable("retained_source_cause_missing");
  let previous = after;
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.seq) || row.seq !== previous + 1 || !row.event || typeof row.event.type !== "string")
      return unavailable("source_sequence_gap");
    previous = row.seq;
  }
  const selected: readonly ThreadEventRow[] = rows.slice(0, PAGE_SIZE);
  const through = selected[selected.length - 1]!.seq;
  const window = { after, through, digest: harnessDigest(selected.map(row => [row.seq, learningEventDigest(row.event)])) };
  const origins = selected.flatMap(({ seq, event }): LearningOrigin[] => {
    if (!sourceTypes.has(event.type) || event.owner !== undefined && event.owner !== binding.owner) return [];
    const suppliedIdentity = event.id ?? event.turn ?? event.callId ?? event.toolId;
    const identity = typeof suppliedIdentity === "string" && suppliedIdentity.length ? suppliedIdentity : learningEventDigest(event);
    return [{ version: 1, owner: binding.owner, scope: `aiko:${binding.owner}`,
      source: { actor: self.actor, instance: self.instance, thread: self.thread },
      projectionVersion: LEARNING_ORIGIN_POLICY, sequence: seq, eventType: event.type,
      eventIdentity: identity, eventDigest: learningEventDigest(event), window }];
  });
  return { ...base, through, status: "advanced", origins };
}

export function validLearningOrigin(value: unknown, owner: string): value is LearningOrigin {
  if (!value || typeof value !== "object") return false;
  const v = value as LearningOrigin;
  const digest = (x: unknown) => typeof x === "string" && /^sha256:[a-f0-9]{64}$/.test(x);
  return v.version === 1 && v.owner === owner && v.scope === `aiko:${owner}` &&
    v.projectionVersion === LEARNING_ORIGIN_POLICY && v.source?.actor === "aiko" &&
    typeof v.source.instance === "string" && typeof v.source.thread === "string" && threadBinding(v.source.thread)?.owner === owner &&
    Number.isSafeInteger(v.sequence) && v.sequence > 0 && sourceTypes.has(v.eventType) &&
    typeof v.eventIdentity === "string" && v.eventIdentity.length > 0 && digest(v.eventDigest) &&
    Number.isSafeInteger(v.window?.after) && v.window.after >= 0 &&
    Number.isSafeInteger(v.window?.through) && v.window.through >= v.sequence &&
    v.sequence > v.window.after && v.window.through - v.window.after <= PAGE_SIZE && digest(v.window.digest);
}

/** A retained lookup receipt is evidence of its earlier read, not permission to
 * substitute different or unavailable source bytes at the next handoff. */
export async function verifyLearningOrigin(binding: MemoryBinding, self: ThreadAddress, origin: LearningOrigin, signal: AbortSignal, matches?: (event: Event) => boolean) {
  if (!validLearningOrigin(origin, binding.owner) || origin.source.actor !== self.actor ||
    origin.source.instance !== self.instance || self.thread !== binding.thread || threadBinding(self.thread)?.owner !== binding.owner) return false;
  signal.throwIfAborted();
  const { after, through } = origin.window;
  let rows: readonly ThreadEventRow[] | undefined;
  try {
    rows = origin.source.thread === binding.thread
      ? await binding.readPage(after, through - after)
      : await binding.readSourcePage?.(origin.source, after, through - after);
  } catch {
    signal.throwIfAborted();
    return false;
  }
  signal.throwIfAborted();
  if (!Array.isArray(rows) || rows.length !== through - after || rows.some((row, i) =>
    !row || row.seq !== after + i + 1 || !row.event || typeof row.event.type !== "string") ||
    harnessDigest(rows.map(row => [row.seq, learningEventDigest(row.event)])) !== origin.window.digest) return false;
  const event = rows[origin.sequence - after - 1]!.event;
  const suppliedIdentity = event.id ?? event.turn ?? event.callId ?? event.toolId;
  const identity = typeof suppliedIdentity === "string" && suppliedIdentity.length ? suppliedIdentity : learningEventDigest(event);
  return event.type === origin.eventType && learningEventDigest(event) === origin.eventDigest &&
    identity === origin.eventIdentity && (event.owner === undefined || event.owner === binding.owner) && (!matches || matches(event));
}
