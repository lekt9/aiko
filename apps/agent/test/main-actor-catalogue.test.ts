import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import type { Action } from "tardie/log/events";
import { createBunHost } from "tardie/bun/host";
import { createAikoActor } from "../src/actor.ts";
import { withRequiredResponse } from "../src/channel-response.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(backend: "bun" | "account", model: (request: InferRequest) => Action, code = false) {
  const directory = await mkdtemp("/tmp/aiko-catalogue-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = new Database(":memory:");
  cleanup.push(() => db.close());
  const storage: AccountStorage = {
    sql: { exec: (query, ...args) => { const rows = db.query(query).all(...args as never[]); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {},
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  let work = 0, sends = 0, models = 0;
  const sent: string[] = [], prompts: string[] = [];
  const harness = code ? new CodeHarness("123", "user-123", runCodeSegment, text => text) : undefined;
  const definition = createAikoActor({
    owner: "123", live: true, codeHarness: harness,
    memory: { owner: "123", thread: "user-123", stateDir: directory, redact: text => text, readPage: async () => [] },
    voice: input => Effect.succeed({ source: "template" as const, text: input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : "Hello" }),
    send: async (_chat, text) => { sends++; sent.push(text); return { status: "delivered" }; },
    extraTools: [
      { spec: { name: "fixture_work", description: "Produce the requested artifact", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        run: () => Effect.sync(() => { work++; return { artifact: "fixture-artifact", checked: true }; }) },
      { spec: { name: "send_message", description: "Synthetic channel edge", inputSchema: { type: "object", properties: { final: { type: "boolean" }, text: { type: "string" } }, required: ["text"] } },
        run: (input, context) => Effect.sync(() => { sends++; sent.push((input as { text: string }).text); return {
          owner: "123", turn: context.turn, status: "unknown", final: (input as { final?: boolean }).final === true,
        }; }) },
    ],
  });
  const base = withRequiredResponse(Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "catalogue" } }),
    react: request => { models++; prompts.push(request.system); return Effect.succeed(model(request)); },
  }));
  const common = {
    actorName: "aiko", actorInstance: "catalogue-test", actorFor: () => definition,
    layersFor: () => harness ? Layer.merge(harness.inference(base), harness.sandboxLayer()) : base,
  };
  const open = () => backend === "bun" ? createBunHost({ ...common, database: join(directory, "native.sqlite") })
    : createCloudflareAccountHost({ ...common, storage, ownsThread: thread => thread === "user-123" });
  let host = await open();
  cleanup.push(() => host.close());
  return {
    get host() { return host; }, prompts, sent,
    counts: () => ({ work, sends, models }),
    run: async () => {
      await host.commitRoot(host.self("user-123"), { type: "MessageReceived", id: "task", source: "telegram", sender: "123", chat: "123", text: "Produce and check the artifact before answering.", at: Date.now() });
      await host.wake("user-123");
      return host.read("user-123");
    },
    restart: async () => { await host.close(); host = await open(); await host.recover(); return host.read("user-123"); },
  };
}

for (const backend of ["bun", "account"] as const) {
  test(`${backend}: premature final batch dispatches neither work nor success, and stays failed on restart`, async () => {
    const f = await fixture(backend, () => ({ kind: "calls", calls: [
      { name: "fixture_work", callId: "work", arguments: {} },
      { name: "respond", callId: "reply", arguments: { text: "Everything was checked." } },
    ] }));
    const events = await f.run();
    expect(events.some(e => e.type === "TurnFailed")).toBe(true);
    expect(events.some(e => e.type === "ToolCalled")).toBe(false);
    expect(events.some(e => e.type === "AikoResponseRequested")).toBe(false);
    expect(f.counts().work).toBe(0);
    expect(f.sent).not.toContain("Everything was checked.");
    const counts = f.counts();
    expect(await f.restart()).toEqual(events);
    expect(f.counts()).toEqual(counts);
  });

  test(`${backend}: two final replies cannot race or resend an uncertain send`, async () => {
    const f = await fixture(backend, () => ({ kind: "calls", calls: [
      { name: "send_message", callId: "send", arguments: { text: "First answer", final: true } },
      { name: "respond", callId: "reply", arguments: { text: "Second answer" } },
    ] }));
    const events = await f.run();
    expect(events.some(e => e.type === "TurnFailed")).toBe(true);
    expect(events.some(e => e.type === "ToolCalled")).toBe(false);
    expect(f.sent).not.toContain("First answer");
    expect(f.sent).not.toContain("Second answer");
    const counts = f.counts();
    expect(await f.restart()).toEqual(events);
    expect(f.counts()).toEqual(counts);
  });

  test(`${backend}: an explicit blocker retains the request and does not claim task completion`, async () => {
    const text = "The artifact could not be checked. I need access to its destination before continuing.";
    const f = await fixture(backend, () => ({ kind: "call", name: "respond", callId: "blocked", arguments: { text, outcome: "blocked" } }));
    const events = await f.run();
    expect(events.find(e => e.type === "AikoResponseRequested")).toMatchObject({ outcome: "blocked", output: text });
    expect(events.find(e => e.type === "MessageReceived")?.text).toBe("Produce and check the artifact before answering.");
    expect(f.sent).toEqual([text]);
    expect(f.counts().work).toBe(0);
    expect(await f.restart()).toEqual(events);
    expect(f.sent).toEqual([text]);
  });

  test(`${backend}: awaited work followed by a standalone response keeps native receipts and policy`, async () => {
    const f = await fixture(backend, request => request.trajectory.some(e => e.type === "ToolReturned")
      ? { kind: "complete", output: "The fixture artifact is ready." }
      : { kind: "call", name: "fixture_work", callId: "work", arguments: {} });
    const events = await f.run();
    expect(events.filter(e => e.type === "ToolCalled").map(e => e.name)).toEqual(["fixture_work", "respond"]);
    expect(events.some(e => e.type === "TurnCompleted")).toBe(true);
    expect(f.counts()).toEqual({ work: 1, sends: 1, models: 2 });
    expect(f.prompts[0]).toContain("Aiko task discipline");
    expect(f.prompts[0]).toContain("acceptance criteria");
    expect(f.prompts[0]).not.toContain("/home/deck/work/agent-harness");
    expect(await f.restart()).toEqual(events);
    expect(f.counts()).toEqual({ work: 1, sends: 1, models: 2 });
  });

  test(`${backend}: final sends inside execute cannot bypass the response boundary; progress still works`, async () => {
    const program = `const denied = await tools.call({name:"send_message",arguments:{text:"Premature success",final:true}});
      if(!denied.error) throw Error("final send escaped the native boundary");
      return await tools.call({name:"fixture_work",arguments:{}});`;
    const f = await fixture(backend, request => request.trajectory.some(e => e.type === "ToolReturned")
      ? { kind: "call", name: "respond", callId: "reply", arguments: { text: "The artifact is checked." } }
      : { kind: "calls", calls: [
        { name: "send_message", callId: "progress", arguments: { text: "Checking the artifact.", final: false } },
        { name: "execute", callId: "compose", arguments: { code: program } },
      ] }, true);
    const events = await f.run();
    expect(f.sent).toEqual(["Checking the artifact.", "The artifact is checked."]);
    expect(f.counts().work).toBe(1);
    expect(events.some(e => e.type === "TurnCompleted")).toBe(true);
    const counts = f.counts();
    expect(await f.restart()).toEqual(events);
    expect(f.counts()).toEqual(counts);
  });
}
