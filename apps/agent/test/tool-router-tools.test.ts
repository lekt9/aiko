import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, infer, tool, Infer, outputValidateOnce } from "tardie";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import { createBunHost } from "tardie/bun/host";
import { createToolRouterActor, routerEventKey, type ToolRouterBinding } from "../src/tool-router.ts";
import { createToolRouterTools, createToolRouterComponent } from "../src/tool-router-tools.ts";
import { routerCaller } from "../src/connector-router-host.ts";

test.each(["child", "root", "sensitive"])("native main/router bridge handles %s without blocking the host", async mode => {
  const directory = await mkdtemp("/tmp/aiko-router-bridge-");
  const binding: ToolRouterBinding = { owner: "123", engine: {
    listCatalog: async () => [{ id: "read", name: "read", toolName: "Gmail.Read", description: "Read email messages", provider: "arcade", domains: ["gmail.com"], toolkit: { name: "Gmail" }, inputSchema: { type: "object", properties: {} }, input: {}, domainEvidence: [], requirements: {}, metadata: {} }],
    describe: async () => { throw new Error("not needed"); },
    search: async () => ({ status: "unavailable", connectors: [], fallbackAllowed: false, message: "unknown" }),
    connections: async () => [{ id: "connection", connectorId: "read", provider: "arcade", status: "connected", createdAt: 0 }],
  } };
  const router = createToolRouterActor(binding);
  let host: Awaited<ReturnType<typeof createBunHost>>;
  const call = routerCaller(binding, () => host);
  const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "test", model_id: "router-bridge" } }), react: request => Effect.succeed(request.trajectory.some(e => e.type === "ToolReturned") ? { kind: "complete" as const, output: "Router result received" } : { kind: "call" as const, name: "tool_router_route", callId: "bridge", arguments: { tasks: [{ id: "mail", query: mode === "sensitive" ? "api_key=secret" : "read email messages" }] } }) });
  const main = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([createToolRouterComponent({ owner: "123", thread: "user-123", readRouter: () => host.read("router-123") }), outputValidateOnce])] });
  host = await createBunHost({ database: join(directory, "actor.sqlite"), actorName: "aiko", actorInstance: "test", keyOf: routerEventKey, actorFor: thread => thread === "router-123" ? router : main, layersFor: () => model });
  try {
    if (mode === "root") await call("status", {}, {callId:"http-first", signal:new AbortController().signal});
    await host.commitRoot(host.self("user-123"), { type: "MessageReceived", id: "turn", text: "Read my email", source: "api", at: Date.now() });
    await host.wake("user-123");
    const foreground = await host.read("user-123"), routed = await host.read("router-123");
    expect(foreground.some(e => e.type === "TurnCompleted")).toBe(true);
    if (mode === "sensitive") {
      expect(foreground.find(e => e.type === "ToolReturned")?.result).toMatchObject({state:"catalog_unavailable"});
      expect(routed).toEqual([]);
    } else {
      expect(foreground.find(e => e.type === "ToolReturned")?.result).toMatchObject({ state: "ready", tasks: [{ taskId: "mail" }] });
      expect(routed.some(e => e.type === "AikoRouterRequested")).toBe(true);
      expect(routed.some(e => e.type === "AikoRouterDecisionRecorded")).toBe(true);
      expect(foreground.some(e => e.type === "ResponseReceived")).toBe(true);
    }
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);

test("router callback is owner bound and publishes only four meta tools", async () => {
  let calls = 0;
  const tools = createToolRouterTools({ owner: "123", thread: "user-123", call: async () => { calls++; return {}; } });
  expect(tools.map(t => t.spec.name)).toEqual(["tool_router_discover", "tool_router_describe", "tool_router_route", "tool_router_status"]);
  const result = await Effect.runPromise(tools[0]!.run({}, { callId: "other", signal: new AbortController().signal }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "test", thread: "user-456" }), Effect.provideService(EventLog, { read: Effect.succeed([]), head: Effect.succeed(0), readFrom: () => Effect.succeed([]), append: () => Effect.void })));
  expect(result).toMatchObject({ reason: "owner_binding_mismatch" }); expect(calls).toBe(0);
});
