import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, createHmac } from "node:crypto";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, infer, Infer, outputValidateOnce } from "tardie";
import { component } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { Router } from "tardie/core/communication/router";
import { Self } from "tardie/core/runtime";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { childLineageOf, threadCreatedOf } from "tardie/core/thread";
import { actorCall } from "tardie/core/method";
import type { Event } from "tardie/core/event";
import { createControlActor, telegramControl } from "../src/telegram-control.ts";
import { createVoice } from "../src/voice.ts";
import { threadBinding } from "../src/account-binding.ts";
import { voiceAndOutbox } from "../src/actor.ts";
import { channelProgress } from "../src/channel-progress.ts";
import { tool } from "tardie/component/tool";
import { responseTool, withRequiredResponse } from "../src/channel-response.ts";
import { createToolRouterActor, routerEventKey } from "../src/tool-router.ts";
import { createToolRouterComponent } from "../src/tool-router-tools.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";

const databases: Database[] = [];

test("Router delivery checks current authority in its transaction after alarm awaits and never acknowledges rejection", async () => {
  const durable = storage(), self = { actor: "aiko", instance: "delivery-guard", thread: "user-123" };
  let inside = false, allowed = true, revokeDuringArm = false, checks = 0;
  const transaction = durable.transactionSync, getAlarm = durable.getAlarm;
  durable.transactionSync = run => transaction(() => { inside = true; try { return run(); } finally { inside = false; } });
  durable.getAlarm = async () => {
    const at = await getAlarm();
    if (revokeDuringArm) { allowed = false; revokeDuringArm = false; }
    return at;
  };
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [component({
    name: "guarded-native-call", initial: () => [] as Event[], step: (events, event) => [...events, event],
    keys: { prefixes: ["guarded-call:"], keyOf: e => ["StartGuardedCall", "DeliveryRejected"].includes(e.type) ? `guarded-call:${e.type}:${e.id}` : undefined },
    output: events => ({ view: undefined, transitions: !events.some(e => e.type === "StartGuardedCall") || events.some(e => e.type === "DeliveryRejected") ? [] :
      actorCall(events, { id: "guarded-message", target: { address: self, methods: { message: agentMessageMethod } }, method: "message", input: { text: "Do this once" } }).transitions.map(transition =>
        transition.kind !== "effect" ? transition : { ...transition, act: (input, signal) => Effect.gen(function* () {
          revokeDuringArm = true;
          return yield* transition.act(input, signal).pipe(Effect.catchCause(() => Effect.succeed([{ type: "DeliveryRejected", id: "guarded-message", at: Date.now() }])));
        }) }),
    }),
  })] });
  const host = await createCloudflareAccountHost({ storage: durable, actorName: self.actor, actorInstance: self.instance,
    ownsThread: thread => thread === self.thread, actorFor: () => definition, layersFor: () => Layer.empty,
    canDeliver: (thread, events, read) => {
      expect(inside).toBe(true); expect(thread).toBe(self.thread); checks++;
      expect(read().some(e => e.type === "CallPlanned" && e.id === "guarded-message")).toBe(true);
      expect(events).toMatchObject([{ type: "MessageReceived", id: "guarded-message", call: { invocation: { method: "message", id: "guarded-message", epoch: 0 } }, link: { source: self, target: self } }]);
      return allowed;
    },
  });
  try {
    await host.commitRoot(host.self(self.thread), { type: "StartGuardedCall", id: "start", at: Date.now() });
    await host.drive();
    const events = await host.read(self.thread);
    expect(checks).toBe(1); expect(allowed).toBe(false);
    expect(events.some(e => e.type === "DeliveryRejected")).toBe(true);
    expect(events.some(e => ["MessageReceived", "CallDispatched", "ResponseReceived"].includes(e.type))).toBe(false);
    await host.recover(); expect(checks).toBe(1);
  } finally { await host.close(); }
});

test("control append guards native metadata and same-SQL admission without scheduling", async () => {
  const durable = storage();
  durable.sql.exec("CREATE TABLE admissions(owner TEXT PRIMARY KEY)");
  let inside = false, checks = 0, writes = 0;
  const transaction = durable.transactionSync;
  durable.transactionSync = run => transaction(() => {
    inside = true;
    try { return run(); } finally { inside = false; }
  });
  const open = () => createCloudflareAccountHost({
    storage: durable, actorName: "authority", actorInstance: "registry", ownsThread: t => t === "owner-123",
    actorFor: () => undefined, layersFor: () => Layer.empty,
    keyOf: e => typeof e.id === "string" ? `authority:${e.id}` : undefined,
    canAppend: (_thread, events, read) => {
      expect(inside).toBe(true);
      checks++;
      const history = read().filter(e => e.type === "AuthorityChanged");
      return events.every(e => {
        if (e.type === "ThreadCreated") return true;
        const prior = history.find(row => row.id === e.id);
        return prior ? JSON.stringify(prior) === JSON.stringify(e) : e.type === "AuthorityChanged" && e.expected === history.length;
      });
    },
  });
  let host = await open();
  const admitted = { type: "AuthorityChanged", id: "initialize", expected: 0, at: 1 };
  const sidecar = () => { writes++; durable.sql.exec("INSERT INTO admissions VALUES(?)", "123"); return undefined; };
  // Rejection on the first append also rejects the implicit native ThreadCreated.
  expect(await host.appendControl("owner-123", [{ ...admitted, expected: 2 }], { sidecar })).toEqual({ appended: 0, head: 0 });
  expect(await host.read("owner-123")).toEqual([]);
  expect(writes).toBe(0);
  expect(await host.appendControl("owner-123", [admitted], { sidecar })).toEqual({ appended: 2, head: 2 });
  expect(writes).toBe(1);
  expect(durable.sql.exec("SELECT owner FROM admissions").toArray()).toEqual([{ owner: "123" }]);
  expect(await durable.getAlarm()).toBeNull();
  expect(host.work()).toBe(0);
  // Exact retry is acknowledged by retained payload, not by the zero append count.
  expect(await host.appendControl("owner-123", [admitted], { sidecar })).toEqual({ appended: 0, head: 2 });
  expect(await host.appendControl("owner-123", [{ ...admitted, expected: 1 }], { sidecar })).toEqual({ appended: 0, head: 2 });
  expect(writes).toBe(1);
  await host.close();
  host = await open();
  expect((await host.read("owner-123")).at(-1)).toEqual(admitted);
  // Two requests from the same observed revision cannot both win admission.
  let transitions = 0;
  const results = await Promise.all(["prepare-a", "prepare-b"].map(id => host.appendControl("owner-123",
    [{ type: "AuthorityChanged", id, expected: 1, at: 2 }], { sidecar: () => { transitions++; } })));
  expect(results.map(result => result.appended)).toEqual([1, 0]);
  expect(transitions).toBe(1);
  expect(checks).toBe(6);
  expect(await durable.getAlarm()).toBeNull();
  expect(host.work()).toBe(0);
  await host.close();
});

