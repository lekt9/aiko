import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { createHash } from "node:crypto";
import { createCloudflareAccountHost } from "../src/cloudflare-host.ts";
import { memoryRestoreAdmission } from "../src/memory-restore-authority.ts";
import { nativeMemoryImportPublication } from "../src/memory-import-publication.ts";
import { Self } from "tardie/core/runtime";
import { cloudflareStorage, type Memory } from "entity-learn/cloudflare";
import { openMemoryAuthorityRegistry } from "../src/memory-authority-node.ts";
import { createMemoryWriteAuthority } from "../src/memory-write-authority.ts";
import { memoryRestoreGate, openGuardedMemory } from "../src/memory-restore.ts";
import { prepareMemoryErasure } from "../src/memory-erasure-authority.ts";
import { memoryTools, type MemoryBinding, type MemoryReceipt } from "../src/memory.ts";
import { memoryTestAuthority } from "./memory-authority-fixture.ts";

const write = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "synthetic-native-write" } });
const fact = (subject: string) => ({ subject, title: subject, type: "fact", payload: `synthetic-${subject}` });
function accountStorage(db: Database) {
  return { sql: { exec(query: string, ...args: (string | number | null | ArrayBuffer)[]) {
    const rows = !args.length && query.trimStart().startsWith("CREATE") ? (db.exec(query), []) : db.query(query).all(...args as never[]);
    return { toArray: () => rows as never, [Symbol.iterator]: () => (rows as Record<string, never>[])[Symbol.iterator]() };
  } }, transactionSync: <T>(run: () => T) => db.transaction(run)(), sync: async () => {},
    getAlarm: async () => null, setAlarm: async () => { throw Error("fixture cannot schedule"); }, deleteAlarm: async () => {} };
}
const storage = (db: Database) => cloudflareStorage(accountStorage(db));
async function fixture() {
  const dir = await mkdtemp("/tmp/memory-write-authority-");
  const registry = await openMemoryAuthorityRegistry(join(dir, "independent/authority.sqlite"), 1);
  await registry.admit("123");
  const db = new Database(join(dir, "native.sqlite")); db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  const native = storage(db), authority = await registry.binding("123");
  let memory: Memory;
  const controller = createMemoryWriteAuthority({ storage: native, memory: () => memory, authority });
  memory = openGuardedMemory({ storage: native, scope: "aiko:123", writeAuthority: controller.guard });
  return { dir, db, native, memory, registry, authority, controller,
    async close() { memory.close(); db.close(); await registry.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("guard and snapshot must share the exact native connection; per-call handles cannot close host custody", async () => {
  const f = await fixture(), otherDb = new Database(join(f.dir, "native.sqlite")), other = storage(otherDb);
  try {
    expect(() => openGuardedMemory({ storage: other, scope: "aiko:123", writeAuthority: f.controller.guard })).toThrow("same native connection");
    const wrong = openGuardedMemory({ storage: other, scope: "aiko:123" });
    const controller = createMemoryWriteAuthority({ storage: f.native, memory: () => wrong, authority: f.authority });
    await expect(controller.write("wrong-connection", {}, () => wrong.remember(fact("wrong"), write("wrong")))).rejects.toThrow("same native connection");
    expect((await f.registry.read("123"))?.pending).toBeUndefined();
    expect(() => nativeMemoryImportPublication({ owner: "123", memory: f.memory, storage: other, operationId: "restore:wrong", fingerprint: "a".repeat(64),
      importId: "wrong", archive: {}, histories: [], history: () => [] })).toThrow("same native connection");
    wrong.close();
    let closed = false;
    const borrowed = { ...f.native, close: () => { closed = true; } };
    openGuardedMemory({ storage: borrowed, scope: "aiko:123", closeStorage: false }).close();
    expect(closed).toBe(false);
  } finally { otherDb.close(); await f.close(); }
});

test("an asynchronous authority callback cannot silently authorize a native transaction", async () => {
  const f = await fixture();
  try {
    const before = f.memory.exportArchive();
    for (const phase of ["check", "after"] as const) {
      const memory = openGuardedMemory({ storage: f.native, scope: "aiko:123", writeAuthority: { storage: f.native, check() {}, after() {}, [phase]: async () => {} } });
      expect(() => memory.remember(fact("not-authorized"), write("async-guard"))).toThrow("synchronous");
      expect(memory.exportArchive()).toEqual(before); memory.close();
    }
  } finally { await f.close(); }
});

test("native writes require exact executor custody; async admission excludes restore and writer handoff", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    expect(() => f.memory.remember(fact("denied"), write("denied"))).toThrow("admission");
    let calls = 0;
    const work = f.controller.write("source-one", { source: "fixture" }, async () => {
      calls++; f.memory.remember(fact("before-await"), write("before-await")); entered.resolve();
      await release.promise;
      return f.memory.remember(fact("after-await"), write("after-await"));
    });
    await entered.promise;
    const state = (await f.registry.read("123"))!;
    expect(state.pending?.kind).toBe("write");
    await expect(f.registry.append("123", { type: "AikoMemoryAuthorityClaimed", owner: "123", scope: "aiko:123", writer: 1,
      key: "competing-restore", kind: "restore", at: 1, expectedRevision: state.revision, fingerprint: "a".repeat(64), beforeFence: state.fence })).rejects.toThrow();
    const next = await openMemoryAuthorityRegistry(join(f.dir, "independent/authority.sqlite"), 2);
    try { await expect(next.advanceWriter("123")).rejects.toThrow("fenced"); } finally { await next.close(); }
    release.resolve(); expect((await work).subject).toBe("after-await");
    expect((await f.registry.read("123"))?.pending).toBeUndefined();
    const before = f.memory.exportArchive();
    await expect(f.controller.write("source-one", { source: "fixture" }, () => { calls++; })).rejects.toThrow("receipt-only");
    await expect(f.controller.write("source-one", { source: "changed" }, () => { calls++; })).rejects.toThrow("key conflict");
    expect((await f.controller.reconcile("source-one")).status).toBe("closed");
    expect(f.memory.exportArchive()).toEqual(before); expect(calls).toBe(1);
  } finally { release.resolve(); await f.close(); }
});

test("a second native connection fences an interrupted writer before release; its late callback cannot write", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let second: Database | undefined, next: Awaited<ReturnType<typeof openMemoryAuthorityRegistry>> | undefined;
  const running = f.controller.write("interrupted", {}, async () => {
    f.memory.remember(fact("committed-part"), write("committed-part")); entered.resolve();
    await release.promise;
    f.memory.remember(fact("must-not-return"), write("must-not-return"));
  }).then(() => undefined, error => error as Error);
  try {
    await entered.promise;
    next = await openMemoryAuthorityRegistry(join(f.dir, "independent/authority.sqlite"), 2);
    second = new Database(join(f.dir, "native.sqlite"));
    const native = storage(second); let memory: Memory;
    const recovery = createMemoryWriteAuthority({ storage: native, memory: () => memory, authority: await next.binding("123") });
    memory = openGuardedMemory({ storage: native, scope: "aiko:123", writeAuthority: recovery.guard });
    const before = memory.exportArchive();
    expect(await recovery.reconcile("interrupted")).toEqual({ status: "pending" });
    await expect(next.advanceWriter("123")).rejects.toThrow("fenced");
    const settled = await recovery.reconcile("interrupted", { fence: true });
    expect(settled).toMatchObject({ status: "closed", receipt: { outcome: "interrupted" } });
    expect((await next.advanceWriter("123")).writer).toBe(2);
    release.resolve(); expect(String(await running)).toContain("closed or fenced");
    expect(memory.exportArchive()).toEqual(before);
    await recovery.write("new-generation", {}, () => memory.remember(fact("new-generation"), write("new-generation")));
    expect(memory.scan().items.some(item => item.observation.subject === "must-not-return")).toBe(false);
    memory.close();
  } finally { release.resolve(); await running; second?.close(); await next?.close(); await f.close(); }
});

