import { createHmac } from "node:crypto";
import type { Memory } from "entity-learn/cloudflare";
import type { MemoryAuthorityEvent, MemoryAuthorityState, MemoryAuthorityClaim } from "./memory-authority.ts";

export interface ErasureAuthorityPort {
  read(owner: string): Promise<MemoryAuthorityState | undefined>;
  /** Must confirm exact retained payload, including on duplicate append. */
  append(owner: string, event: MemoryAuthorityEvent): Promise<MemoryAuthorityState>;
  event(owner: string, key: string): Promise<MemoryAuthorityEvent | undefined>;
}
export interface MemoryErasureBinding extends ErasureAuthorityPort {
  owner: string;
  writer: number;
  erasureClaim(owner: string, receiptKey: string): Promise<MemoryAuthorityClaim | undefined>;
  /** Stable host HMAC, with key custody outside candidate archives. Never a model argument. */
  fingerprint(value: unknown): string;
}
export interface ErasureCleanupReceipt { status: "complete"; reference: string; digest: string }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Bind the independently retained registry key without exposing it in a log,
 * archive or control receipt. Canonical encoding also survives backend changes. */
export function memoryAuthorityFingerprint(secret: string) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw Error("Invalid independent memory authority key");
  const key = Buffer.from(secret, "hex");
  return (value: unknown) => createHmac("sha256", key).update(canonical(value)).digest("hex");
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const checkSignal = (signal?: AbortSignal) => { signal?.throwIfAborted(); };
type Input = Parameters<Memory["prepareSubjectErasure"]>[0];
const requestIdentity = (memory: Memory, input: Input) => ["aiko.erasure-request/v1", memory.scope, input.key, memory.prepareSubjectErasure(input)];
const snapshot = (memory: Memory, fingerprint: (value: unknown) => string) =>
  fingerprint(["aiko.erasure-before/v1", memory.exportArchive()]);

/** Native tool entry seam. Call under the owner gate, held through completion.
 * Resume resolves the original external claim by its native receipt, never by
 * subject/head search. It cannot mint permission for another deletion. */
export async function prepareMemoryErasure(options: {
  memory: Memory; authority: MemoryErasureBinding; input?: Input; resume?: string; signal?: AbortSignal;
}) {
  const { memory, authority, input, resume, signal } = options;
  checkSignal(signal);
  if (memory.scope !== `aiko:${authority.owner}` || !Number.isSafeInteger(authority.writer) || authority.writer < 1 || (!!input === !!resume))
    throw Error("Erasure authority identity mismatch");
  let claim: MemoryAuthorityClaim | undefined;
  if (resume) claim = await authority.erasureClaim(authority.owner, resume);
  else {
    const key = `erase:${input!.key}`;
    const retained = await authority.event(authority.owner, key);
    if (retained && retained.type !== "AikoMemoryAuthorityClaimed") throw Error("Erasure operation key conflict");
    claim = retained;
    if (!claim) {
      const current = await authority.read(authority.owner);
      checkSignal(signal);
      if (!current || current.owner !== authority.owner || current.scope !== memory.scope || current.writer !== authority.writer || current.pending)
        throw Error("Memory authority unavailable or busy");
      // No await between the native verified snapshot and immutable claim data.
      const prepared = memory.prepareSubjectErasure(input!);
      claim = { type: "AikoMemoryAuthorityClaimed", owner: authority.owner, scope: memory.scope, writer: authority.writer,
        key, at: Date.now(), expectedRevision: current.revision, kind: "erase", beforeFence: current.fence,
        fingerprint: authority.fingerprint(["aiko.erasure-claim/v1", key, prepared]),
        native: { tool: "memory_erase", callKey: input!.key, requestFingerprint: authority.fingerprint(requestIdentity(memory, input!)),
          receiptKey: prepared.receiptKey, requestDigest: prepared.requestDigest, beforeState: snapshot(memory, authority.fingerprint) } };
    }
  }
  checkSignal(signal);
  if (!claim || claim.owner !== authority.owner ||
      claim.writer > authority.writer || claim.native?.tool !== "memory_erase" ||
      resume && claim.native.receiptKey !== resume || input && claim.native?.requestFingerprint !== authority.fingerprint(requestIdentity(memory, input)))
    throw Error("Original erasure authority unavailable or changed");
  return memoryErasureAuthority({ ...options, claim, cleanupOnly: !!resume || claim.writer < authority.writer, fingerprint: authority.fingerprint });
}

/** No caller success boolean or missing receipt can release a claim. A verified
 * abort compares the complete canonical native archive (not only the erasure
 * fence) to the retained pre-claim HMAC. It attests native memory only. */
