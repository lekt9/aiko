import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { createActorConnectorTools, type ActorConnectorBinding } from "../src/capability-builder-connectors.ts";
function fixture(status: "available" | "absent" | "unavailable" = "available", auth = "https://cloud.arcade.dev/auth/secret") {
  const calls: string[] = [], deliveries: unknown[] = [], events: Event[] = [{ type: "MessageReceived", id: "turn", source: "telegram", chat: "123" }];
  const connector = { id: "read", name: "Service", provider: "arcade" as const, description: "Read", toolName: "Service.Read", domains: ["service.com"] };
  const connection = { id: "connection", connectorId: "read", provider: "arcade" as const, status: "pending" as const, authorizationUrl: auth, createdAt: 1 };
  const binding: ActorConnectorBinding = { owner: "123", thread: "user-123", engine: {
    search: async () => { calls.push("search"); return { status, connectors: status === "available" ? [connector] : [], fallbackAllowed: status === "absent", message: "catalog" }; },
    connect: async () => { calls.push("connect"); return connection; },
    connectBrowser: async () => { calls.push("browser"); return connection; },
    connections: async () => [connection], execute: async () => ({ status: "succeeded", value: "ok" }),
  }, deliverConnection: async input => { deliveries.push(input); return { status: "delivered" }; } };
  const run = (name: string, input: unknown, thread = binding.thread): Promise<any> => Effect.runPromise(createActorConnectorTools(binding).find(t => t.spec.name === name)!.run(input, { callId: name, turn: "turn", signal: new AbortController().signal }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "test", thread }), Effect.provideService(EventLog, { read: Effect.sync(() => events), head: Effect.sync(() => events.length), readFrom: n => Effect.sync(() => events.slice(n)), append: items => Effect.sync(() => { events.push(...items); }) })));
  return { calls, deliveries, events, run, binding };
}
test("Arcade search precedes durable login request and auth link stays out of receipts/logs", async () => {
  const f = fixture();
  const result = await f.run("connector_recommend", { query: "service", connectorId: "read" });
  expect(f.calls).toEqual(["search", "connect"]);
  expect(f.deliveries).toEqual([]);
  expect(result.delivery).toBe("queued");
  expect(f.events.filter(e => e.type === "AikoLoginRequested")).toMatchObject([{ owner: "123", connectionId: "connection" }]);
  expect(JSON.stringify([result, f.events])).not.toContain("/auth/secret");
  expect(JSON.stringify(await f.run("connector_connections", {}))).not.toContain("/auth/secret");
  expect((await f.run("connector_recommend", { query: "service", connectorId: "read" })).status).toBe("unknown");
  expect(f.events.filter(e => e.type === "AikoLoginRequested")).toHaveLength(1);
});
test("browser fallback requires confirmed absence, never unavailable or matching catalog", async () => {
  for (const status of ["available", "unavailable", "absent"] as const) {
    const f = fixture(status);
    await f.run("connector_recommend", { query: "service", domain: "service.com" });
    expect(f.calls.includes("browser")).toBe(status === "absent");
  }
});
test("owner mismatch and invalid authorization URL cannot deliver", async () => {
  const other = fixture();
  expect((await other.run("connector_recommend", { query: "service", connectorId: "read" }, "user-456")).status).toBe("rejected");
  expect(other.calls).toEqual([]);
  for (const url of ["javascript:alert(1)", "http://cloud.arcade.dev/auth", "https://user:pass@cloud.arcade.dev/auth"]) {
    const f = fixture("available", url);
    await f.run("connector_recommend", { query: "service", connectorId: "read" });
    expect(f.deliveries).toEqual([]);
    expect(f.events.some(e => e.type === "AikoLoginRequested")).toBe(false);
  }
});

test("frontend, stale Telegram and forged textual provenance cannot deliver recommendations", async () => {
  for (const incoming of [
    { type: "MessageReceived", id: "turn", source: "api", chat: "123", text: "source=telegram" },
    { type: "MessageReceived", id: "new-turn", source: "telegram", chat: "123" },
    { type: "MessageReceived", id: "turn", source: "telegram", chat: "456" },
    { type: "MessageReceived", id: "turn", source: "operator", channel: "telegram", chat: "123" },
  ]) {
    const f = fixture(); f.events.push(incoming);
    expect((await f.run("connector_recommend", {query: "service", connectorId: "read"})).status).toBe("rejected");
    expect(f.calls).toEqual([]); expect(f.deliveries).toEqual([]);
  }
});

test("explicit host OAuth disable queues the native sign-in screen without treating an outage as absence", async () => {
  const f = fixture("unavailable");
  f.binding.engine.apps = async () => ({ apps: [], oauthEnabled: false, nativeAvailable: true, nativeInline: true });
  expect((await f.run("connector_recommend", {query:"Service",domain:"service.com"})).delivery).toBe("queued");
  expect(f.calls).toEqual(["browser"]);
  expect(f.events.filter(e=>e.type === "AikoLoginRequested")).toHaveLength(1);
  const missing = fixture();
  missing.binding.engine.apps = f.binding.engine.apps;
  expect((await missing.run("connector_recommend", {query:"Service"})).status).toBe("rejected");
  expect(missing.calls).toEqual([]);
});
