import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";
import { createMemoryAuthorityRegistry } from "../src/memory-authority-host.ts";
import { prepareMemoryErasure, type MemoryErasureBinding } from "../src/memory-erasure-authority.ts";
import { memoryRestoreGate } from "../src/memory-restore.ts";
import { memoryTools, type MemoryBinding, type MemoryReceipt } from "../src/memory.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { memoryObservationDependency } from "../src/retained-result-dependencies.ts";

function storage(db: Database) {
  return { sql: { exec(sql: string, ...args: any[]) {
    const rows = !args.length && sql.trimStart().startsWith("CREATE") ? (db.exec(sql), []) : db.query(sql).all(...args);
    return { toArray: () => rows as never, [Symbol.iterator]: () => (rows as Record<string, never>[])[Symbol.iterator]() };
  } }, transactionSync: <T>(run: () => T) => db.transaction(run)(), sync: async () => {},
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
}
const fingerprint = (value: unknown) => createHmac("sha256", "synthetic-independent-key").update(JSON.stringify(value)).digest("hex");
async function fixture() {
  const control = new Database(":memory:"), native = new Database(":memory:");
  let registry = await createMemoryAuthorityRegistry(storage(control), 1);
  await registry.admit("123");
  const memory = new Memory({ storage: cloudflareStorage(storage(native)), scope: "aiko:123" });
  const write = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "fixture" } });
  const target = memory.remember({ subject: "private", title: "Private", type: "fact", payload: "PRIVATE_SYNTHETIC" }, write("target"));
  const keep = memory.remember({ subject: "keep", title: "Keep", type: "fact", payload: "INDEPENDENT_SYNTHETIC", links: [{ subject: target.subject, relation: "see" }] }, write("keep"));
  const input = { subject: target.subject, expectedHead: target.id, expectedScopeVersion: memory.scan().sourceVersion, key: "native-original" };
  const authority = (): MemoryErasureBinding => ({ ...registry, owner: "123", writer: 1, fingerprint });
  return { memory, native, control, input, target, keep, write, authority,
    registry: () => registry,
    reopen: async () => { await registry.close(); registry = await createMemoryAuthorityRegistry(storage(control), 1); },
    close: async () => { memory.close(); await registry.close(); native.close(); control.close(); } };
}

test("native erase defaults fail closed without independent custody, including rejected or empty resolvers", async () => {
  const f = await fixture(); let cleanups = 0;
  try {
    const before = f.memory.exportArchive();
    for (const erasureAuthority of [undefined, async () => { throw Error("custody unavailable"); }, async () => undefined as never]) {
      const binding: MemoryBinding = { owner: "123", thread: "user-123", stateDir: "/no-files", openMemory: () => f.memory,
        redact: s => s, readPage: async () => [], withErasure: memoryRestoreGate(), erasureAuthority,
        eraseCopies: async () => { cleanups++; throw Error("must not execute"); } };
      const native = memoryTools(binding, { fixtures: false }).find(t => t.spec.name === "memory_erase")!;
      const receipt = await Effect.runPromise(native.run({ subject: f.input.subject, expected: f.input.expectedHead, expectedScopeVersion: f.input.expectedScopeVersion },
        { callId: "denied", signal: new AbortController().signal }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: "user-123" }))) as MemoryReceipt;
      expect(receipt.outcome).toBe("error");
      expect(f.memory.exportArchive()).toEqual(before);
      expect((await f.registry().read("123"))?.pending).toBeUndefined();
    }
    expect(cleanups).toBe(0);
  } finally { await f.close(); }
});

test("external native claim rejects wrong owner, writer and exact-key changed requests", async () => {
  const f = await fixture();
  try {
    const before = f.memory.exportArchive();
    for (const authority of [{ ...f.authority(), owner: "456" }, { ...f.authority(), writer: 2 }, { ...f.authority(), read: async () => undefined }])
      await expect(prepareMemoryErasure({ memory: f.memory, authority, input: f.input })).rejects.toThrow();
    const lease = await prepareMemoryErasure({ memory: f.memory, authority: f.authority(), input: f.input });
    await lease.prepare();
    await expect(prepareMemoryErasure({ memory: f.memory, authority: f.authority(), input: { ...f.input, subject: f.keep.subject, expectedHead: f.keep.id } })).rejects.toThrow("changed");
    expect(f.memory.exportArchive()).toEqual(before);
    expect((await f.registry().read("123"))?.pending?.native?.receiptKey).toBe(lease.receiptKey);
  } finally { await f.close(); }
});

