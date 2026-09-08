import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce, renderMessages, tool, usageIn } from "tardie";
import type { Action } from "tardie/log/events";
import { actionOf } from "tardie/model";
import { definePackage } from "tardie/code/package/definition";
import { Park } from "tardie/code/execution/errors";
import { EventLog } from "tardie/core/log";
import { cancellationRequested } from "tardie/core/method/cancellation";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { codegraffSandboxLayer } from "../src/code-sandbox.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";

const databases: Database[] = [];
const hosts: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const database of databases.splice(0)) database.close();
});
function storage(): AccountStorage {
  const db = new Database(":memory:"); databases.push(db);
  let alarm: number | null = null;
  return {
    sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as never[]); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {},
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; },
  };
}
const thread = "user-batches";
const spec = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const } });
const model = (react: (request: Parameters<import("effect").Context.Service.Shape<typeof Infer>["react"]>[0]) => Effect.Effect<Action>) =>
  Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "batch" } }), react });
async function hostFor(definition: any, inference: any, saved = storage()) {
  const host = await createCloudflareAccountHost({
    storage: saved, actorName: "aiko", actorInstance: "fixture", ownsThread: t => t === thread,
    actorFor: () => definition, layersFor: () => Layer.merge(inference, codegraffSandboxLayer(runCodeSegment)),
  });
  hosts.push(host); return host;
}
const call = (callId: string, name: string, args: unknown = {}) => ({ callId, name, arguments: args });
const message = { type: "MessageReceived", id: "batch-turn", text: "Run the independent calls", at: 1 };
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native batch failed to make independent progress")), 1500); })]); }
  finally { if (timer) clearTimeout(timer); }
}

test("the native provider decoder preserves ordered calls beside execute and rejects malformed batches atomically", () => {
  const decode = (calls: any[]) => actionOf({ content: "Working", toolCalls: calls } as any);
  const wire = (id: string, name: string, args = "{}") => ({ id, type: "function", function: { name, arguments: args } });
  expect(decode([wire("one", "read"), wire("two", "execute", '{"code":"return 2"}')])).toEqual({
    kind: "calls", text: "Working", calls: [call("one", "read"), call("two", "execute", { code: "return 2" })],
  });
  expect(decode([wire("single", "read")])).toEqual({ kind: "call", text: "Working", ...call("single", "read") });
  expect(() => decode([wire("duplicate", "read"), wire("duplicate", "execute")])).toThrow("duplicate");
  expect(() => decode([wire("one", "read"), wire("two", "write", "{bad")])).toThrow("malformed JSON");
});

test("native siblings start concurrently, keep one failure local, spend once, and do not repeat after cold host replay", async () => {
  const started = gate(), release = gate();
  const effects: string[] = [];
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([tool([
    { spec: spec("slow"), run: () => Effect.promise(async () => { effects.push("slow"); started.release(); await release.promise; return { ok: true }; }) },
    { spec: spec("broken"), run: () => Effect.promise(async () => { await started.promise; effects.push("broken"); release.release(); throw new Error("fixture failure"); }) },
  ]), outputValidateOnce])] });
  let modelCalls = 0;
  const binding = model(request => {
    modelCalls++;
    const returned = request.trajectory.filter(event => event.type === "ToolReturned");
    if (!returned.length) return Effect.succeed({ kind: "calls", calls: [call("slow-call", "slow"), call("broken-call", "broken")], usage: { promptTokens: 12, completionTokens: 3 } });
    expect(returned).toHaveLength(2);
    const messages = renderMessages(request.trajectory);
    expect(messages.filter(message => message.toolCalls).map(message => message.toolCalls?.map(call => call.id))).toEqual([["slow-call", "broken-call"]]);
    return Effect.succeed({ kind: "complete", output: "Both answered", usage: { promptTokens: 2, completionTokens: 1 } });
  });
  const saved = storage();
  const host = await hostFor(definition, binding, saved);
  await host.commitRoot(host.self(thread), message);
  try { await deadline(host.drive()); } finally { release.release(); }
  const events = await host.read(thread);
  expect(effects.sort()).toEqual(["broken", "slow"]);
  expect(events.filter(event => event.type === "ToolCalled").map(event => event.batchId)).toEqual(["batch-turn/infer/0", "batch-turn/infer/0"]);
  expect(events.find(event => event.type === "ToolReturned" && event.callId === "broken-call")?.result).toMatchObject({ error: expect.stringContaining("fixture failure") });
  expect(events.find(event => event.type === "TurnCompleted")?.output).toBe("Both answered");
  expect(usageIn(events as any, message.id)).toMatchObject({ promptTokens: 14, completionTokens: 4 });
  expect(events.filter(event => event.type === "ModelCalled").map(event => event.callId)).toEqual(["batch-turn/infer/0", "batch-turn/infer/1"]);
  await host.close(); hosts.splice(hosts.indexOf(host), 1);
  const restarted = await hostFor(definition, binding, saved);
  await restarted.drive();
  expect(effects).toHaveLength(2); expect(modelCalls).toBe(2);
  expect((await restarted.read(thread)).filter(event => event.type === "ToolReturned")).toHaveLength(2);
});

