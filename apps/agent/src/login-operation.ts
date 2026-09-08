import { Effect, Schema } from "effect";
import { intent } from "tardie/core/intent";
import { actorMethod } from "tardie/core/method/method";
import { Router } from "tardie/core/communication/router";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import {
  loginUuid,
  loginObservationEvent,
  type NativeLoginObservation,
} from "./native-login-observation.ts";
import type { NativeLoginInput, NativeLoginView } from "./native-login.ts";

/** Mount on the existing owner thread. Host-only admission: never expose these
 * events as model tools or accept them from public callback JSON. Private APIs
 * submit secrets separately; this component only opens/inspects/finishes login.
 * Compose nextWake/wakeEvent with existing host alarms, not a new scheduler.
 */
export interface LoginOperationRequest {
  owner: string;
  thread: string;
  operationId: string;
  connectionId: string;
  domain: string;
  attemptId: string;
  expectedRevision: number;
  expiresAt: number;
  continuationId: string;
  contractRef: string;
}
export type LoginOperationStatus =
  | "requested"
  | "opening"
  | "awaiting_user"
  | "verifying"
  | "connected"
  | "expired"
  | "cancelled"
  | "unknown";
export interface LoginOperation extends LoginOperationRequest {
  status: LoginOperationStatus;
  sequence: number;
  probes: number;
  challengeId?: string;
  challengeRevision?: number;
  challengeExpiresAt?: number;
  verifiedRevision?: number;
  verifiedAt?: number;
  cleanupAttempts?: number;
  continued?: boolean;
  nextProbeAt?: number;
  cleaned?: boolean;
  cleanupOutcome?: "cleaned" | "unknown";
  continuationOutcome?: "resumed" | "unknown" | "authorization_revoked";
}
export interface LoginOperationBinding {
  owner: string;
  thread: string;
  /** Must enforce owner/connection custody and call existing private nativeAuth. */
  control(
    input: NativeLoginInput,
    signal: AbortSignal,
  ): Promise<NativeLoginView>;
  authorize(operation: LoginOperation, signal: AbortSignal): Promise<boolean>;
  /** Resume through an existing native handoff/effect identity. Must deduplicate
   * by continuationId: a lost acknowledgement is reconciled, never blindly sent. */
  resume?(operation: LoginOperation, signal: AbortSignal): Promise<void>;
  /** Production uses native Router delivery, replayable by deterministic task identity. */
  nativeHandoff?: boolean;
  now?: () => number;
}
const terminal = (status: LoginOperationStatus) =>
  ["connected", "expired", "cancelled"].includes(status);
const identity = (v: unknown): v is string =>
  typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(v);