test("missing native execution custody after account loss cannot release a pending writer", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const running = f.controller.write("lost-native", {}, async () => { entered.resolve(); await release.promise; }).catch(() => {});
  try {
    await entered.promise;
    f.db.exec("DELETE FROM aiko_memory_execution"); // Controlled account-state loss, not cancellation.
    expect(await f.controller.reconcile("lost-native")).toEqual({ status: "pending" });
    await expect(f.controller.reconcile("lost-native", { fence: true })).rejects.toThrow("custody unavailable");
    expect((await f.registry.read("123"))?.pending?.key).toBe("write:lost-native");
  } finally { release.resolve(); await running; await f.close(); }
});

test("native closure persists across failed external acknowledgement; changed closure and unauthorized erasure fail", async () => {
  const f = await fixture();
  try {
    let loseAck = true;
    const port = { ...f.authority, append: async (...args: Parameters<typeof f.authority.append>) => {
      const result = await f.authority.append(...args);
      if (loseAck && args[1].type === "AikoMemoryAuthorityWriteClosed") throw Error("controlled lost settlement acknowledgement");
      return result;
    } };
    // Same native connection; mount this controller on its own memory handle.
    let memory: Memory;
    const controller = createMemoryWriteAuthority({ storage: f.native, memory: () => memory, authority: port });
    memory = openGuardedMemory({ storage: f.native, scope: "aiko:123", writeAuthority: controller.guard });
    const target = await controller.write("first", {}, () => memory.remember(fact("target"), write("target")));
    expect((await f.registry.read("123"))?.pending).toBeUndefined(); loseAck = false;
    const before = memory.exportArchive();
    await expect(controller.write("not-an-erase", {}, () => memory.eraseSubject({ subject: target.subject, expectedHead: target.id,
      expectedScopeVersion: memory.scan().sourceVersion, key: "wrong-grant" }))).rejects.toThrow("erasure fence");
    expect(memory.exportArchive()).toEqual(before);
    const terminal = (await f.registry.event("123", "write-closed:write:first"))!;
    if (terminal.type !== "AikoMemoryAuthorityWriteClosed") throw Error("fixture terminal missing");
    await expect(f.registry.append("123", { ...terminal, witness: { ...terminal.witness, outcome: "interrupted" } })).rejects.toThrow();
    memory.close();
  } finally { await f.close(); }
});

