import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import type { ChannelAdapterBindings } from "../src/channel-host.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const token = "channel-owner-fixture-token-123456789";
async function fixture(enabled = true, replyStyle: AikoConfig["replyStyle"] = "direct", voiceReady = true) {
  const stateDir = await mkdtemp("/tmp/aiko-channel-host-");
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const sends: { input: any; key: string }[] = [];
  const decoded: string[] = [];
  let modelCalls = 0;
  const config: AikoConfig = {
    stateDir,
    mode: "live",
    modelKey: "fixture-model-never-used-123456789",
    instanceId: "channel-host-test",
    port: 4242,
    operatorToken: "channel-operator-fixture-123456789",
    persona: PERSONA,
    voiceEnabled: false,
    replyStyle,
    voiceKey: "fixture-voice-never-used-123456789",
    allowedUsers: new Set(["123", "456"]),
    planeCredentials: [
      { account: "123", digest: credentialDigest(token), scopes: ["read", "write"] },
      {
        account: "456",
        digest: credentialDigest("channel-foreign-fixture-123456789"),
        scopes: ["read", "write"],
      },
      { account: "123", digest: credentialDigest("channel-read-fixture-123456789"), scopes: ["read"] },
    ],
  };
  const adapters: ChannelAdapterBindings = {
    artifactAllowed: async (b) =>
      b.artifact.digest === "fixture-checked-adapter" && b.artifact.contractDigest === "fixture-contract",
    authorize: async (owner, authorization) => owner === "123" && authorization === "explicit-fixture-grant",
    authenticate: async (_b, request) =>
      request.headers.get("x-fixture-signature") === "valid"
        ? {
            principal: "fixture-source",
            occurrence: request.headers.get("x-occurrence") ?? "occurrence-1",
            conversation: "fixture-conversation",
            partition: "mailbox",
            ancestry: [],
            evidence: "fixture-signature-verified",
          }
        : undefined,
    execute: async (_b, operation, input, key) => {
      if (operation === "decode") {
        decoded.push(key);
        return { kind: "external", schemaVersion: "1", text: JSON.parse((input as any).body).text };
      }
      if (operation === "send") {
        sends.push({ input, key });
        return { status: "delivered", evidence: "fixture-recipient-ack", providerId: "fixture-sent-1" };
      }
      throw new Error("unsupported fixture operation");
    },
    validateReceipt: async (_b, operation, result) =>
      operation === "send" && (result as any).evidence === "fixture-recipient-ack",
  };
  const overrides: NonNullable<Parameters<typeof createService>[1]> = {
    voiceFetch: async (_url, init) =>
      voiceReady
        ? Response.json({ personified: `Voice: ${JSON.parse(String(init?.body)).raw}` })
        : new Response("fixture outage", { status: 503 }),
    channels: enabled ? (owner) => (owner === "123" ? adapters : undefined) : undefined,
    model: Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "channel-host" } }),
      react: () => {
        modelCalls++;
        return Effect.succeed({ kind: "complete" as const, output: "The channel fixture was received." });
      },
    }),
  };
  let service = await createService(config, overrides);
  cleanups.push(() => service.close());
  const request = (path: string, body?: unknown, credential = token, extra: Record<string, string> = {}) =>
    service.fetch(
      new Request(`http://localhost/v1/channels${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json", ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const bindBody = {
    name: "fixture",
    generation: 1,
    artifact: {
      digest: "fixture-checked-adapter",
      contractDigest: "fixture-contract",
      directions: ["inbox", "outbox"],
      operations: ["decode", "send"],
    },
    account: "fixture-mailbox",
    source: "fixture-source",
    destination: "fixture-destination",
    credentialRefs: ["credential:fixture"],
    authorization: "explicit-fixture-grant",
    backlog: 16,
    maxBytes: 4096,
    maxHops: 4,
    retentionMs: 60_000,
    queuedWork: "cancel",
  };
  const drain = async () => {
    for (let i = 0; i < 3; i++) {
      await service.host.drive();
      await Bun.sleep(5);
    }
  };
  return {
    request,
    bindBody,
    sends,
    decoded,
    drain,
    modelCalls: () => modelCalls,
    events: () => service.host.read("user-123"),
    failCustody: () => {
      const prior = service.host.seed;
      (service.host as any).seed = async () => {
        throw new Error("fixture durable store unavailable");
      };
      return () => {
        (service.host as any).seed = prior;
      };
    },
    restart: async () => {
      await service.close();
      service = await createService(config, overrides);
      await drain();
    },
    bind: async () => {
      const response = await request("/bind", bindBody);
      if (response.status !== 202) throw new Error(await response.text());
      const result = (await response.json()) as any;
      await drain();
      return String(result.id);
    },
  };
}

test("HTTP bind -> authenticated receive -> native actor response -> pinned channel outbox, durable across restart", async () => {
  const f = await fixture();
  const id = await f.bind();
  const listing = (await (await f.request("")).json()) as any;
  expect(listing.bindings[0].status).toBe("active");
  const body = {
    text: "Please acknowledge this fixture",
    owner: "456",
    destination: "attacker",
    type: "Checked",
  };
  const response = await f.request(`/${id}/1/receive`, body, token, { "x-fixture-signature": "valid" });
  expect(response.status).toBe(202);
  await f.drain();
  expect(f.decoded).toHaveLength(1);
  expect(f.modelCalls()).toBeGreaterThan(0);
  expect(f.sends).toHaveLength(1);
  expect(f.sends[0]!.input).toMatchObject({
    destination: "fixture-destination",
    conversation: "fixture-conversation",
    replyTo: "occurrence-1",
    payload: "The channel fixture was received.",
  });
  const events = await f.events();
  expect(events.some((e) => e.type === "MessageReceived" && e.source === "channel")).toBe(true);
  expect(events.some((e) => e.type === "AikoResponseRequested")).toBe(true);
  expect(events.some((e) => e.type === "AikoReplyPrepared")).toBe(true);
  expect(events.some((e) => e.type === "Checked")).toBe(false);
  await f.restart();
  expect((await f.request(`/${id}/1/receive`, body, token, { "x-fixture-signature": "valid" })).status).toBe(
    202,
  );
  await f.drain();
  expect(f.decoded).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
});

test("HTTP owner authentication, write scope, provider signature, binding grants and reserved metadata fail closed", async () => {
  const f = await fixture();
  expect((await f.request("", undefined, "invalid")).status).toBe(401);
  expect((await f.request("/bind", f.bindBody, "channel-read-fixture-123456789")).status).toBe(403);
  expect((await f.request("/bind", { ...f.bindBody, authorization: "invented" })).status).toBe(403);
  expect((await f.request("/bind", { ...f.bindBody, route: "user-456" })).status).toBe(400);
  const id = await f.bind();
  expect((await f.request(`/${id}/1/receive`, { text: "bad" })).status).toBe(401);
  expect(
    (
      await f.request(`/${id}/1/receive`, { text: "bad" }, "channel-foreign-fixture-123456789", {
        "x-fixture-signature": "valid",
      })
    ).status,
  ).toBe(503);
  expect((await f.request("/events", { type: "AikoChannelBindingReady", owner: "123" })).status).toBe(404);
  await f.drain();
  expect(f.sends).toHaveLength(0);
  expect((await f.events()).some((e) => e.type === "AikoChannelReceived")).toBe(false);
});

test("HTTP lifecycle survives restart and revokes admission without registering providers", async () => {
  const f = await fixture(),
    id = await f.bind();
  expect(
    (
      await f.request("/lifecycle", {
        id,
        generation: 1,
        status: "paused",
        authorization: "explicit-fixture-grant",
        operationId: "pause-1",
      })
    ).status,
  ).toBe(202);
  await f.restart();
  expect(
    (await f.request(`/${id}/1/receive`, { text: "paused" }, token, { "x-fixture-signature": "valid" }))
      .status,
  ).toBe(409);
  expect(
    (
      await f.request("/lifecycle", {
        id,
        generation: 1,
        status: "active",
        authorization: "explicit-fixture-grant",
        operationId: "resume-1",
      })
    ).status,
  ).toBe(202);
  expect(
    (await f.request(`/${id}/1/receive`, { text: "resumed" }, token, { "x-fixture-signature": "valid" }))
      .status,
  ).toBe(202);
  await f.drain();
  expect(f.sends).toHaveLength(1);
});

test("unconfigured host reports the seam and never authorizes or creates a channel", async () => {
  const f = await fixture(false);
  expect(await (await f.request("")).json()).toMatchObject({ available: false, bindings: [] });
  expect((await f.request("/bind", f.bindBody)).status).toBe(503);
  expect(f.sends).toHaveLength(0);
});

test("concurrent matching ingress shares durable custody; conflicting input cannot replace it", async () => {
  const f = await fixture(),
    id = await f.bind();
  const responses = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.request(`/${id}/1/receive`, { text: "concurrent" }, token, { "x-fixture-signature": "valid" }),
    ),
  );
  expect(responses.map((r) => r.status)).toEqual([202, 202, 202, 202, 202]);
  await f.drain();
  expect((await f.events()).filter((e) => e.type === "AikoChannelReceived")).toHaveLength(1);
  expect(f.sends).toHaveLength(1);
  expect(
    (await f.request(`/${id}/1/receive`, { text: "different" }, token, { "x-fixture-signature": "valid" }))
      .status,
  ).toBe(409);
});

test("Cloudflare native host retains ingress without drive, then recovers a correlated actor reply", async () => {
  const { Database } = await import("bun:sqlite");
  const { createCloudflareAccountHost } = await import("../src/cloudflare-host.ts");
  const { createHostedChannels, channelApi } = await import("../src/channel-host.ts");
  const { channelEventKey, channelAppendAllowed } = await import("../src/channel-bindings.ts");
  const { createAikoActor } = await import("../src/actor.ts");
  const { createVoice } = await import("../src/voice.ts");
  const { withRequiredResponse } = await import("../src/channel-response.ts");
  const stateDir = await mkdtemp("/tmp/aiko-channel-cf-");
  const db = new Database(`${stateDir}/account.sqlite`);
  let alarm: number | null = null;
  const storage = {
    sql: {
      exec: (query: string, ...args: any[]) => {
        const rows = db.query(query).all(...args);
        return { toArray: () => rows as never };
      },
    },
    transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
    sync: async () => {},
    getAlarm: async () => alarm,
    setAlarm: async (n: number) => {
      alarm = n;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const sent: any[] = [];
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const channels = createHostedChannels(
    "123",
    () => host,
    {
      artifactAllowed: async () => true,
      authorize: async (_owner, auth) => auth === "fixture-grant",
      authenticate: async (_b, request) =>
        request.headers.get("signature") === "fixture"
          ? {
              principal: "source",
              occurrence: "cf-one",
              conversation: "cf-conversation",
              partition: "default",
              ancestry: [],
              evidence: "fixture",
            }
          : undefined,
      execute: async (_b, operation, input) =>
        operation === "decode"
          ? { kind: "external", schemaVersion: "1", text: "Reply to the CF fixture." }
          : (sent.push(input), { status: "delivered", evidence: "fixture-confirmed" }),
      validateReceipt: async () => true,
    },
    {
      beforeCommit: async () => {
        await storage.setAlarm(Date.now() + 1000);
      },
    },
  );
  const definition = createAikoActor({
    owner: "123",
    channels,
    live: true,
    memory: {
      owner: "123",
      thread: "user-123",
      stateDir,
      redact: (text) => text,
      readPage: (after, limit) => host.readPage("user-123", after, limit),
    },
    voice: createVoice({ enabled: false, persona: PERSONA }),
  });
  const open = () =>
    createCloudflareAccountHost({
      storage,
      actorName: "aiko",
      actorInstance: "channel-cf",
      ownsThread: (thread) => thread === "user-123",
      actorFor: () => definition,
      layersFor: () =>
        withRequiredResponse(
          Layer.succeed(Infer, {
            resolve: () => ({ model: { provider: "fixture", model_id: "cf" } }),
            react: () =>
              Effect.succeed({ kind: "complete" as const, output: "Cloudflare fixture received." }),
          }),
        ),
      keyOf: channelEventKey,
      canAppend: (_thread, batch, read) => channelAppendAllowed(batch, read),
    });
  host = await open();
  cleanups.push(async () => {
    await host.close();
    db.close();
    await rm(stateDir, { recursive: true, force: true });
  });
  const principal = { owner: "123", scopes: ["read", "write"] };
  const api = (path: string, body: unknown, who = principal) =>
    channelApi(
      new Request(`https://fixture/v1/channels/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", signature: "fixture" },
        body: JSON.stringify(body),
      }),
      "123",
      channels,
      who,
      () => {},
    );
  const response = await api("bind", {
    name: "cf",
    generation: 1,
    artifact: {
      digest: "fixture",
      contractDigest: "contract",
      directions: ["inbox", "outbox"],
      operations: ["decode", "send"],
    },
    account: "mailbox",
    source: "source",
    destination: "cf-destination",
    credentialRefs: [],
    authorization: "fixture-grant",
    backlog: 5,
    maxBytes: 4096,
    maxHops: 4,
    retentionMs: 60_000,
    queuedWork: "cancel",
  });
  expect(response.status).toBe(202);
  const { id } = (await response.json()) as any;
  await host.recover();
  expect(
    (await api(`${id}/1/receive`, { text: "fixture" }, { owner: "456", scopes: ["read", "write"] })).status,
  ).toBe(403);
  expect((await api(`${id}/1/receive`, { text: "fixture" })).status).toBe(202);
  expect(sent).toHaveLength(0);
  expect(await storage.getAlarm()).not.toBeNull();
  expect((await host.read("user-123")).some((e) => e.type === "AikoChannelReceived")).toBe(true);
  await host.close();
  host = await open();
  await host.recover();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    destination: "cf-destination",
    conversation: "cf-conversation",
    replyTo: "cf-one",
    payload: "Cloudflare fixture received.",
  });
  await host.close();
  host = await open();
  await host.recover();
  expect(sent).toHaveLength(1);
});

