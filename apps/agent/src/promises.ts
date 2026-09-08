import { Effect } from "effect";
import { boundedText } from "./security.ts";
import { createHash } from "node:crypto";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import {
  ApprovalError,
  canonical,
  hash as approvalHash,
} from "./action-approval.ts";
import type { CodeSegment } from "./code-sandbox-protocol.ts";
import { CODE_SEGMENT_MAX_BYTES } from "./code-sandbox-protocol.ts";

/**
 * Promises: prepared executions resolved by approval, time or journal hooks.
 * The model prepares and cancels; only the host resolves and executes. The
 * record, consent fencing and honest-unknown semantics extend
 * action-approval.ts; hooks close the loop with the automation event plane.
 */

export const PROMISE_HOOK_EVENTS = [
  "AikoHookReceived",
  "AikoApiObserved",
  "AikoPromiseSettled",
] as const;
export type PromiseHookEvent = (typeof PROMISE_HOOK_EVENTS)[number];

export type PromisePayload = { kind: "harness"; segment: CodeSegment };

export type ResolveWhen =
  | { kind: "approval" }
  | { kind: "at"; at: number }
  | { kind: "hook"; eventType: PromiseHookEvent; cooldownMs?: number };

export type PromiseState =
  | "pending"
  | "resolved"
  | "dispatching"
  | "settled"
  | "unknown"
  | "rejected"
  | "expired"
  | "cancelled";

export interface PromiseRecord {
  readonly id: string;
  readonly owner: string;
  readonly thread: string;
  readonly payload: PromisePayload;
  readonly when: ResolveWhen;
  readonly label: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly hash: string;
  readonly state: PromiseState;
  readonly version: number;
  readonly token: string;
  readonly outcome?: "succeeded" | "failed";
  readonly reason?: string;
  readonly resultSummary?: string;
  readonly lastHookAt?: number;
  readonly sourceTurn?: string;
  /** Present only for the native continuation protocol; legacy dispatches stay unknown. */
  readonly execution?: { version: 1; turn: string };
}

type Transition = Event & {
  type: "AikoPromiseTransition";
  owner: string;
  thread: string;
  id: string;
  previous: number;
  snapshot: PromiseRecord;
};

export const MAX_PENDING_PROMISES = 16;
export const PROMISE_MAX_TTL_MS = 30 * 86400_000;
export const PROMISE_MAX_CODE_CHARS = 48_000;
const PROMISE_MAX_LABEL = 80;

// Keys must be unique per journal event: the host's keyed append absorbs
// duplicates, so reusing `aiko-promise:<id>` across transition versions would
// silently drop every transition after the first.
export const promiseEventKey = (e: Event): string | undefined => {
  if (e.type === "AikoPromiseTransition" && typeof e.id === "string")
    return `aiko-promise:t:${JSON.stringify([e.owner, e.thread, e.id, (e as Transition).previous ?? 0])}`;
  if (e.type === "AikoPromiseTick" && typeof e.id === "string")
    return `aiko-promise:tick:${e.id}`;
  if (e.type === "AikoPromiseSettled" && typeof e.id === "string")
    return `aiko-promise:receipt:${e.id}`;
  if (
    (e.type === "AikoAutomationSignal" ||
      PROMISE_HOOK_EVENTS.includes(e.type as PromiseHookEvent)) &&
    typeof e.id === "string"
  )
    // Wake the component so the step can resolve hook-conditioned promises.
    return `aiko-promise:drive:${e.type}:${e.id}`;
  return undefined;
};