test("control append rolls back metadata and admission when its sidecar fails", async () => {
  const durable = storage();
  durable.sql.exec("CREATE TABLE admissions(owner TEXT PRIMARY KEY)");
  const host = await createCloudflareAccountHost({ storage: durable, actorName: "authority", actorInstance: "registry",
    ownsThread: t => t === "owner-123", actorFor: () => undefined, layersFor: () => Layer.empty, canAppend: () => true });
  const event = { type: "AuthorityInitialized", at: 1 };
  await expect(host.appendControl("owner-123", [event], { sidecar: () => {
    durable.sql.exec("INSERT INTO admissions VALUES(?)", "123");
    throw new Error("admission failed");
  } })).rejects.toThrow("admission failed");
  expect(await host.read("owner-123")).toEqual([]);
  expect(durable.sql.exec("SELECT owner FROM admissions").toArray()).toEqual([]);
  let invoked = false;
  await expect(host.appendControl("owner-123", [event], { sidecar: (async () => {
    invoked = true;
    await Promise.resolve();
    durable.sql.exec("INSERT INTO admissions VALUES(?)", "123");
  }) as unknown as () => undefined })).rejects.toThrow("must be synchronous");
  await Promise.resolve();
  expect(invoked).toBe(false);
  expect(await host.read("owner-123")).toEqual([]);
  expect(durable.sql.exec("SELECT owner FROM admissions").toArray()).toEqual([]);
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
});

test("control append survives lost acknowledgement with exact retained metadata", async () => {
  const durable = storage();
  const event = { type: "AuthorityPrepared", id: "erase-1", at: 1 };
  const options = { storage: durable, actorName: "authority", actorInstance: "registry", ownsThread: (t: string) => t === "owner-123",
    actorFor: () => undefined, layersFor: () => Layer.empty,
    keyOf: (e: { type: string; [key: string]: unknown }) => typeof e.id === "string" ? e.id : undefined,
    canAppend: () => true };
  let host = await createCloudflareAccountHost(options), writes = 0;
  durable.sync = async () => { throw new Error("acknowledgement lost"); };
  await expect(host.appendControl("owner-123", [event], { sidecar: () => { writes++; } })).rejects.toThrow("acknowledgement lost");
  await host.close();
  durable.sync = async () => {};
  host = await createCloudflareAccountHost(options);
  expect((await host.read("owner-123")).at(-1)).toEqual(event);
  expect(await host.appendControl("owner-123", [event], { sidecar: () => { writes++; } })).toEqual({ appended: 0, head: 2 });
  expect(writes).toBe(1);
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
});

test("control append requires an explicit synchronous guard and owned lineage", async () => {
  const options = { storage: storage(), actorName: "authority", actorInstance: "registry", ownsThread: (t: string) => t === "owner-123",
    actorFor: () => undefined, layersFor: () => Layer.empty };
  let host = await createCloudflareAccountHost(options);
  await expect(host.appendControl("owner-123", [{ type: "AuthorityInitialized", at: 1 }])).rejects.toThrow("requires a synchronous guard");
  await host.close();
  host = await createCloudflareAccountHost({ ...options, canAppend: () => true });
  await expect(host.appendControl("foreign", [{ type: "AuthorityInitialized", at: 1 }])).rejects.toThrow();
  await expect(host.appendControl("owner-123", [{ type: "AuthorityInitialized", at: NaN }])).rejects.toThrow("finite timestamp");
  expect(await host.read("owner-123")).toEqual([]);
  await host.close();
});

test("ingress replaces an expired recovery alarm using the native alarm policy", async () => {
  const durable = storage();
  await durable.setAlarm(Date.now() - 1000);
  const definition = actor({name:"aiko",methods:{},components:[]});
  const host = await createCloudflareAccountHost({storage:durable,actorName:"aiko",actorInstance:"test",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.empty});
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"request",at:Date.now()});
  expect(await durable.getAlarm()).toBeGreaterThan(Date.now());
  await host.close();
});

