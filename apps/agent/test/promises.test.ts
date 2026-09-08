import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  infer,
  tool,
  Infer,
  outputValidateOnce,
  codeMode,
} from "tardie";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import {
  promiseComponent,
  promiseTools,
  promiseEventKey,
  promiseNextWake,
  promiseState,
  createPromises,
} from "../src/promises.ts";
import { EventLog, withWatermark } from "tardie/core/log";
import { redactor } from "../src/security.ts";
import { CodeHarness, codeHarnessEventKey } from "../src/code-harness.ts";
import { withPromiseExecution } from "../src/promise-execution.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { promiseApi } from "../src/promise-api.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import type { Event } from "tardie/core/event";
import type { NativeTool } from "tardie/component/tool";
import { Self } from "tardie/core/runtime";
import { privateCodeSandbox } from "../src/code-agents.ts";
import { definePackage } from "tardie/code/package/definition";
import { Park } from "tardie/code/execution/errors";
import { cancellationRequested } from "tardie/core/method/cancellation";

const OWNER = "123";
const THREAD = `user-${OWNER}`;

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function storage(): AccountStorage {
  const db = new Database(":memory:");
  dbs.push(db);
  let alarm: number | null = null;
  return {
    sql: {
      exec: (sql, ...args) => {
        const rows = db.query(sql).all(...(args as any[]));
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
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

async function fixture(native: NativeTool<Self | EventLog>[] = []) {
  const calls: unknown[] = [];
  const store = storage();
  const kvDb = new Database(":memory:"); dbs.push(kvDb);
  const blobs = harnessBlobStore(sqliteWorkflowKV(kvDb));
  let authorized = true;
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const read = () => host.read(THREAD);
  let modelCalls = 0;
  const assembly = () => {
    const harness = new CodeHarness(OWNER, THREAD, async (segment, signal) => {
      if (!segment.history.length) calls.push(structuredClone(segment));
      return runCodeSegment(segment, signal);
    }, redactor(["private-fixture-secret"]), undefined, {
      blobs, read, authorize: async () => authorized,
    });
    const definition = actor({
      name: "aiko",
      methods: { message: agentMessageMethod },
      components: [promiseComponent(OWNER), infer([
        tool(promiseTools(OWNER, redactor(["private-fixture-secret"]))),
        privateCodeSandbox(codeMode([harness.package(native), definePackage({ name: "waiter", description: "Synthetic durable receipt wait", docs: { wait: { description: "Wait for the synthetic native receipt", input: { type: "object" }, output: {} } }, methods: { wait: (_args, ctx) => Effect.gen(function* () {
          const events = yield* (yield* EventLog).read;
          if (!events.some(e => e.type === "ResponseReceived" && e.id === "fixture-ready")) return yield* Effect.fail(new Park({ callId: ctx.callId, awaiting: "fixture-ready" }));
          return { ready: true };
        }) } })]), harness),
        outputValidateOnce,
      ])],
    });
    return { harness, definition };
  };
  const model = Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "promises-test" },
    }),
    react: (request: any) => {
      modelCalls++;
      if (request.identity.turn.startsWith("promise-execution:")) throw Error("Frozen execution must not call a model");
      const message = request.trajectory.find(
        (e: any) =>
          e.type === "MessageReceived" && e.id === request.identity.turn,
      )!;
      const called = request.trajectory.some(
        (e: any) =>
          ["ToolReturned", "ToolFailed", "ToolRejected"].includes(e.type) &&
          e.turn === request.identity.turn,
      );
      if (message.source === "automation" || called)
        return Effect.succeed({
          kind: "complete" as const,
          output: "Fixture complete; no external effects.",
        });
      const command = JSON.parse(String(message.text));
      return Effect.succeed({
        kind: "call" as const,
        callId: `call:${request.identity.turn}`,
        name: command.tool,
        arguments: command.args,
      });
    },
  });
  const open = async () => {
    const { harness, definition } = assembly();
    return createCloudflareAccountHost({
    storage: store,
    actorName: "aiko",
    actorInstance: "test",
    ownsThread: (t: string) => t === THREAD,
    actorFor: () => definition,
    layersFor: () => Layer.merge(withPromiseExecution(harness.inference(model), OWNER, read), harness.sandboxLayer()),
    keyOf: e => promiseEventKey(e) ?? codeHarnessEventKey(e),
    nextWake: async () => promiseNextWake(await host.read(THREAD)),
  });
  };
  host = await open();
  const emit = async (e: any) => {
    await host.commitRoot(host.self(THREAD), e);
    await host.drive();
  };
  return {
    get host() { return host; },
    thread: THREAD,
    setAuthorized: (value: boolean) => { authorized = value; },
    modelCalls: () => modelCalls,
    restart: async () => { await host.close(); host = await open(); },
    api: (method: string, body?: unknown, principal: Parameters<typeof promiseApi>[2] = { owner: OWNER, scopes: ["read", "write"] }) => promiseApi(
      new Request(`https://fixture.test/api/promises${method === "POST" ? "/decision" : ""}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      OWNER, principal, { read, append: async events => { for (const e of events) await host.commitRoot(host.self(THREAD), e); }, wake: () => host.drive() }),
    calls,
    emit,
    read,
    prepare: async (when: object, extra: object = {}) => {
      await emit({
        type: "MessageReceived",
        id: crypto.randomUUID(),
        source: "plane",
        at: Date.now(),
        text: JSON.stringify({
          tool: "promise_prepare",
          args: { code: "return 'done';", when, ...extra },
        }),
      });
      return read().then(
        (events) =>
          events.findLast((e) => e.type === "ToolReturned")?.result as any,
      );
    },
  };
}

function service(clock?: { now: () => number }) {
  return createPromises({ owner: OWNER, thread: THREAD, now: clock?.now });
}

function ownerLog(f: {
  host: ReturnType<typeof Object>;
  thread: string;
  read: () => Promise<readonly any[]>;
}) {
  return withWatermark({
    read: Effect.promise(f.read),
    append: (events: readonly any[]) =>
      Effect.promise(async () => {
        for (const e of events) await f.host.commitRoot(f.host.self(f.thread), e);
      }),
  });
}

test("hook promise dispatches exactly once on the matching event and never again", async () => {
  const f = await fixture();
  const prepared = await f.prepare({
    kind: "hook",
    eventType: "AikoHookReceived",
  });
  expect(prepared.status).toBe("recorded");
  expect(prepared.hash).toMatch(/^[0-9a-f]{64}$/);
  const before = f.calls.length;
  await f.emit({
    type: "AikoAutomationSignal",
    id: "sig-1",
    at: Date.now(),
    owner: OWNER,
    eventType: "AikoHookReceived",
  });
  expect(f.calls.length).toBe(before + 1);
  const settled = (await f.read()).findLast(
    (e) => e.type === "AikoPromiseSettled",
  ) as any;
  expect(settled?.outcome).toBe("succeeded");
  // Additional matching signals never re-execute a settled promise.
  for (const n of [2, 3])
    await f.emit({
      type: "AikoAutomationSignal",
      id: `sig-${n}`,
      at: Date.now() + n,
      owner: OWNER,
      eventType: "AikoHookReceived",
    });
  expect(f.calls.length).toBe(before + 1);
});

test("hook promise ignores non-matching events and internal browser-learning signals", async () => {
  const f = await fixture();
  await f.prepare({ kind: "hook", eventType: "AikoApiObserved" });
  await f.emit({
    type: "AikoAutomationSignal",
    id: "sig-wrong",
    at: Date.now(),
    owner: OWNER,
    eventType: "AikoHookReceived",
  });
  await f.emit({
    type: "AikoHookReceived",
    id: "raw-internal",
    at: Date.now(),
    owner: OWNER,
    hook: { kind: "login", origin: "https://example.com" },
    sourceThread: "browser",
  });
  const state = promiseState(await f.read());
  expect(
    [...state.records.values()].filter((r) => r.state === "pending").length,
  ).toBe(1);
});

test("at promise ignores early ticks, fires once when due, and clears the wake", async () => {
  const f = await fixture();
  const due = Date.now() + 3_600_000;
  const prepared = await f.prepare({ kind: "at", at: due });
  expect(prepared.status).toBe("recorded");
  expect(promiseNextWake(await f.read())).toBe(due);
  await f.emit({
    type: "AikoPromiseTick",
    id: "tick-early",
    at: due - 1,
    owner: OWNER,
  });
  expect(f.calls.length).toBe(0);
  const clock = Date.now;
  Date.now = () => due;
  try { await f.emit({
    type: "AikoPromiseTick",
    id: "tick-due",
    at: due,
    owner: OWNER,
  }); } finally { Date.now = clock; }
  expect(f.calls.length).toBe(1);
  await f.emit({
    type: "AikoPromiseTick",
    id: "tick-late",
    at: due + 1,
    owner: OWNER,
  });
  expect(f.calls.length).toBe(1);
  expect(promiseNextWake(await f.read())).toBeUndefined();
});

test("approval promise stays pending until the owner decides; approval dispatches once", async () => {
  const f = await fixture();
  const prepared = await f.prepare({ kind: "approval" });
  const id = prepared.id as string;
  await f.emit({
    type: "AikoApiObserved",
    id: "noise",
    at: Date.now(),
    owner: OWNER,
    read: { url: "https://example.com", method: "GET", status: 200 },
  });
  expect(f.calls.length).toBe(0);
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = service();
      yield* s.resolve(id, { kind: "human", subject: "account:123" });
    }).pipe(Effect.provideService(EventLog, ownerLog(f))),
  );
  await f.host.drive();
  expect(f.calls.length).toBe(1);
  const settled = (await f.read()).findLast(
    (e) => e.type === "AikoPromiseSettled",
  ) as any;
  expect(settled?.outcome).toBe("succeeded");
});

test("rejected approval promise never dispatches", async () => {
  const f = await fixture();
  const prepared = await f.prepare({ kind: "approval" });
  const id = prepared.id as string;
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = service();
      yield* s.reject(id, "human");
    }).pipe(Effect.provideService(EventLog, ownerLog(f))),
  );
  await f.host.drive();
  const state = promiseState(await f.read());
  expect(state.records.get(id)?.state).toBe("rejected");
  expect(f.calls.length).toBe(0);
});

test("expired promises never dispatch", async () => {
  const f = await fixture();
  let now = Date.now();
  await Effect.runPromise(
    Effect.gen(function* () {
      const s = service({ now: () => now });
      const prepared = yield* s.prepare({
        payload: {
          kind: "harness",
          segment: {
            version: 1,
            code: "return 1;",
            packages: {},
            values: {},
            ambient: { at: now, seed: "s" },
            history: [],
          },
        },
        when: { kind: "approval" },
      });
      now = prepared.expiresAt + 1;
      const result = yield* s.resolve(prepared.id, {
        kind: "human",
        subject: "account:123",
      });
      expect(result?.state).toBe("expired");
      const fresh = yield* s.get(prepared.id);
      expect(fresh?.state).toBe("expired");
    }).pipe(Effect.provideService(EventLog, ownerLog(f))),
  );
  await f.host.drive();
  expect(f.calls.length).toBe(0);
});

test("fail-closed input shapes and caps", async () => {
  const f = await fixture();
  expect(
    (await f.prepare({ kind: "hook", eventType: "MessageReceived" })).status,
  ).toBe("rejected");
  expect((await f.prepare({ kind: "at", at: Date.now() - 1000 })).status).toBe(
    "rejected",
  );
  expect(
    (
      await f.prepare({ kind: "approval" }, {
        values: { token: "private-fixture-secret" },
      })
    ).status,
  ).toBe("rejected");
  for (let i = 0; i < 16; i++) {
    const r = await f.prepare({ kind: "approval" });
    expect(r.status).toBe("recorded");
  }
  expect((await f.prepare({ kind: "approval" })).status).toBe("rejected");
});

test("legacy interrupted one-segment dispatch is preserved as unknown, never replayed through the new executor", async () => {
  const f = await fixture();
  const prepared = await f.prepare({ kind: "approval" });
  await Effect.runPromise(service().resolve(prepared.id, { kind: "human", subject: "legacy-owner" }).pipe(Effect.provideService(EventLog, ownerLog(f))));
  const prior = promiseState(await f.read()).records.get(prepared.id)!;
  await f.host.commitRoot(f.host.self(THREAD), { type: "AikoPromiseTransition", owner: OWNER, thread: THREAD, id: prior.id, previous: prior.version,
    snapshot: { ...prior, state: "dispatching", version: prior.version + 1, token: "legacy-dispatch" }, at: Date.now() });
  await f.restart(); await f.host.alarm();
  const rows = await f.read();
  expect(promiseState(rows).records.get(prior.id)?.state).toBe("unknown");
  expect(rows.some(e => e.type === "CodeDispatched")).toBe(false);
  expect(f.calls).toEqual([]);
});

const fixtureTool = (run: NativeTool<Self | EventLog>["run"]): NativeTool<Self | EventLog> => ({
  spec: { name: "fixture_action", description: "Synthetic action only", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }, run,
});
const nativeCode = 'const first = await tools.call({name:"fixture_action",arguments:finalPayload}); await waiter.wait({}); return await tools.call({name:"fixture_action",arguments:{text:finalPayload.text+" second"}});';
const nativeInput = { code: nativeCode, packages: { tools: ["call"], waiter: ["wait"] }, values: { finalPayload: { text: "Final ThinkFeel text" } } };

test("owner HTTP review to native tool-yield continuation survives cold host/harness restart without model or duplicate writes", async () => {
  const sent: unknown[] = [];
  const f = await fixture([fixtureTool(input => Effect.sync(() => { sent.push(input); return { status: "completed" }; }))]);
  const prepared = await f.prepare({ kind: "approval" }, nativeInput);
  const modelCalls = f.modelCalls();
  const review = (await (await f.api("GET")).json()).promises[0];
  expect(review.payload.segment.values).toEqual(nativeInput.values);
  expect(sent).toEqual([]);
  expect((await f.api("POST", { id: review.id, hash: review.hash, decision: "approve" })).status).toBe(200);
  expect(sent).toEqual([{ text: "Final ThinkFeel text" }]);
  let rows = await f.read();
  expect(rows.some(e => e.type === "BlockedOn")).toBe(true);
  expect(promiseState(rows).records.get(prepared.id)?.state).toBe("dispatching");
  await f.restart();
  await f.emit({ type: "ResponseReceived", id: "fixture-ready", at: Date.now() });
  rows = await f.read();
  expect(sent).toEqual([{ text: "Final ThinkFeel text" }, { text: "Final ThinkFeel text second" }]);
  expect(rows.filter(e => e.type === "CodeDispatched")).toHaveLength(1);
  expect(rows.filter(e => e.type === "PackageCalled")).toHaveLength(3);
  expect(rows.filter(e => e.type === "PackageReturned")).toHaveLength(3);
  expect(promiseState(rows).records.get(prepared.id)).toMatchObject({ state: "settled", outcome: "succeeded" });
  expect(f.modelCalls()).toBe(modelCalls);
  await f.restart();
  await f.host.drive();
  await f.api("POST", { id: review.id, hash: review.hash, decision: "approve" });
  expect(sent).toHaveLength(2);
});

for (const outcome of ["failed", "unknown", "authorization_required"]) test(`tool ${outcome} cannot become promise success even when guest returns happy text`, async () => {
  let calls = 0;
  const f = await fixture([fixtureTool(() => Effect.sync(() => { calls++; return { status: outcome }; }))]);
  const prepared = await f.prepare({ kind: "approval" }, { code: 'await tools.call({name:"fixture_action",arguments:{text:"final"}}); return "Everything succeeded";', packages: { tools: ["call"] } });
  await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "approve" });
  const current = promiseState(await f.read()).records.get(prepared.id)!;
  expect(current.state).toBe(outcome === "unknown" ? "unknown" : "settled");
  expect(current.outcome).toBe(outcome === "unknown" ? undefined : "failed");
  await f.restart(); await f.host.drive();
  expect(calls).toBe(1);
});

test("a lost native tool response stays unknown through native retry and cold restart", async () => {
  let effects = 0;
  const f = await fixture([fixtureTool(() => Effect.sync(() => { effects++; throw Error("Synthetic loss after commit"); }))]);
  const prepared = await f.prepare({ kind: "approval" }, { code: 'await tools.call({name:"fixture_action",arguments:{text:"final"}}); return "done";', packages: { tools: ["call"] } });
  await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "approve" });
  expect(effects).toBe(1);
  expect(promiseState(await f.read()).records.get(prepared.id)?.state).toBe("unknown");
  await f.restart(); await f.host.drive();
  await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "approve" });
  expect(effects).toBe(1);
});

test("revoking current tool authority while parked blocks the next action after restart", async () => {
  let calls = 0;
  const f = await fixture([fixtureTool(() => Effect.sync(() => { calls++; return { status: "completed" }; }))]);
  const prepared = await f.prepare({ kind: "approval" }, nativeInput);
  await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "approve" });
  expect(calls).toBe(1);
  f.setAuthorized(false); await f.restart();
  await f.emit({ type: "ResponseReceived", id: "fixture-ready", at: Date.now() });
  expect(calls).toBe(1);
  expect(promiseState(await f.read()).records.get(prepared.id)?.outcome).not.toBe("succeeded");
});

test("native cancellation while parked prevents the later write across restart", async () => {
  let calls = 0;
  const f = await fixture([fixtureTool(() => Effect.sync(() => { calls++; return { status: "completed" }; }))]);
  const prepared = await f.prepare({ kind: "approval" }, nativeInput);
  await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "approve" });
  const turn = `promise-execution:${prepared.id}`;
  // The review API truthfully refuses to claim it can undo dispatched work.
  expect((await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "cancel" })).status).toBe(409);
  await f.emit(cancellationRequested({ request: "fixture-cancel", invocation: { method: "message", id: turn, epoch: 0 }, cause: "requested", at: Date.now() }));
  expect((await f.read()).some(e => e.type === "TurnCancelled" && e.turn === turn)).toBe(true);
  await f.restart(); await f.emit({ type: "ResponseReceived", id: "fixture-ready", at: Date.now() });
  expect(calls).toBe(1);
  expect(promiseState(await f.read()).records.get(prepared.id)?.outcome).not.toBe("succeeded");
});
