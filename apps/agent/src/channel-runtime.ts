import {
  channelControlState,
  controlOperationId,
  type ChannelControlPlan,
} from "./channel-controls.ts";
export { channelRuntimeNextWake } from "./channel-controls.ts";
import { Cause, Effect } from "effect";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog, withWatermark } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import {
  channelBindings,
  channelDigest,
  channelSameReceipt,
  channelEventKey,
  channelFact,
  channelId,
  validateChannelBinding,
  type ChannelBinding,
} from "./channel-bindings.ts";

export type ExternalObservation = {
  kind: "external";
  schemaVersion: string;
  text: string;
  contentRefs?: string[];
};
export type VerifiedIngress = {
  principal: string;
  occurrence: string;
  conversation: string;
  partition: string;
  ancestry: string[]; /** Trusted verification evidence reference, never provider-supplied authority. */
  evidence: string;
};
export type ChannelDelivery = {
  status: "accepted_by_provider" | "delivered" | "failed" | "unknown";
  evidence?: string;
  providerId?: string;
};
export type ChannelAdapterOperation =
  "decode" | "poll" | "send" | "reconcile" | "subscribe" | "remove" | "renew";
/** Root registry implements execute with its pinned, verified sandbox harness.
 * authenticate / authorize / artifactAllowed / validateReceipt are trusted host capabilities,
 * not callbacks selected from provider JSON or generated adapter output.
 */
export interface ChannelRuntimePorts {
  controlPolicy?(
    binding: ChannelBinding,
    plan: ChannelControlPlan,
  ): Promise<string | undefined>;
  activateIngress?(binding: ChannelBinding): Promise<{ bridge: string }>;
  openEvent?(event: Event): Promise<Event>;
  /** Hosted mode routes every receipt batch through one serialized host commit gate. */
  journal?: {
    read(): Promise<readonly Event[]>;
    append(events: Event[]): Promise<void>;
  };
  replyAllowed?(reply: { text: string; source?: unknown }): boolean;
  artifactAllowed(binding: ChannelBinding): Promise<boolean>;
  authorize(
    owner: string,
    authorization: string,
    operation: "bind" | "change" | "send",
    input: unknown,
  ): Promise<boolean>;
  authenticate(
    binding: ChannelBinding,
    request: Request,
    body: string,
  ): Promise<VerifiedIngress | undefined>;
  execute(
    binding: ChannelBinding,
    operation: ChannelAdapterOperation,
    input: unknown,
    key: string,
    signal: AbortSignal,
  ): Promise<unknown>;
  validateReceipt(
    binding: ChannelBinding,
    operation: ChannelAdapterOperation,
    result: unknown,
  ): Promise<boolean>;
  /** Must itself accept the stable key idempotently. No generated events are appended here. */
  handle(
    binding: ChannelBinding,
    observation: ExternalObservation,
    context: VerifiedIngress,
    key: string,
    signal: AbortSignal,
  ): Promise<{ receipt: string }>;
  now?: () => number;
}
const own = (log: readonly Event[], b: ChannelBinding) =>
  log.filter(
    (e) =>
      channelEventKey(e) &&
      e.owner === b.owner &&
      e.channel === b.id &&
      e.generation === b.generation,
  );
const find = (log: readonly Event[], type: string, id: string) =>
  log.find((e) => e.type === `AikoChannel${type}` && e.id === id);
const fact = (
  type: string,
  b: ChannelBinding,
  id: string,
  fields: Record<string, unknown> = {},
  fenced = false,
) =>
  channelFact(type, b, id, {
    ...fields,
    ...(fenced
      ? {
          fence: true,
          expectedStatus: b.status,
          expectedLifecycle: b.lifecycle ?? 0,
        }
      : {}),
  });
const safe = <T>(run: () => Promise<T>) =>
  Effect.promise(async () => {
    try {
      return await run();
    } catch {
      return undefined;
    }
  });
const observationOf = (
  raw: unknown,
  b: ChannelBinding,
): ExternalObservation | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) => !["kind", "schemaVersion", "text", "contentRefs"].includes(k),
    ) ||
    r.kind !== "external" ||
    typeof r.schemaVersion !== "string" ||
    !r.schemaVersion ||
    typeof r.text !== "string" ||
    new TextEncoder().encode(r.text).length > b.maxBytes ||
    (r.contentRefs !== undefined &&
      (!Array.isArray(r.contentRefs) ||
        r.contentRefs.length > 32 ||
        r.contentRefs.some(
          (s) => typeof s !== "string" || !s.startsWith(`content:${b.owner}:`),
        )))
  )
    return;
  return structuredClone(raw) as ExternalObservation;
};
const deliveryOf = (raw: unknown): ChannelDelivery | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) => !["status", "evidence", "providerId"].includes(k),
    ) ||
    !["accepted_by_provider", "delivered", "failed", "unknown"].includes(
      String(r.status),
    ) ||
    (r.status !== "unknown" &&
      (typeof r.evidence !== "string" || !r.evidence)) ||
    (r.providerId !== undefined && typeof r.providerId !== "string")
  )
    return;
  return structuredClone(raw) as ChannelDelivery;
};
type SubscriptionReceipt = {
  status: "ready" | "removed" | "renewed";
  evidence: string;
  subscriptionRef?: string;
  leaseExpiresAt?: number;
};
const subscriptionOf = (
  raw: unknown,
  operation: string,
  retiring = false,
): SubscriptionReceipt | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const r = raw as Record<string, unknown>,
    expected =
      operation === "remove" || retiring
        ? "removed"
        : operation === "renew"
          ? "renewed"
          : "ready";
  if (
    Object.keys(r).some(
      (k) =>
        !["status", "evidence", "subscriptionRef", "leaseExpiresAt"].includes(
          k,
        ),
    ) ||
    r.status !== expected ||
    (r.leaseExpiresAt !== undefined &&
      (!Number.isSafeInteger(r.leaseExpiresAt) ||
        Number(r.leaseExpiresAt) <= 0)) ||
    typeof r.evidence !== "string" ||
    !r.evidence ||
    (r.subscriptionRef !== undefined && typeof r.subscriptionRef !== "string")
  )
    return;
  return structuredClone(raw) as SubscriptionReceipt;
};
const validContext = (v: VerifiedIngress, b: ChannelBinding) =>
  v &&
  v.principal === b.source &&
  [v.occurrence, v.conversation, v.partition, v.evidence].every(
    (x) => typeof x === "string" && x.length > 0 && x.length <= 1024,
  ) &&
  Array.isArray(v.ancestry) &&
  v.ancestry.length < b.maxHops &&
  v.ancestry.every((x) => typeof x === "string" && x.length <= 1024);
export const channelOperationKey = (
  b: ChannelBinding,
  operation: string,
  id: string,
) =>
  channelDigest([
    b.owner,
    b.id,
    b.generation,
    b.artifact.digest,
    operation,
    id,
  ]);
const inputId = (v: VerifiedIngress) =>
  channelDigest([v.partition, v.occurrence]);

