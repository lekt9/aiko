import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { StructuredStore, type Command, type Storage } from "../../../packages/structured-data/src/index.ts";
import { databaseComponent, databaseEventKey, databaseExternalEventAllowed, databaseState, prepareDatabaseCommand, type DatabaseBinding } from "../src/database-component.ts";
import { readDatabaseValue } from "../src/database.ts";
import { executeDatabaseRefresh } from "../src/database-refresh.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const dir = await mkdtemp("/tmp/aiko-native-databases-");
  const db = new Database(join(dir, "structured.sqlite"));
  const storage: Storage = { exec: sql => { db.exec(sql); }, prepare: sql => db.query(sql) as ReturnType<Storage["prepare"]>, transaction: run => db.transaction(run)(), read: run => db.transaction(run)() };
  let now = 1000;
  const store = new StructuredStore(storage, "alice", { now: () => now });
  db.exec("CREATE TABLE private_commands(owner TEXT, ref TEXT, body TEXT, PRIMARY KEY(owner,ref))");
  let allowed = true;
  const binding: DatabaseBinding = { owner: "alice", thread: "user-alice", store, now: () => now, authorize: async () => allowed,
    custody: {
      put: async (owner, value) => { const encoded = JSON.stringify(value), ref = createHash("sha256").update(owner + encoded).digest("hex"); db.query("INSERT OR IGNORE INTO private_commands VALUES (?,?,?)").run(owner, ref, encoded); return ref; },
      get: async (owner, ref) => { const found = db.query("SELECT body FROM private_commands WHERE owner=? AND ref=?").get(owner, ref) as { body: string } | null; if (!found) throw Error("Unavailable"); return JSON.parse(found.body); },
    },
  };
  const definition = actor({ name: "aiko", methods: {}, components: [databaseComponent(binding)] });
  const options = { database: join(dir, "actor.sqlite"), actorName: "aiko", actorInstance: "test", keyOf: databaseEventKey, actorFor: (thread: string) => thread === binding.thread ? definition : undefined };
  let host = await createBunHost(options);
  cleanups.push(async () => { await host.close(); db.close(); await rm(dir, { recursive: true, force: true }); });
  const prepare = (id: string, command: Command) => prepareDatabaseCommand(binding, { operationId: id, command, producer: "user:alice", cause: "task" }, new AbortController().signal);
  return { store, binding, prepare, db, advance: (milliseconds: number) => { now += milliseconds; }, allow: (value: boolean) => { allowed = value; },
    admit: async (event: Awaited<ReturnType<typeof prepare>>) => { await host.commitRoot(host.self(binding.thread), event); },
    drive: () => host.wake(binding.thread),
    events: () => host.read(binding.thread),
    reopen: async () => { await host.close(); host = await createBunHost(options); },
    cancel: async (id: string) => { await host.commitRoot(host.self(binding.thread), { type: "AikoDatabaseOperationCancelled", id, owner: binding.owner, thread: binding.thread, at: 1001 }); },
  };
}
const command: Command = { kind: "database.create", database: { id: "launch", name: "Private project canary", lifecycle: "visible" } };

test("native component executes a sealed command and reopens without duplicate revisions", async () => {
  const f = await fixture(), request = await f.prepare("create", command);
  await f.admit(request); await f.drive();
  expect(f.store.database("launch").revision).toBe(1);
  const events = await f.events();
  expect(databaseState(events, f.binding).get("create")?.status).toBe("committed");
  expect(JSON.stringify(events)).not.toContain("Private project canary");
  await f.reopen(); await f.admit(request); await f.drive();
  expect(f.store.database("launch").revision).toBe(1);
  expect((await f.events()).filter(e => e.type === "AikoDatabaseOperationSettled")).toHaveLength(1);
});

test("native recovery reconciles a committed store receipt with an unsettled event log", async () => {
  const f = await fixture(), request = await f.prepare("create", command);
  await f.admit(request);
  // The actual crash boundary: the domain transaction committed, the native effect receipt did not.
  const committed = f.store.execute("create", command, { at: request.at, producer: "user:alice" });
  expect((await f.events()).some(e => e.type === "AikoDatabaseOperationSettled")).toBe(false);
  await f.reopen(); await f.drive();
  const state = databaseState(await f.events(), f.binding).get("create");
  expect(state?.status).toBe("committed"); expect(state?.revision).toBe(committed.revision);
  expect(f.store.revision()).toBe(1);
});

