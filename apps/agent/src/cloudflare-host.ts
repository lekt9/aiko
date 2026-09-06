import { Effect, Layer } from "effect";
import { KeyValueStore } from "effect/unstable/persistence";
import {
  EventLog,
  eventLogFrom,
  type ThreadEventRow,
  type ThreadEventStore,
} from "tardie/core/log";
import type { Event } from "tardie/core/log/event";
import { Router } from "tardie/core/communication/router";
import {
  isActorEnvelope,
  linkedEventOf,
  type ActorEnvelope,
} from "tardie/core/communication/envelope";
import {
  formatThreadAddress,
  parseThreadAddress,
  isThreadAddress,
  type ThreadAddress,
} from "tardie/core/communication/endpoint";
import {
  Self,
  EffectInterruptions,
  effectInterruptionRegistry,
  createActorReconciler,
  restingActor,
  type Actor,
} from "tardie/core/runtime";
import {
  threadCreated,
  threadCreatedOf,
  threadCreatedForDelivery,
  threadKeys,
} from "tardie/core/thread";
import {
  alarmFired,
  earliestDeadlineOf,
  methodIngressKeyOf,
  type ActorMethods,
} from "tardie/core/method";
import { createThreadDriver } from "tardie/host/driver";
import type { HostPorts } from "tardie/host/host";
import { createHash } from "node:crypto";