/** Log-derived inbox/outbox, including old generations for inspection/reconciliation. */
export function channelRuntimeView(log: readonly Event[], owner: string) {
  log = log.filter((e) => channelEventKey(e));
  return {
    bindings: [...channelBindings(log, owner).values()],
    inbox: log.filter(
      (e) =>
        e.owner === owner &&
        [
          "AikoChannelReceived",
          "AikoChannelInputAccepted",
          "AikoChannelInputRejected",
          "AikoChannelInputHandled",
        ].includes(e.type),
    ),
    outbox: log.filter(
      (e) =>
        e.owner === owner &&
        [
          "AikoChannelOutputPrepared",
          "AikoChannelOutputStarted",
          "AikoChannelOutputSettled",
          "AikoChannelReconcileSettled",
        ].includes(e.type),
    ),
    cursors: log.filter(
      (e) => e.owner === owner && e.type === "AikoChannelCursorAdvanced",
    ),
  };
}

/** Root integration (no host/server edits in this module):
 * 1. Install .component on user-OWNER; combine channelEventKey and
 *    channelAppendAllowed with existing host keys/commit guards. API EventLog
 *    appends MUST use the same serialized, atomic guard, then arm native recovery.
 *    Hosted mode uses channel-host.ts to serialize guard + native batch append;
 *    never expose unguarded host.seed as a channel ingress implementation.
 * 2. Bind Self/EventLog to the authenticated owner's thread. Resolve route/generation
 *    from channelBindings; never expose append/seed or these host receipt types to
 *    generic HTTP methods, provider JSON, generated code, or model tool arguments.
 * 3. Inject ports from the harness registry: verify exact artifact + contract
 *    attestation and current authorization; execute only its pinned sandbox adapter.
 *    Trusted receipt validation must independently validate provider evidence.
 *    Auth must exclude private-login traffic and retain only permitted provider data.
 * 4. HTTP calls ingest; ACK only its durable receipt. Map custody/backpressure errors
 *    to retryable responses, identity conflicts to 409, auth failure to 401/403.
 *    The body remains untrusted even after source authentication.
 * 5. handle invokes the known harness or mints a normalized MessageReceived through
 *    existing native ingress with its stable key. It must be idempotent; never append
 *    arbitrary adapter JSON. Reply routing calls prepare with the accepted binding's
 *    conversation/owner destination and originating authorization, not payload routes.
 * 6. Existing automation/alarm wiring calls requestPoll, requestSubscription and
 *    requestReconcile with stable trigger IDs. recover()/alarm() drives pending work.
 *    No timers, server creation, provider setup or real sends occur on module import.
 *
 * Policy limits: cancel queued work on upgrade/retire; paused work waits. Unknown
 * sends never retry. Failed receipts remain inspectable; automatic backoff, provider
 * challenge handling, encrypted retained-body storage/physical retention and media
 * capability acquisition belong to the host/registry integration, not this module.
 */
