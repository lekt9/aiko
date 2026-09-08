import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { cloudflareStorage, type ErasureFence } from "entity-learn/cloudflare";
import { memoryScope, memoryTools, openMemory, type MemoryBinding, type MemoryReceipt } from "../src/memory.ts";
import { harnessDigest } from "../src/harness-library.ts";
import { memoryRestoreGate, openGuardedMemory } from "../src/memory-restore.ts";
import { productionWorker, durableStorage } from "./registry-worker-host.test.ts";

import { memoryTestAuthority } from "./memory-authority-fixture.ts";

const write = (key: string) => ({ key, producer: { kind: "agent" as const, reference: "controlled-restore" } });
function memoryStorage(db: Database) {
  const storage = durableStorage(db), exec = storage.sql.exec;
  storage.sql.exec = (sql: string, ...args: any[]) => {
    // Match Durable Object sql.exec's schema-batch behavior; Bun query prepares
    // only the first statement in the native entity-learn schema.
    if (!args.length && sql.trimStart().startsWith("CREATE")) {
      db.exec(sql);
      return { toArray: () => [], *[Symbol.iterator]() {} };
    }
    return exec(sql, ...args);
  };
  return storage;
}

test("restore authority: first native write establishes the checkpoint needed for erasure preparation", () => {
  const db = new Database(":memory:"), scope = memoryScope("123");
  const memory = openGuardedMemory({ storage: cloudflareStorage(memoryStorage(db)), scope });
  try {
    db.exec("CREATE TRIGGER reject_first_checkpoint BEFORE INSERT ON aiko_memory_erasure_authority BEGIN SELECT RAISE(ABORT, 'first checkpoint failure'); END");
    expect(() => memory.remember({ subject: "first", title: "First", type: "fact", payload: "recorded" }, write("first"))).toThrow("first checkpoint failure");
    expect(memory.exportArchive().journal).toHaveLength(0);
    expect(db.query("SELECT * FROM aiko_memory_erasure_authority").all()).toHaveLength(0);
    db.exec("DROP TRIGGER reject_first_checkpoint");
    const fact = memory.remember({ subject: "first", title: "First", type: "fact", payload: "recorded" }, write("first"));
    const prepared = memory.prepareSubjectErasure({ subject: fact.subject, expectedHead: fact.id,
      expectedScopeVersion: memory.journal.scopeVersion(scope), key: "erase-first" });
    expect(prepared.key).toBe("erase-first");
    expect(memory.subjectErasureReceipt("erase-first")).toBeUndefined();
    expect(JSON.parse((db.query("SELECT fence FROM aiko_memory_erasure_authority").get() as any).fence)).toEqual(memory.erasureFence());
    expect(memory.get(fact.id)?.observation.payload).toBe("recorded");
  } finally { memory.close(); db.close(); }
});