test("native cancellation aborts and durably answers every running batch sibling", async () => {
  const bothStarted = gate(); let starts = 0, aborts = 0;
  const waitTool = { spec: spec("wait"), run: (_: unknown, context: { signal: AbortSignal }) => Effect.promise(() => new Promise(resolve => {
    if (++starts === 2) bothStarted.release();
    context.signal.addEventListener("abort", () => { aborts++; resolve("late result"); }, { once: true });
  })) };
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([tool(waitTool), outputValidateOnce])] });
  const host = await hostFor(definition, model(() => Effect.succeed({ kind: "calls", calls: [call("wait-a", "wait"), call("wait-b", "wait")] })));
  await host.commitRoot(host.self(thread), message);
  const driving = host.drive();
  try { await deadline(bothStarted.promise); }
  finally { await host.commitRoot(host.self(thread), cancellationRequested({ invocation: { method: "message", id: message.id, epoch: 0 }, request: "cancel-batch", cause: "requested", at: Date.now() })); }
  await deadline(driving);
  const events = await host.read(thread);
  expect(starts).toBe(2); expect(aborts).toBe(2);
  expect(events.filter(event => event.type === "ToolReturned")).toHaveLength(2);
  for (const result of events.filter(event => event.type === "ToolReturned")) expect(result.result).toMatchObject({ error: expect.stringContaining("cancelled") });
  expect(events.filter(event => event.type === "TurnCancelled")).toHaveLength(1);
  await host.drive(); expect(starts).toBe(2);
});

test("a malformed Infer batch or reused call identity cannot launch a partial batch", async () => {
  for (const malformed of [[], [call("same", "effect"), call("same", "effect")], [call("okay", "effect"), { name: "effect", arguments: {} }]]) {
    let effects = 0;
    const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([tool({ spec: spec("effect"), run: () => Effect.sync(() => ++effects) }), outputValidateOnce])] });
    const host = await hostFor(definition, model(() => Effect.succeed({ kind: "calls", calls: malformed } as Action)));
    await host.commitRoot(host.self(thread), message); await host.drive();
    const events = await host.read(thread);
    expect(effects).toBe(0); expect(events.filter(event => event.type === "ToolCalled")).toHaveLength(0);
    expect(events.find(event => event.type === "TurnFailed")?.cause).toBe("inference_error");
  }
});

test("reusing a completed call id in a later batch fails before its new sibling runs", async () => {
  let effects = 0;
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([tool({ spec: spec("effect"), run: () => Effect.sync(() => ++effects) }), outputValidateOnce])] });
  const host = await hostFor(definition, model(request => Effect.succeed(request.trajectory.some(event => event.type === "ToolReturned")
    ? { kind: "calls", calls: [call("used", "effect"), call("fresh", "effect")] }
    : { kind: "call", ...call("used", "effect") })));
  await host.commitRoot(host.self(thread), message); await host.drive();
  const events = await host.read(thread);
  expect(effects).toBe(1);
  expect(events.filter(event => event.type === "ToolCalled")).toHaveLength(1);
  expect(events.find(event => event.type === "TurnFailed")?.error).toContain("previously used");
});

