import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor } from "tardie";
import { Self } from "tardie/core/runtime";
import { EventLog, withWatermark } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import {
  channelAppendAllowed,
  channelBindings,
  channelEventKey,
  channelFact,
  type ChannelBinding,
} from "../src/channel-bindings.ts";
import { createChannelRuntime, type ChannelRuntimePorts } from "../src/channel-runtime.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(overrides: Partial<ChannelRuntimePorts> = {}) {
  const db = new Database(":memory:");
  let alarm: number | null = null;
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
  const calls: { operation: string; input: any; key: string; binding: ChannelBinding }[] = [],
    handled: string[] = [];
  const ports: ChannelRuntimePorts = {
    artifactAllowed: async () => true,
    authorize: async (owner, auth) => owner === "alice" && auth === "grant",
    authenticate: async (_b, request) =>
      request.headers.get("signature") === "valid"
        ? {
            principal: "fixture:source",
            occurrence: request.headers.get("occurrence") ?? "one",
            conversation: "conversation",
            partition: "default",
            ancestry: [],
            evidence: "verified-signature",
          }
        : undefined,
    execute: async (binding, operation, input, key) => {
      calls.push({ binding, operation, input, key });
      if (operation === "decode")
        return { kind: "external", schemaVersion: "1", text: String((input as any).body) };
      if (operation === "send")
        return { status: "accepted_by_provider", evidence: "receipt:202", providerId: "sent-1" };
      if ((input as any).kind === "subscription")
        return { status: operation === "renew" ? "renewed" : "ready", evidence: "subscription-receipt" };
      if (operation === "remove") return { status: "removed", evidence: "subscription-removed" };
      if (operation === "reconcile")
        return { status: "delivered", evidence: "receipt:delivered", providerId: "sent-1" };
      return { status: "ready", evidence: "subscription" };
    },
    validateReceipt: async () => true,
    handle: async (_b, _o, _c, key) => {
      handled.push(key);
      return { receipt: `harness:${key}` };
    },
    now: () => 100,
    ...overrides,
  };
  const runtime = createChannelRuntime("alice", ports);
  const definition = actor({ name: "aiko", methods: {}, components: [runtime.component] });
  const thread = "user-alice";
  const open = () =>
    createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "test",
      ownsThread: (t) => t === thread,
      actorFor: () => definition,
      layersFor: () => Layer.empty,
      keyOf: channelEventKey,
      canAppend: (_t, events, read) => channelAppendAllowed(events, read),
    });
  let host = await open();
  await host.commitRoot(host.self(thread), { type: "FixtureStarted", id: "start", at: 0 });
  const read = () => host.read(thread);
  // Actual native EventLog port, retaining the production synchronous commit fence.
  const log = withWatermark({
    read: Effect.promise(read),
    append: (events) =>
      Effect.promise(async () => {
        // The host seed API is privileged and intentionally bypasses admission checks. Ingress
        // uses a serialized commit boundary; exercise that boundary explicitly for API calls.
        if (!channelAppendAllowed(events, awaitableRead)) throw new Error("channel_commit_conflict");
        await host.seed(thread, events);
        await host.commitRoot(host.self(thread), { type: "FixtureWake", id: crypto.randomUUID(), at: 100 });
      }),
  });
  let snapshot: readonly Event[] = [];
  const awaitableRead = () => snapshot;
  const run = async <T>(work: Effect.Effect<T, never, EventLog | Self>, foreign = false) => {
    snapshot = await read();
    return Effect.runPromise(
      work.pipe(
        Effect.provideService(EventLog, log),
        Effect.provideService(Self, {
          actor: "aiko",
          instance: "test",
          thread: foreign ? "user-bob" : thread,
        }),
      ),
    );
  };
  const bindingInput = (extra: Partial<Omit<ChannelBinding, "id" | "owner" | "status">> = {}) => ({
    name: "fixture",
    generation: 1,
    artifact: {
      digest: "artifact-v1",
      contractDigest: "checked-v1",
      directions: ["inbox", "outbox"] as ("inbox" | "outbox")[],
      operations: ["decode", "send", "reconcile", "poll"] as ChannelBinding["artifact"]["operations"],
    },
    account: "fixture-account",
    source: "fixture:source",
    destination: "fixture:destination",
    route: thread,
    credentialRefs: ["credential:fixture"],
    authorization: "grant",
    backlog: 10,
    maxBytes: 4096,
    maxHops: 4,
    retentionMs: 10000,
    queuedWork: "cancel" as const,
    ...extra,
  });
  const configure = async (extra: Parameters<typeof bindingInput>[0] = {}) => {
    const id = await run(runtime.configure(bindingInput(extra)));
    await host.drive();
    return id;
  };
  const ingress = (id: string, occurrence = "one", body = "hello", generation = 1, signature = "valid") =>
    run(
      runtime.ingest(
        id,
        generation,
        new Request("https://fixture.test/channel", {
          method: "POST",
          headers: { signature, occurrence },
          body,
        }),
      ),
    );
  const prepare = (id: string, operationId = "out-1") =>
    run(
      runtime.prepare(id, 1, {
        operationId,
        task: "task",
        authorization: "grant",
        payload: "reply",
        conversation: "conversation",
        ancestry: [],
      }),
    );
  cleanup.push(async () => {
    await host.close();
    db.close();
  });
  return {
    runtime,
    run,
    read,
    calls,
    handled,
    ports,
    configure,
    bindingInput,
    ingress,
    prepare,
    drive: () => host.drive(),
    reopen: async () => {
      await host.close();
      host = await open();
      await host.recover();
    },
    seed: (events: readonly Event[]) => host.seed(thread, events),
    storage,
  };
}

