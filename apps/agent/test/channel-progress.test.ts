import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor, infer, Infer, outputValidateOnce, type InferRequest } from "tardie";
import { tool } from "tardie/component/tool";
import type { Action } from "tardie/log/events";
import { createBunHost } from "tardie/bun/host";
import { threadCreated } from "tardie/core/thread";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import type { Event } from "tardie/core/event";
import { Effect, Layer } from "effect";
import { channelProgress } from "../src/channel-progress.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const message = { type: "MessageReceived", id: "turn", source: "telegram", chat: "123", sender: "123", telegram: { messageId: 8, messageThreadId: 9 }, at: 1 };
async function fixture(options: {
  model?: (request: InferRequest) => Action;
  work?: () => Effect.Effect<string>;
  sendStatus?: "delivered" | "unknown" | "rejected";
} = {}) {
  const directory = await mkdtemp("/tmp/aiko-progress-");
  cleanup.push(() => rm(directory, {recursive: true, force: true}));
  const sent: {text: string; context: unknown}[] = [];
  const definition = actor({ name: "aiko", methods: {}, components: [channelProgress({
    owner: "123", redact: text => text.replaceAll("fixture-secret", "[redacted]"),
    voice: input => Effect.succeed({ text: input.kind === "answer" ? input.text : "", source: "model" as const }),
    send: async (_owner, text, _signal, context) => { sent.push({text, context}); return {status: options.sendStatus ?? "delivered"}; },
  }), ...(options.model ? [infer([tool([{
    spec: { name: "slow_work", description: "Fixture work", inputSchema: {type: "object"} },
    run: () => options.work?.() ?? Effect.succeed("Done"),
  }]), outputValidateOnce])] : [])] });
  const open = () => createBunHost({ database: join(directory, "actor.sqlite"), actorName: "aiko", actorInstance: "progress-test", actorFor: () => definition,
    layersFor: () => Layer.succeed(Infer, {
      resolve: () => ({model: {provider: "fixture", model_id: "progress"}}),
      react: request => options.model ? Effect.succeed(options.model(request)) : Effect.die(new Error("Unexpected inference")),
    }) });
  let host = await open();
  await host.seed("user-123", [threadCreated(parseThreadAddress(host.self("user-123")), undefined, 0)]);
  cleanup.push(() => host.close());
  return {
    sent,
    append: async (...events: Event[]) => { await host.seed("user-123", events); await host.wake("user-123"); return host.read("user-123"); },
    restart: async () => { await host.close(); host = await open(); await host.wake("user-123"); },
  };
}

for (const batch of [false, true]) test(`silent ${batch ? "batched" : "single"} tool work gets one real update before the slow tool starts`, async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const f = await fixture({
    model: request => {
      const calls = request.trajectory.filter(e => e.type === "ToolCalled");
      if (calls.length >= 2) return {kind: "complete", output: "Finished"};
      const call = {name: "slow_work", callId: `work-${calls.length}`, arguments: {private: "fixture-secret"}};
      return batch ? {kind: "calls", calls: [call, {...call, callId: `${call.callId}-sibling`}]} : {kind: "call", ...call};
    },
    work: () => Effect.promise(async () => { entered.resolve(); return release.promise; }),
  });
  const running = f.append(message);
  try {
    await entered.promise;
    expect(f.sent).toEqual([{text: "I’m looking into your request now.", context: {replyTo: 8, messageThreadId: 9}}]);
  } finally { release.resolve("Done"); await running; }
  const events = await f.append();
  expect(events.filter(e => e.type === "ToolReturned")).toHaveLength(2);
  expect(events.filter(e => e.type === "AikoProgressSettled")).toHaveLength(1);
  expect(events.find(e => e.type === "AikoProgressSettled")).toMatchObject({source: "host", result: {status: "delivered"}});
  expect(JSON.stringify(f.sent)).not.toContain("fixture-secret");
  await f.restart();
  expect(f.sent).toHaveLength(1);
});

for (const status of ["unknown", "rejected"] as const) test(`an early update with ${status} delivery is not retried on more work or restart`, async () => {
  const f = await fixture({sendStatus: status});
  await f.append(message);
  await f.append({type: "ToolCalled", turn: "turn", callId: "one", name: "execute", arguments: {}, at: 2});
  await f.append({type: "Compacted", turn: "turn", state: "Earlier working context compacted", at: 3},
    {type: "ToolCalled", turn: "turn", callId: "two", name: "execute", arguments: {}, at: 4});
  expect(f.sent).toHaveLength(1);
  await f.restart();
  expect(f.sent).toHaveLength(1);
});

