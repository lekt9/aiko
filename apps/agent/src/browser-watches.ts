import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { Validator } from "@cfworker/json-schema";
import { Self } from "tardie/core/runtime";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { channelDigest, CHANNEL_PROVENANCE } from "./channel-bindings.ts";
import { channelHydrate, channelSeal } from "./channel-custody.ts";
import { browserEventOrigin, browserEventKey, type BrowserEventKind, type BrowserObservedEvent, type BrowserProducerGrant } from "./browser-events.ts";
import { channelLogSourceHarnessDefinitions, channelLogSourceSchema, channelLogSourceLease, matchesBrowserLogSource, type BrowserLogSourceFilter, type ChannelLogSourceGrant, type createChannelLogSources } from "./channel-log-source.ts";
import { harnessDigest, type HarnessLibrary, type HarnessDigest, type HarnessJson } from "./harness-library.ts";
import type { BuiltinHarnessDefinition } from "./harness-builtins.ts";
import type { createChannelWiring, WiringJournal } from "./channel-wiring.ts";
import { browserWatchActorAppendAllowed, browserWatchActorEventKey } from "./browser-watch-actor-actions.ts";
import { browserWatchWebhookPermitAppendAllowed } from "./browser-watch-webhook-actions.ts";

export const BROWSER_WATCH_INTENT_SCHEMA = "aiko.browser-watch-intent.v1";
export type BrowserWatchAction =
  | { kind: "harness"; digest: HarnessDigest; contractDigest: HarnessDigest; input: HarnessJson; eventInputs?: Record<string, string[]> }
  | { kind: "actor"; instruction: string }
  | { kind: "webhook"; destination: string };
export interface BrowserWatchConfig {
  id: string; label: string; connectionId: string; connectionRevision: string; sourceGeneration: number;
  origin: string; kind: BrowserEventKind; outcome: string; method?: string; route?: string;
  action: BrowserWatchAction; expiresAt: number; backlog: number; maxOccurrences: number;
}
export interface BrowserWatchLease { grant: BrowserProducerGrant; ingestUrl: string; networkRoutes?: { method: string; route: string }[];
  lifecycleRevision?: number; resumeFrom?: { lifecycleRevision: number; pausedThrough: number };
  leaseRevision?: number; renewalFrom?: { leaseRevision: number; expiresAt: number } }
export interface BrowserWatchDispatch {
  operationId: string; watchId: string; generation: number; event: BrowserObservedEvent; action: BrowserWatchAction; input?: HarnessJson;
  /** Host-minted explicit receipt-check identity; absent during passive crash recovery. */
  reconciliationRequestId?: string;
}
export type BrowserWatchActionResult =
  | { status: "completed" | "failed" | "unknown"; result?: unknown }
  | { status: "pending"; receipt: { kind: "actor" | "channel"; id: string }; deadlineAt: number };
export interface BrowserWatchDiscovery {
  sites: { connectionId: string; label: string; origin: string; connectionRevision: string; sourceGeneration: number; expiresAt?:number;
    events: { id: string; label: string; kind: BrowserEventKind; outcome: string; method?: string; route?: string }[] }[];
  actions: { id: string; label: string; description?: string; action: BrowserWatchAction; supportsInstruction?: boolean }[];
  defaults: { expiresInMs: number; backlog: number; maxOccurrences: number };
}
export interface BrowserWatchBindings {
  owner: string; journal: WiringJournal; library: HarnessLibrary;
  wiring: ReturnType<typeof createChannelWiring>; sources: ReturnType<typeof createChannelLogSources>;
  receivingAuthority: string;
  /** Choices derived from current connected sites and configured execution capabilities. */
  discovery?(signal: AbortSignal): Promise<BrowserWatchDiscovery>;
  current(): boolean;
  /** Synchronous current deployment/connection check for retained grants. Runs
   * again at admission; missing callback preserves explicit in-process policies. */
  configCurrent?(config: BrowserWatchConfig): boolean;
  authorize(config: BrowserWatchConfig, operation: "configure" | "dispatch" | "reconcile", signal: AbortSignal): Promise<boolean>;
  prepareLease(config: BrowserWatchConfig, identity: { producer: string; epoch: string; registeredAt: number }, signal?: AbortSignal): Promise<BrowserWatchLease>;
  configureLease(lease: BrowserWatchLease, signal?: AbortSignal): Promise<unknown>;
  pauseLease(producer: string, signal?: AbortSignal, lifecycleRevision?: number): Promise<unknown>;
  leaseStatus?(producer: string, signal?: AbortSignal): Promise<unknown>;
  acknowledgeGap?(producer: string, sourceGeneration: number, missed: number, signal: AbortSignal): Promise<unknown>;
  /** Must reauthorize at physical dispatch and preserve operationId in the
   * existing actor admission, harness executor or channel outbox adapter. */
  execute(intent: BrowserWatchDispatch, signal: AbortSignal): Promise<BrowserWatchActionResult>;
  /** Read receipts only. Never replay an uncertain effect. */
  reconcile?(intent: BrowserWatchDispatch, signal: AbortSignal): Promise<BrowserWatchActionResult>;
}
const kinds = new Set(["Prepared", "Activated", "Controlled", "Started", "Settled", "ReconcileRequested", "LeaseReleaseChecked", "ActionAccepted", "ActionReceiptChecked", "LeaseRenewalRequested", "LeaseRenewalChecked", "WebhookPermitted"]);
export const browserWatchEventKey = (e: Event) => e.owner && typeof e.id === "string" && e.type.startsWith("AikoBrowserWatch") && kinds.has(e.type.slice(16))
  ? `aiko-browser-watch:${e.owner}:${e.type}:${e.id}` : browserWatchActorEventKey(e);
const fact = (owner: string, type: string, id: string, data: object): Event => ({ type: `AikoBrowserWatch${type}`, owner, id, at: Date.now(), ...data });
const idPattern = /^[a-zA-Z0-9_.-]{1,64}$/;
const scope = (rows: readonly Event[], owner: string) => rows.filter(e => e.owner === owner);
const versionId = (watchId: string, generation: number) => `${watchId}:${generation}`;
const controls = (rows: readonly Event[], watchId: string) => rows.filter(e => e.type === "AikoBrowserWatchControlled" && e.watchId === watchId).at(-1);
const versions = (rows: readonly Event[], watchId: string) => rows.filter(e => e.type === "AikoBrowserWatchPrepared" && e.watchId === watchId);
const latest = (rows: readonly Event[], watchId: string) => versions(rows, watchId).at(-1);
const wake = (owner: string, id: string): Event => ({ type: "AikoChannelLogSourceWake", provenance: CHANNEL_PROVENANCE, owner, id });
interface WatchLeaseRelease { producer: string; epoch?: string; generation: number; lifecycleRevision?: number; deadlineAt: number }
interface WatchSequenceCut { producer: string; epoch: string; generation: number; through: number }
const activeLifecycle = (rows: readonly Event[], watchId: string) => Number(rows.findLast(e => e.type === "AikoBrowserWatchControlled" && e.watchId === watchId && e.status === "active")?.controlRevision ?? 0);
const sequenceCut = (rows: readonly Event[], watchId: string, grant: BrowserProducerGrant): WatchSequenceCut => ({ producer: grant.producer, epoch: grant.epoch, generation: grant.generation,
  through: Math.max(0, ...rows.filter(e => e.type === "AikoBrowserWatchControlled" && e.watchId === watchId).flatMap(e => {
    const cut = e.sequenceCut as WatchSequenceCut | undefined;
    return cut?.producer === grant.producer && cut.epoch === grant.epoch && cut.generation === grant.generation ? [cut.through] : [];
  })) });
const releaseChecks = (rows: readonly Event[], controlId: string) => rows.filter(e => e.type === "AikoBrowserWatchLeaseReleaseChecked" && e.controlId === controlId);
const renewalRequests = (rows: readonly Event[], watchId: string) => rows.filter(e => e.type === "AikoBrowserWatchLeaseRenewalRequested" && e.watchId === watchId);
const renewalChecks = (rows: readonly Event[], requestId: string) => rows.filter(e => e.type === "AikoBrowserWatchLeaseRenewalChecked" && e.requestId === requestId);
const confirmedRenewal = (rows: readonly Event[], watchId: string) => renewalRequests(rows, watchId).findLast(e => renewalChecks(rows, String(e.id)).some(c => c.status === "confirmed"));
/** Current lease bounds may authorize new work; retained action receipt deadlines
 * remain immutable and must never be replaced by these values. */
export function browserWatchRenewedConfig(events: readonly Event[], owner: string, config: BrowserWatchConfig): BrowserWatchConfig {
  const request = confirmedRenewal(scope(events, owner), config.id);
  return request ? { ...config, expiresAt: Number(request.expiresAt), maxOccurrences: Number(request.maxOccurrences) } : config;
}
function renewalState(rows: readonly Event[], request: Event | undefined) {
  if (!request) return undefined;
  const checks = renewalChecks(rows, String(request.id)), last = checks.at(-1);
  return { leaseRevision: Number(request.leaseRevision), expiresAt: Number(request.expiresAt), maxOccurrences: Number(request.maxOccurrences),
    status: last?.status === "confirmed" ? "confirmed" : ((!last && Date.now() < Number(request.deadlineAt)) || last?.nextAt !== undefined) ? "pending" : "needs-attention",
    deadlineAt: Number(request.deadlineAt), attempts: checks.length, ...(last?.nextAt === undefined ? {} : { nextAt: Number(last.nextAt) }),
    ...(last?.reason ? { reason: last.reason } : {}), ...(last?.coverageLapse ? { coverageLapse: last.coverageLapse } : {}) };
}
const pendingAction = (rows: readonly Event[], operationId: string) => {
  const latest = rows.findLast(e => ["AikoBrowserWatchActionAccepted", "AikoBrowserWatchSettled"].includes(e.type) && e.operationId === operationId);
  return latest?.type === "AikoBrowserWatchActionAccepted" ? latest : undefined;
};
const pendingActions = (rows: readonly Event[]) => rows.filter(e => e.type === "AikoBrowserWatchActionAccepted" && pendingAction(rows, String(e.operationId))?.id === e.id);
const receiptEvent = (e: Event) => e.type.startsWith("Call") || e.type === "ResponseReceived" || e.type === "AikoWatchActorAdmissionFailed" ||
  ["AikoChannelOutputPrepared", "AikoChannelOutputStarted", "AikoChannelOutputSettled", "AikoChannelReconcileRequested", "AikoChannelReconcileSettled"].includes(e.type);