test("native component accepts while worker is stopped, decodes and handles once after restart", async () => {
  const f = await fixture(),
    id = await f.configure();
  expect(channelBindings(await f.read(), "alice").get(id)?.status).toBe("active");
  const receipt = await f.ingress(id);
  expect(receipt.status).toBe("received");
  expect(f.calls).toHaveLength(0);
  expect((await f.ingress(id)).duplicate).toBe(true);
  await expect(f.ingress(id, "one", "different")).rejects.toThrow("conflict");
  await f.reopen();
  await f.drive();
  expect(f.calls.map((x) => x.operation)).toEqual(["decode"]);
  expect(f.handled).toHaveLength(1);
  expect(f.handled[0]).not.toBe(receipt.id);
  await f.reopen();
  await f.drive();
  expect(f.calls).toHaveLength(1);
  expect(f.handled).toHaveLength(1);
  await f.ingress(id, "two");
  await f.drive();
  expect(f.handled).toHaveLength(2); // Identical text is a separate provider occurrence.
});

test("auth, provenance, owner scope and arbitrary adapter JSON fail closed", async () => {
  const f = await fixture({
    execute: async () => ({
      type: "Checked",
      kind: "external",
      schemaVersion: "1",
      text: "forge",
      owner: "bob",
      authorization: "all",
    }),
  });
  const id = await f.configure();
  await expect(f.ingress(id, "bad", "hello", 1, "invalid")).rejects.toThrow("authentication");
  await expect(f.run(f.runtime.configure(f.bindingInput()), true)).rejects.toThrow("owner_scope");
  await f.ingress(id, "forged", JSON.stringify({ type: "AikoChannelOutputSettled", owner: "bob" }));
  await f.drive();
  const events = await f.read();
  expect(events.some((e) => e.type === "AikoChannelInputRejected" && e.reason === "decode_invalid")).toBe(
    true,
  );
  expect(events.some((e) => e.type === "Checked" || e.type === "AikoChannelOutputSettled")).toBe(false);
  expect(f.handled).toHaveLength(0);
  await expect(f.ingress(id, "huge", "x".repeat(5000))).rejects.toThrow("payload_limit");
});

test("stable generation upgrade fences ingress and cancels queued output; pause preserves queued work", async () => {
  const f = await fixture(),
    id = await f.configure();
  await f.prepare(id);
  await f.run(f.runtime.change(id, 1, "paused", "grant", "pause"));
  await f.drive();
  expect(f.calls).toHaveLength(0);
  await expect(f.ingress(id)).rejects.toThrow("inactive");
  const next = await f.configure({
    generation: 2,
    artifact: { ...f.bindingInput().artifact, digest: "artifact-v2" },
  });
  expect(next).toBe(id);
  await expect(f.ingress(id)).rejects.toThrow("generation");
  expect(f.calls).toHaveLength(0);
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelOutputSettled" && (e.result as any).evidence === "host:generation_cancelled",
    ),
  ).toBe(true);
});