test("a deadline alarm and its native cancellation commit atomically", async () => {
  const durable = storage();
  const definition = actor({name:"aiko",methods:{message:agentMessageMethod},components:[component<null, undefined>({
    name:"deadline-fixture", initial:()=>null, step:state=>state,
    keys:{prefixes:["terminal:"],keyOf:e=>e.type==="TurnCancelled"?`terminal:${e.turn}:${e.epoch ?? 0}`:undefined},
    output:()=>({view:undefined,transitions:[]}),
  })]});
  const host = await createCloudflareAccountHost({storage:durable,actorName:"aiko",actorInstance:"test",ownsThread:t=>t==="user-123",actorFor:()=>definition,layersFor:()=>Layer.empty});
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"deadline",text:"Pending",at:Date.now()-20,
    call:{invocation:{method:"message",id:"deadline",epoch:0},deadlineAt:Date.now()-10}});
  await host.drive();
  durable.sql.exec("CREATE TRIGGER reject_deadline BEFORE INSERT ON aiko_thread_events WHEN NEW.key LIKE 'cx:%' BEGIN SELECT RAISE(ABORT, 'reject cancellation'); END");
  await expect(host.alarm()).rejects.toThrow("reject cancellation");
  expect((await host.read("user-123")).filter(e=>e.type==="AlarmFired" || e.type==="CancellationRequested")).toEqual([]);
  durable.sql.exec("DROP TRIGGER reject_deadline");
  await host.alarm();
  const events = await host.read("user-123");
  expect(events.filter(e=>e.type==="AlarmFired")).toHaveLength(1);
  expect(events.find(e=>e.type==="CancellationRequested")).toMatchObject({cause:"deadline",invocation:{method:"message",id:"deadline",epoch:0}});
  await host.close();
});

test("alarm delivers working text before a router call and the final reply once across recovery", async () => {
  const durable = storage(), sent: string[] = [];
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const router = createToolRouterActor({ owner: "123", engine: {
    listCatalog: async () => [], connections: async () => [],
    describe: async () => { throw Error("not needed"); },
    search: async () => {
      expect(sent).toEqual(["I’ll check the catalog."]);
      return {status: "unavailable", connectors: [], fallbackAllowed: false, message: "fixture"};
    },
  } });
  const model = Layer.succeed(Infer, {
    resolve: () => ({model: {provider: "fixture", model_id: "router-alarm"}}),
    react: request => Effect.succeed(request.trajectory.some(e => e.type === "ToolReturned")
      ? {kind: "complete" as const, output: "The catalog is unavailable."}
      : {kind: "call" as const, text: "I’ll check the catalog.", callId: "discover", name: "tool_router_discover", arguments: {tasks: [{id: "mail", query: "Read email"}]}}),
  });
  const main = actor({name: "aiko", methods: {message: agentMessageMethod}, components: [
    channelProgress({owner:"123",voice:createVoice({enabled:false,persona:"fixture"}),redact:text=>text,
      send:async (_owner,text)=>{sent.push(text);return {status:"delivered"};}}),
    infer([createToolRouterComponent({owner: "123", thread: "user-123", readRouter: () => host.read("router-123")}), outputValidateOnce]),
    voiceAndOutbox("123", createVoice({enabled: false, persona: "fixture"}), async (_owner, text) => { sent.push(text); return {status: "delivered"}; }, {live: true, redact: text => text}),
  ]});
  const options = {storage: durable, actorName: "aiko", actorInstance: "test", ownsThread: (thread: string) => threadBinding(thread)?.owner === "123", keyOf: routerEventKey, actorFor: (thread: string) => thread === "router-123" ? router : main, layersFor: () => model};
  host = await createCloudflareAccountHost(options);
  await host.commitRoot(host.self("user-123"), {type: "MessageReceived", id: "turn", text: "Read email", source: "telegram", chat: "123", sender: "123", at: Date.now()});
  await host.alarm();
  const log = await host.read("user-123");
  expect(log.some(e => e.type === "ResponseReceived")).toBe(true);
  expect(log.some(e => e.type === "CallTimedOut")).toBe(false);
  expect(log.some(e => e.type === "TurnCompleted")).toBe(true);
  expect(sent).toEqual(["I’ll check the catalog.", "The catalog is unavailable."]);
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.alarm();
  expect(sent).toHaveLength(2);
  await host.close();
});

test("Cloudflare alarm lets the control lane respond while a foreground effect is blocked", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started = false;
  const replies: string[] = [];
  const foreground = actor({ name: "aiko", methods: {}, components: [component({
    name: "blocked-browser", initial: () => false,
    step: (done, e) => done || e.type === "WorkDone",
    output: done => ({ view: undefined, transitions: done ? [] : [effect({
      key: "browser", input: null, act: () => Effect.promise(async () => { started = true; await pending; return [{type:"WorkDone", at:Date.now()}]; }),
    })] }),
  })] });
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const control = createControlActor({ owner:"123", live:true, redact:text=>text,
    voice:createVoice({enabled:true,persona:"fixture",required:true,compose:async text=>({status:"ready",text,persona:"fixture"})}),
    send:async (_owner,text)=>{replies.push(text);return {status:"delivered"};},
    publish:rows=>host.seed("user-123",rows),
  });
  host = await createCloudflareAccountHost({ storage:storage(),actorName:"aiko",actorInstance:"demo",
    ownsThread:t=>threadBinding(t)?.owner==="123",actorFor:t=>t==="control-123"?control:foreground,layersFor:()=>Layer.empty,
  });
  await host.commitRoot(host.self("user-123"),{type:"MessageReceived",id:"work",at:Date.now()});
  const driving = host.alarm();
  try {
    for(let i=0;!started&&i<100;i++)await Bun.sleep(5);
    expect(started).toBe(true);
    await telegramControl(host,"123","status","what's happening?",true,true,undefined,{separateLane:true});
    for(let i=0;!replies.length&&i<100;i++)await Bun.sleep(5);
    expect(replies[0]).toContain("unfinished request");
    expect((await host.read("user-123")).some(e=>e.type==="WorkDone")).toBe(false);
  } finally {release();await driving;}
});
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

