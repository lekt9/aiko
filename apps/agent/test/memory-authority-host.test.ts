import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createMemoryAuthorityRegistry } from "../src/memory-authority-host.ts";
import { durableStorage, productionWorker } from "./registry-worker-host.test.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  const storage = durableStorage(db);
  return { db, storage,
    events: () => db.query("SELECT event FROM aiko_thread_events ORDER BY thread,seq").all().map((row: any) => JSON.parse(row.event)),
    accounts: () => db.query("SELECT owner FROM accounts ORDER BY owner").all(),
  };
}

test("authority registry: production RPC surface cannot return private control capabilities", async () => {
  const module = await productionWorker(), f = fixture();
  const registry = new module.AikoRegistryDO({ storage: f.storage }, {});
  expect(await registry.admit("123")).toBe(true);
  expect(Reflect.get(registry, "control")).toBeUndefined();
  expect(Reflect.get(registry, "authority")).toBeUndefined();
  expect(Object.getOwnPropertyNames(module.AikoRegistryDO.prototype).sort()).toEqual([
    "admit", "constructor", "list", "memoryAuthority",
  ]);
  expect((await registry.memoryAuthority("123"))?.owner).toBe("123");
  expect((await registry.list()).map((row: any) => row.owner)).toEqual(["123"]);
});

test("authority registry: production admission retains an independent zero checkpoint across restart", async () => {
  const module = await productionWorker(), f = fixture();
  let registry = new module.AikoRegistryDO({ storage: f.storage }, {});
  expect(await registry.memoryAuthority("123")).toBeUndefined();
  expect(await registry.admit("123", 1)).toBe(true);
  const authority = await registry.memoryAuthority("123");
  expect(authority).toEqual({ owner: "123", scope: "aiko:123", revision: 1, writer: 2,
    fence: { version: 1, scope: "aiko:123", seq: 0, digest: "0".repeat(64) } });
  expect(f.events().map(e => e.type)).toEqual(["ThreadCreated", "AikoMemoryAuthorityInitialized"]);
  expect(f.accounts()).toEqual([{ owner: "123" }]);
  expect(await f.storage.getAlarm()).toBeNull();
  registry = new module.AikoRegistryDO({ storage: f.storage }, {});
  expect(await registry.admit("123", 0)).toBe(true);
  expect(await registry.memoryAuthority("123")).toEqual(authority);
  expect(f.events()).toHaveLength(2);
  expect((await registry.list()).map((row: any) => row.owner)).toEqual(["123"]);
  expect(await registry.admit("456", 1)).toBe(false);
  expect(await registry.memoryAuthority("456")).toBeUndefined();
  expect(f.events()).toHaveLength(2);
});

test("authority registry: admission and checkpoint roll back together when either SQL write fails", async () => {
  const module = await productionWorker(), f = fixture();
  const registry = new module.AikoRegistryDO({ storage: f.storage }, {});
  await registry.memoryAuthority("123");
  f.db.exec("CREATE TRIGGER reject_membership BEFORE INSERT ON accounts BEGIN SELECT RAISE(ABORT, 'membership failure'); END");
  await expect(registry.admit("123")).rejects.toThrow("membership failure");
  expect(f.accounts()).toEqual([]); expect(f.events()).toEqual([]);
  f.db.exec("DROP TRIGGER reject_membership");
  f.db.exec("CREATE TRIGGER reject_authority BEFORE INSERT ON aiko_thread_events WHEN NEW.key LIKE 'aiko-memory-authority:%' BEGIN SELECT RAISE(ABORT, 'checkpoint failure'); END");
  await expect(registry.admit("123")).rejects.toThrow("checkpoint failure");
  expect(f.accounts()).toEqual([]); expect(f.events()).toEqual([]);
  f.db.exec("DROP TRIGGER reject_authority");
  expect(await registry.admit("123")).toBe(true);
  expect(f.accounts()).toHaveLength(1); expect(f.events()).toHaveLength(2);
});

