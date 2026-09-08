import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer, renderMessages, type InferRequest } from "tardie";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { threadCreated } from "tardie/core/thread";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import {
  accountDirectory,
  accountThreadDatabase,
  backgroundThread,
  threadBinding,
} from "../src/accounts.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { openMemory } from "../src/memory.ts";
import type { AikoEvent } from "../src/actor.ts";
import { controlApi } from "../src/control-api.ts";
import { harnessDigest } from "../src/harness-library.ts";
import { defaultProactivePreferences, type ProactivePreferences } from "../src/proactive-policy.ts";

// Positive live-delivery fixtures only: run the real composer against a deterministic local response.
const positiveVoiceFetch = async (_url: unknown, init?: RequestInit) => Response.json({
  personified: JSON.parse(String(init?.body)).raw,
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const alice = "aiko_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bob = "aiko_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const reader = "aiko_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr";

async function fixture(
  patch: Partial<AikoConfig> = {},
  overrides: Parameters<typeof createService>[1] = {},
) {
  const stateDir = await mkdtemp("/tmp/aiko-background-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const config: AikoConfig = {
    stateDir,
    mode: "demo",
    instanceId: "background-fixture",
    port: 4242,
    operatorToken: "operator-background-fixture-123456789012345",
    modelKey: "model-background-fixture-123456789012345",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
    telegramPublic: true,
    botToken: "123:background-fixture-only",
    webhookSecret: "background_fixture_webhook_123456789012345",
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(alice),
        scopes: ["read", "write"],
      },
      {
        account: "456",
        digest: credentialDigest(bob),
        scopes: ["read", "write"],
      },
      { account: "123", digest: credentialDigest(reader), scopes: ["read"] },
    ],
    ...patch,
  };
  const deliveries: Record<string, unknown>[] = [];
  const options: Parameters<typeof createService>[1] = {
    ...(overrides.model ? { backgroundModel: overrides.model } : {}),
    telegramFetch: async (_url, init) => {
      deliveries.push(JSON.parse(String(init?.body)));
      return Response.json({
        ok: true,
        result: { message_id: deliveries.length },
      });
    },
    ...overrides,
  };
  let service = await createService(config, options);
  await service.ready;
  cleanup.push(() => service.close());
  const request = (path: string, body?: object, token = alice) =>
    service.fetch(
      new Request(`http://127.0.0.1:4242${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    config,
    deliveries,
    request,
    get service() {
      return service;
    },
    events: async (thread: string) =>
      (await service.host.read(thread)) as readonly AikoEvent[],
    telegram: (id: number, user = 123, text = "Hello") =>
      service.acceptTelegram(
        new Request("http://127.0.0.1:4242/telegram/webhook", {
          method: "POST",
          headers: { "x-telegram-bot-api-secret-token": config.webhookSecret! },
          body: JSON.stringify({
            update_id: id,
            message: {
              message_id: id,
              date: 1,
              from: { id: user, is_bot: false },
              chat: { id: user, type: "private" },
              text,
            },
          }),
        }),
      ),
    restart: async (beforeOpen?: () => void | Promise<void>) => {
      await service.close();
      await beforeOpen?.();
      service = await createService(config, options);
      await service.ready;
      await service.host.drive();
    },
  };
}

const learning = (id: string, revision = 1) => ({
  id,
  subject: "project:aurorapanda",
  title: "Aurorapanda release schedule",
  kind: "fact" as const,
  type: "release_schedule",
  payload: {
    release: "Aurorapanda",
    revision,
    day: revision === 1 ? "Tuesday" : "Thursday",
  },
});

const ofType = (events: readonly AikoEvent[], type: string) =>
  events.filter((event) => event.type === type);

async function setProactive(f: Awaited<ReturnType<typeof fixture>>, patch: Partial<ProactivePreferences>, operationId: string) {
  const current = await (await f.request("/api/control/proactive")).json();
  const response = await f.request("/api/control/proactive", { account: "123", expectedRevision: current.revision, operationId, preferences: { ...current.preferences, ...patch } });
  expect(response.status).toBe(202);
  return response.json();
}

test("proactive preferences use authenticated owner CAS, retain idempotency and survive restart", async () => {
  const f = await fixture();
  await f.request("/v1/hooks", learning("proactive-preferences-seed"));
  await f.service.host.drive();
  const read = await (await f.request("/api/control/proactive", undefined, reader)).json();
  expect(read).toMatchObject({ account: "123", revision: "default", writable: false });
  const body = { account: "123", expectedRevision: "default", operationId: "prefs-a", preferences: { ...defaultProactivePreferences, dailyLimit: 2 } };
  expect((await f.request("/api/control/proactive", body, reader)).status).toBe(403);
  expect((await f.request("/api/control/proactive", { ...body, account: "456" })).status).toBe(403);
  const results = await Promise.all([f.request("/api/control/proactive", body), f.request("/api/control/proactive", { ...body, operationId: "prefs-b" })]);
  expect(results.map(r => r.status).sort()).toEqual([202, 409]);
  const winner = results[0]!.status === 202 ? body : { ...body, operationId: "prefs-b" };
  const latest = await (await f.request("/api/control/proactive")).json();
  expect(latest.preferences.dailyLimit).toBe(2);
  expect((await f.request("/api/control/proactive", winner)).status).toBe(200);
  expect((await f.request("/api/control/proactive", { ...winner, preferences: { ...winner.preferences, dailyLimit: 3 } })).status).toBe(409);
  expect(ofType(await f.events("user-123"), "AikoProactivePreferencesSet")).toHaveLength(1);
  await f.restart();
  expect(await (await f.request("/api/control/proactive")).json()).toEqual(latest);
});

test("native batch deadline retains the first window and delivers only the latest topic after restart", async () => {
  const model = reflectionModel(changed => ({ decision: "notify", reason: "A release changed", text: "Your Aurorapanda release schedule has changed.", supports: changed.map(c => c.observation).slice(0, 1) }));
  const f = await fixture({ mode: "live", voiceKey: "thinkfeel-background-fixture" }, { model: model.layer, voiceFetch: positiveVoiceFetch });
  await f.telegram(301); await f.service.host.drive();
  await setProactive(f, { batchWindowMs: 1200 }, "batch-enable");
  const before = f.deliveries.length;
  await f.request("/v1/hooks", learning("batch-first", 1)); await f.service.host.drive();
  const first = ofType(await f.events("user-123"), "AikoProactiveDeferred").at(-1)!;
  expect(first).toBeDefined();
  await f.request("/v1/hooks", learning("batch-second", 2)); await f.service.host.drive();
  const pending = ofType(await f.events("user-123"), "AikoProactiveDeferred");
  expect(pending.length).toBeGreaterThanOrEqual(2);
  expect((pending.at(-1)!.call as any).deadlineAt).toBe((first.call as any).deadlineAt);
  expect(f.deliveries).toHaveLength(before);
  const calls = model.calls;
  await f.restart();
  await Bun.sleep(Math.max(1, Number((first.call as any).deadlineAt) - Date.now() + 30));
  await f.service.host.drive();
  const log = await f.events("user-123");
  expect(f.deliveries).toHaveLength(before + 1);
  expect(ofType(log, "AikoProactiveAccepted")).toHaveLength(1);
  expect(ofType(log, "AikoProactiveDispatchAuthorized")).toHaveLength(1);
  expect(ofType(log, "AikoProactiveSuppressed")).toHaveLength(1);
  await f.restart();
  expect(f.deliveries).toHaveLength(before + 1);
  expect(model.calls).toBe(calls);
});

test("a preference change wakes a deferred native decision and prevents an obsolete alarm from delivering", async () => {
  const model = reflectionModel(changed => ({ decision: "notify", reason: "A release changed", text: "Your Aurorapanda release schedule has changed.", supports: changed.map(c => c.observation).slice(0, 1) }));
  const f = await fixture({ mode: "live", voiceKey: "thinkfeel-background-fixture" }, { model: model.layer, voiceFetch: positiveVoiceFetch });
  await f.telegram(302); await f.service.host.drive();
  await setProactive(f, { batchWindowMs: 60_000 }, "long-window");
  const before = f.deliveries.length;
  await f.request("/v1/hooks", learning("deferred-disable", 2)); await f.service.host.drive();
  expect(ofType(await f.events("user-123"), "AikoProactiveDeferred")).toHaveLength(1);
  await setProactive(f, { enabled: false }, "disable-proactive"); await f.service.host.drive();
  expect(ofType(await f.events("user-123"), "AikoProactiveSuppressed").at(-1)?.reason).toBe("notifications-disabled");
  await f.restart();
  expect(f.deliveries).toHaveLength(before);
  expect(ofType(await f.events("user-123"), "AikoProactiveAccepted")).toHaveLength(0);
});

test("batch replacement preserves an older multi-topic update when the newer decision covers only one topic", async () => {
  const model = reflectionModel(() => ({ decision: "silent", reason: "Fixture seed", text: "", supports: [] }));
  const f = await fixture({}, { model: model.layer });
  await f.request("/v1/hooks", learning("multi-topic-seed")); await f.service.host.drive();
  await setProactive(f, { batchWindowMs: 250 }, "multi-topic-window");
  const memory = openMemory({ stateDir: accountDirectory(f.config.stateDir, "123"), owner: "123" });
  let supports: string[];
  try {
    supports = ["a", "b"].map(name => memory.remember({ subject: `batch:${name}`, title: `Update ${name}`, type: "fact", payload: { changed: true } },
      { key: `multi-topic-${name}`, producer: { kind: "agent", reference: "batch-fixture" } }).id);
  } finally { memory.close(); }
  const at = Date.now(), sourceThread = backgroundThread("123", "reflection");
  // Trusted fixture boundary: distinct reflected decisions cite current real observations.
  for (const row of [
    { id: "batch-two-topics", text: "Both A and B changed.", supports },
    { id: "batch-only-a", text: "A changed.", supports: supports.slice(0, 1) },
  ]) await f.service.host.commitRoot(f.service.host.self("user-123"), { type: "AikoProactiveDecision", owner: "123", sourceThread, root: "fixture-root", at, ...row });
  await f.service.host.drive();
  const deferred = ofType(await f.events("user-123"), "AikoProactiveDeferred").at(-1)!;
  expect(deferred).toBeDefined();
  await Bun.sleep(Math.max(1, Number((deferred.call as any).deadlineAt) - Date.now() + 20));
  await f.service.host.drive();
  const events = await f.events("user-123");
  expect(ofType(events, "AikoProactiveAccepted").map(e => e.id).sort()).toEqual(["batch-only-a", "batch-two-topics"]);
  expect(ofType(events, "AikoProactiveSuppressed").filter(e => e.reason === "batch-superseded")).toHaveLength(0);
});

test("forgetting cited evidence while voice is pending prevents both a visible prepared update and a send", async () => {
  const model = reflectionModel(changed => ({ decision: "notify", reason: "A release changed", text: "Your Aurorapanda release schedule has changed.", supports: changed.map(c => c.observation).slice(0, 1) }));
  let active: Awaited<ReturnType<typeof fixture>> | undefined, invalidated = false;
  const f = await fixture({ mode: "live", voiceKey: "thinkfeel-background-fixture" }, { model: model.layer,
    voiceFetch: async (url, init) => {
      if (active && JSON.parse(String(init?.body)).raw.includes("Your Aurorapanda release schedule has changed")) {
        const memory = openMemory({ stateDir: accountDirectory(active.config.stateDir, "123"), owner: "123" });
        try {
          const accepted = ofType(await active.events("user-123"), "AikoProactiveAccepted").at(-1)!;
          const hit = memory.get(String((accepted.supports as string[])[0]))!;
          memory.forget(hit.observation.subject, hit.observation.id, "forget-during-voice");
          invalidated = true;
        } finally { memory.close(); }
      }
      return positiveVoiceFetch(url, init);
    } });
  active = f;
  await f.telegram(303); await f.service.host.drive();
  const before = f.deliveries.length;
  await f.request("/v1/hooks", learning("voice-citation-revoked", 2)); await f.service.host.drive();
  const log = await f.events("user-123");
  expect(invalidated).toBe(true);
  expect(f.deliveries).toHaveLength(before);
  expect(ofType(log, "AikoReplySuppressed")).toHaveLength(1);
  expect(ofType(log, "AikoReplyPrepared").filter(e => String(e.turn).startsWith("proactive:"))).toHaveLength(0);
  expect(ofType(log, "AikoDeliverySettled").filter(e => String(e.turn).startsWith("proactive:"))).toMatchObject([{ result: { status: "rejected" } }]);
  await f.restart();
  expect(f.deliveries).toHaveLength(before);
});

test("generation-less fabricated promotion cannot enter Merkle learning or leak private execution data", async () => {
  const model = reflectionModel(() => ({ decision: "silent", reason: "Routine capability availability", text: "", supports: [] }));
  const f = await fixture({}, { model: model.layer });
  await f.request("/v1/hooks", learning("seed_harness_001"));
  await f.service.host.drive();
  const indexer = backgroundThread("123", "indexer");
  const before = ofType(await f.events(indexer), "AikoKnowledgeChanged").length;
  const event = { type: "AikoHarnessPromoted", id: harnessDigest("promotion-fixture"), owner: "123", name: "audio.transcribe", harnessDigest: harnessDigest("media-code"), contractDigest: harnessDigest("media-contract"), contextDigest: harnessDigest("owner-context"), generation: 1, at: Date.now(), input: "private attachment never indexed" };
  await f.service.host.commitRoot(f.service.host.self("user-123"), event);
  await f.service.host.drive();
  const events = await f.events(indexer);
  expect(ofType(events, "AikoKnowledgeChanged").length).toBe(before);
  const hook = ofType(events, "AikoHookReceived").find(e => String(e.id).includes(event.id));
  expect(hook).toBeUndefined();
  expect(ofType(await f.events("user-123"), "AikoHarnessPromoted")).toHaveLength(0);
  expect(JSON.stringify(events)).not.toContain(event.input);
  await f.restart();
  await f.service.host.commitRoot(f.service.host.self("user-123"), event);
  await f.service.host.commitRoot(f.service.host.self("user-123"), { ...event, id: harnessDigest("foreign"), owner: "456" });
  await f.service.host.drive();
  expect(ofType(await f.events(indexer), "AikoKnowledgeChanged").length).toBe(before);
  expect(f.deliveries).toHaveLength(0);
});

test("verified connections trigger one native context index and reflection, never on pending or foreign grants", async()=>{
 let reads=0;
 const f=await fixture({},{connectorBrowser:owner=>({native:true,
   begin:async()=>({authorizationUrl:"https://signin.aiko.com/connect"}),
   status:async binding=>({...binding,status:"connected",verification:{verified:true,revision:1,expiresAt:Date.now()+600000}}),
   readContext:async binding=>{expect(binding.owner).toBe(owner);reads++;return {url:`https://${binding.domain}/home`,text:"Aurorapanda has a Thursday release review."}},
 })});
 const pending=await (await f.request("/api/connectors/browser",{domain:"service.net"})).json() as {id:string};
 await f.service.host.drive();expect(reads).toBe(0);
 expect((await f.request("/api/connectors/complete",{connectionId:pending.id},bob)).status).toBe(409);
 expect((await f.request("/api/connectors/complete",{connectionId:pending.id})).status).toBe(200);
 await f.service.host.drive();
 const indexer=backgroundThread("123","indexer");
 expect(reads).toBe(1);
 expect(ofType(await f.events(indexer),"AikoConnectionIndexRequested")).toHaveLength(1);
 expect(ofType(await f.events(indexer),"AikoLearningIndexed")).toHaveLength(1);
 expect(ofType(await f.events(indexer),"AikoKnowledgeChanged")).toHaveLength(1);
 const memory=openMemory({stateDir:accountDirectory(f.config.stateDir,"123"),owner:"123"});
 try {expect(memory.recall({subject:"learning/connected-app-context/service.net"}).items.some(item=>item.observation.type==="connected-app-context")).toBe(true);} finally {memory.close();}
 await f.restart();
 await f.request("/api/connectors/complete",{connectionId:pending.id});await f.service.host.drive();
 expect(reads).toBe(1);
 expect(ofType(await f.events("user-123"),"AikoConnectionChanged").map(e=>e.status)).toEqual(["pending","connected"]);
});

