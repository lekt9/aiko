import { describe, expect, test } from "bun:test";
import { createTelegram } from "../src/telegram.ts";
import {
  normalizeTelegramUpdate,
  redactTelegramInbound,
  serializeTelegramInbound,
  TELEGRAM_ALLOWED_UPDATES,
} from "../src/telegram-normalize.ts";
import {
  createTelegramMedia,
  TELEGRAM_MEDIA_LIMITS,
  type TelegramMediaDescriptor,
  type TelegramMediaKind,
} from "../src/telegram-media.ts";
import { createTelegramOutbound, telegramDraftReady } from "../src/telegram-outbound.ts";
import { createService } from "../src/server.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { demoInference } from "../src/actor.ts";
import { createTelegramPoller, telegramApi } from "../src/telegram-polling.ts";
import type { AikoConfig } from "../src/config.ts";
import { createTelegramVision } from "../src/telegram-tools.ts";

const signal = () => new AbortController().signal;
const options = {
  token: "synthetic-bot-token-never-real",
  secret: "fixture-webhook-secret-only",
  allowedUsers: new Set(["123"]),
};
const update = (body: Record<string, unknown>) => ({
  update_id: 42,
  message: {
    message_id: 9,
    date: 1_700_000_000,
    from: { id: 123, is_bot: false },
    chat: { id: 123, type: "private" },
    ...body,
  },
});
const file = (id = "file_one") => ({
  file_id: id,
  file_unique_id: "unique_" + id,
  file_size: 12,
  mime_type: "image/png",
  file_name: "test.png",
});
const descriptor = (
  kind: TelegramMediaKind = "photo",
): TelegramMediaDescriptor => ({
  owner: "123",
  kind,
  fileId: "file_one",
  mimeType: kind === "voice" ? "audio/ogg" : "image/png",
});
const jpeg = new Uint8Array([255, 216, 255, 0, 1, 2, 3]);
const normalize = (input: unknown) =>
  normalizeTelegramUpdate(input, { ...options, receivedAt: 500 }).inbound!;