const receiptChanges = (events: readonly Event[], pending: Event) => events.filter(e => {
  if (!receiptEvent(e) || e.owner && e.owner !== pending.owner) return false;
  const kind = e.type.startsWith("AikoChannel") ? "channel" : "actor";
  return [e.id, e.call, e.outputId].some(id => typeof id === "string" && harnessDigest({ kind, id }) === pending.receiptKey);
});
function releaseState(rows: readonly Event[], control: Event | undefined) {
  if (!control || control.status === "active" || !control.release) return undefined;
  const checks = releaseChecks(rows, String(control.id)), last = checks.at(-1);
  return { status: last?.status === "confirmed" ? "confirmed" : !last || last.nextAt !== undefined ? "pending" : "needs-attention",
    attempts: checks.length, deadlineAt: (control.release as WatchLeaseRelease).deadlineAt, ...(last?.reason ? { reason: last.reason } : {}),
    ...(last?.nextAt === undefined ? {} : { nextAt: Number(last.nextAt) }) };
}
/** Reuse the host's native method alarm; release work has no resident timer. */
export function browserWatchNextWake(events: readonly Event[], owner: string): number | undefined {
  const rows = scope(events, owner), times: number[] = [];
  for (const control of rows.filter(e => e.type === "AikoBrowserWatchControlled" && e.status !== "active" && e.release)) {
    if (controls(rows, String(control.watchId))?.id !== control.id) continue;
    const release = releaseState(rows, control);
    if (release?.status === "pending" && release.nextAt !== undefined) times.push(release.nextAt);
  }
  for (const pending of pendingActions(rows)) times.push(Number(pending.deadlineAt));
  for (const request of rows.filter(e => e.type === "AikoBrowserWatchLeaseRenewalRequested")) {
    const renewal = renewalState(rows, request);
    if (renewal?.status === "pending" && renewal.nextAt !== undefined) times.push(renewal.nextAt);
  }
  return times.length ? Math.min(...times) : undefined;
}
function validateConfig(raw: BrowserWatchConfig) {
  const c = structuredClone(raw);
  if (!c || Object.keys(c).some(k => !["id", "label", "connectionId", "connectionRevision", "sourceGeneration", "origin", "kind", "outcome", "method", "route", "action", "expiresAt", "backlog", "maxOccurrences"].includes(k)) ||
    !idPattern.test(c.id) || typeof c.label !== "string" || c.label.length > 160 || !c.connectionId || !c.connectionRevision ||
    !Number.isSafeInteger(c.sourceGeneration) || c.sourceGeneration < 1 || !["push", "notification", "network"].includes(c.kind) ||
    !Number.isSafeInteger(c.expiresAt) || c.expiresAt <= Date.now() || c.expiresAt > Date.now() + 86400000 ||
    !Number.isInteger(c.backlog) || c.backlog < 1 || c.backlog > 128 || !Number.isSafeInteger(c.maxOccurrences) || c.maxOccurrences < 1 || c.maxOccurrences > 1_000_000)
    throw Error("watch_configuration_invalid");
  browserEventOrigin(c.origin);
  if (!(c.kind === "push" ? ["received", "failed"] : c.kind === "notification" ? ["displayed", "failed"] : ["completed", "failed"]).includes(c.outcome)) throw Error("watch_outcome_invalid");
  if (c.kind === "network" ? !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(c.method ?? "") || !/^\/[a-zA-Z0-9_/:.{}-]{0,511}$/.test(c.route ?? "") : c.method !== undefined || c.route !== undefined) throw Error("watch_network_filter_invalid");
  if (!c.action || !["harness", "actor", "webhook"].includes(c.action.kind) || Object.keys(c.action).some(k => !(c.action.kind === "actor" ? ["kind", "instruction"] : c.action.kind === "webhook" ? ["kind", "destination"] : ["kind", "digest", "contractDigest", "input", "eventInputs"]).includes(k)) || Buffer.byteLength(JSON.stringify(c.action)) > 32768) throw Error("watch_action_invalid");
  if (c.action.kind === "actor" && (typeof c.action.instruction !== "string" || !c.action.instruction.trim() || c.action.instruction.length > 8000)) throw Error("watch_instruction_invalid");
  if (c.action.kind === "webhook" && !idPattern.test(c.action.destination)) throw Error("watch_destination_binding_required");
  if (c.action.kind === "harness" && (!/^sha256:[a-f0-9]{64}$/.test(c.action.digest) || !/^sha256:[a-f0-9]{64}$/.test(c.action.contractDigest) ||
    c.action.eventInputs && (Object.keys(c.action.eventInputs).length > 32 || Object.entries(c.action.eventInputs).some(([key, path]) => !idPattern.test(key) || ["__proto__", "constructor", "prototype"].includes(key) || !Array.isArray(path) || !path.length || path.length > 8 || path.some(p => typeof p !== "string" || !p || ["__proto__", "constructor", "prototype"].includes(p)))))) throw Error("watch_harness_binding_invalid");
  return c;
}
const sourceKind = (kind: BrowserEventKind) => `browser-${kind}` as "browser-push" | "browser-notification" | "browser-network";
const filterOf = (c: BrowserWatchConfig): BrowserLogSourceFilter => ({ connectionId: c.connectionId, connectionRevision: c.connectionRevision,
  generation: c.sourceGeneration, origin: c.origin, outcome: c.outcome, ...(c.method ? { method: c.method, route: c.route } : {}), excludeCausePrefix: `watch:${c.id}:` });
const watchEventMatches = (event: Event, config: BrowserWatchConfig, grant: BrowserProducerGrant) => event.producer === grant.producer &&
  event.epoch === grant.epoch && event.generation === grant.generation && matchesBrowserLogSource(event, filterOf(config));

/** Fixed pure mapping: page content cannot select an action, destination or pin. */
export function browserWatchHarnessDefinitions(): BuiltinHarnessDefinition[] {
  return (["push", "notification", "network"] as const).map(kind => {
    const base = channelLogSourceHarnessDefinitions().find(d => d.artifact.name === `channel.source.browser-${kind}.ack`)!;
    const outputSchema = { type: "object", properties: { eventId: { type: "string" }, occurrence: { type: "string" } }, required: ["eventId", "occurrence"], additionalProperties: false };
    const cases = structuredClone(base.verifier.cases);
    const verifierDigest = harnessDigest(["browser-watch-mapper/v1", kind]), evaluatorDigest = harnessDigest(cases);
    const contract = { ...base.contract, outcome: "Return only the exact browser event reference and occurrence for authorized watch dispatch.", outputSchema, verifierDigest, evaluatorDigest,
      applicability: { hook: { ...(base.contract.applicability.hook as any), emits: BROWSER_WATCH_INTENT_SCHEMA, effects: ["pure"] } } };
    const code = "return {eventId:input.value.eventId,occurrence:input.value.occurrence};";
    const artifact = { ...base.artifact, name: `browser.watch.${kind}.intent`, description: contract.outcome, files: { "main.js": code }, contractDigest: harnessDigest(contract), sources: [{ uri: `unlock:browser-watch/${kind}`, revision: harnessDigest(code), digest: harnessDigest(code), license: "NOASSERTION" }] };
    const verifier = { digest: verifierDigest, evaluatorDigest, cases, verify: async ({ input, output }: any) => ({ passed: output?.eventId === input?.value?.eventId && output?.occurrence === input?.value?.occurrence,
      evidence: ["independent-browser-event-reference-equality"], quality: null }) };
    return { artifact, contract, verifier };
  });
}