test("connected-route frontier survives restart and deduplicates cycles before indexing each page", async () => {
 const indexer = backgroundThread("123", "indexer");
 const reads: string[] = [];
 const pages: Record<string, string[]> = {
  "https://service.net/home": ["/projects", "/projects", "https://other.net/private", "/logout", "/projects?token=private"],
  "https://service.net/projects": ["/home", "/issues"],
  "https://service.net/issues": ["/projects"],
 };
 const f = await fixture({}, {connectorBrowser: owner => ({native:true,
  begin: async () => ({authorizationUrl:"https://signin.aiko.com/connect"}),
  status: async binding => ({...binding,status:"connected",verification:{verified:true,revision:1,expiresAt:Date.now()+600000}}),
  readContext: async (binding, _signal, url = "https://service.net/home", linkOffset = 0) => {
   expect(binding.owner).toBe(owner);
   reads.push(url);
   if (reads.length === 1) await f.service.host.commitRoot(f.service.host.self(indexer), {type:"AikoHooksConfigured",id:"pause-route-fixture",paused:true,at:Date.now()});
   return {url,text:`Observed page ${new URL(url).pathname}`,links:pages[url]!,...(url.endsWith("/home") && linkOffset === 0 ? {linksTruncated:true,nextLinkOffset:256} : {})};
  },
 })});
 const connection = await (await f.request("/api/connectors/browser", {domain:"service.net"})).json() as {id:string};
 await f.request("/api/connectors/complete", {connectionId:connection.id});
 await f.service.host.drive();
 expect(reads).toEqual(["https://service.net/home"]);
 expect(ofType(await f.events(indexer), "AikoConnectionIndexRequested")).toHaveLength(3);
 await f.restart();
 expect(reads).toHaveLength(1);
 await f.service.host.commitRoot(f.service.host.self(indexer), {type:"AikoHooksConfigured",id:"resume-route-fixture",paused:false,at:Date.now()});
 await f.service.host.drive();
 expect(reads).toEqual(["https://service.net/home","https://service.net/projects","https://service.net/home","https://service.net/issues"]);
 const events = await f.events(indexer);
 expect(ofType(events,"AikoLearningIndexed")).toHaveLength(4);
 expect(ofType(events,"AikoConnectionIndexRequested")).toHaveLength(4);
 expect(ofType(events,"AikoBackgroundFailed")).toHaveLength(0);
 const memory = openMemory({stateDir:accountDirectory(f.config.stateDir,"123"),owner:"123"});
 try { for (const e of ofType(events,"AikoLearningIndexed")) expect(memory.get(String(e.observation))?.observation.type).toBe("connected-app-context"); } finally {memory.close();}
 await f.restart();
 expect(reads).toHaveLength(4);
});

