import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { createBunHost, type BunHost } from "tardie/bun/host";
import { event } from "../src/actor.ts";
import { accountThreadDatabase, threadBinding } from "../src/accounts.ts";
import {
  createTelegram,
  serializeTelegramInbound,
  redactTelegramInbound,
} from "../src/telegram.ts";
import { secretaryTelegram } from "../src/secretary-telegram.ts";
import {
  acceptSecretary,
  createSecretaryActor,
  secretaryApi,
  secretaryEventKey,
  secretaryThread,
  withSecretaryHistory,
} from "../src/secretary.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});
const owner = "123",
  chat = "456",
  connectionId = "native-connection";
const connection = (enabled = true, reply = true) => ({
  id: connectionId,
  user: { id: 123 },
  user_chat_id: 123,
  date: 1,
  is_enabled: enabled,
  rights: { can_reply: reply, can_read_messages: true },
});
const message = (id: number, text = "can we talk?", patch: object = {}) => ({
  business_connection_id: connectionId,
  message_id: id,
  date: Math.floor(Date.now() / 1000),
  chat: { id: 456, type: "private", first_name: "Contact" },
  from: { id: 456 },
  text,
  ...patch,
});
async function fixture() {
  const dir = await mkdtemp("/tmp/aiko-secretary-");
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  let current = connection();
  let failSend = false;
  const sends: any[] = [],
    reads: any[] = [],
    prompts: InferRequest[] = [];
  const transport = async (url: string | URL | Request, init?: RequestInit) => {
    const method = String(url).split("/").at(-1),
      body = JSON.parse(String(init?.body));
    if (method === "getBusinessConnection")
      return Response.json({ ok: true, result: current });
    if (method === "sendMessage") {
      sends.push(body);
      if (failSend) throw new Error("uncertain network");
    }
    if (method === "readBusinessMessage") reads.push(body);
    return Response.json({
      ok: true,
      result: { message_id: 901 + sends.length },
    });
  };
  const telegram = createTelegram({
    token: "1:fixture",
    secret: "secret",
    allowedUsers: new Set([owner]),
    fetch: transport,
  });
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "secretary" } }),
    react: (r: InferRequest) => {
      prompts.push(r);
      return Effect.succeed({
        kind: "complete" as const,
        output: "yep, what's up?",
      });
    },
  });
  const options = () => ({
    database: join(dir, "root.sqlite"),
    threadDatabase: (t: string) => accountThreadDatabase(dir, t),
    actorName: "aiko",
    actorInstance: "fixture",
    keyOf: secretaryEventKey,
    actorFor: (t: string) =>
      threadBinding(t)?.role === "secretary"
        ? createSecretaryActor({
            owner: threadBinding(t)!.owner,
            read: () => host.read(t),
            redact: (s) => s,
            telegram: secretaryTelegram("1:fixture", transport),
          })
        : undefined,
    layersFor: () => withSecretaryHistory(model),
  });
  let host: BunHost = await createBunHost(options());
  cleanups.push(() => host.close());
  async function receive(update_id: number, value: object) {
    const result = await telegram.receive(
      new Request("http://localhost/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        body: JSON.stringify({ update_id, ...value }),
      }),
    );
    if (result.inbound)
      return acceptSecretary(host, result.inbound.user, result.inbound);
    return "ignored";
  }
  const api = (path = "", body?: object, user = owner) =>
    secretaryApi(
      new Request(`http://localhost/api/secretary${path}`, {
        method: body ? "POST" : "GET",
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      user,
      host,
      (s) => s,
    );
  const approve = async (enabled = true) => {
    const r = await api("/contact", { connectionId, chat, enabled });
    expect(r.status).toBe(200);
  };
  await receive(1, { business_connection: current });
  await receive(2, { business_message: message(1) });
  return {
    get host() {
      return host;
    },
    receive,
    api,
    approve,
    telegram,
    sends,
    reads,
    prompts,
    revoke: () => {
      current = connection(false);
    },
    failSend: () => {
      failSend = true;
    },
    restart: async () => {
      await host.close();
      host = await createBunHost(options());
    },
    events: () => host.read(secretaryThread(owner)),
  };
}

test("native connection + approval + owner history produce automatic replies; approval survives restart", async () => {
  const f = await fixture();
  await f.host.drive();
  expect(f.prompts).toHaveLength(0);
  expect(f.sends).toHaveLength(0);
  await f.receive(3, {
    business_message: message(2, "hey! yep yep", { from: { id: 123 } }),
  });
  await f.approve();
  await f.restart();
  await f.receive(4, { business_message: message(3) });
  await f.host.drive();
  expect(f.sends).toEqual([
    {
      business_connection_id: connectionId,
      chat_id: chat,
      text: "yep, what's up?",
      link_preview_options: { is_disabled: true },
    },
  ]);
  expect(f.reads[0].business_connection_id).toBe(connectionId);
  const input = f.prompts[0].trajectory.find(
    (e) => e.type === "MessageReceived",
  )!;
  expect(JSON.parse(String(input.text)).voice.examples[0].text).toBe(
    "hey! yep yep",
  );
  expect(f.prompts[0].tools).toHaveLength(0);
  expect(
    (await f.events()).some((e) => /Approval|ControlReply/.test(e.type)),
  ).toBe(false);
  expect(await f.receive(4, { business_message: message(3) })).toBe(
    "duplicate",
  );
  await f.receive(5, { business_message: message(4, "another message") });
  await f.host.drive();
  expect(f.sends).toHaveLength(2);
  await f.approve(false);
  await f.receive(6, { business_message: message(5) });
  await f.host.drive();
  expect(f.sends).toHaveLength(2);
});

test("revoked provider rights are checked immediately before sending", async () => {
  const f = await fixture();
  await f.approve();
  await f.receive(3, { business_message: message(2) });
  f.revoke();
  await f.host.drive();
  expect(f.sends).toHaveLength(0);
  expect(
    (await f.events()).find((e) => e.type === "AikoSecretarySettled")?.status,
  ).toBe("skipped");
});

test("deleted, edited, stale, bot, media, owner-takeover and paused messages do not send", async () => {
  const f = await fixture();
  await f.approve();
  await f.receive(3, { business_message: message(2) });
  await f.receive(4, {
    deleted_business_messages: {
      business_connection_id: connectionId,
      chat: { id: 456 },
      message_ids: [2],
    },
  });
  await f.receive(5, { business_message: message(3) });
  await f.receive(6, { edited_business_message: message(3, "never mind") });
  await f.receive(7, {
    business_message: message(4, "old", {
      date: Math.floor(Date.now() / 1000) - 86401,
    }),
  });
  await f.receive(8, {
    business_message: message(5, "echo", { sender_business_bot: { id: 999 } }),
  });
  await f.receive(9, {
    business_message: message(6, "caption", { photo: [{ file_id: "photo" }] }),
  });
  await f.host.drive();
  expect(f.sends).toHaveLength(0);
  await f.receive(10, { business_message: message(7) });
  await f.receive(11, {
    business_message: message(8, "i got this", { from: { id: 123 } }),
  });
  await f.host.drive();
  expect(f.sends).toHaveLength(0);
  await f.receive(12, { business_message: message(9) });
  await f.approve(false);
  await f.approve(true);
  await f.host.drive();
  expect(f.sends).toHaveLength(0);
});

test("uncertain sends and crash markers never retry after restart", async () => {
  const f = await fixture();
  await f.approve();
  f.failSend();
  await f.receive(3, { business_message: message(2) });
  await f.host.drive();
  expect(f.sends).toHaveLength(1);
  await f.restart();
  await f.host.drive();
  expect(f.sends).toHaveLength(1);
  await f.receive(4, { business_message: message(3) });
  await f.host.seed(secretaryThread(owner), [
    event("MessageReceived", { id: "secretary:telegram:4", text: "fixture" }),
    event("TurnCompleted", {
      turn: "secretary:telegram:4",
      output: "draft",
      epoch: 0,
    }),
    event("AikoSecretaryDispatch", { id: "telegram:4" }),
  ]);
  await f.host.drive();
  expect(f.sends).toHaveLength(1);
  expect(
    (await f.events())
      .filter((e) => e.type === "AikoSecretarySettled")
      .every((e) => e.status === "unknown"),
  ).toBe(true);
});

test("contact history is isolated; authenticated exports enforce chat and owner identities", async () => {
  const f = await fixture();
  const history = {
    id: 456,
    type: "personal_chat",
    name: "Contact",
    messages: [
      {
        id: 10,
        type: "message",
        from_id: "user123",
        date_unixtime: String(Math.floor(Date.now() / 1000) - 60),
        text: ["hey ", { type: "bold", text: "friend" }],
      },
    ],
  };
  expect(
    (await f.api("/history", { connectionId, chat, history })).status,
  ).toBe(200);
  expect(
    (await f.api("/history", { connectionId, chat: "789", history })).status,
  ).toBe(400);
  expect(
    (
      await f.api("/history", {
        connectionId,
        chat,
        history: {
          ...history,
          messages: [{ ...history.messages[0], from_id: "user789" }],
        },
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.api("/contact", { connectionId, chat, enabled: true }, "789"))
      .status,
  ).toBe(404);
  await f.receive(3, {
    business_message: message(20, "another contact secret", {
      chat: { id: 789, type: "private" },
      from: { id: 789 },
    }),
  });
  await f.approve();
  await f.receive(4, { business_message: message(21) });
  await f.host.drive();
  expect(JSON.stringify(f.prompts[0].trajectory)).toContain("hey friend");
  expect(JSON.stringify(f.prompts[0].trajectory)).not.toContain(
    "another contact secret",
  );
  expect((await f.api()).status).toBe(200);
});

test("normalization preserves business routing through polling, redacts history, rejects foreign owners and groups", async () => {
  const f = await fixture();
  const body = { update_id: 20, business_message: message(20, "sensitive") };
  const request = (value: object, secret = "secret") =>
    new Request("http://localhost/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(value),
    });
  expect((await f.telegram.receive(request(body, "wrong"))).status).toBe(401);
  const inbound = (await f.telegram.receive(request(body))).inbound!;
  const redacted = redactTelegramInbound(inbound, (s) =>
    s.replace("sensitive", "[redacted]"),
  );
  const roundtrip = (
    await f.telegram.receive(
      request(JSON.parse(serializeTelegramInbound(redacted))),
    )
  ).inbound!;
  expect(roundtrip.secretary).toEqual(redacted.secretary);
  expect(roundtrip.user).toBe(owner);
  expect(
    await f.receive(21, {
      business_connection: { ...connection(), user: { id: 789 } },
    }),
  ).toBe("ignored");
  await f.receive(22, {
    business_message: message(22, "group", {
      chat: { id: -999, type: "group", title: "Group" },
    }),
  });
  expect(
    (await f.api("/contact", { connectionId, chat: "-999", enabled: true }))
      .status,
  ).toBe(422);
});

test("Bun service exposes secretary API with account credentials and isolates business updates from foreground", async () => {
  const { createService } = await import("../src/server.ts");
  const { PERSONA } = await import("../src/config.ts");
  const { credentialDigest } = await import("../src/plane-auth.ts");
  const stateDir = await mkdtemp("/tmp/aiko-secretary-service-");
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const service = await createService(
    {
      stateDir,
      mode: "demo",
      port: 4242,
      operatorToken: "operator-secretary-test-123456789012345",
      persona: PERSONA,
      voiceEnabled: false,
      allowedUsers: new Set([owner]),
      botToken: "1:fixture",
      webhookSecret: "secret",
      planeCredentials: [
        {
          account: owner,
          digest: credentialDigest("fixture-owner-token"),
          scopes: ["read", "write"],
        },
        {
          account: owner,
          digest: credentialDigest("fixture-reader-token"),
          scopes: ["read"],
        },
      ],
    },
    {
      telegramFetch: async () =>
        Response.json({ ok: true, result: connection() }),
    },
  );
  cleanups.push(() => service.close());
  const webhook = (update_id: number, value: object) =>
    service.fetch(
      new Request("http://127.0.0.1/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        body: JSON.stringify({ update_id, ...value }),
      }),
    );
  expect((await webhook(1, { business_connection: connection() })).status).toBe(
    200,
  );
  expect(
    (
      await webhook(2, {
        business_message: message(1, "/secretary approve 456"),
      })
    ).status,
  ).toBe(200);
  expect(await service.host.read("user-123")).toHaveLength(0);
  const api = (token: string, body?: object) =>
    service.fetch(
      new Request(`http://127.0.0.1/api/secretary${body ? "/contact" : ""}`, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${token}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  expect((await api("wrong-token")).status).toBe(401);
  expect(
    (await api("fixture-reader-token", { connectionId, chat, enabled: true }))
      .status,
  ).toBe(403);
  expect(
    (await api("fixture-owner-token", { connectionId, chat, enabled: true }))
      .status,
  ).toBe(200);
  const state = (await (await api("fixture-owner-token")).json()) as any;
  expect(state.chats[0].enabled).toBe(true);
});

test("the same Telegram message cannot get a second reply through a new update ID", async () => {
  const f = await fixture();
  await f.approve();
  const incoming = message(22);
  await f.receive(22, { business_message: incoming });
  await f.host.drive();
  await f.receive(23, { business_message: incoming });
  await f.host.drive();
  expect(f.sends).toHaveLength(1);
});