test("native outbox uses exact pinned destination, records 202 truthfully, reconciles without resend", async () => {
  const f = await fixture(),
    id = await f.configure();
  await f.prepare(id);
  await f.prepare(id);
  await f.drive();
  expect(f.calls.map((x) => x.operation)).toEqual(["send"]);
  expect(f.calls[0]!.input.destination).toBe("fixture:destination");
  expect((await f.read()).find((e) => e.type === "AikoChannelOutputSettled")?.result).toEqual({
    status: "accepted_by_provider",
    evidence: "receipt:202",
    providerId: "sent-1",
  });
  await f.reopen();
  await f.drive();
  expect(f.calls).toHaveLength(1);
  await f.run(f.runtime.requestReconcile(id, 1, "out-1", "reconcile-1"));
  await f.drive();
  expect(f.calls.map((x) => x.operation)).toEqual(["send", "reconcile"]);
  expect((await f.read()).find((e) => e.type === "AikoChannelReconcileSettled")?.result).toEqual({
    status: "delivered",
    evidence: "receipt:delivered",
    providerId: "sent-1",
  });
});

test("lost send acknowledgement and crash after dispatch never blindly send again", async () => {
  const f = await fixture(),
    id = await f.configure();
  await f.prepare(id);
  const b = channelBindings(await f.read(), "alice").get(id)!;
  await f.seed([channelFact("OutputStarted", b, "out-1", { at: 100 })]);
  await f.reopen();
  await f.drive();
  expect(f.calls).toHaveLength(0);
  expect((await f.read()).find((e) => e.type === "AikoChannelOutputSettled")?.result).toEqual({
    status: "unknown",
  });
  await f.run(f.runtime.requestReconcile(id, 1, "out-1", "check"));
  await f.drive();
  expect(f.calls.map((x) => x.operation)).toEqual(["reconcile"]);
});

test("poll commits schema outcomes before cursor and resumes from durable partition cursor", async () => {
  const cursors: unknown[] = [];
  const f = await fixture({
    execute: async (_b, operation, input) => {
      if (operation !== "poll") throw new Error("unexpected");
      cursors.push((input as any).cursor);
      return {
        cursor: "next",
        items: [
          {
            context: {
              principal: "fixture:source",
              occurrence: "p1",
              conversation: "conversation",
              partition: "default",
              ancestry: [],
              evidence: "poll-read",
            },
            observation: { kind: "external", schemaVersion: "1", text: "polled" },
          },
          {
            context: {
              principal: "fixture:source",
              occurrence: "p2",
              conversation: "conversation",
              partition: "default",
              ancestry: [],
              evidence: "poll-read",
            },
            observation: { type: "Checked" },
          },
        ],
      };
    },
  });
  const id = await f.configure();
  await f.run(f.runtime.requestPoll(id, 1, "default", "poll-1"));
  await f.drive();
  const events = await f.read(),
    advanced = events.findIndex((e) => e.type === "AikoChannelCursorAdvanced");
  expect(advanced).toBeGreaterThan(events.findIndex((e) => e.type === "AikoChannelInputAccepted"));
  expect(advanced).toBeGreaterThan(events.findIndex((e) => e.type === "AikoChannelInputRejected"));
  expect(f.handled).toHaveLength(1);
  await f.reopen();
  await f.run(f.runtime.requestPoll(id, 1, "default", "poll-2"));
  await f.drive();
  expect(cursors).toEqual([null, "next"]);
  expect(f.handled).toHaveLength(1);
});

test("backpressure does not acknowledge excess input and inbox-only binding cannot send", async () => {
  const f = await fixture(),
    id = await f.configure({ backlog: 1 });
  await f.ingress(id);
  await expect(f.ingress(id, "two")).rejects.toThrow("commit_conflict");
  await f.drive();
  expect((await f.ingress(id, "two")).status).toBe("received");
  const inbox = await f.configure({
    name: "inbox",
    destination: undefined,
    artifact: { digest: "inbox", contractDigest: "checked", directions: ["inbox"], operations: ["decode"] },
  });
  await expect(f.prepare(inbox)).rejects.toThrow("no_send_permission");
});

test("subscription creation/removal are native receipts and replay does not register again", async () => {
  const f = await fixture(),
    id = await f.configure({
      artifact: { ...f.bindingInput().artifact, operations: ["decode", "send", "subscribe", "remove"] },
    });
  expect(f.calls.map((x) => x.operation)).toEqual(["subscribe"]);
  await f.reopen();
  await f.drive();
  expect(f.calls).toHaveLength(1);
  await f.run(f.runtime.change(id, 1, "retiring", "grant", "retire"));
  await f.drive();
  expect(f.calls.map((x) => x.operation)).toEqual(["subscribe", "remove"]);
  expect(channelBindings(await f.read(), "alice").get(id)?.status).toBe("retired");
  await expect(f.ingress(id)).rejects.toThrow("inactive");
});