test("control thread status follows the current turn and job, not historical failures or unknown deliveries", async () => {
  const foreground: AikoEvent[] = [
    { type: "MessageReceived", id: "old", at: 1 },
    { type: "TurnFailed", turn: "old", at: 2 },
    {
      type: "AikoDeliverySettled",
      turn: "old",
      result: { status: "unknown" },
      at: 3,
    },
    { type: "AikoHookReceived", id: "hook-old", at: 4 },
    { type: "AikoHookDispatched", id: "hook-old", at: 5 },
    { type: "MessageReceived", id: "current", at: 6 },
  ];
  const indexer: AikoEvent[] = [
    { type: "AikoIndexRequested", id: "old-index", at: 1 },
    { type: "AikoBackgroundFailed", id: "old-index", stage: "snapshot", at: 2 },
    { type: "AikoIndexRequested", id: "new-index", at: 3 },
  ];
  const reflection: AikoEvent[] = [
    { type: "AikoReflectionRequested", id: "old-reflection", at: 1 },
    {
      type: "MessageReceived",
      id: "reflect:old-reflection",
      source: "background",
      at: 2,
    },
    { type: "TurnFailed", turn: "reflect:old-reflection", at: 3 },
    {
      type: "AikoDecisionRecorded",
      id: "old-reflection",
      decision: "silent",
      at: 4,
    },
    { type: "AikoReflectionRequested", id: "new-reflection", at: 5 },
  ];
  const logs: Record<string, AikoEvent[]> = {
    "user-123": foreground,
    "background-123-indexer": indexer,
    "background-123-reflection": reflection,
  };
  const request = new Request(
    "http://fixture.invalid/api/control/threads?account=123",
  );
  const inspect = async () => {
    const response = await controlApi({
      host: {
        threads: async () => Object.keys(logs),
        read: async (thread: string) => logs[thread]!,
      },
      config: {},
      principal: { owner: "123", operator: false, scopes: ["read"] },
      request,
      url: new URL(request.url),
      redact: (text: string) => text,
      validOwner: (owner: string) => owner === "123",
    } as unknown as Parameters<typeof controlApi>[0]);
    expect(response.status).toBe(200);
    return Object.fromEntries(
      (await response.json()).threads.map((entry: any) => [entry.role, entry]),
    );
  };
  let state = await inspect();
  expect(state.foreground.status).toBe("running");
  expect(state.foreground.summary).toBe("Processing durable events");
  expect(state.indexer.status).toBe("running");
  expect(state.reflection.status).toBe("running");
  foreground.push({ type: "TurnCompleted", turn: "current", at: 7 });
  indexer.push({ type: "AikoKnowledgeUnchanged", id: "new-index", at: 4 });
  reflection.push({
    type: "AikoDecisionRecorded",
    id: "new-reflection",
    decision: "silent",
    at: 6,
  });
  state = await inspect();
  expect(state.foreground.status).toBe("idle");
  expect(state.indexer.status).toBe("idle");
  expect(state.reflection.status).toBe("idle");
  foreground.push(
    { type: "MessageReceived", id: "latest-failure", at: 8 },
    { type: "TurnFailed", turn: "latest-failure", at: 9 },
  );
  indexer.push(
    { type: "AikoIndexRequested", id: "latest-index", at: 5 },
    {
      type: "AikoBackgroundFailed",
      id: "latest-index",
      stage: "indexing",
      at: 6,
    },
  );
  state = await inspect();
  expect(state.foreground.status).toBe("failed");
  expect(state.foreground.summary).toStartWith(
    "Latest conversation turn failed",
  );
  expect(state.indexer.status).toBe("failed");
  foreground.push(
    { type: "MessageReceived", id: "latest-voice", at: 10 },
    { type: "TurnCompleted", turn: "latest-voice", at: 11 },
    {
      type: "AikoTelegramActionSettled",
      turn: "latest-voice",
      result: { status: "unknown", final: true },
      at: 12,
    },
  );
  expect((await inspect()).foreground.status).toBe("blocked");
  foreground.push({ type: "MessageReceived", id: "later-turn", at: 13 });
  expect((await inspect()).foreground.status).toBe("running");
  foreground.push({ type: "AikoHooksConfigured", paused: true, at: 14 });
  state = await inspect();
  expect(state.indexer.status).toBe("blocked");
  expect(state.reflection.status).toBe("blocked");
});