for (const change of ["none", "ordinary-write", "native-loss", "erased"] as const)
test(`verified abort after registry reopen: ${change}`, async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const authority = f.authority(), append = authority.append;
    authority.append = async (owner, event) => { const state = await append(owner, event); if (event.type === "AikoMemoryAuthorityClaimed") controller.abort(); return state; };
    const lease = await prepareMemoryErasure({ memory: f.memory, authority, input: f.input, signal: controller.signal });
    await expect(lease.prepare()).rejects.toThrow();
    expect(() => lease.erase()).toThrow();
    expect(f.memory.subjectErasureReceipt(f.input.key)).toBeUndefined();
    await f.reopen();
    const resumed = await prepareMemoryErasure({ memory: f.memory, authority: f.authority(), input: f.input });
    if (change === "ordinary-write") f.memory.remember({ subject: "later", title: "Later", type: "fact", payload: "unchanged erasure fence is insufficient" }, f.write("later"));
    if (change === "native-loss") f.native.exec("DELETE FROM observations; DELETE FROM heads; DELETE FROM sources; DELETE FROM artifacts; DELETE FROM journal;");
    if (change === "erased") { await resumed.prepare(); resumed.erase(); }
    if (change === "none") {
      const port = f.authority(), save = port.append;
      port.append = async (owner, event) => { await save(owner, event); throw Error("abort acknowledgement lost"); };
      const abort = await prepareMemoryErasure({ memory: f.memory, authority: port, input: f.input });
      expect((await abort.abortUnchanged()).pending).toBeUndefined();
      await expect(resumed.prepare()).rejects.toThrow();
      expect(f.memory.get(f.target.id)?.observation.payload).toBe("PRIVATE_SYNTHETIC");
    } else {
      await expect(resumed.abortUnchanged()).rejects.toThrow("Unchanged");
      expect((await f.registry().read("123"))?.pending?.key).toBe(`erase:${f.input.key}`);
    }
  } finally { await f.close(); }
});

test("new deployment can only clean up an older committed erasure before writer handoff", async () => {
  const f = await fixture(), next = await createMemoryAuthorityRegistry(storage(f.control), 2);
  try {
    const first = await prepareMemoryErasure({ memory: f.memory, authority: f.authority(), input: f.input });
    await first.prepare();
    await expect(next.advanceWriter("123")).rejects.toThrow("fenced");
    const authority = { ...next, owner: "123", writer: 2, fingerprint };
    const replay = await prepareMemoryErasure({ memory: f.memory, authority, input: f.input });
    await expect(replay.prepare()).rejects.toThrow("original native receipt");
    expect(() => replay.erase()).toThrow("not admitted");
    await expect(replay.abortUnchanged()).rejects.toThrow("cannot abort");
    expect((await next.read("123"))?.pending?.writer).toBe(1);
    first.erase();
    expect(await replay.prepare()).toEqual({ deletionRequired: false });
    expect(() => replay.erase()).toThrow("not admitted");
    const resume = await prepareMemoryErasure({ memory: f.memory, authority, resume: first.receiptKey });
    expect(await resume.prepare()).toEqual({ deletionRequired: false });
    expect(() => resume.erase()).toThrow("not admitted");
    const before = f.memory.exportArchive();
    await resume.complete({ status: "complete", reference: "controlled-copies", digest: "c".repeat(64) });
    expect((await next.advanceWriter("123")).writer).toBe(2);
    expect(f.memory.exportArchive()).toEqual(before);
    const old = f.authority();
    await expect(old.append("123", { type: "AikoMemoryAuthorityClaimed", owner: "123", scope: "aiko:123", writer: 1, at: 5, key: "new-old-claim",
      expectedRevision: 4, kind: "restore", beforeFence: f.memory.erasureFence(), fingerprint: "d".repeat(64) })).rejects.toThrow();
  } finally { await next.close(); await f.close(); }
});

