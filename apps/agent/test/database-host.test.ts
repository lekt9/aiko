import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import type { Action } from "tardie/log/events";
import { createService } from "../src/server.ts";
import { PERSONA, parseDatabaseWriteOwners, type AikoConfig } from "../src/config.ts";
import { accountDirectory } from "../src/accounts.ts";
import { openMemory } from "../src/memory.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import type { Command } from "../../../packages/structured-data/src/index.ts";
import { EventLog, withWatermark } from "tardie/core/log";
import { createActionApprovals } from "../src/action-approval.ts";
import { createAikoClient } from "../../../packages/sdk/src/aiko.ts";
import { stagedEntityTables, stagedEntityRefresh } from "./database-refresh.fixture.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const token = "database-fixture-operator-123456789", readToken = "database-fixture-readonly-123456789";
async function fixture(model?: (request: InferRequest) => Action) {
  const stateDir = await mkdtemp("/tmp/aiko-database-host-"); cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const config: AikoConfig = { stateDir, mode: "demo", port: 4242, operatorToken: token, persona: PERSONA, voiceEnabled: false, replyStyle: "direct", allowedUsers: new Set(),
    planeCredentials: [{ account: "local", digest: credentialDigest(readToken), scopes: ["read"] }],
  };
  const overrides = model ? { model: Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "databases" } }), react: (request: InferRequest) => Effect.succeed(model(request)) }) } : {};
  let service = await createService(config, overrides);
  cleanups.push(() => service.close());
  const request = (path: string, body?: unknown, auth = token, origin?: string) => service.fetch(new Request(`http://localhost/api/databases${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${auth}`, ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  const command = async (idempotencyKey: string, command: Command) => {
    const response = await request("/commands", { idempotencyKey, command });
    expect([200, 202]).toContain(response.status); const result = await response.json() as { operationId: string };
    await service.host.drive();
    const operation = await request(`/operations/${result.operationId}`);
    return await operation.json() as { status: string; receipt: { result: any }; operationId: string };
  };
  return { get service() { return service; }, config, request, command, restart: async () => { await service.close(); service = await createService(config, overrides); await service.host.drive(); } };
}
const create: Command = { kind: "database.create", database: { id: "work", name: "Work", lifecycle: "visible" } };
const table: Command = { kind: "table.define", expectedRevision: 0, table: { id: "projects", databaseId: "work", name: "Projects", mode: "stored", columns: [{ id: "name", name: "Name", type: "text" }] } };

test("respond attaches stable artifacts through native preparation, history and restart", async () => {
  const f = await fixture(request => request.trajectory.some(e => e.type === "ToolReturned" && e.callId === "reply-with-table")
    ? { kind: "complete", output: "Your project table is ready." }
    : { kind: "call", callId: "reply-with-table", name: "respond", arguments: { text: "Your project table is ready.", artifacts: [{ artifactId: "project-artifact" }] } });
  await f.command("db", create); await f.command("table", table);
  await f.command("rows", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "launch", expectedRevision: 0, values: { name: "ARTIFACT_PRIVATE_ROW" } }] });
  await f.command("view", { kind: "view.save", expectedRevision: 0, view: { id: "project-view", title: "Projects", layout: "table", query: { tableId: "projects" } } });
  await f.command("artifact", { kind: "artifact.create", artifactId: "project-artifact", viewId: "project-view", viewRevision: 1, title: "Projects", dataMode: "live" });
  expect((await f.request("/artifacts/project-artifact")).status).toBe(200);
  await f.service.host.commitRoot(f.service.host.self("user-local"), { type: "MessageReceived", id: "artifact-task", text: "Show the project table", source: "api", at: Date.now() });
  await f.service.host.drive();
  const before = await f.service.host.read("user-local");

  expect(before.filter(e => e.type === "AikoResponseRequested")).toHaveLength(1);
  expect(before.find(e => e.type === "AikoResponseRequested")?.artifacts).toEqual([{ artifactId: "project-artifact" }]);
  expect((before.find(e => e.type === "AikoReplyPrepared")?.result as any)?.artifacts).toEqual([{ kind: "database", artifactId: "project-artifact", state: "available" }]);
  expect(JSON.stringify(before)).not.toContain("ARTIFACT_PRIVATE_ROW");
  const history = await f.service.fetch(new Request("http://localhost/api/messages", { headers: { authorization: `Bearer ${token}` } }));
  expect((await history.json() as any).messages.find((m: any) => m.role === "assistant").artifacts[0].state).toBe("available");
  const opened = await (await f.request("/artifacts/project-artifact")).json() as any;
  expect(opened.result.rows[0].cells.name.value).toBe("ARTIFACT_PRIVATE_ROW");
  expect(opened.artifact.spec.elements.database.props.artifactId).toBe("project-artifact");
  await f.restart();
  const after = await f.service.host.read("user-local");
  expect(after.filter(e => e.type === "AikoResponseRequested")).toHaveLength(1);
  expect(after.filter(e => e.type === "AikoReplyPrepared")).toHaveLength(1);
  expect(after.filter(e => e.type === "MessageReceived")).toHaveLength(1);
});

