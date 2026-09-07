import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer, type Context } from "effect";
import {
  actor,
  agentMessageMethod,
  infer,
  Infer,
  outputValidateOnce,
} from "tardie";
import type { Event } from "tardie/core/log/event";
import { cancellationRequested } from "tardie/core/method/cancellation";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import { turnWatchdog } from "../src/turn-watchdog.ts";

const message = (id: string, at: number): Event => ({
  type: "MessageReceived",
  id,
  text: "fixture",
  at,
});
const cancelled = (id: string, epoch = 0) =>
  cancellationRequested({
    invocation: { method: "message", id, epoch },
    request: `owner:${id}`,
    cause: "requested",
    at: 50,
  });

test("only the current head times out; queued input and cosmetic typing do not refresh it", () => {
  const log = [
    message("old", 10),
    { type: "ModelCalled", turn: "old", at: 20 },
    message("queued", 500),
    { type: "AikoTelegramTypingStarted", turn: "old", at: 900 },
  ];
  const plan = turnWatchdog(log, 100)!;
  expect(plan.deadlineAt).toBe(120);
  expect(plan.event(120)).toMatchObject({
    type: "CancellationRequested",
    cause: "deadline",
    invocation: { method: "message", id: "old", epoch: 0 },
    deadlineAt: 120,
  });
  const completed = [...log, { type: "TurnCancelled", turn: "old", at: 1_000 }];
  expect(turnWatchdog(completed, 100)?.deadlineAt).toBe(1_100);
});

test("real progress refreshes the stall window; prior epochs do not", () => {
  const log = [message("a", 10), { type: "ToolReturned", turn: "a", at: 70 }];
  expect(turnWatchdog(log, 100)?.deadlineAt).toBe(170);
  const resumed = [
    ...log,
    { type: "TurnFailed", turn: "a", at: 80 },
    { type: "TurnResumed", turn: "a", failedEpoch: 0, epoch: 1, at: 90 },
    { type: "ToolReturned", turn: "a", epoch: 0, at: 1_000 },
  ];
  expect(turnWatchdog(resumed, 100)?.deadlineAt).toBe(190);
  expect(turnWatchdog(resumed, 100)?.event(190)).toMatchObject({
    invocation: { id: "a", epoch: 1 },
  });
});

test("settled turns, existing cancellations and explicit native deadlines are untouched", () => {
  expect(turnWatchdog([], 100)).toBeUndefined();
  for (const type of ["TurnCompleted", "TurnFailed", "TurnCancelled"])
    expect(
      turnWatchdog([message("a", 10), { type, turn: "a", at: 50 }], 100),
    ).toBeUndefined();
  expect(turnWatchdog([message("a", 10), cancelled("a")], 100)).toBeUndefined();
  expect(
    turnWatchdog([message("a", 10), cancelled("a", 1)], 100),
  ).toBeDefined();
  for (const deadlineAt of [20, 50_000]) {
    const input = {
      ...message("a", 10),
      call: {
        invocation: { method: "message", id: "a", epoch: 0 },
        deadlineAt,
      },
    };
    expect(turnWatchdog([input], 100)).toBeUndefined();
  }
  for (const at of [undefined, NaN, Infinity, -1])
    expect(turnWatchdog([{ ...message("a", 10), at }], 100)).toBeUndefined();
  expect(() => turnWatchdog([], 0)).toThrow("Invalid");
});

const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function storage(): AccountStorage {
  const db = new Database(":memory:");
  databases.push(db);
  let alarm: number | null = null;
  return {
    sql: {
      exec: (q, ...args) => {
        const rows = db.query(q).all(...(args as never[]));
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
const definition = () =>
  actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [infer([outputValidateOnce])],
  });
function options(
  data: AccountStorage,
  react: Context.Service.Shape<typeof Infer>["react"],
  idleMs = 100,
) {
  const a = definition();
  return {
    storage: data,
    actorName: "aiko",
    actorInstance: "demo",
    ownsThread: (t: string) => ["user-123", "user-456"].includes(t),
    actorFor: () => a,
    layersFor: () =>
      Layer.succeed(Infer, {
        resolve: () => ({
          model: { provider: "fixture", model_id: "watchdog" },
        }),
        react,
      }),
    watchdog: (thread: string, log: readonly Event[]) =>
      thread === "user-123" ? turnWatchdog(log, idleMs) : undefined,
  };
}

test("alarm after eviction cancels an old head once and serves old queued messages without replaying the stale turn", async () => {
  const data = storage(),
    calls: string[] = [];
  const opts = options(data, (request) => {
    calls.push(request.identity.turn);
    return Effect.succeed({ kind: "complete", output: "fixture done" });
  });
  let host = await createCloudflareAccountHost(opts);
  const at = Date.now() - 60_000;
  await host.seed("user-123", [
    message("stalled", at),
    message("queued", at + 1),
  ]);
  await host.close();
  host = await createCloudflareAccountHost(opts);
  try {
    expect(await host.resting()).toBe(false);
    await host.alarm();
    const log = await host.read("user-123");
    expect(log.filter((e) => e.type === "CancellationRequested")).toHaveLength(
      1,
    );
    expect(log.filter((e) => e.type === "TurnCancelled")).toHaveLength(1);
    expect(log.find((e) => e.type === "TurnCancelled")).toMatchObject({
      turn: "stalled",
      cause: "deadline",
    });
    expect(calls).toEqual(["queued"]);
    expect(log.find((e) => e.type === "TurnCompleted")).toMatchObject({
      turn: "queued",
    });
    await host.alarm();
    expect(await host.resting()).toBe(true);
    expect(await data.getAlarm()).toBeNull();
    expect(
      (await host.read("user-123")).filter(
        (e) => e.type === "CancellationRequested",
      ),
    ).toHaveLength(1);
  } finally {
    await host.close();
  }
});

test("the watchdog interrupts live hung inference and suppresses its late result without another alarm", async () => {
  let aborted = false;
  const data = storage();
  const opts = options(
    data,
    (_request, _key, signal) =>
      Effect.promise(
        () =>
          new Promise((resolve) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve({ kind: "complete", output: "must not land" });
              },
              { once: true },
            );
          }),
      ),
    80,
  );
  const host = await createCloudflareAccountHost(opts);
  try {
    await host.commitRoot(host.self("user-123"), message("hung", Date.now()));
    await host.drive();
    expect(aborted).toBe(true);
    const log = await host.read("user-123");
    expect(log.filter((e) => e.type === "TurnCancelled")).toHaveLength(1);
    expect(log.some((e) => e.type === "TurnCompleted")).toBe(false);
    expect(await host.resting()).toBe(true);
  } finally {
    await host.close();
  }
}, 3_000);