test("restore authority: native erasure and host checkpoint commit or roll back together, surviving empty memory recovery", async () => {
  const directory = await mkdtemp("/tmp/memory-restore-authority-");
  let db = new Database(join(directory, "host.sqlite"));
  let failCheckpoint = false;
  const storage = () => {
    const native = cloudflareStorage(memoryStorage(db));
    return { ...native, prepare: (sql: string) => {
      const statement = native.prepare(sql);
      return { ...statement, run: (...args: Parameters<typeof statement.run>) => {
        if (failCheckpoint && sql.startsWith("INSERT INTO aiko_memory_erasure_authority")) throw Error("controlled checkpoint failure");
        statement.run(...args);
      } };
    } };
  };
  const scope = memoryScope("123"), open = () => openGuardedMemory({ storage: storage(), scope });
  let memory = open();
  try {
    expect(() => memory.checkArchiveErasure(new Proxy({}, { get() { throw Error("archive was inspected"); } }))).toThrow("authority");
    const target = memory.remember({ subject: "private", title: "Erase this", type: "fact", payload: "PRIVATE_RESTORE_MARKER" }, write("private"));
    const keep = memory.remember({ subject: "unrelated", title: "Preserve this", type: "fact", payload: "unrelated value" }, write("keep"));
    const old = memory.exportArchive(), beforeAuthority = db.query("SELECT * FROM aiko_memory_erasure_authority").all();
    const request = { subject: target.subject, expectedHead: target.id, expectedScopeVersion: memory.scan().sourceVersion, key: "erase-original" };
    failCheckpoint = true;
    expect(() => memory.eraseSubject(request)).toThrow("controlled checkpoint failure");
    expect(memory.get(target.id)?.observation.payload).toBe("PRIVATE_RESTORE_MARKER");
    expect(memory.scan().sourceVersion).toBe(request.expectedScopeVersion);
    expect(db.query("SELECT * FROM aiko_memory_erasure_authority").all()).toEqual(beforeAuthority);
    failCheckpoint = false;
    const erased = memory.eraseSubject(request), fence = memory.erasureFence(), clean = memory.exportArchive();
    expect(erased.observations).toBe(1);
    expect(JSON.stringify(clean)).not.toContain("PRIVATE_RESTORE_MARKER");
    expect(JSON.parse((db.query("SELECT fence FROM aiko_memory_erasure_authority").get() as any).fence)).toEqual(fence);
    expect(() => memory.checkArchiveErasure(old)).toThrow("fence");
    expect(memory.checkArchiveErasure(clean)).toMatchObject({ fence, chainVerified: false });
    expect(memory.eraseSubject(request)).toEqual(erased);
    memory.close(); db.close(); db = new Database(join(directory, "host.sqlite")); memory = open();
    expect(() => memory.checkArchiveErasure(old)).toThrow("fence");
    // Controlled loss of the replaceable memory tables; host authority survives.
    db.exec("DELETE FROM journal; DELETE FROM artifacts; DELETE FROM observations; DELETE FROM heads; DELETE FROM sources;");
    expect(() => memory.remember({ subject: "private", title: "Restore accidentally", type: "fact", payload: "PRIVATE_RESTORE_MARKER" }, write("new-after-loss"))).toThrow("erasure history");
    expect(() => memory.importArchive(old)).toThrow("fence");
    expect(memory.scan().items).toHaveLength(0);
    memory.importArchive(clean);
    expect(memory.get(target.id)).toBeNull();
    expect(memory.get(keep.id)?.observation.payload).toBe("unrelated value");
    expect(memory.erasureFence()).toEqual(fence);

    const freshDb = new Database(":memory:"), freshStore = cloudflareStorage(memoryStorage(freshDb));
    const missing = openGuardedMemory({ storage: freshStore, scope });
    expect(() => missing.importArchive(clean)).toThrow("authority");
    missing.close();
    let trusted: ErasureFence | undefined = { ...fence, scope: "aiko:another" };
    const fresh = openGuardedMemory({ storage: freshStore, scope, restoreAuthority: () => trusted });
    expect(() => fresh.importArchive(clean)).toThrow("authority");
    expect(() => fresh.remember({ subject: "private", title: "Wrong owner", type: "fact", payload: "private" }, write("foreign-authority"))).toThrow("authority");
    trusted = undefined;
    expect(() => fresh.remember({ subject: "private", title: "Missing authority", type: "fact", payload: "private" }, write("missing-authority"))).toThrow("authority");
    trusted = fence;
    expect(() => fresh.remember({ subject: "private", title: "Restore accidentally", type: "fact", payload: "PRIVATE_RESTORE_MARKER" }, write("new-on-replacement"))).toThrow("erasure history");
    expect(() => fresh.importArchive(old)).toThrow("fence");
    fresh.importArchive(clean);
    expect(fresh.get(keep.id)?.observation.payload).toBe("unrelated value");
    fresh.close(); freshDb.close();
  } finally { memory.close(); db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("restore authority: actual Worker rejects missing or stale authority even on an exact import retry", async () => {
  const module = await productionWorker(), directory = await mkdtemp("/tmp/worker-memory-restore-");
  const owner = "123", scope = memoryScope(owner);
  let db = new Database(join(directory, "account.sqlite")), storage = memoryStorage(db), account: any;
  const registryDb = new Database(":memory:");
  const id = (name: string) => ({ name, equals: (other: any) => other?.name === name });
  let trusted: ErasureFence | undefined;
  const env: any = {
    AIKO_MODE: "demo", AIKO_INSTANCE_ID: "restore-worker", AIKO_REPLY_STYLE: "direct",
    AIKO_OPERATOR_TOKEN: "controlled-worker-restore-operator-123456789",
    AIKO_ALLOWED_USERS: owner, AIKO_VOICE_ENABLED: "false",
    AIKO_MEMORY_RESTORE_AUTHORITY: () => trusted,
    AIKO_ACCOUNTS: { idFromName: id },
  };
  const registry = new module.AikoRegistryDO({ storage: durableStorage(registryDb) }, env);
  env.AIKO_REGISTRY = { getByName: () => registry };
  const create = () => new module.AikoAccountDO({ id: id(module.accountObjectName(owner)), storage,
    waitUntil: () => {}, blockConcurrencyWhile: (run: () => Promise<unknown>) => run() }, env);
  const request = (body: unknown) => account.handle(owner, new Request("https://controlled.invalid/api/control/import", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), { owner, operator: true, scopes: ["read", "write"] });
  account = create();
  const sourceDb = new Database(":memory:");
  const source = openGuardedMemory({ storage: cloudflareStorage(memoryStorage(sourceDb)), scope });
  try {
    const target = source.remember({ subject: "private", title: "Erase this", type: "fact", payload: "PRIVATE_IMPORT_MARKER" }, write("private"));
    source.remember({ subject: "keep", title: "Keep this", type: "fact", payload: "keep" }, write("keep"));
    const old = source.exportArchive();
    source.eraseSubject({ subject: target.subject, expectedHead: target.id, expectedScopeVersion: source.scan().sourceVersion, key: "delete" });
    const clean = source.exportArchive(), fence = source.erasureFence();
    // Open the real production host, then construct settled native source history.
    await request({ id: "missing-authority", threads: [], memory: old });
    const host = (await account.runtime).host;
    const originDb = new Database(":memory:");
    const { createCloudflareAccountHost } = await import("../src/cloudflare-host.ts");
    const { Layer } = await import("effect");
    const origin = await createCloudflareAccountHost({ storage: durableStorage(originDb), actorName: "aiko", actorInstance: "restore-worker",
      ownsThread: t => t === "user-123", actorFor: () => undefined, layersFor: () => Layer.empty });
    await origin.seed("user-123", [{ type: "Archived", id: "controlled-settled", at: 1 }]);
    const body = { id: "native-restore-001", threads: origin.exportHistory(), memory: clean };
    expect((await request(body)).status).toBe(409);
    expect(host.exportHistory()).toHaveLength(0);
    trusted = { ...fence, scope: "aiko:foreign" };
    expect((await request(body)).status).toBe(409);
    trusted = fence;
    expect((await request({ ...body, memory: old })).status).toBe(409);
    const accepted = await request(body);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ status: "imported", execution: "not_started" });
    expect((await request(body)).status).toBe(201);
    expect(await storage.getAlarm()).toBeNull();
    const before = host.exportHistory();
    trusted = undefined;
    expect((await request(body)).status).toBe(409);
    expect(host.exportHistory()).toEqual(before);
    await host.close(); db.close(); db = new Database(join(directory, "account.sqlite")); storage = memoryStorage(db); account = create();
    expect((await request(body)).status).toBe(409);
    trusted = fence;
    expect((await request(body)).status).toBe(201);
    const memory = openMemory((await account.runtime).binding("user-123"));
    expect(memory.get(target.id)).toBeNull();
    memory.close();
    await origin.close(); originDb.close();
  } finally {
    await (await account.runtime)?.host.close(); source.close(); sourceDb.close(); registryDb.close(); db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore authority: owner gate holds erasure through restore publication and releases after failure", async () => {
  const gate = memoryRestoreGate(), order: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const restore = gate(async () => { order.push("restore admitted"); await pending; order.push("restore published"); });
  const erase = gate(async () => { order.push("erased"); });
  await Promise.resolve();
  expect(order).toEqual(["restore admitted"]);
  release(); await Promise.all([restore, erase]);
  expect(order).toEqual(["restore admitted", "restore published", "erased"]);
  await expect(gate(async () => { throw Error("controlled failed restore"); })).rejects.toThrow("controlled");
  await gate(async () => { order.push("next operation"); });
  expect(order.at(-1)).toBe("next operation");
});

test("restore authority: a native erasure cancelled while queued preserves memory and skips copy cleanup", async () => {
  const db = new Database(":memory:"), storage = cloudflareStorage(memoryStorage(db));
  const directory = await mkdtemp("/tmp/memory-cancel-authority-"), authority = memoryTestAuthority(directory);
  const owner = "123", thread = "user-123", scope = memoryScope(owner);
  const memory = openGuardedMemory({ storage, scope }), gate = memoryRestoreGate();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  let cleanupCalls = 0;
  const binding: MemoryBinding = {
    stateDir: "/proc/no-filesystem-memory", owner, thread, ...authority.binding(owner), redact: value => value, readPage: async () => [],
    openMemory: adapters => openGuardedMemory({ storage, scope, adapters }),
    withErasure: operation => { queued.resolve(); return gate(operation); },
    eraseCopies: async (_observations, key) => {
      cleanupCalls++;
      return { version: 1, operation: harnessDigest(key), status: "erased", references: [] };
    },
  };
  const native = memoryTools(binding, { fixtures: false }).find(entry => entry.spec.name === "memory_erase")!;
  const run = (input: unknown, callId: string, signal: AbortSignal) => Effect.runPromise(
    native.run(input, { callId, signal, turn: "controlled-cancellation" }).pipe(
      Effect.provideService(Self, { actor: "aiko", instance: "restore-cancellation", thread }),
    ),
  ) as Promise<MemoryReceipt>;
  const restoring = gate(async () => { entered.resolve(); await release.promise; });
  try {
    const target = memory.remember({ subject: "cancelled-erase", title: "Preserve when cancelled", type: "fact", payload: "private value" }, write("cancelled-target"));
    const keep = memory.remember({ subject: "unrelated", title: "Keep", type: "fact", payload: "independent value" }, write("cancelled-keep"));
    const version = memory.scan().sourceVersion, fence = memory.erasureFence();
    const request = { subject: target.subject, expected: target.id, expectedScopeVersion: version };
    await entered.promise;
    const cancellation = new AbortController(), pending = run(request, "cancelled-erase", cancellation.signal);
    await queued.promise;
    cancellation.abort();
    release.resolve();
    await restoring;
    expect((await pending).outcome).toBe("error");
    expect(memory.get(target.id)?.state).toBe("current");
    expect(memory.get(keep.id)?.state).toBe("current");
    expect(memory.scan().sourceVersion).toBe(version);
    expect(memory.erasureFence()).toEqual(fence);
    expect(cleanupCalls).toBe(0);

    expect((await run(request, "successful-erase", new AbortController().signal)).outcome).toBe("ok");
    expect(memory.get(target.id)).toBeNull();
    expect(memory.get(keep.id)?.state).toBe("current");
    expect(memory.scan().sourceVersion).toBeGreaterThan(version);
    expect(memory.erasureFence().seq).toBeGreaterThan(fence.seq);
    expect(cleanupCalls).toBe(1);
  } finally { release.resolve(); await restoring; memory.close(); db.close(); await authority.close(); await rm(directory, { recursive: true, force: true }); }
});
