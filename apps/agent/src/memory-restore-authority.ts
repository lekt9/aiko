import type { ErasureFence } from "entity-learn/cloudflare";
import { safeUserId } from "./security.ts";
import { sameMemoryAuthorityValue as same, type MemoryAuthorityClaim, type MemoryAuthorityEvent, type MemoryAuthorityState } from "./memory-authority.ts";
import type { ErasureAuthorityPort } from "./memory-erasure-authority.ts";

type Settlement = Extract<MemoryAuthorityEvent, { type: "AikoMemoryAuthorityRestoreSettled" }>;
export type MemoryPublicationReceipt = Settlement["witness"];
export interface MemoryPublicationReader {
  /** Read and verify executor custody for this EXACT operation. It must not
   * stage, publish, cancel, retry, start a VM or infer a result from absence.
   * A cancelled receipt must durably fence any later publication. */
  receipt(request: { owner: string; operationId: string; fingerprint: string; fence: ErasureFence }): Promise<MemoryPublicationReceipt | undefined>;
}

/** The existing registry restore claim is the exclusive admission, not a new
 * workflow state machine. Hold the local owner gate for every use. Native
 * account import and executor publication remain their own transactions.
 * Unknown results retain the claim indefinitely; only verified exact executor
 * custody can settle it. Missing executor support refuses new staging. */
export async function memoryRestoreAdmission(options: {
  owner: string;
  writer: number;
  authority: ErasureAuthorityPort;
  operationId: string;
  /** Host HMAC of mode, immutable archive/manifest and target identity,
   * including the executor's exact request digest when encoding is significant. */
  fingerprint: string;
  publication?: MemoryPublicationReader;
  signal?: AbortSignal;
}) {
  const { owner, writer, authority, operationId, fingerprint, publication, signal } = options;
  const scope = `aiko:${owner}`;
  if (!safeUserId(owner) || !Number.isSafeInteger(writer) || writer < 1 || !operationId || operationId.length > 400 || !/^[a-f0-9]{64}$/.test(fingerprint))
    throw Error("Invalid restore authority identity");
  signal?.throwIfAborted();
  const key = `restore:${operationId}`, retained = await authority.event(owner, key);
  if (retained && (retained.type !== "AikoMemoryAuthorityClaimed" || retained.kind !== "restore" ||
      retained.owner !== owner || retained.scope !== scope || retained.writer > writer || retained.fingerprint !== fingerprint))
    throw Error("Restore operation key conflict");
  const state = await authority.read(owner);
  if (!state || state.owner !== owner || state.scope !== scope || state.writer > writer ||
      (!retained && state.writer !== writer) || retained && state.writer < retained.writer)
    throw Error("Restore writer authority unavailable");
  const claim: MemoryAuthorityClaim = (retained as MemoryAuthorityClaim | undefined) ?? {
    type: "AikoMemoryAuthorityClaimed", owner, scope, writer, key, at: Date.now(), expectedRevision: state.revision,
    kind: "restore", fingerprint, beforeFence: structuredClone(state.fence),
  };
  const terminalKey = `restore-settled:${key}`;
  const current = (value: MemoryAuthorityState | undefined) => {
    if (!value || value.owner !== owner || value.scope !== scope || value.writer !== claim.writer ||
        !same(value.pending, claim) || !same(value.fence, claim.beforeFence)) throw Error("Exact restore claim is not pending");
    return value;
  };
  const matching = (receipt: MemoryPublicationReceipt) => {
    if (!receipt || !["published", "cancelled"].includes(receipt.status) || receipt.operationId !== key ||
        receipt.fingerprint !== fingerprint || !same(receipt.fence, claim.beforeFence) ||
        !receipt.reference || receipt.reference.length > 512 || !/^[a-f0-9]{64}$/.test(receipt.digest))
      throw Error("Publication receipt does not match restore authority");
  };
  const terminal = async () => {
    const event = await authority.event(owner, terminalKey);
    if (event) {
      if (event.type !== "AikoMemoryAuthorityRestoreSettled" || event.owner !== owner || event.scope !== scope ||
          event.writer !== claim.writer || event.claimKey !== key || event.expectedRevision !== claim.expectedRevision + 1)
        throw Error("Restore settlement conflicts with original claim");
      matching(event.witness);
      return event;
    }
  };
  const appendExact = async (event: MemoryAuthorityEvent) => {
    try { return await authority.append(owner, event); }
    catch (error) {
      if (!same(await authority.event(owner, event.key), event)) throw error;
      const observed = await authority.read(owner);
      if (!observed) throw error;
      return observed;
    }
  };
  return {
    operationId: key,
    fence: structuredClone(claim.beforeFence),
    /** Historical terminal is metadata, never new permission to stage/publish. */
    async prepare(): Promise<{ status: "admitted" | "published" | "cancelled" }> {
      signal?.throwIfAborted();
      const done = await terminal();
      if (done) {
        const live = await authority.read(owner);
        if (!live || live.owner !== owner || live.scope !== scope || live.writer < claim.writer || live.writer > writer || live.pending ||
            !same(live.fence, claim.beforeFence)) throw Error("Restore checkpoint is no longer current");
        signal?.throwIfAborted();
        return { status: done.witness.status };
      }
      if (claim.writer !== writer) throw Error("Older restore permits receipt reconciliation only");
      if (!publication) throw Error("Verified publication recovery is unavailable; restore cannot stage");
      const observed = await authority.read(owner);
      if (observed?.pending) current(observed);
      else {
        if (retained || !observed || observed.owner !== owner || observed.scope !== scope || observed.writer !== writer ||
            observed.revision !== claim.expectedRevision || !same(observed.fence, claim.beforeFence)) throw Error("Restore claim is no longer fresh");
        await appendExact(claim);
      }
      current(await authority.read(owner));
      signal?.throwIfAborted();
      return { status: "admitted" };
    },
    /** Recheck after every awaited transfer and immediately before local/native
     * import or remote dispatch. The executor must also enforce its own fence. */
    async check() {
      if (claim.writer !== writer) throw Error("Older restore permits receipt reconciliation only");
      signal?.throwIfAborted();
      current(await authority.read(owner));
      signal?.throwIfAborted();
    },
    /** Reconciliation only. No external mutation and no caller success boolean. */
    async reconcile(): Promise<{ status: "pending" | "published" | "cancelled" }> {
      const done = await terminal();
      if (done) return { status: done.witness.status };
      current(await authority.read(owner));
      if (!publication) return { status: "pending" };
      const receipt = await publication.receipt({ owner, operationId: key, fingerprint, fence: structuredClone(claim.beforeFence) });
      if (!receipt) return { status: "pending" };
      matching(receipt);
      // The read may outlive a revoked writer or another settlement. Preserve
      // its original uncertainty unless the exact retained event confirms it.
      const event: Settlement = { type: "AikoMemoryAuthorityRestoreSettled", owner, scope, writer: claim.writer, key: terminalKey,
        at: claim.at, expectedRevision: claim.expectedRevision + 1, claimKey: key, witness: structuredClone(receipt) };
      await appendExact(event);
      return { status: receipt.status };
    },
  };
}
