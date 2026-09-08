import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Layer } from "effect";
import { cloudflareStorage } from "entity-learn/cloudflare";
import { createCloudflareAccountHost } from "../src/cloudflare-host.ts";
import { createMemoryAuthorityRegistry } from "../src/memory-authority-host.ts";
import { openMemoryAuthorityRegistry } from "../src/memory-authority-node.ts";
import { memoryAuthorityFingerprint } from "../src/memory-erasure-authority.ts";
import { memoryRestoreAdmission } from "../src/memory-restore-authority.ts";
import { nativeMemoryImportPublication } from "../src/memory-import-publication.ts";
import { openGuardedMemory } from "../src/memory-restore.ts";

function storage(db: Database) {
  return { sql: { exec(sql: string, ...args: any[]) {
    const rows = !args.length && sql.trimStart().startsWith("CREATE") ? (db.exec(sql), []) : db.query(sql).all(...args);
    return { toArray: () => rows as never, [Symbol.iterator]: () => (rows as Record<string, never>[])[Symbol.iterator]() };
  } }, transactionSync: <T>(run: () => T) => db.transaction(run)(), sync: async () => {},
    getAlarm: async () => null, setAlarm: async () => { throw Error("fixture must not execute"); }, deleteAlarm: async () => {} };
}
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const write = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "synthetic-restore" } });
const zero = { version: 1 as const, scope: "aiko:123", seq: 0, digest: "0".repeat(64) };

test("independent HMAC custody commits with admission, never leaks in events, and missing keys cannot regenerate", async () => {
  const db = new Database(":memory:"), registry = await createMemoryAuthorityRegistry(storage(db), 1);
  try {
    db.exec("CREATE TRIGGER reject_key BEFORE INSERT ON aiko_memory_authority_keys BEGIN SELECT RAISE(ABORT, 'key custody failure'); END");
    await expect(registry.admit("123")).rejects.toThrow("key custody failure");
    expect(await registry.read("123")).toBeUndefined(); expect(await registry.list()).toEqual([]);
    db.exec("DROP TRIGGER reject_key");
    await registry.admit("123"); const key = await registry.key("123"), fingerprint = memoryAuthorityFingerprint(key);
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(JSON.stringify(db.query("SELECT event FROM aiko_thread_events").all())).not.toContain(key);
    await registry.admit("456"); expect(await registry.key("456")).not.toBe(key);
    await expect(registry.key("789")).rejects.toThrow("unavailable");
    db.query("DELETE FROM aiko_memory_authority_keys WHERE owner=?").run("123");
    expect(await registry.admit("123")).toBe(true);
    await expect(registry.key("123")).rejects.toThrow("key unavailable");
    expect((await registry.read("123"))?.revision).toBe(1);
  } finally { await registry.close(); db.close(); }
});

test("configured authority fences every native write after first boot, preserving existing data on denial", () => {
  const db = new Database(":memory:"); let authority: typeof zero | undefined = zero;
  const memory = openGuardedMemory({ storage: cloudflareStorage(storage(db)), scope: zero.scope, restoreAuthority: () => authority });
  try {
    const first = memory.remember({ subject: "first", title: "First", type: "fact", payload: "preserve" }, write("first"));
    const before = memory.exportArchive();
    for (const changed of [undefined, { ...zero, scope: "aiko:456" }, { ...zero, seq: 4, digest: "a".repeat(64) }]) {
      authority = changed;
      expect(() => memory.remember({ subject: "later", title: "Later", type: "fact", payload: "denied" }, write("later"))).toThrow("authority");
      expect(memory.exportArchive()).toEqual(before);
      expect(memory.get(first.id)?.observation.payload).toBe("preserve");
    }
    authority = zero;
    expect(memory.remember({ subject: "later", title: "Later", type: "fact", payload: "allowed" }, write("later"))).toBeDefined();
  } finally { memory.close(); db.close(); }
});

