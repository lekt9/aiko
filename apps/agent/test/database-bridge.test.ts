import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Memory } from "entity-learn";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Event } from "tardie/core/event";
import type { Command, Storage } from "../../../packages/structured-data/src/index.ts";
import { createDatabaseBinding } from "../src/database-host.ts";
import { databaseEntities } from "../src/database-entities.ts";
import { executeDatabaseBridge } from "../src/database-bridge.ts";
import { databaseComponent, databaseEventKey, databaseState, prepareDatabaseCommand } from "../src/database-component.ts";
import { readDatabaseValue } from "../src/database.ts";
import { databaseApi } from "../src/database-api.ts";
import type { WorkflowKV } from "../src/workflow-host.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(rowProducer = "user:alice", mappingProducer = "user:alice") {
  const directory = await mkdtemp("/tmp/database-bridge-"); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  let memoryTime = 1000;
  const memoryOptions = { path: join(directory, "memory.sqlite"), scope: "aiko:alice", clock: () => memoryTime };
  const memory = new Memory(memoryOptions); cleanups.push(async () => memory.close());
  let db: Database;
  const open = () => {
    db = new Database(join(directory, "tables.sqlite"));
    db.exec("CREATE TABLE IF NOT EXISTS fixture_kv(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const get = (key: string) => { const row = db.query("SELECT value FROM fixture_kv WHERE key=?").get(key) as { value: string } | null; return row ? JSON.parse(row.value) : undefined; };
    const put = (key: string, value: unknown) => { db.query("INSERT OR REPLACE INTO fixture_kv VALUES(?,?)").run(key, JSON.stringify(value)); };
    const kv: WorkflowKV = { get: async key => get(key), put: async (key, value) => put(key, value), list: async prefix => (db.query("SELECT value FROM fixture_kv WHERE key LIKE ?").all(prefix + "%") as { value: string }[]).map(row => JSON.parse(row.value)), claim: async (key, value) => db.transaction(() => { if (get(key) !== undefined) return false; put(key, value); return true; })(), update: async (key, change) => db.transaction(() => put(key, change(get(key))))() };
    const storage: Storage = { exec: sql => { db.exec(sql); }, prepare: sql => db.query(sql) as ReturnType<Storage["prepare"]>, transaction: run => db.transaction(run)(), read: run => db.transaction(run)() };
    return createDatabaseBinding({ owner: "alice", thread: "user-alice", storage, kv, authorize: async () => true, entities: databaseEntities({ owner: "alice", stateDir: directory, openMemory: () => new Memory(memoryOptions) }), storeOptions: { now: () => 1000 } });
  };
  let binding = open(); cleanups.push(async () => db.close());
  const context = { at: 1000, producer: "user:alice" };
  binding.store.execute("db", { kind: "database.create", database: { id: "work", name: "Work", lifecycle: "visible" } }, context);
  binding.store.execute("table", { kind: "table.define", expectedRevision: 0, table: { id: "people", databaseId: "work", name: "People", mode: "stored", columns: [{ id: "name", name: "Name", type: "text" }] } }, context);
  binding.store.execute("row", { kind: "rows.upsert", tableId: "people", rows: [{ id: "one", expectedRevision: 0, values: { name: "BRIDGE_PRIVATE_VALUE" } }] }, { ...context, producer: rowProducer });
  binding.store.execute("map", { kind: "mapping.define", expectedRevision: 0, expectedRowRevision: 1, mapping: { id: "person", tableId: "people", rowId: "one", subject: "people/one", fields: [{ columnId: "name", path: "/name", authority: "table" }] } }, { ...context, producer: mappingProducer });
  const command: Extract<Command, { kind: "mapping.promote" }> = { kind: "mapping.promote", mappingId: "person", expectedMappingRevision: 1, expectedRowRevision: 2, expectedObservationId: null, title: "Person", type: "person" };
  const request = await prepareDatabaseCommand(binding, { operationId: "publish", command, producer: "user:alice", cause: "publish" }, new AbortController().signal);
  const driveNative = async (cancelled = false, admitted = request) => {
    const definition = actor({ name: "aiko", methods: {}, components: [databaseComponent(binding)] });
    const host = await createBunHost({ database: join(directory, "actor.sqlite"), actorName: "aiko", actorInstance: "test", keyOf: databaseEventKey, actorFor: (thread: string) => thread === binding.thread ? definition : undefined });
    try {
      await host.commitRoot(host.self(binding.thread), admitted);
      if (cancelled) await host.commitRoot(host.self(binding.thread), { type: "AikoDatabaseOperationCancelled", id: admitted.id, owner: binding.owner, thread: binding.thread, at: 1001 });
      await host.wake(binding.thread);
      return await host.read(binding.thread);
    } finally { await host.close(); }
  };
  return { get binding() { return binding; }, memory, command, request, context, driveNative, setMemoryTime: (at: number) => { memoryTime = at; }, reopen: () => { db.close(); binding = open(); } };
}