function downloads(
  bytes: Uint8Array = jpeg,
  metadata: Record<string, unknown> = {},
) {
  const requests: string[] = [];
  return {
    requests,
    fetch: async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      return url.endsWith("/getFile")
        ? Response.json({
            ok: true,
            result: {
              file_id: "file_one",
              file_path: "photos/photo_1.jpg",
              ...metadata,
            },
          })
        : new Response(bytes.slice().buffer);
    },
  };
}
describe("verified Telegram multimodal normalization", () => {
  test("native location, venue, contact and poll cards reach the actor without raw provider fields", () => {
    for (const [card, expected] of [
      [{location:{latitude:1.3,longitude:103.8}}, "Shared location: 1.3, 103.8"],
      [{venue:{location:{latitude:1.3,longitude:103.8},title:"Library",address:"Main Street"}}, "Shared venue: 1.3, 103.8; Library; Main Street"],
      [{contact:{phone_number:"+123456789",first_name:"Sam",vcard:"private-vcard-omitted"}}, "Shared contact: Sam; +123456789"],
      [{poll:{question:"Lunch?",options:[{text:"Soup"},{text:"Salad"}]}}, "Shared poll: Lunch?"],
    ] as const) {
      const inbound = normalize(update(card));
      expect(inbound.text).toContain(expected);
      const persisted = serializeTelegramInbound(inbound);
      expect(persisted).not.toContain("private-vcard-omitted");
      expect(normalize(JSON.parse(persisted))).toEqual(inbound);
    }
    expect(normalize(update({location:{latitude:100,longitude:20}}))).toBeUndefined();
    expect(normalize(update({contact:{first_name:"Sam",phone_number:"invalid",vcard:"private"}}))).toBeUndefined();
  });
  test("every supported kind preserves descriptors through durable polling serialization", () => {
    for (const kind of [
      "photo",
      "video",
      "voice",
      "audio",
      "video_note",
      "document",
      "sticker",
      "animation",
    ] as const) {
      const input = normalize(
        update({
          [kind]:
            kind === "photo"
              ? [
                  { ...file("small"), width: 20, height: 20 },
                  { ...file("large"), width: 400, height: 400 },
                ]
              : file(),
          caption: "Explain this",
          media_group_id: "album_11",
        }),
      );
      expect(input.media?.[0]?.kind).toBe(kind);
      expect(input.text).toBe("Explain this");
      expect(input.messageId).toBe(9);
      expect(input.sentAt).toBe(1_700_000_000_000);
      expect(normalize(JSON.parse(serializeTelegramInbound(input)))).toEqual(
        input,
      );
    }
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("callback_query");
    expect(TELEGRAM_ALLOWED_UPDATES).toContain("message_reaction");
  });
  test("photo resolutions are one image and animation's compatibility document is not duplicated", () => {
    expect(
      normalize(
        update({
          photo: [
            { ...file("tiny"), width: 10, height: 10 },
            { ...file("large"), width: 600, height: 600 },
          ],
        }),
      ).media?.map((item) => item.fileId),
    ).toEqual(["large"]);
    expect(
      normalize(update({ animation: file("gif"), document: file("gif") }))
        .media,
    ).toHaveLength(1);
  });
  test("captionless voice and reply media are accepted and redacted before persistence", () => {
    const inbound = normalize(
      update({
        voice: {
          ...file(),
          mime_type: "audio/ogg",
          file_name: "secret-key.ogg",
        },
        reply_to_message: {
          message_id: 4,
          chat: { id: 123, type: "private" },
          from: { id: 123 },
          caption: "secret-key",
          photo: [file("reply_photo")],
        },
      }),
    );
    expect(inbound.text).toBe("[voice attachment]");
    expect(inbound.replyTo?.media?.[0]?.owner).toBe("123");
    const safe = redactTelegramInbound(inbound, (text) =>
      text.replaceAll("secret-key", "[redacted]"),
    );
    expect(serializeTelegramInbound(safe)).not.toContain("secret-key");
    expect(safe.media?.[0]?.fileId).toBe("file_one");
  });
  test("group, forwarded, bot and cross-owner updates cannot select an account", () => {
    for (const patch of [
      { chat: { id: 123, type: "group" } },
      { chat: { id: 456, type: "private" } },
      { from: { id: 456, is_bot: false } },
      { from: { id: 123, is_bot: true } },
      { forward_origin: { type: "user" } },
      { via_bot: { id: 999 } },
    ])
      expect(
        normalizeTelegramUpdate(update({ text: "hello", ...patch }), options)
          .inbound,
      ).toBeUndefined();
  });
  test("callbacks map only known controls, preserve opaque payload, and reject cross-chat or oversized bytes", () => {
    const base = {
      update_id: 43,
      callback_query: {
        id: "cb1",
        from: { id: 123, is_bot: false },
        message: { message_id: 12, chat: { id: 123, type: "private" } },
        data: "aiko:cancel",
      },
    };
    expect(normalize(base).text).toBe("/cancel");
    expect(
      normalize(JSON.parse(serializeTelegramInbound(normalize(base)))),
    ).toEqual(normalize(base));
    expect(
      normalize({
        ...base,
        callback_query: { ...base.callback_query, data: "custom:choice" },
      }).text,
    ).toBe("[Telegram button selected]");
    expect(
      normalizeTelegramUpdate(
        {
          ...base,
          callback_query: { ...base.callback_query, data: "🐢".repeat(20) },
        },
        options,
      ).inbound,
    ).toBeUndefined();
    expect(
      normalizeTelegramUpdate(
        {
          ...base,
          callback_query: { ...base.callback_query, from: { id: 456 } },
        },
        options,
      ).inbound,
    ).toBeUndefined();
  });
  test("private reactions preserve message ID and webhook authentication precedes decoding", async () => {
    const incoming = {
      update_id: 45,
      message_reaction: {
        chat: { id: 123, type: "private" },
        user: { id: 123 },
        message_id: 9,
        new_reaction: [{ type: "emoji", emoji: "👍" }],
      },
    };
    const value = normalize(incoming);
    expect(value.reaction).toEqual({ messageId: 9, emoji: ["👍"] });
    expect(normalize(JSON.parse(serializeTelegramInbound(value)))).toEqual(
      value,
    );
    const tg = createTelegram(options),
      body = JSON.stringify(update({ photo: [file()] }));
    expect(
      (
        await tg.receive(
          new Request("http://fixture/telegram", { method: "POST", body }),
        )
      ).status,
    ).toBe(401);
    const accepted = await tg.receive(
      new Request("http://fixture/telegram", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": options.secret },
        body,
      }),
    );
    expect(accepted.inbound?.media?.[0]?.fileId).toBe("file_one");
  });
});
describe("private bounded media processing", () => {
  test("getFile and image bytes stay private; no URL is returned or persisted", async () => {
    const transport = downloads(),
      media = createTelegramMedia({ ...options, fetch: transport.fetch });
    const result = await media.process("123", descriptor(), signal());
    expect(result.status).toBe("processed");
    expect(result.images?.[0]?.mimeType).toBe("image/jpeg");
    expect(result.images?.[0]?.data).toEqual(jpeg);
    expect(JSON.stringify(result)).not.toContain(options.token);
    expect(transport.requests).toHaveLength(2);
  });
  test("owner checks, announced limits, traversal, streaming overflow and provider errors are closed", async () => {
    const transport = downloads(),
      media = createTelegramMedia({ ...options, fetch: transport.fetch });
    expect((await media.process("456", descriptor(), signal())).status).toBe(
      "failed",
    );
    expect(transport.requests).toHaveLength(0);
    expect(
      (
        await media.process(
          "123",
          { ...descriptor(), size: TELEGRAM_MEDIA_LIMITS.downloadBytes + 1 },
          signal(),
        )
      ).reason,
    ).toBe("telegram_media_too_large");
    expect(transport.requests).toHaveLength(0);
    for (const path of [
      "../private",
      "https://example.com",
      "photos/x?secret=1",
      "/absolute",
    ]) {
      const f = downloads(jpeg, { file_path: path });
      expect(
        (
          await createTelegramMedia({ ...options, fetch: f.fetch }).process(
            "123",
            descriptor(),
            signal(),
          )
        ).status,
      ).toBe("failed");
      expect(f.requests).toHaveLength(1);
    }
    const overflow = downloads(new Uint8Array(12));
    expect(
      (
        await createTelegramMedia({
          ...options,
          maxBytes: 8,
          fetch: overflow.fetch,
        }).process("123", descriptor(), signal())
      ).reason,
    ).toBe("telegram_media_too_large");
    const errors = createTelegramMedia({
      ...options,
      fetch: async () => {
        throw new Error("private URL " + options.token);
      },
    });
    expect(
      JSON.stringify(await errors.process("123", descriptor(), signal())),
    ).not.toContain(options.token);
  });
  test("voice is honestly unsupported without transcriber; injected processor receives owned bytes", async () => {
    const transport = downloads(new Uint8Array([1, 2, 3]));
    expect(
      (
        await createTelegramMedia({
          ...options,
          fetch: transport.fetch,
        }).process("123", descriptor("voice"), signal())
      ).reason,
    ).toBe("transcription_not_configured");
    let calls = 0;
    const media = createTelegramMedia({
      ...options,
      fetch: transport.fetch,
      processor: async (input) => {
        calls++;
        expect(input.owner).toBe("123");
        expect(input.media.fileId).toBe("file_one");
        expect(input.bytes).toEqual(new Uint8Array([1, 2, 3]));
        return {
          status: "processed",
          text: "a " + options.token + " transcript",
        };
      },
    });
    const result = await media.process("123", descriptor("voice"), signal());
    expect(calls).toBe(1);
    expect(result.text).toBe("a [redacted] transcript");
  });
  test("getFile may renew file_id; stable unique ID mismatch is rejected", async () => {
    const alias = downloads(jpeg, {
      file_id: "renewed_id",
      file_unique_id: "stable",
    });
    expect(
      (
        await createTelegramMedia({ ...options, fetch: alias.fetch }).process(
          "123",
          { ...descriptor(), uniqueId: "stable" },
          signal(),
        )
      ).status,
    ).toBe("processed");
    expect(
      (
        await createTelegramMedia({ ...options, fetch: alias.fetch }).process(
          "123",
          { ...descriptor(), uniqueId: "foreign" },
          signal(),
        )
      ).status,
    ).toBe("failed");
  });
});
describe("rich outbound adapters", () => {
  test("Worker fetch redirect mode is manual and redirects never carry credentials to another origin", async () => {
    const modes: (RequestRedirect | undefined)[] = [];
    const transport = async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      modes.push(init?.redirect);
      if (init?.redirect === "error")
        throw new TypeError(
          "Invalid redirect value. Workers accepts follow or manual only.",
        );
      return Response.json(
        { ok: true, result: { message_id: 99 } },
        {
          status: 302,
          headers: { location: "https://untrusted.invalid/steal" },
        },
      );
    };
    const tg = createTelegram({ ...options, fetch: transport });
    expect((await tg.send("123", "Text", signal())).status).toBe("unknown");
    expect(
      (
        await tg.sendRich(
          "123",
          { kind: "photo", file: { owner: "123", fileId: "file_one" } },
          signal(),
        )
      ).status,
    ).toBe("unknown");
    expect((await tg.media.process("123", descriptor(), signal())).status).toBe(
      "failed",
    );
    const vision = createTelegramVision({
      apiKey: "fixture-vision-key",
      model: "fixture-model",
      fetch: transport,
    });
    await expect(
      vision({
        owner: "123",
        question: "Describe",
        signal: signal(),
        images: [
          { mimeType: "image/jpeg", data: jpeg, sourceFileId: "file_one" },
        ],
      }),
    ).rejects.toThrow("vision_unavailable");
    await expect(
      telegramApi(options.token, "getUpdates", {}, signal(), transport),
    ).rejects.toThrow("Telegram getUpdates failed");
    expect(modes).toEqual(["manual", "manual", "manual", "manual", "manual"]);
  });
  test("file IDs and uploads use their native methods; no arbitrary media URL", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const tg = createTelegramOutbound({
      ...options,
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: init?.body });
        return Response.json({ ok: true, result: { message_id: 10 } });
      },
    });
    for (const kind of [
      "photo",
      "video",
      "voice",
      "audio",
      "video_note",
      "document",
      "sticker",
      "animation",
    ] as const)
      expect(
        (
          await tg.sendRich(
            "123",
            { kind, file: { owner: "123", fileId: "file_one" } },
            signal(),
          )
        ).status,
      ).toBe("delivered");
    expect(calls.map((item) => item.url.split("/").at(-1))).toEqual([
      "sendPhoto",
      "sendVideo",
      "sendVoice",
      "sendAudio",
      "sendVideoNote",
      "sendDocument",
      "sendSticker",
      "sendAnimation",
    ]);
    expect(
      (
        await tg.sendRich(
          "123",
          {
            kind: "voice",
            file: {
              owner: "123",
              bytes: new Uint8Array([1, 2]),
              mimeType: "audio/ogg",
              fileName: "voice.ogg",
            },
          },
          signal(),
        )
      ).status,
    ).toBe("delivered");
    expect(calls.at(-1)?.body).toBeInstanceOf(FormData);
    const before = calls.length;
    expect(
      (
        await tg.sendRich(
          "123",
          { kind: "photo", file: { owner: "456", fileId: "file_one" } },
          signal(),
        )
      ).status,
    ).toBe("rejected");
    expect(
      (
        await tg.sendRich(
          "123",
          {
            kind: "photo",
            file: { owner: "123", fileId: "https://evil.invalid/private" },
          },
          signal(),
        )
      ).status,
    ).toBe("rejected");
    expect(calls).toHaveLength(before);
  });
  test("Mini App buttons allow only the approved entry point and a connection selector", async () => {
    const miniAppUrl = "https://aiko.example/connect";
    const calls: any[] = [];
    const tg = createTelegramOutbound({
      ...options,
      miniAppUrl,
      fetch: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true, result: { message_id: 10 } });
      },
    });
    const send = (button: any) => tg.sendRich("123", {
      kind: "text", text: "Connect your apps", buttons: [[button]],
    }, signal());
    expect((await send({ text: "Connect apps", webAppUrl: miniAppUrl })).status).toBe("delivered");
    expect(calls[0].reply_markup.inline_keyboard).toEqual([
      [{ text: "Connect apps", web_app: { url: miniAppUrl } }],
    ]);
    const selected = miniAppUrl + "?connection=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect((await send({ text: "Sign in", webAppUrl: selected })).status).toBe("delivered");
    expect(calls[1].reply_markup.inline_keyboard[0][0]).toEqual({ text: "Sign in", web_app: { url: selected } });
    for (const button of [
      ...["&redirect=https://other.example", "&connection=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "#secret"].map(suffix => ({text:"Sign in",webAppUrl:selected+suffix})),
      {text:"Sign in",webAppUrl:miniAppUrl+"?connection=secret"},
      {text:"Sign in",webAppUrl:"https://aiko.example/other?connection=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"},
      { text: "Connect", webAppUrl: "https://other.example/connect" },
      { text: "Connect", webAppUrl: miniAppUrl + "?redirect=https://other.example" },
      { text: "Connect", webAppUrl: miniAppUrl, url: miniAppUrl },
      { text: "Connect", webAppUrl: miniAppUrl, callbackData: "" },
      { text: "Connect", webAppUrl: "http://aiko.example/connect" },
      { text: "Connect", webAppUrl: "https://user:password@aiko.example/connect" },
      { text: "Connect", webAppUrl: "" },
      { text: "Connect", webAppUrl: [miniAppUrl] },
      { text: "Connect", callbackData: 123 },
      { text: 123, webAppUrl: miniAppUrl },
      null,
      [],
      { text: "Connect" },
    ]) expect((await send(button)).status).toBe("rejected");
    expect(calls).toHaveLength(2);
    const unconfigured = createTelegramOutbound({ ...options, fetch: async () => {
      throw new Error("must not send");
    } });
    expect((await unconfigured.sendRich("123", {
      kind: "text", text: "Connect", buttons: [[{ text: "Connect", webAppUrl: miniAppUrl }]],
    }, signal())).status).toBe("rejected");
  });
  test("album requires complete receipt and compatible native types; captions/reply/buttons are native", async () => {
    let sent: any;
    const tg = createTelegramOutbound({
      ...options,
      fetch: async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return Response.json({
          ok: true,
          result: sent.media
            ? [{ message_id: 11 }, { message_id: 12 }]
            : { message_id: 10 },
        });
      },
    });
    const file = { owner: "123", fileId: "file_one" };
    expect(
      (
        await tg.sendRich(
          "123",
          {
            kind: "album",
            items: [
              { kind: "photo", file },
              { kind: "video", file },
            ],
          },
          signal(),
        )
      ).providerIds,
    ).toEqual(["11", "12"]);
    expect(
      (
        await tg.sendRich(
          "123",
          { kind: "album", items: [{ kind: "photo", file }] },
          signal(),
        )
      ).status,
    ).toBe("rejected");
    expect(
      (
        await tg.sendRich(
          "123",
          {
            kind: "album",
            items: [
              { kind: "audio", file },
              { kind: "photo", file },
            ],
          },
          signal(),
        )
      ).status,
    ).toBe("rejected");
    await tg.sendRich(
      "123",
      {
        kind: "photo",
        file,
        caption: "hello",
        replyTo: 8,
        buttons: [[{ text: "Stop", callbackData: "aiko:cancel" }]],
      },
      signal(),
    );
    expect(sent.caption).toBe("hello");
    expect(sent.reply_parameters.message_id).toBe(8);
    expect(sent.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      "aiko:cancel",
    );
  });
  test("uncertain sends are never retried and typing stops after abort", async () => {
    let calls = 0;
    const tg = createTelegramOutbound({
      ...options,
      fetch: async () => {
        calls++;
        throw new Error(options.token);
      },
    });
    expect(
      (await tg.sendRich("123", { kind: "text", text: "hello" }, signal()))
        .status,
    ).toBe("unknown");
    expect(calls).toBe(1);
    const controller = new AbortController(),
      stop = tg.typing("123", controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await stop();
    expect(calls).toBe(2);
    const already = new AbortController();
    already.abort();
    await tg.typing("123", already.signal)();
    expect(calls).toBe(2);
  });
});