test("unsupported publication cannot stage or create a restore claim; an already pending unknown restore cannot clear", async () => {
  const db = new Database(":memory:"), registry = await createMemoryAuthorityRegistry(storage(db), 1);
  try {
    await registry.admit("123");
    const options = { owner: "123", writer: 1, authority: registry, operationId: "original-vm-restore", fingerprint: "a".repeat(64) };
    const unavailable = await memoryRestoreAdmission(options);
    await expect(unavailable.prepare()).rejects.toThrow("cannot stage");
    expect((await registry.read("123"))?.pending).toBeUndefined();
    const admitted = await memoryRestoreAdmission({ ...options, publication: { receipt: async () => undefined } });
    expect(await admitted.prepare()).toEqual({ status: "admitted" });
    expect(await admitted.reconcile()).toEqual({ status: "pending" });
    const recovered = await memoryRestoreAdmission(options);
    expect(await recovered.reconcile()).toEqual({ status: "pending" });
    await expect(recovered.prepare()).rejects.toThrow("cannot stage");
    const next = await createMemoryAuthorityRegistry(storage(db), 2);
    await expect(next.advanceWriter("123")).rejects.toThrow("fenced");
    await next.close();
    await expect(memoryRestoreAdmission({ ...options, fingerprint: "b".repeat(64) })).rejects.toThrow("key conflict");
    const wrong = await memoryRestoreAdmission({ ...options, publication: { receipt: async () => ({ status: "cancelled", operationId: "wrong", fingerprint: options.fingerprint,
      fence: zero, reference: "not-the-original-executor", digest: "c".repeat(64) }) } });
    await expect(wrong.reconcile()).rejects.toThrow("does not match");
    expect((await registry.read("123"))?.pending?.key).toBe(admitted.operationId);
  } finally { await registry.close(); db.close(); }
});

test("historical restore admission cannot bypass another pending claim or a newer erasure fence", async () => {
  const dir = await mkdtemp("/tmp/native-restore-retry-"), registry = await openMemoryAuthorityRegistry(join(dir, "control/registry.sqlite"), 1);
  try {
    await registry.admit("123");
    const fingerprint = memoryAuthorityFingerprint(await registry.key("123"))("controlled-archive");
    const lease = await memoryRestoreAdmission({ owner: "123", writer: 1, authority: registry, operationId: "old-archive", fingerprint,
      publication: { receipt: async ({ operationId, fingerprint, fence }) => ({ operationId, fingerprint, fence, status: "published", reference: "controlled-executor-receipt", digest: "a".repeat(64) }) } });
    expect(await lease.prepare()).toEqual({ status: "admitted" });
    expect(await lease.reconcile()).toEqual({ status: "published" });
    await registry.append("123", { type: "AikoMemoryAuthorityClaimed", owner: "123", scope: zero.scope, writer: 1, key: "later-erase", at: 2,
      expectedRevision: 3, kind: "erase", beforeFence: zero, fingerprint: "b".repeat(64),
      native: { tool: "memory_erase", callKey: "later-call", requestFingerprint: "b".repeat(64) } });
    await expect(lease.prepare()).rejects.toThrow("no longer current");
    expect(await lease.reconcile()).toEqual({ status: "published" }); // Historical metadata only.
    expect((await registry.read("123"))?.pending?.key).toBe("later-erase");
    const after = { ...zero, seq: 7, digest: "c".repeat(64) };
    await registry.append("123", { type: "AikoMemoryAuthorityEraseCommitted", owner: "123", scope: zero.scope, writer: 1, key: "later-complete", at: 3,
      expectedRevision: 4, claimKey: "later-erase", afterFence: after, requestFingerprint: "b".repeat(64), operation: "erase-subject",
      receipt: { key: "later-native", seq: after.seq, digest: after.digest, scopeVersion: 7, requestDigest: "d".repeat(64) },
      cleanup: { status: "complete", reference: "controlled-copy-receipt", digest: "e".repeat(64) } });
    await expect(lease.prepare()).rejects.toThrow("no longer current");
    expect((await registry.read("123"))?.fence).toEqual(after);
  } finally { await registry.close(); await rm(dir, { recursive: true, force: true }); }
});