function reflectionModel(
  decide: (
    changed: { observation: string; subject: string }[],
    request: InferRequest,
  ) => object,
) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    layer: Layer.succeed(Infer, {
      resolve: () => ({
        model: { provider: "fixture", model_id: "background" },
      }),
      react: (request) => {
        const message = request.trajectory.findLast(
          (raw) =>
            raw.type === "MessageReceived" &&
            (raw as AikoEvent).id === request.identity.turn,
        ) as AikoEvent | undefined;
        if (message?.source !== "background")
          return Effect.succeed({
            kind: "complete" as const,
            output: "Hello.",
          });
        calls++;
        const input = JSON.parse(String(message.text));
        return Effect.succeed({
          kind: "complete" as const,
          output: JSON.stringify(decide(input.changed, request)),
          mode: { kind: "local", name: "validate-once" },
        });
      },
    }),
  };
}

test("v2 contribution carries retained trigger evidence through native reflection and sends once", async () => {
  const model = reflectionModel(changed => ({ version: 2, reason: "A useful release change", contributions: [{
    decision: "notify", text: "Your Aurorapanda release moved to Thursday.", reason: "The owner's release date changed",
    supports: changed.map(c => c.observation).slice(0, 1), delayMs: 0,
    relevance: 4, usefulness: 4, urgency: 2, novelty: 3, interruptionCost: 1,
  }] }));
  const f = await fixture({ mode: "live", cognitiveContributionOwners: ["123"], voiceKey: "thinkfeel-background-fixture" },
    { model: model.layer, voiceFetch: positiveVoiceFetch });
  await f.telegram(22001); await f.service.host.drive();
  const before = f.deliveries.length;
  await f.request("/v1/hooks", learning("v2-release", 2)); await f.service.host.drive();
  const rows = await f.events("user-123"), decision = ofType(rows, "AikoProactiveDecision").at(-1)!;
  expect(decision?.contribution).toMatchObject({ version: 2, action: "notify" });
  expect((decision.contribution as { triggerSupports: string[] }).triggerSupports.every(id => (decision.supports as string[]).includes(id))).toBe(true);
  expect(ofType(rows, "AikoProactiveAccepted").at(-1)?.contribution).toEqual(decision.contribution);
  expect(f.deliveries).toHaveLength(before + 1);
  expect(f.deliveries.at(-1)?.text).toContain("moved to Thursday");
  const calls = model.calls;
  await f.restart(); await f.request("/v1/hooks", learning("v2-release", 2)); await f.service.host.drive();
  expect(model.calls).toBe(calls); expect(f.deliveries).toHaveLength(before + 1);
});

for (const invalid of ["foreign-citation", "out-of-context-citation", "score", "too-many", "shape", "weak"] as const)
test(`v2 rejects ${invalid} without a second model decision or external notification`, async () => {
  const model = reflectionModel(changed => {
    const candidate = { decision: "notify", text: "A release changed.", reason: "A release update",
      supports: changed.map(c => c.observation).slice(0, 1), delayMs: 0,
      relevance: 4, usefulness: 4, urgency: 2, novelty: 3, interruptionCost: 1 };
    if (invalid === "foreign-citation") candidate.supports = ["owner-456-private-fact"];
    if (invalid === "out-of-context-citation") candidate.supports.push("not-supplied-to-this-call");
    if (invalid === "score") candidate.urgency = 500;
    if (invalid === "weak") { candidate.relevance = 0; candidate.usefulness = 0; }
    if (invalid === "shape") return { version: 2, reason: "Malformed", contributions: "notify" };
    return { version: 2, reason: "Consider a release update", contributions: invalid === "too-many" ? Array(4).fill(candidate) : [candidate] };
  });
  const f = await fixture({ cognitiveContributionOwners: ["123"] }, { model: model.layer });
  await f.request("/v1/hooks", learning(`invalid-${invalid}`, 1)); await f.service.host.drive();
  expect(model.calls).toBe(1);
  expect(ofType(await f.events("user-123"), "AikoProactiveAccepted")).toHaveLength(0);
  expect(f.deliveries).toHaveLength(0);
  expect(ofType(await f.events(backgroundThread("123", "reflection")), "AikoDecisionRecorded").at(-1)?.decision).toBe("silent");
  await f.restart(); await f.service.host.drive(); expect(model.calls).toBe(1);
});

test("v2 shadow records decisions without sending; promotion evaluates only new evidence", async () => {
  const model = reflectionModel(changed => ({ version: 2, reason: "Relevant release update", contributions: [{
    decision: "notify", text: "Your Aurorapanda release changed.", reason: "New release evidence",
    supports: changed.map(c => c.observation).slice(0, 1), delayMs: 0,
    relevance: 4, usefulness: 4, urgency: 2, novelty: 3, interruptionCost: 1,
  }] }));
  const f = await fixture({ cognitiveContributionShadowOwners: ["123"] }, { model: model.layer });
  await f.telegram(22011); await f.service.host.drive();
  const before = f.deliveries.length;
  await f.request("/v1/hooks", learning("shadow-release", 1)); await f.service.host.drive();
  expect(ofType(await f.events("user-123"), "AikoProactiveSuppressed").at(-1)?.reason).toBe("contribution-shadow");
  expect(f.deliveries).toHaveLength(before);
  const calls = model.calls;
  f.config.cognitiveContributionOwners = ["123"];
  f.config.cognitiveContributionShadowOwners = [];
  await f.restart(); await f.service.host.drive();
  expect(model.calls).toBe(calls); expect(f.deliveries).toHaveLength(before);
  await f.request("/v1/hooks", learning("shadow-release-updated", 2)); await f.service.host.drive();
  expect(ofType(await f.events("user-123"), "AikoProactiveAccepted")).toHaveLength(1);
});

