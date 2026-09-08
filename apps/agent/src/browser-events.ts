import { createHmac, timingSafeEqual } from "node:crypto";
import type { Event } from "tardie/core/event";
import { channelSeal, type ChannelPrivateRef } from "./channel-custody.ts";
import { harnessDigest } from "./harness-library.ts";
import type { WiringJournal } from "./channel-wiring.ts";

export const BROWSER_EVENT_SCHEMA = "aiko.browser-event.v1";
export const browserEventTypes = {
  push: "AikoBrowserPushObserved",
  notification: "AikoBrowserNotificationObserved",
  network: "AikoBrowserNetworkObserved",
} as const;
export type BrowserEventKind = keyof typeof browserEventTypes;
export interface BrowserEventFields {
  origin: string;
  outcome: "received" | "displayed" | "completed" | "failed";
  method?: string;
  route?: string;
  status?: number;
}
/** Transport-only value. Private content is sealed before native log admission. */
export interface BrowserOccurrence {
  sequence: number;
  occurrence: string;
  kind: BrowserEventKind;
  observedAt: number;
  sourceId: string;
  fields: BrowserEventFields;
  payload?: unknown;
  cause?: string;
}
export interface BrowserEventBatch {
  schema: typeof BROWSER_EVENT_SCHEMA;
  producer: string;
  epoch: string;
  generation: number;
  items: BrowserOccurrence[];
}
/** Trusted producer capability. Never expose its key or permit page data to create it. */
export interface BrowserProducerGrant {
  owner: string;
  producer: string;
  epoch: string;
  profile: string;
  generation: number;
  connectionId: string;
  connectionRevision: string;
  origins: readonly string[];
  kinds: readonly BrowserEventKind[];
  active: boolean;
  expiresAt: number;
  registeredAt: number;
  secret: string;
}
export type BrowserProducerPolicy = (owner: string) => readonly BrowserProducerGrant[];
export interface BrowserObservedEvent extends Event {
  schema: typeof BROWSER_EVENT_SCHEMA;
  owner: string;
  id: string;
  producer: string;
  epoch: string;
  profile: string;
  generation: number;
  connectionId: string;
  connectionRevision: string;
  sequence: number;
  occurrence: string;
  kind: BrowserEventKind;
  observedAt: number;
  at: number;
  sourceId: string;
  fields: BrowserEventFields;
  commitment: ChannelPrivateRef;
  payloadRef?: ChannelPrivateRef;
  cause?: string;
}
const opaque = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_.:-]{1,160}$/.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const exact = (v: unknown, fields: readonly string[]): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => fields.includes(k));
export function browserEventOrigin(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 2048) throw Error("browser_origin_invalid");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.origin !== raw) throw Error("browser_origin_invalid");
  return url.origin;
}
export function validateBrowserEventFields(raw: unknown, kind: BrowserEventKind): BrowserEventFields {
  if (!exact(raw, ["origin", "outcome", "method", "route", "status"])) throw Error("browser_event_fields_invalid");
  const origin = browserEventOrigin(raw.origin);
  const permitted = kind === "push" ? ["received", "failed"] : kind === "notification" ? ["displayed", "failed"] : ["completed", "failed"];
  if (!permitted.includes(String(raw.outcome))) throw Error("browser_event_outcome_invalid");
  if (kind === "network") {
    if (typeof raw.method !== "string" || !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(raw.method) ||
      typeof raw.route !== "string" || !/^\/[a-zA-Z0-9_/:.{}-]{0,511}$/.test(raw.route) || raw.route.includes("..") ||
      !Number.isInteger(raw.status) || Number(raw.status) < 0 || Number(raw.status) > 599) throw Error("browser_network_fields_invalid");
  } else if (raw.method !== undefined || raw.route !== undefined || raw.status !== undefined) throw Error("browser_event_fields_invalid");
  return { origin, outcome: raw.outcome as BrowserEventFields["outcome"], ...(kind === "network" ? { method: raw.method as string, route: raw.route as string, status: raw.status as number } : {}) };
}
export function validateBrowserEventBatch(raw: unknown): BrowserEventBatch {
  if (!exact(raw, ["schema", "producer", "epoch", "generation", "items"]) || raw.schema !== BROWSER_EVENT_SCHEMA ||
    !opaque(raw.producer) || !opaque(raw.epoch) || !positive(raw.generation) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 128)
    throw Error("browser_batch_invalid");
  if (Buffer.byteLength(JSON.stringify(raw)) > 128_000) throw Error("browser_batch_bound");
  const items = raw.items.map((v: unknown) => {
    if (!exact(v, ["sequence", "occurrence", "kind", "observedAt", "sourceId", "fields", "payload", "cause"]) ||
      !positive(v.sequence) || !opaque(v.occurrence) || !Object.hasOwn(browserEventTypes, String(v.kind)) || !positive(v.observedAt) ||
      !opaque(v.sourceId) || v.cause !== undefined && !opaque(v.cause)) throw Error("browser_occurrence_invalid");
    return { ...v, fields: validateBrowserEventFields(v.fields, v.kind as BrowserEventKind) } as unknown as BrowserOccurrence;
  });
  if (items.some((v, i) => i > 0 && v.sequence !== items[i - 1]!.sequence + 1)) throw Error("browser_batch_gap");
  return { schema: BROWSER_EVENT_SCHEMA, producer: raw.producer, epoch: raw.epoch, generation: raw.generation, items };
}
export const browserBatchSignature = (batch: BrowserEventBatch, secret: string) => createHmac("sha256", secret).update(harnessDigest(batch)).digest("hex");
export function browserEventKey(e: Event): string | undefined {
  return e.schema === BROWSER_EVENT_SCHEMA && Object.values(browserEventTypes).includes(e.type as any) && opaque(e.owner) && opaque(e.producer) && opaque(e.epoch) && positive(e.generation) && positive(e.sequence)
    ? `aiko-browser-event:${e.owner}:${e.producer}:${e.epoch}:${e.generation}:${e.sequence}` : undefined;
}
export function browserEventAppendAllowed(batch: readonly Event[], read: () => readonly Event[]) {
  const rows = [...read()];
  for (const e of batch) {
    if (!Object.values(browserEventTypes).includes(e.type as any)) continue;
    const key = browserEventKey(e);
    if (!key) return false;
      const prior = rows.find(p => browserEventKey(p) === key);
    if (prior && harnessDigest(prior) !== harnessDigest(e)) return false;
    if (!prior) {
      if (rows.some(p => browserEventKey(p) && p.owner === e.owner && p.producer === e.producer && p.epoch === e.epoch && p.generation === e.generation && p.occurrence === e.occurrence)) return false;
      const sequence = rows.filter(p => browserEventKey(p) && p.owner === e.owner && p.producer === e.producer && p.epoch === e.epoch && p.generation === e.generation).reduce((n, p) => Math.max(n, Number(p.sequence)), 0);
      if (e.sequence !== sequence + 1) return false;
      rows.push(e);
    }
  }
  return true;
}