test("authority registry: competing admissions enforce the current capacity inside SQL", async () => {
  const f = fixture(), registry = await createMemoryAuthorityRegistry(f.storage, 2);
  try {
    const results = await Promise.all(["123", "456"].map(owner => registry.admit(owner, 1)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(f.accounts()).toHaveLength(1);
    expect(f.events()).toHaveLength(2);
    const owner = (f.accounts()[0] as { owner: string }).owner;
    expect(await Promise.all([registry.admit(owner, 0), registry.admit(owner, 0)])).toEqual([true, true]);
    await expect(registry.admit("789", NaN)).rejects.toThrow("limit");
    await expect(registry.admit("../foreign")).rejects.toThrow("owner");
    expect(f.events()).toHaveLength(2);
  } finally { await registry.close(); }
  const other = fixture(), simultaneous = await createMemoryAuthorityRegistry(other.storage, 2);
  try {
    expect(await Promise.all([simultaneous.admit("123", 1), simultaneous.admit("123", 1)])).toEqual([true, true]);
    expect(other.events()).toHaveLength(2); expect(other.accounts()).toHaveLength(1);
  } finally { await simultaneous.close(); }
});

test("authority registry: legacy or missing authority is never reconstructed as zero", async () => {
  const f = fixture();
  f.db.exec("CREATE TABLE accounts(owner TEXT PRIMARY KEY,created_at INTEGER NOT NULL)");
  f.db.query("INSERT INTO accounts VALUES(?,?)").run("999", 1);
  let registry = await createMemoryAuthorityRegistry(f.storage, 2);
  expect(await registry.admit("999")).toBe(true);
  expect(await registry.read("999")).toBeUndefined();
  expect(f.events()).toEqual([]);
  expect(await registry.admit("123")).toBe(true);
  const initialized = await registry.read("123");
  await registry.close();
  registry = await createMemoryAuthorityRegistry(f.storage, 3);
  // The registry identity survives an account naming epoch change.
  expect(await registry.read("123")).toEqual(initialized);
  f.db.query("DELETE FROM aiko_thread_events WHERE thread=?").run("memory-authority-123");
  expect(await registry.admit("123")).toBe(true);
  expect(await registry.read("123")).toBeUndefined();
  expect(f.events()).toEqual([]);
  expect(await registry.admit("456")).toBe(true);
  f.db.query("DELETE FROM accounts WHERE owner=?").run("456");
  await expect(registry.admit("456")).rejects.toThrow("inventory conflicts");
  expect((await registry.read("456"))?.writer).toBe(3);
  await registry.close();
});

test("authority registry: lost admission acknowledgement recovers the original durable pair", async () => {
  const module = await productionWorker(), f = fixture();
  let registry = new module.AikoRegistryDO({ storage: f.storage }, {});
  await registry.memoryAuthority("123");
  f.storage.sync = async () => { throw Error("acknowledgement lost"); };
  await expect(registry.admit("123")).rejects.toThrow("acknowledgement lost");
  expect(f.accounts()).toEqual([{ owner: "123" }]);
  const rows = f.events(); expect(rows).toHaveLength(2);
  f.storage.sync = async () => {};
  registry = new module.AikoRegistryDO({ storage: f.storage }, {});
  expect(await registry.admit("123", 1)).toBe(true);
  expect(f.events()).toEqual(rows);
  expect((await registry.memoryAuthority("123"))?.revision).toBe(1);
});

test("authority registry: deployment writer handoff preserves pending work and rejects stale writers", async () => {
  const f = fixture(), old = await createMemoryAuthorityRegistry(f.storage, 2);
  await old.admit("123");
  const next = await createMemoryAuthorityRegistry(f.storage, 3);
  const before = (await old.read("123"))!;
  const claim = { type: "AikoMemoryAuthorityClaimed", owner: "123", scope: "aiko:123", writer: 2,
    key: "restore-1", expectedRevision: 1, kind: "restore", fingerprint: "a".repeat(64), beforeFence: before.fence, at: 1 } as const;
  expect((await old.append("123", claim)).pending).toEqual(claim);
  await expect(next.advanceWriter("123")).rejects.toThrow("fenced");
  expect(await next.read("123")).toEqual(await old.read("123"));
  await old.append("123", { type: "AikoMemoryAuthorityRestoreSettled", owner: "123", scope: "aiko:123", writer: 2,
    key: "restore-1-cancelled", expectedRevision: 2, claimKey: claim.key, at: 2,
    witness: { status: "cancelled", operationId: claim.key, fingerprint: claim.fingerprint, fence: before.fence,
      reference: "controlled-remote-cancellation", digest: "b".repeat(64) } });
  const advanced = await next.advanceWriter("123");
  expect(advanced).toEqual({ ...before, writer: 3, revision: 4 });
  expect(await next.advanceWriter("123")).toEqual(advanced);
  await expect(old.advanceWriter("123")).rejects.toThrow("fenced");
  await expect(old.append("123", { ...claim, key: "stale-new-operation", expectedRevision: 4 })).rejects.toThrow("could not be confirmed");
  expect((await next.append("123", { ...claim, writer: 3, key: "restore-2", expectedRevision: 4 })).pending?.key).toBe("restore-2");
  // Replaying historical acceptance reports current state; it is never a new permit.
  expect((await old.append("123", claim)).pending?.key).toBe("restore-2");
  await expect(next.append("123", { type: "AikoMemoryAuthorityWriterAdvanced", owner: "123", scope: "aiko:123",
    key: "arbitrary-rotation", expectedRevision: 5, writer: 3, nextWriter: 99, at: 3 })).rejects.toThrow("trusted host path");
  await old.close(); await next.close();
});

test("authority registry: concurrent deployment handoffs confirm one retained writer transition", async () => {
  const f = fixture(), old = await createMemoryAuthorityRegistry(f.storage, 2);
  await old.admit("123"); await old.close();
  const next = await createMemoryAuthorityRegistry(f.storage, 3), now = Date.now;
  let clock = 1000;
  Date.now = () => ++clock;
  try {
    const results = await Promise.allSettled([next.advanceWriter("123"), next.advanceWriter("123")]);
    expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(await next.read("123")).toMatchObject({ writer: 3, revision: 2 });
    expect(f.events().filter(event => event.type === "AikoMemoryAuthorityWriterAdvanced")).toHaveLength(1);
  } finally { Date.now = now; await next.close(); }
});