test("production Node API uses durable commands, scoped reads, replay and read-only rollout", async () => {
  const f = await fixture();
  expect((await f.request("", undefined, "wrong")).status).toBe(401);
  expect((await f.request("/commands", { idempotencyKey: "no-write", command: create }, readToken)).status).toBe(403);
  expect((await f.request("/commands", { idempotencyKey: "origin", command: create }, token, "https://foreign.example")).status).toBe(403);
  expect((await f.command("create", create)).status).toBe("committed");
  expect((await f.command("table", table)).status).toBe("committed");
  const rows: Command = { kind: "rows.upsert", tableId: "projects", rows: [{ id: "launch", expectedRevision: 0, values: { name: "PRIVATE_ROW_CANARY" } }] };
  const committed = await f.command("rows", rows); expect(committed.status).toBe("committed");
  const queried = await f.request("/query", { query: { tableId: "projects" } }, readToken);
  expect(queried.status).toBe(200); expect((await queried.json() as any).rows[0].cells.name.value).toBe("PRIVATE_ROW_CANARY");
  for (const mode of ["require-fresh", "refresh-stale"]) {
    const unsupported = await f.request("/query", { query: { tableId: "projects", mode } }, readToken);
    expect(unsupported.status).toBe(400); expect(await unsupported.json()).toEqual({ error: "unavailable" });
  }
  expect((await f.request("/query", { query: { tableId: "projects", mode: "cached" } }, readToken)).status).toBe(200);
  await f.restart();
  expect((await f.command("rows", rows)).receipt).toEqual(committed.receipt);
  expect((await f.request("/commands", { idempotencyKey: "rows", command: create })).status).toBe(409);
  const log = await f.service.host.read("user-local");
  expect(JSON.stringify(log)).not.toContain("PRIVATE_ROW_CANARY");
  f.config.databaseWriteOwners = [];
  expect((await f.request("/commands", { idempotencyKey: "disabled", command: create })).status).toBe(403);
  expect((await f.request("/query", { query: { tableId: "projects" } }, readToken)).status).toBe(200);
});