test("failed native closure acknowledgement holds admission; recovery never repeats the committed write", async () => {
  const f = await fixture(); let calls = 0;
  try {
    f.db.exec("CREATE TRIGGER reject_closure BEFORE INSERT ON aiko_memory_execution WHEN NEW.receipt IS NOT NULL BEGIN SELECT RAISE(ABORT,'closure failure'); END");
    await expect(f.controller.write("closure-failed", {}, () => { calls++; return f.memory.remember(fact("retained"), write("retained")); })).rejects.toThrow("closure failure");
    const before = f.memory.exportArchive();
    expect(await f.controller.reconcile("closure-failed")).toEqual({ status: "pending" });
    await expect(f.controller.reconcile("closure-failed", { fence: true })).rejects.toThrow("closure failure");
    expect((await f.registry.read("123"))?.pending?.key).toBe("write:closure-failed");
    f.db.exec("DROP TRIGGER reject_closure");
    expect(await f.controller.reconcile("closure-failed", { fence: true })).toMatchObject({ status: "closed", receipt: { outcome: "interrupted" } });
    expect(f.memory.exportArchive()).toEqual(before); expect(calls).toBe(1);
    expect(f.memory.scan().items.some(item => item.observation.subject === "retained")).toBe(true);
  } finally { await f.close(); }
});

