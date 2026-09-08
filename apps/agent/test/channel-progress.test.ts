import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { threadCreated } from "tardie/core/thread";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import type { Event } from "tardie/core/event";
import { Effect, Layer } from "effect";
import { channelProgress } from "../src/channel-progress.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const message = { type: "MessageReceived", id: "turn", source: "telegram", chat: "123", sender: "123", telegram: { messageId: 8, messageThreadId: 9 }, at: 1 };
async function fixture() {
  const directory = await mkdtemp("/tmp/aiko-progress-");
  cleanup.push(() => rm(directory, {recursive: true, force: true}));
  const sent: {text: string; context: unknown}[] = [];
  const definition = actor({ name: "aiko", methods: {}, components: [channelProgress({
    owner: "123", redact: text => text.replaceAll("fixture-secret", "[redacted]"),
    voice: input => Effect.succeed({ text: input.kind === "answer" ? input.text : "", source: "model" as const }),
    send: async (_owner, text, _signal, context) => { sent.push({text, context}); return {status: "delivered"}; },
  })] });
  const open = () => createBunHost({ database: join(directory, "actor.sqlite"), actorName: "aiko", actorInstance: "progress-test", actorFor: () => definition, layersFor: () => Layer.empty });
  let host = await open();
  await host.seed("user-123", [threadCreated(parseThreadAddress(host.self("user-123")), undefined, 0)]);
  cleanup.push(() => host.close());
  return {
    sent,
    append: async (...events: Event[]) => { await host.seed("user-123", events); await host.wake("user-123"); return host.read("user-123"); },
    restart: async () => { await host.close(); host = await open(); await host.wake("user-123"); },
  };
}

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