test("current credentials and view shape determine capabilities without changing stored artifacts", async () => {
  const f = await fixture(); await f.command("db", create);
  await f.command("table", { ...table, table: { ...table.table, columns: [
    { id: "name", name: "Name", type: "text", required: true },
    { id: "cost", name: "Cost", type: "decimal" },
    { id: "double", name: "Doubled", type: "decimal", binding: { kind: "formula", expression: { op: "multiply", args: [{ field: "cost" }, { literal: "2" }] } } },
  ] } });
  await f.command("row", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "launch", expectedRevision: 0, values: { name: "Launch", cost: "2.50" } }] });
  const query = async (query: object, auth = token) => await (await f.request("/query", { query }, auth)).json() as import("@unlock/protocol").DatabaseQueryResult;
  const writable = await query({ tableId: "projects" });
  expect(writable.capabilities).toMatchObject({ version: 1, write: true, query: true, saveView: true, createRows: true, createFields: ["name", "cost"] });
  expect(writable.capabilities?.records.launch).toEqual({ editFields: ["name", "cost"], reviewMemoryFields: [], actions: [] });
  const readonly = await query({ tableId: "projects" }, readToken);
  expect(readonly.capabilities).toMatchObject({ write: false, query: true, saveView: false, createRows: false, createFields: [] });
  expect(readonly.capabilities?.records.launch?.editFields).toEqual([]);
  expect((await query({ tableId: "projects", select: ["cost"] })).capabilities).toMatchObject({ createRows: false, createFields: ["cost"] });
  const aggregate = await query({ tableId: "projects", aggregates: [{ as: "total", op: "sum", field: "cost" }] });
  expect(aggregate.capabilities?.createRows).toBe(false);
  expect(Object.values(aggregate.capabilities!.records).every(record => !record.editFields.length && !record.actions.length)).toBe(true);
  const joined = await query({ tableId: "projects", joins: [{ tableId: "projects", as: "other", kind: "left", cardinality: "one", on: { local: "$id", foreign: "$id" } }], select: ["name", "other.cost", "other.double"] });
  expect(joined.capabilities?.createRows).toBe(false);
  expect(joined.capabilities?.records[joined.rows[0]!.id]?.editFields).toEqual(["name", "other.cost"]);
  await f.command("view", { kind: "view.save", expectedRevision: 0, view: { id: "view", title: "Projects", query: { tableId: "projects" }, layout: "table" } });
  for (const mode of ["live", "snapshot"] as const) await f.command(mode, { kind: "artifact.create", artifactId: mode, title: "Projects", viewId: "view", viewRevision: 1, dataMode: mode });
  const open = async (id: string, auth = token) => await (await f.request(`/artifacts/${id}`, undefined, auth)).json() as import("@unlock/protocol").DatabaseArtifactResult;
  expect((await open("snapshot")).result.capabilities).toMatchObject({ write: false, query: false, saveView: false, createRows: false, records: {} });
  const before = await open("live");
  expect((await open("live", readToken)).result.capabilities?.write).toBe(false);
  const catalog = await (await f.request("", undefined, readToken)).json() as import("@unlock/protocol").DatabaseCatalog;
  expect(catalog.capabilities?.saveView).toBe(false); expect(catalog.artifacts.find(artifact => artifact.artifactId === "live")?.tableId).toBe("projects");
  f.config.databaseWriteOwners = [];
  const revoked = await open("live"); expect(revoked.result.capabilities?.write).toBe(false); expect(revoked.artifact).toEqual(before.artifact);
  expect((await f.request("/commands", { idempotencyKey: "after-revocation", command: { kind: "rows.upsert", tableId: "projects", rows: [{ id: "launch", expectedRevision: 1, values: { name: "Forbidden" } }] } })).status).toBe(403);
  expect((await query({ tableId: "projects" })).rows[0]?.cells.name?.value).toBe("Launch");
  f.config.databaseWriteOwners = undefined;
  await f.command("large-row", { kind: "rows.upsert", tableId: "projects", rows: [{ id: "large", expectedRevision: 0, values: { name: "x".repeat(2000) } }] });
  const boundedQuery = { tableId: "projects", select: ["name"], filter: { field: "$id", op: "eq", value: "large" } };
  const full = await query(boundedQuery);
  const maxBytes = new TextEncoder().encode(JSON.stringify(full)).length - 1;
  expect((await f.request("/query", { query: { ...boundedQuery, maxBytes } })).status).toBe(413);
});

test("production Node staged entity refresh survives restart and rechecks upstream snapshot authority", async () => {
  const f = await fixture();
  const memory = openMemory({ owner: "local", stateDir: accountDirectory(f.config.stateDir, "local") });
  cleanups.push(async () => memory.close());
  const directory = memory.remember({ subject: "refresh/directory", title: "Directory", type: "directory", payload: { company: "acme" } }, { key: "refresh-directory", producer: { kind: "user", reference: "fixture" } });
  memory.remember({ subject: "refresh/companies/acme", title: "Company", type: "company", payload: { tier: "NODE_STAGED_PRIVATE_TIER" } }, { key: "refresh-company", producer: { kind: "user", reference: "fixture" } });
  await f.command("db", create);
  for (const [index, command] of stagedEntityTables("work").entries()) expect((await f.command(`staged-seed-${index}`, command)).status).toBe("committed");
  const first = await f.command("staged-refresh", stagedEntityRefresh);
  expect(first.receipt.result).toMatchObject({ coverage: "complete", plannedStages: 2, stages: 2, committed: 2, groups: 2, calls: 0, budgetAccounting: "measured" });
  const query = { tableId: "refresh-projects", select: ["tier"] };
  const read = () => f.request("/query", { query }, readToken);
  expect((await (await f.request("/query", { query })).json() as any).capabilities.refresh).toEqual({ tableId: "refresh-projects", rowIds: ["one", "two"], columnIds: ["tier"] });
  expect((await (await read()).json() as any).capabilities.refresh).toBeUndefined();
  expect((await (await read()).json() as any).rows.map((row: any) => row.cells.tier.value)).toEqual(["NODE_STAGED_PRIVATE_TIER", "NODE_STAGED_PRIVATE_TIER"]);
  await f.command("staged-view", { kind: "view.save", expectedRevision: 0, view: { id: "staged-view", title: "Tiers", query, layout: "table" } });
  await f.command("staged-snapshot", { kind: "artifact.create", artifactId: "staged-snapshot", title: "Tiers", viewId: "staged-view", viewRevision: 1, dataMode: "snapshot" });
  await f.restart();
  expect((await f.command("staged-refresh", stagedEntityRefresh)).receipt).toEqual(first.receipt);
  const events = await f.service.host.read("user-local");
  expect(events.filter(event => event.type === "AikoDatabaseRefreshGroupStarted")).toHaveLength(2);
  expect(events.some(event => ["InferenceRequested", "MessageReceived"].includes(event.type))).toBe(false);
  expect(JSON.stringify(events)).not.toContain("NODE_STAGED_PRIVATE_TIER");
  expect((await f.request("/artifacts/staged-snapshot", undefined, readToken)).status).toBe(200);
  memory.forget(directory.subject, directory.id, "forget-refresh-directory");
  expect((await read()).status).toBe(403);
  expect((await f.request("/artifacts/staged-snapshot", undefined, readToken)).status).toBe(403);
});