export function memoryErasureAuthority(options: {
  memory: Memory; authority: ErasureAuthorityPort; claim: MemoryAuthorityClaim;
  input?: Input; signal?: AbortSignal; fingerprint?: (value: unknown) => string; cleanupOnly?: boolean;
}) {
  const { memory, authority, signal, fingerprint } = options;
  const claim = structuredClone(options.claim), input = options.input && structuredClone(options.input);
  if (claim.kind !== "erase" || !claim.native || input && claim.native.callKey !== input.key || claim.scope !== memory.scope || claim.scope !== `aiko:${claim.owner}`)
    throw Error("Erasure authority identity mismatch");
  const prepared = input ? memory.prepareSubjectErasure(input) : claim.native;
  if (!prepared.receiptKey || !prepared.requestDigest) throw Error("Original native erasure identity unavailable");
  const receiptKey = prepared.receiptKey, requestDigest = prepared.requestDigest;
  if (claim.native.receiptKey && claim.native.receiptKey !== receiptKey || claim.native.requestDigest && claim.native.requestDigest !== requestDigest)
    throw Error("Erasure request conflicts with claim");
  const receipt = () => {
    const row = memory.subjectErasureReceipt(claim.native!.callKey);
    if (row && (row.event.key !== receiptKey || row.event.requestDigest !== requestDigest)) throw Error("Erasure receipt conflicts with original request");
    return row;
  };
  const pending = (state: MemoryAuthorityState | undefined) => {
    if (!state || state.owner !== claim.owner || state.scope !== claim.scope || state.writer !== claim.writer ||
      !same(state.pending, claim) || !same(state.fence, claim.beforeFence)) throw Error("Exact erasure claim is not pending");
  };
  const appendExact = async (event: MemoryAuthorityEvent) => {
    try { return await authority.append(claim.owner, event); }
    catch (error) {
      // Reconcile the exact retained event. Never retry a possibly changed terminal
      // or infer success from the current fence/revision alone.
      if (!same(await authority.event(claim.owner, event.key), event)) throw error;
      const state = await authority.read(claim.owner);
      if (!state) throw error;
      return state;
    }
  };
  let admitted = false;
  return {
    receiptKey,
    async prepare() {
      admitted = false;
      checkSignal(signal);
      const current = await authority.read(claim.owner);
      checkSignal(signal);
      if (current?.pending) pending(current);
      else {
        const terminal = await authority.event(claim.owner, `erase-complete:${claim.key}`);
        if (terminal?.type === "AikoMemoryAuthorityEraseCommitted" && terminal.claimKey === claim.key &&
            terminal.requestFingerprint === claim.native!.requestFingerprint && terminal.receipt.key === receiptKey &&
            terminal.receipt.requestDigest === requestDigest && receipt()) {
          if (!current || current.owner !== claim.owner || current.scope !== claim.scope || current.writer < claim.writer)
            throw Error("Erasure writer is fenced");
          return { deletionRequired: false };
        }
        if (options.cleanupOnly || !input || !current || current.owner !== claim.owner || current.scope !== claim.scope || current.writer !== claim.writer ||
            current.revision !== claim.expectedRevision || receipt() || !same(memory.erasureFence(), claim.beforeFence))
          throw Error("Erasure claim is no longer fresh");
        await appendExact(claim);
      }
      pending(await authority.read(claim.owner));
      checkSignal(signal);
      const prior = receipt();
      if (!prior) {
        if (options.cleanupOnly || !input) throw Error("Cleanup-only resume requires the original native receipt");
        memory.prepareSubjectErasure(input);
        if (!same(memory.erasureFence(), claim.beforeFence)) throw Error("Native before fence changed");
      }
      admitted = true;
      return { deletionRequired: !prior };
    },
    /** Synchronous: the caller must keep the owner gate after prepare. */
    erase() {
      checkSignal(signal);
      if (options.cleanupOnly || !admitted || !input) throw Error("Native deletion was not admitted");
      return memory.eraseSubject(input);
    },
    async abortUnchanged() {
      admitted = false;
      if (options.cleanupOnly) throw Error("Cleanup-only recovery cannot abort the original operation");
      // Cancellation is the reason to abort, not permission to skip verification.
      pending(await authority.read(claim.owner));
      if (!fingerprint || !claim.native!.beforeState || receipt() || !same(memory.erasureFence(), claim.beforeFence) ||
          snapshot(memory, fingerprint) !== claim.native!.beforeState) throw Error("Unchanged native state could not be verified");
      admitted = false;
      const event: MemoryAuthorityEvent = { type: "AikoMemoryAuthorityEraseAborted", owner: claim.owner, scope: claim.scope,
        writer: claim.writer, key: `erase-abort:${claim.key}`, at: claim.at, expectedRevision: claim.expectedRevision + 1, claimKey: claim.key,
        witness: { kind: "unchanged-native-state", fence: claim.beforeFence, callKey: claim.native!.callKey,
          requestFingerprint: claim.native!.requestFingerprint, reference: "native-archive-before-claim/v1", digest: claim.native!.beforeState } };
      return appendExact(event);
    },
    async complete(cleanup: ErasureCleanupReceipt) {
      checkSignal(signal);
      if (cleanup.status !== "complete" || !cleanup.reference || !/^[a-f0-9]{64}$/.test(cleanup.digest)) throw Error("Owner copy cleanup is not complete");
      const row = receipt();
      if (!row) throw Error("Original native erasure receipt unavailable");
      const retained = await authority.event(claim.owner, `erase-complete:${claim.key}`);
      checkSignal(signal);
      // Later erasures may advance the current fence. An exact old completion
      // remains historical; reconstruct its original fence, not today's state.
      const afterFence = retained?.type === "AikoMemoryAuthorityEraseCommitted" ? retained.afterFence : memory.erasureFence();
      if (row.seq !== afterFence.seq || row.digest !== afterFence.digest) throw Error("Native after fence changed");
      const event: MemoryAuthorityEvent = { type: "AikoMemoryAuthorityEraseCommitted", owner: claim.owner, scope: claim.scope,
        writer: claim.writer, key: `erase-complete:${claim.key}`, at: claim.at, expectedRevision: claim.expectedRevision + 1,
        claimKey: claim.key, requestFingerprint: claim.native!.requestFingerprint, operation: "erase-subject", afterFence,
        receipt: { key: row.event.key, seq: row.seq, digest: row.digest, requestDigest: row.event.requestDigest, scopeVersion: row.scopeVersion },
        cleanup: structuredClone(cleanup) };
      admitted = false;
      return appendExact(event);
    },
  };
}
