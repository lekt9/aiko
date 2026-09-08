import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1).max(512);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fence = z.object({ version: z.literal(1), scope: identity, seq: integer, digest }).strict()
  .refine(f => f.seq !== 0 || f.digest === "0".repeat(64));
const common = { at: z.number().finite(), owner: identity, scope: identity, writer: integer, key: identity, expectedRevision: integer };
const claim = z.object({ ...common, type: z.literal("AikoMemoryAuthorityClaimed"), kind: z.enum(["erase", "restore"]),
  fingerprint: digest, beforeFence: fence,
  native: z.object({ tool: identity, callKey: identity, requestFingerprint: digest,
    // Optional only for historical claims. Such claims cannot use verified abort.
    receiptKey: identity.optional(), requestDigest: digest.optional(), beforeState: digest.optional(),
  }).strict().optional() }).strict();
const nativeReceipt = z.object({ key: identity, seq: integer, digest, requestDigest: digest, scopeVersion: integer }).strict();
const schema = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("AikoMemoryAuthorityInitialized"), fence,
    bootstrap: z.object({ reference: identity, digest }).strict() }).strict(),
  z.object({ ...common, type: z.literal("AikoMemoryAuthorityWriterAdvanced"), nextWriter: integer }).strict(),
  claim,
  z.object({ ...common, type: z.literal("AikoMemoryAuthorityEraseCommitted"), claimKey: identity, afterFence: fence,
    requestFingerprint: digest, operation: z.enum(["erase", "erase-subject"]), receipt: nativeReceipt,
    cleanup: z.object({ status: z.literal("complete"), reference: identity, digest }).strict() }).strict(),
  z.object({ ...common, type: z.literal("AikoMemoryAuthorityEraseAborted"), claimKey: identity,
    witness: z.object({ kind: z.literal("unchanged-native-state"), fence, callKey: identity,
      requestFingerprint: digest, reference: identity, digest }).strict() }).strict(),
  z.object({ ...common, type: z.literal("AikoMemoryAuthorityRestoreSettled"), claimKey: identity,
    witness: z.object({ status: z.enum(["published", "cancelled"]), operationId: identity,
      fingerprint: digest, fence, reference: identity, digest }).strict() }).strict(),
]);
export type MemoryAuthorityEvent = z.infer<typeof schema>;
export type MemoryAuthorityClaim = z.infer<typeof claim>;
export interface MemoryAuthorityScope { owner: string; scope: string }
export interface MemoryAuthorityState extends MemoryAuthorityScope {
  revision: number;
  writer: number;
  fence: z.infer<typeof fence>;
  pending?: MemoryAuthorityClaim;
}
const prefix = "AikoMemoryAuthority";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(k =>
    `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
export { equal as sameMemoryAuthorityValue };
function authority(value: unknown): value is { type: string } {
  return !!value && typeof value === "object" && typeof (value as any).type === "string" && (value as any).type.startsWith(prefix);
}
export function memoryAuthorityEventKey(value: unknown): string | undefined {
  if (!authority(value)) return undefined;
  const event = schema.parse(value);
  return `aiko-memory-authority:${JSON.stringify([event.owner, event.scope, event.key])}`;
}
/** Trusted control journal only. This validates evidence shape and linkage, NOT
 * its truth. Claim native.callKey is the tool invocation identity, not the
 * entity-learn derived receipt key. requestFingerprint is a host immutable HMAC
 * of the request; the host must link the actual receipt to that request.
 * The host must verify native receipts/unchanged state/copy cleanup,
 * and remote publication or cancellation before appending a terminal. A boolean,
 * timeout, writer restart, or missing acknowledgement cannot release a claim.
 * The host must separately authenticate bootstrap, writer rotation and append.
 */
export function projectMemoryAuthority(history: readonly unknown[], scope: MemoryAuthorityScope): MemoryAuthorityState | undefined {
  let state: MemoryAuthorityState | undefined;
  const seen = new Map<string, MemoryAuthorityEvent>();
  for (const value of history) {
    if (!authority(value)) continue;
    const event = schema.parse(value);
    if (event.owner !== scope.owner || event.scope !== scope.scope) throw Error("Foreign memory authority event");
    const prior = seen.get(event.key);
    if (prior) {
      if (!equal(prior, event)) throw Error("Changed memory authority replay");
      continue;
    }
    if (event.expectedRevision !== (state?.revision ?? 0)) throw Error("Stale authority revision");
    if (event.type === "AikoMemoryAuthorityInitialized") {
      if (state || event.fence.scope !== scope.scope) throw Error("Invalid authority bootstrap");
      state = { ...scope, writer: event.writer, revision: 1, fence: event.fence };
    } else {
      if (!state || state.writer !== event.writer) throw Error("Stale authority writer");
      if (event.type === "AikoMemoryAuthorityWriterAdvanced") {
        if (state.pending || event.nextWriter <= state.writer) throw Error("Authority writer is fenced");
        state.writer = event.nextWriter;
      } else if (event.type === "AikoMemoryAuthorityClaimed") {
        if ((event.kind === "erase") !== !!event.native || state.pending || !equal(event.beforeFence, state.fence)) throw Error("Authority claim conflict");
        state.pending = event;
      } else {
        const pending = state.pending;
        if (!pending || pending.key !== event.claimKey) throw Error("Authority claim missing");
        if (event.type === "AikoMemoryAuthorityEraseCommitted") {
          if (pending.kind !== "erase" || event.afterFence.scope !== scope.scope ||
            event.afterFence.seq <= state.fence.seq || event.requestFingerprint !== pending.native?.requestFingerprint || event.receipt.seq !== event.afterFence.seq ||
            event.receipt.digest !== event.afterFence.digest ||
            pending.native?.receiptKey !== undefined && pending.native.receiptKey !== event.receipt.key ||
            pending.native?.requestDigest !== undefined && pending.native.requestDigest !== event.receipt.requestDigest)
            throw Error("Invalid native erase completion");
          state.fence = event.afterFence;
        } else if (event.type === "AikoMemoryAuthorityEraseAborted") {
          if (pending.kind !== "erase" || !equal(event.witness.fence, state.fence) ||
            event.witness.callKey !== pending.native?.callKey || event.witness.requestFingerprint !== pending.native?.requestFingerprint)
            throw Error("Invalid unchanged-state witness");
        } else if (pending.kind !== "restore" || event.witness.operationId !== pending.key ||
          event.witness.fingerprint !== pending.fingerprint || !equal(event.witness.fence, state.fence)) {
          throw Error("Invalid restore settlement");
        }
        delete state.pending;
      }
      state.revision++;
    }
    seen.set(event.key, event);
  }
  return state ? structuredClone(state) : undefined;
}
/** Atomic append guard: caller must supply ALL proposed events, including the
 * host's ThreadCreated, under its native append transaction. */
export function memoryAuthorityAppendAllowed(history: readonly unknown[], batch: readonly unknown[], scope: MemoryAuthorityScope): boolean {
  try {
    if (batch.some(e => !authority(e) && (!e || typeof e !== "object" || (e as {type?:unknown}).type !== "ThreadCreated"))) return false;
    projectMemoryAuthority([...history, ...batch], scope); return true; }
  catch { return false; }
}