test("the account alarm delivers early feedback before silent work, then the final reply, without replay", async () => {
  const durable = storage(), sent: string[] = [];
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<string>();
  const voice = createVoice({enabled: false, persona: "fixture"});
  const send = async (_owner: string, text: string) => { sent.push(text); return {status: "delivered" as const}; };
  const definition = actor({name: "aiko", methods: {message: agentMessageMethod}, components: [
    channelProgress({owner: "123", voice, send, redact: text => text}),
    voiceAndOutbox("123", voice, send, {live: true, redact: text => text}),
    infer([tool([
      responseTool("123", "user-123", text => text),
      {spec: {name: "slow_work", description: "Fixture work", inputSchema: {type: "object"}},
        run: () => Effect.promise(async () => { entered.resolve(); return release.promise; })},
    ]), outputValidateOnce]),
  ]});
  let modelCalls = 0;
  const open = () => createCloudflareAccountHost({storage: durable, actorName: "aiko", actorInstance: "early-feedback",
    ownsThread: t => t === "user-123", actorFor: () => definition,
    layersFor: () => withRequiredResponse(Layer.succeed(Infer, {
      resolve: () => ({model: {provider: "fixture", model_id: "progress"}}),
      react: request => {
        modelCalls++;
        return Effect.succeed(request.trajectory.some(e => e.type === "ToolReturned")
          ? {kind: "complete" as const, output: "Here is the result."}
          : {kind: "call" as const, name: "slow_work", callId: "work", arguments: {}});
      },
    })),
  });
  let host = await open();
  try {
    await host.commitRoot(host.self("user-123"), {type: "MessageReceived", id: "turn", source: "telegram", chat: "123", sender: "123", text: "Check this", at: 1});
    expect(await durable.getAlarm()).not.toBeNull();
    const running = host.alarm();
    try {
      await entered.promise;
      expect(sent).toEqual(["I’m looking into your request now."]);
      expect((await host.read("user-123")).some(e => e.type === "AikoDeliverySettled")).toBe(false);
    } finally { release.resolve("Done"); await running; }
    expect(sent).toEqual(["I’m looking into your request now.", "Here is the result."]);
    expect(modelCalls).toBe(2);
    await host.close(); host = await open();
    await host.alarm();
    expect(sent).toHaveLength(2);
    expect(modelCalls).toBe(2);
  } finally { await host.close(); }
});

function storage(): AccountStorage {
  const db = new Database(":memory:");
  databases.push(db);
  let alarm: number | null = null;
  return {
    sql: {
      exec: (query, ...bindings) => {
        const rows = db
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          );
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (operation) => db.transaction(operation)(),
    sync: async () => {},
    getAlarm: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}

const keyOf = (e: { type: string; [name: string]: unknown }) =>
  typeof e.id === "string" ? `${e.type}:${e.id}` : undefined;

test("scoped native threads route durably, preserve identity, and recover without duplicate effects", async () => {
  const durable = storage();
  let actions = 0;
  const definition = actor({
    name: "aiko",
    methods: {},
    components: [
      component({
        name: "test-routing",
        keys: {
          prefixes: ["Done:"],
          keyOf: (e) => (e.type === "Done" ? `Done:${e.id}` : undefined),
        },
        initial: () => ({ events: [] as Record<string, unknown>[] }),
        step: (state, e) => ({ events: [...state.events, e] }),
        output: (state) => ({
          view: undefined,
          transitions: state.events
            .filter(
              (e) =>
                e.type === "Input" &&
                !state.events.some((d) => d.type === "Done" && d.id === e.id),
            )
            .map((e) =>
              effect({
                key: `Done:${e.id}`,
                input: e,
                act: (input) =>
                  Effect.gen(function* () {
                    actions++;
                    const self = yield* Self;
                    if (self.thread === "user-123") {
                      const router = yield* Router;
                      const target = {
                        ...self,
                        thread: "background-123-indexer",
                      };
                      const created = threadCreatedOf(state.events as never)!;
                      yield* router.send(
                        envelopeOf(
                          linkOf(self, target),
                          { type: "Input", id: input.id, at: 10 },
                          childLineageOf(created, "colocated"),
                        ),
                      );
                    }
                    return [{ type: "Done", id: input.id, at: 20 }];
                  }),
              }),
            ),
        }),
      }),
    ],
  });
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) =>
      ["user-123", "background-123-indexer"].includes(t),
    actorFor: () => definition,
    layersFor: () => Layer.empty,
    keyOf,
  };
  let host = await createCloudflareAccountHost(options);
  await host.commitRoot(host.self("user-123"), {
    type: "Input",
    id: "same",
    at: 1,
  });
  expect(await durable.getAlarm()).not.toBeNull();
  await host.drive();
  expect(actions).toBe(2);
  expect(await host.threads()).toEqual(["background-123-indexer", "user-123"]);
  expect((await host.read("background-123-indexer"))[0]).toMatchObject({
    type: "ThreadCreated",
    parent: { thread: "user-123" },
    depth: 1,
  });
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.recover();
  await host.commitRoot(host.self("user-123"), {
    type: "Input",
    id: "same",
    at: 99,
  });
  await host.drive();
  expect(actions).toBe(2);
  expect((await host.readPage("user-123", 0, 2)).map((e) => e.seq)).toEqual([
    1, 2,
  ]);
  await expect(host.read("user-456")).rejects.toThrow("outside");
  await expect(
    host.commit(
      envelopeOf(
        linkOf(
          { actor: "aiko", instance: "demo", thread: "user-456" },
          { actor: "aiko", instance: "demo", thread: "user-123" },
        ),
        { type: "Input", id: "foreign", at: 1 },
      ),
    ),
  ).rejects.toThrow("outside");
  await expect(
    createCloudflareAccountHost({ ...options, actorInstance: "other" }),
  ).rejects.toThrow("identity");
  await host.close();
});

