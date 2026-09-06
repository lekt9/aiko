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
  automationComponent,
  automationTools,
  automationEventKey,
  automationNextWake,
  automationState,
  automationView,
  automationWakeEvent,
  automationHookForwarder,
  automationAppendAllowed,
} from "../src/automations.ts";
import { backgroundThread } from "../src/account-binding.ts";
import { redactor } from "../src/security.ts";

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
async function fixture(owner = "123", boundOwner = owner, durable = storage()) {
  const thread = `user-${owner}`;
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [
      automationComponent(boundOwner),
      infer([
        tool(automationTools(boundOwner, redactor(["private-fixture-secret"]))),
        outputValidateOnce,
      ]),
    ],
  });
  const model = Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "automation-test" },
    }),
    react: (request) => {
      const message = request.trajectory.find(
        (e) => e.type === "MessageReceived" && e.id === request.identity.turn,
      )!;
      const called = request.trajectory.some(
        (e) =>
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
    storage: durable,
    actorName: "aiko",
    actorInstance: "test",
    ownsThread: (t) => t === thread || t === backgroundThread(owner, "indexer"),
    actorFor: (t) =>
      t === thread
        ? definition
        : actor({
            name: "aiko",
            methods: {},
            components: [automationHookForwarder(boundOwner)],
          }),
    layersFor: () => model,
    keyOf: automationEventKey,
    nextWake: async () => automationNextWake(await host.read(thread)),
    canAppend: (_thread, events, read) => automationAppendAllowed(events, read),
  });
  const emit = async (e: any) => {
    await host.commitRoot(host.self(thread), e);
    await host.drive();
  };
  return {
    host,
    durable,
    thread,
    emit,
    emitHook: async (e: any) => {
      await host.commitRoot(host.self(backgroundThread(owner, "indexer")), {
        automationSignal: true,
        ...e,
      });
      await host.drive();
    },
    read: () => host.read(thread),
    call: async (name: string, args: object, id = crypto.randomUUID()) => {
      await emit({
        type: "MessageReceived",
        id,
        source: "plane",
        at: Date.now(),
        text: JSON.stringify({ tool: name, args }),
      });
      return (await host.read(thread)).findLast(
        (e) => e.type === "ToolReturned" && e.turn === id,
      )?.result as any;
    },
  };
}

test("native tools self-wire a one-shot; durable wake, execution and restart are exactly-once", async () => {
  let f = await fixture();
  const at = Date.now() + 3600000;
  expect(
    (
      await f.call("automation_set", {
        name: "reminder",
        kind: "schedule",
        instruction: "Summarize current findings",
        at: new Date(at).toISOString(),
      })
    ).status,
  ).toBe("recorded");
  expect(await f.durable.getAlarm()).toBe(at);
  expect(automationView(await f.read()).rules).toHaveLength(1);
  await f.emit({ type: "AikoAutomationTick", id: "early", at: at - 1 });
  expect(
    (await f.read()).filter((e) => e.type === "AikoAutomationFired"),
  ).toHaveLength(0);
  await f.host.close();
  f = await fixture("123", "123", f.durable);
  await f.host.recover();
  await f.emit({ type: "AikoAutomationTick", id: "due", at });
  await f.host.alarm();
  await f.host.recover();
  const log = await f.read();
  expect(log.filter((e) => e.type === "AikoAutomationFired")).toHaveLength(1);
  const input = log.find(
    (e) => e.type === "MessageReceived" && e.source === "automation",
  )!;
  expect(input.channel).toBeUndefined();
  expect(
    log.some((e) => e.type === "TurnCompleted" && e.turn === input.id),
  ).toBe(true);
  expect(automationNextWake(log)).toBeUndefined();
  expect(await f.durable.getAlarm()).toBeNull();
  const archive = f.host.exportHistory();
  const restored = await fixture();
  expect(await restored.host.importHistory("automation-archive", archive)).toBe(
    "imported",
  );
  expect(restored.host.exportHistory()).toEqual(archive);
  await restored.host.recover();
  expect(
    (await restored.read()).filter((e) => e.type === "AikoAutomationFired"),
  ).toHaveLength(1);
  await restored.host.close();
  await f.host.close();
});

test("legacy indexer hooks remain resting instead of acquiring new forwarding effects", async () => {
  const f = await fixture();
  await f.emitHook({
    type: "AikoHookReceived",
    id: "legacy",
    at: Date.now(),
    automationSignal: undefined,
  });
  expect((await f.read()).some((e) => e.type === "AikoAutomationSignal")).toBe(
    false,
  );
  expect(
    (await f.host.read(backgroundThread(f.thread.slice(5), "indexer"))).some(
      (e) => e.type === "AikoAutomationSignalForwarded",
    ),
  ).toBe(false);
  await f.host.close();
});

