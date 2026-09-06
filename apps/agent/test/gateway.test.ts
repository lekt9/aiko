import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createService } from "../src/server.ts";
import { accountDirectory } from "../src/accounts.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { createTelegramPoller } from "../src/telegram-polling.ts";
import {
  createAikoClient,
  AikoPlaneError,
} from "../../../packages/sdk/src/aiko.ts";
import { openMemory, type MemoryBinding } from "../src/memory.ts";
import { followLogMemory } from "../src/log-memory.ts";
import { Effect } from "effect";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { event } from "../src/actor.ts";
import { tardigradeLogSource } from "entity-learn";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const alice = "aiko_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bob = "aiko_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const reader = "aiko_rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr";
async function setup() {
  const stateDir = await mkdtemp("/tmp/aiko-gateway-");
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const config: AikoConfig = {
    stateDir,
    mode: "demo",
    port: 4242,
    operatorToken: "private-test-operator-1234567890123456",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(),
    telegramPublic: true,
    botToken: "123:test-only",
    webhookSecret: "test_webhook_secret_123456789012345",
    maxAccounts: 100,
    planeCredentials: [
      {
        account: "123",
        digest: credentialDigest(alice),
        scopes: ["read", "write"],
      },
      {
        account: "456",
        digest: credentialDigest(bob),
        scopes: ["read", "write"],
      },
      { account: "123", digest: credentialDigest(reader), scopes: ["read"] },
    ],
  };
  let sends = 0;
  const options = {
    telegramFetch: async () => {
      sends++;
      return Response.json({ ok: true, result: { message_id: 5 } });
    },
  };
  let service = await createService(config, options);
  cleanups.push(() => service.close());
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) =>
    service.fetch(new Request(url, init))) as typeof fetch;
  const client = (token: string) =>
    createAikoClient({
      baseUrl: "http://127.0.0.1:4242",
      token,
      fetch: fetcher,
    });
  return {
    config,
    client,
    fetcher,
    get service() {
      return service;
    },
    get sends() {
      return sends;
    },
    restart: async () => {
      await service.close();
      service = await createService(config, options);
    },
  };
}
function update(
  id: number,
  user = 123,
  text = "Remember: Aurora meeting is on Tuesday",
) {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1,
      text,
      from: { id: user, is_bot: false },
      chat: { id: user, type: "private" },
    },
  };
}

test("Telegram and SDK share one account's durable logs and automatic cited memory; other accounts cannot read it", async () => {
  const app = await setup();
  const accept = (u: object) =>
    app.service.acceptTelegram(
      new Request("http://127.0.0.1/telegram/webhook", {
        method: "POST",
        headers: {
          "x-telegram-bot-api-secret-token": app.config.webhookSecret!,
        },
        body: JSON.stringify(u),
      }),
    );
  expect(
    await accept(update(1, 123, "Our launch codename is aurorapanda")),
  ).toBe("accepted");
  await app.service.host.drive();
  expect(app.sends).toBe(1);
  expect((await app.client(alice).messages.list()).messages[0].text).toContain(
    "aurorapanda",
  );
  expect((await app.client(bob).messages.list()).messages).toHaveLength(0);
  const recalled = await app.client(alice).memory.recall("aurorapanda");
  expect(recalled.items.length).toBeGreaterThan(0);
  const observation = recalled.items[0].observation;
  expect(observation.producer.kind).toBe("tool");
  expect(JSON.stringify(observation.payload)).toContain("eventDigest");
  expect(
    (await app.client(bob).memory.recall("aurorapanda")).items,
  ).toHaveLength(0);
  await expect(
    app.client(bob).memory.get(observation.id),
  ).rejects.toMatchObject({ status: 404 });
  expect((await app.client(alice).status()).account).toBe("123");
  expect((await app.client(alice).discover()).protocol).toBe("aiko-plane/v1");
  expect(accountDirectory(app.config.stateDir, "123")).not.toBe(
    accountDirectory(app.config.stateDir, "456"),
  );
  expect(
    (
      await stat(
        join(accountDirectory(app.config.stateDir, "123"), "thread.sqlite"),
      )
    ).mode & 0o777,
  ).toBe(0o600);
  await app.restart();
  expect(
    await accept(update(1, 123, "Our launch codename is aurorapanda")),
  ).toBe("duplicate");
  expect(
    (await app.client(alice).memory.get(observation.id)).observation.id,
  ).toBe(observation.id);
  const result = await app.client(alice).messages.send({
    id: "sdk_request_001",
    text: "Search memory for aurorapanda",
  });
  expect(result.status).toBe("accepted");
  await app.service.host.drive();
  expect(app.sends).toBe(1); // Plane-originated work does not leak onto Telegram.
  expect(
    JSON.stringify((await app.client(alice).messages.list()).messages.at(-1)),
  ).toContain("aurorapanda");
}, 30_000);

