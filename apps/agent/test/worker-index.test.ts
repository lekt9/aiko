import { expect, test } from "bun:test";
import { Effect } from "effect";
import { EventLog, withWatermark } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { Self } from "tardie/core/runtime";
import { threadCreated, childCreated } from "tardie/core/thread";
import type { HarnessTransportResponse } from "@unbrowse/browser-harness/harness-runtime";
import { BrowserLearning } from "../src/browser-learning.ts";
import { artifactDigestOf, ownedNetworkDefinitions, ownedObservedActions } from "../src/capability-builder-network.ts";
import { workerIndexTools, scopedWorkerTools, type WorkerBinding, type WorkerGrant } from "../src/code-agents.ts";
import { createObservedNetworkTools } from "../src/observed-network.ts";

const origin = "https://api.vendor.com";
async function capture(method = "GET", site = origin) {
  const events: Event[] = []; let sequence = 0;
  const learning = new BrowserLearning({ threadId: "index-trace", nextSequence: () => ++sequence, emit: async e => { events.push(e); } });
  const entry = (url: string, body: string, index: number) => ({
    startedDateTime: new Date(1000 + index * 100).toISOString(), time: 20, _observationComplete: true,
    request: { method: index ? method : "GET", url, headers: [], cookies: [],
      ...(index && method === "POST" ? { postData: { mimeType: "application/json", text: '{"title":"CAPTURED_TITLE_SENTINEL"}' } } : {}) },
    response: { status: index && method === "POST" ? 201 : 200, headers: [], cookies: [], content: { mimeType: "application/json", size: body.length, text: body } },
  });
  const entries = [entry(`${site}/items`, '{"item":"CAPTURED_ID_SENTINEL"}', 0),
    entry(`${site}/details?item=CAPTURED_ID_SENTINEL`, '{"restaurants":[{"name":"CAPTURED_NAME_SENTINEL","rating":4}],"posts":[{"title":"CAPTURED_POST_SENTINEL"}]}', 1)];
  for (let i = 0; i < entries.length; i++) await learning.observe(entries[i]!, i, true);
  await learning.compile(entries, [{ callId: "capture", action: "navigate", startedAtMs: 999, endedAtMs: 1250, direct: true, resultObserved: true }], site);
  const reads = ownedNetworkDefinitions(events);
  for (const read of reads) events.push({ type: "AikoRequestMemoryIndexed", toolDigest: read.toolDigest, pointerId: `obs_${read.toolDigest.slice(7)}` });
  return events;
}
function fixture(events: Event[]) {
  const parentAddress = { actor: "aiko", instance: "index-fixture", thread: "user-123" };
  const address = { ...parentAddress, thread: "ag.4:turncall" };
  const grant: WorkerGrant = { type: "AikoWorkerGranted", owner: "123", parentThread: "user-123", turn: "turn", epoch: 0,
    callId: "call", scope: "browser", profile: "browser-v1", origins: [origin], actions: [], background: true, placement: "independent", at: 1 };
  const parent: Event[] = [threadCreated(parentAddress, undefined, 0), grant as unknown as Event,
    childCreated("call", address, { parent: parentAddress, depth: 1, placement: "independent" }, 1, "turn"), ...events];
  const child: Event[] = [threadCreated(address, { parent: parentAddress, depth: 1, placement: "independent" }, 1),
    { type: "MessageReceived", id: "call", text: "Find restaurant ratings", link: { source: parentAddress, target: address }, at: 1 }];
  const binding: WorkerBinding = { owner: "123", thread: address.thread, readParent: async () => parent, readChild: async () => child };
  const tools = scopedWorkerTools(binding, workerIndexTools(binding));
  const invoke = (tool: typeof tools[number], input: unknown, self = address): Promise<any> => Effect.runPromise(tool.run(input,
    { callId: "index-call", turn: "call", signal: new AbortController().signal }).pipe(
    Effect.provideService(Self, self), Effect.provideService(EventLog, withWatermark({ read: Effect.sync(() => child),
      append: rows => Effect.sync(() => { child.push(...rows); }) })),
  ));
  const run = (name: string, input: unknown = {}) => invoke(tools.find(t => t.spec.name === name)!, input);
  return { parent, child, grant, binding, tools, invoke, run };
}