test("native send rechecks authorization and lifecycle after awaited authorization I/O", async () => {
  const f = await fixture(),
    id = await f.configure();
  await f.prepare(id);
  let injected = false;
  f.ports.authorize = async () => {
    if (!injected) {
      injected = true;
      const b = channelBindings(await f.read(), "alice").get(id)!;
      await f.seed([
        channelFact("Lifecycle", b, "pause-during-send", { status: "paused", at: 100 }),
        channelFact("Lifecycle", b, "resume-during-send", { status: "active", at: 100 }),
      ]);
    }
    return true;
  };
  // A rejected durable start aborts this drive; recovery can re-evaluate the resumed binding.
  await expect(f.drive()).rejects.toThrow("channel_commit_conflict");
  expect(injected).toBe(true);
  expect(f.calls.filter((c) => c.operation === "send")).toHaveLength(0);
});

test("retiring cancels durable unhandled inbox and upgrade preserves decoding provenance", async () => {
  const f = await fixture(),
    id = await f.configure();
  await f.ingress(id);
  await f.run(f.runtime.change(id, 1, "retiring", "grant", "retire"));
  await f.drive();
  expect(f.handled).toHaveLength(0);
  expect(
    (await f.read()).some(
      (e) => e.type === "AikoChannelInputRejected" && e.reason === "generation_cancelled",
    ),
  ).toBe(true);
  await f.configure({ generation: 2, artifact: { ...f.bindingInput().artifact, digest: "v2" } });
  await f.ingress(id, "two", "new", 2);
  await f.drive();
  expect(f.calls.find((c) => c.operation === "decode")?.binding.artifact.digest).toBe("v2");
});

test("adapter claims require independently verified provider evidence", async () => {
  const f = await fixture({ validateReceipt: async () => false }),
    id = await f.configure();
  await f.prepare(id);
  await f.drive();
  expect((await f.read()).find((e) => e.type === "AikoChannelOutputSettled")?.result).toEqual({
    status: "unknown",
  });
  await f.reopen();
  expect(f.calls.filter((c) => c.operation === "send")).toHaveLength(1);
});

test("provider timeout becomes durable unknown; repeated operation never resends", async () => {
  const f = await fixture(),
    id = await f.configure();
  let sends = 0;
  f.ports.execute = async () => {
    sends++;
    throw new Error("lost acknowledgement");
  };
  await f.prepare(id);
  await f.drive();
  expect(sends).toBe(1);
  await f.reopen();
  await f.prepare(id);
  await f.drive();
  expect(sends).toBe(1);
  expect((await f.read()).find((e) => e.type === "AikoChannelOutputSettled")?.result).toEqual({
    status: "unknown",
  });
});

test("subscription crash recovers by explicit reconciliation, never duplicate registration", async () => {
  const f = await fixture();
  const id = await f.run(
    f.runtime.configure(
      f.bindingInput({
        artifact: {
          ...f.bindingInput().artifact,
          operations: ["decode", "send", "subscribe", "remove", "reconcile", "renew"],
        },
      }),
    ),
  );
  const b = channelBindings(await f.read(), "alice").get(id)!;
  await f.seed([channelFact("SubscriptionStarted", b, "subscribe:1", { operation: "subscribe", at: 100 })]);
  await f.reopen();
  expect(f.calls).toHaveLength(0);
  expect(channelBindings(await f.read(), "alice").get(id)?.status).toBe("pending");
  await f.run(f.runtime.requestSubscription(id, 1, "reconcile", "sub-check", "grant"));
  await f.drive();
  expect(f.calls.map((c) => c.operation)).toEqual(["reconcile"]);
  expect(channelBindings(await f.read(), "alice").get(id)?.status).toBe("active");
  await f.run(f.runtime.requestSubscription(id, 1, "renew", "renew-1", "grant"));
  await f.drive();
  await f.reopen();
  expect(f.calls.map((c) => c.operation)).toEqual(["reconcile", "renew"]);
});