test("revoked authority and cancellation settle without executing pending commands", async () => {
  const f = await fixture(); await f.admit(await f.prepare("revoked", command)); f.allow(false); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("revoked")?.status).toBe("rejected");
  expect(f.store.receipt("revoked")).toBeUndefined();
  f.allow(true); await f.admit(await f.prepare("cancel", command)); await f.cancel("cancel"); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("cancel")?.status).toBe("cancelled");
  expect(f.store.receipt("cancel")).toBeUndefined();
});

test("public ingress cannot mint database receipts or host-only wait invocations", () => {
  expect(databaseExternalEventAllowed({ type: "AikoDatabaseOperationSettled", id: "fake" })).toBe(false);
  expect(databaseExternalEventAllowed({ type: "MessageReceived", call: { invocation: { method: "databaseWait" } } })).toBe(false);
  expect(databaseExternalEventAllowed({ type: "MessageReceived", text: "Show my tables" })).toBe(true);
});

test("native refresh groups fields once, preserves value heads, withholds reference-only values and rechecks generations", async () => {
  const f = await fixture(); let calls = 0, generation = "session:1", fail = false;
  f.binding.sources = async () => ({ digest: "contract", generation, stepIds: ["repository"], inputs: [{ name: "repo", type: "string", required: true }], execute: async (input, consume) => {
    calls++; expect(input.repo).toBe("launch"); if (fail) throw Error("Provider failed");
    consume("repository", { issues: 12, title: "SELECTED_PRIVATE_VALUE", transient: "REFERENCE_ONLY_VALUE", unselected: "RAW_RESPONSE_VALUE" }); return { calls: 1, bytes: 100 };
  } });
  f.store.execute("db", command, { at: 1000, producer: "fixture" });
  const request = (pointer: string, retention: "materialized" | "reference-only" = "materialized") => ({ kind: "request" as const, sourceId: "repo", contractDigest: "contract", inputs: { repo: { rowField: "repo" } }, select: { stepId: "repository", jsonPointer: pointer }, refresh: { mode: "on-demand" as const, maxAgeSeconds: 30 }, retention });
  f.store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "projects", databaseId: "launch", name: "Projects", mode: "stored", columns: [{ id: "repo", name: "Repository", type: "text" }, { id: "issues", name: "Issues", type: "integer", binding: request("/issues") }, { id: "title", name: "Title", type: "text", binding: request("/title") }, { id: "transient", name: "Transient", type: "text", binding: request("/transient", "reference-only") }] } }, { at: 1000, producer: "fixture" });
  f.store.execute("row", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "one", expectedRevision: 0, values: { repo: "launch" } }] }, { at: 1000, producer: "fixture" });
  await readDatabaseValue(f.binding, "table_query", { query: { tableId: "projects" } }, await f.events()); expect(calls).toBe(0);
  const refresh = async (id: string) => { await f.admit(await f.prepare(id, { kind: "table.refresh", tableId: "projects" })); await f.drive(); return f.store.receipt(id); };
  expect((await refresh("refresh-1"))?.result).toMatchObject({ coverage: "complete", groups: 1, calls: 1 }); expect(calls).toBe(1);
  const first = f.store.query({ tableId: "projects" }).rows[0]!.cells;
  expect(first.issues?.value).toBe(12); expect(first.transient?.state).toBe("unavailable");
  f.advance(1000); expect((await refresh("refresh-2"))?.result).toMatchObject({ changed: [] });
  const second = f.store.query({ tableId: "projects" }).rows[0]!.cells;
  expect(second.issues?.valueVersion).toBe(first.issues?.valueVersion); expect(second.issues?.checkedAt).toBeGreaterThan(first.issues!.checkedAt!);
  expect(JSON.stringify(await f.events())).not.toContain("SELECTED_PRIVATE_VALUE");
  const persisted = JSON.stringify(f.db.query("SELECT * FROM structured_records").all()) + JSON.stringify(f.db.query("SELECT * FROM structured_operations").all()) + JSON.stringify(f.db.query("SELECT * FROM structured_checks").all());
  expect(persisted).not.toContain("REFERENCE_ONLY_VALUE"); expect(persisted).not.toContain("RAW_RESPONSE_VALUE");
  fail = true; f.advance(1000); expect((await refresh("refresh-failed"))?.result).toMatchObject({ coverage: "partial", failed: 1 });
  expect(f.store.query({ tableId: "projects" }).rows[0]!.cells.issues).toMatchObject({ state: "ready", value: 12, freshness: "stale" });
  generation = "session:2";
  await expect(readDatabaseValue(f.binding, "table_query", { query: { tableId: "projects" } }, await f.events())).rejects.toThrow("generation");
  fail = false; expect((await refresh("refresh-generation"))?.result).toMatchObject({ coverage: "complete" });
  expect((await readDatabaseValue(f.binding, "table_query", { query: { tableId: "projects" } }, await f.events()) as any).rows[0].cells.issues.sourceGeneration).toBe("session:2");
  const before = calls; await f.reopen(); await f.drive(); expect(calls).toBe(before);
});

