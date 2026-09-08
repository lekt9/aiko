import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor } from "tardie";
import { EventLog, withWatermark } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import {
  browserWatchWebhookActions,
  browserWatchWebhookPermitAppendAllowed,
  type BrowserWatchWebhookDestination,
} from "../src/browser-watch-webhook-actions.ts";
import {
  browserWatchEventKey,
  type BrowserWatchConfig,
  type BrowserWatchDispatch,
} from "../src/browser-watches.ts";
import {
  BROWSER_EVENT_SCHEMA,
  browserEventKey,
  type BrowserObservedEvent,
} from "../src/browser-events.ts";
import {
  channelAppendAllowed,
  channelBindings,
  channelDigest,
  channelEventKey,
} from "../src/channel-bindings.ts";
import {
  channelSeal,
  channelSealEvent,
  channelOpenEvent,
} from "../src/channel-custody.ts";
import {
  createChannelRuntime,
  channelOperationKey,
  type ChannelDelivery,
} from "../src/channel-runtime.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => AbortSignal.timeout(5000);
export async function webhookActionFixture() {
  const owner = "webhook-owner",
    thread = `user-${owner}`,
    db = new Database(":memory:"),
    blobs = harnessBlobStore(sqliteWorkflowKV(db));
  let alarm: number | null = null,
    at = Date.now(),
    enabled = true,
    paused = false,
    sends = 0,
    reconciles = 0,
    lateRevoke = false,
    lostAdmission = false;
  let permitHook: ((...args: Parameters<ReturnType<typeof browserWatchWebhookActions>["permit"]>) => Promise<void>) | undefined;
  let beforePermitCommit: (() => void) | undefined, losePermitAck = false, commitCapability = true;
  let beforePermitAppend: (() => Promise<void>) | undefined;
  let delivery: ChannelDelivery = {
    status: "accepted_by_provider",
    evidence: "fixture-accepted",
    providerId: "fixture-1",
  };
  const storage: AccountStorage = {
    sql: {
      exec: (q, ...args) => {
        const rows = db.query(q).all(...(args as any[]));
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    sync: async () => {},
    getAlarm: async () => alarm,
    setAlarm: async (value) => {
      alarm = value;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const read = () => host.read(thread);
  const append = async (events: Event[]) => {
    const previous = await read();
    if (!channelAppendAllowed(events, () => previous))
      throw Error("native_channel_guard");
    const sealed = await Promise.all(events.map(e => channelSealEvent(blobs, owner, e)));
    if (events.some(e => e.type === "AikoBrowserWatchWebhookPermitted")) await host.appendControl(thread, sealed);
    else await host.seed(thread, sealed);
    if (losePermitAck && events.some(e => e.type === "AikoBrowserWatchWebhookPermitted")) { losePermitAck = false; throw Error("lost_permit_ack"); }
    await host.commitRoot(host.self(thread), {
      type: "FixtureWake",
      id: crypto.randomUUID(),
      at,
    });
    if (
      lostAdmission &&
      events.some((e) => e.type === "AikoChannelOutputPrepared")
    ) {
      lostAdmission = false;
      throw Error("lost_prepare_ack");
    }
  };
  let adapter: ReturnType<typeof browserWatchWebhookActions>;
  const runtime = createChannelRuntime(owner, {
    journal: { read, append },
    openEvent: (e) => channelOpenEvent(blobs, owner, e),
    now: () => at,
    artifactAllowed: async () => true,
    authorize: async (account, authority) =>
      account === owner && authority === "send-fixture",
    authenticate: async () => undefined,
    validateReceipt: async (_b, _op, result) =>
      (result as any)?.evidence?.startsWith("fixture-") === true,
    handle: async () => ({ receipt: "fixture-unused" }),
    execute: async (channel, operation, input, key, s) => {
      if (operation !== "send" && operation !== "reconcile")
        return { status: "ready", evidence: "fixture-ready" };
      const admitted = await adapter.authorizeDispatch(
        channel,
        operation,
        input,
        key,
        s,
      );
      if (admitted !== true) throw Error("watch_not_authorized");
      if (permitHook) await permitHook(channel, operation, input, key, undefined as never, s);
      // The transport can await DNS. Authority must be checked again afterward.
      if (lateRevoke) {
        lateRevoke = false;
        enabled = false;
      }
      await Promise.resolve();
      if (
        (await adapter.authorizeDispatch(channel, operation, input, key, s)) !==
        true
      )
        throw Error("watch_revoked_at_socket_boundary");
      if (operation === "reconcile") {
        reconciles++;
        return {
          status: "delivered",
          evidence: "fixture-delivered",
          providerId: "fixture-1",
        };
      }
      sends++;
      if (delivery.status === "unknown")
        throw Error("fixture-lost-provider-response");
      return delivery;
    },
  });
  const definition = actor({
    name: "aiko",
    methods: {},
    components: [runtime.component],
  });
  const open = () =>
    createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "watch-fixture",
      ownsThread: (t) => t === thread,
      actorFor: () => definition,
      layersFor: () => Layer.empty,
      keyOf: (e) =>
        channelEventKey(e) ?? browserWatchEventKey(e) ?? browserEventKey(e),
      canAppend: (_t, events, read) => {
        if (events.some(e => e.type === "AikoBrowserWatchWebhookPermitted")) { beforePermitCommit?.(); beforePermitCommit = undefined; }
        return channelAppendAllowed(events, read) && browserWatchWebhookPermitAppendAllowed(events, read) &&
          (!events.some(e => e.type === "AikoBrowserWatchWebhookPermitted") || adapter.admissionAllowed(events, read));
      },
    });
  host = await open();
  await host.commitRoot(host.self(thread), {
    type: "FixtureStarted",
    id: "root",
    at,
  });
  const log = withWatermark({
    read: Effect.promise(read),
    append: (events) => Effect.promise(() => append([...events])),
  });
  const run = <T>(work: Effect.Effect<T, never, EventLog | Self>) =>
    Effect.runPromise(
      work.pipe(
        Effect.provideService(EventLog, log),
        Effect.provideService(Self, {
          actor: "aiko",
          instance: "watch-fixture",
          thread,
        }),
      ),
    );
  const channelId = await run(
    runtime.configure({
      name: "saved-hook",
      generation: 1,
      artifact: {
        digest: "fixture-adapter",
        contractDigest: "fixture-contract",
        directions: ["outbox"],
        operations: ["send", "reconcile"],
      },
      account: "fixture-account",
      source: "fixture-source",
      destination: "saved-destination",
      route: thread,
      credentialRefs: [],
      authorization: "send-fixture",
      backlog: 8,
      maxBytes: 32768,
      maxHops: 4,
      retentionMs: 3600000,
      queuedWork: "cancel",
    }),
  );
  await host.drive();
  let destination: BrowserWatchWebhookDestination = {
    channel: channelId,
    generation: 1,
    authorization: "send-fixture",
    conversation: "fixture-conversation",
    deadlineAt: at + 3_600_000,
  };
  const current = async (
    _intent: BrowserWatchDispatch,
    _s: AbortSignal,
    op: "execute" | "reconcile",
  ) => enabled && (!paused || op === "reconcile");
  const make = () =>
    browserWatchWebhookActions({
      owner,
      journal: {
        blobs,
        read,
        transact: async (fn, before) => {
          await before?.();
          const next = fn(await read());
          if (next.events.some(e => e.type === "AikoBrowserWatchWebhookPermitted")) await beforePermitAppend?.();
          await append(next.events);
          return next.result;
        },
      },
      runtime,
      run,
      current,
      ...(commitCapability ? { commitCurrent: (_intent: BrowserWatchDispatch, operation: "execute" | "reconcile") => enabled && (!paused || operation === "reconcile") } : {}),
      resolve: async (id) =>
        id === "saved-hook" ? structuredClone(destination) : undefined,
      now: () => at,
    });
  adapter = make();
  const event: BrowserObservedEvent = {
    type: "AikoBrowserPushObserved",
    schema: BROWSER_EVENT_SCHEMA,
    owner,
    id: "event-1",
    producer: "fixture-producer",
    epoch: "epoch-1",
    profile: "fixture-profile",
    generation: 1,
    connectionId: "fixture-site",
    connectionRevision: "r1",
    sequence: 1,
    occurrence: "event-1",
    kind: "push",
    observedAt: at,
    at,
    sourceId: "fixture-cdp",
    fields: { origin: "https://fixture.test", outcome: "received" },
    commitment: await channelSeal(blobs, owner, { sequence: 1 }),
    payloadRef: await channelSeal(blobs, owner, {
      body: "private-body-must-not-egress",
    }),
  };
  const config: BrowserWatchConfig = {
    id: "watch-hook",
    label: "Fixture hook",
    connectionId: event.connectionId,
    connectionRevision: event.connectionRevision,
    sourceGeneration: 1,
    origin: event.fields.origin,
    kind: "push",
    outcome: "received",
    action: { kind: "webhook", destination: "saved-hook" },
    expiresAt: at + 3_600_000,
    backlog: 8,
    maxOccurrences: 10,
  };
  const intent: BrowserWatchDispatch = {
    operationId: `watch:${config.id}:1:${channelDigest([owner, event.id, config.action])}`,
    watchId: config.id,
    generation: 1,
    event,
    action: config.action,
  };
  await host.seed(thread, [
    event,
    {
      type: "AikoBrowserWatchPrepared",
      owner,
      id: `${config.id}:1`,
      watchId: config.id,
      generation: 1,
      at,
      configRef: await channelSeal(blobs, owner, { config }),
    },
    {
      type: "AikoBrowserWatchStarted",
      owner,
      id: intent.operationId,
      watchId: config.id,
      generation: 1,
      eventId: event.id,
      source: "checked-output",
      at,
    },
  ]);
  cleanup.push(async () => {
    await host.close();
    db.close();
  });
  return {
    get adapter() {
      return adapter;
    },
    intent,
    permitHook: (hook: NonNullable<typeof permitHook>) => { permitHook = hook; },
    beforePermitCommit: (hook: () => void) => { beforePermitCommit = hook; },
    beforePermitAppend: (hook: () => Promise<void>) => { beforePermitAppend = hook; },
    losePermitAck: () => { losePermitAck = true; },
    removeCommitCapability: () => { commitCapability = false; adapter = make(); },
    read,
    run,
    runtime,
    channelId,
    blobs,
    get now() {
      return at;
    },
    counts: () => ({ sends, reconciles }),
    drive: () => host.drive(),
    restart: async () => {
      await host.close();
      host = await open();
      adapter = make();
      await host.recover();
    },
    revoke: () => {
      enabled = false;
    },
    pause: () => {
      paused = true;
    },
    lateRevoke: () => {
      lateRevoke = true;
    },
    loseAdmission: () => {
      lostAdmission = true;
    },
    unknownSend: () => {
      delivery = { status: "unknown" };
    },
    advance: (ms: number) => {
      at += ms;
    },
    destination: (value: Partial<BrowserWatchWebhookDestination>) => {
      destination = { ...destination, ...value };
    },
    request: async (id: string) => {
      await host.seed(thread, [
        {
          type: "AikoBrowserWatchReconcileRequested",
          owner,
          id: `${intent.operationId}:${id}`,
          operationId: intent.operationId,
          requestId: id,
          watchId: intent.watchId,
          generation: intent.generation,
          at,
        },
      ]);
      return { ...intent, reconciliationRequestId: id };
    },
  };
}
const fixture = webhookActionFixture;

test("native webhook admission is pending, sealed and idempotent; provider acceptance remains explicit", async () => {
  const f = await fixture();
  const pending = await f.adapter.execute(f.intent, signal());
  expect(pending).toMatchObject({
    status: "pending",
    receipt: { kind: "channel", id: f.intent.operationId },
  });
  expect(f.counts()).toEqual({ sends: 0, reconciles: 0 });
  const raw = (await f.read()).find(
    (e) => e.type === "AikoChannelOutputPrepared",
  )!;
  expect(raw.input).toBeUndefined();
  expect(raw.privateRef).toBeDefined();
  const opened = await channelOpenEvent(f.blobs, f.intent.event.owner, raw),
    payload = JSON.parse((opened.input as any).payload);
  expect(payload.event.id).toBe(f.intent.event.id);
  expect(JSON.stringify(payload)).not.toContain("private-body");
  expect(JSON.stringify(payload)).not.toContain("payloadRef");
  expect(JSON.stringify(payload)).not.toContain("commitment");
  expect(await f.adapter.execute(f.intent, signal())).toEqual(pending);
  await f.drive();
  expect(f.counts()).toEqual({ sends: 1, reconciles: 0 });
  expect(await f.adapter.reconcile(f.intent, signal())).toMatchObject({
    status: "completed",
    result: { delivery: { status: "accepted_by_provider" } },
  });
  await f.restart();
  expect((await f.adapter.execute(f.intent, signal())).status).toBe(
    "completed",
  );
  expect(f.counts().sends).toBe(1);
});

test("account, checked event, operation and destination drift cannot authorize sends", async () => {
  const f = await fixture();
  for (const intent of [
    { ...f.intent, event: { ...f.intent.event, owner: "other" } },
    {
      ...f.intent,
      event: {
        ...f.intent.event,
        fields: { ...f.intent.event.fields, origin: "https://other.test" },
      },
    },
    { ...f.intent, operationId: "watch:forged" },
  ])
    expect((await f.adapter.execute(intent, signal())).status).not.toBe(
      "pending",
    );
  expect(f.counts().sends).toBe(0);
  expect((await f.adapter.execute(f.intent, signal())).status).toBe("pending");
  f.destination({ conversation: "other-conversation" });
  await f.drive();
  expect(f.counts().sends).toBe(0);
  expect((await f.adapter.reconcile(f.intent, signal())).status).toBe(
    "unknown",
  );
});

test("revocation after awaited transport setup prevents the physical send", async () => {
  const f = await fixture();
  await f.adapter.execute(f.intent, signal());
  f.lateRevoke();
  await f.drive();
  expect(f.counts()).toEqual({ sends: 0, reconciles: 0 });
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelOutputStarted"),
  ).toBe(true);
});

test("unknown send survives restart and only an explicit native receipt request invokes reconciliation", async () => {
  const f = await fixture();
  f.unknownSend();
  await f.adapter.execute(f.intent, signal());
  await f.drive();
  expect(f.counts().sends).toBe(1);
  await f.restart();
  expect((await f.adapter.reconcile(f.intent, signal())).status).toBe(
    "unknown",
  );
  expect((await f.adapter.execute(f.intent, signal())).status).toBe("unknown");
  expect(
    (
      await f.adapter.reconcile(
        { ...f.intent, reconciliationRequestId: "unadmitted" },
        signal(),
      )
    ).status,
  ).toBe("unknown");
  expect(f.counts().reconciles).toBe(0);
  f.pause();
  const request = await f.request("receipt-1"),
    pending = await f.adapter.reconcile(request, signal());
  expect(pending.status).toBe("pending");
  f.advance(1000);
  expect(await f.adapter.reconcile(request, signal())).toEqual(pending);
  await f.restart();
  expect((await f.adapter.reconcile(request, signal())).status).toBe(
    "completed",
  );
  await f.drive();
  expect(await f.adapter.reconcile(request, signal())).toMatchObject({
    status: "completed",
    result: { delivery: { status: "delivered" } },
  });
  expect(f.counts()).toEqual({ sends: 1, reconciles: 1 });
});

test("lost outbox acknowledgement is recovered without another prepare or send", async () => {
  const f = await fixture();
  f.loseAdmission();
  expect((await f.adapter.execute(f.intent, signal())).status).toBe("unknown");
  await f.restart();
  expect((await f.adapter.reconcile(f.intent, signal())).status).toBe(
    "completed",
  );
  await f.drive();
  expect(f.counts().sends).toBe(1);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelOutputPrepared"),
  ).toHaveLength(1);
});

