import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Memory } from "entity-learn";
import { Database } from "bun:sqlite";
import { Memory as CloudMemory, cloudflareStorage } from "entity-learn/cloudflare";
import { databaseEntities } from "../src/database-entities.ts";
import { createDatabaseBinding } from "../src/database-host.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

test("entity adapter enforces transitive source approval, observation identity and owner scope", async () => {
  const dir = await mkdtemp("/tmp/database-entity-evidence-"); cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let now = 1000;
  const options = { path: join(dir, "memory.sqlite"), scope: "aiko:alice", clock: () => now };
  const memory = new Memory({ ...options, adapters: { people: async () => ({ data: [{ id: "maya", name: "Maya" }] }) } });
  cleanups.push(async () => memory.close());
  const entities = databaseEntities({ owner: "alice", stateDir: dir, openMemory: () => new Memory(options) });
  const source = memory.registerSource({ id: "people", namespace: "people", type: "person", kind: "entity", resolver: "adapter", locator: "people", format: "json", ttlSeconds: 1, schema: { id: "id", title: "name" } }, "people-register");
  memory.approveSource(source.id, source.revision, true, "people-approve");
  const refreshed = await memory.refresh(source.id, { key: "people-refresh" });
  const observed = memory.get(refreshed.observations[0]!)!.observation;
  const derived = memory.remember({ subject: "summary/maya", title: "Maya summary", type: "summary", payload: { name: "Maya summary" }, supports: [observed.id], dependsOn: [observed.id] }, { key: "summary", producer: { kind: "agent", reference: "fixture:agent" } });
  const evidence = { kind: "entity" as const, subject: derived.subject, observationId: derived.id, followHead: true };
  expect(entities.state(evidence)).toBe("fresh");
  const selected: unknown[] = [], resolved = await entities.resolve({ subject: derived.subject }, new AbortController().signal);
  expect(resolved.generation).toBe(derived.id);
  expect(await resolved.execute({}, (_step, value) => selected.push(value), new AbortController().signal, { maxCalls: 1, maxBytes: 1024 })).toMatchObject({ calls: 0 });
  expect(selected).toEqual([{ name: "Maya summary" }]);
  now = 2001; expect(entities.state(evidence)).toBe("stale");
  expect(() => entities.authorize({ ...evidence, subject: "someone/else" })).toThrow("unavailable");
  memory.approveSource(source.id, source.revision, false, "people-revoke");
  expect(() => entities.authorize(evidence)).toThrow("source authority");
  await expect(resolved.execute({}, () => {}, new AbortController().signal, { maxCalls: 1, maxBytes: 1024 })).rejects.toThrow("source authority");
  const foreign = databaseEntities({ owner: "bob", stateDir: dir, openMemory: () => new Memory(options) });
  expect(() => foreign.authorize(evidence)).toThrow("scope");
});

test("shared Worker SQLite checks entity evidence inside the selected-cell transaction", async () => {
  const db = new Database(":memory:"); cleanups.push(async () => db.close());
  const storage = cloudflareStorage({ sql: { exec: (sql, ...values) => {
    // Cloudflare SQL exec supports the entity journal's multi-statement schema.
    if (sql.trimStart().startsWith("CREATE")) { db.exec(sql); return []; }
    return db.query(sql).all(...values) as any;
  } }, transactionSync: run => db.transaction(run)() });
  const memory = new CloudMemory({ storage, scope: "aiko:alice", clock: () => 1000 });
  const entities = databaseEntities({ owner: "alice", stateDir: "durable-object", openMemory: () => new CloudMemory({ storage, scope: "aiko:alice", clock: () => 1000 }) });
  const blobs = new Map<string, unknown>();
  const kv: import("../src/workflow-host.ts").WorkflowKV = {
    get: async key => blobs.get(key), put: async (key, value) => { blobs.set(key, value); },
    list: async prefix => [...blobs].filter(([key]) => key.startsWith(prefix)).map(([, value]) => value),
    claim: async (key, value) => { if (blobs.has(key)) return false; blobs.set(key, value); return true; },
    update: async (key, change) => { blobs.set(key, change(blobs.get(key))); },
  };
  const binding = createDatabaseBinding({ owner: "alice", thread: "user-alice", storage, entities, authorize: async () => true, kv, storeOptions: { now: () => 1000 } });
  const original = memory.remember({ subject: "people/maya", title: "Maya", type: "person", payload: { name: "Before" } }, { key: "original", producer: { kind: "user", reference: "fixture:user" } });
  const store = binding.store, context = { at: 1000, producer: "fixture:user" };
  store.execute("db", { kind: "database.create", database: { id: "work", name: "Work", lifecycle: "visible" } }, context);
  store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "people", databaseId: "work", name: "People", mode: "stored", columns: [{ id: "name", name: "Name", type: "text", binding: { kind: "entity", subject: original.subject, path: "/name", retention: "materialized" } }] } }, context);
  store.execute("row", { kind: "rows.upsert", tableId: "people", rows: [{ id: "maya", expectedRevision: 0, values: {} }] }, context);
  const input = { tableId: "people", tableRevision: 1, sourceEvidence: [{ tableId: "people", tableRevision: 1, rowId: "maya", rowRevision: 1, columnId: "name", source: { kind: "entity" as const, subject: original.subject, observationId: original.id, followHead: true } }], rows: [{ rowId: "maya", rowRevision: 1, cells: { name: { retention: "materialized" as const, cell: { state: "ready" as const, freshness: "fresh" as const, value: "Before", sourceGeneration: original.id } } } }] };
  await store.commitCells("first", input, 1000);
  expect(store.query({ tableId: "people" }).rows[0]?.cells.name?.value).toBe("Before");
  const pending = store.commitCells("late", input, 1000);
  memory.remember({ subject: original.subject, title: "Maya", type: "person", payload: { name: "After" }, supersedes: original.id }, { key: "correction", producer: { kind: "user", reference: "fixture:correction" } });
  await expect(pending).rejects.toThrow("Input evidence changed");
  expect(store.receipt("late")).toBeUndefined();
  expect(store.query({ tableId: "people" }).rows[0]?.cells.name?.state).toBe("unavailable");
});