test.each(["query", "artifact"] as const)("%s serving rechecks field access after the final host authorization await", async kind => {
  const f = await fixture();
  f.binding.store.execute("view", { kind: "view.save", expectedRevision: 0, view: { id: "people-view", title: "People", layout: "table", query: { tableId: "people" } } }, f.context);
  f.binding.store.execute("artifact", { kind: "artifact.create", artifactId: "people-live", title: "People", viewId: "people-view", viewRevision: 1, dataMode: "live" }, f.context);
  let reads = 0, hidden = false;
  f.binding.store.options.canRead = (_table, field) => !(hidden && field === "name");
  f.binding.authorize = async action => { if (action === "read" && ++reads === 3) { await Promise.resolve(); hidden = true; } return true; };
  const request = new Request(`http://localhost/api/databases/${kind === "query" ? "query" : "artifacts/people-live"}`, kind === "query" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: { tableId: "people" } }) } : undefined);
  const response = await databaseApi(request, f.binding, { read: async () => [], commit: async () => {}, wake: () => {}, serialize: async run => run() }, { owner: "alice", scopes: ["read", "write"] });
  expect(reads).toBe(3); expect(response.status).toBe(403); expect(await response.text()).not.toContain("BRIDGE_PRIVATE_VALUE");
});

test("memory commit recovery reports an applied write when the row changed during a crash", async () => {
  const f = await fixture(), events: Event[] = [], signal = new AbortController().signal;
  await expect(executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { if (rows.some(row => row.type === "AikoDatabaseBridgeMemoryCommitted")) throw Error("Process lost before memory receipt event"); events.push(...rows); } }, signal)).rejects.toThrow("Process lost");
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(2);
  expect(f.binding.store.receipt("publish")).toBeUndefined();
  f.reopen();
  f.binding.store.execute("new-row", { kind: "rows.upsert", tableId: "people", rows: [{ id: "one", expectedRevision: 2, values: { name: "New local value" } }] }, f.context);
  const receipt = await executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { events.push(...rows); } }, signal);
  expect(receipt.outcome).toBe("conflict"); expect(receipt.result).toMatchObject({ appliedToMemory: true, reason: "table_changed_after_memory_commit" });
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(2);
  expect(f.binding.store.mapping("person").value.baseline).toBeUndefined();
  expect(f.binding.store.row("people", "one")?.value.values.name).toBe("New local value");
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
  expect(JSON.stringify(events)).not.toContain("BRIDGE_PRIVATE_VALUE");
});

test("an evidence-only crash does not overwrite a subsequently corrected memory head", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await expect(executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { if (rows.some(row => row.type === "AikoDatabaseBridgeEvidenceCommitted")) throw Error("Process lost after evidence"); } }, signal)).rejects.toThrow("Process lost");
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(1);
  f.reopen();
  const manual = f.memory.remember({ subject: "people/one", title: "Manual person", type: "person", payload: { name: "Current manual value" } }, { key: "manual", producer: { kind: "user", reference: "fixture:manual" } });
  const receipt = await executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async () => {} }, signal);
  expect(receipt.outcome).toBe("conflict"); expect(receipt.result).toMatchObject({ appliedToMemory: false, evidenceRecorded: true, reason: "conflict" });
  expect(f.memory.get(manual.id)?.state).toBe("current"); expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(2);
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
});

for (const stopped of ["cancelled", "revoked", "authority-error", "memory-changed"] as const) test(`native recovery reconciles committed memory after ${stopped}`, async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await expect(executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { if (rows.some(row => row.type === "AikoDatabaseBridgeMemoryCommitted")) throw Error("Process lost"); } }, signal)).rejects.toThrow("Process lost");
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(2);
  f.reopen();
  if (stopped === "revoked") f.binding.authorize = async () => false;
  if (stopped === "authority-error") f.binding.authorize = async () => { throw Error("Authority unavailable"); };
  if (stopped === "memory-changed") {
    const head = f.memory.journal.head(f.memory.scope, "people/one")!;
    f.memory.remember({ subject: "people/one", title: "Person", type: "person", supersedes: head.id, payload: { name: "Later correction" } }, { key: "correction", producer: { kind: "user", reference: "fixture:manual" } });
  }
  const expectedVersion = f.memory.journal.scopeVersion(f.memory.scope);
  const events = await f.driveNative(stopped === "cancelled");
  expect(databaseState(events, f.binding).get("publish")?.status).toBe("conflict");
  const result = f.binding.store.receipt("publish")?.result;
  expect(result).toMatchObject({ appliedToMemory: true, reason: stopped === "cancelled" ? "cancelled_after_memory_commit" : stopped === "memory-changed" ? "memory_changed_after_memory_commit" : "authority_changed_after_memory_commit" });
  expect(f.binding.store.mapping("person").value.baseline).toBeUndefined();
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(expectedVersion);
  expect(JSON.stringify(events)).not.toContain("BRIDGE_PRIVATE_VALUE");
  f.binding.authorize = async () => true;
  expect(await readDatabaseValue(f.binding, "database_operation", { operationId: "publish" }, events)).toMatchObject({ status: "conflict", bridge: { pending: false, evidenceId: expect.any(String), observationId: expect.any(String) } });
  await f.driveNative();
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(expectedVersion);
});

