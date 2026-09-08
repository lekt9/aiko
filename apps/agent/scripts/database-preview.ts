/** Isolated native-host witness. Build the connector UI into /tmp/aiko-database-ui-build first. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { EventLog, withWatermark } from "tardie/core/log";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { createActionApprovals } from "../src/action-approval.ts";
import type { Command } from "../../../packages/structured-data/src/index.ts";
import { openMemory } from "../src/memory.ts";
import { accountDirectory } from "../src/accounts.ts";
import { credentialDigest } from "../src/plane-auth.ts";

const stateDir = await mkdtemp("/tmp/database-browser-witness-");
const uiDir = process.env.DATABASE_PREVIEW_UI_DIR ?? "/tmp/aiko-database-ui-build";
const token = "database-preview-synthetic-local-only";
const config: AikoConfig = { stateDir, mode: "demo", port: 4387, operatorToken: token, planeCredentials: [{ account: "local", digest: credentialDigest("database-preview-read-only"), scopes: ["read"] }], persona: PERSONA, voiceEnabled: false, replyStyle: "direct", allowedUsers: new Set() };
const service = await createService(config, {
  model: Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "database-preview" } }), react: () => Effect.succeed({ kind: "call" as const, callId: "reply-artifact", name: "respond", arguments: { text: "Here are the project table and approval queue.", artifacts: [{ artifactId: "projects-live" }, { artifactId: "approvals-live" }] } }) }),
});
let sequence = 0;
async function command(command: Command) {
  const response = await service.fetch(new Request("http://localhost:4387/api/databases/commands", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ idempotencyKey: `seed-${++sequence}`, command }) }));
  if (!response.ok) throw Error(await response.text());
  const { operationId } = await response.json() as { operationId: string };
  await service.host.drive();
  const status = await service.fetch(new Request(`http://localhost:4387/api/databases/operations/${operationId}`, { headers: { authorization: `Bearer ${token}` } }));
  const result = await status.json() as { status: string };
  if (result.status !== "committed") throw Error(JSON.stringify(result));
}
await command({ kind: "database.create", database: { id: "work", name: "Workspace", lifecycle: "visible" } });
await command({ kind: "table.define", expectedRevision: 0, table: { id: "projects", databaseId: "work", name: "Projects", mode: "stored", columns: [{ id: "name", name: "Project", type: "text", required: true }, { id: "status", name: "Status", type: "enum", options: ["Planned", "In progress", "Done"] }, { id: "budget", name: "Budget", type: "decimal", nullable: true }] } });
await command({ kind: "rows.upsert", tableId: "projects", rows: [{ id: "launch", expectedRevision: 0, values: { name: "Autumn launch", status: "In progress", budget: "1250.50" } }, { id: "docs", expectedRevision: 0, values: { name: "Documentation", status: "Planned", budget: null } }] });
const memory = openMemory({ owner: "local", stateDir: accountDirectory(stateDir, "local") });
try { memory.remember({ subject: "people/maya", title: "Maya", type: "person", payload: { role: "Designer", private: "UNSELECTED_BROWSER_MEMORY_CANARY" } }, { key: "preview-person", producer: { kind: "user", reference: "fixture:author" } }); } finally { memory.close(); }
await command({ kind: "table.define", expectedRevision: 0, table: { id: "people", databaseId: "work", name: "People", mode: "stored", columns: [{ id: "name", name: "Name", type: "text" }, { id: "role", name: "Role", type: "text", binding: { kind: "entity", path: "/role", retention: "materialized" } }] } });
await command({ kind: "rows.upsert", tableId: "people", rows: [{ id: "maya", expectedRevision: 0, values: { name: "Maya" } }] });
await command({ kind: "mapping.define", expectedRevision: 0, expectedRowRevision: 1, mapping: { id: "maya-map", tableId: "people", rowId: "maya", subject: "people/maya", fields: [{ columnId: "role", path: "/role", authority: "entity" }] } });
await command({ kind: "table.refresh", tableId: "people" });
await command({ kind: "table.define", expectedRevision: 0, table: { id: "deliveries", databaseId: "work", name: "Delivery plan", mode: "stored", columns: [
  { id: "name", name: "Delivery", type: "text" }, { id: "status", name: "Status", type: "enum", options: ["Planned", "In progress", "Done"], nullable: true },
  { id: "due", name: "Due", type: "timestamp", nullable: true }, { id: "amount", name: "Amount", type: "decimal", nullable: true },
] } });
await command({ kind: "rows.upsert", tableId: "deliveries", rows: [
  { id: "launch", expectedRevision: 0, values: { name: "Leap day launch", status: "In progress", due: "2028-02-29T09:00:00Z", amount: "9007199254740993.05" } },
  { id: "credit", expectedRevision: 0, values: { name: "March credit", status: "Done", due: "2028-03-01T00:00:00Z", amount: "-9007199254740993.05" } },
  { id: "zero", expectedRevision: 0, values: { name: "No budget needed", status: "Planned", due: null, amount: "0" } },
  { id: "unknown", expectedRevision: 0, values: { name: "Unscheduled research" } },
  { id: "empty", expectedRevision: 0, values: { name: "Awaiting estimate", status: null, amount: null } },
] });
for (const presentation of [
  { layout: "table" as const }, { layout: "list" as const }, { layout: "board" as const, groupField: "status" },
  { layout: "calendar" as const, dateField: "due" }, { layout: "chart" as const, valueField: "amount" },
]) {
  const id = `deliveries-${presentation.layout}`;
  await command({ kind: "view.save", expectedRevision: 0, view: { id, title: "Delivery plan", query: { tableId: "deliveries" }, titleField: "name", ...presentation } });
  await command({ kind: "artifact.create", artifactId: id, viewId: id, viewRevision: 1, title: "Delivery plan", dataMode: "live" });
}
const log = withWatermark({ read: Effect.promise(() => service.host.read("user-local")), append: events => Effect.promise(async () => { for (const event of events) await service.host.commitRoot(service.host.self("user-local"), event); }) });
await Effect.runPromise(createActionApprovals({ owner: "local", thread: "user-local" }).prepare({ id: "preview-approval", operation: "send.report", connectionId: "fixture-mail", connectionRevision: "1", expiresAt: Date.now() + 3600000, payload: { to: "preview@example.invalid", body: "Synthetic approval fixture. No delivery adapter is attached." } }).pipe(Effect.provideService(EventLog, log)));
await command({ kind: "table.define", expectedRevision: 0, table: { id: "unpublished", databaseId: "work", name: "Unpublished research", mode: "stored", columns: [{ id: "name", name: "Name", type: "text" }] } });
await command({ kind: "table.define", expectedRevision: 0, table: { id: "approval-notes", databaseId: "work", name: "Approval notes", mode: "stored", columns: [{ id: "note", name: "Note", type: "text" }, { id: "approval", name: "Approval", type: "relation", relation: { tableId: "system.approvals", cardinality: "many-to-one" } }] } });
await command({ kind: "rows.upsert", tableId: "approval-notes", rows: [{ id: "report-note", expectedRevision: 0, values: { note: "Report context", approval: "preview-approval" } }] });
await command({ kind: "view.save", expectedRevision: 0, view: { id: "approval-notes", title: "Approval notes", layout: "table", query: { tableId: "approval-notes", joins: [{ tableId: "system.approvals", as: "action", kind: "left", cardinality: "one", on: { local: "approval", foreign: "$id" } }] } } });
await command({ kind: "artifact.create", artifactId: "approval-notes", title: "Approval notes", viewId: "approval-notes", viewRevision: 1, dataMode: "live" });
for (const tableId of ["projects", "people", "system.approvals"]) {
  const name = tableId === "system.approvals" ? "approvals" : tableId;
  const title = name === "projects" ? "Projects" : name === "people" ? "People" : "Approval queue";
  await command({ kind: "view.save", expectedRevision: 0, view: { id: `${name}-view`, title, layout: "table", query: { tableId } } });
  for (const mode of ["live", "snapshot"] as const) await command({ kind: "artifact.create", artifactId: `${name}-${mode}`, viewId: `${name}-view`, viewRevision: 1, title, dataMode: mode });
}
await service.host.commitRoot(service.host.self("user-local"), { type: "MessageReceived", id: "preview-message", text: "Show my databases", source: "api", at: Date.now() });
await service.host.drive();
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.DATABASE_PREVIEW_PORT ?? 4387), async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/__fixture/database-read-access" && request.method === "POST") {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 403 });
    const input = await request.json() as { enabled?: unknown };
    if (typeof input.enabled !== "boolean") return new Response(null, { status: 400 });
    config.operatorToken = input.enabled ? token : "database-preview-revoked-synthetic-token";
    return Response.json({ enabled: input.enabled });
  }
  // Fixture-only control for an actual host rollout change during browser editing.
  if (path === "/__fixture/database-writes" && request.method === "POST") {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 403 });
    const input = await request.json() as { enabled?: unknown };
    if (typeof input.enabled !== "boolean") return new Response(null, { status: 400 });
    config.databaseWriteOwners = input.enabled ? undefined : [];
    return Response.json({ enabled: input.enabled });
  }
  if (path === "/connect" || path === "/connect.html") return new Response(Bun.file(join(uiDir, "connect.html")));
  if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)) return new Response(Bun.file(join(uiDir, path)));
  return service.fetch(request);
} });
console.log(`Synthetic database witness ready at ${server.url}connect?screen=databases`);
console.log(`Fixture-only account token: ${token}`);
const close = async () => { await server.stop(true); await service.close(); await rm(stateDir, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