test("a progressing inference crosses its initial timeout without being cancelled", async () => {
  const data = storage();
  const opts = options(
    data,
    () =>
      Effect.promise(async () => {
        await Bun.sleep(170);
        return { kind: "complete", output: "finished" };
      }),
    120,
  );
  const host = await createCloudflareAccountHost(opts);
  await host.commitRoot(host.self("user-123"), message("work", Date.now()));
  const driving = host.drive();
  try {
    await Bun.sleep(75);
    await host.commitRoot(host.self("user-123"), {
      type: "ToolReturned",
      turn: "work",
      callId: "fixture-progress",
      at: Date.now(),
    });
    await driving;
    expect(
      (await host.read("user-123")).some(
        (e) => e.type === "CancellationRequested",
      ),
    ).toBe(false);
    expect(
      (await host.read("user-123")).some((e) => e.type === "TurnCompleted"),
    ).toBe(true);
  } finally {
    await driving;
    await host.close();
  }
}, 3_000);

test("the foreground policy never reaps a different account thread", async () => {
  const data = storage(),
    calls: string[] = [];
  const host = await createCloudflareAccountHost(
    options(data, (r) => {
      calls.push(r.identity.turn);
      return Effect.succeed({ kind: "complete", output: "other" });
    }),
  );
  try {
    await host.seed("user-456", [message("other", Date.now() - 60_000)]);
    await host.alarm();
    expect(calls).toEqual(["other"]);
    expect(
      (await host.read("user-456")).some(
        (e) => e.type === "CancellationRequested",
      ),
    ).toBe(false);
  } finally {
    await host.close();
  }
});

test("progress committed during the alarm-storage await wins over a stale timeout decision", async () => {
  const data = storage(),
    original = data.getAlarm;
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let reads = 0;
  data.getAlarm = async () => {
    if (++reads === 2) {
      entered();
      await gate;
    }
    return original();
  };
  const host = await createCloudflareAccountHost(
    options(data, () => Effect.succeed({ kind: "complete", output: "done" })),
  );
  await host.seed("user-123", [message("old", Date.now() - 60_000)]);
  const waking = host.alarm();
  try {
    await waiting;
    await host.seed("user-123", [
      {
        type: "TurnCompleted",
        turn: "old",
        output: "already finished",
        at: Date.now(),
      },
    ]);
    release();
    await waking;
    expect(
      (await host.read("user-123")).some(
        (e) => e.type === "CancellationRequested",
      ),
    ).toBe(false);
  } finally {
    release();
    await waking;
    await host.close();
  }
});

test("monitor keeps covering the next head after cancellation within the same settlement", async () => {
  const data = storage(),
    calls: string[] = [];
  const host = await createCloudflareAccountHost(
    options(
      data,
      (request, _key, signal) =>
        Effect.promise(
          () =>
            new Promise((resolve) => {
              calls.push(request.identity.turn);
              signal?.addEventListener(
                "abort",
                () => resolve({ kind: "complete", output: "late" }),
                { once: true },
              );
            }),
        ),
      60,
    ),
  );
  try {
    await host.seed("user-123", [
      message("first", Date.now()),
      message("second", Date.now()),
    ]);
    await host.wake("user-123");
    const log = await host.read("user-123");
    expect(calls).toEqual(["first", "second"]);
    expect(log.filter((e) => e.type === "TurnCancelled")).toHaveLength(2);
    expect(log.filter((e) => e.type === "TurnCompleted")).toHaveLength(0);
    expect(await host.resting()).toBe(true);
  } finally {
    await host.close();
  }
}, 3_000);