test("Bun host preserves redacted media through native admission and runs only explicitly injected processors", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-telegram-ingress-");
  let processed = 0;
  const service = await createService(
    {
      mode: "demo",
      port: 4242,
      stateDir,
      operatorToken: "fixture-private-control-token-123456",
      persona: "fixture",
      voiceEnabled: false,
      botToken: options.token,
      webhookSecret: options.secret,
      allowedUsers: options.allowedUsers,
    },
    {
      model: Layer.succeed(Infer, {
        resolve: () => ({ model: { provider: "fixture", model_id: "media" } }),
        react: (request) =>
          Effect.succeed(
            request.trajectory.some(
              (e) =>
                e.type === "ToolReturned" && e.turn === request.identity.turn,
            )
              ? { kind: "complete" as const, output: "Media inspected." }
              : {
                  kind: "call" as const,
                  name: "telegram_inspect",
                  callId: "inspect-owned",
                  arguments: { fileId: "file_one" },
                },
          ),
      }),
      backgroundModel: demoInference,
      telegramMedia: (owner) => ({
        processor: async (input) => {
          processed++;
          expect(owner).toBe("123");
          expect(input.owner).toBe(owner);
          return { status: "processed", text: "Fixture decoded text." };
        },
      }),
      telegramFetch: async (url) =>
        String(url).endsWith("getFile")
          ? Response.json({
              ok: true,
              result: { file_id: "file_one", file_path: "photos/p.jpg" },
            })
          : String(url).includes("/file/bot")
            ? new Response(jpeg.slice().buffer)
            : String(url).endsWith("sendChatAction")
              ? Response.json({ ok: true, result: true })
              : Response.json({ ok: true, result: { message_id: 99 } }),
    },
  );
  const request = (body: unknown) =>
    new Request("http://127.0.0.1:4242/telegram/webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": options.secret },
      body: JSON.stringify(body),
    });
  try {
    const input = update({
      photo: [file()],
      caption: "Read " + options.token,
      media_group_id: "album123",
    });
    expect(await service.acceptTelegram(request(input))).toBe("accepted");
    await service.host.drive();
    const log = await service.host.read("user-123"),
      message = log.find((e) => e.type === "MessageReceived") as any;
    expect(message.media[0].fileId).toBe("file_one");
    expect(message.telegram.caption).toContain("[redacted]");
    expect(message.telegram.mediaGroupId).toBe("album123");
    expect(JSON.stringify(log)).not.toContain(options.token);
    expect(processed).toBe(1);
    expect(await service.acceptTelegram(request(input))).toBe("duplicate");
    expect(
      await service.acceptTelegram(
        request(
          update({
            photo: [file("changed")],
            caption: "Read " + options.token,
            media_group_id: "album123",
          }),
        ),
      ),
    ).toBe("conflict");
    expect(
      await service.acceptTelegram(
        request({
          ...update({ photo: [file()], caption: "/cancel" }),
          update_id: 43,
        }),
      ),
    ).toBe("accepted");
    await service.host.drive();
    expect(
      (await service.host.read("user-123")).some(
        (e) => e.type === "MessageReceived" && e.id === "telegram:43",
      ),
    ).toBe(true);
  } finally {
    await service.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}, 30_000);

