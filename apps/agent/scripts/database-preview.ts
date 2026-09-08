/** Isolated native-host witness. Build the connector UI into /tmp/aiko-database-ui-build first. */
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { EventLog, withWatermark } from "tardie/core/log";
import { createService } from "../src/server.ts";
import { PERSONA } from "../src/config.ts";
import { createActionApprovals } from "../src/action-approval.ts";
import type { Command } from "../../../packages/structured-data/src/index.ts";

const stateDir = await mkdtemp("/tmp/database-browser-witness-");
const token = "database-preview-synthetic-local-only";
const service = await createService({ stateDir, mode: "demo", port: 4387, operatorToken: token, persona: PERSONA, voiceEnabled: false, replyStyle: "direct", allowedUsers: new Set() }, {
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
const log = withWatermark({ read: Effect.promise(() => service.host.read("user-local")), append: events => Effect.promise(async () => { for (const event of events) await service.host.commitRoot(service.host.self("user-local"), event); }) });
await Effect.runPromise(createActionApprovals({ owner: "local", thread: "user-local" }).prepare({ id: "preview-approval", operation: "send.report", connectionId: "fixture-mail", connectionRevision: "1", expiresAt: Date.now() + 3600000, payload: { to: "preview@example.invalid", body: "Synthetic approval fixture. No delivery adapter is attached." } }).pipe(Effect.provideService(EventLog, log)));
for (const tableId of ["projects", "system.approvals"]) {
  const name = tableId === "projects" ? "projects" : "approvals";
  await command({ kind: "view.save", expectedRevision: 0, view: { id: `${name}-view`, title: name === "projects" ? "Projects" : "Approval queue", layout: "table", query: { tableId } } });
  for (const mode of ["live", "snapshot"] as const) await command({ kind: "artifact.create", artifactId: `${name}-${mode}`, viewId: `${name}-view`, viewRevision: 1, title: name === "projects" ? "Projects" : "Approval queue", dataMode: mode });
}
await service.host.commitRoot(service.host.self("user-local"), { type: "MessageReceived", id: "preview-message", text: "Show my databases", source: "api", at: Date.now() });
await service.host.drive();
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.DATABASE_PREVIEW_PORT ?? 4387), async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/connect" || path === "/connect.html") return new Response(Bun.file("/tmp/aiko-database-ui-build/connect.html"));
  if (/^\/assets\/[a-zA-Z0-9_.-]+$/.test(path)) return new Response(Bun.file(join("/tmp/aiko-database-ui-build", path)));
  return service.fetch(request);
} });
console.log(`Synthetic database witness ready at ${server.url}connect?screen=databases`);
console.log(`Fixture-only account token: ${token}`);
const close = async () => { await server.stop(true); await service.close(); await rm(stateDir, { recursive: true, force: true }); process.exit(0); };
process.once("SIGINT", () => void close()); process.once("SIGTERM", () => void close());