const labelOf = (payload: PromisePayload): string => {
  const first = String(payload.segment.code ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (first ?? "harness").slice(0, PROMISE_MAX_LABEL);
};

function project(records: Map<string, PromiseRecord>, e: Transition) {
  if (e.owner !== e.snapshot?.owner || e.thread !== e.snapshot?.thread || e.id !== e.snapshot?.id) return;
  const prior = records.get(e.id);
  if (e.previous !== (prior?.version ?? 0) || e.snapshot.version !== e.previous + 1)
    return;
  if (prior) {
    // Frozen fields must carry through unchanged; only lifecycle fields may move.
    const frozen = (r: PromiseRecord) =>
      canonical({
        payload: r.payload,
        when: r.when,
        hash: r.hash,
        createdAt: r.createdAt,
        owner: r.owner, thread: r.thread, id: r.id, expiresAt: r.expiresAt, sourceTurn: r.sourceTurn ?? null,
      });
    if (frozen(prior) !== frozen(e.snapshot)) return;
  } else if (e.snapshot.state !== "pending") return;
  records.set(e.id, e.snapshot);
}

export function promiseState(log: readonly Event[]) {
  const records = new Map<string, PromiseRecord>();
  for (const e of log)
    if (e.type === "AikoPromiseTransition") project(records, e as Transition);
  // Callers must not mutate journal-owned consent through a returned record.
  return { records: new Map([...records].map(([id, record]) => [id, structuredClone(record)])) };
}

/** Keep outstanding work reachable even after many newer completed tasks. */
export function promiseReviewOrder(a: PromiseRecord, b: PromiseRecord): number {
  const active = (r: PromiseRecord) => ["pending", "resolved", "dispatching"].includes(r.state) && (r.state === "dispatching" || r.expiresAt > Date.now());
  return Number(active(b)) - Number(active(a)) || b.createdAt - a.createdAt;
}

/** Journal event types that may resolve hooks; all are value-free lifecycle events. */
const hookResolves = (when: ResolveWhen, e: Event): boolean => {
  if (when.kind !== "hook") return false;
  if (e.type === "AikoAutomationSignal")
    // Forwarded hook signals arrive on the owner thread as AikoAutomationSignal.
    return (e as { eventType?: string }).eventType === when.eventType;
  return PROMISE_HOOK_EVENTS.includes(e.type as PromiseHookEvent) && e.type === when.eventType;
};

export function promiseNextWake(log: readonly Event[]): number | undefined {
  const { records } = promiseState(log);
  const times = [...records.values()]
    .filter((r) => r.state === "pending" && r.when.kind === "at")
    .map((r) => (r.when.kind === "at" ? r.when.at : 0));
  return times.length ? Math.min(...times) : undefined;
}

export function promiseWakeEvent(log: readonly Event[], at: number): Event | undefined {
  const next = promiseNextWake(log);
  return next !== undefined && next <= at
    ? { type: "AikoPromiseTick", id: `clock:${at}`, at }
    : undefined;
}

/** Host-only service. Never expose resolve/markDispatching/settle as NativeTools or actor methods. */
export function createPromises(binding: { owner: string; thread: string; now?: () => number }) {
  const { owner, thread } = binding;
  if (!owner || !thread) throw new ApprovalError("Owner and thread required");
  const now = binding.now ?? Date.now;
  const read = (id: string) =>
    Effect.gen(function* () {
      const log = yield* EventLog;
      const record = promiseState(yield* log.read).records.get(id);
      return record?.owner === owner && record.thread === thread ? record : undefined;
    });
  const append = (prior: PromiseRecord | undefined, snapshot: PromiseRecord) =>
    Effect.gen(function* () {
      const log = yield* EventLog;
      yield* log.append([
        {
          type: "AikoPromiseTransition",
          owner,
          thread,
          id: snapshot.id,
          previous: prior?.version ?? 0,
          snapshot,
          at: now(),
        },
      ]);
      const current = yield* read(snapshot.id);
      return { current: current!, won: current?.token === snapshot.token };
    });
  const next = (
    prior: PromiseRecord,
    patch: Partial<Omit<PromiseRecord, "id" | "owner" | "thread" | "payload" | "when" | "createdAt" | "expiresAt" | "hash">> &
      { state: PromiseState },
  ) => ({ ...prior, ...patch, version: prior.version + 1, token: crypto.randomUUID() }) as PromiseRecord;
  const get = (id: string) =>
    Effect.gen(function* () {
      const current = yield* read(id);
      if (
        current &&
        ["pending", "resolved"].includes(current.state) &&
        current.expiresAt <= now()
      )
        return (yield* append(current, next(current, { state: "expired", reason: "ttl" }))).current;
      return current;
    });
  const prepare = (input: {
    payload: PromisePayload;
    when: ResolveWhen;
    expiresInMs?: number;
    sourceTurn?: string;
    intentId?: string;
  }) =>
    Effect.gen(function* () {
      // Snapshot all consent material before any async read/hash. No caller aliases.
      let payload: PromisePayload;
      let when: ResolveWhen;
      try {
        payload = JSON.parse(canonical(input.payload));
        when = JSON.parse(canonical(input.when));
      } catch { return yield* Effect.fail(new ApprovalError("Invalid promise payload or condition")); }
      const code = String(payload?.segment?.code ?? "");
      if (
        payload?.kind !== "harness" ||
        payload.segment?.version !== 1 ||
        typeof payload.segment.code !== "string" ||
        !code.trim() ||
        code.length > PROMISE_MAX_CODE_CHARS ||
        Buffer.byteLength(canonical(payload), "utf8") > CODE_SEGMENT_MAX_BYTES ||
        !payload.segment.values || typeof payload.segment.values !== "object" || Array.isArray(payload.segment.values) ||
        !payload.segment.packages || typeof payload.segment.packages !== "object" || Array.isArray(payload.segment.packages) ||
        Object.keys(payload.segment.values).some(key => !/^[A-Za-z_$][\w$]*$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) ||
        Object.entries(payload.segment.packages).some(([key, methods]) => !/^[A-Za-z_$][\w$]*$/.test(key) ||
          ["__proto__", "constructor", "prototype"].includes(key) || key in payload.segment.values ||
          !Array.isArray(methods) || methods.length === 0 || methods.some(method => typeof method !== "string" || !/^[A-Za-z_$][\w$]*$/.test(method) || ["__proto__", "constructor", "prototype"].includes(method))) ||
        !Number.isSafeInteger(payload.segment.ambient?.at) || typeof payload.segment.ambient?.seed !== "string" ||
        !Array.isArray(payload.segment.history) || payload.segment.history.length !== 0 ||
        payload.segment.issued !== undefined || payload.segment.scheduling !== undefined
      )
        return yield* Effect.fail(new ApprovalError("Invalid promise payload"));
      const intentId = input.intentId;
      if (intentId) {
        const existing = yield* get(intentId);
        if (existing) {
          if (canonical(existing.payload) !== canonical(payload) || canonical(existing.when) !== canonical(when) || existing.sourceTurn !== input.sourceTurn)
            return yield* Effect.fail(new ApprovalError("Promise invocation already bound to another payload"));
          return existing;
        }
      }
      if (
        when?.kind === "approval" ||
        (when?.kind === "at" &&
          Number.isSafeInteger(when.at) &&
          when.at > now() + 1000) ||
        (when?.kind === "hook" &&
          PROMISE_HOOK_EVENTS.includes(when.eventType) &&
          (when.cooldownMs === undefined ||
            (Number.isSafeInteger(when.cooldownMs) && when.cooldownMs >= 0)))
      ) {
        // Closed condition shapes only.
      } else return yield* Effect.fail(new ApprovalError("Invalid resolution condition"));
      const ttl = Math.min(Math.max(1, Number(input.expiresInMs) || PROMISE_MAX_TTL_MS), PROMISE_MAX_TTL_MS);
      const log = yield* EventLog;
      const state = promiseState(yield* log.read);
      if (
        [...state.records.values()].filter((r) => r.owner === owner && r.thread === thread && r.state === "pending" && r.expiresAt > now()).length >=
        MAX_PENDING_PROMISES
      )
        return yield* Effect.fail(new ApprovalError("Too many pending promises"));
      const id = intentId ?? `promise-${createHash("sha256")
        .update(`${owner}:${thread}:${now()}:${crypto.randomUUID()}`)
        .digest("hex")
        .slice(0, 24)}`;
      const base = {
        id,
        owner,
        thread,
        payload: JSON.parse(JSON.stringify(payload)) as PromisePayload,
        when: JSON.parse(JSON.stringify(when)) as ResolveWhen,
        label: labelOf(payload),
        ...(input.sourceTurn ? { sourceTurn: input.sourceTurn } : {}),
        createdAt: now(),
        expiresAt: now() + ttl,
      };
      const record = {
        ...base,
        hash: yield* Effect.promise(() => approvalHash(base)),
        state: "pending" as const,
        version: 1,
        token: crypto.randomUUID(),
      } as PromiseRecord;
      const result = yield* append(undefined, record);
      if (!result.won && (canonical(result.current?.payload) !== canonical(payload) || canonical(result.current?.when) !== canonical(when) || result.current?.sourceTurn !== input.sourceTurn))
        return yield* Effect.fail(new ApprovalError("Promise conflict"));
      return result.current;
    });
  /** Host-side resolution. Hook events must match the record's own condition. */
  const resolve = (
    id: string,
    source:
      | { kind: "human"; subject: string }
      | { kind: "time" }
      | { kind: "hook"; event: Event },
  ) =>
    Effect.gen(function* () {
      const current = yield* get(id);
      if (!current || current.state !== "pending") return current;
      const cooled =
        source.kind !== "hook" ||
        current.lastHookAt === undefined ||
        Number(source.event.at) >=
          current.lastHookAt + (current.when.kind === "hook" ? current.when.cooldownMs ?? 0 : 0);
      if (
        !cooled ||
        (source.kind === "human" && current.when.kind !== "approval") ||
        (source.kind === "time" && (current.when.kind !== "at" || current.when.at > now())) ||
        (source.kind === "hook" && !hookResolves(current.when, source.event))
      )
        return current;
      return (
        yield* append(
          current,
          next(current, {
            state: "resolved",
            ...(source.kind === "hook" ? { lastHookAt: Number(source.event.at) } : {}),
          }),
        )
      ).current;
    });
  const reject = (id: string, subject: string) =>
    Effect.gen(function* () {
      const current = yield* get(id);
      if (!current || current.state !== "pending" || current.when.kind !== "approval")
        return current;
      return (
        yield* append(current, next(current, { state: "rejected", reason: `human:${subject}` }))
      ).current;
    });
  const cancel = (id: string, by: "owner" | "model") =>
    Effect.gen(function* () {
      for (;;) {
        const current = yield* get(id);
        if (!current || !["pending", "resolved"].includes(current.state)) return current;
        const result = yield* append(
          current,
          next(current, { state: "cancelled", reason: `cancelled_by_${by}` }),
        );
        if (result.won) return result.current;
      }
    });
  const markDispatching = (id: string) =>
    Effect.gen(function* () {
      const current = yield* get(id);
      if (!current || current.state !== "resolved") return { current, won: false };
      const result = yield* append(current, next(current, { state: "dispatching", execution: { version: 1, turn: promiseTurn(id) } }));
      return { current: result.current, won: result.won && result.current.state === "dispatching" };
    });
  const settle = (
    id: string,
    outcome: "succeeded" | "failed" | "unknown",
    summary?: string,
  ) =>
    Effect.gen(function* () {
      for (;;) {
        const current = yield* read(id);
        if (!current || current.state !== "dispatching") return current;
        const result = yield* append(
          current,
          next(current, {
            state: outcome === "unknown" ? "unknown" : "settled",
            outcome: outcome === "unknown" ? undefined : outcome,
            reason: outcome === "unknown" ? "uncertain_outcome" : undefined,
            resultSummary: summary,
          }),
        );
        if (result.won) return result.current;
      }
    });
  const list = () =>
    Effect.gen(function* () {
      const log = yield* EventLog;
      const records = promiseState(yield* log.read).records;
      return [...records.values()]
        .filter(r => r.owner === owner && r.thread === thread)
        .sort(promiseReviewOrder)
        .slice(0, 32)
        .map((r) => ({
          id: r.id,
          label: r.label,
          when: r.when,
          state: r.state,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          outcome: r.outcome,
        }));
    });
  /** authenticate must validate the mini app session or verified Telegram sender
   * server-side; never read the principal from the request body. */
  const handleDecision = (
    request: Request,
    authenticate: (
      request: Request,
    ) => Effect.Effect<{ owner: string; subject: string; authenticated: true } | undefined, unknown>,
  ) =>
    Effect.gen(function* () {
      if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });
      const human = yield* authenticate(request).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      if (!human || human.authenticated !== true || human.owner !== owner)
        return Response.json({ error: "authenticated_owner_required" }, { status: 403, headers: { "Cache-Control": "no-store" } });
      const decoded = yield* Effect.tryPromise<unknown>(async () => JSON.parse(await boundedText(new Response(request.body), 2048))).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const body = decoded as Record<string, unknown> | null;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "decision,hash,id" ||
        typeof body.id !== "string" ||
        typeof body.hash !== "string" ||
        !["approve", "reject", "cancel"].includes(String(body.decision))
      )
        return Response.json({ error: "invalid_decision" }, { status: 400, headers: { "Cache-Control": "no-store" } });
      const current = yield* get(body.id);
      if (!current) return Response.json({ error: "promise_not_found" }, { status: 404 });
      if (current.hash !== body.hash) return Response.json({ error: "promise_changed" }, { status: 409 });
      if (body.decision !== "cancel" && current.when.kind !== "approval")
        return Response.json({ error: "approval_not_required" }, { status: 409 });
      const replay = body.decision === "approve" && ["resolved", "dispatching", "settled", "unknown"].includes(current.state) ||
        body.decision === "reject" && current.state === "rejected" || body.decision === "cancel" && current.state === "cancelled";
      if (!replay && (body.decision === "cancel" ? !["pending", "resolved"].includes(current.state) : current.state !== "pending"))
        return Response.json({ error: "promise_not_pending", promise: current }, { status: 409 });
      const outcome = body.decision === "cancel" ? yield* cancel(body.id, "owner") :
        String(body.decision) === "approve"
          ? yield* resolve(body.id, { kind: "human", subject: human.subject })
          : yield* reject(body.id, human.subject);
      const accepted = body.decision === "approve" ? ["resolved", "dispatching", "settled", "unknown"].includes(outcome?.state ?? "") :
        outcome?.state === (body.decision === "cancel" ? "cancelled" : "rejected");
      return Response.json({ promise: outcome, ...(!accepted ? { error: "promise_decision_conflict" } : {}) }, { status: accepted ? 200 : 409, headers: { "Cache-Control": "no-store" } });
    });
  return { prepare, resolve, reject, cancel, get, list, markDispatching, settle, handleDecision };
}