test("production entity fields follow corrections, pin exact observations and hide forgotten evidence", async () => {
  const f = await fixture();
  const memory = openMemory({ owner: "local", stateDir: accountDirectory(f.config.stateDir, "local") });
  cleanups.push(async () => memory.close());
  const original = memory.remember({ subject: "people/maya", title: "Maya", type: "person", kind: "entity", payload: { name: "MEMORY_PRIVATE_MAYA", company: "Acme", transient: "ENTITY_REFERENCE_ONLY", unused: "UNSELECTED_ENTITY_FIELD" } }, { key: "maya-1", producer: { kind: "user", reference: "fixture:user" } });
  await f.command("db", create);
  const entity = { kind: "entity" as const, path: "/name", retention: "materialized" as const };
  expect((await f.command("people", { kind: "table.define", expectedRevision: 0, table: { id: "people", databaseId: "work", name: "People", mode: "stored", columns: [
    { id: "name", name: "Name", type: "text", binding: entity },
    { id: "pinned", name: "Original name", type: "text", binding: { ...entity, observationId: original.id } },
    { id: "transient", name: "Transient", type: "text", binding: { ...entity, path: "/transient", retention: "reference-only" } },
    { id: "note", name: "Local note", type: "text" },
  ] } })).status).toBe("committed");
  await f.command("person", { kind: "rows.upsert", tableId: "people", rows: [{ id: "maya", expectedRevision: 0, values: { note: "Independent local record" } }] });
  expect((await f.command("link-person", { kind: "row.link_entity", tableId: "people", rowId: "maya", expectedRevision: 1, subject: original.subject })).receipt.result).toMatchObject({ rowRevision: 2, subject: original.subject });
  expect((await f.command("stale-link", { kind: "row.link_entity", tableId: "people", rowId: "maya", expectedRevision: 1, subject: original.subject })).status).toBe("conflict");
  const query = async (select = ["name", "pinned", "transient"]) => f.request("/query", { query: { tableId: "people", select } });
  expect((await (await query()).json() as any).rows[0].cells.name.state).toBe("unavailable");
  const first = await f.command("refresh-maya", { kind: "table.refresh", tableId: "people" });
  expect(first.status).toBe("committed"); expect(first.receipt.result).toMatchObject({ coverage: "complete", calls: 0, groups: 2 });
  const current = await (await query()).json() as any;
  expect(current.rows[0].cells.name.value).toBe("MEMORY_PRIVATE_MAYA");
  expect(current.rows[0].cells.transient.state).toBe("unavailable");
  expect(current.dependencies.some((d: any) => d.source?.observationId === original.id)).toBe(true);
  const structured = new Database(join(f.config.stateDir, "databases", `${createHash("sha256").update("local").digest("hex")}.sqlite`), { readonly: true });
  try {
    const persisted = JSON.stringify(structured.query("SELECT * FROM structured_records").all()) + JSON.stringify(structured.query("SELECT * FROM structured_checks").all()) + JSON.stringify(structured.query("SELECT * FROM structured_operations").all());
    expect(persisted).not.toMatch(/ENTITY_REFERENCE_ONLY|UNSELECTED_ENTITY_FIELD/);
  } finally { structured.close(); }
  await f.command("view", { kind: "view.save", expectedRevision: 0, view: { id: "people", title: "People", layout: "table", query: { tableId: "people", select: ["name"] } } });
  await f.command("snapshot", { kind: "artifact.create", artifactId: "people", viewId: "people", viewRevision: 1, title: "People", dataMode: "snapshot" });
  const corrected = memory.remember({ subject: original.subject, title: "Maya", type: "person", kind: "entity", supersedes: original.id, payload: { name: "Maya corrected", company: "Acme", transient: "NEW_ENTITY_REFERENCE_ONLY" } }, { key: "maya-2", producer: { kind: "user", reference: "fixture:correction" } });
  const changed = await (await query()).json() as any;
  expect(changed.rows[0].cells.name.state).toBe("unavailable");
  expect(changed.rows[0].cells.pinned.value).toBe("MEMORY_PRIVATE_MAYA");
  expect(changed.rows[0].cells.pinned.freshness).toBe("stale");
  expect((await (await f.request("/artifacts/people")).json() as any).result.rows[0].cells.name.value).toBe("MEMORY_PRIVATE_MAYA");
  expect((await f.command("refresh-corrected", { kind: "table.refresh", tableId: "people", mode: "stale", columnIds: ["name"] })).status).toBe("committed");
  expect((await (await query(["name"])).json() as any).rows[0].cells.name.value).toBe("Maya corrected");
  await f.restart();
  expect((await (await query(["name"])).json() as any).rows[0].cells.name.value).toBe("Maya corrected");
  memory.forget(original.subject, corrected.id, "forget-maya");
  expect((await query()).status).toBe(403);
  expect((await (await query(["note"])).json() as any).rows[0].cells.note.value).toBe("Independent local record");
  expect((await f.request("/artifacts/people")).status).toBe(403);
  expect(JSON.stringify(await f.service.host.read("user-local"))).not.toMatch(/MEMORY_PRIVATE_MAYA|ENTITY_REFERENCE_ONLY|UNSELECTED_ENTITY_FIELD|Maya corrected/);
});