test("refresh recovers a committed group without another fetch and fences concurrent row edits", async () => {
  const f = await fixture(); let calls = 0;
  f.binding.sources = async () => ({ digest: "contract", generation: "public", stepIds: ["read"], inputs: [], execute: async (_input, consume) => { calls++; consume("read", { count: 5 }); return { calls: 1, bytes: 11 }; } });
  f.store.execute("db", command, { at: 1000, producer: "fixture" });
  f.store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "items", databaseId: "launch", name: "Items", mode: "stored", columns: [{ id: "count", name: "Count", type: "integer", binding: { kind: "request", sourceId: "source", contractDigest: "contract", inputs: {}, select: { stepId: "read", jsonPointer: "/count" }, refresh: { mode: "on-demand", maxAgeSeconds: 60 }, retention: "materialized" } }] } }, { at: 1000, producer: "fixture" });
  f.store.execute("row", { kind: "rows.upsert", tableId: "items", rows: [{ id: "one", expectedRevision: 0, values: {} }] }, { at: 1000, producer: "fixture" });
  const refresh = { kind: "table.refresh" as const, tableId: "items" }, request = await f.prepare("refresh", refresh);
  const events: import("tardie/core/event").Event[] = [];
  const journal = { read: async () => events, append: async (rows: typeof events) => { if (rows.some(row => row.type === "AikoDatabaseRefreshGroupSettled")) throw Error("Simulated process loss after group commit"); events.push(...rows); } };
  await expect(executeDatabaseRefresh(f.binding, request, refresh, journal, new AbortController().signal)).rejects.toThrow("process loss");
  expect(calls).toBe(1); expect(f.store.receipt("refresh")).toBeUndefined();
  const recovered = await executeDatabaseRefresh(f.binding, request, refresh, { ...journal, append: async rows => { events.push(...rows); } }, new AbortController().signal);
  expect(calls).toBe(1); expect(recovered.result).toMatchObject({ coverage: "complete", committed: 1, calls: 1, bytes: 11 });
  f.binding.sources = async () => ({ digest: "contract", generation: "public", stepIds: ["read"], inputs: [], execute: async (_input, consume) => {
    f.store.execute("concurrent-row", { kind: "rows.upsert", tableId: "items", rows: [{ id: "one", expectedRevision: 1, values: {} }] }, { at: 1000, producer: "user:other-tab" });
    consume("read", { count: 99 }); return { calls: 1, bytes: 12 };
  } });
  await f.admit(await f.prepare("late-refresh", refresh)); await f.drive();
  expect(databaseState(await f.events(), f.binding).get("late-refresh")?.status).toBe("conflict");
  expect(f.store.row("items", "one")?.revision).toBe(2);
  expect(f.store.query({ tableId: "items" }).rows[0]?.cells.count?.state).toBe("unavailable");
  expect(f.store.cell("items", "one", "count")?.cell.value).toBe(5);
});