test("strict provider nullable optional fields can self-wire both rule kinds", async () => {
  const f = await fixture();
  expect(
    (
      await f.call("automation_set", {
        name: "nullable_schedule",
        kind: "schedule",
        instruction: "Test reminder",
        at: new Date(Date.now() + 3600000).toISOString(),
        everySeconds: null,
        eventType: null,
        cooldownSeconds: null,
      })
    ).status,
  ).toBe("recorded");
  expect(
    (
      await f.call("automation_set", {
        name: "nullable_listener",
        kind: "listener",
        instruction: "Test listener",
        at: null,
        everySeconds: null,
        eventType: "AikoHookReceived",
        cooldownSeconds: null,
      })
    ).status,
  ).toBe("recorded");
  await f.host.close();
});

test("live gateway string null sentinel is accepted only for inapplicable string fields", async () => {
  const f = await fixture();
  expect(
    (
      await f.call("automation_set", {
        name: "gateway_schedule",
        kind: "schedule",
        instruction: "Test",
        at: new Date(Date.now() + 3600000).toISOString(),
        eventType: "null",
        everySeconds: null,
        cooldownSeconds: null,
      })
    ).status,
  ).toBe("recorded");
  expect(
    (
      await f.call("automation_set", {
        name: "gateway_listener",
        kind: "listener",
        instruction: "Test",
        at: "null",
        eventType: "AikoHookReceived",
        everySeconds: null,
        cooldownSeconds: 60,
      })
    ).status,
  ).toBe("recorded");
  expect(
    (
      await f.call("automation_set", {
        name: "bad_listener",
        kind: "listener",
        instruction: "Test",
        at: "null",
        eventType: "null",
      })
    ).status,
  ).toBe("rejected");
  expect(
    (
      await f.call("automation_set", {
        name: "bad_schedule",
        kind: "schedule",
        instruction: "Test",
        at: "null",
        eventType: "null",
      })
    ).status,
  ).toBe("rejected");
  await f.host.close();
});

test("interval coalesces missed ticks, listener cooldown prevents cascades, pause/resume/remove persist", async () => {
  const f = await fixture(),
    at = Date.now() + 3600000;
  await f.call("automation_set", {
    name: "periodic",
    kind: "schedule",
    instruction: "Review",
    at: new Date(at).toISOString(),
    everySeconds: 60,
  });
  await f.emit({ type: "AikoAutomationTick", id: "late", at: at + 600000 });
  expect(
    (await f.read()).filter((e) => e.type === "AikoAutomationFired"),
  ).toHaveLength(1);
  expect(automationNextWake(await f.read())).toBe(at + 660000);
  await f.call("automation_change", { name: "periodic", action: "pause" });
  await f.emit({ type: "AikoAutomationTick", id: "paused", at: at + 720000 });
  expect(automationNextWake(await f.read())).toBeUndefined();
  await f.call("automation_change", { name: "periodic", action: "resume" });
  await f.emit({ type: "AikoAutomationTick", id: "resumed", at: at + 720000 });
  expect(
    (await f.read()).filter((e) => e.type === "AikoAutomationFired"),
  ).toHaveLength(2);
  await f.call("automation_change", { name: "periodic", action: "remove" });
  await f.call("automation_set", {
    name: "learned",
    kind: "listener",
    eventType: "AikoHookReceived",
    cooldownSeconds: 60,
    instruction: "Review new evidence",
  });
  for (let i = 0; i < 5; i++)
    await f.emitHook({ type: "AikoHookReceived", id: `hook${i}`, at: at + i });
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoAutomationFired" && e.name === "learned",
    ),
  ).toHaveLength(1);
  await f.emitHook({ type: "AikoHookReceived", id: "later", at: at + 60001 });
  expect(
    (await f.read()).filter(
      (e) => e.type === "AikoAutomationFired" && e.name === "learned",
    ),
  ).toHaveLength(2);
  expect(automationView(await f.read()).rules.map((r) => r.name)).toEqual([
    "learned",
  ]);
  await f.host.close();
});

test("invalid/secret rules and cross-owner tools fail closed", async () => {
  const f = await fixture();
  for (const args of [
    {
      name: "bad",
      kind: "schedule",
      instruction: "test",
      at: "2030-01-01T12:00:00",
    },
    {
      name: "bad",
      kind: "schedule",
      instruction: "test",
      at: "2000-01-01T12:00:00Z",
    },
    {
      name: "bad",
      kind: "listener",
      instruction: "test",
      eventType: "MessageReceived",
    },
    {
      name: "bad",
      kind: "listener",
      instruction: "private-fixture-secret",
      eventType: "AikoHookReceived",
    },
    {
      name: "bad",
      kind: "listener",
      instruction: "test",
      eventType: "AikoHookReceived",
      cooldownSeconds: 0,
    },
    {
      name: "bad",
      kind: "listener",
      instruction: "test",
      eventType: "AikoHookReceived",
      owner: "456",
    },
  ]) {
    const result = await f.call("automation_set", args);
    expect(result?.status).not.toBe("recorded");
    expect(automationView(await f.read()).rules).toHaveLength(0);
  }
  expect(automationView(await f.read()).rules).toHaveLength(0);
  await f.host.close();
  const foreign = await fixture("456", "123");
  expect((await foreign.call("automation_list", {})).reason).toBe(
    "owner_scope",
  );
  await expect(foreign.host.read("user-123")).rejects.toThrow();
  await foreign.host.close();
});