test("commentary or an explicit send replaces the fallback, regardless of batch order", async () => {
  for (const explicit of [false, true]) for (const sendFirst of [false, true]) {
    const f = await fixture();
    await f.append(message);
    const work = {type: "ToolCalled", turn: "turn", callId: "work", name: "execute", arguments: {}, at: 3};
    const send = {type: "ToolCalled", turn: "turn", callId: "send", name: "send_message", arguments: {final: false}, at: 3};
    await f.append({type: "TextReturned", turn: "turn", text: "I’m checking the opening hours.", at: 2},
      ...(explicit ? (sendFirst ? [send, work] : [work, send]) : [work]));
    await f.append({...work, callId: "later", at: 4});
    expect(f.sent.map(e => e.text)).toEqual(explicit ? [] : ["I’m checking the opening hours."]);
  }
});

test("early feedback does not replay pre-upgrade silent work or target other channels or senders", async () => {
  const f = await fixture();
  await f.append(message, {type: "AikoProgressActivated", at: 2},
    {type: "ToolCalled", turn: "turn", callId: "old", name: "execute", at: 3});
  expect(f.sent).toHaveLength(0);
  for (const inbound of [
    {...message, id: "api", source: "api"}, {...message, id: "foreign", chat: "456"},
    {...message, id: "spoofed", sender: "456"}, {...message, id: "background", source: "background"},
  ]) await f.append(inbound, {type: "ToolCalled", turn: inbound.id, callId: inbound.id, name: "execute", at: 4});
  expect(f.sent).toHaveLength(0);
  await f.append({type: "ToolCalled", turn: "turn", callId: "fresh", name: "execute", at: 5});
  expect(f.sent).toHaveLength(1);
});

test("a resumed epoch can give early feedback without replaying cancelled or terminal work", async () => {
  const f = await fixture();
  await f.append(message);
  const work = {type: "ToolCalled", turn: "turn", callId: "old", name: "execute", at: 2};
  await f.append(work, {type: "TurnCancelled", turn: "turn", at: 3});
  expect(f.sent).toHaveLength(0);
  await f.append({type: "TurnResumed", turn: "turn", epoch: 1, at: 4}, {...work, callId: "stale", at: 5});
  expect(f.sent).toHaveLength(0);
  await f.append({...work, callId: "current", epoch: 1, at: 6});
  expect(f.sent).toHaveLength(1);
});

test("a resumed epoch can report progress; late text from the cancelled epoch cannot", async () => {
  const f = await fixture();
  await f.append(message);
  await f.append({type:"TurnCancelled",turn:"turn",at:2});
  await f.append({type:"TurnResumed",turn:"turn",epoch:1,at:3},
    {type:"TextReturned",turn:"turn",epoch:0,text:"Stale text",at:4},
    {type:"TextReturned",turn:"turn",epoch:1,text:"I’m checking the remaining result. fixture-secret",at:5});
  expect(f.sent).toEqual([{text:"I’m checking the remaining result. [redacted]", context:{replyTo:8,messageThreadId:9}}]);
  await f.restart();
  expect(f.sent).toHaveLength(1);
});

test("a started progress delivery is uncertain on recovery and is never sent twice", async () => {
  const f = await fixture();
  const text = "I’m checking the result.";
  const key = createHash("sha256").update(JSON.stringify(["turn",0,text])).digest("hex");
  await f.append(message);
  const events = await f.append({type:"TextReturned",turn:"turn",text,at:2},
    {type:"AikoProgressStarted",key,turn:"turn",epoch:0,owner:"123",at:3});
  expect(f.sent).toHaveLength(0);
  expect(events.find(e=>e.type==="AikoProgressSettled")?.result).toEqual({status:"unknown"});
  await f.restart();
  expect(f.sent).toHaveLength(0);
});

test("activation never sends old working text or text belonging to another destination", async () => {
  const f = await fixture();
  await f.append(message,{type:"TextReturned",turn:"turn",text:"Historical progress",at:2});
  await f.append({...message,id:"foreign",chat:"456"}, {type:"TextReturned",turn:"foreign",text:"Other account",at:3});
  expect(f.sent).toHaveLength(0);
});

test("a terminal already in the committed tail suppresses obsolete pending commentary", async () => {
  const f = await fixture();
  await f.append(message);
  await f.append({type:"TextReturned",turn:"turn",text:"Still working",at:2},
    {type:"TurnCompleted",turn:"turn",output:"Done",at:3});
  expect(f.sent).toHaveLength(0);
});