test("production actor direct tools seal arguments before native logging and hydrate local query results", async () => {
  let observed = false;
  const actions = [
    { name: "database_create", arguments: { database: create.database } },
    { name: "table_define", arguments: { table: table.table, expectedRevision: 0 } },
    { name: "table_upsert", arguments: { tableId: "projects", rows: [{ id: "launch", expectedRevision: 0, values: { name: "NATIVE_PRIVATE_CANARY" } }] } },
    { name: "table_query", arguments: { query: { tableId: "projects" } } },
  ];
  const f = await fixture(request => {
    const calls = request.trajectory.filter(e => e.type === "ToolCalled" && e.turn === request.identity.turn);
    const returns = request.trajectory.filter(e => e.type === "ToolReturned" && calls.some(c => c.callId === e.callId));
    const result = returns.at(-1)?.result as any;
    if (returns.length === 4) { expect(result.rows[0].cells.name.value).toBe("NATIVE_PRIVATE_CANARY"); observed = true; }
    if (returns.length >= actions.length) return { kind: "complete", output: "Table ready." };
    const next = actions[returns.length]!;
    expect(request.tools.some(t => t.name === next.name)).toBe(true);
    return { kind: "call", callId: `database-${returns.length}`, ...next };
  });
  await f.service.host.commitRoot(f.service.host.self("user-local"), { type: "MessageReceived", id: "task", text: "Create a project table", source: "api", at: Date.now() });
  await f.service.host.drive();
  expect(observed).toBe(true);
  const events = await f.service.host.read("user-local");
  expect(events.filter(e => e.type === "AikoDatabaseOperationSettled" && e.status === "committed")).toHaveLength(3);
  expect(JSON.stringify(events.filter(e => e.type === "ToolCalled" || e.type === "ToolReturned"))).not.toContain("NATIVE_PRIVATE_CANARY");
});

