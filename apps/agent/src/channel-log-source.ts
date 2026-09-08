import { Effect } from "effect";
import { BROWSER_EVENT_SCHEMA, browserEventKey, browserEventTypes, validateBrowserEventFields, type BrowserEventKind } from "./browser-events.ts";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import {
  browserToolActionOf,
  browserToolCategoryOf,
  BROWSER_TRACE_SCHEMA_VERSION,
  BROWSER_TRACE_REDACTION_REVISION,
} from "@unbrowse/browser-harness/trace";
import { channelDigest, CHANNEL_PROVENANCE } from "./channel-bindings.ts";
import { channelSeal, channelHydrate } from "./channel-custody.ts";
import { harnessDigest } from "./harness-library.ts";
import {
  loginObservationEvent,
  type NativeLoginObservation,
} from "./native-login-observation.ts";
import { routeBackground } from "./background-route.ts";
import type { createChannelWiring, WiringJournal } from "./channel-wiring.ts";

export type ChannelLogSourceKind =
  "browser-result" | "knowledge-change" | "private-login" | "browser-push" | "browser-notification" | "browser-network";
export interface ChannelLogSourceGrant {
  owner: string;
  id: string;
  kind: ChannelLogSourceKind;
  receivingAuthority: string;
  active: boolean;
  expiresAt: number;
  maxBindings: number;
  /** Trusted browser watch scope and monotone private queue floor. This changes
   * admission, never the saved source snapshot, pin or cursor numbering. */
  browserSequenceCut?: { producer: string; epoch: string; generation: number; through: number };
  /** Confirmed native watch renewal; the cumulative budget never resets the cut. */
  browserLease?: { revision: number; expiresAt: number; maxOccurrences: number; requestId: string };
  /** A watch owns one immutable source cut, including after exhaustion. */
  browserOperationId?: string;
}
/** Trusted host configuration, refreshed at registration and every admission. No
 * caller-selected owner, stream, predicate, model or network capability exists. */
export type ChannelLogSourcePolicy = (
  owner: string,
) => readonly ChannelLogSourceGrant[];
export interface ChannelLogSourceBindings {
  grants(): readonly ChannelLogSourceGrant[];
  current(): boolean;
}
export interface BrowserLogSourceFilter {
  connectionId: string; connectionRevision: string; generation: number; origin: string;
  outcome: string; method?: string; route?: string; excludeCausePrefix?: string;
}
export function matchesBrowserLogSource(e: Event, filter: BrowserLogSourceFilter) {
  const fields = e.fields as Record<string, unknown> | undefined;
  return e.connectionId === filter.connectionId && e.connectionRevision === filter.connectionRevision && e.generation === filter.generation &&
    fields?.origin === filter.origin && fields?.outcome === filter.outcome &&
    (filter.method === undefined || fields?.method === filter.method) && (filter.route === undefined || fields?.route === filter.route) &&
    !(filter.excludeCausePrefix && typeof e.cause === "string" && e.cause.startsWith(filter.excludeCausePrefix));
}
const legacyTypes = {
  "browser-result": "BrowserToolResultObserved",
  "knowledge-change": "AikoKnowledgeChanged",
  "private-login": "AikoPrivateLoginObserved",
};
const types: Record<ChannelLogSourceKind, string> = { ...legacyTypes,
  "browser-push": browserEventTypes.push,
  "browser-notification": browserEventTypes.notification,
  "browser-network": browserEventTypes.network,
};
const browserSourceKind = (kind: ChannelLogSourceKind): BrowserEventKind | undefined =>
  kind === "browser-push" ? "push" : kind === "browser-notification" ? "notification" : kind === "browser-network" ? "network" : undefined;
export const channelLogSourceSchema = (kind: ChannelLogSourceKind) =>
  `aiko.observation.${kind}.v1`;
const recipe = channelDigest([
  "aiko.log-source",
  1,
  legacyTypes,
  BROWSER_TRACE_SCHEMA_VERSION,
  BROWSER_TRACE_REDACTION_REVISION,
  {
    browser: ["action", "category", "success", "durationMs<=3600000"],
    knowledge: ["root", "previousRoot", "complete", "changedCount<=1000000"],
    login: [
      "attemptId",
      "revision",
      "kind",
      "expiresAt",
      "challengeId",
      "challengeRevision",
    ],
    common: ["schema", "sequence", "occurrence"],
    loginRevision: "native-login-observation/1",
  },
]);
// Preserve existing three source recipes and artifact pins across this additive change.
const sourceRecipe = (kind: ChannelLogSourceKind) => browserSourceKind(kind)
  ? channelDigest(["aiko.browser-log-source", 1, kind, BROWSER_EVENT_SCHEMA]) : recipe;
const kinds = new Set([
  "Cut",
  "Bound",
  "Progress",
  "Blocked",
  "Gap",
  "Revoked",
  "Wake",
  "Relayed",
  "Exhausted",
  "Renewed",
]);
export function channelLogSourceEventKey(e: Event) {
  return e.provenance === CHANNEL_PROVENANCE &&
    typeof e.owner === "string" &&
    typeof e.id === "string" &&
    e.type.startsWith("AikoChannelLogSource") &&
    kinds.has(e.type.slice(20))
    ? `aiko-channel-log-source:${e.owner}:${e.type}:${e.id}`
    : undefined;
}
const fact = (
  owner: string,
  kind: string,
  id: string,
  value: object,
): Event => ({
  type: `AikoChannelLogSource${kind}`,
  provenance: CHANNEL_PROVENANCE,
  owner,
  id,
  ...value,
});
const own = (rows: readonly Event[], owner: string) =>
  rows.filter((e) => e.owner === owner && channelLogSourceEventKey(e));