test("v2 rollback retires a pending native wait across restart and reenabling", async () => {
  const model = reflectionModel(changed => ({ version: 2, reason: "Useful later", contributions: [{
    decision: "defer", text: "Your Aurorapanda release changed.", reason: "Wait for a suitable time",
    supports: changed.map(c => c.observation).slice(0, 1), delayMs: 3_600_000,
    relevance: 4, usefulness: 4, urgency: 2, novelty: 3, interruptionCost: 1,
  }] }));
  const f = await fixture({ cognitiveContributionOwners: ["123"] }, { model: model.layer });
  await f.telegram(22012); await f.service.host.drive();
  await f.request("/v1/hooks", learning("rollback-release", 1)); await f.service.host.drive();
  const rows = await f.events("user-123"), wait = ofType(rows, "AikoProactiveDeferred").at(-1)!;
  expect(wait?.contributionVersion).toBe(2);
  const calls = model.calls, sent = f.deliveries.length;
  f.config.cognitiveContributionOwners = [];
  await f.restart(); await f.service.host.drive();
  expect(ofType(await f.events("user-123"), "AikoProactiveSuppressed").at(-1)).toMatchObject({ id: wait.decisionId, reason: "contribution-disabled" });
  f.config.cognitiveContributionOwners = ["123"];
  await f.restart(); await f.service.host.drive();
  expect(model.calls).toBe(calls); expect(f.deliveries).toHaveLength(sent);
  expect(ofType(await f.events("user-123"), "AikoProactiveAccepted")).toHaveLength(0);
});

test("v2 retains a deferred contribution with older supplied evidence and suppresses it when that evidence is forgotten", async () => {
  let relatedId = "";
  const model = reflectionModel((changed, request) => {
    if (changed.some(e => e.observation === relatedId)) return { version: 2, reason: "Initial context only", contributions: [] };
    const message = request.trajectory.findLast(e => e.type === "MessageReceived" && e.id === request.identity.turn)!;
    const context = JSON.parse(String(message.text));
    expect(context.relatedEvidence.some((e: any) => e.observation === relatedId)).toBe(true);
    return { version: 2, reason: "Useful after the owner's current work", contributions: [{
      decision: "defer", text: "The release date changed; your approval is still needed.", reason: "New date affects an existing requirement",
      supports: [changed[0]!.observation, relatedId], delayMs: 3_600_000,
      relevance: 4, usefulness: 4, urgency: 1, novelty: 3, interruptionCost: 2,
    }] };
  });
  const f = await fixture({ cognitiveContributionOwners: ["123"] }, { model: model.layer });
  // Register the owner with ordinary memory operations before a hook arrives.
  await f.telegram(22002); await f.service.host.drive();
  const binding = { stateDir: accountDirectory(f.config.stateDir, "123"), owner: "123", thread: "user-123", redact: (s: string) => s, readPage: async () => [] };
  let memory = openMemory(binding);
  const saved = memory.remember({ subject: "release-approval", title: "Aurorapanda release schedule", type: "requirement", kind: "fact", payload: "Owner approval is required" },
    { key: "old-requirement", producer: { kind: "agent", reference: "fixture:owner-requirement" } });
  relatedId = saved.id; memory.close();
  await f.request("/v1/hooks", learning("v2-context-baseline", 1)); await f.service.host.drive();
  await f.request("/v1/hooks", learning("v2-with-context", 2)); await f.service.host.drive();
  let rows = await f.events("user-123");
  const decision = ofType(rows, "AikoProactiveDecision").at(-1)!;
  expect(decision?.supports).toContain(relatedId);
  expect(ofType(rows, "AikoProactiveDeferred").some(e => e.decisionId === decision.id)).toBe(true);
  expect(ofType(rows, "AikoProactiveAccepted")).toHaveLength(0);
  const calls = model.calls; await f.restart(); expect(model.calls).toBe(calls);
  memory = openMemory(binding); memory.forget(saved.subject, saved.id, "forget-old-requirement"); memory.close();
  // A legitimate preference change wakes the existing native wait immediately.
  await setProactive(f, { cooldownMs: 1 }, "wake-forget"); await f.service.host.drive();
  rows = await f.events("user-123");
  expect(ofType(rows, "AikoProactiveSuppressed").some(e => e.id === decision.id)).toBe(true);
  expect(ofType(rows, "AikoProactiveAccepted")).toHaveLength(0);
  expect(model.calls).toBe(calls);
});

test("a user-saved note changes real memory while routine indexing stays silent before inference and after restart", async () => {
  const model = reflectionModel(changed => ({
    decision: "notify", reason: "Notify even for a saved note", text: "Unrequested note alert",
    supports: changed.map(item => item.observation),
  }));
  const f = await fixture({}, { backgroundModel: model.layer });
  await f.telegram(411); await f.service.host.drive();
  const deliveries = f.deliveries.length;
  await f.telegram(412, 123, "remember: Aurorapanda release review is on Thursday");
  await f.service.host.drive();
  const foreground = await f.events("user-123");
  expect(foreground.some(e => e.type === "ToolCalled" && e.name === "memory_remember")).toBe(true);
  const indexer = await f.events(backgroundThread("123", "indexer"));
  const change = ofType(indexer, "AikoKnowledgeChanged").at(-1)!;
  expect(change).toBeDefined();
  const reflection = await f.events(backgroundThread("123", "reflection"));
  expect(ofType(reflection, "AikoDecisionRecorded").some(e => e.decision === "silent"
    && e.reason === "Routine indexing and user-saved content do not require an interruption"
    && e.policyVersion === "aiko-proactive-relevance/v1")).toBe(true);
  const memory = openMemory({ stateDir: accountDirectory(f.config.stateDir, "123"), owner: "123" });
  try {
    expect(JSON.stringify(memory.recall({ search: "Aurorapanda" }))).toContain("Aurorapanda release review is on Thursday");
  } finally { memory.close(); }
  expect(model.calls).toBe(0);
  expect(ofType(foreground, "AikoProactiveAccepted")).toHaveLength(0);
  expect(f.deliveries).toHaveLength(deliveries + 1); // The requested foreground reply only.
  await f.restart();
  expect(model.calls).toBe(0);
  expect(f.deliveries).toHaveLength(deliveries + 1);
  expect(ofType(await f.events("user-123"), "AikoProactiveAccepted")).toHaveLength(0);
});

test("thread bindings retain one foreground and place each owner's hidden logs in separate private databases", async () => {
  const f = await fixture();
  expect(threadBinding("user-123")).toEqual({
    owner: "123",
    role: "foreground",
  });
  const names = [
    "user-123",
    backgroundThread("123", "indexer"),
    backgroundThread("123", "reflection"),
  ];
  const paths = names.map((thread) =>
    accountThreadDatabase(f.config.stateDir, thread),
  );
  expect(new Set(paths).size).toBe(3);
  expect(
    paths.every((path) =>
      path.startsWith(accountDirectory(f.config.stateDir, "123")),
    ),
  ).toBe(true);
  expect(
    accountThreadDatabase(
      f.config.stateDir,
      backgroundThread("456", "indexer"),
    ),
  ).not.toBe(paths[1]);
  for (const path of paths) expect((await stat(path)).mode & 0o777).toBe(0o600);
  for (const thread of ["background-123-indexer", "background-123-reflection"])
    expect(threadBinding(thread)?.owner).toBe("123");
  for (const thread of [
    "user-../456",
    "background-123-unknown",
    "background-../456-indexer",
    "",
  ])
    expect(threadBinding(thread)).toBeUndefined();
});