/** Receive-only HTTP adapter. It cannot publish arbitrary native events or choose a thread. */
export async function browserEventIngress(request: Request, admit: ReturnType<typeof createBrowserEventAdmission> | undefined, wake: () => Promise<unknown> | void): Promise<Response> {
  if (request.method !== "POST") return Response.json({error:"receive_only"},{status:405});
  if (!admit) return Response.json({error:"browser_source_unavailable"},{status:503});
  const signature=request.headers.get("x-browser-signature")??"";
  if (!/^[a-f0-9]{64}$/.test(signature)) return Response.json({error:"browser_producer_denied"},{status:401});
  if (!request.headers.get("content-type")?.startsWith("application/json")) return Response.json({error:"json_required"},{status:415});
  let raw:unknown;
  try {
    if (Number(request.headers.get("content-length")) > 128_000) throw Error("bound");
    const reader=request.body?.getReader();if(!reader)throw Error("empty");
    const chunks:Uint8Array[]=[];let size=0;
    try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>128_000)throw Error("bound");chunks.push(value);} }
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
    raw=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch { return Response.json({error:"browser_batch_invalid"},{status:400}); }
  try {
    const result=await admit(raw,signature);
    await wake();
    return Response.json(result,{status:202});
  } catch(error) {
    const code=error instanceof Error?error.message:"browser_admission_failed";
    const status=code==="browser_occurrence_conflict"||code==="browser_source_gap"?409:
      code==="browser_producer_denied"?401:code==="browser_producer_unavailable"||code==="browser_source_scope"?403:
      /^(browser_batch|browser_occurrence_invalid|browser_.*fields_invalid|browser_.*outcome_invalid|browser_source_time|browser_origin_invalid)/.test(code)?400:503;
    return Response.json({error:status===503?"browser_admission_unavailable":code},{status});
  }
}