test("actual native tools use all-write admission and explicit native erasure custody without bypass", async () => {
  const f = await fixture(), copies = memoryTestAuthority(f.dir), gate = memoryRestoreGate();
  try {
    const binding: MemoryBinding = { owner: "123", thread: "user-123", stateDir: f.dir, redact: s => s, readPage: async () => [],
      openMemory: () => f.memory, withErasure: gate,
      withMemory: (request, run) => gate(() => f.controller.write(request.key, { operation: request.operation, input: request.input }, run, request.nativeReceiptRead ? run : undefined)),
      erasureAuthority: { ...f.authority, withNativeMutation: f.controller.exclusive, fenceNativeErasure: f.controller.fenceErasure },
      eraseCopies: copies.binding("123").eraseCopies };
    const invoke = async (name: string, args: unknown, id: string) => Effect.runPromise(memoryTools(binding, { fixtures: false }).find(t => t.spec.name === name)!
      .run(args, { callId: id, signal: new AbortController().signal }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: "user-123" }))) as Promise<MemoryReceipt>;
    const saved = await invoke("memory_remember", fact("tool-fact"), "remember"); expect(saved.outcome).toBe("ok");
    const beforeRead = await f.registry.read("123");
    const scanned = await invoke("memory_scan", {}, "scan");
    expect(scanned.outcome).toBe("ok");
    expect(await invoke("memory_scan", {}, "scan")).toEqual(scanned);
    expect(await f.registry.read("123")).toEqual(beforeRead);
    const remembered = f.memory.exportArchive();
    expect(await invoke("memory_remember", fact("tool-fact"), "remember")).toEqual(saved);
    expect(f.memory.exportArchive()).toEqual(remembered);
    const row = saved.result as { subject: string; id: string };
    expect(f.memory.get(row.id)).not.toBeNull();
    const erased = await invoke("memory_erase", { subject: row.subject, expected: row.id, expectedScopeVersion: f.memory.scan().sourceVersion }, "erase");
    expect(erased.outcome).toBe("ok"); expect(f.memory.get(row.id)).toBeNull();
    const currentRead = await invoke("memory_scan", {}, "scan");
    expect(currentRead.outcome).toBe("ok");
    expect(currentRead.result).toMatchObject({ items: [] });
    const after = f.memory.exportArchive();
    expect((await invoke("memory_remember", fact("tool-fact"), "remember")).outcome).toBe("error");
    expect(f.memory.exportArchive()).toEqual(after);
    expect((await f.registry.read("123"))?.pending).toBeUndefined();
    expect(() => f.memory.remember(fact("direct-unadmitted"), write("direct-unadmitted"))).toThrow("admission");
  } finally { await copies.close(); await f.close(); }
});

test("a native tool cancelled while waiting for owner admission cannot write", async () => {
  const f = await fixture(), gate = memoryRestoreGate(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>();
  const blocker = gate(async () => { entered.resolve(); await release.promise; });
  try {
    const binding: MemoryBinding = { owner: "123", thread: "user-123", stateDir: f.dir, redact: s => s, readPage: async () => [], openMemory: () => f.memory,
      withMemory: (request, run) => { queued.resolve(); return gate(() => f.controller.write(request.key, request.input, run)); } };
    await entered.promise;
    const cancellation = new AbortController();
    const pending = Effect.runPromise(memoryTools(binding, { fixtures: false }).find(t => t.spec.name === "memory_remember")!
      .run(fact("cancelled"), { callId: "cancelled", signal: cancellation.signal }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: "user-123" }))) as Promise<MemoryReceipt>;
    await queued.promise; cancellation.abort(); release.resolve(); await blocker;
    expect((await pending).outcome).toBe("error");
    expect(f.memory.scan().items).toEqual([]);
    expect((await f.registry.read("123"))?.pending).toBeUndefined();
  } finally { release.resolve(); await blocker; await f.close(); }
});

test("a declared receipt reader cannot mutate native memory or execute the original writer", async () => {
  const f = await fixture(); let writes = 0;
  try {
    await f.controller.write("original", {}, () => { writes++; return f.memory.remember(fact("original"), write("original")); });
    const before = f.memory.exportArchive();
    await expect(f.controller.write("original", {}, () => { writes++; }, () => { f.memory.remember(fact("not-a-receipt"), write("not-a-receipt")); })).rejects.toThrow("cannot mutate");
    expect(f.memory.exportArchive()).toEqual(before); expect(writes).toBe(1);
    expect((await f.registry.read("123"))?.pending).toBeUndefined();
  } finally { await f.close(); }
});

