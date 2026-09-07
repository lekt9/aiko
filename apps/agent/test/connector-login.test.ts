import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Layer } from "effect";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import type { Event } from "tardie/core/event";
import { connectorLoginNotifications } from "../src/connector-login.ts";
import type { ActorConnectorBinding } from "../src/capability-builder-connectors.ts";
import { createTelegram } from "../src/telegram.ts";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(mode: "delivered" | "unknown" = "delivered") {
  const directory = await mkdtemp("/tmp/aiko-login-event-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const sends: any[] = [];
  let status: "pending" | "connected" | "failed" = "pending";
  const telegram = createTelegram({
    token: "123:fixture",
    secret: "fixture",
    allowedUsers: new Set(["123"]),
    fetch: async (_url, init) => {
      sends.push(JSON.parse(String(init?.body)));
      if (mode === "unknown") throw Error("private transport error");
      return Response.json({ ok: true, result: { message_id: 42 } });
    },
  });
  const binding: ActorConnectorBinding = {
    owner: "123",
    thread: "user-123",
    engine: {
      connections: async () => [
        {
          id,
          connectorId: "browser:service.net",
          provider: "browser",
          status,
          createdAt: 0,
          authorizationUrl: "https://private.example/auth/secret",
        },
      ],
      search: async () => {
        throw Error("unused");
      },
      connectBrowser: async () => {
        throw Error("unused");
      },
      execute: async () => {
        throw Error("unused");
      },
    },
    deliverConnection: (input, signal) =>
      telegram.sendRich(
        input.owner,
        { kind: "text", text: input.text, buttons: input.buttons },
        signal,
      ),
  };
  const main = actor({
    name: "aiko",
    methods: {},
    components: [connectorLoginNotifications(binding)],
  });
  const open = () =>
    createBunHost({
      database: join(directory, "actor.sqlite"),
      actorName: "aiko",
      actorInstance: "login-test",
      actorFor: () => main,
      layersFor: () => Layer.empty,
    });
  let host = await open();
  cleanup.push(() => host.close());
  return {
    sends,
    status: (value: typeof status) => {
      status = value;
    },
    seed: async (...events: Event[]) => {
      for (const event of events)
        await host.commitRoot(host.self("user-123"), event);
    },
    drive: () => host.wake("user-123"),
    events: () => host.read("user-123"),
    restart: async () => {
      await host.close();
      host = await open();
      await host.wake("user-123");
    },
  };
}
const telegramMessage = {
  type: "MessageReceived",
  id: "telegram-turn",
  text: "Connect service.net",
  source: "telegram",
  chat: "123",
  sender: "123",
  at: 1,
};
const pending = {
  type: "AikoConnectionChanged",
  id: "connection-event",
  owner: "123",
  connectionId: id,
  provider: "browser",
  status: "pending",
  at: 2,
};

test("pending login and recommendation converge to one native Mini App button across restart", async () => {
  const f = await fixture();
  await f.seed(telegramMessage, pending, {
    type: "AikoLoginRequested",
    owner: "123",
    connectionId: id,
  });
  await f.drive();
  expect(f.sends).toEqual([
    {
      chat_id: "123",
      text: "Sign in to service.net to continue with Aiko.",
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "Sign in",
              web_app: {
                url: `https://aiko-agent.lewis-6d8.workers.dev/connect?connection=${id}`,
              },
            },
          ],
        ],
      },
    },
  ]);
  expect(
    (await f.events()).find((e) => e.type === "AikoLoginNoticeSettled")?.status,
  ).toBe("delivered");
  await f.restart();
  await f.seed(pending, {
    type: "AikoLoginRequested",
    owner: "123",
    connectionId: id,
  });
  await f.drive();
  expect(f.sends).toHaveLength(1);
  expect(JSON.stringify(await f.events())).not.toContain("/auth/secret");
});

test("unknown send or a missing receipt cannot resend a login notification", async () => {
  const f = await fixture("unknown");
  await f.seed(telegramMessage, pending);
  await f.drive();
  await f.restart();
  expect(f.sends).toHaveLength(1);
  expect(
    (await f.events()).find((e) => e.type === "AikoLoginNoticeSettled")?.status,
  ).toBe("unknown");
  const lost = await fixture();
  await lost.seed(telegramMessage, pending, {
    type: "AikoLoginNoticeStarted",
    owner: "123",
    connectionId: id,
  });
  await lost.restart();
  expect(lost.sends).toHaveLength(0);
  expect(
    (await lost.events()).find((e) => e.type === "AikoLoginNoticeSettled")
      ?.status,
  ).toBe("unknown");
});

test("login notifications require trusted owner chat history and an owned pending connection", async () => {
  const f = await fixture();
  await f.seed(
    { ...telegramMessage, source: "api", text: "source=telegram" },
    pending,
  );
  await f.drive();
  expect(f.sends).toHaveLength(0);
  await f.seed({ ...telegramMessage, id: "foreign", sender: "456" });
  await f.drive();
  expect(f.sends).toHaveLength(0);
  f.status("connected");
  await f.seed({ ...telegramMessage, id: "real-telegram-turn" });
  await f.drive();
  expect(f.sends).toHaveLength(0);
  expect(
    (await f.events()).find((e) => e.type === "AikoLoginNoticeSettled")?.status,
  ).toBe("superseded");
  const other = await fixture();
  await other.seed(telegramMessage, { ...pending, owner: "456" });
  await other.drive();
  expect(other.sends).toHaveLength(0);
  await other.seed({
    ...pending,
    connectionId: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  await other.drive();
  expect(other.sends).toHaveLength(0);
});