type Work = {
  id: string;
  version: number;
  trigger: string;
  source: { kind: "hook"; event: Event } | { kind: "time" };
};

function normalizeWhen(raw: unknown): ResolveWhen | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const w = raw as Record<string, unknown>;
  if (w.kind === "approval" && Object.keys(w).every((k) => ["kind"].includes(k)))
    return { kind: "approval" };
  if (
    w.kind === "at" &&
    Number.isSafeInteger(w.at) &&
    Object.keys(w).every((k) => ["kind", "at"].includes(k))
  )
    return { kind: "at", at: w.at as number };
  if (
    w.kind === "hook" &&
    typeof w.eventType === "string" &&
    PROMISE_HOOK_EVENTS.includes(w.eventType as PromiseHookEvent) &&
    Object.keys(w).every((k) => ["kind", "eventType", "cooldownSeconds"].includes(k))
  )
    return {
      kind: "hook",
      eventType: w.eventType as PromiseHookEvent,
      ...(w.cooldownSeconds === undefined || w.cooldownSeconds === null
        ? {} : { cooldownMs: (w.cooldownSeconds as number) * 1000 }),
    };
  return undefined;
}

/** Hook and time resolutions run here: the model never resolves or executes. */
export function promiseTools(
  owner: string,
  redact: (text: string) => string,
): NativeTool<Self | EventLog>[] {
  const whenSchema = {
    type: "object",
    properties: {
      kind: { enum: ["approval", "at", "hook"] },
      at: {
        type: ["number", "null"],
        description: "at kind only: future epoch milliseconds. Others: null.",
      },
      eventType: {
        enum: [...PROMISE_HOOK_EVENTS, null],
        description: "hook kind only. Others: null.",
      },
      cooldownSeconds: {
        type: ["number", "null"],
        minimum: 0,
        maximum: 31536000,
        description: "hook kind only. Others: null.",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  };
  return [
    {
      name: "promise_prepare",
      description:
        "Stage a code harness for deterministic later execution on the owner's VM. It runs exactly once when the condition resolves: kind=approval (owner clicks approve), kind=at (epoch ms), or kind=hook (a supported journal event lands). The staged code is frozen and hashed; execution needs no further model turn. Never stage untrusted web content and never put credentials in code or values.",
      properties: {
        code: { type: "string", minLength: 1, maxLength: PROMISE_MAX_CODE_CHARS },
        packages: {
          type: ["object", "null"],
          description: "Optional package map. Default: null.",
        },
        values: {
          type: ["object", "null"],
          description: "Optional JSON values passed to the harness. Default: null.",
        },
        when: whenSchema,
        expiresInHours: {
          type: ["number", "null"],
          minimum: 0.1,
          maximum: 720,
          description: "Hard expiry. Default 720 (30 days).",
        },
      },
      required: ["code", "when"],
    },
    {
      name: "promise_cancel",
      description:
        "Cancel one of your pending or resolved promises before it dispatches. Does not undo work already dispatched.",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    {
      name: "promise_list",
      description:
        "List your recent promises with their conditions and states.",
      properties: {},
      required: [],
    },
  ].map((spec) => ({
    spec: {
      name: spec.name,
      description: spec.description,
      inputSchema: {
        type: "object",
        properties: spec.properties,
        required: spec.required,
        additionalProperties: false,
      },
    },
    run: (raw, ctx) =>
      Effect.gen(function* () {
        const self = yield* Self,
          log = yield* EventLog;
        if (self.actor !== "aiko" || self.thread !== `user-${owner}`)
          return { status: "rejected", reason: "owner_scope" };
        let a = raw as Record<string, any>;
        if (
          !a ||
          typeof a !== "object" ||
          Array.isArray(a) ||
          Object.keys(a).some((k) => !(k in spec.properties)) ||
          spec.required.some((k) => !(k in a))
        )
          return { status: "rejected", reason: "invalid_input" };
        a = Object.fromEntries(
          Object.entries(a).filter(
            ([key, value]) =>
              value !== null || !["packages", "values", "expiresInHours"].includes(key),
          ),
        );
        const service = createPromises({ owner, thread: `user-${owner}` });
        if (spec.name === "promise_list")
          return {
            promises: yield* service.list(),
            hookEvents: PROMISE_HOOK_EVENTS,
          };
        if (spec.name === "promise_cancel") {
          if (typeof a.id !== "string" || !/^promise-[a-f0-9]{24}$/.test(a.id))
            return { status: "rejected", reason: "invalid_input" };
          const cancelled = yield* service.cancel(a.id, "model");
          return { status: cancelled?.state === "cancelled" ? "cancelled" : "rejected", state: cancelled?.state ?? "missing", reason: cancelled?.state === "cancelled" ? undefined : "Only pending work can be cancelled; dispatched work may still complete." };
        }
        const invocation = (yield* log.read).find(e => ["ToolCalled", "PackageCalled"].includes(e.type) && e.callId === ctx.callId && e.turn === ctx.turn);
        const intentId = `promise-${createHash("sha256").update(JSON.stringify([owner, self.thread, ctx.turn, ctx.callId])).digest("hex").slice(0, 24)}`;
        const existing = yield* service.get(intentId);
        const when = normalizeWhen(a.when);
        const packages = a.packages as Record<string, string[]> | undefined;
        const values = a.values as Record<string, unknown> | undefined;
        const payload: PromisePayload = {
          kind: "harness",
          segment: {
            version: 1,
            code: String(a.code ?? ""),
            packages:
              packages && typeof packages === "object" && !Array.isArray(packages)
                ? packages
                : {},
            values:
              values && typeof values === "object" && !Array.isArray(values)
                ? values
                : {},
            ambient: existing?.payload.segment.ambient ?? { at: Number(invocation?.at ?? Date.now()), seed: intentId },
            history: [],
          },
        };
        const probe = JSON.stringify({ code: payload.segment.code, packages: payload.segment.packages, values: payload.segment.values });
        if (canonical(payload.segment.values) === undefined || redact(probe) !== probe)
          return { status: "rejected", reason: "secret_in_payload" };
        const prepared = yield* service
          .prepare({
            payload,
            when: when as ResolveWhen,
            sourceTurn: ctx.turn,
            intentId,
            expiresInMs: a.expiresInHours === undefined ? undefined : a.expiresInHours * 3600_000,
          })
          .pipe(Effect.catch((error) => Effect.succeed(String((error as Error).message))));
        if (typeof prepared === "string") return { status: "rejected", reason: prepared };
        return {
          status: "recorded",
          id: prepared.id,
          hash: prepared.hash,
          when: prepared.when,
          expiresAt: prepared.expiresAt,
          label: prepared.label,
          decisionHint:
            prepared.when.kind === "approval"
              ? "Open Approvals in the mini app and review Promises. Approving queues this exact task; check its receipts for completion."
              : prepared.when.kind === "at"
                ? "Executes at the scheduled time without a model turn."
                : "Executes when the matching journal event lands.",
        };
      }),
  }));
}

export const promiseTurn = (id: string) => `promise-execution:${id}`;
export const promiseCodeId = (id: string) => `promise-code:${id}`;

/** Business outcomes come from durable tool receipts, not the code's return text. */
export function promiseExecutionOutcome(events: readonly Event[], record: PromiseRecord): "succeeded" | "failed" | "unknown" {
  const prefix = `${promiseCodeId(record.id)}.`;
  const calls = events.filter(e => typeof e.callId === "string" && e.callId.startsWith(prefix));
  const started = calls.filter(e => e.type === "AikoCodeToolStarted");
  if (calls.some(e => e.type === "PackageCalled" && !calls.some(r => r.type === "PackageReturned" && r.callId === e.callId)) ||
    calls.some(e => e.type === "PackageReturned" && (e.result as { status?: string } | undefined)?.status === "unknown") || started.some(e => !calls.some(r => r.type === "AikoCodeToolSettled" && r.callId === e.callId)) ||
    calls.some(e => e.type === "AikoCodeToolSettled" && (e.status === "unknown" || e.succeeded === false && e.status === undefined))) return "unknown";
  const code = events.find(e => e.type === "CodeSettled" && e.execId === promiseCodeId(record.id));
  if (!code || code.error || calls.some(e => e.type === "AikoCodeToolSettled" && e.succeeded === false ||
    e.type === "PackageReturned" && (e.result as { error?: unknown } | undefined)?.error)) return "failed";
  return "succeeded";
}

export function promiseComponent(owner: string) {
  type Runtime = { records: Map<string, PromiseRecord>; work: Map<string, Work>; events: readonly Event[] };
  return component({
    name: "aiko.promises",
    keys: { prefixes: ["aiko-promise:"], keyOf: promiseEventKey },
    initial: () => ({ records: new Map<string, PromiseRecord>(), work: new Map<string, Work>(), events: [] as Event[] }),
    step: (s: Runtime, e: Event): Runtime => {
      const records = new Map(s.records);
      if (e.type === "AikoPromiseTransition")
        project(records, e as Transition);
      const work = new Map(s.work);
      const at = Number(e.at);
      if (!Number.isSafeInteger(at)) return { records, work, events: [...s.events, e] };
      // Browser-learning synthesizes hook events with sourceThread; those never resolve.
      const internal = e.type === "AikoHookReceived" && e.sourceThread !== undefined;
      for (const record of records.values()) {
        if (record.owner !== owner || record.thread !== `user-${owner}`) continue;
        if (record.state === "resolved" || record.state === "dispatching") {
          // Re-drive interrupted resolutions; the act continues from fresh state.
          work.set(record.id, {
            id: record.id,
            version: record.version,
            trigger: `drive:${record.state}:${record.version}`,
            source: { kind: "time" },
          });
          continue;
        }
        if (record.state !== "pending") {
          work.delete(record.id);
          continue;
        }
        if (
          !internal &&
          record.when.kind === "hook" &&
          hookResolves(record.when, e) &&
          (record.lastHookAt === undefined ||
            at >= record.lastHookAt + (record.when.cooldownMs ?? 0))
        )
          work.set(record.id, {
            id: record.id,
            version: record.version,
            trigger: `${e.type}:${e.id}`,
            source: { kind: "hook", event: e },
          });
        else if (record.expiresAt <= at || record.when.kind === "at" && record.when.at <= at)
          work.set(record.id, {
            id: record.id,
            version: record.version,
            trigger: `time:${record.when.kind === "at" ? record.when.at : record.expiresAt}`,
            source: { kind: "time" },
          });
      }
      return { records, work, events: [...s.events, e] };
    },
    output: (s: Runtime) => ({
      view: undefined,
      transitions: [...s.work.values()].filter(item => {
        const record = s.records.get(item.id);
        return !record?.execution || !s.events.some(e => e.type === "MessageReceived" && e.id === record.execution!.turn) ||
          s.events.some(e => e.turn === record.execution!.turn && ["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(e.type));
      }).map((item) =>
        effect({
          key: `aiko-promise:work:${item.id}:${item.version}:${s.events.some(e => e.turn === promiseTurn(item.id) && ["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(e.type)) ? "settle" : "dispatch"}`,
          input: item,
          act: () =>
            Effect.gen(function* () {
              const self = yield* Self;
              if (self.actor !== "aiko" || self.thread !== `user-${owner}`) return [];
              const log = yield* EventLog;
              const readCurrent = () =>
                Effect.gen(function* () {
                  return promiseState(yield* log.read).records.get(item.id);
                });
              const service = createPromises({ owner, thread: `user-${owner}` });
              let current = yield* readCurrent();
              if (!current) return [];
              if (current.state === "pending") {
                if (current.expiresAt <= Date.now()) {
                  yield* service.get(item.id);
                  return [];
                }
                if (item.source.kind === "hook")
                  yield* service.resolve(item.id, { kind: "hook", event: item.source.event });
                else yield* service.resolve(item.id, { kind: "time" });
                current = yield* readCurrent();
              }
              if (current?.state === "resolved") {
                const marked = yield* service.markDispatching(item.id);
                if (!marked.won) return [];
                current = marked.current;
              }
              if (current?.state !== "dispatching") return [];
              if (!current.execution) {
                // A pre-continuation dispatcher may already have run. Never replay it.
                yield* service.settle(item.id, "unknown");
                return [];
              }
              const history = yield* log.read;
              const turn = current.execution.turn;
              const terminal = history.findLast(e => e.turn === turn && ["TurnCompleted", "TurnFailed", "TurnCancelled"].includes(e.type));
              if (terminal) {
                const outcome = promiseExecutionOutcome(history, current);
                yield* service.settle(item.id, outcome, outcome === "unknown" ? "Check submitted actions before retrying." : undefined);
                return [{ type: "AikoPromiseSettled", id: item.id, owner, at: Date.now(), outcome }];
              }
              if (history.some(e => e.type === "MessageReceived" && e.id === turn)) return [];
              const original = history.find(e => e.type === "MessageReceived" && e.id === current.sourceTurn);
              const telegram = original && original.chat === owner && (original.source === "telegram" && String(original.sender) === owner ||
                original.source === "automation" && original.channel === "telegram" && original.sender === "automation");
              return [{ type: "MessageReceived", id: turn, source: "automation", sender: "automation", owner,
                promiseId: current.id, promiseHash: current.hash, text: `Run the approved or scheduled task: ${current.label}`,
                ...(telegram ? { channel: "telegram", chat: owner, telegram: original.telegram } : {}), at: Date.now() }];
            }),
        }),
      ),
    }),
  });
}
