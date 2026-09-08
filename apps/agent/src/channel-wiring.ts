import {channelRuntimeNextWake} from "./channel-controls.ts";
import { hookLifetimes, hookForPort, hookAdoption, hookClosure, hookPortOpen, hookPendingDisposition, hookCleanupId, hookCurrentCleanupId, hookSourceAllowed, type HookAdoption } from "./channel-hook-lifetime.ts";
import { prepareChannelManagement, type ChannelManagementBinding } from "./channel-registry.ts";
import { channelSeal, channelHydrate } from "./channel-custody.ts";
import type { HarnessBlobStore } from "./harness-library.ts";
import { Sandbox, type Bindings } from "tardie/code/sandbox/service";
import { Effect, Layer } from "effect";
import { Validator } from "@cfworker/json-schema";
import { definePackage } from "tardie/code/package/definition";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Park } from "tardie/code/execution/errors";
import { Self } from "tardie/core/runtime";
import { Router } from "tardie/core/communication/router";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import type { Event } from "tardie/core/event";
import {
  channelDigest,
  channelEventDigest,
  channelId,
  CHANNEL_PROVENANCE,
} from "./channel-bindings.ts";

/** Receiving capability references are resolved by the host, never inferred from IDs.
 * execute must use the registry's durable operation identity; reconcile MUST NOT re-run
 * an uncertain write. No executable callback, schema implementation or grant is persisted.
 */
export interface ChannelWiringBindings {
  blobs?: HarnessBlobStore;
  now?(): number;
  /** Explicit standing-hook policy, distinct from ordinary receiving authority. */
  authorizeAdoption?(adoption: HookAdoption): Promise<string | undefined>;
  authorize(
    owner: string,
    authority: string,
    operation: "bind" | "connect" | "emit" | "backfill",
    value: unknown,
  ): Promise<boolean>;
  resolve(
    handler: HandlerPin,
    signal: AbortSignal,
  ): Promise<{
    management?: boolean;
    accepts: string;
    emits: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    effects: string[];
    eligible: boolean;
  }>;
  execute(
    handler: HandlerPin,
    input: unknown,
    key: string,
    signal: AbortSignal,
  ): Promise<HandlerResult>;
  reconcile(
    handler: HandlerPin,
    key: string,
    signal: AbortSignal,
  ): Promise<HandlerResult>;
}
export type HandlerPin = { harness: string; contract: string };
export type HandlerResult =
  | { status: "satisfied"; output: unknown; evidence: string }
  | { status: "pending" | "rejected" | "exhausted" | "unavailable"; evidence: string };
export interface WiringJournal {
  blobs?: HarnessBlobStore;
  read(): Promise<readonly Event[]>;
  /** fn is synchronous and runs under the SAME gate as all source admission. */
  transact<T>(
    fn: (events: readonly Event[]) => { events: Event[]; result: T },
    beforeCommit?: () => Promise<void>,
  ): Promise<T>;
}
type PortRef = { channel: string; generation: number };
export type InternalPort = PortRef & {
  owner: string;
  name: string;
  schema: string;
  directions: ("inbox" | "outbox")[];
  maxBytes: number;
  maxHops: number;
  backlog: number;
  status: "active";
};
type Wire = {
  id: string;
  generation: number;
  owner: string;
  input: PortRef;
  accepts: string;
  handler: HandlerPin;
  output: PortRef & { mode: "reply-to-accepted-input" | "port" };
  authority: string;
  start: number;
  end?: number;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  emits: string;
  maxAttempts: number;
  status: "active" | "failed";
  reason?: string;
};
const kinds = new Set([
  "ManagementGranted",
  "HookAdopted",
  "HookRetired",
  "HookCleaned",
  "HandlerDispatched",
  "HandlerChecked",
  "Bound",
  "Connected",
  "Accepted",
  "Claimed",
  "Handoff",
  "Cursor",
  "Consumed",
  "Started",
  "Settled",
  "Reconcile",
  "WaitRegistered",
  "WaitReady",
  "WaitDelivered",
  "WaitCancelled",
]);
export function channelWiringEventKey(e: Event) {
  return e.provenance === CHANNEL_PROVENANCE &&
    e.owner &&
    typeof e.id === "string" &&
    e.type.startsWith("AikoChannelWiring") &&
    kinds.has(e.type.slice(17))
    ? `aiko-channel-wiring:${e.owner}:${e.type}:${e.id}`
    : undefined;
}
const fact = (
  owner: string,
  kind: string,
  id: string,
  fields: Record<string, unknown>,
): Event => ({
  at: 0,
  ...fields,
  type: `AikoChannelWiring${kind}`,
  owner,
  id,
  provenance: CHANNEL_PROVENANCE,
});
const own = (events: readonly Event[], owner: string) =>
  events.filter((e) => channelWiringEventKey(e) && e.owner === owner);
const at = (events: readonly Event[], kind: string, id: unknown) =>
  events.findLast(
    (e) =>
      e.type === `AikoChannelWiring${kind}` &&
      (e.id === id || (kind === "Settled" && e.invocation === id)),
  );
const portKey = (p: PortRef) => `${p.channel}:${p.generation}`;
const equal = (a: unknown, b: unknown) => channelDigest(a) === channelDigest(b);
const strict = (x: any, fields: string[]) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.keys(x).every((k) => fields.includes(k));
const text = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= 512;
const pin = (x: any) =>
  strict(x, ["harness", "contract"]) &&
  [x.harness, x.contract].every(
    (d) => typeof d === "string" && /^(sha256:)?[a-f0-9]{64}$/.test(d),
  );
const ref = (x: any) =>
  strict(x, ["channel", "generation", "mode"]) &&
  text(x.channel) &&
  Number.isSafeInteger(x.generation) &&
  x.generation > 0;
const valid = (schema: Record<string, unknown>, value: unknown) =>
  new Validator(schema as any).validate(value).valid;
const size = (x: unknown) =>
  new TextEncoder().encode(JSON.stringify(x)).byteLength;
export function channelWiringView(events: readonly Event[], owner: string) {
  const rows = own(events, owner);
  const ports = new Map<string, InternalPort>(),
    wires = new Map<string, Wire>(),
    cursors = new Map<string, number>();
  for (const e of rows) {
    if (e.type === "AikoChannelWiringBound")
      ports.set(portKey(e.port as InternalPort), e.port as InternalPort);
    if (e.type === "AikoChannelWiringConnected") {
      const w = e.wire as Wire;
      wires.set(`${w.id}:${w.generation}`, w);
    }
    if (e.type === "AikoChannelWiringCursor")
      cursors.set(String(e.wiring), Number(e.sequence));
  }
  return { ports, wires, cursors, rows };
}
const sources = (rows: readonly Event[], p: PortRef) =>
  rows.filter(
    (e) => e.type === "AikoChannelWiringAccepted" && equal(e.port, p),
  );
const head = (rows: readonly Event[], p: PortRef) => sources(rows, p).length;

/** Install alongside channelAppendAllowed at the native transaction boundary. Public
 * ingress must reject this reserved namespace; provenance alone is NOT authentication.
 */