test("durable polling forwards complete media and callbacks without text-only reconstruction", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-telegram-rich-polling-");
  const bodies: any[] = [];
  let polls = 0;
  const media = update({
    photo: [file()],
    caption: "caption",
    media_group_id: "album",
    reply_to_message: { message_id: 3, text: "Reply context" },
  });
  const callback = {
    update_id: 43,
    callback_query: {
      id: "callback-cancel",
      data: "aiko:cancel",
      from: { id: 123, is_bot: false },
      message: { message_id: 9, chat: { id: 123, type: "private" } },
    },
  };
  const poller = createTelegramPoller(
    {
      stateDir,
      botToken: options.token,
      webhookSecret: options.secret,
    } as AikoConfig,
    {
      prepareTelegram: async (request) =>
        normalizeTelegramUpdate(await request.json(), options).inbound,
      acceptTelegram: async (request) => {
        bodies.push(await request.json());
        return "accepted";
      },
    },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.allowed_updates).toContain("callback_query");
      return Response.json({
        ok: true,
        result: polls++ === 0 ? [media] : [callback],
      });
    },
  );
  try {
    await poller.pollOnce();
    await poller.pollOnce();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].message.photo[0].file_id).toBe("file_one");
    expect(bodies[0].message.caption).toBe("caption");
    expect(bodies[0].message.media_group_id).toBe("album");
    expect(bodies[0].message.reply_to_message.text).toBe("Reply context");
    expect(bodies[1].callback_query.data).toBe("aiko:cancel");
  } finally {
    await poller.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("long text uses one rich message and provider errors have safe actionable receipts", async () => {
  const calls: {method:string; body:any}[]=[];
  const tg = createTelegramOutbound({token:"123:fixture",allowedUsers:new Set(["123"]),fetch:async(url,init)=>{
    calls.push({method:String(url).split("/").at(-1)!,body:JSON.parse(String(init?.body))});
    return Response.json({ok:true,result:{message_id:99}});
  }});
  const text="Read <this> & keep the full answer. ".repeat(160);
  expect(await tg.sendRich("123",{kind:"text",text,replyTo:42,messageThreadId:7},new AbortController().signal)).toMatchObject({status:"delivered",providerId:"99"});
  expect(calls).toEqual([{method:"sendRichMessage",body:{chat_id:"123",message_thread_id:7,reply_parameters:{message_id:42,allow_sending_without_reply:true},rich_message:{blocks:[{type:"paragraph",text}]}}}]);
  const limited=createTelegramOutbound({token:"123:fixture",allowedUsers:new Set(["123"]),fetch:async()=>Response.json({ok:false,description:"private details",parameters:{retry_after:9}},{status:429})});
  expect(await limited.sendRich("123",{kind:"text",text:"hello"},new AbortController().signal)).toEqual({status:"rejected",reason:"rate_limited",retryAfter:9});
});

test("native coordinates, venue, contact and poll dispatch through their exact primitives", async () => {
  const methods:string[]=[];
  const tg=createTelegramOutbound({token:"123:fixture",allowedUsers:new Set(["123"]),fetch:async(url)=>{methods.push(String(url).split("/").at(-1)!);return Response.json({ok:true,result:{message_id:1}})}});
  for(const message of [{kind:"location",latitude:1.2,longitude:103.8},{kind:"venue",latitude:1.2,longitude:103.8,title:"Library",address:"Main Street"},{kind:"contact",phoneNumber:"+123456789",firstName:"Alex"},{kind:"poll",question:"Which day?",choices:["Monday","Tuesday"]}] as const)
    expect((await tg.sendRich("123",message as any,new AbortController().signal)).status).toBe("delivered");
  expect(methods).toEqual(["sendLocation","sendVenue","sendContact","sendPoll"]);
  expect((await tg.sendRich("123",{kind:"location",latitude:91,longitude:0},new AbortController().signal)).status).toBe("rejected");
  expect(methods).toHaveLength(4);
});

test("native Stop and topic context survive durable normalization without accepting foreign chats", () => {
  const policy={allowedUsers:new Set(["123"]),receivedAt:1000};
  const update={update_id:18,stopped_message_generation:{chat:{id:123,type:"private"},draft_id:71,message_thread_id:7}};
  const inbound=normalizeTelegramUpdate(update,policy).inbound!;
  expect(inbound).toMatchObject({user:"123",text:"/cancel",stoppedDraftId:71,messageThreadId:7,kind:"generation_stopped"});
  expect(normalizeTelegramUpdate(JSON.parse(serializeTelegramInbound(inbound)),policy).inbound).toEqual(inbound);
  expect(normalizeTelegramUpdate({...update,stopped_message_generation:{...update.stopped_message_generation,chat:{id:-123,type:"group"}}},policy).inbound).toBeUndefined();
});

test("generation drafts publish per paragraph or chunk, not per letter", async () => {
  expect(telegramDraftReady(undefined, "")).toBe(true);
  expect(telegramDraftReady("", "H")).toBe(false);
  expect(telegramDraftReady("", "Searching…")).toBe(true);
  expect(telegramDraftReady("H", "He")).toBe(false);
  expect(telegramDraftReady("Hello", "Hello world")).toBe(false);
  expect(telegramDraftReady("Hello", "Hello\nnext")).toBe(true);
  expect(telegramDraftReady("Hello", "Hello" + "x".repeat(96))).toBe(true);
  expect(telegramDraftReady("Searching…", "Working on your request…")).toBe(true);
  const methods: string[] = [];
  const bodies: string[] = [];
  const tg = createTelegramOutbound({
    token: "123:fixture",
    allowedUsers: new Set(["123"]),
    fetch: async (url, init) => {
      methods.push(String(url).split("/").at(-1)!);
      bodies.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: true });
    },
  });
  const signal = new AbortController().signal;
  expect((await tg.draft("123", 7, "", signal)).status).toBe("delivered");
  expect((await tg.draft("123", 7, "H", signal)).status).toBe("delivered");
  expect((await tg.draft("123", 7, "He", signal)).status).toBe("delivered");
  expect((await tg.draft("123", 7, "Hello\nworld", signal)).status).toBe("delivered");
  expect(methods).toEqual(["sendMessageDraft", "sendMessageDraft"]);
  expect(bodies).toEqual(["", "Hello\nworld"]);
});