/** Structural API permits the same physical adapter to be tested against SQLite without a Worker emulator. */
export interface AccountStorage {
  sql: {
    exec<
      T extends Record<string, string | number | null | ArrayBuffer> = Record<
        string,
        string | number | null | ArrayBuffer
      >,
    >(
      query: string,
      ...bindings: (string | number | null | ArrayBuffer)[]
    ): { toArray(): T[] };
  };
  transactionSync<T>(operation: () => T): T;
  sync(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface CloudflareAccountHostOptions<R> {
  storage: AccountStorage;
  actorName: string;
  actorInstance: string;
  ownsThread(thread: string): boolean;
  /** Only authenticated internal deliveries with a durable parent claim may create these children. */
  allowChild?(parent: string, child: string): boolean;
  actorFor(thread: string): Actor<R> | undefined;
  layersFor(
    thread: string,
  ): Layer.Layer<
    Exclude<R, HostPorts | KeyValueStore.KeyValueStore>,
    never,
    HostPorts | KeyValueStore.KeyValueStore
  >;
  keyOf?(event: Event): string | undefined;
  recoveryDelayMs?: number;
  /** Host-owned durable capability deadline, composed with native method deadlines. */
  nextWake?(): Promise<number | undefined>;
  /** Synchronous application precondition checked inside the append transaction, after all awaits. */
  canAppend?(thread: string, events: readonly Event[], read: () => readonly Event[]): boolean;
}

/** One owner's physical DO host; Tardigrade owns reconciliation, effects, cancellation and scheduling. */
export async function createCloudflareAccountHost<R>(
  options: CloudflareAccountHostOptions<R>,
) {
  const { storage } = options;
  const delay = options.recoveryDelayMs ?? 120_000;
  if (!Number.isSafeInteger(delay) || delay < 1)
    throw new Error("Invalid recovery alarm delay");
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS aiko_host_identity (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), actor TEXT NOT NULL, instance TEXT NOT NULL
  )`);
  storage.sql.exec(
    "INSERT OR IGNORE INTO aiko_host_identity VALUES(1,?,?)",
    options.actorName,
    options.actorInstance,
  );
  const identity = storage.sql
    .exec<{ actor: string; instance: string }>(
      "SELECT actor,instance FROM aiko_host_identity WHERE singleton=1",
    )
    .toArray()[0];
  if (
    identity.actor !== options.actorName ||
    identity.instance !== options.actorInstance
  )
    throw new Error("Actor identity does not match its durable account host");
  storage.sql.exec(`CREATE TABLE IF NOT EXISTS aiko_thread_events (
    thread TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT, event TEXT NOT NULL,
    PRIMARY KEY(thread,seq), UNIQUE(thread,key)
  ) WITHOUT ROWID`);
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS aiko_history_import(singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, digest TEXT NOT NULL)",
  );
  storage.sql.exec(
    "CREATE TABLE IF NOT EXISTS aiko_workspace(thread TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(thread,key)) WITHOUT ROWID",
  );
  storage.sql.exec("CREATE TABLE IF NOT EXISTS aiko_child_threads(thread TEXT PRIMARY KEY,parent TEXT NOT NULL,root TEXT NOT NULL)");
  await storage.sync();
  let revision = 0;
  let closed = false;
  const runtimes = new Map<
    string,
    {
      actor: Actor<R>;
      reconciler: ReturnType<typeof createActorReconciler<R>>;
      interruptions: ReturnType<typeof effectInterruptionRegistry>;
      settled: boolean;
    }
  >();
  function rootThread(thread: string): string | undefined {
    if (options.ownsThread(thread)) return thread;
    const root = storage.sql.exec<{root:string}>("SELECT root FROM aiko_child_threads WHERE thread=?",thread).toArray()[0]?.root;
    return root && options.ownsThread(root) ? root : undefined;
  }
  function checkThread(thread: string) {
    if (closed) throw new Error("Account host is closed");
    if (!rootThread(thread))
      throw new Error("Thread is outside its account host");
  }
  const addressOf = (thread: string): ThreadAddress => {
    checkThread(thread);
    return {
      actor: options.actorName,
      instance: options.actorInstance,
      thread,
    };
  };
  function checkAddress(address: ThreadAddress) {
    checkThread(address.thread);
    if (
      address.actor !== options.actorName ||
      address.instance !== options.actorInstance
    )
      throw new Error("Delivery is outside its actor instance");
  }
  const readPageSync = (
    thread: string,
    after: number,
    limit: number,
  ): ThreadEventRow[] => {
    checkThread(thread);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0
    )
      throw new Error("Invalid event page");
    return storage.sql
      .exec<{ seq: number; event: string }>(
        "SELECT seq,event FROM aiko_thread_events WHERE thread=? AND seq>? ORDER BY seq LIMIT ?",
        thread,
        after,
        limit,
      )
      .toArray()
      .map((row) => ({ seq: row.seq, event: JSON.parse(row.event) as Event }));
  };
  const readSync = (thread: string): Event[] =>
    readPageSync(thread, 0, Number.MAX_SAFE_INTEGER).map((row) => row.event);
  const headSync = (thread: string): number => {
    checkThread(thread);
    return storage.sql
      .exec<{ head: number }>(
        "SELECT COALESCE(MAX(seq),0) AS head FROM aiko_thread_events WHERE thread=?",
        thread,
      )
      .toArray()[0].head;
  };
  const threadsSync = (): string[] =>
    storage.sql
      .exec<{ thread: string }>(
        "SELECT DISTINCT thread FROM aiko_thread_events ORDER BY thread",
      )
      .toArray()
      .map((row) => {
        checkThread(row.thread);
        return row.thread;
      });
  const keyOf = (thread: string, event: Event) =>
    methodIngressKeyOf(event) ??
    threadKeys.keyOf(event) ??
    options.keyOf?.(event) ??
    options.actorFor(thread)?.keyOf?.(event);
  const arm = async () => {
    const at = Date.now() + delay;
    const current = await storage.getAlarm();
    if (current === null || current > at) await storage.setAlarm(at);
  };
  function appendSync(thread: string, events: readonly Event[], guarded = false, inTransaction = false) {
    const operation = () => {
      let head = headSync(thread);
      if (guarded && options.canAppend && !options.canAppend(thread, events, () => readSync(thread))) return { appended: 0, head };
      let appended = 0;
      for (const event of events) {
        const key = keyOf(thread, event) ?? null;
        if (
          key !== null &&
          storage.sql
            .exec(
              "SELECT 1 FROM aiko_thread_events WHERE thread=? AND key=?",
              thread,
              key,
            )
            .toArray().length
        )
          continue;
        storage.sql.exec(
          "INSERT INTO aiko_thread_events(thread,seq,key,event) VALUES(?,?,?,?)",
          thread,
          ++head,
          key,
          JSON.stringify(event),
        );
        appended++;
      }
      if (appended) {
        revision++;
        runtimes.get(thread)?.interruptions.interrupt(events);
      }
      return { appended, head };
    };
    return inTransaction ? operation() : storage.transactionSync(operation);
  }
  async function append(
    thread: string,
    events: readonly Event[] | (() => readonly Event[]),
    mark = true,
    guarded = false,
  ) {
    checkThread(thread);
    // Recovery coverage is persisted before any executable event, including events from effects.
    if (mark && (typeof events === "function" || events.length)) await arm();
    // Resolve thread creation after the last await: concurrent first deliveries cannot validate stale lineage.
    const result = appendSync(
      thread,
      typeof events === "function" ? events() : events,
      guarded,
    );
    if (mark && result.appended) driver.mark(thread);
    await storage.sync();
    return result;
  }
  const storeFor = (thread: string): ThreadEventStore => ({
    append: (events) => Effect.promise(() => append(thread, events, true, true)),
    read: Effect.sync(() => readSync(thread)),
    head: Effect.sync(() => headSync(thread)),
    readFrom: (after) =>
      Effect.sync(() =>
        readPageSync(thread, after, Number.MAX_SAFE_INTEGER).map(
          (row) => row.event,
        ),
      ),
    readPage: (after, limit) =>
      Effect.sync(() => readPageSync(thread, after, limit)),
  });
  const workspaceFor = (thread: string) => {
    const get = (key: string) =>
      Effect.sync(
        () =>
          storage.sql
            .exec<{ value: string }>(
              "SELECT value FROM aiko_workspace WHERE thread=? AND key=?",
              thread,
              key,
            )
            .toArray()[0]?.value,
      );
    const set = (key: string, value: string) =>
      Effect.promise(async () => {
        storage.sql.exec(
          "INSERT INTO aiko_workspace VALUES(?,?,?) ON CONFLICT(thread,key) DO UPDATE SET value=excluded.value",
          thread,
          key,
          value,
        );
        await storage.sync();
      });
    return KeyValueStore.make({
      get,
      getUint8Array: (key) =>
        get(key).pipe(
          Effect.map((value) =>
            value === undefined
              ? undefined
              : new Uint8Array(Buffer.from(value, "base64")),
          ),
        ),
      set: (key, value) =>
        set(
          key,
          typeof value === "string"
            ? value
            : Buffer.from(value).toString("base64"),
        ),
      remove: (key) =>
        Effect.sync(() => {
          storage.sql.exec(
            "DELETE FROM aiko_workspace WHERE thread=? AND key=?",
            thread,
            key,
          );
        }),
      clear: Effect.sync(() => {
        storage.sql.exec("DELETE FROM aiko_workspace WHERE thread=?", thread);
      }),
      size: Effect.sync(
        () =>
          storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM aiko_workspace WHERE thread=?",
              thread,
            )
            .toArray()[0].count,
      ),
      modify: (key, f) =>
        Effect.sync(() =>
          storage.transactionSync(() => {
            const current = storage.sql
              .exec<{ value: string }>(
                "SELECT value FROM aiko_workspace WHERE thread=? AND key=?",
                thread,
                key,
              )
              .toArray()[0]?.value;
            if (current === undefined) return undefined;
            const next = f(current);
            storage.sql.exec(
              "UPDATE aiko_workspace SET value=? WHERE thread=? AND key=?",
              next,
              thread,
              key,
            );
            return next;
          }),
        ),
    });
  };
  async function commit(envelope: ActorEnvelope) {
    if (!isThreadAddress(envelope.link.source))
      throw new Error("Actor delivery requires a thread source");
    checkAddress(envelope.link.source);
    const { target, source } = envelope.link;
    if (target.actor !== options.actorName || target.instance !== options.actorInstance)
      throw new Error("Delivery is outside its actor instance");
    const landed =
      envelope.event.type === "MessageReceived" || envelope.call !== undefined
        ? linkedEventOf({
            link: envelope.link,
            event: envelope.event,
            ...(envelope.call ? { call: envelope.call } : {}),
          })
        : envelope.event;
    await arm();
    const result = storage.transactionSync(() => {
      if (!rootThread(target.thread)) {
        const parent = threadCreatedOf(readSync(source.thread));
        const claim = readSync(source.thread).find(e => e.type === "ChildCreated" &&
          (e.address as ThreadAddress)?.thread === target.thread &&
          (e.address as ThreadAddress)?.actor === target.actor &&
          (e.address as ThreadAddress)?.instance === target.instance &&
          e.depth === envelope.lineage?.depth && e.callId === envelope.event.id);
        if (!options.allowChild?.(source.thread,target.thread) || !parent || !claim || !envelope.lineage ||
            envelope.lineage.depth !== parent.depth+1 || envelope.lineage.placement === "independent")
          throw new Error("Child lacks an owned durable parent claim");
        storage.sql.exec("INSERT INTO aiko_child_threads(thread,parent,root) VALUES(?,?,?)",target.thread,source.thread,rootThread(source.thread)!);
      }
      checkAddress(target);
      if (!keyOf(target.thread,envelope.event) && envelope.event.type !== "MessageReceived")
        throw new Error("Cross-thread events require a durable occurrence key");
      const first = readPageSync(target.thread, 0, 1).map((row) => row.event);
      const creation = threadCreatedForDelivery(
        first,
        target,
        envelope.lineage,
        source,
      );
      if (envelope.lineage) {
        const parent = threadCreatedOf(
          readPageSync(source.thread, 0, 1).map((row) => row.event),
        );
        if (
          !parent ||
          envelope.lineage.depth !== parent.depth + 1 ||
          envelope.lineage.placement === "independent"
        )
          throw new Error("Child lineage does not match its colocated parent");
      }
      const at = envelope.event.at;
      if (!creation && (typeof at !== "number" || !Number.isFinite(at)))
        throw new Error("First event requires a finite timestamp");
      const rows = creation
        ? [landed]
        : [threadCreated(target, envelope.lineage, at as number), landed];
      return appendSync(target.thread,rows,false,true);
    });
    if (result.appended) driver.mark(target.thread);
    await storage.sync();
  }
  const router = Layer.succeed(Router, {
    send: (envelope) =>
      isActorEnvelope(envelope)
        ? Effect.promise(() => commit(envelope))
        : Effect.die(
            new Error("No provider route is mounted on this account host"),
          ),
  });
  const sliceStop = Object.freeze({ slice: true as const });
  let sliceBudget = Infinity;
  let sliceThread: string | undefined;
  const driver = createThreadDriver({
    policy: { maxConcurrentThreads: 3 },
    pick: (dirty) => {
      const pool = [...dirty];
      if (!Number.isFinite(sliceBudget))
        return pool.find((thread) => thread.startsWith("user-")) ?? pool[0]!;
      const next =
        (sliceThread !== undefined &&
        pool.includes(sliceThread) &&
        threadNeedsWork(sliceThread)
          ? sliceThread
          : undefined) ??
        pool.find((thread) => threadNeedsWork(thread) && thread.startsWith("user-")) ??
        pool.find((thread) => threadNeedsWork(thread)) ??
        // A settled runtime with a freshly appended event can report resting before it
        // reconciles; refusing to pick it here strands ingress behind a +1ms alarm loop.
        // Serving a genuinely resting actor is a cheap no-op that clears its dirty flag.
        pool.find((thread) => thread.startsWith("user-")) ??
        pool[0]!;
      if (sliceThread === undefined) sliceThread = next;
      if (next !== sliceThread) throw sliceStop;
      return next;
    },
    serve: async (thread) => {
      checkThread(thread);
      const actor = options.actorFor(thread);
      if (!actor) return;
      let runtime = runtimes.get(thread);
      if (!runtime || runtime.actor !== actor) {
        runtime = {
          actor,
          reconciler: createActorReconciler(actor),
          interruptions: effectInterruptionRegistry(),
          settled: false,
        };
        runtimes.set(thread, runtime);
      }
      const ports = Layer.mergeAll(
        Layer.succeed(EventLog, eventLogFrom(storeFor(thread))),
        Layer.succeed(Self, addressOf(thread)),
        Layer.succeed(EffectInterruptions, runtime.interruptions),
        router,
        Layer.succeed(KeyValueStore.KeyValueStore, workspaceFor(thread)),
      );
      const layer = options
        .layersFor(thread)
        .pipe(Layer.provideMerge(ports)) as Layer.Layer<R | EventLog>;
      await Effect.runPromise(
        runtime.reconciler.settle.pipe(Effect.provide(layer)),
      );
      runtime.settled = true;
    },
  });
  const deadlineFor = (thread: string) => {
    const actor = options.actorFor(thread);
    return earliestDeadlineOf(
      readSync(thread),
      actor && "methods" in actor ? (actor.methods as ActorMethods) : undefined,
    );
  };
  const threadNeedsWork = (thread: string) => {
    const actor = options.actorFor(thread);
    if (!actor) return false;
    const runtime = runtimes.get(thread);
    return runtime?.settled && runtime.actor === actor
      ? !runtime.reconciler.isResting()
      : !restingActor(actor, readSync(thread));
  };
  const resting = async () => !threadsSync().some(threadNeedsWork);
  async function synchronizeAlarm() {
    const observed = revision;
    const idle = await resting();
    const deadlines = threadsSync()
      .map(deadlineFor)
      .filter((n): n is number => n !== undefined);
    const external = await options.nextWake?.();
    if (external !== undefined) {
      if (!Number.isSafeInteger(external) || external < 0)
        throw new Error("Invalid external deadline");
      deadlines.push(external);
    }
    const next = deadlines.length ? Math.min(...deadlines) : undefined;
    if (revision !== observed || !idle) return arm();
    if (next !== undefined)
      await storage.setAlarm(Math.max(Date.now() + 1, next));
    else await storage.deleteAlarm();
    // An ingress during the awaited alarm operation must retain recovery coverage.
    if (revision !== observed) await arm();
  }
  let tail = Promise.resolve();
  function drive(budget = Infinity) {
    const next = tail.then(async () => {
      sliceBudget = budget;
      sliceThread = undefined;
      try {
        await driver.drain();
      } catch (error) {
        if (error !== sliceStop) throw error;
      }
      if (Number.isFinite(budget) && driver.work() > 0)
        await storage.setAlarm(Date.now() + 1);
      else await synchronizeAlarm();
    });
    tail = next.catch(() => undefined);
    return next;
  }
  return {
    rootThread,
    read: async (thread: string) => readSync(thread),
    readPage: async (thread: string, after: number, limit: number) =>
      readPageSync(thread, after, limit),
    threads: async () => threadsSync(),
    self: (thread: string) => formatThreadAddress(addressOf(thread)),
    commit,
    commitRoot: async (address: string, event: Event) => {
      const target = parseThreadAddress(address);
      checkAddress(target);
      await append(target.thread, () => {
        const first = readPageSync(target.thread, 0, 1).map((row) => row.event);
        const creation = threadCreatedForDelivery(first, target, undefined);
        if (
          !creation &&
          (typeof event.at !== "number" || !Number.isFinite(event.at))
        )
          throw new Error("First event requires a finite timestamp");
        return creation
          ? [event]
          : [threadCreated(target, undefined, event.at as number), event];
      });
    },
    /** Complete-history import and host controls only; this deliberately does not wake an actor. */
    seed: async (thread: string, events: readonly Event[]) => {
      checkThread(thread);
      const existing = readPageSync(thread, 0, 1).map((row) => row.event);
      const imported = threadCreatedOf(events);
      threadCreatedForDelivery(
        imported ? [imported] : existing,
        addressOf(thread),
        undefined,
      );
      const firstAt = events[0]?.at;
      const batch =
        existing.length || imported || !events.length
          ? events
          : [
              threadCreated(
                addressOf(thread),
                undefined,
                typeof firstAt === "number" ? firstAt : Date.now(),
              ),
              ...events,
            ];
      await append(thread, batch, false);
    },
    /** Fresh-target migration is one SQL transaction across every thread, and never arms execution. */
    exportHistory: () =>
      threadsSync().map((thread) => ({ thread, events: readSync(thread) })),
    importHistory: async (
      id: string,
      histories: readonly { thread: string; events: readonly Event[] }[],
      sidecar?: { fingerprint: string; import: () => void },
    ) => {
      const digest = createHash("sha256")
        .update(JSON.stringify([histories, sidecar?.fingerprint ?? null]))
        .digest("hex");
      const prior = storage.sql
        .exec<{ id: string; digest: string }>(
          "SELECT id,digest FROM aiko_history_import WHERE singleton=1",
        )
        .toArray()[0];
      if (prior) {
        if (prior.id !== id || prior.digest !== digest)
          throw new Error("History import conflict");
        return "duplicate" as const;
      }
      if (threadsSync().length)
        throw new Error("History import requires a fresh account");
      if (!histories.length)
        throw new Error("History import requires at least one thread");
      if (
        new Set(histories.map((history) => history.thread)).size !==
        histories.length
      )
        throw new Error("Duplicate imported thread");
      for (const history of histories) {
        checkThread(history.thread);
        const created = threadCreatedOf(history.events);
        if (!created)
          throw new Error("Imported history requires ThreadCreated first");
        threadCreatedForDelivery(
          [created],
          addressOf(history.thread),
          undefined,
        );
        if (created.parent) {
          checkAddress(created.parent);
          const parent = histories.find(
            (h) => h.thread === created.parent!.thread,
          );
          const parentCreated = parent && threadCreatedOf(parent.events);
          if (
            !parentCreated ||
            created.depth !== parentCreated.depth + 1 ||
            created.placement === "independent"
          )
            throw new Error("Invalid imported lineage");
        } else if (created.depth !== 0)
          throw new Error("Invalid imported root depth");
        const actor = options.actorFor(history.thread);
        if (actor && !restingActor(actor, history.events))
          throw new Error("Import requires complete, settled histories");
        const keys = history.events
          .map((e) => keyOf(history.thread, e))
          .filter((key) => key !== undefined);
        if (new Set(keys).size !== keys.length)
          throw new Error("Duplicate imported occurrence key");
      }
      storage.transactionSync(() => {
        for (const history of histories)
          appendSync(history.thread, history.events);
        sidecar?.import();
        storage.sql.exec(
          "INSERT INTO aiko_history_import VALUES(1,?,?)",
          id,
          digest,
        );
      });
      await storage.sync();
      return "imported" as const;
    },
    wake: async (thread: string) => {
      checkThread(thread);
      await arm();
      driver.mark(thread);
      await drive();
    },
    drive,
    recover: async () => {
      for (const thread of threadsSync()) driver.mark(thread);
      if (driver.work()) await arm();
      await drive();
    },
    alarm: async () => {
      await arm();
      for (const thread of threadsSync()) {
        const deadline = deadlineFor(thread);
        if (deadline !== undefined && deadline <= Date.now())
          await append(thread, [
            alarmFired({ scheduledFor: deadline, at: Date.now() }),
          ]);
        else if (threadNeedsWork(thread)) driver.mark(thread);
      }
      // One settlement per alarm so a long native drive cannot pin the isolate
      // and starve Telegram webhook RPCs. Remaining unrested threads re-arm immediately.
      await drive(1);
    },
    resting,
    work: driver.work,
    close: async () => {
      await tail;
      closed = true;
    },
  };
}

export type CloudflareAccountHost = Awaited<
  ReturnType<typeof createCloudflareAccountHost>
>;