for (const cancelled of [false, true]) test(`native recovery settles evidence-only publication on ${cancelled ? "cancellation" : "revocation"}`, async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await expect(executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { if (rows.some(row => row.type === "AikoDatabaseBridgeEvidenceCommitted")) throw Error("Process lost"); } }, signal)).rejects.toThrow("Process lost");
  f.reopen();
  if (!cancelled) f.binding.authorize = async () => false;
  const events = await f.driveNative(cancelled);
  expect(databaseState(events, f.binding).get("publish")?.status).toBe(cancelled ? "cancelled" : "rejected");
  expect(f.binding.store.receipt("publish")?.result).toMatchObject({ appliedToMemory: false, evidenceRecorded: true, reason: cancelled ? "cancelled" : "forbidden" });
  expect(f.memory.journal.head(f.memory.scope, "people/one")).toBeUndefined();
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(1);
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
});

for (const boundary of ["planned", "evidence"] as const) test(`cancellation while authorization resolves stops the next memory write after ${boundary}`, async () => {
  const f = await fixture(), controller = new AbortController(); let cancelOnAuthorization = false;
  f.binding.authorize = async () => { if (cancelOnAuthorization) controller.abort(); return true; };
  const receipt = await executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => {
    if (rows.some(row => row.type === (boundary === "planned" ? "AikoDatabaseBridgePlanned" : "AikoDatabaseBridgeEvidenceCommitted"))) cancelOnAuthorization = true;
  } }, controller.signal);
  expect(receipt.outcome).toBe("cancelled");
  expect(receipt.result).toMatchObject({ appliedToMemory: false, evidenceRecorded: boundary === "evidence" });
  expect(f.memory.journal.head(f.memory.scope, "people/one")).toBeUndefined();
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(boundary === "evidence" ? 1 : 0);
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
  expect(await executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async () => {} }, new AbortController().signal)).toEqual(receipt);
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(boundary === "evidence" ? 1 : 0);
});

for (const [rowProducer, mapper] of [["user:alice", "agent:mapper"], ["agent:author", "user:alice"]]) test(`mapping by ${mapper} preserves ${rowProducer} table evidence attribution`, async () => {
  const f = await fixture(rowProducer, mapper);
  expect(f.binding.store.mapping("person").producer).toBe(mapper);
  expect(f.binding.store.row("people", "one")?.producer).toBe(rowProducer);
  const receipt = await executeDatabaseBridge(f.binding, f.request, f.command, "agent:publisher", { append: async () => {} }, new AbortController().signal);
  const result = receipt.result as { observationId: string; evidenceId: string };
  expect(f.memory.get(result.evidenceId)?.observation.producer).toMatchObject({ kind: rowProducer!.startsWith("user:") ? "user" : "agent", reference: rowProducer });
  expect(f.memory.get(result.observationId)?.observation.producer).toMatchObject({ kind: "agent", reference: "agent:publisher" });
});

test("authority lost after initial native reconciliation settles the staged evidence delivery", async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await expect(executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { if (rows.some(row => row.type === "AikoDatabaseBridgeEvidenceCommitted")) throw Error("Process lost"); } }, signal)).rejects.toThrow("Process lost");
  f.reopen();
  let checks = 0;
  f.binding.authorize = async () => ++checks === 1;
  const events = await f.driveNative();
  expect(databaseState(events, f.binding).get("publish")?.status).toBe("rejected");
  expect(f.binding.store.receipt("publish")?.result).toMatchObject({ appliedToMemory: false, evidenceRecorded: true });
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(1);
});