test("native worker retrieval finds observed output concepts and inspects a paged fresh-response DAG without executing", async () => {
  const f = fixture(await capture());
  const before = JSON.stringify(f.parent);
  const found = await f.run("worker_index_search", { query: "find restaurant rating" });
  expect(found.retrieval).toBe("ranked-lexical");
  const d = found.definitions[0];
  expect(d.endpoint.output.fields).toContainEqual({ path: "$.restaurants[].rating", types: ["number"] });
  expect(d.endpoint.recomputation).toMatchObject({ stepCount: 2, dependencyCount: 1, freshInputs: true, capturedValues: false });
  expect(d.pointerId).toMatch(/^obs_[a-f0-9]{64}$/);
  expect(d.executeWith).toBe("observed_network_run");
  expect(d.sessionRequired).toBe(false);
  expect((await f.run("worker_index_search", { query: "find recent posts" })).definitions[0].kind).toBe("read");
  const first = await f.run("worker_index_describe", { toolDigest: d.toolDigest, limit: 1 });
  expect(first.graph).toMatchObject({ totalSteps: 2, offset: 0, nextOffset: 1, order: "topological", capturedValues: false });
  const second = await f.run("worker_index_describe", { toolDigest: d.toolDigest, offset: first.graph.nextOffset, limit: 1 });
  expect(second.graph.nextOffset).toBeNull();
  expect(second.graph.steps[0].dependsOn).toContain(first.graph.steps[0].id);
  expect(second.graph.steps[0].query.item).toEqual({ kind: "response_json", stepId: first.graph.steps[0].id, pointer: "/item" });
  expect(JSON.stringify([found, first, second])).not.toContain("CAPTURED_");
  expect(JSON.stringify(f.parent)).toBe(before);
  expect(f.child).toHaveLength(2);
});

test.each([false, true])("retrieved native DAG uses current producer values and never falls back to captured ones (missing: %s)", async missing => {
  const f = fixture(await capture());
  const found = await f.run("worker_index_search", { query: "restaurant rating" });
  const d = found.definitions[0];
  const described = await f.run("worker_index_describe", { toolDigest: d.toolDigest });
  const requests: string[] = [];
  const native = scopedWorkerTools(f.binding, createObservedNetworkTools({ owner: "123", thread: f.binding.thread,
    readEvents: async () => f.parent, redact: s => s, checkArcade: async () => true, send: async (request): Promise<HarnessTransportResponse> => {
      requests.push(request.url);
      return { status: 200, headers: {}, classification: "application", body: requests.length === 1
        ? missing ? {} : { item: "CURRENT_ITEM" } : { restaurants: [{ name: "Current restaurant", rating: 5 }] } };
    } }))[0]!;
  const inputs = Object.fromEntries(d.inputs.map((i: { name: string }) => [i.name, i.name.includes("0001") ? "items" : "details"]));
  expect(described.graph.steps).toHaveLength(2);
  const result = await f.invoke(native, { toolDigest: d.toolDigest, inputs });
  expect(result.browser).toBe(false);
  if (missing) { expect(result.status).not.toBe("completed"); expect(requests).toHaveLength(1); }
  else { expect(result.status).toBe("completed"); expect(requests).toHaveLength(2); expect(requests[1]).toContain("item=CURRENT_ITEM"); }
  expect(requests.join(" ")).not.toContain("CAPTURED_");
});

test("origin/action restrictions, owner lineage, cancellation and removed evidence fence search, describe and retained graphs", async () => {
  const events = await capture(), f = fixture(events);
  const d = (await f.run("worker_index_search", { query: "restaurant rating" })).definitions[0];
  const describe = f.tools.find(t => t.spec.name === "worker_index_describe")!;
  const args = { toolDigest: d.toolDigest };
  expect(await describe.authorizeRetained!(args)).toBe(true);
  f.grant.actions = [`sha256:${"f".repeat(64)}`];
  expect((await f.run("worker_index_search")).definitions).toEqual([]);
  expect(await f.run("worker_index_describe", args)).toMatchObject({ status: "blocked" });
  expect(await describe.authorizeRetained!(args)).toBe(false);
  f.grant.actions = [d.toolDigest];
  expect((await f.run("worker_index_search")).definitions).toHaveLength(1);
  expect(await describe.authorizeRetained!(args)).toBe(true);
  f.grant.origins = ["https://other.vendor.com"];
  expect((await f.run("worker_index_search")).definitions).toEqual([]);
  expect(await describe.authorizeRetained!(args)).toBe(false);
  f.grant.origins = [origin];
  expect(await f.invoke(describe, args, { actor: "aiko", instance: "index-fixture", thread: "user-456" })).toMatchObject({ status: "blocked" });
  const foreign = { ...f.binding, owner: "456" };
  expect(await f.invoke(workerIndexTools(foreign)[0]!, {})).toMatchObject({ status: "blocked" });
  f.child.push({ type: "CancellationRequested", invocation: { method: "message", id: "call", epoch: 0 }, request: "stop", cause: "requested", at: 4 });
  expect(await f.run("worker_index_search")).toMatchObject({ status: "blocked" });
  expect(await describe.authorizeRetained!(args)).toBe(false);
  f.child.pop();
  f.parent.splice(3);
  expect((await f.run("worker_index_search")).definitions).toEqual([]);
  expect(await f.run("worker_index_describe", args)).toMatchObject({ status: "blocked" });
  expect(await describe.authorizeRetained!(args)).toBe(false);
});