/** Pure structural guard composed into the existing serialized host commit gate. */
export function browserWatchAppendAllowed(batch: readonly Event[], read: () => readonly Event[]) {
  if (!browserWatchActorAppendAllowed(batch, read) || !browserWatchWebhookPermitAppendAllowed(batch, read)) return false;
  const rows = [...read()];
  for (const e of batch) {
    if (!e.type.startsWith("AikoBrowserWatch")) continue;
    if (!browserWatchEventKey(e)) return false;
    const own = scope(rows, String(e.owner)), prior = own.find(p => browserWatchEventKey(p) === browserWatchEventKey(e));
    if (prior) { if (harnessDigest(prior) !== harnessDigest(e)) return false; continue; }
    if (e.type === "AikoBrowserWatchPrepared" && (e.generation !== Number(latest(own, String(e.watchId))?.generation ?? 0) + 1 || e.id !== versionId(String(e.watchId), Number(e.generation)))) return false;
    if (e.type === "AikoBrowserWatchPrepared" && renewalRequests(own, String(e.watchId)).some(p => renewalState(own, p)?.status !== "confirmed")) return false;
    if (e.type === "AikoBrowserWatchActivated" && !own.some(p => p.type === "AikoBrowserWatchPrepared" && p.id === e.id)) return false;
    if (e.type === "AikoBrowserWatchLeaseRenewalRequested") {
      const previous = renewalRequests(own, String(e.watchId)).at(-1), head = latest(own, String(e.watchId));
      if (!head || head.generation !== e.generation || controls(own, String(e.watchId))?.status === "deleted" ||
        previous && renewalState(own, previous)?.status !== "confirmed" ||
        e.leaseRevision !== Number(previous?.leaseRevision ?? 0) + 1 || e.expectedLeaseRevision !== Number(previous?.leaseRevision ?? 0) ||
        e.id !== `lease:${e.watchId}:${e.leaseRevision}` || !Number.isSafeInteger(e.expiresAt) || Number(e.expiresAt) <= Number(e.at) || Number(e.expiresAt) > Number(e.at) + 86400000 ||
        !Number.isSafeInteger(e.maxOccurrences) || Number(e.maxOccurrences) < 1 || Number(e.maxOccurrences) > 1_000_000 ||
        Number(e.deadlineAt) !== Number(e.at) + 60_000 || (e.leaseRef as any)?.owner !== e.owner || (e.leaseRef as any)?.kind !== "aiko-channel-private.v1" || !/^sha256:[a-f0-9]{64}$/.test(String((e.leaseRef as any)?.ref))) return false;
    }
    if (e.type === "AikoBrowserWatchLeaseRenewalChecked") {
      const request = own.find(p => p.type === "AikoBrowserWatchLeaseRenewalRequested" && p.id === e.requestId), checks = renewalChecks(own, String(e.requestId));
      if (!request || e.watchId !== request.watchId || e.leaseRevision !== request.leaseRevision || e.deadlineAt !== request.deadlineAt ||
        e.attempt !== checks.length || !Number.isSafeInteger(e.attempt) || Number(e.attempt) > 4 || checks.some(p => p.status === "confirmed") ||
        e.id !== `${request.id}:${e.attempt}` || !["confirmed", "unconfirmed"].includes(String(e.status)) ||
        Number(e.attempt) === 4 && e.status !== "confirmed" || e.nextAt !== undefined && (e.status !== "unconfirmed" || Number(e.attempt) >= 3 ||
          !Number.isSafeInteger(e.nextAt) || Number(e.nextAt) <= Number(e.at) || Number(e.nextAt) > Number(e.deadlineAt))) return false;
      if (e.status === "confirmed" && (controls(own, String(e.watchId))?.status === "deleted" ||
        !batch.some(p => p.type === "AikoChannelLogSourceRenewed" && p.owner === e.owner && p.watchRenewalId === request.id && p.leaseRevision === e.leaseRevision && p.expiresAt === request.expiresAt && p.maxOccurrences === request.maxOccurrences))) return false;
    }
    if (e.type === "AikoBrowserWatchControlled" && (!latest(own, String(e.watchId)) || !["active", "paused", "deleted"].includes(String(e.status)) || controls(own, String(e.watchId))?.status === "deleted" || !Number.isSafeInteger(e.cut) || Number(e.cut) < 0 || e.id !== `${e.watchId}:${e.controlRevision}` || e.controlRevision !== Number(controls(own, String(e.watchId))?.controlRevision ?? 0) + 1)) return false;
    if (e.type === "AikoBrowserWatchControlled" && e.release !== undefined) {
      const r = e.release as WatchLeaseRelease;
      if (e.status === "active" || !r || typeof r.producer !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(r.producer) ||
        !Number.isSafeInteger(r.generation) || r.generation < 1 || !Number.isSafeInteger(r.deadlineAt) || r.deadlineAt !== Number(e.at) + 60_000) return false;
      if (r.lifecycleRevision !== undefined && (!Number.isSafeInteger(r.lifecycleRevision) || r.lifecycleRevision !== activeLifecycle(own, String(e.watchId)) || typeof r.epoch !== "string" || !r.epoch)) return false;
    }
    if (e.type === "AikoBrowserWatchControlled" && e.sequenceCut !== undefined) {
      const cut = e.sequenceCut as WatchSequenceCut;
      if (!cut || typeof cut.producer !== "string" || !cut.producer || typeof cut.epoch !== "string" || !cut.epoch ||
        !Number.isSafeInteger(cut.generation) || cut.generation < 1 || !Number.isSafeInteger(cut.through) || cut.through < Number(e.cut)) return false;
      if (own.some(p => p.type === e.type && p.watchId === e.watchId && (p.sequenceCut as WatchSequenceCut)?.producer === cut.producer &&
        (p.sequenceCut as WatchSequenceCut).epoch === cut.epoch && (p.sequenceCut as WatchSequenceCut).generation === cut.generation && (p.sequenceCut as WatchSequenceCut).through > cut.through)) return false;
      const release = e.release as WatchLeaseRelease | undefined;
      if (release && (cut.producer !== release.producer || cut.epoch !== release.epoch || cut.generation !== release.generation)) return false;
    }
    if (e.type === "AikoBrowserWatchControlled" && e.status === "active") {
      const previous = controls(own, String(e.watchId)), release = releaseState(own, previous);
      if (release && release.status !== "confirmed") return false;
      if (previous?.status !== "active" && previous?.release) {
        const checked = releaseChecks(own, String(previous.id)).at(-1), r = previous.release as WatchLeaseRelease, resume = e.resumeFrom as BrowserWatchLease["resumeFrom"], cut = e.sequenceCut as WatchSequenceCut | undefined;
        if (!checked || !Number.isSafeInteger(checked.pausedThrough) || checked.lifecycleRevision !== (r.lifecycleRevision ?? 0) ||
          resume?.lifecycleRevision !== checked.lifecycleRevision || resume?.pausedThrough !== checked.pausedThrough || !cut ||
          cut.producer !== r.producer || cut.epoch !== r.epoch || cut.generation !== r.generation || cut.through < Number(checked.pausedThrough)) return false;
      }
    }
    if (e.type === "AikoBrowserWatchLeaseReleaseChecked") {
      const control = own.find(p => p.type === "AikoBrowserWatchControlled" && p.id === e.controlId), release = control?.release as WatchLeaseRelease | undefined;
      const checks = releaseChecks(own, String(e.controlId));
      if (!control || !release || control.status === "active" || e.watchId !== control.watchId || e.producer !== release.producer || e.sourceGeneration !== release.generation ||
        e.id !== `release:${control.id}:${e.attempt}` || !Number.isInteger(e.attempt) || e.attempt !== checks.length || Number(e.attempt) >= 4 ||
        checks.some(p => p.status === "confirmed" || p.nextAt === undefined) || !["confirmed", "unconfirmed"].includes(String(e.status)) ||
        e.deadlineAt !== release.deadlineAt || e.nextAt !== undefined && (e.status !== "unconfirmed" || Number(e.attempt) >= 3 ||
          !Number.isSafeInteger(e.nextAt) || Number(e.nextAt) <= Number(e.at) || Number(e.nextAt) > release.deadlineAt)) return false;
      if (e.lifecycleRevision !== (release.lifecycleRevision ?? 0) || e.status === "confirmed" &&
        (!Number.isSafeInteger(e.pausedThrough) || Number(e.pausedThrough) < Math.max(Number(control.cut), Number((control.sequenceCut as WatchSequenceCut)?.through ?? 0)))) return false;
    }
    if (e.type === "AikoBrowserWatchStarted" && (controls(own, String(e.watchId))?.status && controls(own, String(e.watchId))?.status !== "active" || !own.some(p => p.type === "AikoBrowserWatchActivated" && p.id === versionId(String(e.watchId), Number(e.generation))))) return false;
    if (e.type === "AikoBrowserWatchReconcileRequested") {
      const started = own.find(p => p.type === "AikoBrowserWatchStarted" && p.id === e.operationId);
      const settled = own.findLast(p => p.type === "AikoBrowserWatchSettled" && p.operationId === e.operationId);
      if (!started || settled?.status !== "unknown" || typeof e.requestId !== "string" || !idPattern.test(e.requestId) ||
        e.id !== `${e.operationId}:${e.requestId}` || e.watchId !== started.watchId || e.generation !== started.generation || e.source !== started.source ||
        own.filter(p => p.type === "AikoBrowserWatchReconcileRequested" && p.operationId === e.operationId).length >= 7) return false;
    }
    if (e.type === "AikoBrowserWatchActionAccepted") {
      const started = own.find(p => p.type === "AikoBrowserWatchStarted" && p.id === e.operationId);
      const settled = own.findLast(p => p.type === "AikoBrowserWatchSettled" && p.operationId === e.operationId);
      const job = e.jobRef as { kind?: string; owner?: string; ref?: string } | undefined;
      if (!started || e.watchId !== started.watchId || e.generation !== started.generation || e.source !== started.source ||
        typeof e.requestId !== "string" || !idPattern.test(e.requestId) || e.id !== `${e.operationId}:${e.requestId}:accepted` ||
        pendingAction(own, String(e.operationId)) || !Number.isSafeInteger(e.deadlineAt) || Number(e.deadlineAt) <= Number(e.at) || Number(e.deadlineAt) > Number(e.at) + 86400000 ||
        typeof e.receiptKey !== "string" || !/^sha256:[a-f0-9]{64}$/.test(e.receiptKey) || job?.kind !== "aiko-channel-private.v1" || job.owner !== e.owner || typeof job.ref !== "string" || !/^sha256:[a-f0-9]{64}$/.test(job.ref) ||
        (e.requestId === "initial" ? !!settled : settled?.status !== "unknown" || !own.some(p => p.type === "AikoBrowserWatchReconcileRequested" && p.id === `${e.operationId}:${e.requestId}`))) return false;
    }
    if (e.type === "AikoBrowserWatchActionReceiptChecked") {
      const accepted = own.find(p => p.type === "AikoBrowserWatchActionAccepted" && p.id === e.acceptedId);
      if (!accepted || pendingAction(own, String(accepted.operationId))?.id !== accepted.id || e.operationId !== accepted.operationId ||
        typeof e.receiptRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(e.receiptRevision) || e.id !== `${accepted.id}:${e.receiptRevision}`) return false;
      const changes = receiptChanges(rows, accepted);
      // A receipt may arrive while its earlier revision is being checked. Retain
      // that prefix check, and leave the newly arrived revision runnable.
      if (!Array.from({ length: changes.length + 1 }, (_, length) => harnessDigest(changes.slice(0, length))).some(revision => revision === e.receiptRevision)) return false;
    }
    if (["AikoBrowserWatchStarted", "AikoBrowserWatchSettled"].includes(e.type)) {
      const accepted = own.find(p => p.type === "AikoChannelWiringAccepted" && p.id === e.source);
      const claim = own.find(p => p.type === "AikoChannelWiringClaimed" && p.id === accepted?.invocation);
      const activated = own.find(p => p.type === "AikoBrowserWatchActivated" && p.id === versionId(String(e.watchId), Number(e.generation)));
      if (!accepted || !claim || !activated || harnessDigest(accepted.port) !== harnessDigest(activated.output) ||
        (claim.wire as any)?.id !== (activated.wire as any)?.id || (claim.wire as any)?.generation !== (activated.wire as any)?.generation ||
        !own.some(p => p.type === "AikoChannelWiringSettled" && p.invocation === accepted.invocation && p.status === "satisfied")) return false;
      if (e.type === "AikoBrowserWatchSettled" && (!["completed", "failed", "unknown"].includes(String(e.status)) || typeof e.operationId !== "string" || !String(e.id).startsWith(`${e.operationId}:`) ||
        e.status !== "failed" && !own.some(p => p.type === "AikoBrowserWatchStarted" && p.id === e.operationId && p.source === e.source))) return false;
    }
    rows.push(e);
  }
  return true;
}