test("native account import reconciles original SQL receipt after acknowledgement loss and disk reopen; zero re-imports", async () => {
  const dir = await mkdtemp("/tmp/memory-native-publication-");
  let registry = await openMemoryAuthorityRegistry(join(dir, "independent-control/authority.sqlite"), 1);
  const owner = "123", importId = "native-import-001", operationId = `restore:account:${importId}`;
  let writer = 1;
  await registry.admit(owner);
  const hostOptions = { actorName: "aiko", actorInstance: "restore-test", ownsThread: (t: string) => t === "user-123", actorFor: () => undefined, layersFor: () => Layer.empty };
  const sourceDb = new Database(":memory:"), sourceStore = storage(sourceDb);
  const sourceHost = await createCloudflareAccountHost({ ...hostOptions, storage: sourceStore });
  const source = openGuardedMemory({ storage: cloudflareStorage(sourceStore), scope: zero.scope });
  const targetPath = join(dir, "account.sqlite");
  let db = new Database(targetPath), native = storage(db), host = await createCloudflareAccountHost({ ...hostOptions, storage: native });
  let memory = openGuardedMemory({ storage: cloudflareStorage(native), scope: zero.scope, restoreAuthority: () => zero });
  try {
    const fact = source.remember({ subject: "kept", title: "Keep", type: "fact", payload: "NATIVE_PUBLICATION_FIXTURE" }, write("kept"));
    await sourceHost.seed("user-123", [{ type: "Archived", id: "settled-origin", at: 1 }]);
    const archive = source.exportArchive(), histories = sourceHost.exportHistory();
    const sidecarFingerprint = createHash("sha256").update(JSON.stringify(archive)).digest("hex");
    const nativeDigest = createHash("sha256").update(JSON.stringify([histories, sidecarFingerprint])).digest("hex");
    const fingerprint = (await registry.binding(owner)).fingerprint(["native-import", owner, importId, nativeDigest]);
    const open = async (port = registry) => memoryRestoreAdmission({ owner, writer, authority: port, operationId: `account:${importId}`, fingerprint,
      publication: nativeMemoryImportPublication({ owner, memory, storage: cloudflareStorage(native), importId, operationId, fingerprint, archive, histories, history: host.exportHistory }) });
    let lease = await open(); expect(await lease.prepare()).toEqual({ status: "admitted" });
    expect(await lease.reconcile()).toEqual({ status: "pending" });
    let imports = 0;
    native.sync = async () => { throw Error("native import acknowledgement lost"); };
    await expect(host.importHistory(importId, histories, { fingerprint: sha(archive), import: () => { imports++; memory.importArchive(archive); } })).rejects.toThrow("acknowledgement lost");
    native.sync = async () => {};
    memory.close(); await host.close(); db.close(); await registry.close();
    writer = 2;
    registry = await openMemoryAuthorityRegistry(join(dir, "independent-control/authority.sqlite"), writer);
    await expect(registry.advanceWriter(owner)).rejects.toThrow("fenced");
    db = new Database(targetPath); native = storage(db); host = await createCloudflareAccountHost({ ...hostOptions, storage: native });
    memory = openGuardedMemory({ storage: cloudflareStorage(native), scope: zero.scope, restoreAuthority: () => zero });
    const append = registry.append, port = { ...registry, append: async (...args: Parameters<typeof append>) => { await append(...args); throw Error("authority completion acknowledgement lost"); } };
    lease = await open(port);
    await expect(lease.prepare()).rejects.toThrow("reconciliation only");
    await expect(lease.check()).rejects.toThrow("reconciliation only");
    expect(await lease.reconcile()).toEqual({ status: "published" });
    expect(await lease.prepare()).toEqual({ status: "published" });
    await expect(lease.check()).rejects.toThrow("reconciliation only");
    expect(await lease.reconcile()).toEqual({ status: "published" });
    expect(imports).toBe(1);
    expect(memory.get(fact.id)?.observation.payload).toBe("NATIVE_PUBLICATION_FIXTURE");
    expect(host.exportHistory()).toEqual(histories);
    expect((await registry.read(owner))?.pending).toBeUndefined();
    expect((await registry.read(owner))?.revision).toBe(3);
    expect((await registry.advanceWriter(owner)).writer).toBe(2);
    const readback = nativeMemoryImportPublication({ owner, memory, storage: cloudflareStorage(native), importId, operationId, fingerprint, archive, histories, history: host.exportHistory });
    memory.remember({ subject: "later", title: "Later", type: "fact", payload: "changed" }, write("later"));
    await expect(readback.receipt({ owner, operationId, fingerprint, fence: zero })).rejects.toThrow("does not match");
  } finally {
    memory.close(); await host.close(); db.close(); source.close(); await sourceHost.close(); sourceDb.close(); await registry.close();
    await rm(dir, { recursive: true, force: true });
  }
});