test("history seed is no-drive, pending input survives host eviction and alarm recovery", async () => {
  const durable = storage();
  let calls = 0;
  const definition = actor({
    name: "aiko",
    methods: {},
    components: [
      component({
        name: "test-count",
        keys: {
          prefixes: ["Done:"],
          keyOf: (e) => (e.type === "Done" ? `Done:${e.id}` : undefined),
        },
        initial: () => ({ pending: [] as string[] }),
        step: (state, e) => ({
          pending:
            e.type === "Input"
              ? [...state.pending, String(e.id)]
              : e.type === "Done"
                ? state.pending.filter((id) => id !== e.id)
                : state.pending,
        }),
        output: (state) => ({
          view: undefined,
          transitions: state.pending.map((id) =>
            effect({
              key: `Done:${id}`,
              input: id,
              act: (id) =>
                Effect.sync(() => {
                  calls++;
                  return [{ type: "Done", id, at: 2 }];
                }),
            }),
          ),
        }),
      }),
    ],
  });
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) => t === "user-123",
    actorFor: () => definition,
    layersFor: () => Layer.empty,
    keyOf,
  };
  let host = await createCloudflareAccountHost(options);
  await host.seed("user-123", [
    { type: "Input", id: "history", at: 1 },
    { type: "Done", id: "history", at: 2 },
  ]);
  expect(calls).toBe(0);
  expect(await durable.getAlarm()).toBeNull();
  await host.commitRoot(host.self("user-123"), {
    type: "Input",
    id: "new",
    at: 3,
  });
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.alarm();
  expect(calls).toBe(1);
  expect(
    (await host.read("user-123")).filter((e) => e.type === "Done"),
  ).toHaveLength(2);
  expect(await host.resting()).toBe(true);
  await host.close();
});

test("fresh-account history and native memory sidecar import atomically without driving or replay", async () => {
  const durable = storage();
  durable.sql.exec("CREATE TABLE native_memory(value TEXT)");
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) => t === "user-123",
    actorFor: () => undefined,
    layersFor: () => Layer.empty,
    keyOf,
  };
  const source = await createCloudflareAccountHost({
    ...options,
    storage: storage(),
  });
  await source.seed("user-123", [{ type: "Archived", id: "original", at: 1 }]);
  const histories = source.exportHistory();
  let host = await createCloudflareAccountHost(options);
  await expect(
    host.importHistory("migration-1", histories, {
      fingerprint: "original-memory",
      import: () => {
        durable.transactionSync(() =>
          durable.sql.exec(
            "INSERT INTO native_memory VALUES(?)",
            "rolled-back",
          ),
        );
        throw new Error("Memory archive is invalid");
      },
    }),
  ).rejects.toThrow("invalid");
  expect(await host.threads()).toEqual([]);
  expect(durable.sql.exec("SELECT * FROM native_memory").toArray()).toEqual([]);
  expect(await durable.getAlarm()).toBeNull();
  let imports = 0;
  const sidecar = {
    fingerprint: "original-memory",
    import: () => {
      imports++;
      durable.transactionSync(() =>
        durable.sql.exec("INSERT INTO native_memory VALUES(?)", "restored"),
      );
    },
  };
  expect(await host.importHistory("migration-1", histories, sidecar)).toBe(
    "imported",
  );
  expect(host.exportHistory()).toEqual(histories);
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
  host = await createCloudflareAccountHost(options);
  expect(await host.importHistory("migration-1", histories, sidecar)).toBe(
    "duplicate",
  );
  expect(imports).toBe(1);
  expect(durable.sql.exec("SELECT * FROM native_memory").toArray()).toEqual([
    { value: "restored" },
  ]);
  await expect(
    host.importHistory("migration-1", histories, {
      ...sidecar,
      fingerprint: "different-memory",
    }),
  ).rejects.toThrow("conflict");
  expect(imports).toBe(1);
  await host.close();
  await source.close();
});

test("alarm recovers all pending threads without starving background work", async () => {
  const durable = storage();
  const calls: string[] = [];
  const makeActor = (label: string) =>
    actor({
      name: "aiko",
      methods: {},
      components: [
        component({
          name: `slice-${label}`,
          keys: {
            prefixes: ["Done:"],
            keyOf: (e) => (e.type === "Done" ? `Done:${e.id}` : undefined),
          },
          initial: () => ({ pending: [] as string[] }),
          step: (state, e) => ({
            pending:
              e.type === "Input"
                ? [...state.pending, String(e.id)]
                : e.type === "Done"
                  ? state.pending.filter((id) => id !== e.id)
                  : state.pending,
          }),
          output: (state) => ({
            view: undefined,
            transitions: state.pending.map((id) =>
              effect({
                key: `Done:${id}`,
                input: id,
                act: (id) =>
                  Effect.sync(() => {
                    calls.push(`${label}:${id}`);
                    return [{ type: "Done", id, at: Date.now() }];
                  }),
              }),
            ),
          }),
        }),
      ],
    });
  const foreground = makeActor("fg");
  const indexer = makeActor("idx");
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) =>
      t === "user-123" || t === "background-123-indexer",
    actorFor: (t: string) =>
      t === "user-123" ? foreground : t === "background-123-indexer" ? indexer : undefined,
    layersFor: () => Layer.empty,
    keyOf,
  };
  let host = await createCloudflareAccountHost(options);
  await host.commitRoot(host.self("user-123"), { type: "Input", id: "fg", at: 1 });
  await host.commitRoot(host.self("background-123-indexer"), {
    type: "Input",
    id: "idx",
    at: 1,
  });
  await host.close();
  calls.length = 0;
  host = await createCloudflareAccountHost(options);
  await host.alarm();
  expect(calls).toEqual(["fg:fg", "idx:idx"]);
  expect((await host.read("user-123")).some((e) => e.type === "Done")).toBe(true);
  expect(
    (await host.read("background-123-indexer")).some((e) => e.type === "Done"),
  ).toBe(true);
  expect(await durable.getAlarm()).toBeNull();
  await host.alarm();
  expect(calls).toEqual(["fg:fg", "idx:idx"]);
  await host.close();
});