const stream = (owner: string, kind: ChannelLogSourceKind) =>
  kind === "knowledge-change" ? `background-${owner}-indexer` : `user-${owner}`;
const count = (x: unknown) =>
  Number.isSafeInteger(x) && Number(x) >= 0 && Number(x) <= 1_000_000;
const root = (x: unknown) =>
  typeof x === "string" && /^(sha256:)?[a-f0-9]{64}$/.test(x);

/** Fixed metadata projection. A verified observation is never a SessionVerified,
 * Checked or delivery fact. Unknown browser action strings cannot carry values. */
export function normalizeChannelLogSource(
  kind: ChannelLogSourceKind,
  e: Event,
  owner: string,
  sequence: number,
  occurrence: string,
): object | undefined {
  if (e.type !== types[kind] || (e.owner !== undefined && e.owner !== owner))
    return;
  const base = { schema: channelLogSourceSchema(kind), sequence, occurrence };
  const browserKind = browserSourceKind(kind);
  if (browserKind) {
    if (!browserEventKey(e) || e.owner !== owner || e.kind !== browserKind || typeof e.connectionId !== "string" || typeof e.connectionRevision !== "string") return;
    try {
      const fields = validateBrowserEventFields(e.fields, browserKind);
      return { ...base, eventId: e.id, connectionId: e.connectionId, connectionRevision: e.connectionRevision,
        kind: browserKind, observedAt: e.observedAt, fields };
    } catch { return; }
  }
  if (kind === "browser-result") {
    if (![true, false, "unknown"].includes(e.success as any)) return;
    const action = browserToolActionOf(e.action);
    return {
      ...base,
      action,
      category: browserToolCategoryOf(action),
      success: e.success,
      ...(typeof e.durationMs === "number" &&
      Number.isFinite(e.durationMs) &&
      e.durationMs >= 0
        ? { durationMs: Math.min(e.durationMs, 3_600_000) }
        : {}),
    };
  }
  if (kind === "private-login") {
    try {
      const v = loginObservationEvent(
        owner,
        e as unknown as NativeLoginObservation,
      );
      return {
        ...base,
        attemptId: v.attemptId,
        revision: v.revision,
        kind: v.kind,
        expiresAt: v.expiresAt,
        ...(v.challengeId
          ? {
              challengeId: v.challengeId,
              challengeRevision: v.challengeRevision,
            }
          : {}),
      };
    } catch {
      return;
    }
  }
  if (
    !root(e.root) ||
    (e.previousRoot !== undefined &&
      e.previousRoot !== null &&
      e.previousRoot !== "" &&
      !root(e.previousRoot)) ||
    typeof e.complete !== "boolean" ||
    !Array.isArray(e.changed)
  )
    return;
  return {
    ...base,
    root: e.root,
    previousRoot: e.previousRoot || null,
    complete: e.complete,
    changedCount: Math.min(e.changed.length, 1_000_000),
  };
}

/** Native host append guard also fences cut conflicts and cursor rollback. Public
 * ingress rejects the entire reserved AikoChannel namespace. */
export function channelLogSourceAppendAllowed(
  batch: readonly Event[],
  read: () => readonly Event[],
) {
  const rows = [...read()];
  for (const e of batch) {
    if (!e.type.startsWith("AikoChannelLogSource")) { rows.push(e); continue; }
    if (!channelLogSourceEventKey(e)) return false;
    const previous = rows.find(
      (p) => channelLogSourceEventKey(p) === channelLogSourceEventKey(e),
    );
    if (previous) {
      if (channelDigest(previous) !== channelDigest(e)) return false;
      continue;
    }
    if (
      [
        "AikoChannelLogSourceBound",
        "AikoChannelLogSourceProgress",
        "AikoChannelLogSourceRevoked",
        "AikoChannelLogSourceGap",
        "AikoChannelLogSourceExhausted",
        "AikoChannelLogSourceRenewed",
      ].includes(e.type) &&
      !rows.some(
        (p) =>
          p.type === "AikoChannelLogSourceCut" &&
          p.owner === e.owner &&
          p.id === e.binding,
      )
    )
      return false;
    if (e.type === "AikoChannelLogSourceRenewed") {
      const lease = channelLogSourceLease(rows, String(e.owner), String(e.binding));
      const request = rows.find(p => p.owner === e.owner && p.type === "AikoBrowserWatchLeaseRenewalRequested" && p.id === e.watchRenewalId);
      if (!lease.request || !browserSourceKind(lease.request.source) || lease.stop?.type === "AikoChannelLogSourceGap" || lease.stop?.type === "AikoChannelLogSourceRevoked" ||
        e.id !== `${e.binding}:lease:${e.leaseRevision}` || e.leaseRevision !== lease.revision + 1 ||
        !request || lease.request.sourceAuthority !== `watch-source:${request.watchId}` || request.leaseRevision !== e.leaseRevision ||
        request.expiresAt !== e.expiresAt || request.maxOccurrences !== e.maxOccurrences ||
        !rows.some(p => p.owner === e.owner && p.type === "AikoBrowserWatchLeaseRenewalChecked" && p.requestId === request.id && p.status === "confirmed") ||
        !Number.isSafeInteger(e.expiresAt) || !Number.isSafeInteger(request.at) || Number(e.expiresAt) <= Number(request.at) ||
        Number(e.expiresAt) > Number(request.at) + 86400000 || Number(e.expiresAt) < lease.request.expiresAt ||
        !Number.isSafeInteger(e.maxOccurrences) || Number(e.maxOccurrences) < (lease.request.maxOccurrences ?? 128) || Number(e.maxOccurrences) < lease.used || Number(e.maxOccurrences) > 1_000_000 ||
        e.expiresAt === lease.request.expiresAt && e.maxOccurrences === lease.request.maxOccurrences) return false;
    }
    if (e.type === "AikoChannelLogSourceProgress") {
      const cut = rows.find(
        (p) =>
          p.type === "AikoChannelLogSourceCut" &&
          p.owner === e.owner &&
          p.id === e.binding,
      );
      const head =
        rows
          .filter(
            (p) =>
              p.type === "AikoChannelLogSourceProgress" &&
              p.owner === e.owner &&
              p.binding === e.binding,
          )
          .at(-1) ?? cut;
      if (!head || !count(e.cursor) || Number(e.cursor) <= Number(head.cursor))
        return false;
      if (
        e.disposition === "accepted" &&
        ![...rows, ...batch].some(
          (p) =>
            p.type === "AikoChannelWiringAccepted" &&
            p.owner === e.owner &&
            p.id === e.accepted,
        )
      )
        return false;
    }
    rows.push(e);
  }
  return true;
}