/** Same owner log gate as channels; authentication and authority are rechecked after custody I/O. */
export function createBrowserEventAdmission(options: {
  owner: string;
  journal: WiringJournal;
  grant(producer: string): BrowserProducerGrant | undefined;
  current(): boolean;
  now?(): number;
}) {
  const now = options.now ?? Date.now;
  return async (raw: unknown, signature: string) => {
    const batch = validateBrowserEventBatch(raw);
    const grant = options.grant(batch.producer);
    const check = () => {
      const current = options.grant(batch.producer);
      if (!options.current() || !grant || !current || current.owner !== options.owner || !current.active || current.expiresAt <= now() ||
        current.generation !== batch.generation || current.epoch !== batch.epoch || harnessDigest(current) !== harnessDigest(grant) || current.secret.length < 32)
        throw Error("browser_producer_unavailable");
      const expected = browserBatchSignature(batch, current.secret);
      if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) throw Error("browser_producer_denied");
      return current;
    };
    const active = check();
    const prepared: BrowserObservedEvent[] = [];
    for (const item of batch.items) {
      if (!active.kinds.includes(item.kind) || !active.origins.includes(item.fields.origin)) throw Error("browser_source_scope");
      if (item.observedAt < active.registeredAt || item.observedAt > now() + 60_000) throw Error("browser_source_time");
      const commitment = await channelSeal(options.journal.blobs, options.owner, harnessDigest(item));
      const payloadRef = item.payload === undefined ? undefined : await channelSeal(options.journal.blobs, options.owner, item.payload);
      prepared.push({ type: browserEventTypes[item.kind], schema: BROWSER_EVENT_SCHEMA, owner: options.owner,
        id: `${batch.producer}:${batch.epoch}:${batch.generation}:${item.sequence}`, producer: batch.producer, epoch: batch.epoch, profile: active.profile,
        generation: batch.generation, connectionId: active.connectionId, connectionRevision: active.connectionRevision,
        sequence: item.sequence, occurrence: item.occurrence, kind: item.kind, observedAt: item.observedAt, at: now(), sourceId: item.sourceId,
        fields: item.fields, commitment, ...(payloadRef ? { payloadRef } : {}), ...(item.cause ? { cause: item.cause } : {}) });
    }
    return options.journal.transact(rows => {
      check();
      const events: Event[] = [];
      let duplicates = 0;
      for (const e of prepared) {
        const prior = rows.find(p => browserEventKey(p) === browserEventKey(e));
        if (prior) {
          if (harnessDigest(prior.commitment) !== harnessDigest(e.commitment)) throw Error("browser_occurrence_conflict");
          duplicates++;
        } else events.push(e);
      }
      if (!browserEventAppendAllowed(events, () => rows)) throw Error("browser_source_gap");
      return { events, result: { status: duplicates === prepared.length ? "duplicate" as const : "accepted" as const, through: batch.items.at(-1)!.sequence, accepted: events.length, duplicates } };
    }, async () => { check(); });
  };
}