test("alarm replays a cold settled history once and reuses its projection on later wakes", async () => {
  const durable = storage();
  let steps = 0;
  const definition = actor({name: "aiko", methods: {}, components: [component<number, undefined>({
    name: "replay-cost", initial: () => 0,
    step: state => { steps++; return state + 1; },
    output: () => ({view: undefined, transitions: []}),
  })]});
  const options = {storage: durable, actorName: "aiko", actorInstance: "test", ownsThread: (t: string) => t === "user-123", actorFor: () => definition, layersFor: () => Layer.empty};
  let host = await createCloudflareAccountHost(options);
  await host.seed("user-123", Array.from({length: 1000}, (_, id) => ({type: "Archived", id: String(id), at: 1})));
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.alarm();
  expect(steps).toBe(1001);
  await host.alarm();
  expect(steps).toBe(1001);
  await host.close();
});

test("native recovery preserves an external durable idle deadline across eviction", async () => {
  const durable = storage();
  let nextWake: number | undefined = Date.now() + 240_000;
  const options = {
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) => t === "user-123",
    actorFor: () => undefined,
    layersFor: () => Layer.empty,
    keyOf,
    nextWake: async () => nextWake,
  };
  let host = await createCloudflareAccountHost(options);
  await host.commitRoot(host.self("user-123"), {
    type: "Archived",
    id: "wake",
    at: 1,
  });
  await host.drive();
  expect(await durable.getAlarm()).toBe(nextWake!);
  await host.close();
  host = await createCloudflareAccountHost(options);
  await host.recover();
  expect(await durable.getAlarm()).toBe(nextWake!);
  nextWake = undefined;
  await host.alarm();
  expect(await durable.getAlarm()).toBeNull();
  await host.close();
});

test("concurrent first child deliveries validate persisted lineage after arming recovery", async () => {
  const durable = storage();
  const host = await createCloudflareAccountHost({
    storage: durable,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) =>
      [
        "user-123",
        "background-123-indexer",
        "background-123-reflection",
      ].includes(t),
    actorFor: () => undefined,
    layersFor: () => Layer.empty,
    keyOf,
  });
  const foreground = { actor: "aiko", instance: "demo", thread: "user-123" },
    indexer = { ...foreground, thread: "background-123-indexer" },
    reflection = { ...foreground, thread: "background-123-reflection" };
  await host.commitRoot(host.self(foreground.thread), {
    type: "Archived",
    id: "parent",
    at: 1,
  });
  await host.commitRoot(host.self(reflection.thread), {
    type: "Archived",
    id: "other-parent",
    at: 1,
  });
  const results = await Promise.allSettled([
    host.commit(
      envelopeOf(
        linkOf(foreground, indexer),
        { type: "Archived", id: "first", at: 2 },
        { parent: foreground, depth: 1, placement: "colocated" },
      ),
    ),
    host.commit(
      envelopeOf(
        linkOf(reflection, indexer),
        { type: "Archived", id: "second", at: 2 },
        { parent: reflection, depth: 1, placement: "colocated" },
      ),
    ),
  ]);
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(
    (await host.read(indexer.thread)).filter((e) => e.type === "Archived"),
  ).toHaveLength(1);
  await host.close();
});

// Exercise the real Worker router in Bun without constructing workerd objects.
// Platform, browser trace handlers and VM assembly are traps; actual routing,
// configuration, operator authentication and WebCrypto remain unchanged.
let attestationWorker:
  | Promise<{
      fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
    }>
  | undefined;
