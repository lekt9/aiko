import { randomUUID } from "node:crypto";
import type { Event } from "tardie/core/event";
import { browserWatchRestorePrefixDigest } from "./browser-watch-restore.ts";
import { browserEventKey, browserDeliveryEpoch } from "./browser-events.ts";
import { harnessDigest } from "./harness-library.ts";
import type { WiringJournal } from "./channel-wiring.ts";
import type { BrowserWatchConfig, BrowserWatchLease } from "./browser-watches.ts";

export interface BrowserWatchRestoreScope {
  config: BrowserWatchConfig; lease: BrowserWatchLease; generation: number; lifecycleRevision: number; active: boolean;
}
export interface BrowserWatchRestoreInput {
  id: string; expectedGeneration: number; expectedLifecycleRevision: number; expectedLeaseRevision: number; challenge: string;
}
export interface BrowserWatchRestorePermit {
  owner: string; requestId: string; watchId: string; generation: number; producer: string; epoch: string; sourceGeneration: number;
  connectionId: string; connectionRevision: string; lifecycleRevision: number; leaseRevision: number;
  previousDeliveryEpoch: string | null; deliveryEpoch: string; challenge: string; hostThrough: number; prefixDigest: string;
  queueHead: number; queueAcknowledged: number; queueOffered: number; expiresAt: number; profile: string; restoreAt: number;
}
export interface BrowserWatchRestorePorts {
  restoreProof?(producer: string, challenge: string, hostThrough: number, signal: AbortSignal): Promise<unknown>;
  reauthorizeLease?(permit: BrowserWatchRestorePermit, signal: AbortSignal): Promise<unknown>;
}
const types = ["AikoBrowserWatchRestoreRequested", "AikoBrowserWatchRestorePermitted", "AikoBrowserWatchRestoreChecked"];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (v: unknown) => Number.isSafeInteger(v) && Number(v) >= 0;
const own = (rows: readonly Event[], owner: string) => rows.filter(e => e.owner === owner);
const requestOf = (rows: readonly Event[], id: string) => rows.find(e => e.type === types[0] && e.id === id);
const permitOf = (rows: readonly Event[], id: string) => rows.find(e => e.type === types[1] && e.id === id);
const checksOf = (rows: readonly Event[], id: string) => rows.filter(e => e.type === types[2] && e.requestId === id);
export const browserWatchRestoreAdmissionRequired = (events: readonly Event[]) => events.some(e => types.includes(e.type));
export const browserWatchRestoreEpoch = (rows: readonly Event[], owner: string, producer: string, epoch: string, generation: number) =>
  browserDeliveryEpoch(rows, {owner, producer, epoch, generation});
