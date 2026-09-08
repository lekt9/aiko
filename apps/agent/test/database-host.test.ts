import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import type { Action } from "tardie/log/events";
import { createService } from "../src/server.ts";
import { PERSONA, parseDatabaseWriteOwners, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import type { Command } from "../../../packages/structured-data/src/index.ts";
import { EventLog, withWatermark } from "tardie/core/log";
import { createActionApprovals } from "../src/action-approval.ts";

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
  await f.restart();
  expect((await f.command("rows", rows)).receipt).toEqual(committed.receipt);
  expect((await f.request("/commands", { idempotencyKey: "rows", command: create })).status).toBe(409);
  const log = await f.service.host.read("user-local");
  expect(JSON.stringify(log)).not.toContain("PRIVATE_ROW_CANARY");
  f.config.databaseWriteOwners = [];
  expect((await f.request("/commands", { idempotencyKey: "disabled", command: create })).status).toBe(403);
  expect((await f.request("/query", { query: { tableId: "projects" } }, readToken)).status).toBe(200);
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
  const catalogue = await (await f.request("")).json() as any;
  expect(catalogue.tables.find((t: any) => t.id === "system.approvals").coverage).toContain("foreground thread");
});