function workerForAttestation() {
  return (attestationWorker ??= (async () => {
    const built = await Bun.build({
      entrypoints: [new URL("../src/cloudflare.ts", import.meta.url).pathname],
      target: "bun",
      format: "esm",
      conditions: ["workerd"],
      external: ["node:*"],
      plugins: [
        {
          name: "attestation-platform-traps",
          setup(builder) {
            builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
              path: "workers",
              namespace: "attestation-trap",
            }));
            builder.onResolve(
              { filter: /cloudflare-capabilities\.ts$/ },
              () => ({ path: "capabilities", namespace: "attestation-trap" }),
            );
            builder.onResolve(
              {
                filter: /^@unbrowse\/browser-harness\/(?:trace|network-facts)$/,
              },
              () => ({ path: "trace", namespace: "attestation-trap" }),
            );
            builder.onLoad(
              { filter: /.*/, namespace: "attestation-trap" },
              ({ path }) => ({
                loader: "js",
                contents:
                  path === "workers"
                    ? 'export class DurableObject { constructor() { throw new Error("Attestation must not construct a Durable Object"); } }'
                    : path === "trace"
                      ? 'const fail=()=>{throw new Error("Attestation must not use browser traces");}; export const browserTraceKeys={keyOf:fail}; export const harKeys={keyOf:fail}; export const browserToolActionOf=fail; export const browserToolCategoryOf=fail; export const BROWSER_TRACE_SCHEMA_VERSION="attestation-disabled"; export const BROWSER_TRACE_REDACTION_REVISION="attestation-disabled"; export const decodeBrowserTraceEvent=fail; export const browserRequestEvidenceIdOf=fail; export const assertNetworkSnapshotBackedByLog=fail; export const networkGraphCheckpointOf=fail; export const validatedHarCaptureFactsOf=fail;'
                      : 'export function createCloudflareCapabilities() { throw new Error("Attestation must not allocate a VM or call a provider"); }',
              }),
            );
          },
        },
      ],
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const moduleUrl = URL.createObjectURL(
      new Blob([await built.outputs[0]!.text()], {
        type: "application/javascript",
      }),
    );
    try {
      return (await import(moduleUrl)).default;
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  })());
}
function attestationFixture() {
  let namespaceAccesses = 0;
  const namespace = {
    getByName() {
      namespaceAccesses++;
      throw new Error("Attestation must not access account storage");
    },
  };
  const operator = "private-operator-attestation-fixture-1234567890";
  const account = "private-account-attestation-fixture-1234567890";
  const env: Record<string, unknown> = {
    AIKO_ACCOUNTS: namespace,
    AIKO_REGISTRY: namespace,
    AIKO_MODE: "live",
    AIKO_INSTANCE_ID: "demo",
    CODEGRAFF_API_KEY: "private-provider-attestation-fixture",
    AIKO_OPERATOR_TOKEN: operator,
    AIKO_BOT_TOKEN: "987654321:private_bot_attestation_fixture_1234567890",
    AIKO_WEBHOOK_SECRET: "private_webhook_attestation_fixture_1234567890",
    AIKO_ALLOWED_USERS: "123",
    AIKO_PLANE_CREDENTIALS: JSON.stringify([
      {
        account: "123",
        digest: createHash("sha256").update(account).digest("hex"),
        scopes: ["read", "write"],
      },
    ]),
  };
  const request = async (
    body: unknown,
    options: {
      token?: string;
      method?: string;
      raw?: string;
      headers?: Record<string, string>;
      query?: string;
    } = {},
  ) => {
    const method = options.method ?? "POST";
    return (await workerForAttestation()).fetch(
      new Request(
        "https://aiko-agent.fixture.workers.dev/api/control/telegram-attest" +
          (options.query ?? ""),
        {
          method,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.token ?? operator}`,
            ...options.headers,
          },
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { body: options.raw ?? JSON.stringify(body) }),
        },
      ),
      env,
    );
  };
  return {
    env,
    operator,
    account,
    request,
    get namespaceAccesses() {
      return namespaceAccesses;
    },
  };
}

test("operator-only Worker attestation proves both deployed Telegram secrets without driving a namespace", async () => {
  const f = attestationFixture(),
    nonce = "ab".repeat(32);
  const response = await f.request({ nonce });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text(),
    parsed = JSON.parse(body);
  const expected = createHmac("sha256", String(f.env.AIKO_WEBHOOK_SECRET))
    .update(
      JSON.stringify(["aiko.telegram-cutover/v1", nonce, f.env.AIKO_BOT_TOKEN]),
    )
    .digest("hex");
  expect(parsed).toEqual({ botId: "987654321", proof: expected });
  for (const secret of [
    f.env.AIKO_BOT_TOKEN,
    f.env.AIKO_WEBHOOK_SECRET,
    f.env.AIKO_OPERATOR_TOKEN,
    f.env.CODEGRAFF_API_KEY,
  ])
    expect(body).not.toContain(String(secret));
  expect(body).not.toContain(nonce);
  const next = await (await f.request({ nonce: "cd".repeat(32) })).json();
  expect(next.proof).not.toBe(expected);
  f.env.AIKO_BOT_TOKEN = "987654321:rotated_bot_attestation_fixture_1234567890";
  const rotatedBot = (await (await f.request({ nonce })).json()).proof;
  expect(rotatedBot).not.toBe(expected);
  f.env.AIKO_WEBHOOK_SECRET = "rotated_webhook_attestation_fixture_1234567890";
  expect((await (await f.request({ nonce })).json()).proof).not.toBe(
    rotatedBot,
  );
  expect(f.namespaceAccesses).toBe(0);
}, 30_000);

test("Worker attestation denies account credentials, absent auth, wrong origins and unsafe request bodies", async () => {
  const f = attestationFixture(),
    nonce = "ab".repeat(32);
  expect((await f.request({ nonce }, { token: "invalid" })).status).toBe(401);
  expect(
    (await f.request({ nonce }, { headers: { authorization: "" } })).status,
  ).toBe(401);
  expect((await f.request({ nonce }, { token: f.account })).status).toBe(403);
  expect(
    (
      await f.request(
        { nonce },
        { headers: { origin: "https://evil.invalid" } },
      )
    ).status,
  ).toBe(403);
  const method = await f.request(undefined, { method: "GET" });
  expect(method.status).toBe(405);
  expect(method.headers.get("allow")).toBe("POST");
  for (const body of [
    null,
    [],
    {},
    { nonce: "AB".repeat(32) },
    { nonce: "a".repeat(63) },
    { nonce: "g".repeat(64) },
    { nonce: 1 },
    { nonce, account: "123" },
  ]) {
    const rejected = await f.request(body);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: "invalid_body" });
  }
  expect((await f.request({ nonce }, { raw: '{"nonce":' })).status).toBe(400);
  expect((await f.request({ nonce }, { raw: " ".repeat(257) })).status).toBe(
    400,
  );
  expect(
    (await f.request({ nonce }, { headers: { "content-type": "text/plain" } }))
      .status,
  ).toBe(400);
  expect((await f.request({ nonce }, { query: "?account=123" })).status).toBe(
    400,
  );
  expect(f.namespaceAccesses).toBe(0);
});

test("Worker attestation fails closed with sanitized output for absent or malformed deployed Telegram configuration", async () => {
  for (const overrides of [
    { AIKO_BOT_TOKEN: undefined, AIKO_WEBHOOK_SECRET: undefined },
    { AIKO_WEBHOOK_SECRET: undefined },
    { AIKO_BOT_TOKEN: "bad-token-private-value" },
    { AIKO_WEBHOOK_SECRET: "short-private" },
    { AIKO_BOT_TOKEN: "987654321:credential-with-url-https://evil.invalid" },
  ]) {
    const f = attestationFixture();
    Object.assign(f.env, overrides);
    const response = await f.request({ nonce: "ab".repeat(32) });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).not.toContain("private");
    expect(body).not.toContain("proof");
    expect(f.namespaceAccesses).toBe(0);
  }
});

test("Secretary Mode uses the Cloudflare native host for persistent permissions and account-bound delivery", async () => {
  const { Infer } = await import("tardie");
  const { acceptSecretary, createSecretaryActor, secretaryApi, secretaryEventKey, withSecretaryHistory } = await import("../src/secretary.ts");
  const connection = { id: "business", owner: "123", ownerChat: "123", enabled: true, canReply: true, canRead: false };
  const deliveries: string[] = [];
  const data = storage();
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "secretary" } }), react: () => Effect.succeed({ kind: "complete" as const, output: "sure, tell me more" }) });
  const open = () => createCloudflareAccountHost({ storage: data, actorName: "aiko", actorInstance: "demo", ownsThread: t => threadBinding(t)?.owner === "123", keyOf: secretaryEventKey,
    actorFor: () => createSecretaryActor({ owner: "123", redact: s => s, read: () => host.read("secretary-123"), telegram: { resolve: async () => connection, receive: async () => undefined, send: async (c, m, text) => { deliveries.push(`${c.owner}:${m.chat}:${text}`); return { status: "delivered", providerId: "1" }; }, markRead: async () => {} } }),
    layersFor: () => withSecretaryHistory(model),
  });
  host = await open();
  const message = { connectionId: "business", chat: "456", chatType: "private", name: "Contact", messageId: 1, sender: "456", text: "hi", date: Math.floor(Date.now() / 1000), viaBot: false, unsupported: false };
  await acceptSecretary(host, "123", { user: "123", update: 1, text: "", at: Date.now(), secretary: { kind: "message", connection, message } });
  expect((await secretaryApi(new Request("http://localhost/api/secretary/contact", { method: "POST", body: JSON.stringify({ connectionId: "business", chat: "456", enabled: true }) }), "123", host, s => s)).status).toBe(200);
  await host.drive();
  expect(deliveries).toHaveLength(0);
  host = await open();
  await acceptSecretary(host, "123", { user: "123", update: 2, text: "", at: Date.now(), secretary: { kind: "message", connection, message: { ...message, messageId: 2 } } });
  await host.drive();
  expect(deliveries).toEqual(["123:456:sure, tell me more"]);
  expect((await host.read("secretary-123")).some(e => e.type === "AikoSecretarySettled" && e.status === "delivered")).toBe(true);
  expect(await host.read("user-123")).toHaveLength(0);
});

test("actual Worker routes receive-only capabilities without constructing an owner principal",async()=>{
 const f=attestationFixture(),calls:{owner:string;request:Request}[]=[];
 f.env.AIKO_CHANNEL_INGRESS=async(route:string,token:string)=>route==="fixture-route"&&token==="receive-only"?{owner:"123",scope:"receive",expiresAt:Date.now()+60000}:undefined;
 f.env.AIKO_ACCOUNTS={getByName:()=>({handle:()=>{throw Error("Broad owner admission forbidden");},receiveChannel:async(...args:[string,Request])=>{expect(args).toHaveLength(2);calls.push({owner:args[0],request:args[1]});return Response.json({status:"retained-fixture"},{status:202});}})};
 const worker=await workerForAttestation();
 const request=(headers:Record<string,string>={},method="POST")=>worker.fetch(new Request("https://fixture.workers.dev/v1/channel-ingress/fixture-route",{method,headers,...(method==="POST"?{body:'{"owner":"456"}'}:{})}),f.env);
 expect((await request({authorization:`Bearer ${f.operator}`})).status).toBe(401);
 expect((await request({"x-channel-receive-capability":"invalid"})).status).toBe(403);
 expect((await request({"x-channel-receive-capability":"receive-only"},"GET")).status).toBe(405);
 expect(calls).toHaveLength(0);
 expect((await request({"x-channel-receive-capability":"receive-only"})).status).toBe(202);
 expect(calls).toHaveLength(1);expect(calls[0]!.owner).toBe("123");expect(await calls[0]!.request.text()).toBe('{"owner":"456"}');
 f.env.AIKO_CHANNEL_INGRESS=async()=>({owner:"456",scope:"receive",expiresAt:Date.now()+60000});
 expect((await request({"x-channel-receive-capability":"receive-only"})).status).toBe(403);expect(calls).toHaveLength(1);
});