test("background threads do not consume account slots or appear in the user's foreground chat", async () => {
  const f = await fixture({ maxAccounts: 2 });
  expect(await f.telegram(101, 123)).toBe("accepted");
  await f.service.host.drive();
  expect(
    (await f.request("/v1/hooks", learning("learning_slots_001"))).status,
  ).toBe(202);
  await f.service.host.drive();
  const threads = await f.service.host.threads();
  expect(
    threads.filter((thread) => threadBinding(thread)?.owner === "123").sort(),
  ).toEqual(
    [
      backgroundThread("123", "indexer"),
      backgroundThread("123", "reflection"),
      "user-123",
    ].sort(),
  );
  expect(await f.telegram(102, 456)).toBe("accepted");
  await f.service.host.drive();
  expect(await f.telegram(103, 789)).toBe("limited");
  const chat = await (await f.request("/v1/messages")).json();
  expect(JSON.stringify(chat.messages)).not.toContain(
    "Aurorapanda release schedule",
  );
  expect(JSON.stringify(chat.messages)).not.toContain("reflect:");
  expect(f.deliveries).toHaveLength(2);
});

test("control panel and native entity memory isolate owners while the operator can see both", async () => {
  const f = await fixture();
  await f.request("/v1/hooks", learning("learning_alice_001"));
  await f.request(
    "/v1/hooks",
    {
      ...learning("learning_bob_001"),
      subject: "project:bob-only",
      title: "Bob private evidence",
    },
    bob,
  );
  await f.service.host.drive();
  const own = await (await f.request("/api/control/accounts")).json();
  expect(own.operator).toBe(false);
  expect(own.accounts.map((item: { account: string }) => item.account)).toEqual(
    ["123"],
  );
  const all = await (
    await f.request("/api/control/accounts", undefined, f.config.operatorToken)
  ).json();
  expect(all.operator).toBe(true);
  expect(all.accounts.map((item: { account: string }) => item.account)).toEqual(
    expect.arrayContaining(["123", "456"]),
  );
  for (const path of [
    "/api/control/threads?account=456",
    `/api/control/events?thread=${backgroundThread("456", "indexer")}&after=0&limit=100`,
  ])
    expect([403, 404]).toContain((await f.request(path)).status);
  const ownThreads = await (
    await f.request("/api/control/threads?account=123")
  ).json();
  expect(
    ownThreads.threads.some(
      (item: { role: string; visibility: string }) =>
        item.role === "indexer" && item.visibility === "background",
    ),
  ).toBe(true);
  const indexed = ofType(
    await f.events(backgroundThread("123", "indexer")),
    "AikoLearningIndexed",
  );
  expect(indexed).toHaveLength(1);
  const observation = String(indexed[0].observation);
  expect(
    (await f.request(`/v1/memory/observations/${observation}`)).status,
  ).toBe(200);
  expect(
    (await f.request(`/v1/memory/observations/${observation}`, undefined, bob))
      .status,
  ).toBe(404);
  expect(
    (await f.request("/v1/hooks", learning("readonly_hook_001"), reader))
      .status,
  ).toBe(403);
  expect([403, 404]).toContain(
    (await f.request("/api/control/hooks", { account: "456", paused: true }))
      .status,
  );
  expect(
    (
      await f.request(
        "/api/control/hooks",
        { account: "123", paused: true },
        reader,
      )
    ).status,
  ).toBe(403);
  const first = await (
    await f.request(
      `/api/control/events?thread=${backgroundThread("123", "indexer")}&after=0&limit=2`,
    )
  ).json();
  expect(first.events).toHaveLength(2);
  expect(first.hasMore).toBe(true);
  expect(first.nextAfter).toBe(first.events.at(-1).seq);
  const next = await (
    await f.request(
      `/api/control/events?thread=${backgroundThread("123", "indexer")}&after=${first.nextAfter}&limit=2`,
    )
  ).json();
  expect(
    next.events.every((row: { seq: number }) => row.seq > first.nextAfter),
  ).toBe(true);
});

test("hook identity deduplicates observations and reflection across restart; unchanged content preserves the Merkle root", async () => {
  const model = reflectionModel(() => ({
    decision: "silent",
    reason: "Recorded for context",
    text: "",
    supports: [],
  }));
  const f = await fixture({ mode: "live" }, { model: model.layer });
  const hook = learning("learning_dedup_001");
  expect((await f.request("/v1/hooks", hook)).status).toBe(202);
  await f.service.host.drive();
  const indexer = backgroundThread("123", "indexer");
  const initial = await f.events(indexer);
  const root = ofType(initial, "AikoKnowledgeChanged").at(-1)?.root;
  expect(typeof root).toBe("string");
  expect(model.calls).toBe(1);
  const observation = String(
    ofType(initial, "AikoLearningIndexed")[0].observation,
  );
  await f.restart();
  const duplicate = await f.request("/v1/hooks", hook);
  expect([200, 202]).toContain(duplicate.status);
  await f.service.host.drive();
  expect(ofType(await f.events(indexer), "AikoHookReceived")).toHaveLength(1);
  expect(ofType(await f.events(indexer), "AikoLearningIndexed")).toHaveLength(
    1,
  );
  expect(model.calls).toBe(1);
  const memory = openMemory({
    stateDir: accountDirectory(f.config.stateDir, "123"),
    owner: "123",
  });
  try {
    const subject = String(ofType(initial, "AikoLearningIndexed")[0].subject);
    expect(
      memory.recall({ subject }).items.map((item) => item.observation.id),
    ).toEqual([observation]);
  } finally {
    memory.close();
  }
  expect(
    (
      await f.request("/v1/hooks", {
        ...hook,
        id: "learning_dedup_002",
        payload: {
          day: hook.payload.day,
          revision: hook.payload.revision,
          release: hook.payload.release,
        },
      })
    ).status,
  ).toBe(202);
  await f.service.host.drive();
  const unchanged = await f.events(indexer);
  expect(ofType(unchanged, "AikoKnowledgeChanged")).toHaveLength(1);
  expect(ofType(unchanged, "AikoKnowledgeUnchanged").at(-1)?.root).toBe(root);
  expect(model.calls).toBe(1);
  expect(f.deliveries).toHaveLength(0);
  expect(
    (
      await f.request("/v1/hooks", {
        ...hook,
        payload: { unexpected: "same identity, different content" },
      })
    ).status,
  ).toBe(409);
});

