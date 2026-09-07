import { Effect } from "effect";
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
import type { CodeSegment, CodeSegmentResult } from "./code-sandbox-protocol.ts";
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
    return `aiko-promise:t:${e.id}:${(e as Transition).previous ?? 0}`;
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
      });
    if (frozen(prior) !== frozen(e.snapshot)) return;
  } else if (e.snapshot.state !== "pending") return;
  records.set(e.id, e.snapshot);
}

export function promiseState(log: readonly Event[]) {
  const records = new Map<string, PromiseRecord>();
  for (const e of log)
    if (e.type === "AikoPromiseTransition") project(records, e as Transition);
  return { records };
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

export type PromiseExecutors = {
  /** Runs on the owner's VM. Throwing a retryable error before the dispatching
   * marker is persisted lets the effect retry (e.g. sandbox busy). */
  harness: (segment: CodeSegment, signal?: AbortSignal) => Promise<CodeSegmentResult>;
};

/** Host-only service. Never expose resolve/markDispatching/settle as NativeTools or actor methods. */
export function createPromises(binding: { owner: string; thread: string; now?: () => number }) {
  const { owner, thread } = binding;
  if (!owner || !thread) throw new ApprovalError("Owner and thread required");
  const now = binding.now ?? Date.now;
  const read = (id: string) =>
    Effect.gen(function* () {
      const log = yield* EventLog;
      return promiseState(yield* log.read).records.get(id);
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
  }) =>
    Effect.gen(function* () {
      const payload = input.payload as PromisePayload;
      const code = String(payload?.segment?.code ?? "");
      if (
        payload?.kind !== "harness" ||
        payload.segment?.version !== 1 ||
        typeof payload.segment.code !== "string" ||
        !code.trim() ||
        code.length > PROMISE_MAX_CODE_CHARS ||
        Buffer.byteLength(code, "utf8") > CODE_SEGMENT_MAX_BYTES
      )
        return yield* Effect.fail(new ApprovalError("Invalid promise payload"));
      const when = input.when as ResolveWhen;
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
        [...state.records.values()].filter((r) => r.state === "pending").length >=
        MAX_PENDING_PROMISES
      )
        return yield* Effect.fail(new ApprovalError("Too many pending promises"));
      const id = `promise-${createHash("sha256")
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
      if (!result.won) return yield* Effect.fail(new ApprovalError("Promise conflict"));
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
        (source.kind === "time" && current.when.kind !== "at") ||
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
      const result = yield* append(current, next(current, { state: "dispatching" }));
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
        .sort((a, b) => b.createdAt - a.createdAt)
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
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const human = yield* authenticate(request).pipe(
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      if (!human || human.authenticated !== true || human.owner !== owner)
        return new Response(null, { status: 403 });
      const decoded = yield* Effect.tryPromise<unknown>(() => request.json()).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      const body = decoded as Record<string, unknown> | null;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((k) => !["id", "decision"].includes(k)) ||
        typeof body.id !== "string" ||
        !["approve", "reject"].includes(String(body.decision))
      )
        return new Response(null, { status: 400 });
      const outcome =
        String(body.decision) === "approve"
          ? yield* resolve(body.id, { kind: "human", subject: human.subject })
          : yield* reject(body.id, human.subject);
      return Response.json(outcome, { headers: { "Cache-Control": "no-store" } });
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
      cooldownMs:
        w.cooldownSeconds === undefined || w.cooldownSeconds === null
          ? undefined
          : (w.cooldownSeconds as number) * 1000,
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
          return { status: "cancelled", state: cancelled?.state ?? "unknown" };
        }
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
            ambient: { at: Date.now(), seed: crypto.randomUUID() },
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
              ? "The owner approves from the mini app promises screen; execution is automatic after approval."
              : prepared.when.kind === "at"
                ? "Executes at the scheduled time without a model turn."
                : "Executes when the matching journal event lands.",
        };
      }),
  }));
}

export function promiseComponent(owner: string, executors: PromiseExecutors) {
  type Runtime = { records: Map<string, PromiseRecord>; work: Map<string, Work> };
  return component({
    name: "aiko.promises",
    keys: { prefixes: ["aiko-promise:"], keyOf: promiseEventKey },
    initial: () => ({ records: new Map<string, PromiseRecord>(), work: new Map<string, Work>() }),
    step: (s: Runtime, e: Event): Runtime => {
      const records = new Map(s.records);
      if (e.type === "AikoPromiseTransition")
        project(records, e as Transition);
      const work = new Map(s.work);
      const at = Number(e.at);
      if (!Number.isSafeInteger(at)) return { records, work };
      // Browser-learning synthesizes hook events with sourceThread; those never resolve.
      const internal = e.type === "AikoHookReceived" && e.sourceThread !== undefined;
      for (const record of records.values()) {
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
        else if (record.when.kind === "at" && record.when.at <= at)
          work.set(record.id, {
            id: record.id,
            version: record.version,
            trigger: `time:${record.when.at}`,
            source: { kind: "time" },
          });
      }
      return { records, work };
    },
    output: (s: Runtime) => ({
      view: undefined,
      transitions: [...s.work.values()].map((item) =>
        effect({
          key: `aiko-promise:work:${item.id}:${item.version}`,
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
              if (current?.state === "dispatching") {
                // The previous dispatcher died mid-run; never re-execute.
                yield* service.settle(item.id, "unknown");
                return [];
              }
              if (current?.state !== "resolved") return [];
              const marked = yield* service.markDispatching(item.id);
              if (!marked.won) return [];
              let outcome: "succeeded" | "failed" | "unknown" = "unknown";
              let summary: string | undefined;
              const attempted = yield* Effect.tryPromise(() =>
                executors.harness(current!.payload.segment),
              ).pipe(
                Effect.catch((error) =>
                  Effect.succeed({
                    __thrown: String((error as Error)?.message ?? "executor_error"),
                  }),
                ),
              );
              if ("__thrown" in attempted) {
                // Transport-level failure: the segment may or may not have run.
                outcome = "unknown";
              } else if (attempted.settled && !attempted.error) {
                outcome = "succeeded";
                const value = attempted.result;
                summary =
                  typeof value === "string" && value
                    ? value.slice(0, 200)
                    : value !== undefined
                      ? JSON.stringify(value).slice(0, 200)
                      : undefined;
              } else if (attempted.settled) {
                outcome = "failed";
                summary = "harness_failed";
              } else outcome = "unknown";
              const settled = yield* service.settle(item.id, outcome, summary);
              if (settled?.outcome)
                yield* log
                  .append([
                    {
                      type: "AikoPromiseSettled",
                      id: item.id,
                      owner,
                      at: Date.now(),
                      outcome: settled.outcome,
                    },
                  ])
                  .pipe(Effect.catch(() => Effect.void));
              return [];
            }),
        }),
      ),
    }),
  });
}