for (const denied of ["field", "row", "table"] as const) test(`native recovery preserves baseline after ${denied} access is revoked`, async () => {
  const f = await fixture(), signal = new AbortController().signal;
  await expect(executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { if (rows.some(row => row.type === "AikoDatabaseBridgeMemoryCommitted")) throw Error("Process lost"); } }, signal)).rejects.toThrow("Process lost");
  f.reopen();
  f.binding.store.options.canRead = (table, column, row) => denied === "field" ? column !== "name" : denied === "row" ? row !== "one" : table !== "people";
  expect(() => f.binding.store.mapping("person")).toThrow("current access");
  const events = await f.driveNative();
  expect(databaseState(events, f.binding).get("publish")?.status).toBe("conflict");
  expect(f.binding.store.receipt("publish")?.result).toMatchObject({ appliedToMemory: true, reason: "authority_changed_after_memory_commit" });
  expect(f.binding.store.record<{ baseline?: unknown }>("mapping", "person")?.value.baseline).toBeUndefined();
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(2);
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
});

async function correctionFixture() {
  const f = await fixture();
  f.binding.store.execute("entity-schema", { kind: "table.define", expectedRevision: 1, table: { id: "people", databaseId: "work", name: "People", mode: "stored", columns: [
    { id: "name", name: "Name", type: "text" },
    { id: "role", name: "Role", type: "text", binding: { kind: "entity", path: "/profile/role", retention: "materialized" } },
    { id: "private", name: "Private", type: "text", binding: { kind: "entity", path: "/private", retention: "reference-only" } },
  ] } }, f.context);
  f.binding.store.execute("entity-map", { kind: "mapping.define", expectedRevision: 1, expectedRowRevision: 2, mapping: { id: "person", tableId: "people", rowId: "one", subject: "people/one", fields: [
    { columnId: "name", path: "/name", authority: "table" }, { columnId: "role", path: "/profile/role", authority: "entity" }, { columnId: "private", path: "/private", authority: "entity" },
  ] } }, f.context);
  const initial = f.memory.remember({ subject: "people/one", title: "Person", type: "person", kind: "entity", ttlSeconds: 300, validFrom: 500, payload: { name: "BRIDGE_PRIVATE_VALUE", profile: { role: "Designer", other: true }, private: "REFERENCE_ONLY_CORRECTION_CANARY", untouched: 7 } }, { key: "initial-person", producer: { kind: "user", reference: "fixture:author" } });
  const command: Extract<Command, { kind: "mapping.correct" }> = { kind: "mapping.correct", mappingId: "person", expectedMappingRevision: 2, expectedRowRevision: 2, expectedObservationId: initial.id, values: { role: "Builder" } };
  const request = await prepareDatabaseCommand(f.binding, { operationId: "correct", command, producer: "user:alice", cause: "correct" }, new AbortController().signal);
  return { f, initial, command, request };
}

test("native mapped corrections preserve other fields, update the projection, and replay once", async () => {
  const { f, initial, command, request } = await correctionFixture();
  f.setMemoryTime(2000);
  const events = await f.driveNative(false, request);
  const receipt = f.binding.store.receipt("correct")!, result = receipt.result as { observationId: string; evidenceId: string };
  expect(receipt.outcome).toBe("committed"); expect(receipt.result).toMatchObject({ appliedToMemory: true, projectionUpdated: true, baselineUpdated: false, mappingRevision: 2 });
  const corrected = f.memory.get(result.observationId)!;
  expect(corrected.observation.payload).toEqual({ name: "BRIDGE_PRIVATE_VALUE", profile: { role: "Builder", other: true }, private: "REFERENCE_ONLY_CORRECTION_CANARY", untouched: 7 });
  expect(corrected.observation.supersedes).toBe(initial.id);
  expect(corrected.observation.validFrom).toBe(500); expect(corrected.observation.expiresAt).toBe(301000);
  expect(corrected.observation.observedAt).toBe(1000); expect(corrected.observation.recordedAt).toBe(2000);
  expect(corrected.observation.supports).toContain(initial.id); expect(corrected.observation.dependsOn).toContain(result.evidenceId);
  expect(f.memory.get(result.evidenceId)?.observation).toMatchObject({ type: "structured-table-correction", producer: { kind: "user", reference: "user:alice" }, payload: { fields: { role: "Builder" } } });
  const cells = f.binding.store.query({ tableId: "people" }).rows[0]!.cells;
  expect(cells.role?.value).toBe("Builder"); expect(cells.role?.sourceGeneration).toBe(result.observationId);
  expect(cells.private?.state).toBe("unavailable"); expect(cells.private?.value).toBeUndefined();
  expect(f.binding.store.mapping("person").value.baseline).toBeUndefined();
  expect(JSON.stringify(events)).not.toMatch(/Builder|REFERENCE_ONLY_CORRECTION_CANARY/);
  const privateHistory = f.binding.store.history("cell", JSON.stringify(["people", "one", "private"]));
  expect(privateHistory).toHaveLength(1);
  expect(JSON.stringify(privateHistory)).not.toContain("REFERENCE_ONLY_CORRECTION_CANARY");
  f.reopen(); await f.driveNative(false, request);
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(3); expect(f.binding.store.receipt("correct")).toEqual(receipt);
  const next = { ...command, expectedObservationId: result.observationId, values: { role: "Editor" } };
  const nextRequest = await prepareDatabaseCommand(f.binding, { operationId: "correct-again", command: next, producer: "agent:editor", cause: "correct-again" }, new AbortController().signal);
  await f.driveNative(false, nextRequest);
  const nextResult = f.binding.store.receipt("correct-again")!.result as { observationId: string; evidenceId: string };
  expect(f.memory.get(nextResult.observationId)?.freshness).toBe("fresh");
  expect(f.memory.get(nextResult.observationId)?.observation.dependsOn).toEqual([nextResult.evidenceId]);
  expect(f.binding.store.query({ tableId: "people" }).rows[0]?.cells.role?.value).toBe("Editor");
});

