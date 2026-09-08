import { Effect } from "effect";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";

export type ApprovalJson = null | boolean | number | string | readonly ApprovalJson[] | { readonly [key: string]: ApprovalJson };
export type ApprovalState = "pending" | "approved" | "rejected" | "expired" | "dispatched" | "settled" | "unknown";
/** All provider arguments, destination, attachments and final ThinkFeel text belong in payload.
 * Never put credentials here. Resolve credentials from the bound connection at dispatch. */
export interface PreparedAction {
  readonly id: string;
  readonly owner: string;
  readonly thread: string;
  readonly operation: string;
  readonly connectionId: string;
  readonly connectionRevision: string;
  readonly expiresAt: number;
  readonly payload: ApprovalJson;
  readonly hash: string;
}
export type PrepareAction = Omit<PreparedAction, "owner" | "thread" | "hash">;
export interface ActionApproval {
  readonly prepared: PreparedAction;
  readonly state: ApprovalState;
  readonly version: number;
  readonly token: string;
  readonly reason?: string;
  readonly outcome?: "succeeded" | "failed";
}
type Transition = Event & {
  type: "AikoActionApprovalTransition";
  owner: string; thread: string; id: string; previous: number;
  snapshot: ActionApproval;
};
export class ApprovalError extends Error {}