export const browserWatchRestoreHeld = (rows: readonly Event[], owner: string, watchId: string) => {
  const request = rows.findLast(e => e.type === types[0] && e.owner === owner && e.watchId === watchId);
  return !!request && !rows.some(e => e.type === types[1] && e.owner === owner && e.id === request.id);
};
/** Source identity and occurrence prefix, independent of transport delivery epoch. */
export function browserWatchRestorePrefix(rows: readonly Event[], scope: { owner: string; producer: string; epoch: string; sourceGeneration: number }) {
  const values = rows.filter(e => browserEventKey(e) && e.owner === scope.owner && e.producer === scope.producer && e.epoch === scope.epoch && e.generation === scope.sourceGeneration)
    .sort((a, b) => Number(a.sequence) - Number(b.sequence));
  if (values.some((e, i) => e.sequence !== i + 1 || typeof e.occurrence !== "string")) throw Error("watch_restore_native_prefix_unavailable");
  return { hostThrough: values.length, prefixDigest: browserWatchRestorePrefixDigest({ ...scope, generation: scope.sourceGeneration }, values.map(e => [Number(e.sequence), String(e.occurrence)] as const)) };
}
export function browserWatchRestoreState(rows: readonly Event[], request: Event | undefined, now = Date.now()) {
  if (!request) return undefined;
  const checks = checksOf(rows, String(request.id)), last = checks.at(-1);
  return { requestId: String(request.id), challenge: String(request.challenge), status: last?.status === "confirmed" ? "confirmed" :
    checks.length < 4 && now < Number(request.deadlineAt) ? "pending" : "needs-attention", attempts: checks.length,
    deadlineAt: Number(request.deadlineAt), ...(last?.nextAt === undefined ? {} : { nextAt: Number(last.nextAt) }) };
}
const scopeKeys = ["watchId", "generation", "producer", "epoch", "sourceGeneration", "connectionId", "connectionRevision", "lifecycleRevision", "leaseRevision", "previousDeliveryEpoch", "challenge", "expiresAt"];
export function browserWatchRestoreAppendAllowed(batch: readonly Event[], read: () => readonly Event[]) {
  const rows = [...read()];
  try {
    for (const e of batch) {
      if (!types.includes(e.type)) { rows.push(e); continue; }
      if (typeof e.owner !== "string" || typeof e.id !== "string" || !integer(e.at)) return false;
      const history = own(rows, e.owner), prior = history.find(p => p.type === e.type && p.id === e.id);
      if (prior) { if (harnessDigest(prior) !== harnessDigest(e)) return false; continue; }
      if (e.type === types[2]) {
        const request = requestOf(history, String(e.requestId)), checks = checksOf(history, String(e.requestId));
        if (!request || e.watchId !== request.watchId || e.deadlineAt !== request.deadlineAt || !integer(e.attempt) || e.attempt !== checks.length || Number(e.attempt) > 4 ||
          checks.some(c => c.status === "confirmed") || !["confirmed", "unconfirmed"].includes(String(e.status)) ||
          e.id !== `${request.id}:${e.attempt}` || e.status === "confirmed" && !permitOf(history, String(request.id)) ||
          e.status === "unconfirmed" && Number(e.attempt) >= 4 ||
          e.nextAt !== undefined && (e.status !== "unconfirmed" || Number(e.attempt) >= 3 || !integer(e.nextAt) || Number(e.nextAt) <= Number(e.at) || Number(e.nextAt) > Number(e.deadlineAt))) return false;
      } else {
        const allowedKeys = ["type", "owner", "id", "at", ...scopeKeys, ...(e.type === types[0] ? ["deadlineAt"] : ["requestId", "deliveryEpoch", "hostThrough", "prefixDigest", "queueHead", "queueAcknowledged", "queueOffered", "profile", "restoreAt"])];
        if (Object.keys(e).some(k => !allowedKeys.includes(k)) || !uuid.test(String(e.challenge)) ||
          !["watchId", "producer", "epoch", "connectionId", "connectionRevision"].every(k => typeof e[k] === "string" && String(e[k]).length > 0) ||
          !["generation", "sourceGeneration", "lifecycleRevision", "leaseRevision", "expiresAt"].every(k => integer(e[k])) || Number(e.generation) < 1 || Number(e.sourceGeneration) < 1 ||
          e.previousDeliveryEpoch !== null && !uuid.test(String(e.previousDeliveryEpoch))) return false;
        const head = history.findLast(p => p.type === "AikoBrowserWatchPrepared" && p.watchId === e.watchId), control = history.findLast(p => p.type === "AikoBrowserWatchControlled" && p.watchId === e.watchId);
        const lifecycle = Number(history.findLast(p => p.type === "AikoBrowserWatchControlled" && p.watchId === e.watchId && p.status === "active")?.controlRevision ?? 0);
        const renewal = history.filter(p => p.type === "AikoBrowserWatchLeaseRenewalRequested" && p.watchId === e.watchId)
          .findLast(p => history.some(c => c.type === "AikoBrowserWatchLeaseRenewalChecked" && c.requestId === p.id && c.status === "confirmed"));
        if (!head || head.generation !== e.generation || control && control.status !== "active" || e.lifecycleRevision !== lifecycle || e.leaseRevision !== Number(renewal?.leaseRevision ?? 0) ||
          !history.some(p => p.type === "AikoBrowserWatchActivated" && p.watchId === e.watchId && p.generation === e.generation) ||
          Number(e.expiresAt) <= Number(e.at)) return false;
        if (e.type === types[0]) {
          if (e.id !== `restore:${e.watchId}:${e.generation}:${e.challenge}` || e.deadlineAt !== Number(e.at) + 60_000 ||
            (browserWatchRestoreEpoch(history, e.owner, String(e.producer), String(e.epoch), Number(e.sourceGeneration)) ?? null) !== e.previousDeliveryEpoch ||
            history.some(p => p.type === types[0] && p.watchId === e.watchId && !checksOf(history, String(p.id)).some(c => c.status === "confirmed"))) return false;
        } else {
          const request = requestOf(history, String(e.requestId));
          if (!request || e.id !== request.id || scopeKeys.some(k => harnessDigest(e[k]) !== harnessDigest(request[k])) ||
            typeof e.profile !== "string" || !e.profile || !integer(e.restoreAt) || Number(e.at) >= Number(request.deadlineAt) || !uuid.test(String(e.deliveryEpoch)) || e.deliveryEpoch === e.previousDeliveryEpoch ||
            (browserWatchRestoreEpoch(history, e.owner, String(e.producer), String(e.epoch), Number(e.sourceGeneration)) ?? null) !== e.previousDeliveryEpoch ||
            !["hostThrough", "queueHead", "queueAcknowledged", "queueOffered"].every(k => integer(e[k])) ||
            Number(e.queueAcknowledged) > Number(e.hostThrough) || Number(e.hostThrough) > Number(e.queueHead) ||
            Number(e.queueAcknowledged) > Number(e.queueOffered) || Number(e.queueOffered) > Number(e.queueHead)) return false;
          const prefix = browserWatchRestorePrefix(history, e as unknown as Parameters<typeof browserWatchRestorePrefix>[1]);
          if (prefix.hostThrough !== e.hostThrough || prefix.prefixDigest !== e.prefixDigest) return false;
        }
      }
      rows.push(e);
    }
    return true;
  } catch { return false; }
}