export function channelWiringAppendAllowed(
  batch: readonly Event[],
  read: () => readonly Event[],
) {
  const rows = [...read()];
  for (const e of batch) {
    if (!e.type.startsWith("AikoChannelWiring")) continue;
    const key = channelWiringEventKey(e);
    if (!key) return false;
    const previous = rows.find((r) => channelWiringEventKey(r) === key);
    if (previous) {
      if (channelEventDigest(previous) !== channelEventDigest(e)) return false;
      continue;
    }
    const local = own(rows, String(e.owner));
    const open = (port: unknown) => hookPortOpen(rows, String(e.owner), port, Date.now());
    if (e.type === "AikoChannelWiringConsumed") {
      const source = at(local, "Accepted", e.source);
      if (!source?.invocation || !local.some(row => row.type === "AikoChannelWiringSettled" && row.invocation === source.invocation && row.status === "satisfied") ||
        typeof e.consumer !== "string" || e.id !== channelDigest([e.owner, e.source, e.consumer])) return false;
    }
    if (e.type === "AikoChannelWiringBound" && String(e.operationId).startsWith("child:")) {
      const g = hookLifetimes(rows,String(e.owner)).find(g=>String(e.operationId).startsWith(g.namespace+":"));
      if (!g || hookClosure(rows,String(e.owner),g,Date.now())) return false;
    }
    if (e.type === "AikoChannelWiringAccepted" && !open(e.port)) return false;
    if (e.type === "AikoChannelWiringConnected" && (!open((e.wire as Wire).input) || !open((e.wire as Wire).output))) return false;
    if (e.type === "AikoChannelWiringClaimed" && (!open((e.wire as Wire).input) || !hookSourceAllowed(rows,String(e.owner),(e.wire as Wire).input,Number(at(local,"Accepted",e.source)?.sequence)))) return false;
    if (e.type === "AikoChannelWiringStarted") {
      const claim = at(local, "Claimed", e.id);
      if (claim && !open((claim.wire as Wire).input)) return false;
    }
    if (e.type === "AikoChannelWiringHookAdopted") {
      const g = hookLifetimes(rows, String(e.owner)).find(g => g.execution === e.id);
      if (!g || ![undefined,"parent_completed"].includes(hookClosure(rows, String(e.owner), g, Date.now())) || !Number.isSafeInteger(e.expiresAt) || Number(e.expiresAt) <= Date.now() || e.namespace !== g.namespace) return false;
      const expected = Object.fromEntries(local.filter(b=>b.type === "AikoChannelWiringBound" && String(b.operationId).startsWith(g.namespace+":")).map(b=>{
        const p=b.port as PortRef; return [portKey(p),head(local,{channel:p.channel,generation:p.generation})];
      }));
      if (!equal(e.watermarks,expected) || !text(e.policyDigest) || hookPendingDisposition(rows,String(e.owner),g).some(s=>s.invocations.some(i=>i.disposition === "unknown_retained"))) return false;
    }
    if (
      e.type === "AikoChannelWiringAccepted" &&
      e.sequence !== head(local, e.port as PortRef) + 1
    )
      return false;
    if (
      e.type === "AikoChannelWiringAccepted" &&
      e.requestWaiter !== undefined
    ) {
      const waiter = at(local, "WaitRegistered", e.requestWaiter);
      if (
        !waiter ||
        waiter.source !== e.id ||
        waiter.operationRef === undefined
      )
        return false;
    }
    if (
      e.type === "AikoChannelWiringConnected" &&
      e.watermark !== head(local, (e.wire as Wire).input)
    )
      return false;
    if (
      e.type === "AikoChannelWiringWaitRegistered" &&
      e.operationRef !== undefined
    ) {
      const source = batch.find(
        (r) =>
          r.type === "AikoChannelWiringAccepted" &&
          r.owner === e.owner &&
          r.id === e.source,
      );
      const wires = [
        ...channelWiringView(local, String(e.owner)).wires.values(),
      ];
      const wire = wires.find(
        (w) =>
          source &&
          e.invocation ===
            channelDigest([e.owner, w.id, w.generation, source.id]),
      );
      if (
        !source ||
        source.requestWaiter !== e.id ||
        at(local, "Accepted", e.source) ||
        !wire ||
        wire.status !== "active" ||
        !equal(wire.input, source.port) ||
        !equal(wire.handler, e.handler) ||
        wire.output.channel !== (e.port as PortRef)?.channel ||
        wire.output.generation !== (e.port as PortRef)?.generation ||
        wire.emits !== e.schema ||
        wire.accepts !== source.schema ||
        Number(source.sequence) <= wire.start ||
        Number(source.sequence) > (wire.end ?? Infinity) ||
        source.correlation !== e.correlation ||
        e.watermark !== head(local, e.port as PortRef) ||
        wires.some((w) => w.id === wire.id && w.generation > wire.generation) ||
        local.some(
          (r) => r.type === e.type && r.operationRef === e.operationRef,
        )
      )
        return false;
    }
    if (e.type === "AikoChannelWiringHandoff" && !at(local, "Claimed", e.id))
      return false;
    if (e.type === "AikoChannelWiringClaimed") {
      const w = e.wire as Wire;
      const registered = at(local, "Connected", `${w.id}:${w.generation}`);
      const source = at(local, "Accepted", e.source);
      const upgrade = local.find(
        (r) =>
          r.type === "AikoChannelWiringConnected" &&
          (r.wire as Wire).id === w.id &&
          (r.wire as Wire).generation === w.generation + 1,
      );
      if (
        !registered ||
        !equal(registered.wire, w) ||
        w.status !== "active" ||
        !source ||
        !equal(source.port, w.input) ||
        Number(source.sequence) <= w.start ||
        Number(source.sequence) >
          Math.min(
            w.end ?? Infinity,
            upgrade ? Number(upgrade.watermark) : Infinity,
          ) ||
        e.id !== channelDigest([e.owner, w.id, w.generation, source.id])
      )
        return false;
    }
    if (e.type === "AikoChannelWiringStarted" && !at(local, "Handoff", e.id))
      return false;
    if (e.type === "AikoChannelWiringCursor") {
      const source = at(local, "Accepted", e.source);
      const w = at(local, "Connected", e.wiring)?.wire as Wire | undefined;
      const previousCursor = local.findLast(
        (r) => r.type === e.type && r.wiring === e.wiring,
      );
      if (
        (!at(local, "Handoff", e.id) &&
          at(local, "Settled", e.id)?.status !== "rejected") ||
        !source ||
        !w ||
        !equal(source.port, w.input) ||
        e.sequence !== source.sequence ||
        Number(e.sequence) <= Number(previousCursor?.sequence ?? w.start)
      )
        return false;
    }
    rows.push(e);
  }
  return true;
}

const cancelledCall = (events: readonly Event[], callId: unknown) => {
  const call = events.find(
    (e) => e.type === "PackageCalled" && e.callId === callId,
  );
  return (
    !!call &&
    events.some(
      (e) =>
        ["TurnCancelled", "TurnFailed"].includes(e.type) &&
        e.turn === call.turn &&
        Number(e.epoch ?? 0) === Number(call.epoch ?? 0),
    )
  );
};