test("correction editor reads only its mapped field and rechecks evidence after authorization", async () => {
  const { f, initial } = await correctionFixture();
  const input = { tableId: "people", rowId: "one", columnId: "role" };
  const before = f.memory.journal.scopeVersion(f.memory.scope);
  const detail = await readDatabaseValue(f.binding, "field_detail", input, []);
  expect(detail).toMatchObject({ rowRevision: 2, memory: { mappingId: "person", mappingRevision: 2, observationId: initial.id, current: { value: "Designer" }, canCorrect: true } });
  expect(JSON.stringify(detail)).not.toContain("REFERENCE_ONLY_CORRECTION_CANARY");
  expect(JSON.stringify(detail)).not.toContain("untouched");
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(before);
  expect(await readDatabaseValue(f.binding, "table_explain", { ...input, columnId: "private" }, [])).not.toHaveProperty("memory");
  f.binding.store.options.canRead = (_table, column) => column !== "role";
  await expect(readDatabaseValue(f.binding, "field_detail", input, [])).rejects.toThrow("unavailable");
  f.binding.store.options.canRead = () => true;
  f.binding.authorize = async kind => {
    if (kind === "write") f.memory.forget(initial.subject, initial.id, "forget-during-editor-read");
    return true;
  };
  await expect(readDatabaseValue(f.binding, "field_detail", input, [])).rejects.toThrow("unavailable");
});

for (const changed of ["memory", "row", "mapping"] as const) test(`correction review rejects a ${changed} change during authorization`, async () => {
  const { f, initial } = await correctionFixture();
  f.binding.authorize = async kind => {
    if (kind === "write") {
      if (changed === "memory") f.memory.remember({ subject: initial.subject, title: "Person", type: "person", supersedes: initial.id, payload: { profile: { role: "Newer role" } } }, { key: "newer-head", producer: { kind: "user", reference: "fixture:race" } });
      else if (changed === "row") f.binding.store.execute("newer-row", { kind: "rows.upsert", tableId: "people", rows: [{ id: "one", expectedRevision: 2, values: { name: "Newer name" } }] }, f.context);
      else {
        const { baseline: _baseline, ...mapping } = f.binding.store.mapping("person").value;
        f.binding.store.execute("newer-mapping", { kind: "mapping.define", expectedRevision: 2, expectedRowRevision: 2, mapping }, f.context);
      }
    }
    return true;
  };
  await expect(readDatabaseValue(f.binding, "field_detail", { tableId: "people", rowId: "one", columnId: "role" }, [])).rejects.toThrow("changed");
});

test("field API fences a memory change during its final serving authorization", async () => {
  const { f, initial } = await correctionFixture(); let reads = 0;
  f.binding.authorize = async kind => {
    if (kind === "read" && ++reads === 3) f.memory.remember({ subject: initial.subject, title: "Person", type: "person", supersedes: initial.id, payload: { profile: { role: "Changed before response" } } }, { key: "response-race", producer: { kind: "user", reference: "fixture:race" } });
    return true;
  };
  const response = await databaseApi(new Request("https://fixture.invalid/api/databases/field", { method: "POST", body: JSON.stringify({ tableId: "people", rowId: "one", columnId: "role" }) }), f.binding, { read: async () => [], commit: async () => {}, wake: () => {}, serialize: run => run() }, { owner: "alice", scopes: ["read", "write"] });
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "conflict" });
});