test("native mappings publish exact table evidence, recover receipts and reject diverged memory", async () => {
  const f = await fixture(), memory = openMemory({ owner: "local", stateDir: accountDirectory(f.config.stateDir, "local") });
  cleanups.push(async () => memory.close());
  await f.command("db", create);
  await f.command("table", { kind: "table.define", expectedRevision: 0, table: { id: "contacts", databaseId: "work", name: "Contacts", mode: "stored", columns: [
    { id: "name", name: "Name", type: "text" },
    { id: "role", name: "Role", type: "text", binding: { kind: "entity", path: "/role", retention: "materialized" } },
  ] } });
  await f.command("row", { kind: "rows.upsert", tableId: "contacts", rows: [{ id: "maya", expectedRevision: 0, values: { name: "PRIVATE_PUBLICATION_CANARY" } }] });
  const mapped = await f.command("map", { kind: "mapping.define", expectedRevision: 0, expectedRowRevision: 1, mapping: { id: "maya", tableId: "contacts", rowId: "maya", subject: "people/maya", fields: [{ columnId: "name", path: "/name", authority: "table" }, { columnId: "role", path: "/role", authority: "entity" }] } });
  expect(mapped.receipt.result).toMatchObject({ rowRevision: 2, mappingRevision: 1 });
  const publish: Command = { kind: "mapping.promote", mappingId: "maya", expectedMappingRevision: 1, expectedRowRevision: 2, expectedObservationId: null, title: "Maya", type: "person" };
  const first = await f.command("publish", publish);
  expect(first.status).toBe("committed"); expect(first.receipt.result).toMatchObject({ appliedToMemory: true, mappingRevision: 2 });
  const { observationId, evidenceId } = first.receipt.result;
  const target = memory.get(observationId)!.observation, evidence = memory.get(evidenceId)!.observation;
  expect(target.payload).toEqual({ name: "PRIVATE_PUBLICATION_CANARY" });
  expect(target.dependsOn).toEqual([evidenceId]); expect(target.supports).toContain(evidenceId);
  expect(target.producer.kind).toBe("user"); expect(evidence.producer.kind).toBe("user");
  expect(evidence.payload).toMatchObject({ tableId: "contacts", rowId: "maya", rowRevision: 2, fields: { name: "PRIVATE_PUBLICATION_CANARY" } });
  const version = memory.journal.scopeVersion(memory.scope);
  await f.restart();
  expect((await f.command("publish", publish)).receipt).toEqual(first.receipt);
  expect(memory.journal.scopeVersion(memory.scope)).toBe(version);
  await f.command("edit", { kind: "rows.upsert", tableId: "contacts", rows: [{ id: "maya", expectedRevision: 2, values: { name: "Maya updated" } }] });
  const second = await f.command("publish-again", { ...publish, expectedMappingRevision: 2, expectedRowRevision: 3, expectedObservationId: observationId });
  expect(second.status).toBe("committed");
  expect(memory.get(second.receipt.result.observationId)!.observation.payload).toEqual({ name: "Maya updated" });
  const corrected = memory.remember({ subject: "people/maya", title: "Maya", type: "person", kind: "entity", supersedes: second.receipt.result.observationId, payload: { name: "Maya changed in memory", role: "Builder" } }, { key: "outside-correction", producer: { kind: "user", reference: "fixture:memory-edit" } });
  expect((await f.command("pull-role", { kind: "table.refresh", tableId: "contacts", columnIds: ["role"] })).status).toBe("committed");
  const query = await (await f.request("/query", { query: { tableId: "contacts" } })).json() as any;
  expect(query.rows[0].cells.role.value).toBe("Builder"); expect(query.rows[0].cells.name.value).toBe("Maya updated");
  expect((await f.command("conflicted-publish", { ...publish, expectedMappingRevision: 3, expectedRowRevision: 3, expectedObservationId: second.receipt.result.observationId })).status).toBe("conflict");
  expect(memory.get(corrected.id)!.state).toBe("current");
  const mapping = await (await f.request("/mappings/maya")).json() as any;
  expect(mapping.value.baseline.observationId).toBe(second.receipt.result.observationId);
  const fixtureFetch: typeof globalThis.fetch = Object.assign((...args: Parameters<typeof globalThis.fetch>) => f.service.fetch(new Request(...args)), { preconnect: globalThis.fetch.preconnect });
  const client = createAikoClient({ baseUrl: "http://localhost", token: readToken, fetch: fixtureFetch });
  expect((await client.databases.mapping("maya")).value.baseline?.observationId).toBe(second.receipt.result.observationId);
  expect((await client.databases.operation(first.operationId)).bridge).toEqual({ pending: false, observationId, evidenceId });
  const correction: Command = { kind: "mapping.correct", mappingId: "maya", expectedMappingRevision: 3, expectedRowRevision: 3, expectedObservationId: corrected.id, values: { role: "CORRECTED_PRIVATE_ROLE" } };
  const fieldInput = { tableId: "contacts", rowId: "maya", columnId: "role" };
  const editorResponse = await f.request("/field", fieldInput);
  expect(editorResponse.headers.get("cache-control")).toBe("no-store");
  const editor = await editorResponse.json() as any;
  expect(editor.memory).toMatchObject({ mappingId: "maya", mappingRevision: 3, observationId: corrected.id, current: { value: "Builder" }, canCorrect: true });
  expect(JSON.stringify(editor)).not.toContain("Maya changed in memory");
  expect((await client.databases.field(fieldInput)).memory?.canCorrect).toBe(false);
  expect((await f.request("/field", { ...fieldInput, owner: "foreign" })).status).toBe(400);
  expect((await f.request("/commands", { idempotencyKey: "readonly-correction", command: correction }, readToken)).status).toBe(403);
  const correctionResult = await f.command("mapped-correction", correction);
  expect(correctionResult.status).toBe("committed"); expect(correctionResult.receipt.result).toMatchObject({ projectionUpdated: true, baselineUpdated: false });
  expect((await client.databases.query({ tableId: "contacts" })).rows[0]?.cells.role?.value).toBe("CORRECTED_PRIVATE_ROLE");
  expect(memory.get(correctionResult.receipt.result.observationId)?.observation.payload).toEqual({ name: "Maya changed in memory", role: "CORRECTED_PRIVATE_ROLE" });
  const resolved = await f.command("resolved-publish", { ...publish, expectedMappingRevision: 3, expectedRowRevision: 3, expectedObservationId: correctionResult.receipt.result.observationId, resolveConflict: "publish-table" });
  expect(resolved.status).toBe("committed");
  expect(memory.get(resolved.receipt.result.observationId)?.observation.payload).toEqual({ name: "Maya updated", role: "CORRECTED_PRIVATE_ROLE" });
  const finalVersion = memory.journal.scopeVersion(memory.scope);
  await f.restart(); expect((await f.command("mapped-correction", correction)).receipt).toEqual(correctionResult.receipt);
  expect(memory.journal.scopeVersion(memory.scope)).toBe(finalVersion);
  expect(JSON.stringify(await f.service.host.read("user-local"))).not.toMatch(/PRIVATE_PUBLICATION_CANARY|Maya updated|Maya changed in memory|CORRECTED_PRIVATE_ROLE/);
});

