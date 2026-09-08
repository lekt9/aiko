import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { MemoryError, type Memory, type MemoryStorage } from "entity-learn/cloudflare";
import { sameMemoryAuthorityValue as same, type MemoryAuthorityClaim, type MemoryAuthorityEvent } from "./memory-authority.ts";
import type { MemoryErasureBinding } from "./memory-erasure-authority.ts";
import { safeUserId } from "./security.ts";

const TABLE = "aiko_memory_execution";
type Closed = Extract<MemoryAuthorityEvent, { type: "AikoMemoryAuthorityWriteClosed" }>;
type Receipt = Closed["witness"];
type Execution = { claim: MemoryAuthorityClaim; token: string; version: number };

/** Native executor custody, not a second job scheduler. The existing registry
 * excludes competing work; this SQL token excludes late writes after closure.
 * Use ONE controller per native account connection and mount `guard` on EVERY
 * openGuardedMemory handle. Account archives must never import this table.
 * Callbacks may perform native memory work, not unrelated remote mutations. */
export function createMemoryWriteAuthority(options: {
  storage: MemoryStorage;
  memory(): Memory;
  authority: MemoryErasureBinding;
}) {
  const { storage, authority } = options, { owner, writer, fingerprint } = authority;
  if (!safeUserId(owner) || !Number.isSafeInteger(writer) || writer < 1) throw Error("Invalid memory executor identity");
  const scope = `aiko:${owner}`, context = new AsyncLocalStorage<Execution>();
  storage.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(scope TEXT NOT NULL,key TEXT NOT NULL,claim TEXT NOT NULL,token TEXT NOT NULL,receipt TEXT,PRIMARY KEY(scope,key))`);
  function fail(message: string): never { throw new MemoryError("forbidden", message); }
  const identity = (claim: MemoryAuthorityClaim) => {
    if (claim.owner !== owner || claim.scope !== scope || claim.writer > writer || options.memory().scope !== scope) fail("Foreign memory execution");
  };
  const row = (claim: MemoryAuthorityClaim) => storage.prepare(`SELECT claim,token,receipt FROM ${TABLE} WHERE scope=? AND key=?`).get(scope, claim.key);
  const stateDigest = () => fingerprint(["aiko.memory-execution-state/v1", options.memory().exportArchive()]);
  const seal = (claim: MemoryAuthorityClaim, value: Omit<Receipt, "digest">) => fingerprint(["aiko.memory-execution-closed/v1", claim, value]);
  const readReceipt = (claim: MemoryAuthorityClaim): Receipt | undefined => {
    identity(claim);
    const retained = row(claim);
    if (!retained) return undefined;
    if (!same(JSON.parse(String(retained.claim)), claim)) fail("Native execution identity changed");
    if (!retained.receipt) return undefined;
    const receipt = JSON.parse(String(retained.receipt)) as Receipt;
    const { digest, ...body } = receipt;
    if (retained.token !== "" || receipt.status !== "closed" || receipt.operationId !== claim.key ||
        receipt.fingerprint !== claim.fingerprint || seal(claim, body) !== digest ||
        !same(receipt.fence, options.memory().erasureFence()) || receipt.stateDigest !== stateDigest())
      fail("Native execution closure cannot be verified");
    return receipt;
  };
  const pending = async (claim: MemoryAuthorityClaim) => {
    identity(claim);
    const current = await authority.read(owner);
    if (!current || current.owner !== owner || current.scope !== scope || current.writer !== claim.writer ||
        !same(current.pending, claim) || !same(current.fence, claim.beforeFence)) fail("Exact memory execution claim is not pending");
  };
  const start = (claim: MemoryAuthorityClaim): Execution => storage.transaction(() => {
    identity(claim);
    if (claim.writer !== writer) fail("Older memory execution permits recovery only");
    if (row(claim)) fail("Original memory execution already started; do not repeat it");
    if (storage.prepare(`SELECT key FROM ${TABLE} WHERE scope=? AND token<>'' LIMIT 1`).get(scope)) fail("Another native memory execution remains active");
    const memory = options.memory(), version = memory.journal.scopeVersion(scope);
    if (!same(memory.erasureFence(), claim.beforeFence) && !(claim.kind === "restore" && version === 0))
      fail("Native memory does not match admission");
    const token = Buffer.from(randomBytes(32)).toString("hex");
    storage.prepare(`INSERT INTO ${TABLE}(scope,key,claim,token) VALUES(?,?,?,?)`).run(scope, claim.key, JSON.stringify(claim), token);
    return { claim: structuredClone(claim), token, version };
  });
  const close = (claim: MemoryAuthorityClaim, outcome: Receipt["outcome"], token?: string, unchanged?: () => void): Receipt => storage.transaction(() => {
    identity(claim);
    const retained = row(claim);
    // Missing custody is not evidence that an ordinary write stopped. Only the
    // erasure helper can supply its complete pre-state verification for abort.
    if (!retained && !unchanged) fail("Native memory execution custody unavailable");
    if (retained && !same(JSON.parse(String(retained.claim)), claim)) fail("Native execution identity changed");
    unchanged?.();
    if (retained?.receipt) return readReceipt(claim)!;
    if (token && retained?.token !== token) fail("Native memory execution token changed");
    const fence = options.memory().erasureFence();
    if (claim.kind !== "erase" && !same(fence, claim.beforeFence)) fail("Memory write cannot change the erasure fence");
    const body: Omit<Receipt, "digest"> = { status: "closed", operationId: claim.key, fingerprint: claim.fingerprint,
      fence, outcome, stateDigest: stateDigest(), reference: `native-memory-execution:${claim.key}` };
    const receipt: Receipt = { ...body, digest: seal(claim, body) };
    // Revocation and the verified native snapshot commit together. An old async
    // callback must re-read this row inside its next write transaction.
    storage.prepare(`INSERT INTO ${TABLE}(scope,key,claim,token,receipt) VALUES(?,?,?,'',?) ON CONFLICT(scope,key) DO UPDATE SET token='',receipt=excluded.receipt`)
      .run(scope, claim.key, JSON.stringify(claim), JSON.stringify(receipt));
    return receipt;
  });
  const active = (requested: string): Execution => {
    const current = context.getStore();
    if (!current || requested !== scope) return fail("Memory write has no executor admission");
    const retained = row(current.claim);
    if (!retained || retained.receipt || retained.token !== current.token || !same(JSON.parse(String(retained.claim)), current.claim))
      return fail("Memory execution is closed or fenced");
    return current;
  };
  const appendExact = async (event: MemoryAuthorityEvent) => {
    try { await authority.append(owner, event); }
    catch (error) { if (!same(await authority.event(owner, event.key), event)) throw error; }
  };
  const settle = async (claim: MemoryAuthorityClaim) => {
    const key = `write-closed:${claim.key}`, retained = await authority.event(owner, key);
    if (retained) {
      if (retained.type !== "AikoMemoryAuthorityWriteClosed" || retained.claimKey !== claim.key ||
          retained.writer !== claim.writer || retained.owner !== owner || retained.scope !== scope ||
          retained.expectedRevision !== claim.expectedRevision + 1 || retained.witness.fingerprint !== claim.fingerprint)
        fail("Native write settlement changed");
      return { status: "closed" as const, receipt: retained.witness };
    }
    await pending(claim);
    const receipt = storage.read(() => readReceipt(claim));
    if (!receipt) return { status: "pending" as const };
    await appendExact({ type: "AikoMemoryAuthorityWriteClosed", owner, scope, writer: claim.writer, key, at: claim.at,
      expectedRevision: claim.expectedRevision + 1, claimKey: claim.key, witness: receipt });
    return { status: "closed" as const, receipt };
  };
  const exclusive = async <T>(claim: MemoryAuthorityClaim, run: () => Promise<T> | T): Promise<T> => {
    await pending(claim);
    const execution = start(claim);
    let outcome: Receipt["outcome"] = "failed";
    try {
      const result = await context.run(execution, run);
      outcome = "returned";
      return result;
    } finally { close(claim, outcome, execution.token); }
  };
  return {
    guard: {
      check: (requested: string) => { active(requested); },
      after: (requested: string) => {
        const { claim, version } = active(requested), memory = options.memory();
        if (claim.kind !== "erase" && !same(memory.erasureFence(), claim.beforeFence)) fail("Memory write cannot change the erasure fence");
        if (claim.kind === "write" && memory.journal.scopeVersion(scope) < version) fail("Memory write cannot roll back native history");
      },
    },
    /** For already-admitted erasure/import: wrap NATIVE mutation only, then use
     * its existing receipt/cleanup settlement. Never settle inside this callback. */
    exclusive,
    /** Verify the original native import and revoke its executor token in ONE
     * native transaction, before the external restore claim can be settled. */
    async fencePublication<T>(claim: MemoryAuthorityClaim, verify: () => T | undefined): Promise<T | undefined> {
      if (claim.kind !== "restore") fail("Not a native restore execution");
      await pending(claim);
      return storage.transaction(() => {
        const receipt = verify();
        if (receipt === undefined) return undefined;
        close(claim, "interrupted");
        return receipt;
      });
    },
    /** Verify and durably fence under the same native transaction before an
     * erasure abort. Caller must hold the owner gate and supply exact pre-state
     * verification; missing ordinary-write custody can never use this path. */
    async fenceErasure(claim: MemoryAuthorityClaim, unchanged: () => void) {
      if (claim.kind !== "erase" || claim.writer !== writer) fail("Erasure abort authority unavailable");
      await pending(claim);
      close(claim, "interrupted", undefined, unchanged);
    },
    async write<T>(operationId: string, request: unknown, run: () => Promise<T> | T): Promise<T> {
      if (!operationId || operationId.length > 350) fail("Invalid native memory operation identity");
      const key = `write:${operationId}`, requestDigest = fingerprint(["aiko.memory-write-request/v1", owner, key, request]);
      const prior = await authority.event(owner, key);
      if (prior) {
        if (prior.type !== "AikoMemoryAuthorityClaimed" || prior.kind !== "write" || prior.fingerprint !== requestDigest)
          fail("Memory write operation key conflict");
        fail("Original memory write requires receipt-only recovery; it cannot execute again");
      }
      const current = await authority.read(owner);
      if (!current || current.owner !== owner || current.scope !== scope || current.writer !== writer || current.pending)
        fail("Current memory writer authority unavailable or busy");
      const claim: MemoryAuthorityClaim = { type: "AikoMemoryAuthorityClaimed", owner, scope, writer, key, at: Date.now(),
        expectedRevision: current.revision, kind: "write", fingerprint: requestDigest, beforeFence: current.fence };
      await appendExact(claim);
      try { return await exclusive(claim, run); }
      finally { await settle(claim); }
    },
    /** No execution/retry. `fence` is an explicit native-memory-only recovery
     * action: revoke the old token BEFORE releasing its independent claim. */
    async reconcile(operationId: string, options: { fence?: boolean } = {}) {
      if (!operationId || operationId.length > 350) fail("Invalid native memory operation identity");
      const claim = await authority.event(owner, `write:${operationId}`);
      if (!claim || claim.type !== "AikoMemoryAuthorityClaimed" || claim.kind !== "write") fail("Original write claim unavailable");
      const original = claim;
      const observed = await settle(original);
      if (observed.status === "closed" || !options.fence) return observed;
      await pending(original);
      close(original, "interrupted");
      return settle(original);
    },
  };
}
