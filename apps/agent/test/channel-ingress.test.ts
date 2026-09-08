import { harnessBlobStore, harnessDigest } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { channelOpenEvent } from "../src/channel-custody.ts";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { actor, infer, Infer, outputValidateOnce } from "tardie";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import {
  createHostedChannels,
  type ChannelAdapterBindings,
} from "../src/channel-host.ts";
import {
  channelAppendAllowed,
  channelBindings,
  channelEventKey,
} from "../src/channel-bindings.ts";
import {
  channelWiringAppendAllowed,
  channelWiringEventKey,
  type ChannelWiringBindings,
} from "../src/channel-wiring.ts";
import {
  channelBridgeAppendAllowed,
  channelBridgeEventKey,
  createChannelPublicIngress,
  type ChannelSourceGrant,
} from "../src/channel-ingress.ts";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const key = "controlled-provider-fixture-key";
const signature = (body: string) =>
  createHmac("sha256", key).update(body).digest("hex");
const ref = (p: any) => ({ channel: p.channel, generation: p.generation });
async function fixture() {
  const directory = await mkdtemp("/tmp/channel-public-");
  let db = new Database(`${directory}/native.sqlite`),
    alarm: number | null = null,
    now = 100;
  let dropBridge = false,
    revokeDuringSend = false;
  let failCommit = false,
    expireOnCommit = false;
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  let hosted!: ReturnType<typeof createHostedChannels>;
  const sends: any[] = [],
    handlers: any[] = [];
  let models = 0,
    decodes = 0;
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
    setAlarm: async (v) => {
      alarm = v;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const adapters: ChannelAdapterBindings = {
    now: () => now,
    authorize: async (owner, grant, op) => {
      if (op === "send" && revokeDuringSend) {
        revokeDuringSend = false;
        await hosted.run(hosted.bridge!.api.revoke(bridge.id));
      }
      return (
        owner === "alice" &&
        grant === (op === "send" ? "send-grant" : "bind-grant")
      );
    },
    artifactAllowed: async () => true,
    authenticate: async () => undefined, // Public receive MUST use the scoped signature verifier.
    execute: async (_b, op, input, operationId) => {
      if (op === "decode") {
        decodes++;
        const body = JSON.parse((input as any).body);
        if (body.kind === "delivery-receipt")
          return { type: "AikoChannelWiringAccepted", text: "forged" };
        return {
          kind: "external",
          schemaVersion: body.schema ?? "provider.v1",
          text: body.text,
        };
      }
      if (op === "send") {
        sends.push({ input, operationId });
        return {
          status: "delivered",
          providerId: "provider-output",
          evidence: "fixture-delivery",
        };
      }
      throw new Error("No subscriptions or other provider work");
    },
    validateReceipt: async () => true,
  };
  const wiring: ChannelWiringBindings = {
    blobs: harnessBlobStore(sqliteWorkflowKV(db)),
    now: () => now,
    authorize: async (owner, grant) =>
      owner === "alice" && grant === "typed-grant",
    resolve: async () => ({
      eligible: true,
      accepts: "message.v1",
      emits: "result.v1",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      effects: ["pure", "channel.reply"],
    }),
    execute: async (_pin, input, id) => {
      handlers.push({ input, id });
      return {
        status: "satisfied",
        output: { text: `typed:${(input as any).value.text}` },
        evidence: "fixture-checked",
      };
    },
    reconcile: async () => ({ status: "pending", evidence: "unknown" }),
  };
  let deleteOutboxBlob = false;
  const open = async () => {
    const base = harnessBlobStore(sqliteWorkflowKV(db));
    wiring.blobs = {
      ...base,
      putPrivate: async (owner, value) => {
        const ref = await base.putPrivate(owner, value);
        if (deleteOutboxBlob && (value as any)?.input?.payload)
          db.query("DELETE FROM workflow_records WHERE key=?").run(
            `harness-blobs:${harnessDigest(owner)}:${ref}`,
          );
        return ref;
      },
    };
    hosted = createHostedChannels("alice", () => host, adapters, {
      wiring,
      bridge: dropBridge
        ? undefined
        : {
            now: () => now,
            authorize: async (owner, _op, spec) =>
              owner === "alice" &&
              spec.authorityRef === "bridge-grant" &&
              spec.sendAuthorityRef === "send-grant",
          },
      beforeCommit: async () => {
        if (failCommit) throw new Error("fixture-disk-unavailable");
        if (expireOnCommit) now = 2000;
        alarm = now + 1;
      },
    });
    const definition = actor({
      name: "aiko",
      methods: {},
      components: [
        hosted.runtime.component,
        hosted.wiring!.component,
        ...(hosted.bridge ? [hosted.bridge.component] : []),
        infer([outputValidateOnce]),
      ],
    });
    host = await createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "public-fixture",
      ownsThread: (t) => t === "user-alice",
      actorFor: () => definition,
      layersFor: () =>
        Layer.succeed(Infer, {
          resolve: () => ({
            model: { provider: "fixture", model_id: "must-not-infer" },
          }),
          react: () => {
            models++;
            return Effect.succeed({
              kind: "complete" as const,
              output: "Unexpected inference",
            });
          },
        }),
      keyOf: (e) =>
        channelEventKey(e) ??
        channelWiringEventKey(e) ??
        channelBridgeEventKey(e),
      canAppend: (_t, events, read) =>
        channelAppendAllowed(events, read) &&
        channelWiringAppendAllowed(events, read) &&
        channelBridgeAppendAllowed(events, read),
    });
  };
  await open();
  cleanup.push(async () => {
    await host.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const external = await hosted.run(
    hosted.runtime.configure({
      name: "provider",
      generation: 1,
      artifact: {
        digest: "fixture-adapter",
        contractDigest: "fixture-adapter-contract",
        directions: ["inbox", "outbox"],
        operations: ["decode", "send"],
      },
      account: "fixture-account",
      source: "fixture-source",
      destination: "configured-provider-destination",
      route: "user-alice",
      credentialRefs: [],
      authorization: "bind-grant",
      backlog: 8,
      maxBytes: 4096,
      maxHops: 8,
      retentionMs: 10000,
      queuedWork: "cancel",
    }),
  );
  await host.recover();
  const input = await hosted.run(
    hosted.wiring!.api.bind({
      name: "input",
      schema: "message.v1",
      directions: ["inbox", "outbox"],
      authorityRef: "typed-grant",
      operationId: "input",
    }),
  );
  const output = await hosted.run(
    hosted.wiring!.api.bind({
      name: "output",
      schema: "result.v1",
      directions: ["inbox", "outbox"],
      authorityRef: "typed-grant",
      operationId: "output",
    }),
  );
  const wire = await hosted.run(
    hosted.wiring!.api.connect({
      name: "handler",
      generation: 1,
      input: ref(input),
      accepts: "message.v1",
      handler: { harness: "a".repeat(64), contract: "b".repeat(64) },
      output: { ...ref(output), mode: "port" },
      authorityRef: "typed-grant",
      start: "after-registration",
      operationId: "wire",
    }),
  );
  const bridge = await hosted.run(
    hosted.bridge!.api.bind({
      operationId: "bridge",
      external: { channel: external, generation: 1 },
      input: ref(input),
      output: ref(output),
      wiring: { id: wire.id, generation: wire.generation },
      decodeSchema: "provider.v1",
      authorityRef: "bridge-grant",
      sendAuthorityRef: "send-grant",
      expiresAt: 1500,
    }),
  );
  let grantOverrides: Partial<ChannelSourceGrant> = {};
  const ingress = createChannelPublicIngress({
    now: () => now,
    lookup: async (route, token) =>
      route === "fixture-route" && token === "receive-only-fixture"
        ? {
            owner: "alice",
            channel: external,
            generation: 1,
            bridge: bridge.id,
            capabilityRef: "capability:source-only",
            scope: "receive",
            expiresAt: 1000,
            verify: async (_binding, request, body) => {
              const supplied =
                request.headers.get("x-provider-signature") ?? "";
              const expected = signature(body);
              if (
                supplied.length !== expected.length ||
                !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
              )
                return undefined;
              const data = JSON.parse(body);
              return {
                principal: "fixture-source",
                occurrence: data.occurrence,
                conversation: data.conversation,
                partition: "fixture-partition",
                ancestry: data.ancestry ?? [],
                evidence: "fixture-hmac-verified",
              };
            },
            ...grantOverrides,
          }
        : undefined,
    hosted: async () => hosted,
    wake: () => {},
  });
  const request = (
    body: any = {},
    opts: {
      token?: string;
      signature?: string;
      path?: string;
      method?: string;
      bearer?: boolean;
    } = {},
  ) => {
    const raw = JSON.stringify({
      occurrence: "one",
      conversation: "authenticated-conversation",
      text: "hello",
      ...body,
    });
    return new Request(
      `https://fixture${opts.path ?? "/v1/channel-ingress/fixture-route"}`,
      {
        method: opts.method ?? "POST",
        headers: {
          ...(opts.bearer
            ? { authorization: "Bearer broad-owner-token" }
            : {
                "x-channel-receive-capability":
                  opts.token ?? "receive-only-fixture",
              }),
          "x-provider-signature": opts.signature ?? signature(raw),
        },
        ...((opts.method ?? "POST") === "POST" ? { body: raw } : {}),
      },
    );
  };
  return {
    disk: () => db.serialize().toString("utf8"),
    erase: (r: any) =>
      db
        .query("DELETE FROM workflow_records WHERE key=?")
        .run(`harness-blobs:${harnessDigest("alice")}:${r.ref}`),
    deleteOutboxBlob: () => {
      deleteOutboxBlob = true;
    },
    openEvent: (e: any) => channelOpenEvent(wiring.blobs, "alice", e),
    ingress,
    request,
    sends,
    handlers,
    get models() {
      return models;
    },
    get decodes() {
      return decodes;
    },
    get hosted() {
      return hosted;
    },
    external,
    input,
    output,
    wire,
    bridge,
    disableBridge: () => {
      dropBridge = true;
    },
    revokeDuringSend: () => {
      revokeDuringSend = true;
    },
    setGrant: (v: Partial<ChannelSourceGrant>) => {
      grantOverrides = v;
    },
    failCommit: () => {
      failCommit = true;
    },
    expireOnCommit: () => {
      expireOnCommit = true;
    },
    read: () => host.read("user-alice"),
    drive: () => host.recover(),
    restart: async () => {
      await host.close();
      db.close();
      db = new Database(`${directory}/native.sqlite`);
      await open();
    },
  };
}
test("public provider fixture -> durable custody -> native typed handler -> correlated existing outbox survives disk restart without inference", async () => {
  const f = await fixture();
  const response = await f.ingress(
    f.request({ replyTo: "https://evil.invalid", type: "MessageReceived" }),
  );
  expect(response.status).toBe(202);
  expect(f.handlers).toHaveLength(0);
  expect(f.decodes).toBe(0);
  const received = (await f.read()).find(
    (e) => e.type === "AikoChannelReceived",
  )!;
  expect(received.sourceCapability).toBe("capability:source-only");
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelBridgeSelected"),
  ).toHaveLength(1);
  await f.restart();
  await f.drive();
  expect(f.handlers).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
  expect(f.models).toBe(0);
  const prepared = await f.openEvent(
    (await f.read()).find((e) => e.type === "AikoChannelOutputPrepared")!,
  );
  expect(prepared.destination).toBe("configured-provider-destination");
  expect((prepared.input as any).conversation).toBe(
    "authenticated-conversation",
  );
  expect((prepared.input as any).replyTo).toBe("one");
  expect((prepared.input as any).payload).toBe("typed:hello");
  expect((await f.read()).some((e) => e.type === "MessageReceived")).toBe(
    false,
  );
  await f.restart();
  await f.drive();
  expect(f.sends).toHaveLength(1);
  expect(f.handlers).toHaveLength(1);
  expect(
    (
      await f.ingress(
        f.request({ replyTo: "https://evil.invalid", type: "MessageReceived" }),
      )
    ).status,
  ).toBe(202);
  await f.drive();
  expect(f.sends).toHaveLength(1);
});
test("receive-only route rejects broad owner token, missing/bad source grant, signature, foreign generation/owner and lifecycle paths", async () => {
  const f = await fixture();
  expect((await f.ingress(f.request({}, { bearer: true }))).status).toBe(401);
  expect((await f.ingress(f.request({}, { token: "wrong" }))).status).toBe(403);
  expect((await f.ingress(f.request({}, { signature: "wrong" }))).status).toBe(
    403,
  );
  expect((await f.ingress(f.request({}, { method: "GET" }))).status).toBe(405);
  expect(
    (
      await f.ingress(
        f.request({}, { path: "/v1/channel-ingress/fixture-route/lifecycle" }),
      )
    ).status,
  ).toBe(404);
  expect(
    (await f.ingress(f.request({}, { path: "/v1/channels" }))).status,
  ).toBe(404);
  f.setGrant({ owner: "bob" });
  expect((await f.ingress(f.request())).status).toBe(404);
  f.setGrant({ generation: 2 });
  expect((await f.ingress(f.request())).status).toBe(409);
  f.setGrant({ expiresAt: 99 });
  expect((await f.ingress(f.request())).status).toBe(403);
  f.setGrant({ scope: "write" as any });
  expect((await f.ingress(f.request())).status).toBe(403);
  expect((await f.read()).some((e) => e.type === "AikoChannelReceived")).toBe(
    false,
  );
});
test("bad decode schema and provider delivery receipts never become internal event types or inference", async () => {
  const f = await fixture();
  expect((await f.ingress(f.request({ schema: "wrong.v1" }))).status).toBe(202);
  await f.drive();
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelInputRejected" &&
        e.reason === "bridge_decode_schema",
    ),
  ).toBe(true);
  expect(
    (
      await f.ingress(
        f.request({ occurrence: "receipt", kind: "delivery-receipt" }),
      )
    ).status,
  ).toBe(202);
  await f.drive();
  expect(f.handlers).toHaveLength(0);
  expect(f.sends).toHaveLength(0);
  expect(f.models).toBe(0);
});
test("failed custody and expiry racing commit never acknowledge input", async () => {
  const failed = await fixture();
  failed.failCommit();
  expect((await failed.ingress(failed.request())).status).toBe(503);
  expect(
    (await failed.read()).some((e) => e.type === "AikoChannelReceived"),
  ).toBe(false);
  const expired = await fixture();
  expired.expireOnCommit();
  expect((await expired.ingress(expired.request())).status).toBe(403);
  expect(
    (await expired.read()).some((e) => e.type === "AikoChannelReceived"),
  ).toBe(false);
});
test("correlated output echoes are rejected and bridge revocation fences further source admission", async () => {
  const f = await fixture();
  await f.ingress(f.request());
  await f.drive();
  const prepared = await f.openEvent(
    (await f.read()).find((e) => e.type === "AikoChannelOutputPrepared")!,
  );
  await f.ingress(
    f.request({ occurrence: "provider-output", ancestry: [prepared.id] }),
  );
  await f.drive();
  expect(f.sends).toHaveLength(1);
  expect(f.handlers).toHaveLength(1);
  expect(
    (await f.read()).some(
      (e) => e.type === "AikoChannelInputRejected" && e.reason === "echo",
    ),
  ).toBe(true);
  await f.hosted.run(f.hosted.bridge!.api.revoke(f.bridge.id));
  expect(
    (await f.ingress(f.request({ occurrence: "after-revocation" }))).status,
  ).toBe(409);
});