test("same operation ID on two bindings has distinct provider idempotency keys", async () => {
  const f = await fixture(),
    first = await f.configure(),
    second = await f.configure({ name: "second" });
  await f.prepare(first);
  await f.prepare(second);
  await f.drive();
  const sends = f.calls.filter((c) => c.operation === "send");
  expect(sends).toHaveLength(2);
  expect(sends[0]!.key).not.toBe(sends[1]!.key);
});

test("poll occurrence conflicts leave the durable cursor unchanged", async () => {
  let content = "one";
  const f = await fixture({
    execute: async () => ({
      cursor: content,
      items: [
        {
          context: {
            principal: "fixture:source",
            occurrence: "same",
            conversation: "conversation",
            partition: "default",
            ancestry: [],
            evidence: "read",
          },
          observation: { kind: "external", schemaVersion: "1", text: content },
        },
      ],
    }),
  });
  const id = await f.configure();
  await f.run(f.runtime.requestPoll(id, 1, "default", "p1"));
  await f.drive();
  content = "conflicting";
  await f.run(f.runtime.requestPoll(id, 1, "default", "p2"));
  await f.drive();
  expect((await f.read()).filter((e) => e.type === "AikoChannelCursorAdvanced")).toHaveLength(1);
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelPollSettled" && e.status === "occurrence_conflict"),
  ).toBe(true);
});

test("causal provider echoes are suppressed while ordinary identical replies and hop limits are respected", async () => {
  const f = await fixture(),
    id = await f.configure();
  await f.prepare(id);
  await f.drive();
  const auth = f.ports.authenticate;
  f.ports.authenticate = async (...args) => ({
    ...(await auth(...args))!,
    occurrence: "sent-1",
    ancestry: ["out-1"],
  });
  await f.ingress(id);
  await f.drive();
  expect(f.handled).toHaveLength(0);
  expect((await f.read()).some((e) => e.type === "AikoChannelInputRejected" && e.reason === "echo")).toBe(
    true,
  );
  f.ports.authenticate = async (...args) => ({ ...(await auth(...args))!, ancestry: ["a", "b", "c", "d"] });
  await expect(f.ingress(id, "hops")).rejects.toThrow("authentication");
  f.ports.authenticate = auth;
  await f.ingress(id, "reply", "reply");
  await f.drive();
  expect(f.handled).toHaveLength(1);
});

test("poll backpressure rejects the whole batch and cursor; durable source can be fetched again", async () => {
  const f = await fixture(),
    id = await f.configure({ backlog: 1 });
  await f.ingress(id, "retained");
  f.ports.execute = async (_b, operation) =>
    operation === "decode"
      ? { type: "invalid" }
      : {
          cursor: "next",
          items: [
            {
              context: {
                principal: "fixture:source",
                occurrence: "polled",
                conversation: "conversation",
                partition: "default",
                ancestry: [],
                evidence: "poll",
              },
              observation: { kind: "external", schemaVersion: "1", text: "hello" },
            },
          ],
        };
  await f.run(f.runtime.requestPoll(id, 1, "default", "poll-bounded"));
  // Directly evaluate the same synchronous production guard with a live backlog:
  // actual runtime execution above/below also uses it for every effect transaction.
  const b = channelBindings(await f.read(), "alice").get(id)!,
    before = await f.read();
  const batch = [
    channelFact("Received", b, "extra", { fence: true, expectedStatus: "active" }),
    channelFact("CursorAdvanced", b, "cursor", {
      fence: true,
      previous: null,
      cursor: "bad",
      partition: "default",
    }),
  ];
  expect(channelAppendAllowed(batch, () => before)).toBe(false);
  await f.drive(); // rejection of the retained invalid input frees capacity before polling.
  expect((await f.read()).find((e) => e.type === "AikoChannelCursorAdvanced")?.cursor).toBe("next");
});

test("lifecycle retries are idempotent and malformed binding permissions never activate", async () => {
  const f = await fixture(),
    id = await f.configure();
  await f.run(f.runtime.change(id, 1, "paused", "grant", "pause-once"));
  await f.run(f.runtime.change(id, 1, "paused", "grant", "pause-once"));
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelLifecycle" && e.id === "pause-once"),
  ).toHaveLength(1);
  await expect(
    f.configure({
      name: "orphan",
      artifact: { ...f.bindingInput().artifact, operations: ["decode", "send", "subscribe"] },
    }),
  ).rejects.toThrow("invalid_channel_binding");
  await expect(f.configure({ name: "foreign-route", route: "user-bob" })).rejects.toThrow(
    "invalid_channel_binding",
  );
});