test("a parked native execute does not block an unrelated ready native execute", async () => {
  let secondRuns = 0;
  const pkg = definePackage({ name: "fixture", description: "Fixture", methods: {
    wait: (_, { callId }) => Effect.gen(function* () {
      const log = yield* EventLog;
      const events = yield* log.read;
      if (events.some(event => event.type === "ResponseReceived" && (event as any).id === "reply")) return "arrived";
      return yield* Effect.fail(new Park({ callId, awaiting: "reply" }));
    }),
    ready: () => Effect.sync(() => { secondRuns++; return "independent"; }),
  } });
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([codeMode([pkg]), outputValidateOnce])] });
  const host = await hostFor(definition, model(request => request.trajectory.filter(event => event.type === "ToolReturned").length === 2
    ? Effect.succeed({ kind: "complete", output: "Both complete" })
    : Effect.succeed({ kind: "calls", calls: [call("a-parked", "execute", { code: "return await fixture.wait({});" }), call("b-ready", "execute", { code: "return await fixture.ready({});" })] })));
  await host.commitRoot(host.self(thread), message); await host.drive();
  let events = await host.read(thread);
  expect(secondRuns).toBe(1);
  expect(events.find(event => event.type === "ToolReturned" && event.callId === "b-ready")?.result).toEqual({ result: "independent" });
  expect(events.some(event => event.type === "BlockedOn")).toBe(true);
  expect(events.some(event => event.type === "TurnCompleted")).toBe(false);
  await host.commitRoot(host.self(thread), { type: "ResponseReceived", id: "reply", result: "arrived", turn: message.id, at: 5 });
  await host.drive(); events = await host.read(thread);
  expect(events.find(event => event.type === "TurnCompleted")?.output).toBe("Both complete");
  expect(secondRuns).toBe(1);
});

test("native package completion order survives a cold replay with no duplicated effects or ordinal drift", async () => {
  const releaseSlow = gate(); const observed: string[] = [];
  const pkg = definePackage({ name: "fixture", description: "Fixture", methods: {
    read: (input: any) => Effect.promise(async () => { observed.push(`read:${input.id}`); if (input.id === "slow") await releaseSlow.promise; return input.id; }),
    next: (input: any) => Effect.sync(() => { observed.push(`next:${input.id}`); if (input.id === "fast") releaseSlow.release(); return `${input.id}-done`; }),
  } });
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([codeMode([pkg]), outputValidateOnce])] });
  const binding = model(request => request.trajectory.some(event => event.type === "ToolReturned")
    ? Effect.succeed({ kind: "complete", output: "Restored" })
    : Effect.succeed({ kind: "call", ...call("ordered", "execute", { code: "return await Promise.all(['slow','fast'].map(id=>fixture.read({id}).then(id=>fixture.next({id}))));" }) }));
  const host = await hostFor(definition, binding);
  await host.commitRoot(host.self(thread), message);
  try { await deadline(host.drive()); } finally { releaseSlow.release(); }
  const events = await host.read(thread);
  expect(observed).toEqual(["read:slow", "read:fast", "next:fast", "next:slow"]);
  expect(events.filter(event => event.type === "PackageReturned").map(event => event.callId)).toEqual(["ordered.1", "ordered.2", "ordered.0", "ordered.3"]);
  const restored = await hostFor(definition, binding);
  const lastReturn = events.findLastIndex(event => event.type === "PackageReturned");
  for (const event of events.slice(0, lastReturn + 1)) await restored.commitRoot(restored.self(thread), event);
  await deadline(restored.drive());
  const replay = await restored.read(thread);
  expect(observed).toHaveLength(4);
  expect(replay.find(event => event.type === "CodeSettled")?.result).toEqual(["slow-done", "fast-done"]);
  expect(replay.find(event => event.type === "TurnCompleted")?.output).toBe("Restored");
});
