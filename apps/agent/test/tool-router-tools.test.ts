import { cancellationRequested } from "tardie/core/method";
import { validateActor } from "tardie/core/actor";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, infer, tool, Infer, outputValidateOnce } from "tardie";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import { createBunHost } from "tardie/bun/host";
import { createToolRouterActor, routerEventKey, type ToolRouterBinding } from "../src/tool-router.ts";
import { createToolRouterComponent } from "../src/tool-router-tools.ts";
import { routerCaller } from "../src/connector-router-host.ts";

test.each(["child", "root", "sensitive", "invalid"])("native main/router bridge handles %s without blocking the host", async mode => {
  const directory = await mkdtemp("/tmp/aiko-router-bridge-");
  const binding: ToolRouterBinding = { owner: "123", engine: {
    listCatalog: async () => [{ id: "read", name: "read", toolName: "Gmail.Read", description: "Read email messages", provider: "arcade", domains: ["gmail.com"], toolkit: { name: "Gmail" }, inputSchema: { type: "object", properties: {} }, input: {}, domainEvidence: [], requirements: {}, metadata: {} }],
    describe: async () => { throw new Error("not needed"); },
    search: async () => ({ status: "unavailable", connectors: [], fallbackAllowed: false, message: "unknown" }),
    connections: async () => [{ id: "connection", connectorId: "read", provider: "arcade", status: "connected", createdAt: 0 }],
  } };
  const router = validateActor(createToolRouterActor(binding));
  let host: Awaited<ReturnType<typeof createBunHost>>;
  const call = routerCaller(binding, () => host);
  const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "test", model_id: "router-bridge" } }), react: request => Effect.succeed(request.trajectory.some(e => e.type === "ToolReturned") ? { kind: "complete" as const, output: "Router result received" } : { kind: "call" as const, name: "tool_router_route", callId: "bridge", arguments: mode === "invalid" ? { tasks: "not-an-array" } : { tasks: [{ id: "mail", query: mode === "sensitive" ? "api_key=secret" : "read email messages" }] } }) });
  const main = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([createToolRouterComponent({ owner: "123", thread: "user-123", readRouter: () => host.read("router-123") }), outputValidateOnce])] });
  host = await createBunHost({ database: join(directory, "actor.sqlite"), actorName: "aiko", actorInstance: "test", keyOf: routerEventKey, actorFor: thread => thread === "router-123" ? router : main, layersFor: () => model });
  try {
    if (mode === "root") await call("status", {}, {callId:"http-first", signal:new AbortController().signal});
    await host.commitRoot(host.self("user-123"), { type: "MessageReceived", id: "turn", text: "Read my email", source: "api", at: Date.now() });
    await host.wake("user-123");
    const foreground = await host.read("user-123"), routed = await host.read("router-123");
    expect(foreground.some(e => e.type === "TurnCompleted")).toBe(true);
    if (["sensitive", "invalid"].includes(mode)) {
      expect(foreground.find(e => e.type === "ToolReturned")?.result).toMatchObject({state:"catalog_unavailable"});
      expect(routed).toEqual([]);
    } else {
      expect(foreground.find(e => e.type === "ToolReturned")?.result).toMatchObject({ state: "ready", tasks: [{ taskId: "mail" }] });
      expect(routed.some(e => e.type === "AikoRouterRequested")).toBe(true);
      expect(routed.some(e => e.type === "AikoRouterDecisionRecorded")).toBe(true);
      expect(foreground.some(e => e.type === "ResponseReceived")).toBe(true);
      expect(foreground.some(e => e.type === "CallPlanned")).toBe(true);
      expect(foreground.some(e => e.type === "InvocationLinked" && (e.parent as any)?.id === "turn")).toBe(true);
      expect(foreground.some(e => e.type === "CallDispatched" && typeof e.deadlineAt === "number")).toBe(true);
      expect(foreground.some(e => e.type === "AikoRouterBridgeDispatched")).toBe(false);
    }
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
}, 15000);

test("router bridge is owner bound and publishes only four meta tools", () => {
  const bridge = createToolRouterComponent({ owner: "123", thread: "user-123", readRouter: async () => [] });
  const tools = bridge.machine.output(bridge.machine.initial()).view.tools;
  expect(tools.map(t => t.spec.name)).toEqual(["tool_router_discover", "tool_router_describe", "tool_router_route", "tool_router_status"]);
  let result: unknown;
  tools[0]!.serve({ callId: "foreign", name: "tool_router_discover", arguments: {} }, [{ type: "ThreadCreated", address: { actor: "aiko", instance: "test", thread: "user-456" }, depth: 0, at: 1 }], value => { result = value; return {} as never; });
  expect(result).toMatchObject({ reason: "owner_binding_mismatch" });
});

test("cancelling a foreground turn cancels its native router method without waiting on catalog I/O", async () => {
  const directory = await mkdtemp("/tmp/aiko-router-cancel-");
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>(r => { entered = r; });
  const gate = new Promise<never[]>(r => { release = () => r([]); });
  const binding: ToolRouterBinding = { owner: "123", engine: {
    listCatalog: async () => { entered(); return gate; },
    describe: async () => { throw new Error("unused"); },
    connections: async () => [], search: async () => ({ status: "unavailable", connectors: [], fallbackAllowed: false, message: "unavailable" }),
  } };
  const router = validateActor(createToolRouterActor(binding));
  let host: Awaited<ReturnType<typeof createBunHost>>;
  const main = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([
    createToolRouterComponent({ owner: "123", thread: "user-123", readRouter: () => host.read("router-123") }), outputValidateOnce,
  ])] });
  host = await createBunHost({ database: join(directory, "actor.sqlite"), actorName: "aiko", actorInstance: "cancel-test", actorFor: t => t === "router-123" ? router : main,
    layersFor: () => Layer.succeed(Infer, { resolve: () => ({ model: { provider: "test", model_id: "cancel" } }), react: () => Effect.succeed({ kind: "call", callId: "route", name: "tool_router_route", arguments: { tasks: [{ id: "read", query: "read email" }] } }) }),
  });
  let driving: Promise<void> | undefined;
  try {
    await host.commitRoot(host.self("user-123"), { type: "MessageReceived", id: "turn", text: "Read email", at: Date.now() });
    driving = host.wake("user-123");
    await began;
    await host.commitRoot(host.self("user-123"), cancellationRequested({ request: "stop", invocation: { method: "message", id: "turn", epoch: 0 }, cause: "requested", at: Date.now() }));
    await driving;
    const parent = await host.read("user-123"), child = await host.read("router-123");
    expect(parent.some(e => e.type === "CancellationDispatched")).toBe(true);
    expect(parent.some(e => e.type === "TurnCancelled")).toBe(true);
    expect(child.some(e => e.type === "AikoRouterCancelled")).toBe(true);
    expect(child.some(e => e.type === "AikoRouterDecisionRecorded")).toBe(false);
    release();
    await host.drive();
    expect((await host.read("router-123")).some(e => e.type === "AikoRouterDecisionRecorded")).toBe(false);
  } finally { release(); await driving; await host.close(); await rm(directory, { recursive: true, force: true }); }
}, 5000);