test("the original admission deadline stays fixed and expired queued work cannot send", async () => {
  const f = await fixture();
  const pending = await f.adapter.execute(f.intent, signal());
  f.advance(300001);
  expect((await f.adapter.reconcile(f.intent, signal())).status).toBe(
    "unknown",
  );
  await f.drive();
  expect(f.counts().sends).toBe(0);
  expect(pending).toMatchObject({ status: "pending", deadlineAt: f.now - 1 });
});

test("the final guard rejects changed provider input, operation key, owner and authority", async () => {
  const f = await fixture();
  await f.adapter.execute(f.intent, signal());
  const rows = await f.read(),
    channel = channelBindings(rows, f.intent.event.owner).get(f.channelId)!;
  const prepared = await channelOpenEvent(
    f.blobs,
    f.intent.event.owner,
    rows.find((e) => e.type === "AikoChannelOutputPrepared")!,
  );
  const input = {
      ...(prepared.input as object),
      destination: channel.destination,
    },
    key = channelOperationKey(channel, "send", f.intent.operationId);
  expect(
    await f.adapter.authorizeDispatch(channel, "send", input, key, signal()),
  ).toBe(true);
  expect(
    await f.adapter.authorizeDispatch(
      channel,
      "send",
      { ...input, artifact: channel.artifact },
      key,
      signal(),
    ),
  ).toBe(true);
  expect(
    await f.adapter.authorizeDispatch(
      channel,
      "send",
      { ...input, artifact: { ...channel.artifact, digest: "changed" } },
      key,
      signal(),
    ),
  ).toBe(false);
  expect(
    await f.adapter.authorizeDispatch(
      { ...channel, owner: "other" },
      "send",
      input,
      key,
      signal(),
    ),
  ).toBe(false);
  expect(
    await f.adapter.authorizeDispatch(
      channel,
      "send",
      { ...input, destination: "other" },
      key,
      signal(),
    ),
  ).toBe(false);
  expect(
    await f.adapter.authorizeDispatch(
      channel,
      "send",
      input,
      "wrong-key",
      signal(),
    ),
  ).toBe(false);
  expect(
    await f.adapter.authorizeDispatch(
      channel,
      "send",
      { operationId: "unrelated", task: "unrelated" },
      "other",
      signal(),
    ),
  ).toBeUndefined();
  f.destination({ authorization: "revoked-grant" });
  expect(
    await f.adapter.authorizeDispatch(channel, "send", input, key, signal()),
  ).toBe(false);
});

test("receipt-check deadlines do not extend when a refreshed grant allows more time", async () => {
  const f = await fixture();
  f.unknownSend();
  await f.adapter.execute(f.intent, signal());
  await f.drive();
  f.destination({ deadlineAt: f.now + 60000 });
  const request = await f.request("short-receipt"),
    pending = await f.adapter.reconcile(request, signal());
  expect(pending).toMatchObject({
    status: "pending",
    deadlineAt: f.now + 60000,
  });
  f.advance(1000);
  f.destination({ deadlineAt: f.now + 60000 });
  expect(await f.adapter.reconcile(request, signal())).toEqual(pending);
  f.advance(60000);
  expect((await f.adapter.reconcile(request, signal())).status).toBe("unknown");
  await f.drive();
  expect(f.counts()).toEqual({ sends: 1, reconciles: 0 });
});