export function requestLoginOperation(
  input: LoginOperationRequest,
  at = Date.now(),
): Event {
  if (
    !identity(input.owner) ||
    !identity(input.thread) ||
    !identity(input.operationId) ||
    !identity(input.continuationId) ||
    !identity(input.contractRef) ||
    !loginUuid(input.attemptId) ||
    !loginUuid(input.connectionId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= at ||
    input.expiresAt > at + 30 * 60_000 ||
    !/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(input.domain)
  )
    throw Error("Invalid login operation");
  return {
    type: "AikoLoginOperationRequested",
    id: input.operationId,
    owner: input.owner,
    thread: input.thread,
    operationId: input.operationId,
    connectionId: input.connectionId,
    domain: input.domain,
    attemptId: input.attemptId,
    expectedRevision: input.expectedRevision,
    expiresAt: input.expiresAt,
    continuationId: input.continuationId,
    contractRef: input.contractRef,
    at,
  };
}
export { loginObservationEvent } from "./native-login-observation.ts";
export function loginOperationEventKey(e: Event): string | undefined {
  if (
    e.type === "AikoPrivateLoginObserved" &&
    typeof e.owner === "string" &&
    typeof e.attemptId === "string"
  )
    return `aiko-login-operation:observed:${e.owner}:${e.attemptId}:${e.sequence}`;
  if (
    e.type.startsWith("AikoLoginOperation") &&
    typeof e.owner === "string" &&
    typeof e.id === "string"
  )
    return `aiko-login-operation:${e.owner}:${e.type}:${e.id}`;
}
/** Add to public-ingress policy: false means host/component-private only. */
export const loginOperationExternalEventAllowed = (e: Event) =>
  !e.type.startsWith("AikoLoginOperation") &&
  ![
    "AikoPrivateLoginObserved",
    "AikoLoginProgress",
    "AikoLoginSubmitted",
    "AikoLoginAttemptFailed",
    "AikoNativeLoginStatus",
    "AikoLoginNoticeStarted",
    "AikoLoginNoticeSettled",
  ].includes(e.type) &&
  !(
    e.type === "MessageReceived" &&
    (e.source === "login" || e.loginOperation !== undefined)
  ) &&
  (e.call as any)?.invocation?.method !== "loginWait";
export function loginOperationState(
  events: readonly Event[],
  owner: string,
  thread: string,
): Map<string, LoginOperation> {
  const records = new Map<string, LoginOperation>();
  for (const e of events) {
    if (e.type === "AlarmFired") {
      for (const r of records.values()) {
        if (
          !terminal(r.status) &&
          (Number(e.at) >= r.expiresAt ||
            (r.status === "awaiting_user" &&
              Number(e.at) >= (r.challengeExpiresAt ?? Infinity)))
        )
          r.status = "expired";
        else if (
          !terminal(r.status) &&
          r.nextProbeAt !== undefined &&
          Number(e.at) >= r.nextProbeAt &&
          r.probes < 8
        ) {
          r.status = "verifying";
          delete r.nextProbeAt;
        }
      }
      continue;
    }
    if (e.type === "CancellationRequested") {
      for (const r of records.values())
        if (
          (e.invocation as any)?.id === r.continuationId &&
          !terminal(r.status)
        )
          r.status = "cancelled";
      continue;
    }
    if (e.owner !== owner) continue;
    if (e.type === "AikoLoginOperationRequested") {
      if (e.thread !== thread || records.has(String(e.operationId))) continue;
      try {
        requestLoginOperation(
          e as unknown as LoginOperationRequest,
          Number(e.at),
        );
      } catch {
        continue;
      }
      if (
        [...records.values()].some(
          (r) =>
            r.attemptId === e.attemptId ||
            (r.connectionId === e.connectionId && !terminal(r.status)),
        )
      )
        continue;
      records.set(String(e.operationId), {
        owner,
        thread,
        operationId: String(e.operationId),
        connectionId: String(e.connectionId),
        domain: String(e.domain),
        attemptId: String(e.attemptId),
        expectedRevision: Number(e.expectedRevision),
        expiresAt: Number(e.expiresAt),
        continuationId: String(e.continuationId),
        contractRef: String(e.contractRef),
        status: "requested",
        sequence: 0,
        probes: 0,
      });
      continue;
    }
    for (const r of records.values()) {
      if (e.type === "AikoLoginOperationTick") {
        if (
          (Number(e.at) >= r.expiresAt ||
            (r.status === "awaiting_user" &&
              Number(e.at) >= (r.challengeExpiresAt ?? Infinity))) &&
          !terminal(r.status)
        ) {
          r.status = "expired";
          continue;
        }
        if (
          r.nextProbeAt !== undefined &&
          Number(e.at) >= r.nextProbeAt &&
          !terminal(r.status) &&
          r.probes < 8
        ) {
          r.status = "verifying";
          delete r.nextProbeAt;
        }
      }
      if (e.attemptId !== r.attemptId || e.connectionId !== r.connectionId)
        continue;
      if (
        e.type === "AikoLoginOperationCleanupRequested" &&
        ["cancelled", "expired"].includes(r.status) &&
        r.cleanupOutcome === "unknown" &&
        e.generation === (r.cleanupAttempts ?? 0) + 1
      ) {
        r.cleanupAttempts = Number(e.generation);
        delete r.cleanupOutcome;
        continue;
      }
      if (
        e.type === "AikoLoginOperationCleanupSettled" &&
        (e.generation ?? 0) === (r.cleanupAttempts ?? 0)
      ) {
        r.cleanupOutcome = e.outcome === "cleaned" ? "cleaned" : "unknown";
        r.cleaned = r.cleanupOutcome === "cleaned";
        continue;
      }
      if (e.type === "AikoLoginOperationContinued") {
        if (r.status === "connected") {
          r.continuationOutcome =
            e.outcome === "resumed"
              ? "resumed"
              : e.outcome === "authorization_revoked"
                ? "authorization_revoked"
                : "unknown";
          r.continued = r.continuationOutcome === "resumed";
        }
        continue;
      }
      if (e.type === "AikoLoginOperationCancelled" && !terminal(r.status)) {
        r.status = "cancelled";
        continue;
      }
      if (terminal(r.status)) continue;
      if (Number(e.at) >= r.expiresAt) {
        r.status = "expired";
        continue;
      }
      if (e.type === "AikoPrivateLoginObserved") {
        try {
          loginObservationEvent(owner, e as unknown as NativeLoginObservation);
        } catch {
          continue;
        }
        if (
          e.sequence !== r.sequence + 1 ||
          Number(e.revision) < r.expectedRevision
        )
          continue;
        r.sequence = Number(e.sequence);
        if (e.kind === "disconnected") {
          r.status = "cancelled";
          continue;
        }
        if (e.kind === "opening") r.status = "opening";
        if (e.kind === "challenge") {
          r.status = "awaiting_user";
          delete r.nextProbeAt;
          r.challengeId = String(e.challengeId);
          r.challengeRevision = Number(e.challengeRevision);
          r.challengeExpiresAt = Number(e.expiresAt);
        }
        if (
          [
            "submission_dispatched",
            "submission_acknowledged",
            "verified",
          ].includes(String(e.kind))
        )
          r.status = "verifying";
      }
      if (
        e.type === "AikoLoginOperationAwaitingUser" &&
        e.sequence === r.sequence
      ) {
        r.status = "awaiting_user";
        delete r.nextProbeAt;
      }
      if (
        e.type === "AikoLoginOperationProbeFinished" &&
        e.sequence === r.sequence
      ) {
        r.probes++;
        r.status = "awaiting_user";
        if (r.probes < 8) r.nextProbeAt = Number(e.at) + 1000;
      }
      if (
        e.type === "AikoLoginOperationVerified" &&
        Number(e.revision) > r.expectedRevision &&
        Number(e.sessionExpiresAt) > Number(e.at)
      ) {
        r.status = "connected";
        r.verifiedRevision = Number(e.revision);
        r.verifiedAt = Number(e.at);
      }
    }
  }
  return records;
}
export function loginOperationNextWake(
  events: readonly Event[],
  owner: string,
  thread: string,
): number | undefined {
  const deadlines = [...loginOperationState(events, owner, thread).values()]
    .filter((r) => !terminal(r.status))
    .map((r) =>
      Math.min(
        r.expiresAt,
        r.nextProbeAt ?? Infinity,
        r.status === "awaiting_user"
          ? (r.challengeExpiresAt ?? Infinity)
          : Infinity,
      ),
    );
  return deadlines.length ? Math.min(...deadlines) : undefined;
}
export function loginOperationWakeEvent(owner: string, at: number): Event {
  return { type: "AikoLoginOperationTick", id: `tick:${at}`, owner, at };
}
export function cancelLoginOperation(
  operation: LoginOperationRequest,
  at = Date.now(),
): Event {
  return {
    type: "AikoLoginOperationCancelled",
    id: operation.operationId,
    owner: operation.owner,
    attemptId: operation.attemptId,
    connectionId: operation.connectionId,
    at,
  };
}
async function finiteLoginCall<T>(
  run: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal,
  ms = 30000,
): Promise<T> {
  const signal = AbortSignal.any([
    parent,
    AbortSignal.timeout(Math.max(1, Math.min(ms, 30000))),
  ]);
  signal.throwIfAborted();
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(Error("Login operation deadline"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return run(signal);
      }),
      interrupted,
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export function loginOperationComponent(binding: LoginOperationBinding) {
  const now = binding.now ?? Date.now;
  return component({
    name: "aiko.login-operation",
    keys: {
      prefixes: ["aiko-login-operation:"],
      keyOf: loginOperationEventKey,
    },
    initial: () => [] as Event[],
    step: (events: Event[], event: Event) =>
      loginOperationEventKey(event) ||
      ["AlarmFired", "CancellationRequested"].includes(event.type)
        ? [...events, event]
        : events,
    output: (events) => ({
      view: undefined,
      transitions: [
        ...loginDeadlineTransitions(events, binding.owner, binding.thread),
        ...[
          ...loginOperationState(
            events,
            binding.owner,
            binding.thread,
          ).values(),
        ]
          .filter(
            (r) =>
              r.status === "requested" ||
              (r.status === "verifying" && r.probes < 8) ||
              (r.status === "connected" && !r.continuationOutcome) ||
              (["cancelled", "expired"].includes(r.status) &&
                !r.cleanupOutcome),
          )
          .map((r) =>
            effect({
              key: `aiko-login-operation:work:${r.attemptId}:${r.status}:${r.sequence}:${r.probes}:${r.cleanupAttempts ?? 0}`,
              input: {
                operationId: r.operationId,
                status: r.status,
                sequence: r.sequence,
              },
              interrupts: (_, e) =>
                (e.type === "AikoLoginOperationCancelled" &&
                  e.attemptId === r.attemptId) ||
                (e.type === "CancellationRequested" &&
                  (e.invocation as any)?.id === r.continuationId),
              act: (input, signal) =>
                Effect.gen(function* () {
                  const self = yield* Self,
                    log = yield* EventLog;
                  if (self.actor !== "aiko" || self.thread !== binding.thread)
                    return [];
                  const read = () =>
                    Effect.gen(function* () {
                      return loginOperationState(
                        yield* log.read,
                        binding.owner,
                        binding.thread,
                      ).get(input.operationId);
                    });
                  const current = yield* read();
                  if (
                    !current ||
                    current.status !== input.status ||
                    current.sequence !== input.sequence
                  )
                    return [];
                  const base = {
                    owner: binding.owner,
                    connectionId: current.connectionId,
                    attemptId: current.attemptId,
                    at: now(),
                  };
                  if (["cancelled", "expired"].includes(current.status)) {
                    const outcome = yield* Effect.tryPromise(() =>
                      finiteLoginCall(
                        (active) =>
                          binding.control(
                            {
                              connectionId: current.connectionId,
                              domain: current.domain,
                              attemptId: current.attemptId,
                              action: "disconnect",
                            },
                            active,
                          ),
                        signal,
                      ),
                    ).pipe(
                      Effect.map((view) =>
                        view.status === "disconnected" ? "cleaned" : "unknown",
                      ),
                      Effect.catch(() => Effect.succeed("unknown")),
                    );
                    return [
                      {
                        type: "AikoLoginOperationCleanupSettled",
                        id: `${current.operationId}:${current.cleanupAttempts ?? 0}`,
                        ...base,
                        generation: current.cleanupAttempts ?? 0,
                        outcome,
                      },
                    ];
                  }
                  if (
                    current.expiresAt <= now() &&
                    current.status !== "connected"
                  )
                    return [loginOperationWakeEvent(binding.owner, now())];
                  const allowed = yield* Effect.tryPromise(() =>
                    finiteLoginCall(
                      (active) => binding.authorize(current, active),
                      signal,
                      current.expiresAt - now(),
                    ),
                  ).pipe(Effect.catch(() => Effect.succeed(false)));
                  if (!allowed)
                    return current.status === "connected"
                      ? [
                          {
                            type: "AikoLoginOperationContinued",
                            id: current.operationId,
                            ...base,
                            outcome: "authorization_revoked",
                          },
                        ]
                      : [cancelLoginOperation(current, now())];
                  if (current.status === "connected" && binding.nativeHandoff) {
                    const history = yield* log.read;
                    const original = history.find(
                      (e) =>
                        e.type === "MessageReceived" &&
                        e.id === current.continuationId,
                    );
                    if (
                      !original ||
                      typeof original.text !== "string" ||
                      history.some(
                        (e) =>
                          e.type === "CancellationRequested" &&
                          (e.invocation as any)?.id === current.continuationId,
                      )
                    )
                      return [
                        {
                          type: "AikoLoginOperationContinued",
                          id: current.operationId,
                          ...base,
                          outcome: "authorization_revoked",
                        },
                      ];
                    const router = yield* Router;
                    // Native Router commits to the same durable thread. A crash after delivery
                    // replays this exact message id; agentKeys suppress duplicate execution.
                    yield* router.send(
                      envelopeOf(linkOf(self, self), {
                        type: "MessageReceived",
                        id: `login-resume:${current.operationId}`,
                        at: current.verifiedAt!,
                        source: "login",
                        cause: current.continuationId,
                        loginOperation: current.operationId,
                        text: `The requested connection is now verified. Continue the original task: ${original.text}`,
                      }),
                    );
                    return [
                      {
                        type: "AikoLoginOperationContinued",
                        id: current.operationId,
                        ...base,
                        outcome: "resumed",
                        continuationId: current.continuationId,
                      },
                    ];
                  }
                  if (current.status === "connected") {
                    const started = (yield* log.read).some(
                      (e) =>
                        e.type === "AikoLoginOperationContinuationStarted" &&
                        e.attemptId === current.attemptId,
                    );
                    if (started)
                      return [
                        {
                          type: "AikoLoginOperationContinued",
                          id: current.operationId,
                          ...base,
                          outcome: "unknown",
                        },
                      ];
                    yield* log.append([
                      {
                        type: "AikoLoginOperationContinuationStarted",
                        id: current.operationId,
                        ...base,
                        continuationId: current.continuationId,
                      },
                    ]);
                    const outcome = yield* Effect.tryPromise(() =>
                      finiteLoginCall(
                        (active) =>
                          binding.resume
                            ? binding.resume(current, active)
                            : Promise.reject(Error("Continuation unavailable")),
                        signal,
                      ),
                    ).pipe(
                      Effect.map(() => "resumed"),
                      Effect.catch(() => Effect.succeed("unknown")),
                    );
                    return [
                      {
                        type: "AikoLoginOperationContinued",
                        id: current.operationId,
                        ...base,
                        outcome,
                      },
                    ];
                  }
                  const action =
                    current.status === "requested" ? "begin" : "finish";
                  const view = yield* Effect.tryPromise(async () => {
                    try {
                      return await finiteLoginCall(
                        (active) =>
                          binding.control(
                            {
                              connectionId: current.connectionId,
                              domain: current.domain,
                              attemptId: current.attemptId,
                              action,
                            },
                            active,
                          ),
                        signal,
                        current.expiresAt - now(),
                      );
                    } catch {
                      if (action !== "finish") return undefined;
                      return finiteLoginCall(
                        (active) =>
                          binding.control(
                            {
                              connectionId: current.connectionId,
                              domain: current.domain,
                              attemptId: current.attemptId,
                              action: "form",
                            },
                            active,
                          ),
                        signal,
                        current.expiresAt - now(),
                      );
                    }
                  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
                  const fresh = yield* read();
                  if (
                    !fresh ||
                    terminal(fresh.status) ||
                    fresh.expiresAt <= now()
                  )
                    return fresh && fresh.expiresAt <= now()
                      ? [loginOperationWakeEvent(binding.owner, now())]
                      : [];
                  const output: Event[] = [];
                  if (view?.attemptId === current.attemptId)
                    for (const receipt of view.loginReceipts ?? [])
                      output.push(
                        loginObservationEvent(binding.owner, receipt),
                      );
                  if (
                    view?.attemptId === current.attemptId &&
                    view.status === "connected" &&
                    view.revision > current.expectedRevision &&
                    view.expiresAt > now()
                  )
                    output.push({
                      type: "AikoLoginOperationVerified",
                      id: current.operationId,
                      ...base,
                      at: now(),
                      revision: view.revision,
                      sessionExpiresAt: view.expiresAt,
                    });
                  else {
                    const sequence =
                      view?.attemptId === current.attemptId
                        ? (view.loginReceipts?.at(-1)?.sequence ??
                          current.sequence)
                        : current.sequence;
                    output.push({
                      type: view?.fields?.length
                        ? "AikoLoginOperationAwaitingUser"
                        : "AikoLoginOperationProbeFinished",
                      id: `${current.operationId}:${sequence}:${current.probes}`,
                      ...base,
                      sequence,
                    });
                  }
                  return output;
                }),
            }),
          ),
      ],
    }),
  });
}

/** Real native method invocation deadlines, consumed by the installed Bun/Worker
 * alarm machinery. No timers, polling loop, or independent durable queue. */
export const loginWaitMethod = actorMethod({
  input: Schema.Struct({ operationId: Schema.String }),
  output: Schema.String,
  event: (call) => ({
    type: "AikoLoginOperationDeadline",
    id: call.invocation.id,
    operationId: call.input.operationId,
    at: call.at,
    call: { invocation: call.invocation, deadlineAt: call.deadlineAt },
  }),
  projection: {
    initial: () => [] as Event[],
    step: (s: Event[], e: Event) => [...s, e],
    output: (events) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        const e = events.find(
          (e) =>
            e.type === "AikoLoginOperationDeadline" &&
            (e.call as any)?.invocation.id === invocation.id,
        );
        if (!e) return undefined;
        const operation = loginOperationState(
          events,
          String(e.owner),
          String(e.thread),
        ).get(String(e.operationId));
        return (operation && terminal(operation.status)) ||
          events.some(
            (a) =>
              a.type === "AlarmFired" &&
              Number(a.at) >= Number((e.call as any).deadlineAt),
          )
          ? { status: "completed" as const, output: "settled" }
          : { status: "pending" as const };
      },
    }),
  },
});
function loginDeadlineTransitions(
  events: readonly Event[],
  owner: string,
  thread: string,
) {
  return [...loginOperationState(events, owner, thread).values()]
    .filter((r) => !terminal(r.status))
    .flatMap((r) => {
      const at = Math.min(
        r.expiresAt,
        r.nextProbeAt ?? Infinity,
        r.status === "awaiting_user"
          ? (r.challengeExpiresAt ?? Infinity)
          : Infinity,
      );
      const id = `${r.attemptId}:${at}`;
      if (
        events.some(
          (e) => e.type === "AikoLoginOperationDeadline" && e.id === id,
        )
      )
        return [];
      return [
        intent({
          key: `aiko-login-operation:deadline:${id}`,
          input: r,
          events: (_, committedAt) => [
            {
              ...loginWaitMethod.event({
                invocation: { method: "loginWait", id, epoch: 0 },
                deadlineAt: at,
                input: { operationId: r.operationId },
                at: committedAt,
              }),
              owner,
              thread,
            },
          ],
        }),
      ];
    });
}