test("credentials bind identity and read/write grants; injected account fields and conflicting retries fail closed", async () => {
  const app = await setup();
  await expect(app.client("wrong").status()).rejects.toBeInstanceOf(
    AikoPlaneError,
  );
  await expect(
    app.client(reader).messages.send({ id: "readonly_001", text: "Hi" }),
  ).rejects.toMatchObject({ status: 403 });
  const spoof = await app.fetcher("http://127.0.0.1:4242/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${alice}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: "spoofing_001", text: "Hi", owner: "456" }),
  });
  expect(spoof.status).toBe(400);
  const body = { id: "idempotency_001", text: "Remember: UTC" };
  await app.client(alice).messages.send(body);
  await app.service.host.drive();
  expect((await app.client(alice).messages.send(body)).status).toBe(
    "duplicate",
  );
  await expect(
    app.client(alice).messages.send({ ...body, text: "Different" }),
  ).rejects.toMatchObject({ status: 409 });
  const accepted = await app.client(bob).messages.send(body);
  expect(accepted.status).toBe("accepted"); // Same key is scoped to Bob, not global.
  await app.service.host.drive();
  await expect(
    app.client(bob).messages.cancel("telegram:foreign"),
  ).rejects.toMatchObject({ status: 404 });
  expect(() => accountDirectory(app.config.stateDir, "../123")).toThrow();
  await app
    .client(alice)
    .messages.send({ id: "credential_001", text: `Remember: ${alice}` });
  await app.service.host.drive();
  expect(JSON.stringify(await app.service.host.read("user-123"))).not.toContain(
    alice,
  );
}, 30_000);

test("completed log follower observations remain stable across restart", async () => {
  const app = await setup();
  await app.client(alice).messages.send({
    id: "follow_replay_001",
    text: "Remember: violetmongoose",
  });
  await app.service.host.drive();
  const binding = {
    stateDir: accountDirectory(app.config.stateDir, "123"),
    owner: "123",
  };
  const memory = openMemory(binding);
  const before = memory.recall({ search: "violetmongoose" });
  memory.close();
  expect(before.items.length).toBeGreaterThan(0);
  // Restart replays the native component projection, rather than appending fresh observations.
  await app.restart();
  const after = await app.client(alice).memory.recall("violetmongoose");
  expect(after.items.map((item) => item.observation.id)).toEqual(
    before.items.map((item) => item.observation.id),
  );
}, 30_000);