export function createChannelWiring(
  owner: string,
  journal: WiringJournal,
  bindings: ChannelWiringBindings,
) {
  const scoped = Effect.gen(function* () {
    const self = yield* Self;
    if (!bindings.blobs) throw new Error("channel_custody_unavailable");
    if (self.actor !== "aiko" || self.thread !== `user-${owner}`)
      throw new Error("channel_owner_mismatch");
    return self;
  });
  const transaction = <T>(
    f: (rows: readonly Event[]) => { events: Event[]; result: T },
    callId?: string,
  ) =>
    journal.transact((rows) => {
      if (callId && cancelledCall(rows, callId))
        throw new Error("channel_request_cancelled");
      return f(rows);
    });
  const checked = async (
    authority: string,
    operation: "bind" | "connect" | "emit" | "backfill",
    value: unknown,
  ) => {
    if (
      !text(authority) ||
      !(await bindings.authorize(owner, authority, operation, value))
    )
      throw new Error("channel_capability_denied");
  };
  const now = bindings.now ?? Date.now;
  // Prepare custody/authorization outside the gate; compute sequence and capacity
  // inside it. Both emit and request use this exact synchronous admission fence.
  const prepareAdmission = (raw: unknown) =>
    Effect.gen(function* () {
      yield* scoped;
      const a = structuredClone(raw) as any;
      if (
        !strict(a, [
          "port",
          "schema",
          "value",
          "occurrence",
          "correlation",
          "authorityRef",
        ]) ||
        !ref(a.port) ||
        !text(a.schema) ||
        !text(a.occurrence) ||
        !text(a.correlation)
      )
        throw new Error("channel_emit_invalid");
      yield* Effect.promise(() => checked(a.authorityRef, "emit", a));
      if (!(yield* Effect.promise(() => portAuthorized(a.port)))) throw Error("channel_hook_closed");
      const bytes = size(a.value);
      const valueRef = yield* Effect.promise(() =>
        channelSeal(bindings.blobs, owner, a.value),
      );
      const identityRef = yield* Effect.promise(() =>
        channelSeal(bindings.blobs, owner, [a.schema, a.value, a.correlation]),
      );
      const correlationRef = yield* Effect.promise(() =>
        channelSeal(bindings.blobs, owner, a.correlation),
      );
      const occurrenceRef = yield* Effect.promise(() =>
        channelSeal(bindings.blobs, owner, a.occurrence),
      );
      return (rows: readonly Event[]) => {
        const port = channelWiringView(rows, owner).ports.get(portKey(a.port));
        if (
          !port ||
          !hookPortOpen(rows, owner, a.port, now()) ||
          !port.directions.includes("inbox") ||
          port.schema !== a.schema
        )
          throw new Error("channel_source_scope");
        const id = channelDigest([owner, a.port, occurrenceRef.ref]),
          digest = identityRef.ref;
        const prior = at(rows, "Accepted", id);
        if (prior) {
          if (prior.digest !== digest)
            throw new Error("channel_occurrence_conflict");
          return {
            events: [],
            result: {
              id,
              sequence: Number(prior.sequence),
              status: "accepted",
            },
          };
        }
        if (bytes > port.maxBytes) throw new Error("channel_bytes");
        const pending = sources(rows, a.port).filter(
          (e) =>
            !rows.some(
              (r) => ["AikoChannelWiringCursor", "AikoChannelWiringConsumed"].includes(r.type) && r.source === e.id,
            ),
        );
        if (
          pending.length >= port.backlog ||
          pending.reduce((n, e) => n + Number(e.bytes), 0) + bytes >
            port.maxBytes * port.backlog
        )
          throw new Error("channel_backlog");
        const sequence = head(rows, a.port) + 1;
        return {
          events: [
            fact(owner, "Accepted", id, {
              at: now(),
              port: a.port,
              schema: a.schema,
              valueRef,
              bytes,
              correlation: correlationRef.ref,
              correlationRef,
              occurrence: occurrenceRef.ref,
              occurrenceRef,
              sequence,
              digest,
              ancestry: [],
              authority: a.authorityRef,
            }),
          ],
          result: { id, sequence, status: "accepted" },
        };
      };
    });
  let adoptionPolicy = bindings.authorizeAdoption;
  const standingAllowed = async (a: HookAdoption) => {
    await checked(a.authorityRef, "connect", a);
    const digest = await adoptionPolicy?.(a);
    if (!digest) throw Error("channel_standing_policy_denied");
    return digest;
  };
  const portAuthorized = async (port: unknown) => {
    const rows = await journal.read();
    if (!hookPortOpen(rows, owner, port, now())) return false;
    const g = hookForPort(rows, owner, port), adoption = g && hookAdoption(rows, owner, g);
    if (adoption) {
      try { if (await standingAllowed({...g!, operationId:String(adoption.operationId), authorityRef:String(adoption.authorityRef), expiresAt:Number(adoption.expiresAt)}) !== adoption.policyDigest) return false; }
      catch { return false; }
    }
    return true;
  };
  const api = {
    hooks: (raw: unknown) => Effect.gen(function* () {
      yield* scoped;
      const a = raw as any;
      if (!strict(a,["authorityRef"])) throw Error("channel_hooks_invalid");
      yield* Effect.promise(() => checked(a.authorityRef,"connect",a));
      const rows = yield* Effect.promise(journal.read);
      return hookLifetimes(rows,owner).map(g=>({...g, lifetime:hookAdoption(rows,owner,g)?"standing":"task", expiresAt:Number(hookAdoption(rows,owner,g)?.expiresAt ?? g.deadline), reason:hookClosure(rows,owner,g,now()) ?? "active",
        ports:own(rows,owner).filter(e=>e.type==="AikoChannelWiringBound" && String(e.operationId).startsWith(g.namespace+":")).map(e=>e.port)}));
    }),
    adopt: (raw: unknown) => Effect.gen(function* () {
      yield* scoped;
      const a = structuredClone(raw) as any;
      if (!strict(a, ["execution", "authorityRef", "operationId", "expiresAt"]) || !text(a.execution) || !text(a.operationId) || !Number.isSafeInteger(a.expiresAt) || a.expiresAt <= now()) throw Error("channel_adoption_invalid");
      const rows = yield* Effect.promise(journal.read);
      const g = hookLifetimes(rows, owner).find(g => g.execution === a.execution);
      if (!g) throw Error("channel_task_hook_missing");
      const decision: HookAdoption = {...g, ...a};
      const policyDigest = yield* Effect.promise(() => standingAllowed(decision));
      return yield* Effect.promise(() => journal.transact(current => {
        const prior = hookAdoption(current, owner, g);
        if (prior) {
          if (prior.operationId !== a.operationId || prior.expiresAt !== a.expiresAt || prior.authorityRef !== a.authorityRef || prior.policyDigest !== policyDigest) throw Error("channel_adoption_conflict");
          return {events:[],result:{execution:g.execution,status:"standing",expiresAt:a.expiresAt}};
        }
        if (![undefined,"parent_completed"].includes(hookClosure(current, owner, g, now()))) throw Error("channel_task_hook_closed");
        if (hookPendingDisposition(current,owner,g).some(s=>s.invocations.some(i=>i.disposition === "unknown_retained"))) throw Error("channel_hook_uncertainty_requires_reconciliation");
        const watermarks=Object.fromEntries(own(current,owner).filter(e=>e.type === "AikoChannelWiringBound" && String(e.operationId).startsWith(g.namespace+":")).map(e=>[portKey(e.port as PortRef),head(current,{channel:(e.port as PortRef).channel,generation:(e.port as PortRef).generation})]));
        return {events:[fact(owner,"HookAdopted",g.execution,{...decision,policyDigest,watermarks})],result:{execution:g.execution,status:"standing",expiresAt:a.expiresAt}};
      }, async () => { if (await standingAllowed(decision) !== policyDigest) throw Error("channel_standing_policy_changed"); }));
    }),
    retireHook: (raw: unknown) => Effect.gen(function* () {
      yield* scoped;
      const a = structuredClone(raw) as any;
      if (!strict(a,["execution","authorityRef","operationId"]) || !text(a.execution) || !text(a.operationId)) throw Error("channel_retirement_invalid");
      yield* Effect.promise(() => checked(a.authorityRef,"connect",a));
      return yield* Effect.promise(() => journal.transact(rows => {
        const g = hookLifetimes(rows,owner).find(g=>g.execution===a.execution);
        if (!g) throw Error("channel_task_hook_missing");
        return {events:at(rows,"HookRetired",g.execution)?[]:[fact(owner,"HookRetired",g.execution,{operationId:a.operationId})],result:{execution:g.execution,status:"revoked"}};
      }, () => checked(a.authorityRef,"connect",a)));
    }),
    bind: (raw: unknown) =>
      Effect.gen(function* () {
        yield* scoped;
        const a = structuredClone(raw) as any;
        if (
          !strict(a, [
            "name",
            "schema",
            "directions",
            "authorityRef",
            "operationId",
            "maxBytes",
            "maxHops",
            "backlog",
          ]) ||
          !text(a.name) ||
          !text(a.schema) ||
          !text(a.operationId) ||
          !Array.isArray(a.directions) ||
          !a.directions.length ||
          a.directions.some(
            (d: unknown) => !["inbox", "outbox"].includes(String(d)),
          )
        )
          throw new Error("channel_bind_invalid");
        yield* Effect.promise(() => checked(a.authorityRef, "bind", a));
        const port: InternalPort = {
          channel: channelId(owner, `internal:${a.name}`),
          owner,
          name: a.name,
          generation: 1,
          schema: a.schema,
          directions: [...new Set(a.directions)] as InternalPort["directions"],
          maxBytes: a.maxBytes ?? 65536,
          maxHops: a.maxHops ?? 8,
          backlog: a.backlog ?? 128,
          status: "active",
        };
        if (
          ![port.maxBytes, port.maxHops, port.backlog].every(
            (n) => Number.isSafeInteger(n) && n > 0,
          ) ||
          port.maxBytes > 1048576 ||
          port.maxHops > 32 ||
          port.backlog > 1024
        )
          throw new Error("channel_limits_invalid");
        return yield* Effect.promise(() =>
          transaction((rows) => {
            const existing = channelWiringView(rows, owner).ports.get(
              portKey(port),
            );
            if (existing && !equal(existing, port))
              throw new Error("channel_binding_conflict");
            return {
              events: existing
                ? []
                : [
                    fact(owner, "Bound", portKey(port), {
                      port,
                      operationId: a.operationId,
                    }),
                  ],
              result: existing ?? port,
            };
          }),
        );
      }),
    connect: (raw: unknown) =>
      Effect.gen(function* () {
        yield* scoped;
        const a = structuredClone(raw) as any;
        if (
          !strict(a, [
            "name",
            "generation",
            "input",
            "accepts",
            "handler",
            "output",
            "authorityRef",
            "start",
            "operationId",
            "maxAttempts",
          ]) ||
          !text(a.name) ||
          !text(a.operationId) ||
          !ref(a.input) ||
          !ref(a.output) ||
          !pin(a.handler) ||
          !text(a.accepts) ||
          !Number.isSafeInteger(a.generation) ||
          a.generation < 1 ||
          !["reply-to-accepted-input", "port"].includes(a.output.mode)
        )
          throw new Error("channel_connect_invalid");
        if (
          a.start !== "after-registration" &&
          !(
            strict(a.start, ["from", "through", "authorityRef"]) &&
            Number.isSafeInteger(a.start.from) &&
            a.start.from > 0 &&
            Number.isSafeInteger(a.start.through) &&
            a.start.through >= a.start.from &&
            a.start.through - a.start.from < 128
          )
        )
          throw new Error("channel_backfill_invalid");
        yield* Effect.promise(() => checked(a.authorityRef, "connect", a));
        if (a.start !== "after-registration")
          yield* Effect.promise(() =>
            checked(a.start.authorityRef, "backfill", a),
          );
        const descriptor = yield* Effect.promise(() =>
          bindings.resolve(a.handler, AbortSignal.timeout(5000)),
        );
        const attempts = a.maxAttempts ?? 2;
        if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5)
          throw new Error("channel_retry_invalid");
        return yield* Effect.promise(() =>
          transaction((rows) => {
            const state = channelWiringView(rows, owner),
              input = state.ports.get(portKey(a.input)),
              output = state.ports.get(portKey(a.output));
            if (!input || !output || !hookPortOpen(rows, owner, a.input, now()) || !hookPortOpen(rows, owner, a.output, now()))
              throw new Error("channel_receiving_capability_required");
            const id = channelId(owner, `wire:${a.name}`),
              key = `${id}:${a.generation}`;
            const old = at(rows, "Connected", key),
              requestDigest = channelDigest(a);
            if (old) {
              if (old.requestDigest !== requestDigest)
                throw new Error("channel_wiring_conflict");
              return { events: [], result: old.wire as Wire };
            }
            const versions = [...state.wires.values()].filter(
              (w) => w.id === id,
            );
            if (versions.some((w) => !equal(w.input, a.input)))
              throw new Error("channel_wiring_input_immutable");
            if (
              a.generation !==
              Math.max(0, ...versions.map((w) => w.generation)) + 1
            )
              throw new Error("channel_wiring_generation");
            const watermark = head(rows, a.input);
            if (a.start !== "after-registration" && a.start.through > watermark)
              throw new Error("channel_backfill_future");
            const compatible =
              descriptor.eligible &&
              descriptor.accepts === a.accepts &&
              input.schema === a.accepts &&
              descriptor.emits === output.schema &&
              input.directions.includes("inbox") &&
              output.directions.includes("outbox") &&
              descriptor.effects.every(
                (e) => e === "pure" || e === "channel.reply" || e === "channel.manage" && descriptor.management === true,
              ) &&
              (a.output.mode !== "reply-to-accepted-input" ||
                equal(a.input, {
                  channel: a.output.channel,
                  generation: a.output.generation,
                }));
            const wire: Wire = {
              id,
              generation: a.generation,
              owner,
              input: a.input,
              accepts: a.accepts,
              handler: a.handler,
              output: a.output,
              authority: a.authorityRef,
              start:
                a.start === "after-registration" ? watermark : a.start.from - 1,
              ...(a.start === "after-registration"
                ? {}
                : { end: a.start.through }),
              inputSchema: descriptor.inputSchema,
              outputSchema: descriptor.outputSchema,
              emits: descriptor.emits,
              maxAttempts: attempts,
              status: compatible ? "active" : "failed",
              ...(!compatible
                ? { reason: "incompatible_schema_effect_or_capability" }
                : {}),
            };
            return {
              events: [
                fact(owner, "Connected", key, {
                  wire,
                  watermark,
                  requestDigest,
                  backfill: a.start,
                }),
              ],
              result: wire,
            };
          }),
        );
      }),
    emit: (raw: unknown) =>
      Effect.gen(function* () {
        const admit = yield* prepareAdmission(raw);
        return yield* Effect.promise(() => transaction(admit));
      }),
    wait: (
      raw: unknown,
      ctx: { callId: string },
      request?: { operationId: string; send: any },
    ): Effect.Effect<any, Park, Self> =>
      Effect.gen(function* () {
        yield* scoped;
        const a = structuredClone(raw) as any;
        if (
          !strict(a, [
            "port",
            "handler",
            "schema",
            "correlation",
            "deadline",
            "authorityRef",
          ]) ||
          !ref(a.port) ||
          !pin(a.handler) ||
          !text(a.schema) ||
          !text(a.correlation) ||
          !Number.isSafeInteger(a.deadline)
        )
          throw new Error("channel_wait_invalid");
        yield* Effect.promise(() => checked(a.authorityRef, "connect", a));
        if (request)
          yield* Effect.promise(() =>
            checked(request.send.authorityRef, "emit", request.send),
          );
        const registered = at(
          own(yield* Effect.promise(journal.read), owner),
          "WaitRegistered",
          channelDigest([owner, "wait", ctx.callId]),
        );
        const admit =
          request && !registered
            ? yield* prepareAdmission(request.send)
            : undefined;
        const waitRequest = yield* Effect.promise(() =>
          channelSeal(
            bindings.blobs,
            owner,
            request ? { reply: a, ...request } : a,
          ),
        );
        const correlationRef = yield* Effect.promise(() =>
          channelSeal(bindings.blobs, owner, a.correlation),
        );
        a.correlation = correlationRef.ref;
        const id = channelDigest([owner, "wait", ctx.callId]);
        const operationRef = request
          ? yield* Effect.promise(() =>
              channelSeal(bindings.blobs, owner, request.operationId),
            )
          : undefined;
        const ready = yield* Effect.promise(() =>
          transaction(
            (rows) => {
              const port = channelWiringView(rows, owner).ports.get(
                portKey(a.port),
              );
              if (!port || port.schema !== a.schema)
                throw new Error("channel_wait_scope");
              const previous = at(rows, "WaitRegistered", id),
                requestDigest = waitRequest.ref;
              if (previous && previous.requestDigest !== requestDigest)
                throw new Error("channel_wait_conflict");
              let admission: ReturnType<NonNullable<typeof admit>> | undefined;
              let invocation: string | undefined;
              if (request && !previous) {
                if (a.deadline <= now())
                  throw new Error("channel_request_expired");
                if (
                  rows.some(
                    (e) =>
                      e.type === "AikoChannelWiringWaitRegistered" &&
                      e.operationRef === operationRef!.ref,
                  )
                )
                  throw new Error("channel_request_conflict");
                admission = admit!(rows);
                if (!admission.events.length)
                  throw new Error("channel_request_source_exists");
                const wires = [
                  ...channelWiringView(rows, owner).wires.values(),
                ];
                const matching = wires.filter(
                  (w) =>
                    w.status === "active" &&
                    equal(w.input, request.send.port) &&
                    equal(w.handler, a.handler) &&
                    equal(
                      {
                        channel: w.output.channel,
                        generation: w.output.generation,
                      },
                      a.port,
                    ) &&
                    w.emits === a.schema &&
                    w.accepts === request.send.schema &&
                    admission!.result.sequence > w.start &&
                    admission!.result.sequence <= (w.end ?? Infinity) &&
                    !wires.some(
                      (next) =>
                        next.id === w.id && next.generation > w.generation,
                    ),
                );
                if (matching.length !== 1)
                  throw new Error("channel_request_wiring_scope");
                const wire = matching[0]!;
                if (!valid(wire.inputSchema, request.send.value))
                  throw new Error("channel_request_schema");
                invocation = channelDigest([
                  owner,
                  wire.id,
                  wire.generation,
                  admission.result.id,
                ]);
              }
              return {
                events: previous
                  ? []
                  : [
                      fact(owner, "WaitRegistered", id, {
                        ...a,
                        callId: ctx.callId,
                        awaiting: `channel-wait:${id}`,
                        requestDigest,
                        watermark: head(rows, a.port),
                        ...(request
                          ? {
                              operationRef: operationRef!.ref,
                              source: admission!.result.id,
                              invocation,
                            }
                          : {}),
                      }),
                      ...(admission?.events.map((e) => ({
                        ...e,
                        requestWaiter: id,
                      })) ?? []),
                    ],
                result: at(rows, "WaitReady", id),
              };
            },
            request ? ctx.callId : undefined,
          ),
        );
        if (ready) {
          const result = ready.result as any;
          if (result.status !== "satisfied") return result;
          return yield* Effect.promise(async () => {
            try {
              return {
                ...result,
                value: await channelHydrate(
                  bindings.blobs,
                  owner,
                  result.valueRef,
                ),
                correlation: await channelHydrate(
                  bindings.blobs,
                  owner,
                  result.correlationRef,
                ),
              };
            } catch {
              return { status: "unavailable" };
            }
          });
        }
        return yield* new Park({
          callId: ctx.callId,
          awaiting: `channel-wait:${id}`,
        });
      }),
    request: (
      raw: unknown,
      ctx: { callId: string },
    ): Effect.Effect<any, Park, Self> =>
      Effect.gen(function* () {
        const a = structuredClone(raw) as any;
        if (
          !strict(a, ["operationId", "send", "reply"]) ||
          !text(a.operationId) ||
          !a.send ||
          !a.reply ||
          a.send.correlation !== a.reply.correlation
        )
          throw new Error("channel_request_invalid");
        return yield* api.wait(a.reply, ctx, {
          operationId: a.operationId,
          send: a.send,
        });
      }),
    reconcile: (raw: unknown) =>
      Effect.gen(function* () {
        yield* scoped;
        const a = structuredClone(raw) as any;
        if (
          !strict(a, ["invocation", "operationId", "authorityRef"]) ||
          !text(a.invocation) ||
          !text(a.operationId)
        )
          throw new Error("channel_reconcile_invalid");
        yield* Effect.promise(() => checked(a.authorityRef, "connect", a));
        return yield* Effect.promise(() =>
          transaction((rows) => {
            const claim = at(rows, "Claimed", a.invocation);
            if (!claim || !at(rows, "Started", a.invocation))
              throw new Error("channel_invocation_missing");
            const requests = rows.filter(
              (e) =>
                e.type === "AikoChannelWiringReconcile" &&
                e.invocation === a.invocation,
            );
            const id = channelDigest([a.invocation, a.operationId]);
            if (at(rows, "Reconcile", id))
              return { events: [], result: { status: "pending" } };
            if (requests.length >= (claim.wire as Wire).maxAttempts)
              throw new Error("channel_retry_exhausted");
            return {
              events: [
                fact(owner, "Reconcile", id, { invocation: a.invocation }),
              ],
              result: { status: "pending" },
            };
          }),
        );
      }),
  };
  const native = component({
    name: "aiko.channel-wiring",
    keys: { prefixes: ["aiko-channel-wiring:"], keyOf: channelWiringEventKey },
    initial: () => [] as Event[],
    step: (s, e) =>
      (channelWiringEventKey(e) && e.owner === owner) ||
      ["BlockedOn", "PackageCalled", "TurnCancelled", "TurnFailed", "CodeCancelled", "AlarmFired"].includes(
        e.type,
      )
        ? [...s, e]
        : s,
    output: (rows) => {
      const state = channelWiringView(rows, owner);
      const transitions: ReturnType<typeof effect<any, Self | Router>>[] = [];
      for (const g of hookLifetimes(rows, owner)) {
        const reason = hookClosure(rows, owner, g, now());
        if (!reason || at(rows,"HookCleaned",hookCurrentCleanupId(rows,owner,g))) continue;
        transitions.push(effect({key:`aiko-channel-wiring:hook-cleanup:${hookCurrentCleanupId(rows,owner,g)}`,input:undefined,act:()=>Effect.promise(() => journal.transact(current => {
          const reason = hookClosure(current,owner,g,now());
          if (!reason || at(current,"HookCleaned",hookCurrentCleanupId(current,owner,g))) return {events:[],result:[]};
          const events = [fact(owner,"HookCleaned",hookCurrentCleanupId(current,owner,g),{execution:g.execution,namespace:g.namespace,reason,pending:hookPendingDisposition(current,owner,g)})];
          for (const waiter of own(current,owner).filter(e=>e.type==="AikoChannelWiringWaitRegistered" && hookForPort(current,owner,e.port)?.execution===g.execution && !at(current,"WaitReady",e.id) && !at(current,"WaitCancelled",e.id)))
            events.push(fact(owner,"WaitCancelled",String(waiter.id),{reason:"hook_closed"}));
          return {events,result:[]};
        }))}));
      }
      for (const [wireKey, wire] of state.wires) {
        if (!hookPortOpen(rows,owner,wire.input,now())) continue;
        if (wire.status !== "active") continue;
        // Upgrades close the old source window at the new registration's atomic watermark.
        const next = rows.find(
          (e) =>
            e.type === "AikoChannelWiringConnected" &&
            (e.wire as Wire).id === wire.id &&
            (e.wire as Wire).generation === wire.generation + 1,
        );
        const end = Math.min(
          wire.end ?? Infinity,
          next ? Number(next.watermark) : Infinity,
        );
        const source = sources(rows, wire.input).find(
          (e) =>
            hookSourceAllowed(rows,owner,wire.input,Number(e.sequence)) &&
            Number(e.sequence) > (state.cursors.get(wireKey) ?? wire.start) &&
            Number(e.sequence) <= end,
        );
        if (!source) continue;
        const id = channelDigest([owner, wire.id, wire.generation, source.id]);
        transitions.push(
          effect({
            key: `aiko-channel-wiring:handoff:${id}`,
            input: { id },
            act: () =>
              Effect.gen(function* () {
                const self = yield* scoped;
                const sourceValue = yield* Effect.promise(async () => {
                  try {
                    if (
                      !await portAuthorized(wire.input) ||
                      !(await bindings.authorize(
                        owner,
                        wire.authority,
                        "connect",
                        wire,
                      ))
                    )
                      return undefined;
                    return {
                      value: await channelHydrate(
                        bindings.blobs,
                        owner,
                        source.valueRef,
                      ),
                    };
                  } catch {
                    return undefined;
                  }
                });
                const claim = yield* Effect.promise(() =>
                  transaction((current) => {
                    const prior = at(current, "Claimed", id);
                    if (prior) return { events: [], result: prior };
                    if (!hookPortOpen(current,owner,wire.input,now())) return {events:[],result:undefined};
                    const input = state.ports.get(portKey(wire.input))!;
                    const ancestry = source.ancestry as string[];
                    if (
                      !sourceValue ||
                      !valid(wire.inputSchema, sourceValue.value) ||
                      ancestry.length >= input.maxHops ||
                      ancestry.includes(wire.id)
                    ) {
                      return {
                        events: [
                          fact(owner, "Settled", id, {
                            status: "rejected",
                            reason: sourceValue
                              ? "schema_or_chain_limit"
                              : "input_unavailable",
                          }),
                          fact(owner, "Cursor", id, {
                            wiring: wireKey,
                            source: source.id,
                            sequence: source.sequence,
                          }),
                        ],
                        result: undefined,
                      };
                    }
                    const active = current.filter(
                      (e) =>
                        e.type === "AikoChannelWiringClaimed" &&
                        !["satisfied", "rejected", "exhausted", "unavailable"].includes(
                          String(at(current, "Settled", e.id)?.status),
                        ),
                    );
                    if (active.length >= 8)
                      return { events: [], result: undefined };
                    const receipt = fact(owner, "Claimed", id, {
                      wire,
                      source: source.id,
                      valueRef: source.valueRef,
                      bytes: source.bytes,
                      correlation: source.correlation,
                      correlationRef: source.correlationRef,
                      ancestry,
                    });
                    return { events: [receipt], result: receipt };
                  }),
                );
                if (!claim) return [];
                const router = yield* Router;
                yield* router.send(
                  envelopeOf(
                    linkOf(self, self),
                    fact(owner, "Handoff", id, { claim: id }),
                  ),
                );
                yield* Effect.promise(() =>
                  transaction((current) =>
                    at(current, "Cursor", id)
                      ? { events: [], result: undefined }
                      : {
                          events: [
                            fact(owner, "Cursor", id, {
                              wiring: wireKey,
                              source: source.id,
                              sequence: source.sequence,
                            }),
                          ],
                          result: undefined,
                        },
                  ),
                );
                return [];
              }),
          }),
        );
      }
      for (const claim of rows.filter(
        (e) =>
          e.type === "AikoChannelWiringClaimed" && at(rows, "Handoff", e.id),
      )) {
        const id = String(claim.id),
          wire = claim.wire as Wire;
        if (!hookPortOpen(rows,owner,wire.input,now()) || !hookSourceAllowed(rows,owner,wire.input,Number(at(rows,"Accepted",claim.source)?.sequence))) continue;
        const settled = at(rows, "Settled", id);
        if (settled && settled.status !== "pending") continue;
        const request = rows.findLast(
          (e) => e.type === "AikoChannelWiringReconcile" && e.invocation === id,
        );
        // Checked bytes held solely by output capacity need publication, not an
        // external-effect retry. Consumer progress wakes this native transition.
        const publication = settled?.status === "pending" && settled.reason === "output_backpressure" && !!settled.outputRef;
        const outputSources = sources(rows, { channel: wire.output.channel, generation: wire.output.generation });
        const outputReleased = rows.filter(e => ["AikoChannelWiringCursor", "AikoChannelWiringConsumed"].includes(e.type) && outputSources.some(source => source.id === e.source)).length;
        if (publication) {
          const port = state.ports.get(portKey(wire.output));
          if (!port || outputSources.filter(source => !rows.some(e => ["AikoChannelWiringCursor", "AikoChannelWiringConsumed"].includes(e.type) && e.source === source.id)).length >= port.backlog ||
            settled.publicationCursor === outputReleased) continue;
        } else if (settled && (!request || settled.request === request.id)) continue;
        const attempt = publication ? `publish:${outputReleased}` : request?.id ?? "initial";
        transitions.push(
          effect({
            key: `aiko-channel-wiring:dispatch:${id}:${attempt}`,
            input: { id },
            act: (_input, signal) =>
              Effect.gen(function* () {
                yield* scoped;
                let inputUnavailable = false;
                let result: HandlerResult = yield* Effect.promise(async (): Promise<HandlerResult> => {
                  const authorized = async () => { try { return await portAuthorized(wire.input) && await portAuthorized(wire.output) && await bindings.authorize(owner, wire.authority, "connect", wire); } catch { return false; } };
                  if (!await authorized()) return { status: "rejected", evidence: "channel_capability_revoked" };
                  if (publication) {
                    try {
                      const resolved = await bindings.resolve(wire.handler, signal);
                      if (!resolved.eligible || resolved.accepts !== wire.accepts || resolved.emits !== wire.emits ||
                        !equal(resolved.inputSchema, wire.inputSchema) || !equal(resolved.outputSchema, wire.outputSchema))
                        return { status: "rejected", evidence: "checked_handler_unavailable" };
                      const output = await channelHydrate(bindings.blobs, owner, settled.outputRef);
                      const evidence = await channelHydrate(bindings.blobs, owner, settled.evidenceRef);
                      if (!await authorized()) return { status: "rejected", evidence: "channel_capability_revoked" };
                      return { status: "satisfied", output, evidence };
                    } catch { return { status: "unavailable", evidence: "checked_output_unavailable" }; }
                  }
                  let started = !!at(await journal.read(), "Started", id);
                  let value: unknown, correlation: unknown;
                  if (!started) {
                    // Missing custody before dispatch is a known unavailable input,
                    // not an uncertain external effect. A retained Started claim,
                    // however, must reconcile without needing the original bytes.
                    try {
                      value = await channelHydrate(bindings.blobs, owner, claim.valueRef);
                      if (!await authorized()) return { status: "rejected", evidence: "channel_capability_revoked" };
                      correlation = await channelHydrate(bindings.blobs, owner, claim.correlationRef);
                    } catch {
                      inputUnavailable = true;
                      return { status: "unavailable", evidence: "input_unavailable" };
                    }
                  }
                  if (!await authorized()) return { status: "rejected", evidence: "channel_capability_revoked" };
                  signal.throwIfAborted();
                  if (!started) started = await transaction((current) => {
                    const previous = at(current, "Started", id);
                    return { events: previous ? [] : [fact(owner, "Started", id, { handler: wire.handler })], result: !!previous };
                  });
                  try {
                    return await (started ? bindings.reconcile(wire.handler, id, signal) :
                      bindings.execute(wire.handler, { value, schema: wire.accepts, correlation }, id, signal));
                  } catch {
                    return { status: "pending", evidence: "dispatch_outcome_unknown" };
                  }
                });
                const sealed = yield* Effect.promise(async () => {
                  try {
                    return {
                      outputRef:
                        result.status === "satisfied"
                          ? await channelSeal(
                              bindings.blobs,
                              owner,
                              result.output,
                            )
                          : undefined,
                      evidenceRef: await channelSeal(
                        bindings.blobs,
                        owner,
                        result.evidence,
                      ),
                    };
                  } catch {
                    return undefined;
                  }
                });
                const outputRef = sealed?.outputRef,
                  evidenceRef = sealed?.evidenceRef;
                if (!sealed && !inputUnavailable)
                  result = {
                    status: "pending",
                    evidence: "custody_unavailable",
                  };
                yield* Effect.promise(() =>
                  transaction((current) => {
                    const prior = at(current, "Settled", id);
                    if (prior && prior.status !== "pending")
                      return { events: [], result: undefined };
                    const events: Event[] = [];
                    // A competing dispatcher may have claimed while custody was
                    // being read. Do not publish a false pre-dispatch terminal.
                    if (inputUnavailable && at(current, "Started", id)) {
                      inputUnavailable = false;
                      result = { status: "pending", evidence: "dispatch_outcome_unknown" };
                    }
                    if (result.status === "satisfied") {
                      const output = channelWiringView(
                        current,
                        owner,
                      ).ports.get(portKey(wire.output));
                      if (
                        !text(result.evidence) ||
                        !valid(wire.outputSchema, result.output) ||
                        !output ||
                        size(result.output) > output.maxBytes
                      )
                        result = {
                          status: "rejected",
                          evidence: "invalid_handler_output",
                        };
                      else if (
                        sources(current, {
                          channel: wire.output.channel,
                          generation: wire.output.generation,
                        }).filter(
                          (e) =>
                            !current.some(
                              (c) =>
                                ["AikoChannelWiringCursor", "AikoChannelWiringConsumed"].includes(c.type) &&
                                c.source === e.id,
                            ),
                        ).length >= output.backlog
                      )
                        result = {
                          status: "pending",
                          evidence: "output_backpressure",
                        };
                      else {
                        const port = {
                          channel: wire.output.channel,
                          generation: wire.output.generation,
                        };
                        const outputId = channelDigest([id, "output"]);
                        if (!at(current, "Accepted", outputId))
                          events.push(
                            fact(owner, "Accepted", outputId, {
                              at: now(),
                              port,
                              schema: wire.emits,
                              valueRef: outputRef,
                              bytes: size(result.output),
                              sequence: head(current, port) + 1,
                              correlation: claim.correlation,
                              correlationRef: claim.correlationRef,
                              occurrence: outputId,
                              digest: (outputRef as { ref: string }).ref,
                              ancestry: [
                                ...(claim.ancestry as string[]),
                                wire.id,
                              ],
                              replyTo: claim.source,
                              invocation: id,
                            }),
                          );
                      }
                    }
                    if (
                      result.status === "pending" && !(result.evidence === "output_backpressure" && outputRef) &&
                      current.filter(
                        (e) =>
                          e.type === "AikoChannelWiringReconcile" &&
                          e.invocation === id,
                      ).length >= wire.maxAttempts
                    )
                      result = {
                        status: "exhausted",
                        evidence: result.evidence,
                      };
                    // Attempt receipts are immutable; the projection uses the latest status.
                    events.push(
                      fact(owner, "Settled", `${id}:${attempt}`, {
                        invocation: id,
                        status: result.status,
                        ...(inputUnavailable ? { reason: "input_unavailable" } : {}),
                        ...(result.status === "pending" && result.evidence === "output_backpressure" && outputRef ? {
                          reason: "output_backpressure", outputRef,
                          publicationCursor: outputReleased,
                        } : {}),
                        evidenceRef,
                        request: attempt,
                      }),
                    );
                    return { events, result: undefined };
                  }),
                );
                return [];
              }),
          }),
        );
      }
      for (const waiter of rows.filter(
        (e) =>
          e.type === "AikoChannelWiringWaitRegistered" &&
          !at(rows, "WaitDelivered", e.id) &&
          !at(rows, "WaitCancelled", e.id),
      )) {
        if (cancelledCall(rows, waiter.callId)) {
          if (!at(rows, "WaitCancelled", waiter.id))
            transitions.push(
              effect({
                key: `aiko-channel-wiring:cancel-wait:${waiter.id}`,
                input: { id: waiter.id },
                act: () =>
                  Effect.gen(function* () {
                    yield* scoped;
                    yield* Effect.promise(() =>
                      transaction((current) => ({
                        events: at(current, "WaitCancelled", waiter.id)
                          ? []
                          : [
                              fact(owner, "WaitCancelled", String(waiter.id), {
                                status: "cancelled",
                              }),
                            ],
                        result: undefined,
                      })),
                    );
                    return [];
                  }),
              }),
            );
          continue;
        }
        if (
          !rows.some(
            (e) =>
              e.type === "BlockedOn" &&
              e.callId === waiter.callId &&
              e.awaiting === waiter.awaiting,
          )
        )
          continue;
        transitions.push(
          effect({
            key: `aiko-channel-wiring:wait:${waiter.id}`,
            input: { id: waiter.id },
            act: () =>
              Effect.gen(function* () {
                const self = yield* scoped;
                if (
                  waiter.operationRef !== undefined &&
                  !(yield* Effect.promise(() =>
                    bindings.authorize(
                      owner,
                      String(waiter.authorityRef),
                      "connect",
                      waiter,
                    ),
                  ))
                ) {
                  yield* Effect.promise(() =>
                    transaction((current) => ({
                      events: at(current, "WaitCancelled", waiter.id)
                        ? []
                        : [
                            fact(owner, "WaitCancelled", String(waiter.id), {
                              status: "cancelled",
                              reason: "authority_revoked",
                            }),
                          ],
                      result: undefined,
                    })),
                  );
                  return [];
                }
                const ready = yield* Effect.promise(() =>
                  transaction((current) => {
                    const previous = at(current, "WaitReady", waiter.id);
                    if (previous) return { events: [], result: previous };
                    const terminal = sources(
                      current,
                      waiter.port as PortRef,
                    ).find((e) => {
                      if (
                        Number(e.sequence) <= Number(waiter.watermark) ||
                        Number(e.at) > Number(waiter.deadline) ||
                        e.correlation !== waiter.correlation ||
                        e.schema !== waiter.schema ||
                        !e.invocation ||
                        (waiter.invocation !== undefined &&
                          e.invocation !== waiter.invocation)
                      )
                        return false;
                      const claim = at(current, "Claimed", e.invocation);
                      return (
                        claim &&
                        equal((claim.wire as Wire).handler, waiter.handler) &&
                        at(current, "Settled", e.invocation)?.status ===
                          "satisfied"
                      );
                    });
                    const lostInput =
                      waiter.invocation !== undefined &&
                      at(current, "Settled", waiter.invocation)?.reason ===
                        "input_unavailable";
                    if (
                      !terminal &&
                      !lostInput &&
                      now() <= Number(waiter.deadline)
                    )
                      return { events: [], result: undefined };
                    const receipt = fact(
                      owner,
                      "WaitReady",
                      String(waiter.id),
                      {
                        result: terminal
                          ? {
                              status: "satisfied",
                              valueRef: terminal.valueRef,
                              correlation: terminal.correlation,
                              correlationRef: terminal.correlationRef,
                              invocation: terminal.invocation,
                            }
                          : { status: lostInput ? "unavailable" : "expired" },
                      },
                    );
                    return { events: [receipt], result: receipt };
                  }),
                );
                if (!ready) return [];
                const router = yield* Router;
                yield* router.send(
                  envelopeOf(linkOf(self, self), {
                    type: "MessageReceived",
                    id: waiter.awaiting,
                    at: 0,
                    source: "channel-waiter",
                    text: "Channel waiter ready",
                  }),
                );
                yield* Effect.promise(() =>
                  transaction((current) => ({
                    events: at(current, "WaitDelivered", waiter.id)
                      ? []
                      : [
                          fact(owner, "WaitDelivered", String(waiter.id), {
                            awaiting: waiter.awaiting,
                          }),
                        ],
                    result: undefined,
                  })),
                );
                return [];
              }),
          }),
        );
      }
      return { view: state, transitions };
    },
  });
  const doc = (description: string) => ({
    description,
    input: { type: "object" as const },
    output: {},
  });
  const pkg = definePackage({
    name: "channels",
    description:
      "Task-created managed hooks clean up on parent termination; explicit standing adoption requires a separately configured policy. Owner-scoped native internal typed channels. Binding identity is not receiving authority. No provider transport or implicit grants.",
    docs: {
      hooks: doc("Inspect owner-scoped managed hook identities, lifetime and child ports using authorityRef. No raw inputs or provider authority."),
      adopt: doc("Explicit owner-native adoption of an active task hook: execution, operationId, authorityRef, expiresAt. Requires a separately configured standing policy; never inherited by managed code. Existing IDs, pins and limits are preserved."),
      retireHook: doc("Revoke future admissions for a task or adopted hook: execution, operationId, authorityRef. Pending dispatch uncertainty is retained, never retried."),
      bind: doc(
        "Create a bounded internal port: name, schema, directions, authorityRef, operationId.",
      ),
      connect: doc(
        "Pin typed handler: name, generation, input, accepts, handler {harness,contract}, output {channel,generation,mode}, start, authorityRef, operationId.",
      ),
      emit: doc(
        "Accept typed data using explicit receiving authority: port, schema, value, occurrence, correlation, authorityRef. No event type or reply destination accepted.",
      ),
      wait: doc(
        "Durably await a checked terminal output: port, handler pin, schema, correlation, deadline, authorityRef. Native code parks until a matching trusted outcome or deadline wake.",
      ),
      request: doc(
        "Atomically register a reply waiter and admit its request before dispatch: operationId, send (emit arguments), reply (wait arguments). Correlations must match; one active matching pinned wiring is required. Parks the native continuation.",
      ),
      reconcile: doc(
        "Inspect an uncertain existing invocation; never blindly repeat a write. invocation, operationId, authorityRef.",
      ),
    },
    methods: {
      ...Object.fromEntries(
        Object.entries(api).map(([name, fn]) => [
          name,
          (raw: unknown, ctx: { callId: string }) =>
            Effect.gen(function* () {
              yield* scoped;
              if (
                cancelledCall(yield* Effect.promise(journal.read), ctx.callId)
              )
                return { status: "cancelled" };
              const args = yield* Effect.promise(() =>
                channelHydrate(
                  bindings.blobs,
                  owner,
                  (raw as any)?.privateInput,
                ),
              );
              const result = yield* (
                fn as (
                  args: unknown,
                  ctx: { callId: string },
                ) => Effect.Effect<unknown, Park, Self>
              )(args, ctx);
              return {
                privateResult: yield* Effect.promise(() =>
                  channelSeal(bindings.blobs, owner, result),
                ),
              };
            }),
        ]),
      ),
    },
  });
  const sandboxLayer = <R, E>(base: Layer.Layer<never, E, R>, management?: ChannelManagementBinding) =>
    Layer.effect(
      Sandbox,
      Effect.gen(function* () {
        const sandbox = yield* Sandbox;
        return {
          run: (code: string, supplied: Bindings, ambient: any) => {
            const scopedBindings: any = { ...supplied };
            if (supplied.channels && typeof supplied.channels === "object")
              scopedBindings.channels = Object.fromEntries(
                Object.entries(supplied.channels).map(([name, fn]) => [
                  name,
                  async (args: unknown, ordinal: number) => {
                    const managed = management ? await prepareChannelManagement(management, owner, ambient?.seed, ordinal, name, args, await journal.read()) : undefined;
                    if (managed) { args = managed.args; await managed.recheck(); }
                    const privateInput = await channelSeal(
                      bindings.blobs,
                      owner,
                      args,
                    );
                    const outcome = await (fn as any)(
                      { privateInput },
                      ordinal,
                    );
                    if (managed) await managed.recheck();
                    if (
                      outcome._tag === "Returned" &&
                      outcome.result?.privateResult
                    )
                      return {
                        ...outcome,
                        result: await channelHydrate(
                          bindings.blobs,
                          owner,
                          outcome.result.privateResult,
                        ),
                      };
                    return outcome;
                  },
                ]),
              );
            return sandbox.run(code, scopedBindings, ambient);
          },
        };
      }),
    ).pipe(Layer.provide(base));
  return {
    /** Trusted native consumer only. Never exposed in the sandbox package. */
    consume: (source: string, consumer: string) => transaction(rows => {
      const id = channelDigest([owner, source, consumer]);
      if (at(rows, "Consumed", id)) return { events: [], result: undefined };
      const input = at(rows, "Accepted", source);
      if (!input?.invocation || !rows.some(e => e.owner === owner && e.type === "AikoChannelWiringSettled" && e.invocation === input.invocation && e.status === "satisfied")) throw Error("checked_channel_output_required");
      return { events: [fact(owner, "Consumed", id, { source, consumer })], result: undefined };
    }),
    // Trusted source adapters prepare the existing admission and commit it with their cursor.
    prepareAdmission,
    /** Trusted factory initialization only; not included in channels package. */
    setAdoptionPolicy: (policy: ChannelWiringBindings["authorizeAdoption"]) => { adoptionPolicy = policy; },
    // The shared host gate calls this after private sealing, for ALL producers.
    authorizeBatch: async (events: readonly Event[]) => {
      for (const e of events) {
        const ports = e.type === "AikoChannelWiringAccepted" ? [e.port] : e.type === "AikoChannelWiringConnected" ? [(e.wire as Wire).input,(e.wire as Wire).output] : [];
        for (const port of ports) if (!await portAuthorized(port)) throw Error("channel_hook_closed");
      }
    },
    authorizeAdmission: checked,
    api,
    sandboxLayer,
    package: pkg,
    component: native,
    view: async () => channelWiringView(await journal.read(), owner),
  };
}

/** Feed into the host's existing native alarm calculation. There is no channel timer loop. */
export function channelWiringNextWake(
  events: readonly Event[],
  owner: string,
): number | undefined {
  const rows = own(events, owner);
  const deadlines = rows
    .filter(
      (e) =>
        e.type === "AikoChannelWiringWaitRegistered" &&
        !at(rows, "WaitReady", e.id) &&
        !at(rows, "WaitCancelled", e.id) &&
        !cancelledCall(events, e.callId),
    )
    .map((e) => Number(e.deadline) + 1);
  for (const g of hookLifetimes(events,owner)) {
    if (at(rows,"HookCleaned",hookCurrentCleanupId(rows,owner,g))) continue;
    const adopted = hookAdoption(events,owner,g);
    deadlines.push(Number(adopted?.expiresAt ?? g.deadline) + 1);
  }
  const runtimeAt=channelRuntimeNextWake(events,owner);
  if(runtimeAt!==undefined)deadlines.push(runtimeAt);
  return deadlines.length ? Math.min(...deadlines) : undefined;
}
