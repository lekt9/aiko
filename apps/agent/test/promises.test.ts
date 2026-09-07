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
  type PromiseExecutors,
} from "../src/promises.ts";
import { EventLog, withWatermark } from "tardie/core/log";
import { redactor } from "../src/security.ts";

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

async function fixture(executor?: PromiseExecutors["harness"]) {
  const calls: unknown[] = [];
  const harness: PromiseExecutors["harness"] =
    executor ??
    (async (segment) => {
      calls.push(segment);
      return { calls: [], settled: true, result: "ok" };
    });
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [
      promiseComponent(OWNER, { harness }),
      infer([
        tool(promiseTools(OWNER, redactor(["private-fixture-secret"]))),
        outputValidateOnce,
      ]),
    ],
  });
  const model = Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "promises-test" },
    }),
    react: (request: any) => {
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
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  host = await createCloudflareAccountHost({
    storage: storage(),
    actorName: "aiko",
    actorInstance: "test",
    ownsThread: (t: string) => t === THREAD,
    actorFor: () => definition,
    layersFor: () => model,
    keyOf: promiseEventKey,
    nextWake: async () => promiseNextWake(await host.read(THREAD)),
  });
  const emit = async (e: any) => {
    await host.commitRoot(host.self(THREAD), e);
    await host.drive();
  };
  const read = () => host.read(THREAD);
  return {
    host,
    thread: THREAD,
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
  await f.emit({
    type: "AikoPromiseTick",
    id: "tick-due",
    at: due,
    owner: OWNER,
  });
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