// Strict JSON only: no lossy undefined/NaN/date/accessor conversion or mutable aliases.
export function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)) throw new ApprovalError("Payload must be finite acyclic JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) throw new ApprovalError("Sparse or decorated array");
      return "[" + Array.from({ length: value.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !("value" in d)) throw new ApprovalError("JSON accessors forbidden");
        return canonical(d.value, seen);
      }).join(",") + "]";
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new ApprovalError("Plain JSON object required");
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) throw new ApprovalError("Hidden JSON properties");
    return "{" + Object.keys(value).sort().map(k => {
      const d = Object.getOwnPropertyDescriptor(value, k)!;
      if (!("value" in d)) throw new ApprovalError("JSON accessors forbidden");
      return JSON.stringify(k) + ":" + canonical(d.value, seen);
    }).join(",") + "}";
  } finally { seen.delete(value); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const copy = <T>(value: T): T => freeze(JSON.parse(canonical(value)));
export async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
/** Optional host key fragment. Safety also holds without dedup: projection selects the
 * first valid successor, then writers read back their unique token before acting. */
export const actionApprovalEventKey = (e: Event): string | undefined => e.type === "AikoActionApprovalTransition"
  ? JSON.stringify([e.type, e.owner, e.thread, e.id, e.previous]) : undefined;

/** Read-only canonical projection shared with domain collection views. */
export function projectActionApprovals(events: readonly Event[], owner: string, thread: string, onlyId?: string): Map<string, ActionApproval> {
  const states = new Map<string, ActionApproval>();
  for (const row of events) {
    if (row.type !== "AikoActionApprovalTransition" || row.owner !== owner || row.thread !== thread || typeof row.id !== "string" || onlyId !== undefined && row.id !== onlyId) continue;
    const e = row as Transition;
    const state = states.get(e.id);
    if (e.previous !== (state?.version ?? 0) || e.snapshot.version !== e.previous + 1) continue;
    if (!state && e.snapshot.state !== "pending") continue;
    if (state && canonical(e.snapshot.prepared) !== canonical(state.prepared)) continue;
    states.set(e.id, e.snapshot);
  }
  return new Map([...states].map(([id, state]) => [id, copy(state)]));
}
const project = (events: readonly Event[], owner: string, thread: string, id: string) => projectActionApprovals(events, owner, thread, id).get(id);

/** Host-only service. Never expose decide/handleDecision as NativeTools or actor methods.
 * Bind all calls for this owner to the SAME durable thread EventLog (linearizable reads
 * and atomic ordered appends). Authenticate the HTTP request independently of its body.
 * Connection revocation must invalidate each outstanding action through cancel(), or
 * serialize the authoritative revision check and dispatch admission at the host. */
export function createActionApprovals(binding: { owner: string; thread: string; now?: () => number }) {
  const { owner, thread } = binding;
  if (!owner || !thread) throw new ApprovalError("Owner and thread required");
  const now = binding.now ?? Date.now;
  const read = (id: string) => Effect.gen(function* () {
    const log = yield* EventLog;
    return project(yield* log.read, owner, thread, id);
  });
  const transition = (prior: ActionApproval | undefined, prepared: PreparedAction, state: ApprovalState, extra: { reason?: string; outcome?: "succeeded" | "failed" } = {}) => Effect.gen(function* () {
    const log = yield* EventLog;
    const token = crypto.randomUUID();
    if ((state === "approved" || state === "dispatched") && prepared.expiresAt <= now()) state = "expired";
    const snapshot: ActionApproval = { prepared, state, version: (prior?.version ?? 0) + 1, token, ...extra };
    yield* log.append([{ type: "AikoActionApprovalTransition", owner, thread, id: prepared.id, previous: prior?.version ?? 0, snapshot, at: now() }]);
    const current = yield* read(prepared.id);
    return { current: current!, won: current?.token === token };
  });
  const get = (id: string) => Effect.gen(function* () {
    const current = yield* read(id);
    if (current && ["pending", "approved"].includes(current.state) && current.prepared.expiresAt <= now())
      return (yield* transition(current, current.prepared, "expired")).current;
    return current;
  });
  const prepare = (input: PrepareAction) => Effect.gen(function* () {
    // Snapshot before the first async boundary; caller mutation cannot change consent.
    const data = copy({ ...input, owner, thread });
    if ([data.id, data.operation, data.connectionId, data.connectionRevision].some(v => typeof v !== "string" || !v.trim()) || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= now())
      return yield* Effect.fail(new ApprovalError("Invalid prepared action"));
    const prepared = copy({ ...data, hash: yield* Effect.promise(() => hash(data)) });
    const previous = yield* get(data.id);
    if (previous) {
      if (canonical(previous.prepared) !== canonical(prepared)) return yield* Effect.fail(new ApprovalError("Action ID already bound to another payload"));
      return previous;
    }
    const result = (yield* transition(undefined, prepared, "pending")).current;
    if (canonical(result.prepared) !== canonical(prepared)) return yield* Effect.fail(new ApprovalError("Action ID conflict"));
    return result;
  });
  const decide = (human: { owner: string; subject: string; authenticated: true }, input: { id: string; hash: string; decision: "approve" | "reject" }) => Effect.gen(function* () {
    if (human.authenticated !== true || human.owner !== owner || !human.subject || !["approve", "reject"].includes(input.decision))
      return yield* Effect.fail(new ApprovalError("Authenticated owner required"));
    const current = yield* get(input.id);
    if (!current || current.prepared.hash !== input.hash) return yield* Effect.fail(new ApprovalError("Approval not found or hash mismatch"));
    if (current.state !== "pending") return current;
    return (yield* transition(current, current.prepared, input.decision === "approve" ? "approved" : "rejected", { reason: `human:${human.subject}` })).current;
  });
  /** Host cancellation/revocation; never restores consent. A dispatched attempt may
   * already have reached the provider, so cancellation becomes unknown. */
  const cancel = (id: string, reason: "cancelled" | "revoked") => Effect.gen(function* () {
    for (;;) {
      const current = yield* get(id);
      if (!current || !["pending", "approved", "dispatched"].includes(current.state)) return current;
      const result = yield* transition(current, current.prepared, current.state === "dispatched" ? "unknown" : "rejected", { reason });
      if (result.won) return result.current;
    }
  });
  /** Recovery only: the host has established that the original dispatcher is gone.
   * This records uncertainty; it does not grant another attempt or infer failure. */
  const markUnknown = (id: string) => Effect.gen(function* () {
    const current = yield* read(id);
    if (!current || current.state !== "dispatched") return current;
    return (yield* transition(current, current.prepared, "unknown", { reason: "dispatcher_interrupted" })).current;
  });
  /** Consumes consent BEFORE invoking work. Work receives the immutable stored payload,
   * never fresh model arguments. There is deliberately no reusable dispatch permit API. */
  const dispatch = <R>(input: { id: string; hash: string; payload: ApprovalJson; connectionId: string; connectionRevision: string }, work: (prepared: PreparedAction) => Effect.Effect<"succeeded" | "failed" | "unknown", unknown, R>) => Effect.gen(function* () {
    const exact = copy(input);
    const current = yield* get(exact.id);
    if (!current || current.prepared.hash !== exact.hash || canonical(current.prepared.payload) !== canonical(exact.payload) || current.prepared.connectionId !== exact.connectionId || current.prepared.connectionRevision !== exact.connectionRevision)
      return yield* Effect.fail(new ApprovalError("Exact payload and current connection revision required"));
    if (current.state !== "approved") return current;
    const fence = yield* transition(current, current.prepared, "dispatched");
    if (!fence.won || fence.current.state !== "dispatched") return fence.current;
    const result = yield* Effect.suspend(() => work(current.prepared)).pipe(Effect.catchCause(() => Effect.succeed("unknown" as const)));
    const latest = yield* read(exact.id);
    if (latest?.token !== fence.current.token) return latest!;
    return (yield* transition(latest, current.prepared, result === "succeeded" || result === "failed" ? "settled" : "unknown", result === "succeeded" || result === "failed" ? { outcome: result } : { reason: "uncertain_outcome" })).current;
  });
  /** authenticate must validate Mini App signature/session or verified Telegram sender,
   * ownership and request origin/CSRF before returning this principal. Never read it from JSON. */
  const handleDecision = (request: Request, authenticate: (request: Request) => Effect.Effect<{ owner: string; subject: string; authenticated: true } | undefined, unknown>) => Effect.gen(function* () {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const human = yield* authenticate(request).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (!human || human.authenticated !== true || human.owner !== owner) return new Response(null, { status: 403 });
    const decoded = yield* Effect.tryPromise<unknown>(() => request.json()).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return new Response(null, { status: 400 });
    const body = decoded as Record<string, unknown>;
    if (Object.keys(body).some(k => !["id", "hash", "decision"].includes(k)) || typeof body.id !== "string" || typeof body.hash !== "string" || (body.decision !== "approve" && body.decision !== "reject")) return new Response(null, { status: 400 });
    return yield* decide(human, { id: body.id, hash: body.hash, decision: body.decision }).pipe(Effect.map(state => Response.json(state, { headers: { "Cache-Control": "no-store" } })), Effect.catch(() => Effect.succeed(new Response(null, { status: 409 }))));
  });
  return { prepare, get, decide, cancel, markUnknown, dispatch, handleDecision };
}