export function createBrowserWatchReauthorization(binding: BrowserWatchRestorePorts & {
  owner: string; journal: WiringJournal;
  scope(rows: readonly Event[], watchId: string): BrowserWatchRestoreScope | undefined;
  current(config: BrowserWatchConfig): boolean;
  authorize(config: BrowserWatchConfig, signal: AbortSignal): Promise<void>;
  status(producer: string, signal: AbortSignal): Promise<unknown>;
  refresh(): Promise<void>;
  mutate<T>(producer: string, task: () => Promise<T>): Promise<T>;
}) {
  const { owner, journal } = binding;
  const caches = new Map<string, { config: BrowserWatchConfig; signal: AbortSignal; checked: boolean }>();
  const scope = (rows: readonly Event[], id: string) => binding.scope(own(rows, owner), id);
  const scoped = (rows: readonly Event[], event: Event, permit = true) => {
    const s = scope(rows, String(event.watchId)), g = s?.lease.grant;
    return !!s && !!g && s.active && binding.current(s.config) && s.generation === event.generation && s.lifecycleRevision === event.lifecycleRevision &&
      Number(s.lease.leaseRevision ?? 0) === event.leaseRevision && g.producer === event.producer && g.epoch === event.epoch && g.generation === event.sourceGeneration &&
      g.connectionId === event.connectionId && g.connectionRevision === event.connectionRevision && s.config.expiresAt === event.expiresAt &&
      (!permit || s.config.expiresAt > Date.now());
  };
  const admissionAllowed = (batch: readonly Event[], read: () => readonly Event[]) => {
    if (!browserWatchRestoreAppendAllowed(batch, read)) return false;
    for (const e of batch) {
      if (!types.includes(e.type)) continue;
      if (read().some(p => p.owner === owner && p.type === e.type && p.id === e.id && harnessDigest(p) === harnessDigest(e))) continue;
      const cached = caches.get(harnessDigest(e));
      const request = e.type === types[2] ? requestOf(own(read(), owner), String(e.requestId)) : e;
      if (e.owner !== owner || !cached || cached.signal.aborted || !binding.current(cached.config) || !request || !scoped(read(), request, e.type !== types[2])) return false;
      cached.checked = true;
    }
    return true;
  };
  const append = async (e: Event, config: BrowserWatchConfig, signal: AbortSignal) => {
    const key = harnessDigest(e), cache = { config, signal, checked: false }; caches.set(key, cache);
    try {
      await journal.transact(rows => {
        const prior = rows.find(p => p.owner === owner && p.type === e.type && p.id === e.id);
        if (prior) { if (harnessDigest(prior) !== key) throw Error("watch_restore_conflict"); return { events: [], result: undefined }; }
        if (!browserWatchRestoreAppendAllowed([e], () => rows)) throw Error("watch_restore_conflict");
        return { events: [e], result: undefined };
      });
      const prior = (await journal.read()).find(p => p.owner === owner && p.type === e.type && p.id === e.id);
      if (!prior || harnessDigest(prior) !== key || !cache.checked) throw Error("watch_restore_commit_unconfirmed");
    } finally { if (caches.get(key) === cache) caches.delete(key); }
  };
  const call = <T>(task: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, deadlineAt: number) => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(10_000, deadlineAt - Date.now())))]);
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(Error("watch_restore_private_timeout"));
      if (bounded.aborted) { abort(); return; }
      bounded.addEventListener("abort", abort, { once: true });
      void Promise.resolve().then(() => task(bounded)).then(resolve, reject).finally(() => bounded.removeEventListener("abort", abort));
    });
  };
  const statusMatches = (status: any, request: Event) => status && status.producer === request.producer && status.generation === request.sourceGeneration &&
    status.lifecycleRevision === request.lifecycleRevision && Number(status.leaseRevision ?? 0) === request.leaseRevision && status.expiresAt === request.expiresAt;
  const check = async (requestId: string, signal: AbortSignal) => {
    await binding.refresh();
    const initial = requestOf(own(await journal.read(), owner), requestId); if (!initial) throw Error("watch_restore_missing");
    await binding.mutate(String(initial.producer), async () => {
      let rows = own(await journal.read(), owner), request = requestOf(rows, requestId)!;
      const s = scope(rows, String(request.watchId)); if (!s || !binding.current(s.config)) throw Error("watch_restore_authority_unavailable");
      const checks = checksOf(rows, requestId); if (checks.some(e => e.status === "confirmed")) return;
      const attempt = checks.length, at = Date.now(), canApply = attempt < 4 && at < Number(request.deadlineAt);
      let permit = permitOf(rows, requestId), confirmed = false;
      try {
        await binding.authorize(s.config, signal);
        let status: any = await call(bounded => binding.status(String(request.producer), bounded), signal, Date.now() + 10_000);
        if (permit && statusMatches(status, request) && !status.restore && status.deliveryEpoch === permit.deliveryEpoch && Number.isSafeInteger(status.acknowledged) && status.acknowledged >= Number(permit.hostThrough)) confirmed = true;
        if (!confirmed && canApply && scoped(rows, request)) {
          if (!permit) {
            if (!statusMatches(status, request) || status.restore?.challenge !== request.challenge || !status.restore?.queue) throw Error("watch_restore_hold_unavailable");
            const prefix = browserWatchRestorePrefix(rows, request as unknown as Parameters<typeof browserWatchRestorePrefix>[1]);
            const proof: any = await call(bounded => binding.restoreProof!(String(request.producer), String(request.challenge), prefix.hostThrough, bounded), signal, Number(request.deadlineAt));
            const g = s.lease.grant;
            if (!proof || proof.owner !== owner || proof.producer !== g.producer || proof.profile !== g.profile || proof.epoch !== g.epoch || proof.generation !== g.generation ||
              proof.connectionId !== g.connectionId || proof.connectionRevision !== g.connectionRevision || proof.lifecycleRevision !== request.lifecycleRevision || proof.leaseRevision !== request.leaseRevision ||
              proof.challenge !== request.challenge || proof.expiresAt !== request.expiresAt || (proof.deliveryEpoch ?? null) !== request.previousDeliveryEpoch ||
              proof.at !== status.restore.at || proof.hostThrough !== prefix.hostThrough || proof.prefixDigest !== prefix.prefixDigest || !proof.queue) throw Error("watch_restore_prefix_unavailable");
            const event: Event = { type: types[1]!, owner, id: requestId, at: Date.now(), requestId,
              ...Object.fromEntries(scopeKeys.map(k => [k, request[k]])), deliveryEpoch: randomUUID(), ...prefix,
              profile: proof.profile, restoreAt: proof.at, queueHead: proof.queue.head, queueAcknowledged: proof.queue.acknowledged, queueOffered: proof.queue.offered };
            await append(event, s.config, signal); permit = event;
          }
          await binding.refresh(); rows = own(await journal.read(), owner);
          if (!scoped(rows, request)) throw Error("watch_restore_authority_changed");
          await binding.authorize(s.config, signal);
          await call(bounded => binding.reauthorizeLease!(permit as unknown as BrowserWatchRestorePermit, bounded), signal, Number(request.deadlineAt));
          status = await call(bounded => binding.status(String(request.producer), bounded), signal, Date.now() + 10_000);
          confirmed = statusMatches(status, request) && !status.restore && status.deliveryEpoch === permit.deliveryEpoch && Number.isSafeInteger(status.acknowledged) && status.acknowledged >= Number(permit.hostThrough);
        }
      } catch { /* The exact request/permit remains held; status reads never clear it. */ }
      rows = own(await journal.read(), owner); if (checksOf(rows, requestId).length !== attempt || checksOf(rows, requestId).some(e => e.status === "confirmed") || attempt > 4 || !confirmed && attempt >= 4) return;
      const nextAt = !confirmed && attempt < 3 && Date.now() < Number(request.deadlineAt) ? Math.min(Number(request.deadlineAt), Date.now() + [1000, 5000, 15000][attempt]!) : undefined;
      await append({ type: types[2]!, owner, id: `${requestId}:${attempt}`, at: Date.now(), requestId, watchId: request.watchId, attempt,
        deadlineAt: request.deadlineAt, status: confirmed ? "confirmed" : "unconfirmed", ...(nextAt === undefined ? {} : { nextAt }) }, s.config, signal);
      await binding.refresh();
    });
  };
  const reauthorize = async (raw: BrowserWatchRestoreInput, signal: AbortSignal) => {
    const args = structuredClone(raw);
    if (!args || Object.keys(args).some(k => !["id", "expectedGeneration", "expectedLifecycleRevision", "expectedLeaseRevision", "challenge"].includes(k)) ||
      !/^[A-Za-z0-9_.-]{1,64}$/.test(args.id) || !uuid.test(args.challenge) || ![args.expectedGeneration, args.expectedLifecycleRevision, args.expectedLeaseRevision].every(integer)) throw Error("watch_restore_invalid");
    if (!binding.restoreProof || !binding.reauthorizeLease) throw Error("watch_restore_capability_unavailable");
    await binding.refresh(); const rows = own(await journal.read(), owner), s = scope(rows, args.id);
    if (!s || !s.active || !binding.current(s.config) || s.generation !== args.expectedGeneration || s.lifecycleRevision !== args.expectedLifecycleRevision || Number(s.lease.leaseRevision ?? 0) !== args.expectedLeaseRevision) throw Error("watch_restore_scope_changed");
    await binding.authorize(s.config, signal);
    const requestId = `restore:${args.id}:${args.expectedGeneration}:${args.challenge}`;
    if (!requestOf(rows, requestId)) {
      const status: any = await call(bounded => binding.status(s.lease.grant.producer, bounded), signal, Date.now() + 10_000);
      const g = s.lease.grant, at = Date.now();
      const event: Event = { type: types[0]!, owner, id: requestId, at, watchId: args.id, generation: s.generation,
        producer: g.producer, epoch: g.epoch, sourceGeneration: g.generation, connectionId: g.connectionId, connectionRevision: g.connectionRevision,
        lifecycleRevision: s.lifecycleRevision, leaseRevision: Number(s.lease.leaseRevision ?? 0), previousDeliveryEpoch: browserWatchRestoreEpoch(rows, owner, g.producer, g.epoch, g.generation) ?? null,
        challenge: args.challenge, expiresAt: s.config.expiresAt, deadlineAt: at + 60_000 };
      if (!statusMatches(status, event) || status.restore?.challenge !== args.challenge || !status.restore?.queue) throw Error("watch_restore_hold_unavailable");
      await append(event, s.config, signal);
    }
    await check(requestId, signal);
    const after = own(await journal.read(), owner); return browserWatchRestoreState(after, requestOf(after, requestId));
  };
  return { reauthorize, check, admissionAllowed };
}