test("native import receipt verification fences its still-running executor before releasing restore authority", async () => {
  const f = await fixture(), sourceDb = new Database(":memory:");
  const hostOptions = { actorName: "aiko", actorInstance: "write-import", ownsThread: (t: string) => t === "user-123", actorFor: () => undefined, layersFor: () => Layer.empty };
  const sourceHost = await createCloudflareAccountHost({ ...hostOptions, storage: accountStorage(sourceDb) });
  const host = await createCloudflareAccountHost({ ...hostOptions, storage: accountStorage(f.db) });
  const source = openGuardedMemory({ storage: storage(sourceDb), scope: "aiko:123" });
  const zero = (await f.registry.read("123"))!.fence;
  const memory = openGuardedMemory({ storage: f.native, scope: "aiko:123", restoreAuthority: () => zero, writeAuthority: f.controller.guard });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let running: Promise<Error | undefined> | undefined;
  try {
    const original = source.remember(fact("imported"), write("imported"));
    await sourceHost.seed("user-123", [{ type: "Archived", id: "source", at: 1 }]);
    const archive = source.exportArchive(), histories = sourceHost.exportHistory(), importId = "joined-import";
    const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    const fingerprint = f.authority.fingerprint(["native-import", "123", importId, sha([histories, sha(archive)])]);
    let lease: Awaited<ReturnType<typeof memoryRestoreAdmission>>;
    const publication = nativeMemoryImportPublication({ owner: "123", memory, storage: f.native, importId, operationId: `restore:${importId}`, fingerprint,
      archive, histories, history: host.exportHistory, withExecutionFence: verify => f.controller.fencePublication(lease.claim, verify) });
    lease = await memoryRestoreAdmission({ owner: "123", writer: 1, authority: f.authority, operationId: importId, fingerprint, publication });
    await lease.prepare(); expect(await lease.reconcile()).toEqual({ status: "pending" });
    let imports = 0;
    running = f.controller.exclusive(lease.claim, async () => {
      await host.importHistory(importId, histories, { fingerprint: sha(archive), import: () => { imports++; memory.importArchive(archive); } });
      entered.resolve(); await release.promise;
      memory.remember(fact("late-import-write"), write("late-import-write"));
    }).then(() => undefined, error => error as Error);
    await entered.promise;
    const before = memory.exportArchive();
    for (const withExecutionFence of [undefined, async <T>(verify: () => T | undefined) => verify()]) {
      const unguarded = nativeMemoryImportPublication({ owner: "123", memory, storage: f.native, importId, operationId: `restore:${importId}`, fingerprint,
        archive, histories, history: host.exportHistory, withExecutionFence });
      await expect(unguarded.receipt({ owner: "123", operationId: `restore:${importId}`, fingerprint, fence: zero })).rejects.toThrow("not durably fenced");
      expect((await f.registry.read("123"))?.pending?.kind).toBe("restore");
    }
    expect(await lease.reconcile()).toEqual({ status: "published" });
    expect((await f.registry.read("123"))?.pending).toBeUndefined();
    release.resolve(); expect(String(await running)).toContain("closed or fenced");
    expect(memory.exportArchive()).toEqual(before); expect(host.exportHistory()).toEqual(histories);
    expect(memory.get(original.id)?.observation.payload).toBe("synthetic-imported"); expect(imports).toBe(1);
  } finally {
    release.resolve(); await running; memory.close(); source.close(); await host.close(); await sourceHost.close(); sourceDb.close(); await f.close();
  }
});

test("verified erasure abort installs a durable native fence before releasing the claim", async () => {
  const f = await fixture();
  try {
    const target = await f.controller.write("target", {}, () => f.memory.remember(fact("abort-target"), write("abort-target")));
    const authority = { ...f.authority, withNativeMutation: f.controller.exclusive, fenceNativeErasure: f.controller.fenceErasure };
    const input = { subject: target.subject, expectedHead: target.id, expectedScopeVersion: f.memory.scan().sourceVersion, key: "abort-original" };
    const lease = await prepareMemoryErasure({ memory: f.memory, authority, input });
    await lease.prepare(); const before = f.memory.exportArchive();
    await lease.abortUnchanged();
    await expect(lease.eraseNative()).rejects.toThrow();
    expect(f.memory.exportArchive()).toEqual(before);
    expect((await f.registry.read("123"))?.pending).toBeUndefined();
  } finally { await f.close(); }
});