test("log follower recovers a committed memory window before native acknowledgement without duplicating observations", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-follow-crash-");
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  let host: Awaited<ReturnType<typeof createBunHost>>;
  const binding: MemoryBinding = {
    stateDir,
    owner: "123",
    thread: "user-123",
    redact: (text) => text,
    readPage: (after, limit) => host.readPage("user-123", after, limit),
  };
  const follower = followLogMemory(binding);
  const crashing = {
    ...follower,
    machine: {
      ...follower.machine,
      output: (state: ReturnType<typeof follower.machine.initial>) => {
        const output = follower.machine.output(state);
        return {
          ...output,
          transitions: output.transitions.map((transition) => {
            if (transition.kind !== "effect") return transition;
            return {
              ...transition,
              act: (...args: Parameters<typeof transition.act>) =>
                transition
                  .act(...args)
                  .pipe(
                    Effect.tap(() =>
                      Effect.die(
                        new Error("simulated loss after memory commit"),
                      ),
                    ),
                  ),
            };
          }),
        };
      },
    },
  };
  const options = {
    database: join(stateDir, "actor.sqlite"),
    actorName: "aiko",
    actorInstance: "test",
  };
  host = await createBunHost({
    ...options,
    actorFor: () =>
      actor({ name: "aiko", methods: {}, components: [crashing] }),
  });
  cleanups.push(() => host.close());
  await host.commitRoot(
    host.self(binding.thread),
    event("MessageReceived", {
      id: "crash-follow-1",
      text: "violetmongoose launch",
    }),
  );
  await host.seed(binding.thread, [
    event("AikoReplyPrepared", {
      turn: "crash-follow-1",
      result: { text: "Recorded", source: "template" },
    }),
  ]);
  // A pre-existing metadata-only import must not block the new content projection.
  const legacy = tardigradeLogSource({
    id: "legacy-metadata",
    actor: "aiko@test",
    thread: binding.thread,
    read: ({ after, limit }) => binding.readPage(after, limit),
  });
  const legacyMemory = openMemory(binding, {
    [legacy.source.locator]: legacy.run,
  });
  const registered = legacyMemory.registerSource(
    legacy.source,
    "legacy-register",
  );
  legacyMemory.approveSource(
    registered.id,
    registered.revision,
    true,
    "legacy-approve",
  );
  expect(
    (await legacyMemory.refresh(registered.id, { key: "legacy-read" })).error,
  ).toBeNull();
  legacyMemory.close();
  await expect(host.wake(binding.thread)).rejects.toThrow("simulated loss");
  const before = openMemory(binding);
  const original = before.recall({ search: "violetmongoose" }).items[0]
    .observation;
  before.close();
  expect(
    (await host.read(binding.thread)).some(
      (e) => e.type === "AikoLogMemoryFollowed",
    ),
  ).toBe(false);
  await host.close();
  host = await createBunHost({
    ...options,
    actorFor: () =>
      actor({ name: "aiko", methods: {}, components: [follower] }),
  });
  await host.recover();
  const after = openMemory(binding);
  expect(after.history(original.subject)).toHaveLength(1);
  expect(
    after.recall({ search: "violetmongoose" }).items[0].observation.id,
  ).toBe(original.id);
  after.close();
  expect(
    (await host.read(binding.thread)).filter(
      (e) => e.type === "AikoLogMemoryFollowed",
    ),
  ).toHaveLength(1);
}, 30_000);

test("polling persists a redacted inbox before cursor advancement; queued work survives restart", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-polling-");
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const config = {
    stateDir,
    botToken: "123:test-only",
    webhookSecret: "fixture-webhook",
  } as AikoConfig;
  const offsets: number[] = [];
  const accepted: number[] = [];
  let busy = true;
  let notices = 0;
  const fakeService = {
    prepareTelegram: async (request: Request) => {
      const value = await request.json();
      return {
        update: value.update_id,
        user: String(value.message.from.id),
        text: value.message.text,
        at: Date.now(),
      };
    },
    acceptTelegram: async (request: Request) => {
      const { update_id } = await request.json();
      if (update_id === 2 && busy) return "busy" as const;
      accepted.push(update_id);
      return update_id === 3 ? ("limited" as const) : ("accepted" as const);
    },
  };
  const fetcher = async (
    url: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    if (String(url).endsWith("/sendMessage")) {
      notices++;
      return Response.json({ ok: true, result: { message_id: 3 } });
    }
    const body = JSON.parse(String(init?.body));
    offsets.push(body.offset);
    return Response.json({
      ok: true,
      result: [update(1), update(2), update(3)].filter(
        (u) => u.update_id >= body.offset,
      ),
    });
  };
  let poller = createTelegramPoller(config, fakeService, fetcher);
  await poller.pollOnce();
  await poller.close();
  expect(accepted).toEqual([1]);
  busy = false;
  poller = createTelegramPoller(config, fakeService, fetcher);
  try {
    await poller.pollOnce();
    await poller.pollOnce();
  } finally {
    await poller.close();
  }
  expect(offsets).toEqual([0, 4, 4]);
  expect(accepted).toEqual([1, 2, 3]);
  expect(notices).toBe(1);
});
