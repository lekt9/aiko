import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBunHost } from "tardie/bun/host";
import { ConnectorEngine, type ConnectorStore } from "../src/connectors.ts";
import { createToolRouterActor, routerEventKey, type RouterMethod } from "../src/tool-router.ts";

test("real engine auth-required transition invalidates native router readiness", async () => {
 const rows = new Map<string, unknown>();
 const store: ConnectorStore = {
  get: async key => structuredClone(rows.get(key)),
  set: async (key, value) => { rows.set(key, structuredClone(value)); },
  list: async prefix => [...rows].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)),
 };
 const engine = new ConnectorEngine({ owner: "123", store, env: { ARCADE_API_KEY: "fixture-only-router-key" }, fetch: async url => {
  const target = String(url);
  const body = target.includes("tools?") ? { items: [{ qualified_name: "GitHub.ListIssues", toolkit: { name: "GitHub", version: "1" }, description: "List GitHub repository issues", input: { parameters: [] } }], offset: 0, total_count: 1 }
   : target.endsWith("authorize") ? { status: "completed" }
   : target.endsWith("tools/execute") ? { success: false, output: { authorization: { status: "pending", url: "https://api.arcade.dev/auth/do-not-log" } } }
   : { items: [], offset: 0, total_count: 0 };
  return new Response(JSON.stringify(body));
 } });
 const connection = await engine.connect("arcade:GitHub.ListIssues");
 const directory = await mkdtemp(join(tmpdir(), "connector-router-regression-"));
 const definition = createToolRouterActor({ owner: "123", engine, readOwnedEvents: async () => [] });
 const host = await createBunHost({ database: join(directory, "router.sqlite"), actorName: "aiko", actorInstance: "regression", keyOf: routerEventKey, actorFor: () => definition });
 try {
  let sequence = 0;
  const call = async (method: RouterMethod, input: unknown): Promise<any> => {
   const invocation = { method, id: `check-${++sequence}`, epoch: 0 };
   await host.commitRoot(host.self("router-123"), definition.methods[method].eventOf({ input, invocation, at: Date.now() }));
   await host.wake("router-123");
   const state = definition.methods[method].state(await host.read("router-123"), invocation);
   expect(state?.status).toBe("completed");
   return state?.status === "completed" ? state.output : undefined;
  };
  const input = { tasks: [{ id: "issues", query: "list GitHub repository issues" }] };
  const ready = await call("route", input);
  expect(ready.state).toBe("ready");
  expect((await engine.execute(connection.id, {})).status).toBe("authorization_required");
  expect((await engine.connections())[0]!.status).toBe("failed");
  expect(await call("status", { decisionId: ready.id })).toMatchObject({ current: false });
  const rerouted = await call("route", input);
  expect(rerouted.state).toBe("needs_connection");
  expect(rerouted.tasks[0].tools[0].connected).toBe(false);
  expect(JSON.stringify(await host.read("router-123"))).not.toContain("do-not-log");
 } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