test("corrections preserve unpublished local work and promotion requires explicit conflict resolution", async () => {
  const { f, initial, command } = await correctionFixture(), signal = new AbortController().signal;
  const publish = { ...f.command, expectedMappingRevision: 2, expectedObservationId: initial.id };
  const publishedRequest = await prepareDatabaseCommand(f.binding, { operationId: "first-publish", command: publish, producer: "user:alice", cause: "first-publish" }, signal);
  const published = await executeDatabaseBridge(f.binding, publishedRequest, publish, "user:alice", { append: async () => {} }, signal);
  const publishedId = (published.result as { observationId: string }).observationId;
  f.binding.store.execute("local-edit", { kind: "rows.upsert", tableId: "people", rows: [{ id: "one", expectedRevision: 2, values: { name: "Local unpublished name" } }] }, f.context);
  const correct = { ...command, expectedMappingRevision: 3, expectedRowRevision: 3, expectedObservationId: publishedId };
  const correctRequest = await prepareDatabaseCommand(f.binding, { operationId: "correct-local", command: correct, producer: "user:alice", cause: "correct-local" }, signal);
  const corrected = await executeDatabaseBridge(f.binding, correctRequest, correct, "user:alice", { append: async () => {} }, signal), correctedId = (corrected.result as { observationId: string }).observationId;
  expect(corrected.result).toMatchObject({ projectionUpdated: true, baselineUpdated: false });
  expect(f.binding.store.row("people", "one")?.value.values.name).toBe("Local unpublished name");
  expect(f.binding.store.mapping("person").value.baseline?.observationId).toBe(publishedId);
  const resolve = { ...publish, expectedMappingRevision: 3, expectedRowRevision: 3, expectedObservationId: correctedId };
  const resolveRequest = await prepareDatabaseCommand(f.binding, { operationId: "resolve", command: resolve, producer: "user:alice", cause: "resolve" }, signal);
  await expect(executeDatabaseBridge(f.binding, resolveRequest, resolve, "user:alice", { append: async () => {} }, signal)).rejects.toThrow("resolve the conflict");
  const explicit = { ...resolve, resolveConflict: "publish-table" as const };
  const explicitRequest = await prepareDatabaseCommand(f.binding, { operationId: "explicit-resolve", command: explicit, producer: "user:alice", cause: "explicit-resolve" }, signal);
  const resolved = await executeDatabaseBridge(f.binding, explicitRequest, explicit, "user:alice", { append: async () => {} }, signal);
  expect(resolved.outcome).toBe("committed"); expect(resolved.result).toMatchObject({ baselineUpdated: true, mappingRevision: 4 });
  expect(f.memory.get((resolved.result as { observationId: string }).observationId)?.observation.payload).toMatchObject({ name: "Local unpublished name", profile: { role: "Builder", other: true }, untouched: 7 });
});

for (const invalid of ["table-field", "wrong-type", "stale-head", "local-override"] as const) test(`mapped correction rejects ${invalid} without writing memory`, async () => {
  const { f, command } = await correctionFixture(); let correction = command;
  if (invalid === "table-field") correction = { ...command, values: { name: "Forbidden" } };
  if (invalid === "wrong-type") correction = { ...command, values: { role: 3 } };
  if (invalid === "stale-head") correction = { ...command, expectedObservationId: "obs_" + "0".repeat(64) };
  if (invalid === "local-override") {
    f.binding.store.execute("override", { kind: "rows.upsert", tableId: "people", rows: [{ id: "one", expectedRevision: 2, values: {}, overrides: { role: "Local override" } }] }, f.context);
    correction = { ...command, expectedRowRevision: 3 };
  }
  const request = await prepareDatabaseCommand(f.binding, { operationId: "denied-correction", command: correction, producer: "user:alice", cause: "denied-correction" }, new AbortController().signal);
  await expect(executeDatabaseBridge(f.binding, request, correction, "user:alice", { append: async () => {} }, new AbortController().signal)).rejects.toThrow();
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(1);
});