test("a permitted endpoint cannot disclose a DAG whose prerequisite origin is outside the grant", async () => {
  const bootstrap = "https://bootstrap.vendor.com";
  const events = await capture("POST"), action = ownedObservedActions(events)[0]!;
  // Host-prepared multi-origin action fixture: this tests scope projection, not
  // a claim that the browser compiler learns arbitrary cross-site bindings.
  expect(action.artifact.actions[0]!.steps).toHaveLength(2);
  const artifact = { ...action.artifact, allowedOrigins: [bootstrap, origin], actions: action.artifact.actions.map(a => ({ ...a,
    steps: a.steps.map((step, i) => i === 0 ? { ...step, origin: bootstrap } : step) })) };
  const artifactDigest = artifactDigestOf(artifact);
  events.push({ ...action, artifact, artifactDigest } as unknown as Event);
  const f = fixture(events); f.grant.actions = [artifactDigest];
  expect((await f.run("worker_index_search")).definitions).toEqual([]);
  f.grant.origins.push(bootstrap);
  const d = (await f.run("worker_index_search")).definitions[0];
  expect(d.origins).toContain(bootstrap);
  expect(d.origins).toContain(origin);
  expect(d.endpoint.recomputation.stepCount).toBe(2);
  const args = { artifactDigest };
  expect((await f.run("worker_index_describe", args)).graph.totalSteps).toBe(2);
  f.grant.origins = [origin];
  expect(await f.run("worker_index_describe", args)).toMatchObject({ status: "blocked" });
});

test("nested/tampered endpoint prose cannot supply retrieval meaning or create executable evidence", async () => {
  const events = await capture();
  const f = fixture(events.flatMap(e => e.type === "AikoObservedEndpointDescribed"
    ? [{ ...e, id: "tampered" }, { type: "ToolReturned", result: e }] : [e]));
  expect((await f.run("worker_index_search", { query: "restaurant rating" })).definitions).toEqual([]);
  const d = (await f.run("worker_index_search")).definitions[0];
  expect(d.endpoint.output.shape).toBe("unavailable");
  f.parent.splice(3, f.parent.length, { type: "ToolReturned", result: events });
  expect((await f.run("worker_index_search")).definitions).toEqual([]);
  expect(await f.run("worker_index_describe", { toolDigest: d.toolDigest })).toMatchObject({ status: "blocked" });
});

test("discovery is bounded and paginated, and malformed selectors do not widen it", async () => {
  const f = fixture(await capture());
  const all = await f.run("worker_index_search");
  expect(all.definitions.length).toBeGreaterThan(1);
  const first = await f.run("worker_index_search", { limit: 1 });
  expect(first.coverage).toBe("partial");
  const rest = await f.run("worker_index_search", { offset: first.nextOffset });
  expect([...first.definitions, ...rest.definitions]).toEqual(all.definitions);
  expect(rest.nextOffset).toBeNull();
  expect(new TextEncoder().encode(JSON.stringify(all)).length).toBeLessThanOrEqual(24_000);
  for (const input of [null, { query: {} }, { query: "a".repeat(1001) }, { limit: 33 }, { offset: -1 }, { offset: 0.5 }, { origin: "https://other.vendor.com" }])
    expect(await f.run("worker_index_search", input)).toMatchObject({ status: "blocked" });
  const d = all.definitions[0];
  for (const input of [{}, { toolDigest: d.toolDigest, artifactDigest: d.toolDigest }, { toolDigest: d.toolDigest, limit: 9 }, { artifactDigest: d.toolDigest }, { toolDigest: "fake" }])
    expect(await f.run("worker_index_describe", input)).toMatchObject({ status: "blocked" });
});

test("write graph discovery omits constants and cannot mint approval or send an action", async () => {
  const events = await capture("POST");
  const action = ownedObservedActions(events)[0]!;
  expect(action).toBeDefined();
  const changed = structuredClone(action.artifact);
  (changed.actions[0]!.steps.at(-1)! as any).body = { kind: "object", fields: { title: { kind: "constant", value: "HOST_PRIVATE_CONSTANT" } } };
  const artifactDigest = artifactDigestOf(changed);
  events.push({ ...action, artifact: changed, artifactDigest } as unknown as Event);
  const f = fixture(events); f.grant.actions = [artifactDigest];
  expect((await f.run("worker_index_search", { query: "find restaurants" })).definitions).toEqual([]);
  const found = await f.run("worker_index_search");
  expect(found.definitions[0]).toMatchObject({ kind: "write", artifactDigest, executeWith: "observed_network_run" });
  const graph = await f.run("worker_index_describe", { artifactDigest });
  expect(graph.graph.steps.at(-1).body.fields.title).toEqual({ kind: "constant", valueOmitted: true });
  expect(JSON.stringify([found, graph])).not.toMatch(/HOST_PRIVATE_CONSTANT|CAPTURED_|approvalId/);
  expect(f.child).toHaveLength(2);
});