test("concurrent identical public deliveries share one admission and output; forged typed data cannot select a provider destination", async () => {
  const f = await fixture();
  const responses = await Promise.all([
    f.ingress(f.request()),
    f.ingress(f.request()),
  ]);
  expect(responses.map((r) => r.status)).toEqual([202, 202]);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelReceived"),
  ).toHaveLength(1);
  await f.restart();
  await f.drive();
  const linked = (await f.read()).find(
    (e) => e.type === "AikoChannelBridgeInputLinked",
  )!;
  await f.hosted.run(
    f.hosted.wiring!.api.emit({
      port: ref(f.output),
      schema: "result.v1",
      value: { text: "forged provider send" },
      occurrence: "forged",
      correlation: linked.correlation,
      authorityRef: "typed-grant",
    }),
  );
  await f.drive();
  expect(f.sends).toHaveLength(1);
  expect(f.handlers).toHaveLength(1);
  expect(
    (await f.ingress(f.request({ text: "changed same occurrence" }))).status,
  ).toBe(409);
  expect(
    (
      await f.ingress(
        f.request({ occurrence: "oversize", text: "x".repeat(5000) }),
      )
    ).status,
  ).toBe(413);
});

test("bridge scope must name the exact owner ports and wire; upgrading a wire before decode rejects the pinned pending source", async () => {
  const f = await fixture();
  const { id: _id, owner: _owner, artifact: _artifact, ...spec } = f.bridge;
  await expect(
    f.hosted.run(
      f.hosted.bridge!.api.bind({
        ...spec,
        operationId: "foreign",
        input: { channel: "foreign-owner-port", generation: 1 },
      }),
    ),
  ).rejects.toThrow("channel_bridge_scope");
  await f.ingress(f.request());
  await f.hosted.run(
    f.hosted.wiring!.api.connect({
      name: "handler",
      generation: 2,
      input: ref(f.input),
      accepts: "message.v1",
      handler: { harness: "c".repeat(64), contract: "b".repeat(64) },
      output: { ...ref(f.output), mode: "port" },
      authorityRef: "typed-grant",
      start: "after-registration",
      operationId: "wire-2",
    }),
  );
  await f.restart();
  await f.drive();
  expect(f.handlers).toHaveLength(0);
  expect(f.sends).toHaveLength(0);
  expect(f.models).toBe(0);
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelInputRejected" && e.reason === "bridge_stale",
    ),
  ).toBe(true);
  expect((await f.ingress(f.request({ occurrence: "new" }))).status).toBe(409);
});