for (const boundary of ["memory", "projection"] as const) test(`native correction recovery after ${boundary} commit does not repeat either write`, async () => {
  const { f, command, request } = await correctionFixture(), signal = new AbortController().signal;
  if (boundary === "projection") f.binding.store.finishBridge = () => { throw Error("Process lost after projection"); };
  await expect(executeDatabaseBridge(f.binding, request, command, "user:alice", { append: async rows => { if (boundary === "memory" && rows.some(row => row.type === "AikoDatabaseBridgeMemoryCommitted")) throw Error("Process lost after memory"); } }, signal)).rejects.toThrow("Process lost");
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(3);
  const priorCellVersion = f.binding.store.cell("people", "one", "role")?.cell.valueVersion;
  if (boundary === "projection") expect(priorCellVersion).toBe(1);
  expect(f.binding.store.receipt("correct")).toBeUndefined();
  f.reopen();
  const events = await f.driveNative(false, request);
  expect(databaseState(events, f.binding).get("correct")?.status).toBe("committed");
  expect(f.binding.store.receipt("correct")?.result).toMatchObject({ appliedToMemory: true, projectionUpdated: true });
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(3);
  expect(f.binding.store.cell("people", "one", "role")?.cell.valueVersion).toBe(1);
  expect(f.binding.store.pending().some(row => row.kind === "entity-bridge")).toBe(false);
});

test("correcting an otherwise synchronized mapping advances its baseline", async () => {
  const { f, initial, command } = await correctionFixture(), signal = new AbortController().signal;
  const publish = { ...f.command, expectedMappingRevision: 2, expectedObservationId: initial.id };
  const publishRequest = await prepareDatabaseCommand(f.binding, { operationId: "publish-before-edit", command: publish, producer: "user:alice", cause: "publish-before-edit" }, signal);
  const published = await executeDatabaseBridge(f.binding, publishRequest, publish, "user:alice", { append: async () => {} }, signal);
  const correct = { ...command, expectedMappingRevision: 3, expectedObservationId: (published.result as { observationId: string }).observationId };
  const request = await prepareDatabaseCommand(f.binding, { operationId: "correct-synced", command: correct, producer: "user:alice", cause: "correct-synced" }, signal);
  const result = await executeDatabaseBridge(f.binding, request, correct, "user:alice", { append: async () => {} }, signal);
  expect(result.result).toMatchObject({ baselineUpdated: true, mappingRevision: 4, projectionUpdated: true });
  expect(f.binding.store.mapping("person").value.baseline?.observationId).toBe((result.result as { observationId: string }).observationId);
});

for (const stopped of ["cancelled", "revoked", "memory-changed"] as const) test(`correction recovery reports an already committed projection after ${stopped}`, async () => {
  const { f, command, request } = await correctionFixture();
  f.binding.store.finishBridge = () => { throw Error("Process lost after projection"); };
  await expect(executeDatabaseBridge(f.binding, request, command, "user:alice", { append: async () => {} }, new AbortController().signal)).rejects.toThrow("Process lost");
  expect(f.binding.store.cell("people", "one", "role")?.cell.valueVersion).toBe(1);
  f.reopen();
  if (stopped === "revoked") f.binding.authorize = async () => false;
  if (stopped === "memory-changed") {
    const head = f.memory.journal.head(f.memory.scope, "people/one")!;
    f.memory.remember({ subject: "people/one", title: "Person", type: "person", supersedes: head.id, payload: { name: "Other update" } }, { key: "after-projection", producer: { kind: "user", reference: "fixture:other" } });
  }
  const version = f.memory.journal.scopeVersion(f.memory.scope);
  await f.driveNative(stopped === "cancelled", request);
  expect(f.binding.store.receipt("correct")?.result).toMatchObject({ appliedToMemory: true, projectionUpdated: true, baselineUpdated: false });
  expect(f.binding.store.receipt("correct")?.outcome).toBe("conflict");
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(version);
  expect(f.binding.store.cell("people", "one", "role")?.cell.valueVersion).toBe(1);
});

test("a mapping edit during projection commit fences the cached write", async () => {
  const { f, command, request } = await correctionFixture(), commitCells = f.binding.store.commitCells.bind(f.binding.store);
  f.binding.store.commitCells = (operation, input, at) => {
    const committing = commitCells(operation, input, at);
    const { baseline: _baseline, ...mapping } = f.binding.store.mapping("person").value;
    f.binding.store.execute("concurrent-mapping", { kind: "mapping.define", expectedRevision: 2, expectedRowRevision: 2, mapping: { ...mapping, fields: mapping.fields.filter(field => field.columnId !== "private") } }, f.context);
    return committing;
  };
  const receipt = await executeDatabaseBridge(f.binding, request, command, "user:alice", { append: async () => {} }, new AbortController().signal);
  expect(receipt.outcome).toBe("conflict"); expect(receipt.result).toMatchObject({ appliedToMemory: true, projectionUpdated: false, baselineUpdated: false, reason: "projection_unavailable_after_memory_commit" });
  expect(f.binding.store.cell("people", "one", "role")).toBeUndefined();
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(3);
});