test("a cited decision travels through the foreground outbox and Telegram exactly once after a content change", async () => {
  const model = reflectionModel((changed) => ({
    decision: "notify",
    reason: "The user's recorded release schedule changed",
    text: "Your Aurorapanda release schedule has changed.",
    supports: changed.map((item) => item.observation).slice(0, 1),
  }));
  const f = await fixture({ mode: "live", voiceKey: "thinkfeel-background-fixture" }, { model: model.layer, voiceFetch: positiveVoiceFetch });
  expect(await f.telegram(201)).toBe("accepted");
  await f.service.host.drive();
  const priorSends = f.deliveries.length;
  const priorCalls = model.calls;
  const hook = learning("learning_notification_001", 2);
  expect((await f.request("/v1/hooks", hook)).status).toBe(202);
  await f.service.host.drive();
  expect(model.calls).toBe(priorCalls + 1);
  expect(f.deliveries).toHaveLength(priorSends + 1);
  expect(f.deliveries.at(-1)?.chat_id).toBe("123");
  expect(f.deliveries.at(-1)?.text).toContain(
    "Aurorapanda release schedule has changed",
  );
  const log = await f.events("user-123");
  const published = ofType(log, "AikoProactiveDecision").at(-1)!;
  expect(published.sourceThread).toBe(backgroundThread("123", "reflection"));
  expect(
    ofType(log, "AikoReplyPrepared").filter(
      (row) => row.turn === `proactive:${published.id}`,
    ),
  ).toHaveLength(1);
  const count = ofType(log, "AikoProactiveDecision").length;
  await f.restart();
  await f.request("/v1/hooks", hook);
  await f.service.host.drive();
  expect(
    ofType(await f.events("user-123"), "AikoProactiveDecision"),
  ).toHaveLength(count);
  expect(f.deliveries).toHaveLength(priorSends + 1);
  expect(model.calls).toBe(priorCalls + 1);
});

test("a reflection cannot publish another account's evidence or malformed decision JSON", async () => {
  let support = "obs_missing_foreign_support";
  let malformed = false;
  const model = reflectionModel(() =>
    malformed
      ? { decision: "notify", reason: "missing required fields" }
      : {
          decision: "notify",
          reason: "foreign source",
          text: "Foreign evidence must not be sent",
          supports: [support],
        },
  );
  const f = await fixture({ mode: "live" }, { model: model.layer });
  await f.request(
    "/v1/hooks",
    { ...learning("learning_foreign_001"), subject: "project:bob-private" },
    bob,
  );
  await f.service.host.drive();
  support = String(
    ofType(
      await f.events(backgroundThread("456", "indexer")),
      "AikoLearningIndexed",
    )[0].observation,
  );
  await f.request("/v1/hooks", learning("learning_unowned_001"));
  await f.service.host.drive();
  expect(
    ofType(await f.events("user-123"), "AikoProactiveDecision"),
  ).toHaveLength(0);
  expect(f.deliveries).toHaveLength(0);
  malformed = true;
  await f.request("/v1/hooks", learning("learning_malformed_002", 2));
  await f.service.host.drive();
  expect(
    ofType(await f.events("user-123"), "AikoProactiveDecision"),
  ).toHaveLength(0);
  const decisions = ofType(
    await f.events(backgroundThread("123", "reflection")),
    "AikoDecisionRecorded",
  );
  expect(decisions).toHaveLength(2);
  expect(decisions.every((decision) => decision.decision === "silent")).toBe(
    true,
  );
  expect(model.calls).toBe(3);
  expect(f.deliveries).toHaveLength(0);
});

test("pausing hooks survives restart and resuming processes the durable pending change once", async () => {
  const model = reflectionModel(() => ({
    decision: "silent",
    reason: "No interruption needed",
    text: "",
    supports: [],
  }));
  const f = await fixture({ mode: "live" }, { model: model.layer });
  expect(await f.telegram(301)).toBe("accepted");
  await f.service.host.drive();
  const priorCalls = model.calls;
  const priorSends = f.deliveries.length;
  const pause = { account: "123", paused: true };
  expect([200, 202]).toContain(
    (await f.request("/api/control/hooks", pause, f.config.operatorToken))
      .status,
  );
  expect(
    (await f.request("/v1/hooks", learning("learning_paused_001"))).status,
  ).toBe(202);
  await f.service.host.drive();
  expect(model.calls).toBe(priorCalls);
  await f.restart();
  const control = await (
    await f.request("/api/control/threads?account=123")
  ).json();
  expect(control.hooks.paused).toBe(true);
  expect(model.calls).toBe(priorCalls);
  expect([200, 202]).toContain(
    (
      await f.request(
        "/api/control/hooks",
        { ...pause, paused: false },
        f.config.operatorToken,
      )
    ).status,
  );
  await f.service.host.drive();
  expect(model.calls).toBe(priorCalls + 1);
  expect(
    ofType(
      await f.events(backgroundThread("123", "indexer")),
      "AikoLearningIndexed",
    ),
  ).toHaveLength(1);
  await f.restart();
  expect(model.calls).toBe(priorCalls + 1);
  expect(f.deliveries).toHaveLength(priorSends);
});

test("an older same-owner citation cannot support a notification about a newer changed snapshot", async () => {
  let oldObservation: string | undefined;
  const model = reflectionModel(() =>
    oldObservation
      ? {
          decision: "notify",
          reason: "Old evidence",
          text: "Do not publish this outdated inference",
          supports: [oldObservation],
        }
      : {
          decision: "silent",
          reason: "Initial context",
          text: "",
          supports: [],
        },
  );
  const f = await fixture({ mode: "live" }, { model: model.layer });
  await f.request("/v1/hooks", learning("learning_stale_001"));
  await f.service.host.drive();
  oldObservation = String(
    ofType(
      await f.events(backgroundThread("123", "indexer")),
      "AikoLearningIndexed",
    )[0].observation,
  );
  await f.request("/v1/hooks", learning("learning_stale_002", 2));
  await f.service.host.drive();
  expect(model.calls).toBe(2);
  expect(
    ofType(await f.events("user-123"), "AikoProactiveDecision"),
  ).toHaveLength(0);
  expect(
    ofType(
      await f.events(backgroundThread("123", "reflection")),
      "AikoDecisionRecorded",
    ).at(-1)?.decision,
  ).toBe("silent");
  expect(f.deliveries).toHaveLength(0);
});