type Request = {
  operationId: string;
  source: ChannelLogSourceKind;
  sourceAuthority: string;
  receivingAuthority: string;
  port: { channel: string; generation: number };
  expiresAt: number;
  filter?: BrowserLogSourceFilter;
  maxOccurrences?: number;
};
/** Retain the original immutable request, cut and history anchor. Only lifetime
 * bounds are overlaid by independently keyed native renewal facts. */
export function channelLogSourceLease(rows: readonly Event[], owner: string, id: string) {
  const facts = own(rows, owner), cut = facts.find(e => e.type === "AikoChannelLogSourceCut" && e.id === id);
  const renewal = facts.findLast(e => e.type === "AikoChannelLogSourceRenewed" && e.binding === id);
  const revision = Number(renewal?.leaseRevision ?? 0);
  const original = cut?.request as Request | undefined;
  const request = original && { ...original, ...(renewal ? { expiresAt: Number(renewal.expiresAt), maxOccurrences: Number(renewal.maxOccurrences) } : {}) };
  const stop = facts.findLast(e => e.binding === id && (["AikoChannelLogSourceRevoked", "AikoChannelLogSourceGap"].includes(e.type) ||
    e.type === "AikoChannelLogSourceExhausted" && Number(e.leaseRevision ?? 0) >= revision));
  const progress = facts.findLast(e => e.type === "AikoChannelLogSourceProgress" && e.binding === id) ?? cut;
  return { cut, progress, request, revision, stop, used: Math.max(0, Number(progress?.cursor ?? 0) - Number(cut?.cursor ?? 0)) };
}
export function createChannelLogSources(
  owner: string,
  journal: WiringJournal,
  wiring: ReturnType<typeof createChannelWiring>,
  binding: ChannelLogSourceBindings,
  readThread: (thread: string) => Promise<readonly Event[]>,
) {
  const scoped = Effect.gen(function* () {
    const self = yield* Self;
    if (
      self.actor !== "aiko" ||
      self.thread !== `user-${owner}` ||
      !binding.current()
    )
      throw Error("log_source_owner_denied");
  });
  const allowed = (a: Request, allowInactiveRenewal = false) =>
    binding.current() &&
    binding
      .grants()
      .some(
        (g) =>
          g.owner === owner &&
          (g.active || allowInactiveRenewal && !!browserSourceKind(a.source)) &&
          g.id === a.sourceAuthority &&
          g.kind === a.source &&
          g.receivingAuthority === a.receivingAuthority &&
          (allowInactiveRenewal ? g.browserLease?.expiresAt ?? g.expiresAt : g.expiresAt) >= a.expiresAt &&
          (allowInactiveRenewal || a.expiresAt > Date.now()) &&
          (g.browserOperationId === undefined || !!browserSourceKind(a.source) &&
            /^[a-zA-Z0-9_.:-]{1,128}$/.test(g.browserOperationId) && g.browserOperationId === a.operationId) &&
          Number.isInteger(g.maxBindings) &&
          g.maxBindings > 0 &&
          g.maxBindings <= 32 && (!g.browserSequenceCut || !!browserSourceKind(a.source) &&
            typeof g.browserSequenceCut.producer === "string" && !!g.browserSequenceCut.producer && typeof g.browserSequenceCut.epoch === "string" && !!g.browserSequenceCut.epoch &&
            Number.isSafeInteger(g.browserSequenceCut.generation) && g.browserSequenceCut.generation > 0 && Number.isSafeInteger(g.browserSequenceCut.through) && g.browserSequenceCut.through >= 0),
      );
  const browserCutReason = (a: Request, event: Event, current?: readonly Event[]) => {
    const cut = binding.grants().find(g => g.owner === owner && g.id === a.sourceAuthority && g.kind === a.source && g.receivingAuthority === a.receivingAuthority)?.browserSequenceCut;
    if (!cut || !browserSourceKind(a.source)) return undefined;
    if (event.producer !== cut.producer || event.epoch !== cut.epoch || event.generation !== cut.generation) return "watch_producer_scope";
    // A retained control can only narrow this explicitly bound grant. Read its
    // native cut at commit too, so asynchronous grant refresh cannot admit an
    // old occurrence between a pause/resume transaction and projection refresh.
    const controls = current?.filter(e => e.owner === owner && e.type === "AikoBrowserWatchControlled" &&
      (e.sequenceCut as any)?.producer === cut.producer && (e.sequenceCut as any)?.epoch === cut.epoch && (e.sequenceCut as any)?.generation === cut.generation) ?? [];
    if (controls.at(-1) && controls.at(-1)!.status !== "active") return "watch_paused";
    const through = Math.max(cut.through, ...controls.map(e => Number((e.sequenceCut as any).through)));
    return Number(event.sequence) <= through ? "watch_pause_cut" : undefined;
  };
  const ackPins = new Set(
    channelLogSourceHarnessDefinitions().map((d) => harnessDigest(d.artifact)),
  );
  const recheck = (a: Request, value?: object) => async () => {
    await wiring.authorizeAdmission(a.receivingAuthority, "emit", {
      port: a.port,
      schema: channelLogSourceSchema(a.source),
      ...(value ? { value } : {}),
    });
    if (!allowed(a)) throw Error("log_source_grant_denied");
  };
  const snapshot = async (request: Request) => {
    const kind = request.source;
    const rows = await readThread(stream(owner, kind));
    return rows
      .filter((e) => e.type === types[kind] && (!request.filter || matchesBrowserLogSource(e, request.filter)))
      .map((e) =>
        kind !== "knowledge-change"
          ? e
          : {
              ...e,
              sourceFeedback: rows.some(
                (derived) =>
                  derived.type === "AikoHarnessSkillDerived" &&
                  derived.owner === owner &&
                  derived.id === e.cause &&
                  ackPins.has(derived.harnessDigest as any),
              ),
            },
      );
  };
  // Digest of private history is itself private; only owner-keyed custody refs enter logs.
  const anchor = (rows: readonly Event[]) =>
    channelSeal(journal.blobs, owner, harnessDigest(rows));
  const state = (rows: readonly Event[], id: string) => {
    const lease = channelLogSourceLease(rows, owner, id);
    return { ...lease, stopped: !!lease.stop };
  };
  const renew = (raw: { id: string; leaseRevision: number; expiresAt: number; maxOccurrences: number; watchRenewalId: string }, confirmation?: Event) => Effect.gen(function* () {
    yield* scoped;
    const args = structuredClone(raw), rows = yield* Effect.promise(journal.read), s = state(rows, args.id);
    const checked = confirmation && structuredClone(confirmation);
    if (checked && (checked.owner !== owner || checked.type !== "AikoBrowserWatchLeaseRenewalChecked" || checked.requestId !== args.watchRenewalId || checked.status !== "confirmed")) throw Error("log_source_renewal_confirmation_invalid");
    if (s.stop && s.stop.type !== "AikoChannelLogSourceExhausted") throw Error("log_source_renewal_invalid");
    const eventId = `${args.id}:lease:${args.leaseRevision}`;
    const prior = own(rows, owner).find(e => e.type === "AikoChannelLogSourceRenewed" && e.id === eventId);
    if (prior) {
      if (prior.expiresAt !== args.expiresAt || prior.maxOccurrences !== args.maxOccurrences || prior.watchRenewalId !== args.watchRenewalId) throw Error("log_source_renewal_conflict");
      return { status: "active", id: args.id, leaseRevision: args.leaseRevision, used: s.used };
    }
    if (!s.request || !browserSourceKind(s.request.source) || s.stop && s.stop.type !== "AikoChannelLogSourceExhausted" ||
      args.leaseRevision !== s.revision + 1 || !Number.isSafeInteger(args.expiresAt) ||
      args.expiresAt < s.request.expiresAt || !Number.isSafeInteger(args.maxOccurrences) || args.maxOccurrences < (s.request.maxOccurrences ?? 128) ||
      args.maxOccurrences < s.used || args.maxOccurrences > 1_000_000 || args.expiresAt === s.request.expiresAt && args.maxOccurrences === s.request.maxOccurrences) throw Error("log_source_renewal_invalid");
    const request = { ...s.request, expiresAt: args.expiresAt, maxOccurrences: args.maxOccurrences };
    // A valid time-only request can reach confirmation after the old budget is
    // consumed. Retain its exact ceiling; scanning still enforces used >= limit.
    const permitted = () => allowed(request, true) && binding.grants().some(g => g.owner === owner && g.id === request.sourceAuthority &&
      g.browserLease?.revision === args.leaseRevision && g.browserLease.expiresAt === args.expiresAt && g.browserLease.maxOccurrences === args.maxOccurrences && g.browserLease.requestId === args.watchRenewalId);
    if (!permitted()) throw Error("log_source_renewal_denied");
    return yield* Effect.promise(() => journal.transact(current => {
      if (!permitted()) throw Error("log_source_renewal_denied");
      const next = fact(owner, "Renewed", eventId, { binding: args.id, leaseRevision: args.leaseRevision,
        expiresAt: args.expiresAt, maxOccurrences: args.maxOccurrences, watchRenewalId: args.watchRenewalId });
      const retained = own(current, owner).find(e => e.type === next.type && e.id === eventId);
      if (retained && channelDigest(retained) !== channelDigest(next)) throw Error("log_source_renewal_conflict");
      const batch = retained ? [] : [...(checked ? [checked] : []), next];
      if (!channelLogSourceAppendAllowed(batch, () => current)) throw Error("log_source_renewal_denied");
      return { events: batch, result: { status: "active", id: args.id, leaseRevision: args.leaseRevision, used: state(current, args.id).used } };
    }, async () => {
      await wiring.authorizeAdmission(request.receivingAuthority, "emit", { port: request.port, schema: channelLogSourceSchema(request.source) });
      if (!permitted()) throw Error("log_source_renewal_denied");
    }));
  });
  const register = (raw: unknown) =>
    Effect.gen(function* () {
      yield* scoped;
      const a = structuredClone(raw) as Request;
      if (
        !a ||
        Object.keys(a).some(
          (k) =>
            ![
              "operationId",
              "source",
              "sourceAuthority",
              "receivingAuthority",
              "port",
              "expiresAt",
              "filter",
              "maxOccurrences",
            ].includes(k),
        ) ||
        !Object.hasOwn(types, a.source) ||
        typeof a.operationId !== "string" ||
        !/^[a-zA-Z0-9_.:-]{1,128}$/.test(a.operationId) ||
        !a.port ||
        typeof a.port.channel !== "string" ||
        !Number.isSafeInteger(a.port.generation) ||
        !Number.isSafeInteger(a.expiresAt) ||
        a.expiresAt > Date.now() + 86_400_000 ||
        !allowed(a)
      )
        throw Error("log_source_grant_denied");
      if ((a.filter || a.maxOccurrences !== undefined) && !browserSourceKind(a.source)) throw Error("browser_source_options_required");
      if (a.maxOccurrences !== undefined && (!Number.isSafeInteger(a.maxOccurrences) || a.maxOccurrences < 1 || a.maxOccurrences > 1_000_000)) throw Error("browser_source_budget_invalid");
      if (a.filter && (Object.keys(a.filter).some(key => !["connectionId", "connectionRevision", "generation", "origin", "outcome", "method", "route", "excludeCausePrefix"].includes(key)) ||
        !a.filter.connectionId || !a.filter.connectionRevision || !Number.isSafeInteger(a.filter.generation) || a.filter.generation < 1 ||
        typeof a.filter.origin !== "string" || typeof a.filter.outcome !== "string" ||
        a.filter.excludeCausePrefix !== undefined && (typeof a.filter.excludeCausePrefix !== "string" || !a.filter.excludeCausePrefix.length))) throw Error("browser_source_filter_invalid");
      yield* Effect.promise(() =>
        wiring.authorizeAdmission(a.receivingAuthority, "emit", {
          port: a.port,
          schema: channelLogSourceSchema(a.source),
        }),
      );
      const port = (yield* Effect.promise(wiring.view)).ports.get(
        `${a.port.channel}:${a.port.generation}`,
      );
      if (
        !port ||
        port.schema !== channelLogSourceSchema(a.source) ||
        !port.directions.includes("inbox")
      )
        throw Error("log_source_port_scope");
      const id = channelDigest([owner, a.operationId]),
        requestDigest = channelDigest(a);
      let cut = state(yield* Effect.promise(journal.read), id).cut;
      if (!cut) {
        const source = yield* Effect.promise(() => snapshot(a));
        const anchorRef = yield* Effect.promise(() => anchor(source));
        cut = yield* Effect.promise(() =>
          journal.transact((rows) => {
            if (!allowed(a)) throw Error("log_source_grant_denied");
            const prior = state(rows, id).cut;
            if (prior) return { events: [], result: prior };
            const grant = binding
              .grants()
              .find((g) => g.id === a.sourceAuthority && g.owner === owner)!;
            if (
              own(rows, owner).filter(
                (e) =>
                  e.type === "AikoChannelLogSourceCut" &&
                  (e.request as Request).sourceAuthority ===
                    a.sourceAuthority &&
                  !state(rows, String(e.id)).stopped &&
                  (e.request as Request).expiresAt > Date.now(),
              ).length >= grant.maxBindings
            )
              throw Error("log_source_quota");
            const e = fact(owner, "Cut", id, {
              request: a,
              requestDigest,
              recipe: sourceRecipe(a.source),
              stream: stream(owner, a.source),
              cursor: source.length,
              anchorRef,
            });
            return { events: [e], result: e };
          }, recheck(a)),
        );
      }
      if (cut.requestDigest !== requestDigest || cut.recipe !== sourceRecipe(a.source))
        throw Error("log_source_operation_conflict");
      return yield* Effect.promise(() =>
        journal.transact((rows) => {
          if (!allowed(a) || state(rows, id).stopped)
            throw Error("log_source_grant_denied");
          const old = own(rows, owner).find(
            (e) => e.type === "AikoChannelLogSourceBound" && e.id === id,
          );
          return {
            events: old ? [] : [fact(owner, "Bound", id, { binding: id })],
            result: {
              id,
              status: "active",
              schema: channelLogSourceSchema(a.source),
              cut: cut!.cursor,
              expiresAt: a.expiresAt,
            },
          };
        }, recheck(a)),
      );
    });
  const revoke = (raw: unknown) =>
    Effect.gen(function* () {
      yield* scoped;
      const id = (raw as any)?.id;
      return yield* Effect.promise(() =>
        journal.transact((rows) => {
          if (!state(rows, id).cut) throw Error("log_source_binding_missing");
          const old = own(rows, owner).find(
            (e) => e.type === "AikoChannelLogSourceRevoked" && e.binding === id,
          );
          return {
            events: old ? [] : [fact(owner, "Revoked", id, { binding: id })],
            result: { status: "revoked" },
          };
        }),
      );
    });
  const native = component({
    name: "aiko.channel-log-sources",
    keys: {
      prefixes: ["aiko-channel-log-source:"],
      keyOf: channelLogSourceEventKey,
    },
    initial: () => [] as Event[],
    step: (rows: Event[], e: Event) => [...rows, e],
    output: (rows) => {
      const wake = rows.filter(
        (e) =>
          Object.values(types).includes(e.type) ||
          ["AikoChannelWiringCursor", "AikoChannelWiringConsumed", "AikoChannelLogSourceWake"].includes(
            e.type,
          ),
      ).length;
      const activations = own(rows, owner)
        .filter(
          (e) =>
            e.type === "AikoChannelLogSourceCut" &&
            !state(rows, String(e.id)).stopped &&
            !rows.some(
              (b) =>
                b.type === "AikoChannelLogSourceBound" &&
                b.owner === owner &&
                b.id === e.id,
            ),
        )
        .map((cut) =>
          effect({
            key: `aiko-channel-log-source:activate:${cut.id}`,
            input: { id: cut.id },
            act: () =>
              Effect.gen(function* () {
                yield* scoped;
                const a = cut.request as Request;
                if (cut.recipe !== sourceRecipe(a.source)) {
                  yield* Effect.promise(() =>
                    journal.transact(() => ({
                      events: [
                        fact(owner, "Gap", String(cut.id), {
                          binding: cut.id,
                          cursor: cut.cursor,
                          reason: "normalizer_pin_unavailable",
                        }),
                      ],
                      result: undefined,
                    })),
                  );
                  return [];
                }
                if (!allowed(a)) return [];
                yield* Effect.promise(() =>
                  wiring.authorizeAdmission(a.receivingAuthority, "emit", {
                    port: a.port,
                    schema: channelLogSourceSchema(a.source),
                  }),
                );
                yield* Effect.promise(() =>
                  journal.transact(
                    (current) => ({
                      events:
                        !allowed(a) ||
                        state(current, String(cut.id)).stopped ||
                        current.some(
                          (e) =>
                            e.type === "AikoChannelLogSourceBound" &&
                            e.owner === owner &&
                            e.id === cut.id,
                        )
                          ? []
                          : [
                              fact(owner, "Bound", String(cut.id), {
                                binding: cut.id,
                              }),
                            ],
                      result: undefined,
                    }),
                    recheck(a),
                  ),
                );
                return [];
              }),
          }),
        );
      const transitions = own(rows, owner)
        .filter((e) => e.type === "AikoChannelLogSourceBound")
        .flatMap((bound) => {
          const id = String(bound.id),
            s = state(rows, id),
            a = s.request as Request;
          if (!a || !s.progress || s.stopped) return [];
          const token = channelDigest(s.revision ? [id, s.progress.cursor, wake, s.revision] : [id, s.progress.cursor, wake]);
          return [
            effect({
              key: `aiko-channel-log-source:scan:${token}`,
              input: { id, token },
              act: () =>
                Effect.gen(function* () {
                  yield* scoped;
                  if (!allowed(a)) return [];
                  const currentLog = yield* Effect.promise(journal.read);
                  let current = state(currentLog, id);
                  if (current.stopped) return [];
                  if (current.cut!.recipe !== sourceRecipe(a.source)) {
                    yield* Effect.promise(() =>
                      journal.transact(() => ({
                        events: [
                          fact(owner, "Gap", id, {
                            binding: id,
                            cursor: current.progress!.cursor,
                            reason: "normalizer_pin_unavailable",
                          }),
                        ],
                        result: undefined,
                      })),
                    );
                    return [];
                  }
                  const source = yield* Effect.promise(() =>
                    snapshot(a),
                  );
                  const start = Number(current.progress!.cursor);
                  // Lifetime work is bounded too, including custom knowledge handlers that
                  // cause further learning. Explicit new composition is required after exhaustion.
                  const lifetimeBudget = a.maxOccurrences ?? 128;
                  if (start - Number(current.cut!.cursor) >= lifetimeBudget) {
                    yield* Effect.promise(() =>
                      journal.transact(() => ({
                        events: [
                          fact(owner, "Exhausted", s.revision ? `${id}:lease:${s.revision}` : id, {
                            binding: id,
                            ...(s.revision ? { leaseRevision: s.revision } : {}),
                            cursor: start,
                            reason: "source_occurrence_budget",
                          }),
                        ],
                        result: undefined,
                      })),
                    );
                    return [];
                  }
                  const expected = yield* Effect.promise(() =>
                    channelHydrate(
                      journal.blobs,
                      owner,
                      current.progress!.anchorRef,
                    ).catch(() => undefined),
                  );
                  if (
                    source.length < start ||
                    harnessDigest(source.slice(0, start)) !== expected
                  ) {
                    yield* Effect.promise(() =>
                      journal.transact(() => ({
                        events: [
                          fact(owner, "Gap", id, {
                            binding: id,
                            cursor: start,
                            reason: "source_history_unavailable",
                          }),
                        ],
                        result: undefined,
                      })),
                    );
                    return [];
                  }
                  for (
                    let i = start;
                    i <
                    Math.min(
                      source.length,
                      start + 32,
                      Number(current.cut!.cursor) + lifetimeBudget,
                    );
                    i++
                  ) {
                    const occurrence = channelDigest([owner, id, i + 1]),
                      sourceCut = browserCutReason(a, source[i]!, currentLog),
                      value =
                        source[i]!.sourceFeedback === true || sourceCut !== undefined
                          ? undefined
                          : normalizeChannelLogSource(
                              a.source,
                              source[i]!,
                              owner,
                              i + 1,
                              occurrence,
                            );
                    const anchorRef = yield* Effect.promise(() =>
                      anchor(source.slice(0, i + 1)),
                    );
                    let admit:
                      | Effect.Success<
                          ReturnType<typeof wiring.prepareAdmission>
                        >
                      | undefined;
                    if (value)
                      admit = yield* wiring.prepareAdmission({
                        port: a.port,
                        schema: channelLogSourceSchema(a.source),
                        value,
                        occurrence,
                        correlation: occurrence,
                        authorityRef: a.receivingAuthority,
                      });
                    const blocked = yield* Effect.promise(() =>
                      journal.transact(
                        (events) => {
                          current = state(events, id);
                          if (!allowed(a) || current.stopped)
                            return { events: [], result: true };
                          if (browserCutReason(a, source[i]!, events) !== sourceCut)
                            return { events: [], result: true };
                          if (Number(current.progress!.cursor) !== i)
                            return { events: [], result: true };
                          try {
                            const accepted = admit?.(events);
                            return {
                              events: [
                                ...(accepted?.events ?? []),
                                fact(owner, "Progress", occurrence, {
                                  binding: id,
                                  cursor: i + 1,
                                  anchorRef,
                                  disposition: value ? "accepted" : "rejected",
                                  ...(accepted
                                    ? { accepted: accepted.result.id }
                                    : {
                                        reason:
                                          source[i]!.sourceFeedback === true
                                            ? "source_ack_feedback"
                                            : sourceCut ?? "invalid_source_metadata",
                                      }),
                                }),
                              ],
                              result: false,
                            };
                          } catch (error) {
                            if (
                              !(error instanceof Error) ||
                              error.message !== "channel_backlog"
                            )
                              throw error;
                            return {
                              events: [
                                fact(owner, "Blocked", token, {
                                  binding: id,
                                  cursor: i,
                                  reason: "backpressure",
                                }),
                              ],
                              result: true,
                            };
                          }
                        },
                        recheck(a, value),
                      ),
                    );
                    if (blocked) break;
                  }
                  return [];
                }),
            }),
          ];
        });
      return { view: undefined, transitions: [...activations, ...transitions] };
    },
  });
  const tools: NativeTool<Self>[] = [
    {
      spec: {
        name: "channel_source_status",
        description:
          "Inspect owned binding metadata and retained cursor/stop disposition by id. Never reads a caller-selected source stream.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      run: (raw) =>
        Effect.gen(function* () {
          yield* scoped;
          const id = (raw as any).id,
            rows = yield* Effect.promise(journal.read),
            s = state(rows, id);
          if (!s.cut) throw Error("log_source_binding_missing");
          const stop = s.stop;
          return {
            id,
            cursor: s.progress!.cursor,
            start: s.cut.cursor,
            leaseRevision: s.revision, expiresAt: s.request!.expiresAt, maxOccurrences: s.request!.maxOccurrences ?? 128,
            used: s.used, remaining: Math.max(0, (s.request!.maxOccurrences ?? 128) - s.used),
            status:
              stop?.reason ??
              (stop
                ? "revoked"
                : allowed(s.request!)
                  ? "active"
                  : "authority_unavailable"),
          };
        }),
    },
    {
      spec: {
        name: "channel_source_catalog",
        description:
          "Discover explicitly granted native log sources. Actor-native only; channel.manage confers no source access. Fixed metadata schemas, future-only cut, maximum 32 occurrences per native batch and 128 per binding lifetime.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      run: () =>
        Effect.gen(function* () {
          yield* scoped;
          return binding
            .grants()
            .filter(
              (g) => g.owner === owner && g.active && g.expiresAt > Date.now(),
            )
            .map((g) => ({
              ...g,
              schema: channelLogSourceSchema(g.kind),
              recipe: sourceRecipe(g.kind),
              maxOccurrences: 128,
              batchSize: 32,
              handler: (() => {
                const d = channelLogSourceHarnessDefinitions().find(
                  (d) => d.artifact.name === `channel.source.${g.kind}.ack`,
                )!;
                return {
                  name: d.artifact.name,
                  harness: harnessDigest(d.artifact),
                  contract: harnessDigest(d.contract),
                };
              })(),
            }));
        }),
    },
    {
      spec: {
        name: "channel_source_bind",
        description:
          "Bind future trusted source facts to a typed inbox: operationId, source, sourceAuthority, receivingAuthority, port {channel,generation}, expiresAt. Retains cut before activation; both grants required. No arbitrary log queries or historical backfill.",
        inputSchema: { type: "object" },
      },
      run: register,
    },
    {
      spec: {
        name: "channel_source_revoke",
        description:
          "Stop admission for an owned log-source binding by id; admitted handlers retain their own lifecycle.",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
      run: revoke,
    },
  ];
  return { component: native, tools, api: { register, revoke, renew } };
}

/** Retained indexer-to-owner native handoff. Wake contains no observation payload
 * or grant; the receiver always reads the exact owner indexer stream itself. */
export function channelLogSourceRelay(owner: string) {
  return component({
    name: "aiko.channel-log-source-relay",
    keys: {
      prefixes: ["aiko-channel-log-source:"],
      keyOf: channelLogSourceEventKey,
    },
    initial: () => [] as Event[],
    step: (rows: Event[], e: Event) => [...rows, e],
    output: (rows) => {
      const n = rows.filter((e) => e.type === "AikoKnowledgeChanged").length;
      const id = channelDigest([owner, "knowledge-change", n]);
      return {
        view: undefined,
        transitions:
          !n ||
          rows.some(
            (e) => e.type === "AikoChannelLogSourceRelayed" && e.id === id,
          )
            ? []
            : [
                effect({
                  key: `aiko-channel-log-source:relay:${id}`,
                  input: { id },
                  act: () =>
                    Effect.gen(function* () {
                      const self = yield* Self;
                      if (
                        self.actor !== "aiko" ||
                        self.thread !== stream(owner, "knowledge-change")
                      )
                        throw Error("log_source_relay_scope");
                      yield* routeBackground(
                        owner,
                        "foreground",
                        fact(owner, "Wake", id, { source: "knowledge-change" }),
                      );
                      return [fact(owner, "Relayed", id, {})];
                    }),
                }),
              ],
      };
    },
  });
}

/** Useful default known handler: acknowledge the observation's kind and sequence.
 * It does not claim session verification, summarize private content or deliver it. */
export function channelLogSourceHarnessDefinitions(): readonly import("./harness-builtins.ts").BuiltinHarnessDefinition[] {
  return (Object.keys(types) as ChannelLogSourceKind[]).map((kind) => {
    const schema = channelLogSourceSchema(kind);
    const common = {
      schema: { const: schema },
      sequence: { type: "integer", minimum: 1 },
      occurrence: { type: "string", pattern: "^[a-f0-9]{64}$" },
    };
    const fields =
      browserSourceKind(kind)
        ? { eventId: {type:"string",maxLength:512}, connectionId:{type:"string",maxLength:160}, connectionRevision:{type:"string",maxLength:160}, kind:{const:browserSourceKind(kind)}, observedAt:{type:"integer",minimum:1}, fields:{type:"object",properties:{origin:{type:"string"},outcome:{enum:["received","displayed","completed","failed"]},method:{type:"string"},route:{type:"string"},status:{type:"integer"}},required:["origin","outcome"],additionalProperties:false} }
        : kind === "browser-result"
        ? {
            action: { type: "string", maxLength: 64 },
            category: {
              enum: [
                "navigation",
                "observation",
                "interaction",
                "network",
                "session",
                "script",
                "other",
              ],
            },
            success: { enum: [true, false, "unknown"] },
            durationMs: { type: "number", minimum: 0, maximum: 3_600_000 },
          }
        : kind === "knowledge-change"
          ? {
              root: { type: "string", maxLength: 71 },
              previousRoot: { type: ["string", "null"], maxLength: 71 },
              complete: { type: "boolean" },
              changedCount: { type: "integer", minimum: 0, maximum: 1_000_000 },
            }
          : {
              attemptId: { type: "string", maxLength: 36 },
              revision: { type: "integer", minimum: 1 },
              kind: {
                enum: [
                  "opening",
                  "challenge",
                  "submission_dispatched",
                  "submission_acknowledged",
                  "verified",
                  "disconnected",
                ],
              },
              expiresAt: { type: "integer" },
              challengeId: { type: "string", maxLength: 36 },
              challengeRevision: { type: "integer", minimum: 1 },
            };
    const valueSchema = {
      type: "object",
      properties: { ...common, ...fields },
      required: [
        ...Object.keys(common),
        ...Object.keys(fields).filter(
          (k) =>
            !["durationMs", "challengeId", "challengeRevision"].includes(k),
        ),
      ],
      additionalProperties: false,
    };
    const cases: import("./harness-library.ts").HarnessCase[] = [1, 2, 37].map(
      (sequence, i) => ({
        id: `sequence-${sequence}`,
        split: i === 2 ? "held-out" : "development",
        input: {
          schema,
          correlation: `case-${i}`,
          value: {
            schema,
            sequence,
            occurrence: "a".repeat(64),
            ...(browserSourceKind(kind)
              ? {eventId:`event-${sequence}`,connectionId:"fixture-connection",connectionRevision:"1",kind:browserSourceKind(kind)!,observedAt:1,fields:{origin:"https://example.com",outcome:kind==="browser-push"?"received":kind==="browser-notification"?"displayed":"completed"}}
              : kind === "browser-result"
              ? {
                  action: "read",
                  category: "navigation",
                  success: i === 1 ? "unknown" : true,
                }
              : kind === "knowledge-change"
                ? {
                    root: "b".repeat(64),
                    previousRoot: null,
                    complete: true,
                    changedCount: sequence,
                  }
                : {
                    attemptId: "00000000-0000-0000-0000-000000000001",
                    revision: 1,
                    kind: i === 1 ? "verified" : "challenge",
                    expiresAt: 1,
                  }),
          },
        },
      }),
    );
    const verifierDigest = harnessDigest([
        "aiko-log-source-ack-verifier/v1",
        kind,
      ]),
      evaluatorDigest = harnessDigest(cases);
    const contract: import("./harness-library.ts").HarnessContract = {
      version: 1,
      outcome: `Acknowledge ${kind} observation sequence only; no session, handler or delivery attestation.`,
      inputSchema: {
        type: "object",
        properties: {
          value: valueSchema,
          schema: { const: schema },
          correlation: { type: "string" },
        },
        required: ["value", "schema", "correlation"],
        additionalProperties: false,
      } as any,
      outputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      effect: "read",
      verifierDigest,
      evaluatorDigest,
      timeoutMs: 5000,
      applicability: {
        hook: {
          accepts: schema,
          emits: "text.message.v1",
          inputSchema: valueSchema,
          effects: ["pure", "channel.reply"],
        },
      } as any,
    };
    const contractDigest = harnessDigest(contract),
      code = `return {text:${JSON.stringify(kind + ":")}+input.value.sequence};`;
    return {
      contract,
      artifact: {
        version: 1,
        name: `channel.source.${kind}.ack`,
        description: contract.outcome,
        runtime: "javascript",
        entrypoint: "main.js",
        files: { "main.js": code },
        dependencies: [],
        contractDigest,
        sources: [
          {
            uri: `unlock:log-source/${kind}`,
            revision: sourceRecipe(kind),
            digest: harnessDigest(code),
            license: "NOASSERTION",
          },
        ],
      },
      verifier: {
        digest: verifierDigest,
        evaluatorDigest,
        cases,
        async verify({ contract: supplied, input, output }, signal) {
          signal.throwIfAborted();
          const v = input as any,
            result = output as any;
          const passed =
            harnessDigest(supplied) === contractDigest &&
            v?.schema === schema &&
            Number.isSafeInteger(v?.value?.sequence) &&
            v.value.sequence > 0 &&
            result &&
            Object.keys(result).length === 1 &&
            result.text === `${kind}:${v.value.sequence}`;
          return {
            passed: !!passed,
            quality: passed ? 1 : 0,
            evidence: [
              `fixed-log-source-ack:${kind}:${passed ? "satisfied" : "violated"}`,
            ],
          };
        },
      },
    };
  });
}