test("exact historical cleanup acknowledgement survives later erasures without adopting their fence", async () => {
  const f = await fixture();
  try {
    const cleanup = { status: "complete" as const, reference: "controlled-copy-receipt", digest: "c".repeat(64) };
    const first = await prepareMemoryErasure({ memory: f.memory, authority: f.authority(), input: f.input });
    await first.prepare(); first.erase(); const original = await first.complete(cleanup);
    const later = f.memory.remember({ subject: "later-private", title: "Later", type: "fact", payload: "later" }, f.write("later"));
    const second = await prepareMemoryErasure({ memory: f.memory, authority: f.authority(), input: { subject: later.subject, expectedHead: later.id,
      expectedScopeVersion: f.memory.scan().sourceVersion, key: "later-erase" } });
    await second.prepare(); second.erase(); const current = await second.complete(cleanup);
    expect(current.fence.seq).toBeGreaterThan(original.fence.seq);
    const history = f.memory.exportArchive();
    const recovered = await prepareMemoryErasure({ memory: f.memory, authority: f.authority(), resume: first.receiptKey });
    expect(await recovered.prepare()).toEqual({ deletionRequired: false });
    expect(await recovered.complete(cleanup)).toEqual(current);
    await expect(recovered.complete({ ...cleanup, digest: "d".repeat(64) })).rejects.toThrow();
    expect(f.memory.exportArchive()).toEqual(history);
    expect((await f.registry().read("123"))?.revision).toBe(5);
  } finally { await f.close(); }
});

test("native tool keeps external claim through copy interruption and cleanup-only resume; no second deletion", async () => {
  const f = await fixture();
  try {
    const kv = new Map<string, unknown>();
    const blobs = harnessBlobStore({ get: async key => kv.get(key), put: async (key, value) => { kv.set(key, value); },
      list: async prefix => [...kv].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
      claim: async (key, value) => { if (kv.has(key)) return false; kv.set(key, value); return true; },
      update: async (key, fn) => { kv.set(key, fn(kv.get(key))); } });
    const privateRef = await blobs.putPrivate("123", { value: "PRIVATE_COPY" }, [memoryObservationDependency(f.target.id)]);
    const keepRef = await blobs.putPrivate("123", { value: "unrelated copy" });
    let interrupted = true;
    const binding: MemoryBinding = { owner: "123", thread: "user-123", stateDir: "/no-files", redact: s => s, readPage: async () => [],
      openMemory: () => f.memory, erasureAuthority: f.authority(), withErasure: memoryRestoreGate(),
      eraseCopies: async (ids, key) => { if (interrupted) throw Error("interrupted copy cleanup"); return blobs.eraseDependencies!("123", ids.map(memoryObservationDependency), key); } };
    const invoke = async (input: unknown, callId: string): Promise<MemoryReceipt> => Effect.runPromise(memoryTools(binding, { fixtures: false }).find(t => t.spec.name === "memory_erase")!.run(input,
      { callId, turn: "turn-1", signal: new AbortController().signal } as any).pipe(Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: "user-123" }))) as Promise<MemoryReceipt>;
    const first = await invoke({ subject: f.input.subject, expected: f.input.expectedHead, expectedScopeVersion: f.input.expectedScopeVersion }, "erase");
    expect(first.outcome).toBe("error");
    const erased = first.result as any, version = f.memory.scan().sourceVersion;
    expect(erased.authority.status).toBe("pending");
    expect(f.memory.get(f.target.id)).toBeNull();
    expect((await f.registry().read("123"))?.pending?.native?.receiptKey).toBe(erased.resume);
    await f.reopen(); binding.erasureAuthority = f.authority(); interrupted = false;
    expect((await invoke({ resume: "foreign-receipt" }, "wrong")).outcome).toBe("error");
    expect((await invoke({ resume: erased.resume, subject: "private" }, "mixed")).outcome).toBe("error");
    const completed = await invoke({ resume: erased.resume }, "cleanup-only");
    expect(completed.outcome).toBe("ok");
    expect(f.memory.scan().sourceVersion).toBe(version);
    expect((await f.registry().read("123"))?.pending).toBeUndefined();
    await expect(blobs.get("123", privateRef)).rejects.toThrow();
    expect(await blobs.get("123", keepRef)).toEqual({ value: "unrelated copy" });
    expect(f.memory.get(erased.replacements[0].observation)?.observation.payload).toBe("INDEPENDENT_SYNTHETIC");
    const rows = f.control.query("SELECT event FROM aiko_thread_events ORDER BY seq").all();
    expect((await invoke({ resume: erased.resume }, "retry-complete")).outcome).toBe("ok");
    expect(f.control.query("SELECT event FROM aiko_thread_events ORDER BY seq").all()).toEqual(rows);
    expect(f.memory.scan().sourceVersion).toBe(version);
  } finally { await f.close(); }
});