test("upgrading completed legacy logs activates hooks after history without reflecting or notifying historical turns", async () => {
  const model = reflectionModel((changed) => ({
    decision: "notify",
    reason: "Fixture would notify for every reflected change",
    text: "A new change was reflected.",
    supports: changed.map((item) => item.observation).slice(0, 1),
  }));
  const f = await fixture({ mode: "live" }, { model: model.layer });
  const oldAt = Date.now() - 86_400_000;
  const legacy: AikoEvent[] = [
    threadCreated(
      parseThreadAddress(f.service.host.self("user-123")),
      undefined,
      oldAt,
    ),
  ];
  for (const turn of ["telegram:old-1", "telegram:old-2"]) {
    legacy.push(
      {
        type: "MessageReceived",
        id: turn,
        text: "A historical conversation",
        source: "telegram",
        chat: "123",
        at: oldAt,
      },
      {
        type: "TurnCompleted",
        turn,
        epoch: 0,
        output: "An old reply",
        at: oldAt,
      },
      {
        type: "AikoReplyPrepared",
        turn,
        epoch: 0,
        result: { text: "An old reply", source: "template" },
        at: oldAt,
      },
      { type: "AikoDeliveryStarted", turn, epoch: 0, at: oldAt },
      {
        type: "AikoDeliverySettled",
        turn,
        epoch: 0,
        result: { status: "delivered", providerId: turn },
        at: oldAt,
      },
      {
        type: "AikoLogMemoryFollowed",
        turn,
        after: legacy.length + 6,
        status: "current",
        at: oldAt,
      },
    );
  }
  // Native seed imports an old committed log without waking the new actor.
  await f.service.host.seed("user-123", legacy);
  await f.restart();
  expect(model.calls).toBe(0);
  expect(f.deliveries).toHaveLength(0);
  expect(await f.service.host.threads()).toEqual(["user-123"]);
  const upgraded = await f.events("user-123");
  expect(upgraded.slice(0, legacy.length)).toEqual(legacy);
  expect(ofType(upgraded, "AikoHooksActivated")).toHaveLength(1);
  expect(upgraded[legacy.length].type).toBe("AikoHooksActivated");
  expect(ofType(upgraded, "AikoHookDispatched")).toHaveLength(0);
  await f.restart();
  expect(model.calls).toBe(0);
  expect(ofType(await f.events("user-123"), "AikoHooksActivated")).toHaveLength(
    1,
  );
  expect(await f.telegram(401, 123, "Hello after the upgrade")).toBe(
    "accepted",
  );
  await f.service.host.drive();
  expect(model.calls).toBe(0);
  const dispatches = ofType(await f.events("user-123"), "AikoHookDispatched");
  expect(dispatches).toHaveLength(1);
  expect(dispatches[0].id).toBe("log:telegram:401");
  expect(
    (await f.request("/v1/hooks", learning("learning_after_upgrade_001")))
      .status,
  ).toBe(202);
  await f.service.host.drive();
  expect(model.calls).toBe(1);
});

test("recovery replays lost native routing receipts without repeating reflection or foreground Telegram delivery", async () => {
  const model = reflectionModel((changed) =>
    changed.some((item) => item.subject.includes("aurorapanda"))
      ? {
          decision: "notify",
          reason: "New release evidence",
          text: "A release change is ready to review.",
          supports: changed
            .filter((item) => item.subject.includes("aurorapanda"))
            .map((item) => item.observation)
            .slice(0, 1),
        }
      : {
          decision: "silent",
          reason: "Routine greeting",
          text: "",
          supports: [],
        },
  );
  const f = await fixture({ mode: "live", voiceKey: "thinkfeel-background-fixture" }, { model: model.layer, voiceFetch: positiveVoiceFetch });
  expect(await f.telegram(402)).toBe("accepted");
  await f.service.host.drive();
  const hook = learning("learning_crash_001");
  expect((await f.request("/v1/hooks", hook)).status).toBe(202);
  await f.service.host.drive();
  const id = `hook:${hook.id}`;
  const priorCalls = model.calls;
  const priorSends = f.deliveries.length;
  expect(priorSends).toBe(2);
  const foregroundBefore = await f.events("user-123");
  expect(
    ofType(foregroundBefore, "AikoProactiveDecision").filter(
      (event) => event.id === id,
    ),
  ).toHaveLength(1);
  await f.restart(() => {
    for (const [role, receipt] of [
      ["indexer", "AikoReflectionDispatched"],
      ["reflection", "AikoDecisionPublished"],
    ] as const) {
      const database = new Database(
        accountThreadDatabase(f.config.stateDir, backgroundThread("123", role)),
      );
      try {
        const row = database
          .query<{ seq: number }, [string, string]>(
            "SELECT seq FROM events WHERE json_extract(event, '$.type') = ? AND json_extract(event, '$.id') = ?",
          )
          .get(receipt, id);
        expect(row).not.toBeNull();
        // Restore only the sender's durable prefix at the crash boundary; receiver commits remain intact.
        database.query("DELETE FROM events WHERE seq >= ?").run(row!.seq);
      } finally {
        database.close();
      }
    }
  });
  expect(model.calls).toBe(priorCalls);
  expect(f.deliveries).toHaveLength(priorSends);
  expect(await f.events("user-123")).toEqual(foregroundBefore);
  for (const [role, receipt] of [
    ["indexer", "AikoReflectionDispatched"],
    ["reflection", "AikoDecisionPublished"],
  ] as const) {
    expect(
      ofType(await f.events(backgroundThread("123", role)), receipt).filter(
        (event) => event.id === id,
      ),
    ).toHaveLength(1);
  }
  await f.restart();
  expect(model.calls).toBe(priorCalls);
  expect(f.deliveries).toHaveLength(priorSends);
  expect(await f.service.host.resting()).toBe(true);
});

test("the next foreground turn sees the proactive reply that was actually sent to Telegram", async () => {
  let history: ReturnType<typeof renderMessages> = [];
  const model = Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "foreground-history" },
    }),
    react: (request) => {
      if (request.identity.turn === "telegram:404")
        history = renderMessages(request.trajectory);
      return Effect.succeed({ kind: "complete" as const, output: "Hello." });
    },
  });
  const background = reflectionModel((changed) => ({
    decision: "notify",
    reason: "Private background rationale",
    text: "Aurorapanda is now scheduled for Thursday.",
    supports: changed.map((item) => item.observation).slice(0, 1),
  }));
  const f = await fixture(
    { mode: "live", voiceKey: "thinkfeel-background-fixture" },
    { model, backgroundModel: background.layer, voiceFetch: positiveVoiceFetch },
  );
  expect(await f.telegram(403)).toBe("accepted");
  await f.service.host.drive();
  expect(
    (await f.request("/v1/hooks", learning("learning_history_001", 2))).status,
  ).toBe(202);
  await f.service.host.drive();
  const delivered = String(f.deliveries.at(-1)?.text);
  expect(delivered).toContain("Aurorapanda is now scheduled for Thursday");
  expect(await f.telegram(404, 123, "What changed in that schedule?")).toBe(
    "accepted",
  );
  await f.service.host.drive();
  expect(
    history.some(
      (message) =>
        message.role === "assistant" && message.content === delivered,
    ),
  ).toBe(true);
  expect(JSON.stringify(history)).not.toContain("Private background rationale");
});

test("a real owner connection event opens a Telegram Mini App through the foreground actor", async () => {
  const f = await fixture({replyStyle:"direct"}, {connectorBrowser: () => ({native:true,
    begin: async () => ({authorizationUrl:"https://signin.aiko.com/connect"}),
    status: async binding => ({...binding,status:"pending"}),
  })});
  await f.telegram(19001);
  await f.service.host.drive();
  const response = await f.request("/api/connectors/browser",{domain:"service.net"});
  expect(response.status).toBe(200);
  const connection = await response.json() as {id:string};
  await f.service.host.drive();
  const notices = () => f.deliveries.filter((d:any) => d.reply_markup?.inline_keyboard?.[0]?.[0]?.web_app);
  expect(notices()).toHaveLength(1);
  expect(notices()[0]).toMatchObject({chat_id:"123",reply_markup:{inline_keyboard:[[{text:"Sign in",web_app:{url:`https://aiko-agent.lewis-6d8.workers.dev/connect?connection=${connection.id}`}}]]}});
  expect(ofType(await f.events("user-123"),"AikoLoginNoticeSettled")[0]?.status).toBe("delivered");
  await f.restart(); await f.request("/api/connectors/connections"); await f.service.host.drive();
  expect(notices()).toHaveLength(1);
});