export function createChannelRuntime(
  owner: string,
  ports: ChannelRuntimePorts,
) {
  const now = ports.now ?? Date.now;
  const execute = async (
    b: ChannelBinding,
    op: ChannelAdapterOperation,
    input: unknown,
    id: string,
    signal: AbortSignal,
  ) => {
    if (
      !b.artifact.operations.includes(op) ||
      !(await ports.artifactAllowed(b))
    )
      throw new Error("channel_artifact_revoked");
    if (ports.journal && ["poll", "renew"].includes(op)) {
      const state = channelControlState(await ports.journal.read(), owner).find(
        (s) =>
          s.plan.channel === b.id &&
          s.plan.generation === b.generation &&
          s.p.action === op &&
          Array.from({ length: s.p.maxRuns }, (_, i) =>
            controlOperationId(s.plan, i),
          ).includes(id),
      );
      if (
        state &&
        (state.reason !== "pending" ||
          state.p.expiresAt <= now() ||
          (await ports.controlPolicy?.(b, state.p)) !== state.plan.policyDigest)
      )
        throw Error("channel_control_no_longer_authorized");
      if (state)
        signal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, state.p.expiresAt - now())),
        ]);
    }
    return ports.execute(b, op, input, channelOperationKey(b, op, id), signal);
  };
  const open = (e: Event) =>
    ports.openEvent ? ports.openEvent(e) : Promise.resolve(e);
  const scoped = Effect.gen(function* () {
    const self = yield* Self;
    if (self.actor !== "aiko" || self.thread !== `user-${owner}`)
      throw new Error("channel_owner_scope");
    const native = yield* EventLog;
    return ports.journal
      ? withWatermark({
          read: Effect.promise(() => ports.journal!.read()),
          append: (events) =>
            Effect.promise(() => ports.journal!.append([...events])),
        })
      : native;
  });
  const commit = (rows: readonly Event[]) =>
    Effect.gen(function* () {
      const log = yield* scoped;
      yield* log.append(rows);
      const after = yield* log.read;
      for (const row of rows) {
        const stored = after.find(
          (e) => channelEventKey(e) === channelEventKey(row),
        );
        const recorded = stored ? yield* safe(() => open(stored)) : undefined;
        if (!recorded || !channelSameReceipt(recorded, row))
          throw new Error("channel_commit_conflict");
      }
    });
  const binding = (id: string, generation?: number) =>
    Effect.gen(function* () {
      const log = yield* scoped;
      const b = channelBindings(yield* log.read, owner).get(id);
      if (!b || (generation !== undefined && b.generation !== generation))
        throw new Error("channel_generation");
      return b;
    });
  const api = {
    configure(input: Omit<ChannelBinding, "id" | "owner" | "status">) {
      return Effect.gen(function* () {
        const b: ChannelBinding = {
          ...structuredClone(input),
          id: channelId(owner, input.name),
          owner,
          status: "pending",
          lifecycle: 0,
        };
        validateChannelBinding(b);
        if (
          !(yield* safe(() =>
            ports.authorize(owner, b.authorization, "bind", b),
          )) ||
          !(yield* safe(() => ports.artifactAllowed(b)))
        )
          throw new Error("channel_not_authorized_or_verified");
        const log = yield* scoped;
        const events = yield* log.read;
        const previous = events.find(
          (e) =>
            e.type === "AikoChannelBindingIntent" &&
            e.channel === b.id &&
            e.generation === b.generation,
        );
        if (previous) {
          if (channelDigest(previous.binding) !== channelDigest(b))
            throw new Error("channel_binding_conflict");
          return b.id;
        }
        const prior = channelBindings(events, owner).get(b.id);
        if (b.generation !== (prior?.generation ?? 0) + 1)
          throw new Error("channel_generation");
        // An upgrade cannot orphan a remote subscription. Retire/clean it up first.
        if (
          prior?.artifact.operations.includes("subscribe") &&
          prior.status !== "retired"
        )
          throw new Error("channel_subscription_requires_retirement");
        yield* commit([
          fact("BindingIntent", b, String(b.generation), {
            binding: b,
            at: now(),
          }),
        ]);
        return b.id;
      });
    },
    arm(id: string, generation: number, bridge: string, authorization: string) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation),
          log = yield* scoped,
          rows = yield* log.read;
        if (
          !b.ingressBeforeSubscribe ||
          !(yield* safe(() =>
            ports.authorize(owner, authorization, "bind", b),
          )) ||
          !rows.some(
            (e) =>
              e.type === "AikoChannelBridgeBound" &&
              e.owner === owner &&
              e.id === bridge &&
              (e.bridge as any)?.external.channel === id &&
              (e.bridge as any)?.external.generation === generation,
          )
        )
          throw Error("channel_ingress_not_prepared");
        const previous = find(own(rows, b), "IngressArmed", String(generation));
        if (previous) {
          if (previous.bridge !== bridge)
            throw Error("channel_ingress_conflict");
          return;
        }
        if (b.status !== "pending") throw Error("channel_ingress_lifecycle");
        yield* commit([
          fact(
            "IngressArmed",
            b,
            String(generation),
            { bridge, at: now() },
            true,
          ),
        ]);
      });
    },
    change(
      id: string,
      generation: number,
      status: "paused" | "active" | "retiring",
      authorization: string,
      operationId: string,
    ) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation);
        if (
          !(yield* safe(() =>
            ports.authorize(owner, authorization, "change", {
              id,
              generation,
              status,
            }),
          ))
        )
          throw new Error("channel_not_authorized");
        const log = yield* scoped,
          prior = find(own(yield* log.read, b), "Lifecycle", operationId);
        if (prior) {
          if (prior.status !== status || prior.authorization !== authorization)
            throw new Error("channel_lifecycle_conflict");
          return;
        }
        if (!(
          (b.status === "pending" && status === "retiring") ||
          (b.status === "active" && ["paused", "retiring"].includes(status)) ||
          (b.status === "paused" && ["active", "retiring"].includes(status))
        ))
          throw new Error("channel_lifecycle");
        yield* commit([
          fact(
            "Lifecycle",
            b,
            operationId,
            { status, authorization, at: now() },
            true,
          ),
        ]);
      });
    },
    /** ACK only after authenticated raw input is durable. Decode and actor completion are separate receipts. */
    ingest(id: string, generation: number, request: Request) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation);
        const ingressLog = yield* scoped;
        const armed =
          b.ingressBeforeSubscribe &&
          find(
            own(yield* ingressLog.read, b),
            "IngressArmed",
            String(generation),
          );
        if (
          (b.status !== "active" && !(b.status === "pending" && armed)) ||
          !b.artifact.directions.includes("inbox")
        )
          throw new Error("channel_inactive");
        // Bound the stream before materializing it, including chunked requests.
        const body = yield* Effect.promise(async () => {
          const reader = request.body?.getReader();
          if (!reader) return "";
          let size = 0;
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              size += next.value.length;
              if (size > b.maxBytes) throw new Error("channel_payload_limit");
              chunks.push(next.value);
            }
          } finally {
            await reader.cancel();
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          return new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: false,
          }).decode(bytes);
        });
        const verified = yield* safe(() =>
          ports.authenticate(b, request, body),
        );
        if (!verified || !validContext(verified, b))
          throw new Error("channel_authentication");
        const log = yield* scoped,
          events = own(yield* log.read, b);
        const occurrenceId = inputId(verified),
          digest = channelDigest([
            body,
            verified.principal,
            verified.conversation,
            verified.partition,
            verified.ancestry,
          ]);
        const prior = find(events, "Received", occurrenceId);
        if (prior) {
          const retained = yield* safe(() => open(prior));
          if (!retained) throw new Error("channel_custody_unavailable");
          if (retained.digest !== digest)
            throw new Error("channel_occurrence_conflict");
          return {
            status: "received" as const,
            id: occurrenceId,
            duplicate: true,
          };
        }
        // Exact provider IDs suppress echoes; matching text alone never suppresses a legitimate reply.
        const echo = events.some(
          (e) =>
            [
              "AikoChannelOutputSettled",
              "AikoChannelReconcileSettled",
            ].includes(e.type) &&
            (e.result as ChannelDelivery)?.providerId === verified.occurrence &&
            verified.ancestry.includes(String(e.id)),
        );
        yield* commit([
          fact(
            "Received",
            b,
            occurrenceId,
            {
              body,
              digest,
              context: verified,
              artifact: b.artifact,
              at: now(),
              expiresAt: now() + b.retentionMs,
            },
            true,
          ),
          ...(echo
            ? [
                fact(
                  "InputRejected",
                  b,
                  occurrenceId,
                  { reason: "echo", at: now() },
                  true,
                ),
              ]
            : []),
        ]);
        return {
          status: "received" as const,
          id: occurrenceId,
          duplicate: false,
        };
      });
    },
    prepare(
      id: string,
      generation: number,
      input: {
        operationId: string;
        task: string;
        authorization: string;
        payload: string;
        conversation: string;
        replyTo?: string;
        ancestry: string[];
      },
    ) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation);
        if (b.status !== "active" || !b.artifact.directions.includes("outbox"))
          throw new Error("channel_no_send_permission");
        if (
          Object.keys(input).some(
            (k) =>
              ![
                "operationId",
                "task",
                "authorization",
                "payload",
                "conversation",
                "replyTo",
                "ancestry",
              ].includes(k),
          ) ||
          (input.replyTo !== undefined &&
            (typeof input.replyTo !== "string" ||
              input.replyTo.length > 1024)) ||
          ![
            input.operationId,
            input.task,
            input.authorization,
            input.conversation,
          ].every(
            (x) => typeof x === "string" && x.length > 0 && x.length <= 1024,
          ) ||
          typeof input.payload !== "string" ||
          new TextEncoder().encode(input.payload).length > b.maxBytes ||
          !Array.isArray(input.ancestry) ||
          input.ancestry.length >= b.maxHops ||
          input.ancestry.some((x) => typeof x !== "string")
        )
          throw new Error("channel_output_invalid");
        if (
          !(yield* safe(() =>
            ports.authorize(owner, input.authorization, "send", {
              ...input,
              destination: b.destination,
              artifact: b.artifact,
            }),
          ))
        )
          throw new Error("channel_not_authorized");
        const log = yield* scoped,
          events = own(yield* log.read, b);
        const digest = channelDigest(input),
          prior = find(events, "OutputPrepared", input.operationId);
        if (prior) {
          const retained = yield* safe(() => open(prior));
          if (!retained) throw new Error("channel_custody_unavailable");
          if (retained.digest !== digest)
            throw new Error("channel_operation_conflict");
          return String(prior.id);
        }
        yield* commit([
          fact(
            "OutputPrepared",
            b,
            input.operationId,
            {
              input: structuredClone(input),
              destination: b.destination,
              artifact: b.artifact,
              binding: b,
              digest,
              at: now(),
            },
            true,
          ),
        ]);
        return input.operationId;
      });
    },
    scheduleControl(id: string, generation: number, plan: ChannelControlPlan) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation),
          log = yield* scoped;
        const p = structuredClone(plan);
        if (
          !p ||
          Object.keys(p).sort().join(",") !==
            "action,backoffMs,expiresAt,firstAt,id,intervalMs,leaseLeadMs,maxRuns,partition" ||
          !/^[a-zA-Z0-9._:-]{1,160}$/.test(p.id) ||
          !["poll", "renew"].includes(p.action) ||
          !b.artifact.operations.includes(p.action) ||
          b.status !== "active" ||
          ![
            p.maxRuns,
            p.intervalMs,
            p.backoffMs,
            p.expiresAt,
            p.firstAt,
            p.leaseLeadMs,
          ].every(Number.isSafeInteger) ||
          p.maxRuns < 1 ||
          p.maxRuns > 16 ||
          p.intervalMs < 100 ||
          p.backoffMs < p.intervalMs ||
          p.backoffMs > 3600000 ||
          p.leaseLeadMs < 0 ||
          p.leaseLeadMs > 3600000 ||
          p.expiresAt <= now() ||
          p.expiresAt > now() + 86400000 ||
          p.firstAt >= p.expiresAt ||
          !p.partition
        )
          throw Error("channel_control_invalid");
        const digest = yield* safe(
          () => ports.controlPolicy?.(b, p) ?? Promise.resolve(undefined),
        );
        if (
          !digest ||
          !(yield* safe(() =>
            ports.authorize(owner, b.authorization, "change", {
              id,
              generation,
              operation: "schedule",
              plan: p,
            }),
          ))
        )
          throw Error("channel_control_denied");
        const events = yield* log.read,
          old = find(own(events, b), "ControlPlan", p.id);
        if (old) {
          if (
            channelDigest(old.plan) !== channelDigest(p) ||
            old.policyDigest !== digest
          )
            throw Error("channel_control_conflict");
          return p.id;
        }
        if (p.firstAt < now()) throw Error("channel_control_past_start");
        if (
          channelControlState(events, owner).some(
            (s) =>
              s.plan.channel === id &&
              s.plan.generation === generation &&
              s.p.action === p.action &&
              !["stopped", "exhausted", "retired"].includes(s.reason ?? ""),
          )
        )
          throw Error("channel_control_already_registered");
        if (p.action === "renew") {
          const prior = own(events, b).findLast(
            (e) =>
              [
                "AikoChannelSubscriptionSettled",
                "AikoChannelRenewSettled",
              ].includes(e.type) && e.status === "ready",
          );
          const receipt = prior?.receipt as SubscriptionReceipt | undefined;
          if (
            !receipt?.leaseExpiresAt ||
            receipt.leaseExpiresAt <= now() ||
            !(yield* safe(() =>
              ports.validateReceipt(
                b,
                prior!.type === "AikoChannelSubscriptionSettled"
                  ? "subscribe"
                  : "renew",
                receipt,
              ),
            ))
          )
            throw Error("channel_signed_lease_unavailable");
        }
        if (
          (yield* safe(
            () => ports.controlPolicy?.(b, p) ?? Promise.resolve(undefined),
          )) !== digest
        )
          throw Error("channel_control_revoked");
        yield* commit([
          fact(
            "ControlPlan",
            b,
            p.id,
            { plan: p, policyDigest: digest, at: now() },
            true,
          ),
        ]);
        return p.id;
      });
    },
    cancelControl(id: string, generation: number, planId: string) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation),
          log = yield* scoped;
        if (
          !(yield* safe(() =>
            ports.authorize(owner, b.authorization, "change", {
              id,
              generation,
              operation: "cancel-control",
            }),
          ))
        )
          throw Error("channel_control_denied");
        const rows = own(yield* log.read, b);
        if (!find(rows, "ControlPlan", planId))
          throw Error("channel_control_missing");
        if (!find(rows, "ControlStopped", planId))
          yield* commit([
            fact(
              "ControlStopped",
              b,
              planId,
              { reason: "owner_cancelled", at: now() },
              true,
            ),
          ]);
      });
    },
    requestPoll(
      id: string,
      generation: number,
      partition: string,
      operationId: string,
    ) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation);
        if (
          b.status !== "active" ||
          !b.artifact.operations.includes("poll") ||
          !partition ||
          !operationId
        )
          throw new Error("channel_poll_invalid");
        const log = yield* scoped,
          events = own(yield* log.read, b);
        const prior = find(events, "PollRequested", operationId);
        if (prior) {
          if (prior.partition !== partition)
            throw Error("channel_poll_identity_conflict");
          return;
        }
        if (
          !(yield* safe(() =>
            ports.authorize(owner, b.authorization, "change", {
              id,
              generation,
              operation: "poll",
              partition,
            }),
          ))
        )
          throw Error("channel_not_authorized");
        if (
          events.some(
            (e) =>
              e.type === "AikoChannelPollSettled" &&
              e.partition === partition &&
              e.status === "source_gap",
          )
        )
          throw Error("channel_poll_source_gap");
        const cursor =
          events
            .filter(
              (e) =>
                e.type === "AikoChannelCursorAdvanced" &&
                e.partition === partition,
            )
            .at(-1)?.cursor ?? null;
        yield* commit([
          fact(
            "PollRequested",
            b,
            operationId,
            { partition, cursor, at: now() },
            true,
          ),
        ]);
      });
    },
    requestSubscription(
      id: string,
      generation: number,
      operation: "renew" | "reconcile",
      operationId: string,
      authorization: string,
      originalRenewalId?: string,
    ) {
      return Effect.gen(function* () {
        const b = yield* binding(id, generation);
        if (
          !(yield* safe(() =>
            ports.authorize(owner, authorization, "change", {
              id,
              generation,
              operation,
            }),
          ))
        )
          throw new Error("channel_not_authorized");
        if (
          !b.artifact.operations.includes(operation) ||
          (operation === "renew"
            ? b.status !== "active"
            : !["pending", "retiring"].includes(b.status) &&
              !(b.status === "active" && originalRenewalId))
        )
          throw new Error("channel_subscription_operation");
        const log = yield* scoped;
        const rows = own(yield* log.read, b);
        if (
          originalRenewalId &&
          (operation !== "reconcile" ||
            !rows.some(
              (e) =>
                e.type === "AikoChannelRenewSettled" &&
                e.id === originalRenewalId &&
                e.status === "unknown",
            ) ||
            !rows.some(
              (e) =>
                e.type === "AikoChannelRenewRequested" &&
                e.id === originalRenewalId &&
                e.operation === "renew",
            ))
        )
          throw Error("channel_renewal_reconcile_scope");
        if (
          operation === "renew" &&
          rows.some(
            (e) =>
              e.type === "AikoChannelRenewSettled" &&
              e.status === "unknown" &&
              !rows.some(
                (r) =>
                  r.type === "AikoChannelRenewRequested" &&
                  r.originalRenewalId === e.id &&
                  rows.some(
                    (s) =>
                      s.type === "AikoChannelRenewSettled" &&
                      s.id === r.id &&
                      s.status === "ready",
                  ),
              ),
          )
        )
          throw Error("channel_renewal_requires_reconciliation");
        const existing = find(rows, "RenewRequested", operationId);
        if (
          existing &&
          (existing.operation !== operation ||
            existing.originalRenewalId !== originalRenewalId)
        )
          throw Error("channel_subscription_identity_conflict");
        if (!existing)
          yield* commit([
            fact(
              "RenewRequested",
              b,
              operationId,
              {
                operation,
                authorization,
                ...(originalRenewalId ? { originalRenewalId } : {}),
                at: now(),
              },
              true,
            ),
          ]);
      });
    },
    requestReconcile(
      id: string,
      generation: number,
      outputId: string,
      operationId: string,
    ) {
      return Effect.gen(function* () {
        const log = yield* scoped,
          events = yield* log.read;
        const prepared = events.find(
          (e) =>
            e.type === "AikoChannelOutputPrepared" &&
            e.owner === owner &&
            e.channel === id &&
            e.generation === generation &&
            e.id === outputId,
        );
        if (!prepared) throw new Error("channel_unknown_output");
        const b = prepared.binding as ChannelBinding;
        if (!b.artifact.operations.includes("reconcile"))
          throw new Error("channel_reconcile_unsupported");
        const result = own(events, b)
          .filter(
            (e) =>
              [
                "AikoChannelOutputSettled",
                "AikoChannelReconcileSettled",
              ].includes(e.type) &&
              (e.id === outputId || e.outputId === outputId),
          )
          .at(-1)?.result as ChannelDelivery | undefined;
        if (
          !result ||
          !["unknown", "accepted_by_provider"].includes(result.status)
        )
          throw new Error("channel_reconcile_not_pending");
        if (!find(own(events, b), "ReconcileRequested", operationId))
          yield* commit([
            fact("ReconcileRequested", b, operationId, {
              outputId,
              binding: b,
              at: now(),
            }),
          ]);
      });
    },
  };
  // Components never accept an event list from the sandbox. Only fixed receipt constructors below may append.
  const native = component({
    name: "aiko.channel-runtime",
    keys: { prefixes: ["aiko-channel:"], keyOf: channelEventKey },
    initial: () => [] as Event[],
    step: (s, e) =>
      channelEventKey(e) ||
      [
        "MessageReceived",
        "AikoReplyPrepared",
        "AlarmFired",
        "AikoChannelWiringCursor",
        "AikoChannelWiringAccepted",
        "AikoChannelBridgeBound",
      ].includes(e.type)
        ? [...s, e]
        : s,
    output: (events) => {
      const transitions: ReturnType<typeof effect<any, Self>>[] = [];
      const add = (
        type: string,
        b: ChannelBinding,
        id: string,
        work: (
          log: EventLog["Service"],
          signal: AbortSignal,
        ) => Effect.Effect<readonly Event[], never, EventLog | Self>,
        fenced = true,
        admission?: { anchor: string; attempt: number },
      ) => {
        const key = channelEventKey(
          fact(type, b, admission ? channelDigest([id, admission.anchor]) : id),
        )!;
        transitions.push(
          effect({
            key,
            input: { b, id },
            interrupts: (_input, e) =>
              fenced &&
              e.channel === b.id &&
              ["AikoChannelLifecycle", "AikoChannelBindingIntent"].includes(
                e.type,
              ),
            act: (_input, signal) =>
              Effect.gen(function* () {
                const log = yield* scoped,
                  current = channelBindings(yield* log.read, owner).get(b.id);
                if (
                  fenced &&
                  (current?.generation !== b.generation ||
                    current.status !== b.status ||
                    (current.lifecycle ?? 0) !== (b.lifecycle ?? 0))
                )
                  return [];
                const receipts = yield* work(log, signal);
                if (ports.journal && receipts.length) {
                  yield* commit(receipts).pipe(
                    Effect.catchCause((cause) =>
                      Effect.gen(function* () {
                        const error = Cause.squash(cause);
                        if (
                          !admission ||
                          !(error instanceof Error) ||
                          error.message !== "channel_bridge_backpressure"
                        )
                          return yield* Effect.failCause(cause);
                        // A lost append acknowledgement is not a failed admission.
                        const retained = own(yield* log.read, b);
                        if (find(retained, "PollSettled", id)) return;
                        yield* commit([
                          fact(
                            "PollAdmissionDeferred",
                            b,
                            channelDigest([id, admission.anchor]),
                            {
                              poll: id,
                              anchor: admission.anchor,
                              attempt: admission.attempt,
                              at: now(),
                            },
                            true,
                          ),
                        ]);
                      }),
                    ),
                  );
                  return [];
                }
                return receipts;
              }),
          }),
        );
      };
      for (const state of channelControlState(events, owner)) {
        if (
          state.reason === "pending" &&
          state.b &&
          state.p.expiresAt <= now()
        ) {
          const b = state.b;
          add("ControlStopped", b, state.p.id, () =>
            Effect.succeed([
              fact(
                "ControlStopped",
                b,
                state.p.id,
                { reason: "expired", at: now() },
                true,
              ),
            ]),
          );
        }
        if (
          state.reason ||
          !state.b ||
          (state.due! > now() && state.p.expiresAt > now())
        )
          continue;
        const { b, p, plan, ordinal } = state,
          id = controlOperationId(plan, ordinal);
        add("ControlTick", b, id, () =>
          Effect.gen(function* () {
            const log = yield* scoped,
              fresh = channelControlState(yield* log.read, owner).find(
                (s) =>
                  s.plan.id === plan.id &&
                  s.plan.channel === b.id &&
                  s.plan.generation === b.generation,
              );
            if (!fresh || fresh.reason || fresh.ordinal !== ordinal) return [];
            const stop = (reason: string) => [
              fact("ControlStopped", b, p.id, { reason, at: now() }, true),
            ];
            if (p.expiresAt <= now()) return stop("expired");
            if (
              (yield* safe(
                () => ports.controlPolicy?.(b, p) ?? Promise.resolve(undefined),
              )) !== plan.policyDigest
            )
              return stop("current_policy_denied");
            try {
              if (p.action === "poll")
                yield* api.requestPoll(b.id, b.generation, p.partition, id);
              else
                yield* api.requestSubscription(
                  b.id,
                  b.generation,
                  "renew",
                  id,
                  b.authorization,
                );
            } catch {
              return stop("control_unavailable");
            }
            return [
              fact(
                "ControlTick",
                b,
                id,
                { plan: p.id, ordinal, at: now() },
                true,
              ),
            ];
          }),
        );
      }
      // Reuse the actor's respond -> voice preparation path. Payload-supplied routing
      // is never consulted: both accepted input and the host-minted turn must agree.
      for (const reply of events.filter(
        (e) => e.type === "AikoReplyPrepared",
      )) {
        const message = events.find(
          (e) =>
            e.type === "MessageReceived" &&
            e.id === reply.turn &&
            e.source === "channel",
        );
        if (!message) continue;
        const b = channelBindings(events, owner).get(
          String(message.channelBinding),
        );
        if (
          !b ||
          b.generation !== message.channelGeneration ||
          b.status !== "active" ||
          !b.artifact.directions.includes("outbox")
        )
          continue;
        const rows = own(events, b),
          accepted = find(rows, "InputAccepted", String(message.channelInput));
        if (
          !accepted ||
          message.id !== channelOperationKey(b, "handle", String(accepted.id))
        )
          continue;
        const id = `reply:${accepted.id}:${Number(reply.epoch ?? 0)}`;
        if (find(rows, "OutputPrepared", id) || find(rows, "OutputSettled", id))
          continue;
        const rendered = reply.result as { text?: unknown; source?: unknown };
        if (typeof rendered?.text !== "string" || !rendered.text.trim())
          continue;
        if (
          ports.replyAllowed &&
          !ports.replyAllowed({ text: rendered.text, source: rendered.source })
        ) {
          add("OutputSettled", b, id, () =>
            Effect.succeed([
              fact("OutputSettled", b, id, {
                result: { status: "failed", evidence: "host:voice_policy" },
                at: now(),
              }),
            ]),
          );
          continue;
        }
        if (
          accepted.context &&
          (accepted.context as VerifiedIngress).ancestry.length + 1 >= b.maxHops
        ) {
          add("OutputSettled", b, id, () =>
            Effect.succeed([
              fact("OutputSettled", b, id, {
                result: { status: "failed", evidence: "host:hop_limit" },
                at: now(),
              }),
            ]),
          );
          continue;
        }
        add("OutputPrepared", b, id, () =>
          Effect.gen(function* () {
            const hydrated = yield* safe(() => open(accepted));
            if (!hydrated)
              return [
                fact("OutputSettled", b, id, {
                  result: {
                    status: "unknown",
                    evidence: "host:input_unavailable",
                  },
                  at: now(),
                }),
              ];
            const context = hydrated.context as VerifiedIngress;
            if (context.ancestry.length + 1 >= b.maxHops)
              return [
                fact("OutputSettled", b, id, {
                  result: { status: "failed", evidence: "host:hop_limit" },
                  at: now(),
                }),
              ];
            yield* api.prepare(b.id, b.generation, {
              operationId: id,
              task: String(message.id),
              authorization: b.authorization,
              payload: rendered.text as string,
              conversation: context.conversation,
              replyTo: context.occurrence,
              ancestry: [...context.ancestry, id],
            });
            return [];
          }),
        );
      }
      for (const b of channelBindings(events, owner).values()) {
        const rows = own(events, b);
        if (
          b.status === "pending" &&
          b.ingressBeforeSubscribe &&
          !find(rows, "IngressArmed", String(b.generation))
        ) {
          if (b.providerBridge && ports.activateIngress)
            add("IngressArmed", b, String(b.generation), () =>
              Effect.gen(function* () {
                const armed = yield* safe(() => ports.activateIngress!(b));
                if (armed)
                  yield* api.arm(
                    b.id,
                    b.generation,
                    armed.bridge,
                    b.authorization,
                  );
                return [];
              }),
            );
          continue;
        }
        if (b.status === "pending" || b.status === "retiring") {
          const retiring = b.status === "retiring",
            op = retiring ? "remove" : "subscribe",
            id = `${op}:${b.generation}`;
          const settled = find(rows, "SubscriptionSettled", id);
          if (!settled)
            add("SubscriptionSettled", b, id, (log, signal) =>
              Effect.gen(function* () {
                let ready = !b.artifact.operations.includes(op),
                  result: unknown = { status: "local" };
                const prior = find(
                  own(yield* log.read, b),
                  "SubscriptionStarted",
                  id,
                );
                if (
                  !ready &&
                  !prior &&
                  (yield* safe(() =>
                    ports.authorize(
                      owner,
                      b.authorization,
                      retiring ? "change" : "bind",
                      b,
                    ),
                  ))
                ) {
                  yield* commit([
                    fact(
                      "SubscriptionStarted",
                      b,
                      id,
                      { operation: op, at: now() },
                      true,
                    ),
                  ]);
                  result = yield* safe(() =>
                    execute(b, op, { operationId: id }, id, signal),
                  );
                  const receipt = subscriptionOf(result, op);
                  ready =
                    receipt !== undefined &&
                    (yield* safe(() =>
                      ports.validateReceipt(b, op, receipt),
                    )) === true;
                  result = receipt;
                }
                // Crash after remote mutation needs operator/provider reconciliation; never create twice.
                return [
                  fact(
                    "SubscriptionSettled",
                    b,
                    id,
                    {
                      status: ready ? "ready" : "unknown",
                      ...(ready ? { receipt: result } : {}),
                      at: now(),
                    },
                    true,
                  ),
                  ...(ready
                    ? [
                        retiring
                          ? fact(
                              "Lifecycle",
                              b,
                              `retired:${b.generation}`,
                              { status: "retired", at: now() },
                              true,
                            )
                          : fact(
                              "BindingReady",
                              b,
                              String(b.generation),
                              { at: now() },
                              true,
                            ),
                      ]
                    : []),
                ];
              }),
            );
        }
        for (const request of rows.filter(
          (e) =>
            e.type === "AikoChannelRenewRequested" &&
            !find(rows, "RenewSettled", String(e.id)),
        )) {
          add("RenewSettled", b, String(request.id), (log, signal) =>
            Effect.gen(function* () {
              const op = request.operation as "renew" | "reconcile";
              const startedId = `renew:${request.id}`,
                prior = find(
                  own(yield* log.read, b),
                  "SubscriptionStarted",
                  startedId,
                );
              let raw: unknown;
              if (
                (op === "reconcile" || !prior) &&
                (yield* safe(() =>
                  ports.authorize(
                    owner,
                    String(request.authorization),
                    "change",
                    {
                      id: b.id,
                      generation: b.generation,
                      operation: op,
                    },
                  ),
                ))
              ) {
                if (op === "renew")
                  yield* commit([
                    fact(
                      "SubscriptionStarted",
                      b,
                      startedId,
                      { operation: op, at: now() },
                      true,
                    ),
                  ]);
                raw = yield* safe(() =>
                  execute(
                    b,
                    op,
                    {
                      kind: "subscription",
                      operationId: request.originalRenewalId
                        ? channelOperationKey(
                            b,
                            "renew",
                            String(request.originalRenewalId),
                          )
                        : channelOperationKey(
                            b,
                            b.status === "retiring" ? "remove" : "subscribe",
                            `${b.status === "retiring" ? "remove" : "subscribe"}:${b.generation}`,
                          ),
                      ...(request.originalRenewalId
                        ? { originalOperation: "renew" }
                        : {}),
                    },
                    String(request.id),
                    signal,
                  ),
                );
              }
              const receipt = subscriptionOf(
                raw,
                request.originalRenewalId ? "renew" : op,
                b.status === "retiring",
              );
              const verified =
                receipt !== undefined &&
                (yield* safe(() => ports.validateReceipt(b, op, receipt))) ===
                  true;
              return [
                fact(
                  "RenewSettled",
                  b,
                  String(request.id),
                  {
                    status: verified ? "ready" : "unknown",
                    ...(verified ? { receipt } : {}),
                    at: now(),
                  },
                  true,
                ),
                ...(verified && op === "reconcile" && !request.originalRenewalId
                  ? [
                      b.status === "retiring"
                        ? fact(
                            "Lifecycle",
                            b,
                            `retired:${b.generation}`,
                            { status: "retired", at: now() },
                            true,
                          )
                        : fact(
                            "BindingReady",
                            b,
                            String(b.generation),
                            { at: now() },
                            true,
                          ),
                    ]
                  : []),
              ];
            }),
          );
        }
        if (b.status !== "active") continue;
        for (const rawInput of rows.filter(
          (e) =>
            e.type === "AikoChannelReceived" &&
            !find(rows, "InputAccepted", String(e.id)) &&
            !find(rows, "InputRejected", String(e.id)),
        )) {
          add("InputAccepted", b, String(rawInput.id), (_log, signal) =>
            Effect.gen(function* () {
              const input = yield* safe(() => open(rawInput));
              if (!input)
                return [
                  fact(
                    "InputRejected",
                    b,
                    String(rawInput.id),
                    { reason: "input_unavailable", at: now() },
                    true,
                  ),
                ];
              const raw =
                Number(input.expiresAt) <= now()
                  ? undefined
                  : yield* safe(() =>
                      execute(
                        b,
                        "decode",
                        { body: input.body, context: input.context },
                        String(input.id),
                        signal,
                      ),
                    );
              const observation = observationOf(raw, b);
              return [
                observation
                  ? fact(
                      "InputAccepted",
                      b,
                      String(input.id),
                      {
                        observation,
                        context: input.context,
                        artifact: input.artifact,
                        at: now(),
                      },
                      true,
                    )
                  : fact(
                      "InputRejected",
                      b,
                      String(input.id),
                      {
                        reason:
                          Number(input.expiresAt) <= now()
                            ? "expired"
                            : "decode_invalid",
                        at: now(),
                      },
                      true,
                    ),
              ];
            }),
          );
        }
        for (const rawAccepted of rows.filter(
          (e) =>
            e.type === "AikoChannelInputAccepted" &&
            !find(rows, "InputHandled", String(e.id)) &&
            !find(rows, "InputRejected", String(e.id)),
        )) {
          add("InputHandled", b, String(rawAccepted.id), (_log, signal) =>
            Effect.gen(function* () {
              const accepted = yield* safe(() => open(rawAccepted));
              if (!accepted)
                return [
                  fact(
                    "InputRejected",
                    b,
                    String(rawAccepted.id),
                    { reason: "input_unavailable", at: now() },
                    true,
                  ),
                ];
              const receipt = yield* safe(() =>
                ports.handle(
                  b,
                  accepted.observation as ExternalObservation,
                  accepted.context as VerifiedIngress,
                  channelOperationKey(b, "handle", String(accepted.id)),
                  signal,
                ),
              );
              return [
                fact(
                  "InputHandled",
                  b,
                  String(accepted.id),
                  {
                    status:
                      receipt &&
                      typeof receipt.receipt === "string" &&
                      receipt.receipt
                        ? "handled"
                        : "failed",
                    ...(receipt?.receipt ? { receipt: receipt.receipt } : {}),
                    at: now(),
                  },
                  true,
                ),
              ];
            }),
          );
        }
        for (const poll of rows.filter(
          (e) =>
            e.type === "AikoChannelPollRequested" &&
            !find(rows, "PollSettled", String(e.id)),
        )) {
          if (!find(rows, "PollFetched", String(poll.id))) {
            add("PollFetched", b, String(poll.id), (_log, signal) =>
              Effect.gen(function* () {
                const raw = yield* safe(() =>
                  execute(
                    b,
                    "poll",
                    {
                      cursor: poll.cursor,
                      partition: poll.partition,
                      limit: b.backlog,
                    },
                    String(poll.id),
                    signal,
                  ),
                );
                return [
                  fact(
                    "PollFetched",
                    b,
                    String(poll.id),
                    { batch: raw ?? null, at: now() },
                    true,
                  ),
                ];
              }),
            );
            continue;
          }
          // Consumer progress changes only the admission effect identity. The physical
          // fetch, private batch and source cursor keep the original poll identity.
          const bridge = events.findLast(
            (e) =>
              e.type === "AikoChannelBridgeBound" &&
              e.owner === owner &&
              (e.bridge as any)?.external?.channel === b.id &&
              (e.bridge as any)?.external?.generation === b.generation,
          );
          const input = (bridge?.bridge as any)?.input as
            { channel: string; generation: number } | undefined;
          const sources = new Set(
            events
              .filter(
                (e) =>
                  e.type === "AikoChannelWiringAccepted" &&
                  e.owner === owner &&
                  (e.port as any)?.channel === input?.channel &&
                  (e.port as any)?.generation === input?.generation,
              )
              .map((e) => e.id),
          );
          const scheduled = channelControlState(events, owner).find(
            (s) =>
              s.plan.channel === b.id &&
              s.plan.generation === b.generation &&
              s.p.action === "poll" &&
              Array.from({ length: s.p.maxRuns }, (_, i) =>
                controlOperationId(s.plan, i),
              ).includes(String(poll.id)),
          );
          const expired =
            now() >=
            Math.min(
              Number(poll.at) + b.retentionMs,
              scheduled?.p.expiresAt ?? Infinity,
            );
          const anchor = channelDigest([
            b.lifecycle ?? 0,
            expired,
            scheduled?.reason ?? null,
            events
              .filter(
                (e) =>
                  e.type === "AikoChannelWiringCursor" &&
                  e.owner === owner &&
                  sources.has(e.source),
              )
              .map((e) => e.id),
          ]);
          const deferred = rows.filter(
            (e) =>
              e.type === "AikoChannelPollAdmissionDeferred" &&
              e.poll === poll.id,
          );
          if (deferred.some((e) => e.anchor === anchor)) continue;
          add(
            "PollSettled",
            b,
            String(poll.id),
            (log, signal) =>
              Effect.gen(function* () {
                const all = yield* log.read,
                  current = own(all, b);
                const control = channelControlState(all, owner).find(
                  (s) =>
                    s.plan.channel === b.id &&
                    s.plan.generation === b.generation &&
                    s.p.action === "poll" &&
                    Array.from({ length: s.p.maxRuns }, (_, i) =>
                      controlOperationId(s.plan, i),
                    ).includes(String(poll.id)),
                );
                const deadline = Math.min(
                  Number(poll.at) + b.retentionMs,
                  control?.p.expiresAt ?? Infinity,
                );
                if (
                  now() >= deadline ||
                  deferred.length >= 64 ||
                  (control &&
                    (control.reason !== "pending" ||
                      (yield* safe(
                        () =>
                          ports.controlPolicy?.(b, control.p) ??
                          Promise.resolve(undefined),
                      )) !== control.plan.policyDigest)) ||
                  !(yield* safe(() => ports.artifactAllowed(b))) ||
                  !(yield* safe(() =>
                    ports.authorize(owner, b.authorization, "change", {
                      id: b.id,
                      generation: b.generation,
                      operation: "poll",
                      partition: poll.partition,
                    }),
                  ))
                )
                  return [
                    fact(
                      "PollSettled",
                      b,
                      String(poll.id),
                      { status: "admission_unavailable", at: now() },
                      true,
                    ),
                  ];
                const cursor =
                  current
                    .filter(
                      (e) =>
                        e.type === "AikoChannelCursorAdvanced" &&
                        e.partition === poll.partition,
                    )
                    .at(-1)?.cursor ?? null;
                if (cursor !== poll.cursor)
                  return [
                    fact(
                      "PollSettled",
                      b,
                      String(poll.id),
                      { status: "stale_cursor", at: now() },
                      true,
                    ),
                  ];
                const fetched = find(current, "PollFetched", String(poll.id))!;
                const raw = (yield* safe(() => open(fetched)))?.batch;
                const batch = raw as
                  | {
                      status?: string;
                      previous?: unknown;
                      cursor?: unknown;
                      items?: {
                        context: VerifiedIngress;
                        observation: unknown;
                      }[];
                    }
                  | undefined;
                if (
                  !batch ||
                  typeof batch.cursor !== "string" ||
                  !Array.isArray(batch.items) ||
                  batch.items.length > b.backlog ||
                  !(yield* safe(() => ports.validateReceipt(b, "poll", batch)))
                )
                  return [
                    fact(
                      "PollSettled",
                      b,
                      String(poll.id),
                      { status: "invalid_batch", at: now() },
                      true,
                    ),
                  ];
                if (batch.status === "gap")
                  return [
                    fact(
                      "PollSettled",
                      b,
                      String(poll.id),
                      {
                        status: "source_gap",
                        partition: poll.partition,
                        at: now(),
                      },
                      true,
                    ),
                  ];
                if (batch.previous !== undefined && batch.previous !== cursor)
                  return [
                    fact(
                      "PollSettled",
                      b,
                      String(poll.id),
                      {
                        status: "source_gap",
                        partition: poll.partition,
                        at: now(),
                      },
                      true,
                    ),
                  ];
                const result: Event[] = [];
                for (const item of batch.items) {
                  if (
                    !validContext(item.context, b) ||
                    item.context.partition !== poll.partition
                  )
                    return [
                      fact(
                        "PollSettled",
                        b,
                        String(poll.id),
                        { status: "invalid_context", at: now() },
                        true,
                      ),
                    ];
                  const id = inputId(item.context),
                    digest = channelDigest(item.observation),
                    prior = find([...current, ...result], "Received", id);
                  if (prior) {
                    const retained = yield* safe(() => open(prior));
                    if (!retained || retained.digest !== digest)
                      return [
                        fact(
                          "PollSettled",
                          b,
                          String(poll.id),
                          { status: "occurrence_conflict", at: now() },
                          true,
                        ),
                      ];
                    continue;
                  }
                  const observation = observationOf(item.observation, b);
                  result.push(
                    fact(
                      "Received",
                      b,
                      id,
                      {
                        digest,
                        sourceRequiresBridge: !!b.providerPolicyDigest,
                        context: item.context,
                        artifact: b.artifact,
                        at: now(),
                        expiresAt: now() + b.retentionMs,
                      },
                      true,
                    ),
                  );
                  result.push(
                    observation
                      ? fact(
                          "InputAccepted",
                          b,
                          id,
                          {
                            observation,
                            context: item.context,
                            artifact: b.artifact,
                            at: now(),
                          },
                          true,
                        )
                      : fact(
                          "InputRejected",
                          b,
                          id,
                          { reason: "schema_invalid", at: now() },
                          true,
                        ),
                  );
                }
                // One native append transaction: cursor can never outrun durable item outcomes.
                return [
                  ...result,
                  fact(
                    "CursorAdvanced",
                    b,
                    String(poll.id),
                    {
                      cursor: batch.cursor,
                      previous: cursor,
                      partition: poll.partition,
                      at: now(),
                    },
                    true,
                  ),
                  fact(
                    "PollSettled",
                    b,
                    String(poll.id),
                    { status: "accepted", at: now() },
                    true,
                  ),
                ];
              }),
            true,
            { anchor, attempt: deferred.length + 1 },
          );
        }
      }
      for (const input of events.filter(
        (e) =>
          e.owner === owner &&
          e.type === "AikoChannelReceived" &&
          channelEventKey(e),
      )) {
        const intent = events.find(
          (e) =>
            e.type === "AikoChannelBindingIntent" &&
            e.owner === owner &&
            e.channel === input.channel &&
            e.generation === input.generation,
        );
        if (!intent) continue;
        const b = intent.binding as ChannelBinding,
          rows = own(events, b),
          current = channelBindings(events, owner).get(b.id);
        if (
          find(rows, "InputHandled", String(input.id)) ||
          find(rows, "InputRejected", String(input.id))
        )
          continue;
        if (
          current?.generation === b.generation &&
          !["retiring", "retired"].includes(current.status)
        )
          continue;
        add(
          "InputRejected",
          b,
          String(input.id),
          () =>
            Effect.succeed([
              fact("InputRejected", b, String(input.id), {
                reason: "generation_cancelled",
                at: now(),
              }),
            ]),
          false,
        );
      }
      // Old dispatched generations still reconcile; upgrades cancel only undispatched work.
      for (const rawPrepared of events.filter(
        (e) =>
          e.owner === owner &&
          e.type === "AikoChannelOutputPrepared" &&
          channelEventKey(e),
      )) {
        const b = rawPrepared.binding as ChannelBinding,
          rows = own(events, b),
          id = String(rawPrepared.id),
          started = find(rows, "OutputStarted", id);
        if (find(rows, "OutputSettled", id)) continue;
        const current = channelBindings(events, owner).get(b.id),
          active =
            current?.generation === b.generation && current.status === "active";
        if (
          !active &&
          !started &&
          current?.generation === b.generation &&
          current.status === "paused"
        )
          continue;
        add(
          "OutputSettled",
          b,
          id,
          (log, signal) =>
            Effect.gen(function* () {
              const prepared = yield* safe(() => open(rawPrepared));
              if (!prepared)
                return [
                  fact("OutputSettled", b, id, {
                    result: {
                      status: "unknown",
                      evidence: "host:output_unavailable",
                    },
                    at: now(),
                  }),
                ];
              let result: ChannelDelivery = { status: "unknown" };
              if (!active && !started)
                result = {
                  status: "failed",
                  evidence: "host:generation_cancelled",
                };
              else if (!find(own(yield* log.read, b), "OutputStarted", id)) {
                if (
                  !(yield* safe(() => ports.artifactAllowed(b))) ||
                  !(yield* safe(() =>
                    ports.authorize(
                      owner,
                      String((prepared.input as any).authorization),
                      "send",
                      {
                        ...(prepared.input as object),
                        destination: prepared.destination,
                        artifact: prepared.artifact,
                      },
                    ),
                  ))
                )
                  result = {
                    status: "failed",
                    evidence: "host:authorization_revoked",
                  };
                else {
                  yield* commit([
                    fact(
                      "OutputStarted",
                      { ...b, lifecycle: current?.lifecycle },
                      id,
                      { at: now() },
                      true,
                    ),
                  ]);
                  const raw = yield* safe(() =>
                    execute(
                      b,
                      "send",
                      {
                        ...(prepared.input as object),
                        destination: prepared.destination,
                      },
                      id,
                      signal,
                    ),
                  );
                  const decoded = deliveryOf(raw);
                  if (
                    decoded &&
                    (yield* safe(() =>
                      ports.validateReceipt(b, "send", decoded),
                    ))
                  )
                    result = decoded;
                }
              }
              return [fact("OutputSettled", b, id, { result, at: now() })];
            }),
          false,
        );
      }
      for (const request of events.filter(
        (e) =>
          e.owner === owner &&
          e.type === "AikoChannelReconcileRequested" &&
          channelEventKey(e),
      )) {
        const b = request.binding as ChannelBinding,
          rows = own(events, b),
          id = String(request.id);
        if (find(rows, "ReconcileSettled", id)) continue;
        add(
          "ReconcileSettled",
          b,
          id,
          (_log, signal) =>
            Effect.gen(function* () {
              const raw = yield* safe(() =>
                  execute(
                    b,
                    "reconcile",
                    {
                      operationId: channelOperationKey(
                        b,
                        "send",
                        String(request.outputId),
                      ),
                    },
                    id,
                    signal,
                  ),
                ),
                decoded = deliveryOf(raw);
              const result =
                decoded &&
                (yield* safe(() =>
                  ports.validateReceipt(b, "reconcile", decoded),
                ))
                  ? decoded
                  : { status: "unknown" };
              return [
                fact("ReconcileSettled", b, id, {
                  outputId: request.outputId,
                  result,
                  at: now(),
                }),
              ];
            }),
          false,
        );
      }
      return { view: channelRuntimeView(events, owner), transitions };
    },
  });
  return { ...api, component: native };
}
