import { runSandboxJob, type SandboxJobBinding } from "./sandbox-job-runner.ts";
import { sandboxCanonical, sandboxDigest, type SandboxDigest, type SandboxJob, type SandboxJobReceipt } from "./sandbox-job.ts";
import type { ObservedHttpDispatch } from "./observed-network.ts";

export interface SandboxDispatchChallenge {
  status: "awaiting-dispatch";
  protocol: "host-request/v1";
  owner: string;
  operationId: string;
  jobDigest: SandboxDigest;
  requestDigest: SandboxDigest;
  stepId: string;
  attempt: number;
  nonce: string;
  expiresAt: number;
  /** Private request bytes. Carry only through the existing encrypted runner
   * channel; they are not public receipts or authority in their own right. */
  prepared: ObservedHttpDispatch;
}
export type SandboxDispatchReply = SandboxDispatchChallenge | { status: "receipt"; receipt: SandboxJobReceipt };
export interface SandboxDispatchDecision {
  owner: string;
  operationId: string;
  jobDigest: SandboxDigest;
  requestDigest: SandboxDigest;
  nonce: string;
  allow: boolean;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  // A job can finish while no RPC is awaiting its next reply.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
type Pending = { challenge: SandboxDispatchChallenge; permit: ReturnType<typeof deferred<void>> };
type Entry = { job: SandboxJob; digest: SandboxDigest; deadlineAt: number; cancellation: AbortController;
  reply: ReturnType<typeof deferred<SandboxDispatchReply>>; pending?: Pending; requests: number; aborted: boolean };

/** Owns an existing runSandboxJob future, never a durable dispatch queue. A
 * restart loses the nonce/continuation; the existing job claim then yields an
 * unknown receipt, rather than recreating a send. The host must authorize each
 * exact prepared request before issuing a one-use decision. */
export function createSandboxDispatch(binding: Omit<SandboxJobBinding, "beforeNetworkDispatch" | "send">, options: { maxPending?: number } = {}) {
  const maxPending = options.maxPending ?? 16;
  if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 64 || "send" in binding)
    throw Error("sandbox_dispatch_configuration_invalid");
  const entries = new Map<string, Entry>();
  let closed = false;
  const unknown = (entry: Entry): SandboxDispatchReply => ({ status: "receipt", receipt: {
    operationId: entry.job.operationId, jobDigest: entry.digest, harnessDigest: entry.job.harnessDigest,
    environmentDigest: entry.job.environmentDigest, status: "unknown", reason: "dispatch_continuation_cancelled",
    requests: entry.requests, browserStarts: 0,
  } });
  const abort = (entry: Entry) => {
    entry.aborted = true;
    entry.pending?.permit.reject(Error("sandbox_dispatch_cancelled")); entry.pending = undefined;
    entry.reply.resolve(unknown(entry));
    entry.reply = deferred<SandboxDispatchReply>(); entry.reply.resolve(unknown(entry));
    if (entries.get(entry.job.operationId) === entry) entries.delete(entry.job.operationId);
  };
  const reply = (entry: Entry) => entry.reply.promise.then(value => structuredClone(value));
  return {
    get pendingCount() { return entries.size; },
    async start(raw: SandboxJob, signal?: AbortSignal): Promise<SandboxDispatchReply> {
      signal?.throwIfAborted();
      if (closed) throw Error("sandbox_dispatch_closed");
      if (!raw || raw.owner !== binding.owner || raw.dispatch?.protocol !== "host-request/v1" ||
        raw.artifact?.kind !== "network" || !Number.isSafeInteger(raw.budget?.wallMs) || raw.budget.wallMs < 1 || raw.budget.wallMs > 30000 ||
        !Number.isSafeInteger(raw.budget.requests) || raw.budget.requests < 1 || raw.budget.requests > 96)
        throw Error("sandbox_dispatch_job_invalid");
      const encoded = sandboxCanonical(raw);
      if (Buffer.byteLength(encoded) > 1024 * 1024) throw Error("sandbox_dispatch_job_too_large");
      const job = JSON.parse(encoded) as SandboxJob, digest = await sandboxDigest(job);
      signal?.throwIfAborted();
      if (closed) throw Error("sandbox_dispatch_closed");
      const existing = entries.get(job.operationId);
      if (existing) {
        if (existing.digest !== digest) throw Error("sandbox_dispatch_identity_conflict");
        return reply(existing);
      }
      if (entries.size >= maxPending) throw Error("sandbox_dispatch_capacity");
      const cancellation = new AbortController();
      const entry: Entry = { job, digest, deadlineAt: Date.now() + job.budget.wallMs, cancellation,
        reply: deferred<SandboxDispatchReply>(), requests: 0, aborted: false };
      entries.set(job.operationId, entry);
      const timer = setTimeout(() => cancellation.abort(), job.budget.wallMs);
      const cancelled = () => cancellation.abort(signal?.reason);
      signal?.addEventListener("abort", cancelled, { once: true });
      cancellation.signal.addEventListener("abort", () => abort(entry), { once: true });
      const future = runSandboxJob(job, { ...binding, beforeNetworkDispatch: async (request, requestSignal) => {
        requestSignal.throwIfAborted();
        if (entry.aborted || closed || entries.get(job.operationId) !== entry || entry.pending ||
          entry.requests >= job.budget.requests || Date.now() >= entry.deadlineAt || request.jobDigest !== digest)
          throw Error("sandbox_dispatch_unavailable");
        const challenge: SandboxDispatchChallenge = { status: "awaiting-dispatch", protocol: "host-request/v1", owner: binding.owner,
          operationId: job.operationId, jobDigest: digest, requestDigest: request.requestDigest, stepId: request.stepId, attempt: request.attempt,
          nonce: crypto.randomUUID(), expiresAt: entry.deadlineAt, prepared: structuredClone(request.prepared) };
        const permit = deferred<void>(); entry.requests++; entry.pending = { challenge, permit };
        entry.reply.resolve(structuredClone(challenge));
        const interrupted = () => permit.reject(Error("sandbox_dispatch_cancelled"));
        requestSignal.addEventListener("abort", interrupted, { once: true });
        try { await permit.promise; requestSignal.throwIfAborted(); if (entry.aborted || closed || Date.now() >= entry.deadlineAt) throw Error("sandbox_dispatch_expired"); }
        finally { requestSignal.removeEventListener("abort", interrupted); }
      } }, cancellation.signal);
      void future.then(receipt => entry.reply.resolve({ status: "receipt", receipt }), error => entry.reply.reject(error)).finally(() => {
        clearTimeout(timer); signal?.removeEventListener("abort", cancelled);
        entry.pending?.permit.reject(Error("sandbox_dispatch_finished")); entry.pending = undefined;
        if (entries.get(job.operationId) === entry) entries.delete(job.operationId);
      });
      return reply(entry);
    },
    async continue(raw: SandboxDispatchDecision): Promise<SandboxDispatchReply> {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key =>
        !["owner", "operationId", "jobDigest", "requestDigest", "nonce", "allow"].includes(key)) ||
        raw.owner !== binding.owner || typeof raw.allow !== "boolean") throw Error("sandbox_dispatch_decision_invalid");
      const entry = entries.get(raw.operationId), pending = entry?.pending;
      if (closed || !entry || !pending || entry.aborted || entry.cancellation.signal.aborted || Date.now() >= entry.deadlineAt)
        throw Error("sandbox_dispatch_continuation_unavailable");
      if (raw.jobDigest !== entry.digest || raw.requestDigest !== pending.challenge.requestDigest || raw.nonce !== pending.challenge.nonce)
        throw Error("sandbox_dispatch_decision_conflict");
      // Consume before resolving the job. No await may separate this comparison
      // from consumption; replay cannot release the same request twice.
      entry.pending = undefined; entry.reply = deferred<SandboxDispatchReply>();
      if (raw.allow) pending.permit.resolve(); else pending.permit.reject(Error("sandbox_dispatch_denied"));
      return reply(entry);
    },
    close() { closed = true; for (const entry of entries.values()) entry.cancellation.abort(); },
  };
}