test("database write rollout accepts explicit owner lists and preserves read-only mode", () => {
  expect(parseDatabaseWriteOwners(undefined)).toBeUndefined(); expect(parseDatabaseWriteOwners("false", "local")).toEqual([]);
  expect(parseDatabaseWriteOwners("true", "local,123,local")).toEqual(["local", "123"]);
  expect(() => parseDatabaseWriteOwners("yes")).toThrow(); expect(() => parseDatabaseWriteOwners("true", "../foreign")).toThrow();
});

test("production native batches seal each database call and hydrate both results", async () => {
  let observed = false;
  const f = await fixture(request => {
    const results = request.trajectory.filter(e => e.type === "ToolReturned");
    if (!results.length) return { kind: "calls", calls: ["one", "two"].map(id => ({ callId: id, name: "database_create", arguments: { database: { id, name: `PRIVATE_BATCH_${id}`, lifecycle: "internal" } } })) };
    observed = results.filter(e => (e.result as any)?.operationId).length === 2;
    return { kind: "complete", output: "Databases queued." };
  });
  await f.service.host.commitRoot(f.service.host.self("user-local"), { type: "MessageReceived", id: "batch", text: "Create two separate databases", source: "api", at: Date.now() });
  await f.service.host.drive();
  const events = await f.service.host.read("user-local");
  expect(observed).toBe(true);
  expect(events.filter(e => e.type === "AikoDatabaseOperationSettled" && e.status === "committed")).toHaveLength(2);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_BATCH_");
});

test("system.approvals projects real domain transitions, joins local rows, and rejects generic decisions", async () => {
  const f = await fixture();
  const log = withWatermark({ read: Effect.promise(() => f.service.host.read("user-local")), append: events => Effect.promise(async () => { for (const event of events) await f.service.host.commitRoot(f.service.host.self("user-local"), event); }) });
  const approvals = createActionApprovals({ owner: "local", thread: "user-local" });
  const run = <A, E>(effect: Effect.Effect<A, E, EventLog>) => Effect.runPromise(effect.pipe(Effect.provideService(EventLog, log)));
  const action = await run(approvals.prepare({ id: "action-1", operation: "send.report", connectionId: "mail", connectionRevision: "1", expiresAt: Date.now() + 60000, payload: { body: "PRIVATE_APPROVAL_PAYLOAD" } }));
  await run(approvals.prepare({ id: "action-2", operation: "send.report", connectionId: "mail", connectionRevision: "1", expiresAt: Date.now() + 60000, payload: { body: "Second report" } }));
  const page = await (await f.request("/query", { query: { tableId: "system.approvals", limit: 1 } })).json() as any;
  expect(page.rows[0].cells.state.value).toBe("pending"); expect(page.rows[0].cells.canDecide.value).toBe(true);
  expect(page.capabilities.createRows).toBe(false);
  expect(page.capabilities.records[page.rows[0].id]).toEqual({ editFields: [], reviewMemoryFields: [], actions: [{ kind: "approval.review", recordId: "action-1", label: "Review action" }] });
  expect((await (await f.request("/approvals/action-1", undefined, readToken)).json() as any).canDecide).toBe(false);
  expect(JSON.stringify(page)).not.toContain("PRIVATE_APPROVAL_PAYLOAD"); expect(page.nextCursor.domains["system.approvals"]).toBeDefined();
  const attempted = await f.command("forge-decision", { kind: "rows.upsert", tableId: "system.approvals", rows: [{ id: "action-1", expectedRevision: 1, values: { state: "approved" } }] });
  expect(attempted.status).toBe("rejected"); expect((await run(approvals.get("action-1")))?.state).toBe("pending");
  const decision = await f.service.fetch(new Request("http://localhost/api/observed-actions/approval", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id: "action-1", hash: action.prepared.hash, decision: "approve" }) }));
  expect(decision.status).toBe(200);
  expect((await f.request("/query", { query: { tableId: "system.approvals", limit: 1, cursor: page.nextCursor } })).status).toBe(409);
  const current = await (await f.request("/query", { query: { tableId: "system.approvals" } })).json() as any;
  expect(current.rows[0].cells.state.value).toBe("approved"); expect(current.rows[0].cells.canDecide.value).toBe(false); expect(current.rows[0].cells.outcome.value).toBeNull();
  await f.command("db", create);
  await f.command("annotations", { kind: "table.define", expectedRevision: 0, table: { id: "annotations", databaseId: "work", name: "Approval notes", mode: "stored", columns: [{ id: "approval", name: "Approval", type: "relation", relation: { tableId: "system.approvals", cardinality: "many-to-one" } }, { id: "note", name: "Note", type: "text" }] } });
  await f.command("note", { kind: "rows.upsert", tableId: "annotations", rows: [{ id: "note-1", expectedRevision: 0, values: { approval: "action-1", note: "Launch report" } }] });
  const joined = await (await f.request("/query", { query: { tableId: "annotations", joins: [{ tableId: "system.approvals", as: "action", kind: "left", cardinality: "one", on: { local: "approval", foreign: "$id" } }] } })).json() as any;
  expect(joined.rows[0].cells["action.state"].value).toBe("approved");
  expect(joined.capabilities.records[joined.rows[0].id]).toEqual({ editFields: ["approval", "note"], reviewMemoryFields: [], actions: [{ kind: "approval.review", recordId: "action-1", label: "Review action" }] });
  const catalogue = await (await f.request("")).json() as any;
  expect(catalogue.tables.find((t: any) => t.id === "system.approvals").coverage).toContain("foreground thread");
});