test("channel registry bridge executes a pinned, independently evaluated artifact through the real sandbox", async () => {
  const { Database } = await import("bun:sqlite");
  const { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryEventKey } =
    await import("../src/harness-library.ts");
  const { createHarnessSandboxBinding } = await import("../src/harness-sandbox.ts");
  const { localHarnessSandbox } = await import("../src/harness-sandbox-local.ts");
  const { sandboxJobJournal } = await import("../src/sandbox-job-journal.ts");
  const { sandboxEnvironment } = await import("../src/sandbox-job-runner.ts");
  const { sqliteWorkflowKV } = await import("../src/workflow-store.ts");
  const { channelHarnessAdapters } = await import("../src/channel-host.ts");
  const { channelId } = await import("../src/channel-bindings.ts");
  const directory = await mkdtemp("/tmp/channel-registry-bridge-");
  const db = new Database(`${directory}/state.sqlite`);
  cleanups.push(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const runtimeDigest = await sandboxEnvironment("channel-fixture-v1");
  const authority = {
    owner: "123",
    active: true,
    runtimeDigest,
    contextRef: "fixture",
    authorityRef: "read-only-fixture",
    sessionRevision: null,
    effects: ["read" as const],
    origins: [],
    methods: ["GET"],
    budget: { wallMs: 5000, requests: 0, outputBytes: 32768 },
  };
  const sandbox = localHarnessSandbox({
    owner: "123",
    environmentDigest: runtimeDigest,
    journal: await sandboxJobJournal(db, `${directory}/key`),
  });
  const bridge = createHarnessSandboxBinding({
    owner: "123",
    thread: "user-123",
    placement: "local",
    sandbox,
    current: async () => authority,
  });
  const verifier = {
    digest: harnessDigest("channel-verifier"),
    evaluatorDigest: harnessDigest("channel-fixed-cases"),
    cases: [
      {
        id: "development",
        input: { operation: "decode", input: { body: '{"text":"first"}' }, binding: {} },
        split: "development" as const,
      },
      {
        id: "held-out",
        input: { operation: "decode", input: { body: '{"text":"different"}' }, binding: {} },
        split: "held-out" as const,
      },
    ],
    verify: async ({ input, output }: any) => ({
      passed: output.kind === "external" && output.text === JSON.parse(input.input.body).text,
      evidence: ["independent-fixture-decode-equality"],
      quality: 1,
    }),
  };
  const binding = {
    owner: "123",
    thread: "user-123",
    blobs: harnessBlobStore(sqliteWorkflowKV(db)),
    verifiers: new Map([[verifier.digest, verifier]]),
    guard: () => {},
    ...bridge,
  };
  const events: import("tardie/core/event").Event[] = [];
  const journal = {
    read: async () => events,
    append: async (batch: typeof events) => {
      for (const event of batch)
        if (!events.some((e) => harnessLibraryEventKey(e) === harnessLibraryEventKey(event)))
          events.push(event);
    },
  };
  const library = new HarnessLibrary(binding, journal);
  const contractDigest = await library.registerContract({
    version: 1,
    outcome: "Decode fixture message text",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    effect: "read",
    verifierDigest: verifier.digest,
    evaluatorDigest: verifier.evaluatorDigest,
    applicability: { channel: { directions: ["inbox"], operations: ["decode"] } },
    timeoutMs: 5000,
  });
  const code = 'return {kind:"external",schemaVersion:"1",text:JSON.parse(input.input.body).text};';
  const digest = await library.record({
    version: 1,
    name: "fixture-channel",
    description: "Bounded fixture decoder",
    runtime: "javascript",
    entrypoint: "main.js",
    files: { "main.js": code },
    dependencies: [],
    sources: [{ uri: "fixture:channel", revision: "1", digest: harnessDigest(code), license: "fixture" }],
    contractDigest,
  });
  const adapters = channelHarnessAdapters(binding, journal, {
    authorize: async () => false,
    authenticate: async () => undefined,
    validateReceipt: async () => false,
  });
  const channel: import("../src/channel-bindings.ts").ChannelBinding = {
    owner: "123",
    id: channelId("123", "registry"),
    name: "registry",
    generation: 1,
    status: "active",
    artifact: { digest, contractDigest, directions: ["inbox"], operations: ["decode"] },
    account: "fixture",
    source: "fixture",
    route: "user-123",
    credentialRefs: [],
    authorization: "existing-grant",
    backlog: 4,
    maxBytes: 4096,
    maxHops: 4,
    retentionMs: 60000,
    queuedWork: "cancel",
  };
  expect(await adapters.artifactAllowed(channel)).toBe(false);
  expect((await library.evaluate(digest, "channel-evaluation", AbortSignal.timeout(15000))).eligible).toBe(
    true,
  );
  expect(await adapters.artifactAllowed(channel)).toBe(true);
  expect(
    await adapters.execute(
      channel,
      "decode",
      { body: '{"text":"fresh runtime input"}' },
      "channel-fresh-operation",
      AbortSignal.timeout(15000),
    ),
  ).toEqual({ kind: "external", schemaVersion: "1", text: "fresh runtime input" });
  expect(
    await adapters.artifactAllowed({
      ...channel,
      artifact: { ...channel.artifact, directions: ["inbox", "outbox"], operations: ["decode", "send"] },
    }),
  ).toBe(false);
  expect(await adapters.authorize("123", "invented", "send", {})).toBe(false);
  authority.active = false;
  expect(await adapters.artifactAllowed(channel)).toBe(false);
});

test("failed durable custody returns a retryable error instead of acknowledging dropped input", async () => {
  const f = await fixture(),
    id = await f.bind();
  const restore = f.failCustody();
  try {
    expect(
      (
        await f.request(`/${id}/1/receive`, { text: "must retain" }, token, {
          "x-fixture-signature": "valid",
        })
      ).status,
    ).toBe(503);
    expect((await f.events()).some((e) => e.type === "AikoChannelReceived")).toBe(false);
  } finally {
    restore();
  }
  expect(
    (await f.request(`/${id}/1/receive`, { text: "must retain" }, token, { "x-fixture-signature": "valid" }))
      .status,
  ).toBe(202);
  await f.drain();
  expect(f.sends).toHaveLength(1);
});

test("dynamic channel output uses prepared persona text and the existing safe outage response", async () => {
  for (const ready of [true, false]) {
    const f = await fixture(true, "thinkfeel", ready),
      id = await f.bind();
    expect(
      (
        await f.request(`/${id}/1/receive`, { text: "persona fixture" }, token, {
          "x-fixture-signature": "valid",
        })
      ).status,
    ).toBe(202);
    await f.drain();
    const prepared = (await f.events()).find((e) => e.type === "AikoReplyPrepared")!.result as any;
    expect(prepared.source).toBe(ready ? "thinkfeel" : "service");
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]!.input.payload).toBe(prepared.text);
    expect(f.sends[0]!.input.payload).not.toBe("The channel fixture was received.");
  }
});
