import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { component } from "tardie/core/component";
import { intent } from "tardie/core/intent";
import type { Event } from "tardie/core/event";
import { createBunHost } from "tardie/bun/host";
import { createAikoActor } from "../src/actor.ts";
import { createVoice } from "../src/voice.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import {
  hostedRegistryNextWake,
  hostedChannelDeadlineKey,
} from "../src/registry-host.ts";
import { mediaProcessingEventKey } from "../src/media-processing.ts";

const owner = "123",
  thread = "user-123";
const wait = (id: string, deadline: number, account = owner): Event[] => [
  {
    type: "AikoMediaAccepted",
    owner: account,
    id,
    at: 1,
    channel: "api",
    contentRef: "fixture-opaque",
  },
  {
    type: "AikoMediaAcquisitionWaiting",
    owner: account,
    id,
    at: 2,
    deadline,
    observed: id,
    witnessIds: [],
    evaluationId: id,
    acquisitionId: id,
  },
];
const terminal = (id: string, type: "Completed" | "Cancelled"): Event => ({
  type: `AikoMedia${type}`,
  owner,
  id,
  at: 3,
});

// Only the media work is isolated. Production createAikoActor supplies the method
// and deadline component; native hosts supply persistence and alarm cancellation.
// No inference, acquisition, media-quality or provider execution is attested.
async function fixture(worker: boolean) {
  const dir = await mkdtemp("/tmp/registry-deadlines-");
  let db: Database | undefined,
    alarm: { at: number; fire: (at: number) => Promise<void> } | undefined;
  let host: any,
    inference = 0;
  const mediaComponent = component({
    name: "fixture.media-wait",
    initial: () => [] as Event[],
    keys: { prefixes: ["aiko-media:"], keyOf: mediaProcessingEventKey },
    step: (rows, e) => [...rows, e],
    output: (rows) => ({
      view: undefined,
      transitions: rows
        .filter(
          (e) =>
            e.type === "AikoMediaAcquisitionWaiting" &&
            e.owner === owner &&
            !rows.some(
              (r) =>
                ["AikoMediaCompleted", "AikoMediaCancelled"].includes(r.type) &&
                r.owner === owner &&
                r.id === e.id,
            ) &&
            rows.some(
              (r) =>
                r.type === "AlarmFired" && Number(r.at) >= Number(e.deadline),
            ),
        )
        .map((e) =>
          intent({
            key: mediaProcessingEventKey(terminal(String(e.id), "Completed"))!,
            input: String(e.id),
            events: (id) => [terminal(id, "Completed")],
          }),
        ),
    }),
  });
  const definition = createAikoActor({
    owner,
    live: true,
    background: false,
    voice: createVoice({ enabled: false, persona: "Deadline fixture" }),
    memory: {
      owner,
      thread,
      stateDir: dir,
      redact: (text) => text,
      readPage: async () => [],
    },
    // A deliberate fixture component, not a configured media execution binding.
    media: { component: mediaComponent, tools: [] } as unknown as NonNullable<
      Parameters<typeof createAikoActor>[0]["media"]
    >,
  });
  expect(definition.methods.channelWait).toBeDefined();
  const layers = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "unused" } }),
    react: () => {
      inference++;
      return Effect.die(Error("Deadline scheduling must not invoke Infer"));
    },
  });
  let storage: AccountStorage | undefined;
  const open = async () => {
    if (!worker)
      return createBunHost({
        database: join(dir, "native.sqlite"),
        actorName: "aiko",
        actorInstance: "deadline-fixture",
        actorFor: () => definition,
        layersFor: () => layers,
        alarm: {
          schedule: (at, fire) => {
            const next = { at, fire };
            alarm = next;
            return {
              cancel: () => {
                if (alarm === next) alarm = undefined;
              },
            };
          },
        },
      });
    db = new Database(join(dir, "native.sqlite"));
    db.exec(
      "CREATE TABLE IF NOT EXISTS fixture_alarm(id INTEGER PRIMARY KEY, at INTEGER)",
    );
    storage = {
      sql: {
        exec: (q, ...args) => {
          const rows = db!.query(q).all(...(args as any));
          return { toArray: () => rows as never };
        },
      },
      transactionSync: (fn) => db!.transaction(fn)(),
      sync: async () => {},
      getAlarm: async () =>
        (db!.query("SELECT at FROM fixture_alarm WHERE id=1").get() as any)
          ?.at ?? null,
      setAlarm: async (at) => {
        db!
          .query("INSERT OR REPLACE INTO fixture_alarm VALUES(1,?)")
          .run(Number(at));
      },
      deleteAlarm: async () => {
        db!.query("DELETE FROM fixture_alarm").run();
      },
    };
    return createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "deadline-fixture",
      ownsThread: (t) => t === thread,
      actorFor: () => definition,
      layersFor: () => layers,
      keyOf: (e) => mediaProcessingEventKey(e) ?? hostedChannelDeadlineKey(e),
      nextWake: async () =>
        hostedRegistryNextWake(await host.read(thread), owner),
    });
  };
  host = await open();
  await host.commitRoot(host.self(thread), { type: "FixtureOpened", at: 1 });
  return {
    seed: async (events: Event[]) => {
      await host.seed(thread, events);
      await host.wake(thread);
    },
    rows: () => host.read(thread) as Promise<readonly Event[]>,
    next: async () =>
      worker ? await storage!.getAlarm() : (alarm?.at ?? null),
    restart: async () => {
      await host.close();
      db?.close();
      host = await open();
      await host.wake(thread);
    },
    fire: async () => {
      if (worker) await host.alarm();
      else {
        const current = alarm!;
        alarm = undefined;
        await current.fire(Date.now());
      }
    },
    close: async () => {
      await host.close();
      db?.close();
      await rm(dir, { recursive: true, force: true });
      expect(inference).toBe(0);
    },
  };
}
for (const worker of [false, true]) {
  test(`registry media-only ${worker ? "Worker" : "Bun"} native method and alarm survive SQLite restart`, async () => {
    const f = await fixture(worker);
    try {
      const deadline = Date.now() + 500;
      await f.seed([
        ...wait("foreign", deadline - 100, "456"),
        ...wait("cancelled", deadline - 80),
        terminal("cancelled", "Cancelled"),
        ...wait("complete", deadline - 60),
        terminal("complete", "Completed"),
        ...wait("owned", deadline),
      ]);
      expect(hostedRegistryNextWake(await f.rows(), owner)).toBe(deadline);
      expect(await f.next()).toBe(deadline);
      expect(
        (await f.rows()).filter((e) => e.type === "AikoHostedChannelDeadline"),
      ).toMatchObject([{ owner, id: `${owner}:${deadline}` }]);
      await f.restart();
      expect(await f.next()).toBe(deadline);
      await Bun.sleep(Math.max(1, deadline - Date.now() + 5));
      await f.fire();
      expect(
        (await f.rows()).filter((e) => e.type === "AlarmFired"),
      ).toHaveLength(1);
      expect(
        (await f.rows()).some(
          (e) => e.type === "AikoMediaCompleted" && e.id === "owned",
        ),
      ).toBe(true);
      expect(hostedRegistryNextWake(await f.rows(), owner)).toBeUndefined();
      expect(await f.next()).toBeNull();
      await f.restart();
      expect(await f.next()).toBeNull();
      expect(
        (await f.rows()).filter((e) => e.type === "AlarmFired"),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
  for (const disposition of ["Cancelled", "Completed"] as const)
    test(`registry media-only ${worker ? "Worker" : "Bun"} retracts ${disposition} earliest method while a later waiter remains`, async () => {
      const f = await fixture(worker);
      try {
        const early = Date.now() + 20000,
          late = early + 10000;
        await f.seed([...wait("early", early), ...wait("late", late)]);
        expect(await f.next()).toBe(early);
        await f.seed([terminal("early", disposition)]);
        expect(hostedRegistryNextWake(await f.rows(), owner)).toBe(late);
        const beforeRestart = await f.next();
        await f.restart();
        const afterRestart = await f.next();
        await f.seed([terminal("late", "Completed")]);
        expect(await f.next()).toBeNull();
        await f.restart();
        expect(await f.next()).toBeNull();
        expect((await f.rows()).some((e) => e.type === "AlarmFired")).toBe(
          false,
        );
        expect({ beforeRestart, afterRestart }).toEqual({
          beforeRestart: late,
          afterRestart: late,
        });
      } finally {
        await f.close();
      }
    });
}