test("pending listener cannot interrupt an active turn; removal cancels undispatched work", () => {
  const log: any[] = [
    {
      type: "AikoAutomationConfigured",
      id: "v1",
      rule: {
        name: "listen",
        kind: "listener",
        instruction: "review",
        eventType: "AikoHookReceived",
        enabled: true,
        cooldownMs: 60000,
      },
    },
    { type: "MessageReceived", id: "active", source: "telegram" },
    { type: "AikoHookReceived", id: "hook", at: 100 },
  ];
  const state = automationState(log);
  expect(state.active.size).toBe(1);
  expect(state.pending.size).toBe(1);
  log.push({
    type: "AikoAutomationChanged",
    id: "paused",
    name: "listen",
    action: "pause",
  });
  expect(automationState(log).pending.size).toBe(0);
});

test("housekeeping wakes emit no tick without a due rule", () => {
  expect(automationWakeEvent([], Date.now())).toBeUndefined();
  const at = Date.now() + 60000;
  const events: any[] = [
    {
      type: "AikoAutomationConfigured",
      id: "v1",
      at: Date.now(),
      rule: {
        name: "once",
        kind: "schedule",
        instruction: "test",
        enabled: true,
        at,
      },
    },
  ];
  expect(automationWakeEvent(events, at - 1)).toBeUndefined();
  expect(automationWakeEvent(events, at)?.type).toBe("AikoAutomationTick");
  events.push({
    type: "AikoAutomationChanged",
    id: "pause",
    name: "once",
    action: "pause",
  });
  expect(automationWakeEvent(events, at + 1)).toBeUndefined();
});

test("dispatch transaction fences a pause or user message arriving during awaited alarm I/O", async () => {
  for (const action of ["pause", "user"] as const) {
    const f = await fixture(),
      at = Date.now() + 60000;
    await f.call("automation_set", {
      name: "race",
      kind: "schedule",
      instruction: "Review",
      at: new Date(at).toISOString(),
    });
    const getAlarm = f.durable.getAlarm;
    let injected = false;
    f.durable.getAlarm = async () => {
      const state = automationState(await f.read());
      if (!injected && state.pending.size && !state.active.size) {
        injected = true;
        await f.host.commitRoot(
          f.host.self(f.thread),
          action === "pause"
            ? {
                type: "AikoAutomationChanged",
                id: "concurrent-pause",
                at,
                name: "race",
                action: "pause",
              }
            : {
                type: "MessageReceived",
                id: "concurrent-user",
                source: "plane",
                at,
                text: JSON.stringify({ tool: "automation_list", args: {} }),
              },
        );
      }
      return getAlarm();
    };
    await f.emit({ type: "AikoAutomationTick", id: "due-race", at });
    const log = await f.read();
    expect(injected).toBe(true);
    if (action === "pause")
      expect(log.filter((e) => e.type === "AikoAutomationFired")).toHaveLength(
        0,
      );
    else {
      const completed = log.findIndex(
        (e) => e.type === "TurnCompleted" && e.turn === "concurrent-user",
      );
      const fired = log.findIndex((e) => e.type === "AikoAutomationFired");
      expect(completed).toBeGreaterThan(-1);
      expect(fired).toBeGreaterThan(completed);
    }
    await f.host.close();
  }
});

test("external hook signals queue behind automation work, without replaying pre-registration history", () => {
  const log: any[] = [
    {
      type: "AikoAutomationConfigured",
      id: "v1",
      at: 100,
      rule: {
        name: "hook",
        kind: "listener",
        eventType: "AikoHookReceived",
        instruction: "Review",
        enabled: true,
        cooldownMs: 60000,
      },
    },
  ];
  log.push({
    type: "AikoAutomationSignal",
    id: "old",
    eventType: "AikoHookReceived",
    at: 99,
  });
  expect(automationState(log).pending.size).toBe(0);
  log.push({
    type: "MessageReceived",
    id: "automation:busy",
    source: "automation",
  });
  log.push({
    type: "AikoAutomationSignal",
    id: "new",
    eventType: "AikoHookReceived",
    at: 101,
  });
  expect(automationState(log).pending.size).toBe(1);
  log.push({ type: "TurnCompleted", turn: "automation:busy" });
  expect(automationState(log).active.size).toBe(0);
  expect(automationState(log).pending.size).toBe(1);
});