export function createBrowserWatches(binding: BrowserWatchBindings) {
  const { owner, journal, wiring, sources, library } = binding;
  let rows: readonly Event[] = [];
  const privateVersions = new Map<string, { config: BrowserWatchConfig; lease: BrowserWatchLease }>();
  const privateRenewals = new Map<string, BrowserWatchLease>();
  const leaseMutations = new Map<string, Promise<unknown>>();
  const mutateLease = <T>(producer: string, operation: () => Promise<T>): Promise<T> => {
    const next = (leaseMutations.get(producer) ?? Promise.resolve()).catch(() => undefined).then(operation);
    leaseMutations.set(producer, next);
    void next.finally(() => { if (leaseMutations.get(producer) === next) leaseMutations.delete(producer); }).catch(() => undefined);
    return next;
  };
  const native = <A, E>(operation: Effect.Effect<A, E, Self>) => Effect.runPromise(operation.pipe(Effect.provideService(Self, { actor: "aiko", instance: "browser-watches", thread: `user-${owner}` })));
  const refresh = async () => {
    rows = scope(await journal.read(), owner);
    for (const e of rows.filter(e => e.type === "AikoBrowserWatchPrepared")) {
      try {
        const value = await channelHydrate(journal.blobs, owner, e.configRef) as { config: BrowserWatchConfig; lease: BrowserWatchLease };
        privateVersions.set(String(e.id), value);
      } catch { privateVersions.delete(String(e.id)); }

    }
    for (const e of rows.filter(e => e.type === "AikoBrowserWatchLeaseRenewalRequested")) {
      try { privateRenewals.set(String(e.id), await channelHydrate(journal.blobs, owner, e.leaseRef) as BrowserWatchLease); }
      catch { privateRenewals.delete(String(e.id)); }
    }
  };
  const effectiveVersion = (value: { config: BrowserWatchConfig; lease: BrowserWatchLease } | undefined) => {
    if (!value) return undefined;
    const request = confirmedRenewal(rows, value.config.id), lease = request && privateRenewals.get(String(request.id));
    if (!request) return value;
    if (!lease || lease.grant.producer !== value.lease.grant.producer || lease.grant.epoch !== value.lease.grant.epoch || lease.grant.generation !== value.lease.grant.generation) return undefined;
    return { config: { ...value.config, expiresAt: Number(request.expiresAt), maxOccurrences: Number(request.maxOccurrences) }, lease };
  };
  const state = (watchId: string) => {
    const head = latest(rows, watchId), control = controls(rows, watchId);
    return { head, control, value: effectiveVersion(head ? privateVersions.get(String(head.id)) : undefined),
      status: typeof control?.status === "string" ? control.status : "active" };
  };
  const allowed = async (config: BrowserWatchConfig, operation: "configure" | "dispatch" | "reconcile", signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!binding.current() || (operation !== "reconcile" && config.expiresAt <= Date.now()) || !await binding.authorize(config, operation, signal)) throw Error("watch_authority_unavailable");
    signal.throwIfAborted();
  };
  const producerGrants = () => [...new Set(rows.filter(e => e.type === "AikoBrowserWatchPrepared").map(e => String(e.watchId)))].flatMap(id => {
    const s = state(id); if (!s.value) return [];
    const active = binding.current() && (binding.configCurrent?.(s.value.config) ?? true) && s.status === "active" && s.value.config.expiresAt > Date.now() && rows.some(e => e.type === "AikoBrowserWatchActivated" && e.id === s.head!.id);
    return [{ ...s.value.lease.grant, active }];
  });
  const sourceGrants = (): ChannelLogSourceGrant[] => [...new Set(rows.filter(e => e.type === "AikoBrowserWatchPrepared").map(e => String(e.watchId)))].flatMap(id => {
    const s = state(id); if (!s.value) return [];
    const pending = renewalRequests(rows, id).at(-1), candidate = pending && { ...s.value.config, expiresAt: Number(pending.expiresAt), maxOccurrences: Number(pending.maxOccurrences) };
    const renewalAllowed = candidate && s.status !== "deleted" && binding.current() && (binding.configCurrent?.(candidate) ?? true);
    return [{ owner, id: `watch-source:${id}`, kind: sourceKind(s.value.config.kind), receivingAuthority: binding.receivingAuthority,
      active: binding.current() && (binding.configCurrent?.(s.value.config) ?? true) && s.status === "active", expiresAt: s.value.config.expiresAt, maxBindings: 1,
      browserOperationId: `watch:${id}:source`,
      ...(renewalAllowed ? { browserLease: { revision: Number(pending!.leaseRevision), expiresAt: candidate!.expiresAt, maxOccurrences: candidate!.maxOccurrences, requestId: String(pending!.id) } } : {}),
      browserSequenceCut: sequenceCut(rows, id, s.value.lease.grant) }];
  });
  const checkRenewal = async (requestId: string, signal: AbortSignal, explicit = false) => {
    await refresh();
    const initial = rows.find(e => e.type === "AikoBrowserWatchLeaseRenewalRequested" && e.id === requestId);
    const firstLease = privateRenewals.get(requestId);
    if (!initial || !firstLease) throw Error("watch_private_renewal_unavailable");
    await mutateLease(firstLease.grant.producer, async () => {
      await refresh();
      const request = rows.find(e => e.type === "AikoBrowserWatchLeaseRenewalRequested" && e.id === requestId)!;
      const lease = privateRenewals.get(requestId), s = state(String(request.watchId)), checks = renewalChecks(rows, requestId), last = checks.at(-1);
      if (last?.status === "confirmed") return;
      if (!lease || !s.value || s.status === "deleted" || !binding.current()) throw Error("watch_renewal_unavailable");
      if (!explicit && last && (last.nextAt === undefined || Number(last.nextAt) > Date.now())) return;
      const config = { ...s.value.config, expiresAt: Number(request.expiresAt), maxOccurrences: Number(request.maxOccurrences) };
      // A retained private receipt can be confirmed after this lease expires.
      // Its bounds remain expired; only a later explicit revision extends them.
      await allowed(config, "reconcile", signal);
      const privateCall = <T>(call: (deadline: AbortSignal) => Promise<T>, receiptOnly = false) => {
        const remaining = Number(request.deadlineAt) - Date.now();
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(10_000, receiptOnly && remaining <= 0 ? 10_000 : remaining)))]);
        return new Promise<T>((resolve, reject) => {
          const aborted = () => reject(Error("watch_private_renewal_timeout"));
          if (deadline.aborted) { aborted(); return; }
          deadline.addEventListener("abort", aborted, { once: true });
          void Promise.resolve().then(() => call(deadline)).then(resolve, reject).finally(() => deadline.removeEventListener("abort", aborted));
        });
      };
      const matches = (status: any) => !!status && status.producer === lease.grant.producer && status.generation === lease.grant.generation &&
        Number(status.leaseRevision ?? 0) === request.leaseRevision && status.lifecycleRevision === activeLifecycle(rows, config.id) && status.expiresAt === lease.grant.expiresAt &&
        (state(config.id).status === "paused" ? status.state === "paused" : status.state !== "paused") &&
        (status.observationFloor === undefined || Number.isSafeInteger(status.observationFloor) && status.observationFloor >= 0) &&
        (status.coverageLapse === undefined || Number.isSafeInteger(status.coverageLapse.from) && Number.isSafeInteger(status.coverageLapse.to) &&
          status.coverageLapse.from <= status.coverageLapse.to && status.coverageLapse.leaseRevision <= request.leaseRevision);
      let status: any, confirmed = false;
      try { status = await privateCall(s => binding.leaseStatus?.(lease.grant.producer, s) ?? Promise.resolve(undefined), true); confirmed = matches(status); } catch { /* Check retained outcome before attempting the same CAS. */ }
      const canDispatch = checks.length < 4 && Date.now() < Number(request.deadlineAt) && Date.now() < config.expiresAt;
      if (!confirmed && canDispatch) {
        try {
          await allowed(config, "configure", signal);
          await privateCall(s => binding.configureLease(lease, s));
          status = await privateCall(s => binding.leaseStatus?.(lease.grant.producer, s) ?? Promise.resolve(undefined), true);
          confirmed = matches(status);
        } catch { /* Unknown transport result retains this exact revision for recovery. */ }
      }
      await refresh();
      if (renewalChecks(rows, requestId).some(e => e.status === "confirmed")) return;
      if (state(config.id).status === "deleted" || !binding.current()) return;
      // Control can commit while private status is in flight. Confirm against the
      // current lifecycle and pause state, never a pre-await projection.
      confirmed = confirmed && matches(status);
      const attempt = renewalChecks(rows, requestId).length;
      if (attempt !== checks.length || attempt > 4 || !confirmed && attempt >= 4) return;
      const at = Date.now(), nextAt = !confirmed && attempt < 3 && at < Number(request.deadlineAt)
        ? Math.min(Number(request.deadlineAt), at + [1000, 5000, 15000][attempt]!) : undefined;
      const confirmation = fact(owner, "LeaseRenewalChecked", `${requestId}:${attempt}`, { at, requestId, watchId: request.watchId, leaseRevision: request.leaseRevision,
        deadlineAt: request.deadlineAt, attempt, status: confirmed ? "confirmed" : "unconfirmed",
        ...(confirmed ? { ...(status?.coverageLapse ? { coverageLapse: status.coverageLapse } : {}), ...(status?.observationFloor === undefined ? {} : { observationFloor: status.observationFloor }) }
          : { reason: canDispatch ? "private_renewal_unconfirmed" : "private_renewal_deadline", ...(nextAt === undefined ? {} : { nextAt }) }) });
      if (confirmed) {
        await allowed(config, "reconcile", signal);
        const activation = rows.find(e => e.type === "AikoBrowserWatchActivated" && e.watchId === config.id);
        if (!activation) throw Error("watch_source_unavailable");
        // Private confirmation and the source lifetime amendment share one native
        // commit. Neither the action generation nor the source cursor is replaced.
        await native(sources.api.renew({ id: String(activation.sourceId), leaseRevision: Number(request.leaseRevision), expiresAt: config.expiresAt,
          maxOccurrences: config.maxOccurrences, watchRenewalId: requestId }, confirmation));
      } else {
        await journal.transact(current => ({ events: renewalChecks(scope(current, owner), requestId).length === attempt ? [confirmation] : [], result: undefined }));
      }
      await refresh();
    });
  };
  const renew = async (input: { id: string; expectedGeneration: number; expectedLeaseRevision: number; expiresAt: number; maxOccurrences: number }, signal: AbortSignal) => {
    const args = structuredClone(input);
    if (!args || Object.keys(args).some(k => !["id", "expectedGeneration", "expectedLeaseRevision", "expiresAt", "maxOccurrences"].includes(k)) ||
      !idPattern.test(args.id) || !Number.isSafeInteger(args.expectedGeneration) || args.expectedGeneration < 1 ||
      !Number.isSafeInteger(args.expectedLeaseRevision) || args.expectedLeaseRevision < 0) throw Error("watch_renewal_invalid");
    await refresh();
    const s = state(args.id), previous = renewalRequests(rows, args.id).at(-1);
    if (!s.value || s.status === "deleted" || s.head?.generation !== args.expectedGeneration || !binding.current()) throw Error("watch_renewal_unavailable");
    const requestId = `lease:${args.id}:${args.expectedLeaseRevision + 1}`;
    if (previous?.id === requestId) {
      if (previous.generation !== args.expectedGeneration || previous.expiresAt !== args.expiresAt || previous.maxOccurrences !== args.maxOccurrences) throw Error("watch_renewal_conflict");
      await checkRenewal(requestId, signal, true);
      return renewalState(rows, previous)!;
    }
    if (Number(previous?.leaseRevision ?? 0) !== args.expectedLeaseRevision || previous && renewalState(rows, previous)?.status !== "confirmed") throw Error("watch_renewal_revision_conflict");
    const config = validateConfig({ ...s.value.config, expiresAt: args.expiresAt, maxOccurrences: args.maxOccurrences });
    if (config.expiresAt < s.value.config.expiresAt || config.maxOccurrences < s.value.config.maxOccurrences ||
      config.expiresAt === s.value.config.expiresAt && config.maxOccurrences === s.value.config.maxOccurrences) throw Error("watch_renewal_must_extend");
    const activation = rows.find(e => e.type === "AikoBrowserWatchActivated" && e.watchId === args.id);
    const source = activation && channelLogSourceLease(rows, owner, String(activation.sourceId));
    if (!source?.request || source.stop && source.stop.type !== "AikoChannelLogSourceExhausted" || config.maxOccurrences <= source.used) throw Error("watch_source_renewal_unavailable");
    await allowed(config, "configure", signal);
    const controlRevision = Number(s.control?.controlRevision ?? 0), lifecycleRevision = activeLifecycle(rows, args.id);
    const lease: BrowserWatchLease = { ...structuredClone(s.value.lease), leaseRevision: args.expectedLeaseRevision + 1,
      renewalFrom: { leaseRevision: args.expectedLeaseRevision, expiresAt: s.value.config.expiresAt },
      lifecycleRevision, grant: { ...s.value.lease.grant, expiresAt: config.expiresAt } };
    const leaseRef = await channelSeal(journal.blobs, owner, lease), at = Date.now();
    await journal.transact(current => {
      const own = scope(current, owner), head = latest(own, args.id), last = renewalRequests(own, args.id).at(-1);
      if (head?.generation !== args.expectedGeneration || Number(last?.leaseRevision ?? 0) !== args.expectedLeaseRevision ||
        Number(controls(own, args.id)?.controlRevision ?? 0) !== controlRevision || activeLifecycle(own, args.id) !== lifecycleRevision ||
        controls(own, args.id)?.status === "deleted") throw Error("watch_renewal_revision_conflict");
      return { events: [fact(owner, "LeaseRenewalRequested", requestId, { at, watchId: args.id, generation: args.expectedGeneration,
        leaseRevision: args.expectedLeaseRevision + 1, expectedLeaseRevision: args.expectedLeaseRevision, expiresAt: config.expiresAt,
        maxOccurrences: config.maxOccurrences, deadlineAt: at + 60000, leaseRef })], result: undefined };
    }, () => allowed(config, "configure", signal));
    await refresh(); await checkRenewal(requestId, signal);
    return renewalState(rows, renewalRequests(rows, args.id).at(-1))!;
  };
  const configure = async (raw: BrowserWatchConfig, expectedGeneration: number, signal: AbortSignal) => {
    const config = validateConfig(raw); await refresh(); await allowed(config, "configure", signal);
    const prior = state(config.id);
    if (renewalRequests(rows, config.id).some(p => renewalState(rows, p)?.status !== "confirmed")) throw Error("watch_renewal_pending");
    if (Number(prior.head?.generation ?? 0) !== expectedGeneration) throw Error("watch_generation_conflict");
    if (prior.status === "deleted") throw Error("watch_deleted");
    if (prior.value && harnessDigest(filterOf(prior.value.config)) !== harnessDigest(filterOf(config))) throw Error("watch_source_immutable_create_new_watch");
    if (prior.value && (prior.value.config.expiresAt !== config.expiresAt || prior.value.config.backlog !== config.backlog || prior.value.config.maxOccurrences !== config.maxOccurrences)) throw Error("watch_source_lease_immutable_create_new_watch");
    if (config.action.kind === "harness") {
      const resolved = await library.resolve(config.action.digest);
      if (resolved.artifact.contractDigest !== config.action.contractDigest) throw Error("watch_contract_pin_mismatch");
    }
    const generation = expectedGeneration + 1, id = versionId(config.id, generation);
    const lease = prior.value?.lease ?? await binding.prepareLease(config, { producer: `watch-${config.id}`, epoch: randomUUID(), registeredAt: Date.now() }, signal);
    if (lease.grant.owner !== owner || lease.grant.connectionId !== config.connectionId || lease.grant.connectionRevision !== config.connectionRevision || lease.grant.generation !== config.sourceGeneration ||
      lease.grant.origins.length !== 1 || lease.grant.origins[0] !== config.origin || lease.grant.kinds.length !== 1 || lease.grant.kinds[0] !== config.kind || lease.grant.expiresAt !== config.expiresAt) throw Error("watch_producer_binding_mismatch");
    const configRef = await channelSeal(journal.blobs, owner, { config, lease });
    await journal.transact(current => {
      if (Number(latest(scope(current, owner), config.id)?.generation ?? 0) !== expectedGeneration) throw Error("watch_generation_conflict");
      return { events: [fact(owner, "Prepared", id, { watchId: config.id, generation, configRef })], result: undefined };
    }, () => allowed(config, "configure", signal));
    privateVersions.set(id, { config, lease }); await refresh();
    return activate(id, signal);
  };
  const activate = async (id: string, signal: AbortSignal) => {
    await refresh(); const prepared = rows.find(e => e.type === "AikoBrowserWatchPrepared" && e.id === id), value = effectiveVersion(privateVersions.get(id));
    if (!prepared || !value || latest(rows, String(prepared.watchId))?.id !== id) throw Error("watch_configuration_unavailable");
    const { config, lease } = value; await allowed(config, "configure", signal);
    if (state(config.id).status !== "active") return { status: "paused", id: config.id };
    const definition = browserWatchHarnessDefinitions().find(d => d.artifact.name === `browser.watch.${config.kind}.intent`)!;
    const hash = harnessDigest(definition.artifact), contractDigest = harnessDigest(definition.contract);
    await library.registerContract(definition.contract); await library.record(definition.artifact);
    const evaluationId = `watch-map:${config.kind}:${harnessDigest(await library.binding.context(signal)).slice(7)}`;
    const evaluation = await library.evaluate(hash, evaluationId, signal);
    if (!evaluation.eligible) throw Error("watch_mapper_not_verified");
    await library.promote(hash, evaluationId, 0, signal);
    const input = await native(wiring.api.bind({ name: `watch:${config.id}:input`, schema: channelLogSourceSchema(sourceKind(config.kind)), directions: ["inbox", "outbox"], authorityRef: binding.receivingAuthority, operationId: `watch:${config.id}:input`, backlog: config.backlog }));
    const output = await native(wiring.api.bind({ name: `watch:${config.id}:intent`, schema: BROWSER_WATCH_INTENT_SCHEMA, directions: ["inbox", "outbox"], authorityRef: binding.receivingAuthority, operationId: `watch:${config.id}:intent`, backlog: config.backlog }));
    const wire = await native(wiring.api.connect({ name: `watch:${config.id}`, generation: prepared.generation, input: { channel: input.channel, generation: input.generation },
      accepts: input.schema, handler: { harness: hash, contract: contractDigest }, output: { channel: output.channel, generation: output.generation, mode: "port" }, authorityRef: binding.receivingAuthority,
      start: "after-registration", operationId: `watch:${id}:connect`, maxAttempts: 2 }));
    if (wire.status !== "active") throw Error("watch_mapping_connection_failed");
    const retained = rows.find(e => e.type === "AikoBrowserWatchActivated" && e.watchId === config.id);
    const retainedLease = retained && channelLogSourceLease(rows, owner, String(retained.sourceId));
    if (retained && (!retainedLease?.request || retainedLease.request.expiresAt !== config.expiresAt || retainedLease.request.maxOccurrences !== config.maxOccurrences ||
      harnessDigest(retainedLease.request.filter) !== harnessDigest(filterOf(config)) || harnessDigest(retainedLease.request.port) !== harnessDigest({ channel: input.channel, generation: input.generation }))) throw Error("watch_source_lease_conflict");
    const source = retained ? { id: String(retained.sourceId), status: "active" } : await native(sources.api.register({ operationId: `watch:${config.id}:source`, source: sourceKind(config.kind), sourceAuthority: `watch-source:${config.id}`, receivingAuthority: binding.receivingAuthority,
      port: { channel: input.channel, generation: input.generation }, expiresAt: config.expiresAt, filter: filterOf(config), maxOccurrences: config.maxOccurrences }));
    if (source.status !== "active") throw Error("watch_source_not_active");
    await journal.transact(current => ({ events: current.some(e => e.owner === owner && e.type === "AikoBrowserWatchActivated" && e.id === id) ? [] : [fact(owner, "Activated", id, { watchId: config.id, generation: prepared.generation,
      wire: { id: wire.id, generation: wire.generation }, input: { channel: input.channel, generation: input.generation }, output: { channel: output.channel, generation: output.generation }, sourceId: source.id }), wake(owner, `watch:${id}:ready`)], result: undefined }), () => allowed(config, "configure", signal));
    await refresh();
    await mutateLease(lease.grant.producer, async () => {
      await refresh();
      if (state(config.id).status !== "active" || state(config.id).head?.id !== id) return;
      await allowed(config, "configure", signal);
      const active = controls(rows, config.id);
      await binding.configureLease({ ...lease, lifecycleRevision: activeLifecycle(rows, config.id),
        ...(active?.status === "active" && active.resumeFrom ? { resumeFrom: active.resumeFrom as BrowserWatchLease["resumeFrom"] } : {}) }, signal);
    });
    const health = (await inspect(config.id))[0]!;
    return { id: config.id, generation: prepared.generation, status: health.status };
  };
  const releaseLease = async (controlId: string, attempt: number, signal: AbortSignal) => {
    await refresh();
    const control = rows.find(e => e.type === "AikoBrowserWatchControlled" && e.id === controlId), release = control?.release as WatchLeaseRelease | undefined;
    if (!control || !release) return;
    await mutateLease(release.producer, async () => {
      await refresh();
      if (controls(rows, String(control.watchId))?.id !== controlId || releaseState(rows, control)?.status !== "pending" ||
        releaseChecks(rows, controlId).length !== attempt || signal.aborted) return;
      let confirmed = false, reason = "private_pause_unconfirmed", pausedThrough: number | undefined;
      const lifecycleRevision = release.lifecycleRevision ?? 0;
      const exactPaused = (status: unknown) => {
        const valid = !!status && typeof status === "object" && (status as any).producer === release.producer && (status as any).generation === release.generation &&
          (status as any).lifecycleRevision === lifecycleRevision && (status as any).state === "paused" && Number.isSafeInteger((status as any).pausedThrough) &&
          (status as any).pausedThrough >= Math.max(Number(control.cut), Number((control.sequenceCut as WatchSequenceCut)?.through ?? 0));
        if (valid) pausedThrough = (status as any).pausedThrough;
        return valid;
      };
      const privateCall = <T>(call: (deadline: AbortSignal) => Promise<T>) => {
        const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(10_000, release.deadlineAt - Date.now())))]);
        return new Promise<T>((resolve, reject) => {
          const aborted = () => reject(Error("watch_private_release_timeout"));
          if (deadline.aborted) { aborted(); return; }
          deadline.addEventListener("abort", aborted, { once: true });
          void Promise.resolve().then(() => call(deadline)).then(resolve, reject).finally(() => deadline.removeEventListener("abort", aborted));
        });
      };
      if (Date.now() < release.deadlineAt) {
        try { confirmed = exactPaused(await privateCall(s => binding.leaseStatus?.(release.producer, s) ?? Promise.resolve(undefined))); } catch { /* Still attempt idempotent pause. */ }
        if (!confirmed) {
          try {
            await refresh();
            if (controls(rows, String(control.watchId))?.id !== controlId || signal.aborted) return;
            // Pause is an idempotent revocation. Its acknowledgement alone is
            // insufficient; recover a lost acknowledgement by reading status.
            try { await privateCall(s => binding.pauseLease(release.producer, s, lifecycleRevision)); } catch { /* Verify retained private state below. */ }
            confirmed = exactPaused(await privateCall(s => binding.leaseStatus?.(release.producer, s) ?? Promise.resolve(undefined)));
          } catch { /* A missing or mismatched status cannot prove release. */ }
        }
      } else reason = "private_pause_deadline_elapsed";
      const at = Date.now(), delay = [1000, 5000, 30000][attempt];
      const nextAt = !confirmed && delay !== undefined && at + delay <= release.deadlineAt ? at + delay : undefined;
      await journal.transact(current => {
        const own = scope(current, owner);
        if (controls(own, String(control.watchId))?.id !== controlId || releaseChecks(own, controlId).length !== attempt) return { events: [], result: undefined };
        return { events: [fact(owner, "LeaseReleaseChecked", `release:${controlId}:${attempt}`, { at, controlId, watchId: control.watchId,
          producer: release.producer, sourceGeneration: release.generation, attempt, deadlineAt: release.deadlineAt,
          lifecycleRevision, ...(confirmed ? { pausedThrough } : {}),
          status: confirmed ? "confirmed" : "unconfirmed", ...(confirmed ? {} : { reason }), ...(nextAt === undefined ? {} : { nextAt }) })], result: undefined };
      });
      await refresh();
    });
  };
  const control = async (watchId: string, status: "active" | "paused" | "deleted", expectedRevision: number, signal: AbortSignal) => {
    if (!idPattern.test(watchId) || !["active", "paused", "deleted"].includes(status) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Error("watch_control_invalid");
    await refresh(); const s = state(watchId);
    if (!s.value || !binding.current()) throw Error("watch_unavailable");
    if (s.status === "deleted") throw Error("watch_deleted");
    // Revocation must remain possible after the session or lease expires.
    if (status === "active") {
      if (renewalRequests(rows, watchId).some(p => renewalState(rows, p)?.status !== "confirmed")) throw Error("watch_renewal_pending");
      if (releaseState(rows, s.control)?.status && releaseState(rows, s.control)?.status !== "confirmed") throw Error("watch_lease_release_unconfirmed");
      await allowed(s.value.config, "configure", signal);
      if (s.status === "active") {
        if (Number(s.control?.controlRevision ?? 0) !== expectedRevision) throw Error("watch_control_conflict");
        return { id: watchId, status: (await inspect(watchId))[0]!.status, controlRevision: expectedRevision };
      }
    }
    signal.throwIfAborted();
    await journal.transact(current => {
      const own = scope(current, owner);
      if (Number(controls(own, watchId)?.controlRevision ?? 0) !== expectedRevision) throw Error("watch_control_conflict");
      const grant = s.value!.lease.grant;
      const cut = Math.max(0, ...own.filter(e => browserEventKey(e) && watchEventMatches(e, s.value!.config, grant)).map(e => Number(e.sequence)));
      const floor = sequenceCut(own, watchId, grant), checked = status === "active" && s.control ? releaseChecks(own, String(s.control.id)).at(-1) : undefined;
      const resumeFrom = checked ? { lifecycleRevision: Number(checked.lifecycleRevision), pausedThrough: Number(checked.pausedThrough) } : undefined;
      if (status === "active" && (!resumeFrom || !Number.isSafeInteger(resumeFrom.pausedThrough) || !Number.isSafeInteger(resumeFrom.lifecycleRevision))) throw Error("watch_lease_release_unconfirmed");
      const at = Date.now();
      return { events: [fact(owner, "Controlled", `${watchId}:${expectedRevision + 1}`, { at, watchId, status, controlRevision: expectedRevision + 1, cut,
        sequenceCut: { ...floor, through: Math.max(cut, floor.through, resumeFrom?.pausedThrough ?? 0) },
        ...(status === "active" ? { resumeFrom } : { release: { producer: grant.producer, epoch: grant.epoch, generation: grant.generation, lifecycleRevision: activeLifecycle(own, watchId), deadlineAt: at + 60_000 } }) }), wake(owner, `watch:${watchId}:control:${expectedRevision + 1}`)], result: undefined };
    });
    await refresh();
    let reportedStatus: string = status;
    if (status === "active") reportedStatus = (await activate(String(s.head!.id), signal)).status;
    else await releaseLease(`${watchId}:${expectedRevision + 1}`, 0, signal);
    return { id: watchId, status: reportedStatus, controlRevision: expectedRevision + 1, ...(status === "active" ? {} : { release: releaseState(rows, state(watchId).control) }) };
  };
  /** Trusted ConnectorEngine callback only. Connection removal revokes all
   * matching source cuts atomically; it cannot grant or resume a watch. */
  const disconnect = async (connectionId: string, signal: AbortSignal = AbortSignal.timeout(60_000)) => {
    if (typeof connectionId !== "string" || !connectionId || connectionId.length > 128) throw Error("watch_connection_invalid");
    await refresh();
    const matching = [...new Set(rows.filter(e => e.type === "AikoBrowserWatchPrepared").map(e => String(e.watchId)))].flatMap(watchId => {
      const s = state(watchId);
      return s.value?.config.connectionId === connectionId && s.status === "active" ? [{ watchId, value: s.value }] : [];
    });
    const ids = await journal.transact(current => {
      const own = scope(current, owner), events: Event[] = [], ids: string[] = [];
      for (const { watchId, value } of matching) {
        const previous = controls(own, watchId);
        if (previous && previous.status !== "active") continue;
        const revision = Number(previous?.controlRevision ?? 0) + 1, id = `${watchId}:${revision}`, at = Date.now();
        const cut = Math.max(0, ...own.filter(e => browserEventKey(e) && watchEventMatches(e, value.config, value.lease.grant)).map(e => Number(e.sequence)));
        const floor = sequenceCut(own, watchId, value.lease.grant);
        events.push(fact(owner, "Controlled", id, { at, watchId, controlRevision: revision, status: "paused", reason: "connection-disconnected", cut,
          sequenceCut: { ...floor, through: Math.max(cut, floor.through) },
          release: { producer: value.lease.grant.producer, epoch: value.lease.grant.epoch, generation: value.lease.grant.generation, lifecycleRevision: activeLifecycle(own, watchId), deadlineAt: at + 60_000 } }), wake(owner, `watch:${watchId}:control:${revision}`));
        ids.push(id);
      }
      return { events, result: ids };
    });
    await refresh();
    await Promise.all(ids.map(id => releaseLease(id, 0, signal)));
    return { status: "paused", watches: matching.map(item => item.watchId) };
  };
  const dispatchCurrent = (intent: BrowserWatchDispatch) => {
    const s = state(intent.watchId), version = effectiveVersion(privateVersions.get(versionId(intent.watchId, intent.generation))), config = version?.config;
    const cut = Math.max(0, ...rows.filter(e => e.type === "AikoBrowserWatchControlled" && e.watchId === intent.watchId && e.status !== "active").map(e => Number(e.cut)));
    return !!config && binding.current() && (binding.configCurrent?.(config) ?? true) && s.status === "active" && config.expiresAt > Date.now() &&
      intent.event.sequence > Math.max(cut, sequenceCut(rows, intent.watchId, version!.lease.grant).through) &&
      watchEventMatches(intent.event, config, version!.lease.grant) && harnessDigest(intent.action) === harnessDigest(config.action);
  };
  const authorizeAction = async (intent: BrowserWatchDispatch, operation: "execute" | "reconcile", signal: AbortSignal) => {
    await refresh();
    const config = effectiveVersion(privateVersions.get(versionId(intent.watchId, intent.generation)))?.config;
    if (!config || intent.event.owner !== owner || harnessDigest(intent.action) !== harnessDigest(config.action)) return false;
    await allowed(config, operation === "reconcile" ? "reconcile" : "dispatch", signal);
    await refresh();
    if (operation === "execute") return dispatchCurrent(intent);
    // Pause and collection expiry stop new actions, but existing receipts retain
    // their original action pins and still require current account authority.
    return binding.current() && rows.some(e => e.type === "AikoBrowserWatchStarted" && e.id === intent.operationId &&
      e.watchId === intent.watchId && e.generation === intent.generation && e.eventId === intent.event.id);
  };
  const inputFor = async (config: BrowserWatchConfig, event: BrowserObservedEvent) => {
    if (config.action.kind !== "harness") return;
    let input = structuredClone(config.action.input);
    if (config.action.eventInputs) {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("watch_input_object_required");
      const payload = event.payloadRef ? await channelHydrate(journal.blobs, owner, event.payloadRef) : undefined;
      const context: Record<string, unknown> = { ...event, payload };
      for (const [name, path] of Object.entries(config.action.eventInputs)) {
        let value: unknown = context;
        for (const segment of path) {
          if (!value || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, segment)) throw Error("watch_event_input_unavailable");
          value = (value as Record<string, unknown>)[segment];
        }
        (input as Record<string, HarnessJson>)[name] = structuredClone(value) as HarnessJson;
      }
    }
    // Resolve and validate against the exact saved version, never the route head.
    const resolved = await library.resolve(config.action.digest);
    if (resolved.artifact.contractDigest !== config.action.contractDigest) throw Error("watch_contract_pin_mismatch");
    if (!new Validator(resolved.contract.inputSchema as never).validate(input).valid) throw Error("watch_input_schema_mismatch");
    return input;
  };
  const checkedIntent = async (source: string): Promise<BrowserWatchDispatch> => {
    await refresh();
    const accepted = rows.find(e => e.type === "AikoChannelWiringAccepted" && e.id === source);
    const claim = rows.find(e => e.type === "AikoChannelWiringClaimed" && e.id === accepted?.invocation);
    const wire = claim?.wire as { id: string; generation: number; handler: { harness: string; contract: string } } | undefined;
    const activation = rows.find(e => e.type === "AikoBrowserWatchActivated" && (e.wire as any)?.id === wire?.id && (e.wire as any)?.generation === wire?.generation);
    const value = activation && privateVersions.get(String(activation.id));
    if (!accepted || !wire || !activation || !value || accepted.schema !== BROWSER_WATCH_INTENT_SCHEMA ||
      harnessDigest(accepted.port) !== harnessDigest(activation.output) || !rows.some(e => e.type === "AikoChannelWiringSettled" && e.invocation === accepted.invocation && e.status === "satisfied")) throw Error("watch_checked_intent_required");
    const definition = browserWatchHarnessDefinitions().find(d => d.artifact.name === `browser.watch.${value.config.kind}.intent`)!;
    if (wire.handler.harness !== harnessDigest(definition.artifact) || wire.handler.contract !== harnessDigest(definition.contract)) throw Error("watch_mapper_pin_mismatch");
    const mapped = await channelHydrate(journal.blobs, owner, accepted.valueRef) as { eventId: string; occurrence: string };
    const event = rows.find(e => browserEventKey(e) && e.id === mapped.eventId) as BrowserObservedEvent | undefined;
    const input = rows.find(e => e.type === "AikoChannelWiringAccepted" && e.id === claim!.source);
    const original = input && await channelHydrate(journal.blobs, owner, input.valueRef) as { eventId: string; occurrence: string };
    if (!event || !original || original.eventId !== mapped.eventId || original.occurrence !== mapped.occurrence || !watchEventMatches(event, value.config, value.lease.grant)) throw Error("watch_event_reference_mismatch");
    return { operationId: `watch:${value.config.id}:${activation.generation}:${channelDigest([owner, event.id, value.config.action])}`, watchId: value.config.id,
      generation: Number(activation.generation), event, action: value.config.action };
  };
  const settle = async (intent: BrowserWatchDispatch, source: string, result: { status: "completed" | "failed" | "unknown"; result?: unknown }, request = "initial") => {
    const resultRef = result.result === undefined ? undefined : await channelSeal(journal.blobs, owner, result.result);
    await journal.transact(current => ({ events: current.some(e => e.owner === owner && e.type === "AikoBrowserWatchSettled" && e.id === `${intent.operationId}:${request}`) ? [] :
      [fact(owner, "Settled", `${intent.operationId}:${request}`, { operationId: intent.operationId, watchId: intent.watchId, generation: intent.generation, source, status: result.status, ...(resultRef ? { resultRef } : {}) })], result: undefined }));
    // Only after durable outcome retention may this checked output release backlog.
    await wiring.consume(source, intent.operationId);
    await refresh();
  };
  const recordActionResult = async (intent: BrowserWatchDispatch, source: string, result: BrowserWatchActionResult, requestId = "initial") => {
    if (result?.status !== "pending") {
      await settle(intent, source, result && ["completed", "failed", "unknown"].includes(result.status) ? result : { status: "unknown" }, requestId);
      return;
    }
    if (!["actor", "channel"].includes(result.receipt?.kind) || result.receipt?.kind !== (intent.action?.kind === "actor" ? "actor" : intent.action?.kind === "webhook" ? "channel" : undefined) || typeof result.receipt?.id !== "string" || !result.receipt.id || result.receipt.id.length > 1024 ||
      !Number.isSafeInteger(result.deadlineAt) || result.deadlineAt <= Date.now() || result.deadlineAt > Date.now() + 86400000) {
      await settle(intent, source, { status: "unknown", result: { reason: "watch_pending_receipt_invalid_or_expired" } }, requestId); return;
    }
    const jobRef = await channelSeal(journal.blobs, owner, { receipt: result.receipt, deadlineAt: result.deadlineAt });
    await journal.transact(current => {
      const own = scope(current, owner);
      if (pendingAction(own, intent.operationId) || own.some(e => e.type === "AikoBrowserWatchSettled" && e.id === `${intent.operationId}:${requestId}`)) return { events: [], result: undefined };
      return { events: [fact(owner, "ActionAccepted", `${intent.operationId}:${requestId}:accepted`, { operationId: intent.operationId,
        watchId: intent.watchId, generation: intent.generation, source, requestId, jobRef, receiptKey: harnessDigest(result.receipt), deadlineAt: result.deadlineAt })], result: undefined };
    });
    await refresh();
  };
  const checkPending = async (acceptedId: string, receiptRevision: string, signal: AbortSignal) => {
    await refresh();
    const accepted = rows.find(e => e.type === "AikoBrowserWatchActionAccepted" && e.id === acceptedId);
    if (!accepted || pendingAction(rows, String(accepted.operationId))?.id !== acceptedId) return;
    const source = String(accepted.source), requestId = String(accepted.requestId);
    // The saved Started identity is sufficient to retain an unavailable result;
    // no receipt path may invent fresh action input or execute a replacement.
    const identity = { operationId: String(accepted.operationId), watchId: String(accepted.watchId), generation: Number(accepted.generation) } as BrowserWatchDispatch;
    let result: BrowserWatchActionResult = { status: "unknown" };
    try {
      const job = await channelHydrate(journal.blobs, owner, accepted.jobRef);
      if (!job || job.deadlineAt !== accepted.deadlineAt || harnessDigest(job.receipt) !== accepted.receiptKey) throw Error("watch_pending_receipt_unavailable");
      const intent = await checkedIntent(source);
      if (requestId !== "initial") intent.reconciliationRequestId = requestId;
      const config = effectiveVersion(privateVersions.get(versionId(intent.watchId, intent.generation)))?.config;
      if (!config) throw Error("watch_configuration_unavailable");
      await allowed(config, "reconcile", signal);
      if (binding.reconcile) result = await binding.reconcile(intent, signal);
      if (result?.status === "pending") {
        if (Number(accepted.deadlineAt) <= Date.now()) {
          result = { status: "unknown", result: { reason: "watch_action_deadline" } };
        } else if (result.deadlineAt === accepted.deadlineAt && harnessDigest(result.receipt) === accepted.receiptKey) {
          await journal.transact(current => ({ events: pendingAction(scope(current, owner), String(accepted.operationId))?.id !== acceptedId || current.some(e =>
            e.owner === owner && e.type === "AikoBrowserWatchActionReceiptChecked" && e.id === `${acceptedId}:${receiptRevision}`) ? [] :
            [fact(owner, "ActionReceiptChecked", `${acceptedId}:${receiptRevision}`, { acceptedId, operationId: accepted.operationId, receiptRevision })], result: undefined }));
          await refresh(); return;
        } else result = { status: "unknown", result: { reason: "watch_pending_receipt_changed" } };
      }
    } catch { /* Missing custody or authority holds the dispatched outcome. */ }
    await recordActionResult(identity, source, result, requestId);
  };
  const dispatch = async (source: string, signal: AbortSignal) => {
    await refresh();
    if (pendingActions(rows).some(e => e.source === source)) return;
    const priorOutput = rows.findLast(e => e.type === "AikoBrowserWatchSettled" && e.source === source);
    if (priorOutput) { await wiring.consume(source, String(priorOutput.operationId)); return; }
    let intent: BrowserWatchDispatch;
    try { intent = await checkedIntent(source); }
    catch {
      signal.throwIfAborted();
      // Mapping custody can expire independently of task receipts. Record the
      // unavailable input and release only this checked output; never invent it.
      const accepted = rows.find(e => e.type === "AikoChannelWiringAccepted" && e.id === source);
      const claim = rows.find(e => e.type === "AikoChannelWiringClaimed" && e.id === accepted?.invocation), wire = claim?.wire as any;
      const activation = rows.find(e => e.type === "AikoBrowserWatchActivated" && (e.wire as any)?.id === wire?.id && (e.wire as any)?.generation === wire?.generation);
      if (!activation) throw Error("watch_checked_intent_required");
      const priorStart = rows.find(e => e.type === "AikoBrowserWatchStarted" && e.source === source);
      const operationId = priorStart ? String(priorStart.id) : `watch:${activation.watchId}:${activation.generation}:unavailable:${source}`;
      const resultRef = await channelSeal(journal.blobs, owner, { reason: "watch_input_unavailable" });
      await journal.transact(current => ({ events: current.some(e => e.owner === owner && e.type === "AikoBrowserWatchSettled" && e.source === source) ? [] : [fact(owner, "Settled", `${operationId}:initial`, {
        operationId, source, watchId: activation.watchId, generation: activation.generation, status: priorStart ? "unknown" : "failed", resultRef,
      })], result: undefined }));
      await wiring.consume(source, operationId); await refresh(); return;
    }
    const config = effectiveVersion(privateVersions.get(versionId(intent.watchId, intent.generation)))?.config;
    if (!config) throw Error("watch_configuration_unavailable");
    const settled = rows.findLast(e => e.type === "AikoBrowserWatchSettled" && e.operationId === intent.operationId);
    if (settled) { await wiring.consume(source, intent.operationId); return; }
    let started = rows.some(e => e.type === "AikoBrowserWatchStarted" && e.id === intent.operationId);
    if (!started) {
      try {
        await allowed(config, "dispatch", signal);
        if (!dispatchCurrent(intent)) throw Error("watch_paused_or_source_cut");
        intent.input = await inputFor(config, intent.event);
        await allowed(config, "dispatch", signal);
        started = await journal.transact(current => {
          rows = scope(current, owner);
          if (!dispatchCurrent(intent)) throw Error("watch_paused_or_source_cut");
          const existing = rows.some(e => e.type === "AikoBrowserWatchStarted" && e.id === intent.operationId);
          return { events: existing ? [] : [fact(owner, "Started", intent.operationId, { watchId: intent.watchId, generation: intent.generation, source, eventId: intent.event.id })], result: existing };
        }, () => allowed(config, "dispatch", signal));
      } catch (error) {
        signal.throwIfAborted();
        await refresh();
        if (rows.some(e => e.type === "AikoBrowserWatchStarted" && e.id === intent.operationId)) return;
        await settle(intent, source, { status: "failed", result: { reason: error instanceof Error ? error.message : "watch_unavailable" } }); return;
      }
    }
    let result: Awaited<ReturnType<BrowserWatchBindings["execute"]>>;
    try {
      if (started) {
        await allowed(config, "reconcile", signal);
        result = binding.reconcile ? await binding.reconcile(intent, signal) : { status: "unknown" };
      }
      else {
        await refresh();
        if (!dispatchCurrent(intent)) result = { status: "failed", result: { reason: "watch_paused_before_dispatch" } };
        else { await allowed(config, "dispatch", signal); result = await binding.execute(intent, signal); }
      }
    } catch { result = { status: "unknown" }; }
    await recordActionResult(intent, source, result);
  };
  const reconcile = async (operationId: string, requestId: string, signal: AbortSignal) => {
    if (!idPattern.test(requestId) || !binding.current()) throw Error("watch_reconcile_invalid");
    await refresh();
    const started = rows.find(e => e.type === "AikoBrowserWatchStarted" && e.id === operationId);
    if (!started) throw Error("watch_dispatch_missing");
    if (pendingAction(rows, operationId)) return { operationId, status: "pending" };
    const prior = rows.findLast(e => e.type === "AikoBrowserWatchSettled" && e.operationId === operationId);
    if (prior && prior.status !== "unknown") return { operationId, status: prior.status };
    if (rows.some(e => e.type === "AikoBrowserWatchSettled" && e.id === `${operationId}:${requestId}`)) return { operationId, status: "unknown" };
    if (rows.filter(e => e.type === "AikoBrowserWatchSettled" && e.operationId === operationId).length >= 8) throw Error("watch_reconcile_budget_exhausted");
    const intent = await checkedIntent(String(started.source));
    const config = effectiveVersion(privateVersions.get(versionId(intent.watchId, intent.generation)))?.config;
    if (!config) throw Error("watch_configuration_unavailable");
    await allowed(config, "reconcile", signal);
    await journal.transact(current => {
      const own = scope(current, owner);
      if (own.some(e => e.type === "AikoBrowserWatchReconcileRequested" && e.id === `${operationId}:${requestId}`)) return {events: [], result: undefined};
      if (own.filter(e => e.type === "AikoBrowserWatchReconcileRequested" && e.operationId === operationId).length >= 7)
        throw Error("watch_reconcile_budget_exhausted");
      return {events: [fact(owner, "ReconcileRequested", `${operationId}:${requestId}`, {
        operationId, requestId, watchId: started.watchId, generation: started.generation, source: started.source,
      })], result: undefined};
    }, () => allowed(config, "reconcile", signal));
    intent.reconciliationRequestId = requestId;
    let result: Awaited<ReturnType<BrowserWatchBindings["execute"]>> = { status: "unknown" };
    try {
      await allowed(config, "reconcile", signal);
      if (binding.reconcile) result = await binding.reconcile(intent, signal);
    } catch { /* Unknown remains held. */ }
    await recordActionResult(intent, String(started.source), result, requestId);
    return { operationId, status: pendingAction(rows, operationId) ? "pending" : rows.findLast(e => e.type === "AikoBrowserWatchSettled" && e.operationId === operationId)?.status ?? "unknown" };
  };
  const inspect = async (watchId?: string) => {
    await refresh();
    return Promise.all([...new Set(rows.filter(e => e.type === "AikoBrowserWatchPrepared" && (!watchId || e.watchId === watchId)).map(e => String(e.watchId)))].map(async id => {
      const s = state(id), value = s.value;
      if (!value) return { id, generation: s.head!.generation, status: "needs-attention", reason: "private_configuration_unavailable", release: releaseState(rows, s.control) };
      const activated = rows.find(e => e.type === "AikoBrowserWatchActivated" && e.id === s.head!.id);
      const stop = activated && channelLogSourceLease(rows, owner, String(activated.sourceId)).stop;
      const delivery = rows.findLast(e => ["AikoBrowserWatchSettled", "AikoBrowserWatchActionAccepted"].includes(e.type) && e.watchId === id);
      const observed = rows.findLast(e => browserEventKey(e) && watchEventMatches(e, value.config, value.lease.grant));
      let collector: any;
      try { collector = await binding.leaseStatus?.(value.lease.grant.producer); } catch { collector = { state: "needs-attention", reason: "collector_unavailable" }; }
      if (collector && (collector.producer !== value.lease.grant.producer || collector.generation !== value.lease.grant.generation || collector.lifecycleRevision !== activeLifecycle(rows, id) || Number(collector.leaseRevision ?? 0) !== Number(value.lease.leaseRevision ?? 0)))
        collector = { state: "needs-attention", reason: collector.reason === "collector_unavailable" ? "collector_unavailable" : "collector_scope_mismatch" };
      const status = s.status !== "active" ? s.status : !binding.current() || !(binding.configCurrent?.(value.config) ?? true) || value.config.expiresAt <= Date.now() || stop ? "needs-attention" :
        !activated ? "setting-up" : collector?.state === "watching" ? "watching" : collector?.state === "catching-up" ? "catching-up" : "needs-attention";
      return { id, label: value.config.label, generation: s.head!.generation, controlRevision: Number(s.control?.controlRevision ?? 0), status, release: releaseState(rows, s.control),
        leaseRevision: Number(value.lease.leaseRevision ?? 0), renewal: renewalState(rows, renewalRequests(rows, id).at(-1)),
        ...(activated ? { budget: (() => { const source = channelLogSourceLease(rows, owner, String(activated.sourceId)); return { used: source.used, limit: value.config.maxOccurrences, remaining: Math.max(0, value.config.maxOccurrences - source.used) }; })() } : {}),
        config: value.config, source: { activated: !!activated, ...(stop ? { reason: stop.reason } : {}) }, collector,
        lastEventAt: observed?.observedAt, lastTaskAt: delivery?.at, lastTaskStatus: delivery?.type === "AikoBrowserWatchActionAccepted" ? "pending" : delivery?.status,
        lastTaskOperationId: delivery?.operationId, ...(delivery?.type === "AikoBrowserWatchActionAccepted" ? { lastTaskDeadlineAt: delivery.deadlineAt } : {}) };
    }));
  };
  const sample = async (watchId: string, signal: AbortSignal) => {
    await refresh(); const s = state(watchId);
    if (!s.value) throw Error("watch_unavailable");
    await allowed(s.value.config, "dispatch", signal);
    const event = rows.findLast(e => browserEventKey(e) && watchEventMatches(e, s.value!.config, s.value!.lease.grant)) as BrowserObservedEvent | undefined;
    if (!event) return { status: "waiting-for-example" };
    const payload = event.payloadRef ? await channelHydrate(journal.blobs, owner, event.payloadRef) : undefined;
    await allowed(s.value.config, "dispatch", signal);
    return { status: "available", event: { id: event.id, kind: event.kind, observedAt: event.observedAt, fields: event.fields }, payload };
  };
  const acknowledgeGap = async (watchId: string, expectedGeneration: number, missed: number, signal: AbortSignal) => {
    if (!Number.isSafeInteger(missed) || missed < 1 || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
      throw Error("watch_gap_acknowledgement_invalid");
    await refresh();
    const s = state(watchId);
    if (!s.value || !binding.acknowledgeGap || s.status === "deleted") throw Error("watch_gap_acknowledgement_unavailable");
    if (s.head!.generation !== expectedGeneration) throw Error("watch_generation_conflict");
    await allowed(s.value.config, "configure", signal);
    // The private runner compares the current source generation and missed count.
    // Acknowledging loss neither changes the watch lifecycle nor replays events.
    return binding.acknowledgeGap(s.value.lease.grant.producer, s.value.lease.grant.generation, missed, signal);
  };
  const discovery = async (signal: AbortSignal): Promise<BrowserWatchDiscovery> => {
    if (!binding.discovery || !binding.current()) throw Error("watch_discovery_unavailable");
    const value = await binding.discovery(signal);
    signal.throwIfAborted();
    if (!binding.current() || !value || Buffer.byteLength(JSON.stringify(value)) > 262144 ||
      !Array.isArray(value.sites) || value.sites.length > 128 || !Array.isArray(value.actions) || value.actions.length > 128 ||
      !Number.isSafeInteger(value.defaults?.expiresInMs) || value.defaults.expiresInMs < 1000 || value.defaults.expiresInMs > 86400000)
      throw Error("watch_discovery_invalid");
    const label = (text: string) => { if (typeof text !== "string" || !text.trim() || text.length > 160) throw Error("watch_discovery_invalid"); return text; };
    const base: BrowserWatchConfig = {id:"discovery",label:"Available watch",connectionId:"site",connectionRevision:"revision",sourceGeneration:1,
      origin:"https://example.com",kind:"push",outcome:"received",action:{kind:"actor",instruction:"Investigate the event"},
      expiresAt:Date.now()+value.defaults.expiresInMs,backlog:value.defaults.backlog,maxOccurrences:value.defaults.maxOccurrences};
    validateConfig(base);
    const sites = value.sites.map(site => {
      if (!site || typeof site.connectionId !== "string" || site.connectionId.length > 128 || typeof site.connectionRevision !== "string" || site.connectionRevision.length > 128 ||
        !Array.isArray(site.events) || site.events.length > 32 || site.expiresAt!==undefined&&(!Number.isSafeInteger(site.expiresAt)||site.expiresAt<=Date.now())) throw Error("watch_discovery_invalid");
      const identity = {connectionId:site.connectionId,label:label(site.label),origin:site.origin,connectionRevision:site.connectionRevision,sourceGeneration:site.sourceGeneration};
      validateConfig({...base,...identity});
      const events = site.events.map(event => {
        if (!event || !idPattern.test(event.id)) throw Error("watch_discovery_invalid");
        const choice = {id:event.id,label:label(event.label),kind:event.kind,outcome:event.outcome,
          ...(event.method === undefined ? {} : {method:event.method}),...(event.route === undefined ? {} : {route:event.route})};
        validateConfig({...base,...identity,kind:choice.kind,outcome:choice.outcome,method:choice.method,route:choice.route});
        return choice;
      });
      if (new Set(events.map(event=>event.id)).size!==events.length) throw Error("watch_discovery_invalid");
      return {...identity,events,...(site.expiresAt===undefined?{}:{expiresAt:site.expiresAt})};
    });
    const actions = value.actions.map(choice => {
      if (!choice || !idPattern.test(choice.id) || choice.description !== undefined && (typeof choice.description!=="string" || choice.description.length>1000) ||
        choice.supportsInstruction !== undefined && (typeof choice.supportsInstruction!=="boolean" || choice.action.kind!=="actor")) throw Error("watch_discovery_invalid");
      validateConfig({...base,action:choice.action});
      return {id:choice.id,label:label(choice.label),...(choice.description===undefined?{}:{description:choice.description}),action:structuredClone(choice.action),
        ...(choice.supportsInstruction===undefined?{}:{supportsInstruction:choice.supportsInstruction})};
    });
    if (new Set(sites.map(site=>site.connectionId)).size!==sites.length || new Set(actions.map(action=>action.id)).size!==actions.length) throw Error("watch_discovery_invalid");
    return {sites,actions,defaults:{expiresInMs:value.defaults.expiresInMs,backlog:value.defaults.backlog,maxOccurrences:value.defaults.maxOccurrences}};
  };
  const nativeComponent = component({
    name: "aiko.browser-watches",
    keys: { prefixes: ["aiko-browser-watch:"], keyOf: e => e.type.startsWith("AikoBrowserWatch") ? browserWatchEventKey(e) : undefined },
    initial: () => [] as Event[],
    step: (s, e) => e.owner === owner || (!e.owner && receiptEvent(e)) || ["AlarmFired", "AikoChannelLogSourceWake"].includes(e.type) ? [...s, e] : s,
    output: current => {
      const transitions: ReturnType<typeof effect<any, Self>>[] = [];
      for (const request of current.filter(e => e.type === "AikoBrowserWatchLeaseRenewalRequested")) {
        const renewal = renewalState(current, request);
        if (renewal?.status !== "pending" || renewal.nextAt !== undefined && renewal.nextAt > Date.now() || controls(current, String(request.watchId))?.status === "deleted") continue;
        transitions.push(effect({ key: `aiko-browser-watch:renew:${request.id}:${renewal.attempts}`, input: undefined,
          act: () => Effect.promise(async signal => { await checkRenewal(String(request.id), signal); return []; }) }));
      }
      for (const pending of pendingActions(current)) {
        const receiptRevision = harnessDigest(receiptChanges(current, pending));
        const expired = Number(pending.deadlineAt) <= Date.now();
        if (!expired && current.some(e => e.type === "AikoBrowserWatchActionReceiptChecked" && e.id === `${pending.id}:${receiptRevision}`)) continue;
        transitions.push(effect({ key: `aiko-browser-watch:receipt:${pending.id}:${expired ? "deadline" : receiptRevision}`, input: undefined,
          act: () => Effect.promise(async signal => { await checkPending(String(pending.id), receiptRevision, signal); return []; }) }));
      }
      for (const control of current.filter(e => e.type === "AikoBrowserWatchControlled" && e.status !== "active" && e.release)) {
        if (controls(current, String(control.watchId))?.id !== control.id) continue;
        const release = releaseState(current, control);
        if (release?.status !== "pending" || release.nextAt !== undefined && release.nextAt > Date.now()) continue;
        transitions.push(effect({ key: `aiko-browser-watch:release:${control.id}:${release.attempts}`, input: undefined,
          act: () => Effect.promise(async signal => { await releaseLease(String(control.id), release.attempts, signal); return []; }) }));
      }
      for (const prepared of current.filter(e => e.type === "AikoBrowserWatchPrepared")) {
        if (latest(current, String(prepared.watchId))?.id !== prepared.id ||
          current.some(e => e.type === "AikoBrowserWatchActivated" && e.id === prepared.id) ||
          (controls(current, String(prepared.watchId))?.status ?? "active") !== "active") continue;
        transitions.push(effect({ key: `aiko-browser-watch:activate:${prepared.id}`, input: undefined,
          act: () => Effect.promise(async signal => { await activate(String(prepared.id), signal); return []; }) }));
      }
      for (const accepted of current.filter(e => e.type === "AikoChannelWiringAccepted" && e.schema === BROWSER_WATCH_INTENT_SCHEMA)) {
        const claim = current.find(e => e.type === "AikoChannelWiringClaimed" && e.id === accepted.invocation), wire = claim?.wire as any;
        if (!wire || !current.some(e => e.type === "AikoBrowserWatchActivated" && (e.wire as any)?.id === wire.id && (e.wire as any)?.generation === wire.generation) ||
          !current.some(e => e.type === "AikoChannelWiringSettled" && e.invocation === accepted.invocation && e.status === "satisfied") ||
          current.some(e => e.type === "AikoChannelWiringConsumed" && e.source === accepted.id) || pendingActions(current).some(e => e.source === accepted.id)) continue;
        transitions.push(effect({ key: `aiko-browser-watch:dispatch:${accepted.id}`, input: undefined,
          act: () => Effect.promise(async signal => { await dispatch(String(accepted.id), signal); return []; }) }));
      }
      return { view: undefined, transitions };
    },
  });
  const tools: NativeTool<Self>[] = [
    { spec: { name: "browser_watch_renew", description: "Explicitly extend a watch deadline or cumulative occurrence ceiling. Preserves its producer, source cursor, action pins and past receipts; renewing a paused watch does not resume it. Retry identical values to check an uncertain renewal.", inputSchema: { type: "object", properties: {
      id: { type: "string" }, expectedGeneration: { type: "integer", minimum: 1 }, expectedLeaseRevision: { type: "integer", minimum: 0 },
      expiresAt: { type: "integer" }, maxOccurrences: { type: "integer", minimum: 1, maximum: 1000000 } }, required: ["id", "expectedGeneration", "expectedLeaseRevision", "expiresAt", "maxOccurrences"], additionalProperties: false } },
      run: raw => Effect.promise(signal => renew(raw as Parameters<typeof renew>[0], signal)) },
    { spec: { name: "browser_watch_configure", description: "Save an authorized Site → When → Do watch or explicitly upgrade its pinned action. expectedGeneration guards concurrent edits.", inputSchema: { type: "object", properties: { config: { type: "object" }, expectedGeneration: { type: "integer", minimum: 0 } }, required: ["config", "expectedGeneration"], additionalProperties: false } }, run: raw => Effect.promise(signal => configure((raw as any).config, (raw as any).expectedGeneration, signal)) },
    { spec: { name: "browser_watch_control", description: "Pause, resume or delete an owned watch. Pausing cancels undispatched work; unknown effects remain held for reconciliation.", inputSchema: { type: "object", properties: { id: { type: "string" }, status: { enum: ["active", "paused", "deleted"] }, expectedRevision: { type: "integer", minimum: 0 } }, required: ["id", "status", "expectedRevision"], additionalProperties: false } }, run: raw => Effect.promise(signal => control((raw as any).id, (raw as any).status, (raw as any).expectedRevision, signal)) },
    { spec: { name: "browser_watch_status", description: "Show retained task state and separate source and collector health. Does not expose producer credentials.", inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } }, run: raw => Effect.promise(() => inspect((raw as any).id)) },
    { spec: { name: "browser_watch_sample", description: "Read an actual captured example under current connection authority. This does not execute its configured action.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } }, run: raw => Effect.promise(signal => sample((raw as any).id, signal)) },
    { spec: { name: "browser_watch_reconcile", description: "Check an uncertain task's existing receipt without replaying its effect.", inputSchema: { type: "object", properties: { operationId: { type: "string" }, requestId: { type: "string" } }, required: ["operationId", "requestId"], additionalProperties: false } }, run: raw => Effect.promise(signal => reconcile((raw as any).operationId, (raw as any).requestId, signal)) },
  ];
  if (binding.discovery) tools.push({spec:{name:"browser_watch_discovery",description:"List current connected sites, observable events and configured action choices for watch setup. Discovery is not permission to execute; configuration and dispatch recheck authority.",inputSchema:{type:"object",properties:{},additionalProperties:false}},
    run: () => Effect.promise(signal => discovery(signal))});
  if (binding.acknowledgeGap) tools.push({
    spec: {name:"browser_watch_acknowledge_gap",description:"Acknowledge the currently reported observation loss for an owned watch. Retains the loss history; does not recover events, replay actions or resume a paused watch. Supply the watch generation and missed count shown by status.",inputSchema:{type:"object",properties:{id:{type:"string"},expectedGeneration:{type:"integer",minimum:1},missed:{type:"integer",minimum:1}},required:["id","expectedGeneration","missed"],additionalProperties:false}},
    run: raw => Effect.promise(signal => acknowledgeGap((raw as any).id,(raw as any).expectedGeneration,(raw as any).missed,signal)),
  });
  const scopedTools = tools.map(tool => ({ ...tool, run: (...args: Parameters<typeof tool.run>) => Effect.gen(function* () {
    const self = yield* Self;
    if (self.actor !== "aiko" || self.thread !== `user-${owner}` || !binding.current()) throw Error("watch_owner_denied");
    const result = yield* tool.run(...args);
    if (!binding.current()) throw Error("watch_owner_denied");
    return result;
  }) }));
  return { component: nativeComponent, tools: scopedTools, refresh, producerGrants, sourceGrants, configure, activate, control, disconnect, inspect, sample, reconcile, acknowledgeGap, discovery, dispatchCurrent, authorizeAction, renew };
}