for (const count of [1, 16]) test(`promotion retains unmapped dependencies and checks the ${count}-reference budget before writes`, async () => {
  const f = await fixture(), signal = new AbortController().signal;
  const inputs = Array.from({ length: count }, (_, i) => f.memory.remember({ subject: `inputs/${i}`, title: `Input ${i}`, type: "value", payload: { value: i } }, { key: `input-${i}`, producer: { kind: "user", reference: "fixture:input" } }));
  const person = f.memory.remember({ subject: "people/one", title: "Person", type: "person", payload: { name: "Other name", derived: 1 }, dependsOn: inputs.map(input => input.id) }, { key: "derived-person", producer: { kind: "agent", reference: "fixture:derived" } });
  const command = { ...f.command, expectedObservationId: person.id, resolveConflict: "publish-table" as const };
  const request = await prepareDatabaseCommand(f.binding, { operationId: "preserve-dependencies", command, producer: "user:alice", cause: "preserve-dependencies" }, signal);
  const before = f.memory.journal.scopeVersion(f.memory.scope);
  if (count === 16) {
    await expect(executeDatabaseBridge(f.binding, request, command, "user:alice", { append: async () => {} }, signal)).rejects.toThrow("dependency budget");
    expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(before);
    expect(f.binding.store.bridgePlan(request.id)).toBeUndefined();
  } else {
    const result = await executeDatabaseBridge(f.binding, request, command, "user:alice", { append: async () => {} }, signal);
    const target = f.memory.get((result.result as { observationId: string }).observationId)!;
    expect(target.observation.payload).toEqual({ name: "BRIDGE_PRIVATE_VALUE", derived: 1 });
    expect(target.observation.dependsOn).toContain(inputs[0]!.id); expect(target.freshness).toBe("not-applicable");
    f.memory.remember({ subject: inputs[0]!.subject, title: "Changed input", type: "value", payload: { value: 2 }, supersedes: inputs[0]!.id }, { key: "changed-input", producer: { kind: "user", reference: "fixture:input" } });
    expect(f.memory.get(target.observation.id)?.freshness).toBe("stale");
  }
});

test("cancellation during post-projection authorization prevents baseline advancement", async () => {
  const { f, command } = await correctionFixture(), controller = new AbortController();
  const { baseline: _baseline, ...mapping } = f.binding.store.mapping("person").value;
  f.binding.store.execute("entity-only-map", { kind: "mapping.define", expectedRevision: 2, expectedRowRevision: 2, mapping: { ...mapping, fields: mapping.fields.filter(field => field.authority === "entity") } }, f.context);
  let projectionCommitted = false;
  const commitCells = f.binding.store.commitCells.bind(f.binding.store);
  f.binding.store.commitCells = async (...args) => { const result = await commitCells(...args); projectionCommitted = true; return result; };
  f.binding.authorize = async () => { if (projectionCommitted) controller.abort(); return true; };
  const correction = { ...command, expectedMappingRevision: 3 };
  const request = await prepareDatabaseCommand(f.binding, { operationId: "cancel-after-projection", command: correction, producer: "user:alice", cause: "cancel-after-projection" }, controller.signal);
  const result = await executeDatabaseBridge(f.binding, request, correction, "user:alice", { append: async () => {} }, controller.signal);
  expect(result.outcome).toBe("conflict");
  expect(result.result).toMatchObject({ appliedToMemory: true, projectionUpdated: true, baselineUpdated: false, reason: "cancelled_after_memory_commit" });
  expect(f.binding.store.mapping("person").value.baseline).toBeUndefined();
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(3);
});

test("a legacy v1 publication plan resumes after its evidence commit", async () => {
  const f = await fixture(), put = f.binding.custody.put;
  f.binding.custody.put = async (owner, value) => {
    if (value && typeof value === "object" && "version" in value && value.version === 2 && "commandKind" in value && value.commandKind === "mapping.promote") {
      const { commandKind: _kind, ...legacy } = value;
      return put(owner, { ...legacy, version: 1 });
    }
    return put(owner, value);
  };
  await expect(executeDatabaseBridge(f.binding, f.request, f.command, "user:alice", { append: async rows => { if (rows.some(row => row.type === "AikoDatabaseBridgeEvidenceCommitted")) throw Error("Process lost"); } }, new AbortController().signal)).rejects.toThrow("Process lost");
  const planRef = f.binding.store.bridgePlan("publish")!.planRef;
  expect(await f.binding.custody.get("alice", planRef)).toMatchObject({ version: 1 });
  f.reopen(); await f.driveNative();
  expect(f.binding.store.receipt("publish")?.outcome).toBe("committed");
  expect(f.binding.store.mapping("person").value.baseline?.operationId).toBe("publish");
  expect(f.memory.journal.scopeVersion(f.memory.scope)).toBe(2);
});