test("agent-native mapped corrections seal private values and preserve agent attribution", async () => {
  let expectedObservationId = "";
  const f = await fixture(request => request.trajectory.some(event => event.type === "ToolReturned" && event.callId === "correct-person")
    ? { kind: "complete", output: "The role was corrected." }
    : { kind: "call", callId: "correct-person", name: "table_correct_entity", arguments: { mappingId: "person-map", expectedMappingRevision: 1, expectedRowRevision: 2, expectedObservationId, values: { role: "NATIVE_MAPPED_CORRECTION_CANARY" } } });
  const memory = openMemory({ owner: "local", stateDir: accountDirectory(f.config.stateDir, "local") }); cleanups.push(async () => memory.close());
  const original = memory.remember({ subject: "people/one", title: "Person", type: "person", payload: { role: "Designer", retained: true } }, { key: "native-person", producer: { kind: "user", reference: "fixture:author" } });
  expectedObservationId = original.id;
  await f.command("db", create);
  await f.command("people", { kind: "table.define", expectedRevision: 0, table: { id: "people", databaseId: "work", name: "People", mode: "stored", columns: [{ id: "role", name: "Role", type: "text", binding: { kind: "entity", path: "/role", retention: "materialized" } }] } });
  await f.command("row", { kind: "rows.upsert", tableId: "people", rows: [{ id: "one", expectedRevision: 0, values: {} }] });
  await f.command("map", { kind: "mapping.define", expectedRevision: 0, expectedRowRevision: 1, mapping: { id: "person-map", tableId: "people", rowId: "one", subject: "people/one", fields: [{ columnId: "role", path: "/role", authority: "entity" }] } });
  await f.service.host.commitRoot(f.service.host.self("user-local"), { type: "MessageReceived", id: "correct-task", text: "Correct the role in memory", source: "api", at: Date.now() });
  await f.service.host.drive();
  const head = memory.journal.head(memory.scope, original.subject)!, corrected = memory.get(head.id)!;
  expect(corrected.observation.payload).toEqual({ role: "NATIVE_MAPPED_CORRECTION_CANARY", retained: true });
  expect(corrected.observation.producer.kind).toBe("agent");
  expect(memory.get(corrected.observation.dependsOn[0]!)?.observation.producer.kind).toBe("agent");
  expect((await (await f.request("/query", { query: { tableId: "people" } })).json() as any).rows[0].cells.role.value).toBe("NATIVE_MAPPED_CORRECTION_CANARY");
  expect(JSON.stringify(await f.service.host.read("user-local"))).not.toContain("NATIVE_MAPPED_CORRECTION_CANARY");
  const version = memory.journal.scopeVersion(memory.scope); await f.restart();
  expect(memory.journal.scopeVersion(memory.scope)).toBe(version);
});