test("disabling a bridge cannot turn retained typed input into an inference turn", async () => {
  const f = await fixture();
  await f.ingress(f.request());
  f.disableBridge();
  await f.restart();
  await f.drive();
  expect(f.handlers).toHaveLength(0);
  expect(f.sends).toHaveLength(0);
  expect(f.models).toBe(0);
  expect((await f.read()).some((e) => e.type === "MessageReceived")).toBe(
    false,
  );
  expect((await f.ingress(f.request({ occurrence: "disabled" }))).status).toBe(
    409,
  );
});

test("bridge revocation during awaited sender authorization prevents outbox dispatch", async () => {
  const f = await fixture();
  await f.ingress(f.request());
  f.revokeDuringSend();
  await f.drive();
  expect(f.handlers).toHaveLength(1);
  expect(f.sends).toHaveLength(0);
  expect(f.models).toBe(0);
  expect(
    (await f.read()).some(
      (e) =>
        e.type === "AikoChannelBridgeOutputRejected" &&
        e.reason === "outbox_not_prepared",
    ),
  ).toBe(true);
  await f.restart();
  await f.drive();
  expect(f.sends).toHaveLength(0);
});

test("sealed provider raw body, typed bridge and outbox keep private text and addresses out of complete native/disk traces", async () => {
  const f = await fixture(),
    secret = `private-provider-${crypto.randomUUID()}@custody.invalid`;
  expect(
    (await f.ingress(f.request({ text: secret, conversation: secret }))).status,
  ).toBe(202);
  const raw = (await f.read()).find((e) => e.type === "AikoChannelReceived")!;
  expect(raw.body).toBeUndefined();
  expect(raw.context).toBeUndefined();
  expect(raw.digest).toBeUndefined();
  expect(raw.privateRef).toBeDefined();
  await f.restart();
  await f.drive();
  expect(f.sends).toHaveLength(1);
  expect(JSON.stringify(f.sends[0])).toContain(secret);
  expect(JSON.stringify(await f.read())).not.toContain(secret);
  expect(f.disk()).not.toContain(secret);
  const prepared = (await f.read()).find(
    (e) => e.type === "AikoChannelOutputPrepared",
  )!;
  expect(prepared.input).toBeUndefined();
  expect(prepared.digest).toBeUndefined();
  f.erase(prepared.privateRef);
  await f.restart();
  await f.drive();
  expect(f.sends).toHaveLength(1);
});

test("deleted sealed provider input and missing prepared outbox bytes stay unavailable without sends", async () => {
  const input = await fixture();
  await input.ingress(input.request());
  input.erase(
    (await input.read()).find((e) => e.type === "AikoChannelReceived")!
      .privateRef,
  );
  await input.restart();
  await input.drive();
  expect(input.handlers).toHaveLength(0);
  expect(input.sends).toHaveLength(0);
  expect(
    (await input.read()).some(
      (e) =>
        e.type === "AikoChannelInputRejected" &&
        e.reason === "input_unavailable",
    ),
  ).toBe(true);
  expect((await input.ingress(input.request())).status).toBe(503);
  const output = await fixture();
  await output.ingress(output.request());
  output.deleteOutboxBlob();
  await output.drive();
  expect(output.handlers).toHaveLength(1);
  expect(output.sends).toHaveLength(0);
  expect(
    (await output.read()).some(
      (e) =>
        e.type === "AikoChannelOutputSettled" &&
        (e.result as any).evidence === "host:output_unavailable",
    ),
  ).toBe(true);
  await output.restart();
  await output.drive();
  expect(output.handlers).toHaveLength(1);
  expect(output.sends).toHaveLength(0);
});
