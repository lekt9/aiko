import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  infer,
  tool,
  Infer,
  outputValidateOnce,
} from "tardie";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import { createBunHost } from "tardie/bun/host";
import { createTelegramMedia } from "../src/telegram-media.ts";
import { createTelegramOutbound } from "../src/telegram-outbound.ts";
import {
  createTelegramTools,
  createTelegramTyping,
  createTelegramVision,
  telegramEventKey,
  type TelegramReceipt,
} from "../src/telegram-tools.ts";
import { voiceAndOutbox, event, type AikoEvent } from "../src/actor.ts";
import { createVoice, type ThinkFeelComposer } from "../src/voice.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
test("send_message shares durable send identity, uses ThinkFeel wording and never recomposes on replay", async () => {
  let compositions=0;
  const f=fixture(true,async()=>{compositions++;return {status:"ready",text:"Hey, here you go!",persona:"test-persona"};});
  const args={kind:"text",text:"Hello",final:true};
  const result=await f.run("send_message",args,"same-call");
  expect(result).toMatchObject({status:"delivered",reply:"Hey, here you go!",final:true});
  expect(f.events.some(e=>e.type==="AikoThinkFeelPrepared")).toBe(true);
  expect(await f.run("telegram_send",args,"same-call")).toEqual(result);
  expect(compositions).toBe(1);
});
test("ThinkFeel failures prevent Telegram sends and operator relays remain owner bound", async () => {
  const f=fixture(true,async()=>({status:"blocked",reason:"unavailable"}));
  expect(await f.run("send_message",{kind:"text",text:"Hello",final:true})).toMatchObject({status:"failed",reason:"thinkfeel_unavailable"});
  expect(f.calls).toHaveLength(0);
  const g=fixture(true,async text=>({status:"ready",text,persona:"test-persona"}));
  g.events[0]=incoming("turn-1","123",{source:"operator",sender:"operator",channel:"telegram"});
  expect((await g.run("send_message",{kind:"text",text:"Operator test",final:true})).status).toBe("delivered");
  g.events[0]=incoming("turn-2","123",{source:"plane",sender:"operator",channel:"telegram"});
  expect((await g.run("send_message",{kind:"text",text:"Bad relay"},"bad-call","user-123","turn-2")).status).toBe("rejected");
});
test("automation delivery uses the same owner-bound ThinkFeel tool path", async () => {
  const f = fixture(true, async text => ({status:"ready",text:`Persona: ${text}`,persona:"fixture"}));
  f.events[0] = incoming("automation:one", "123", {source:"automation",sender:"automation",channel:"telegram"});
  expect(await f.run("send_message", {kind:"text",text:"Scheduled finding",final:true}, "send-1", "user-123", "automation:one")).toMatchObject({status:"delivered",reply:"Persona: Scheduled finding"});
  f.events[0] = incoming("automation:two", "456", {source:"automation",sender:"automation",channel:"telegram"});
  expect((await f.run("send_message", {kind:"text",text:"Wrong owner"}, "send-2", "user-123", "automation:two")).status).toBe("rejected");
  expect(f.calls).toHaveLength(1);
});
test("unused text never bypasses media caption composition", async () => {
  for (const text of ["", "unused"]) {
    const f=fixture(true,async draft=>({status:"ready",text:`Persona: ${draft}`,persona:"test-persona"}));
    const result=await f.run("send_message",{kind:"photo",fileId:"owned_photo",text,caption:"Actual caption",final:true});
    expect(result).toMatchObject({status:"delivered",reply:"Persona: Actual caption"});
    expect(f.events.filter(e=>e.type==="AikoThinkFeelPrepared")).toHaveLength(1);
  }
});
test("voice synthesis receives ThinkFeel wording, never the raw draft", async () => {
  const f = fixture(true, async () => ({ status: "ready", text: "Persona speech", persona: "fixture" }));
  expect((await f.run("telegram_voice", { text: "Raw speech", final: true })).status).toBe("delivered");
  expect(f.spoken).toEqual(["Persona speech"]);
  const blocked = fixture(true, async () => ({ status: "blocked", reason: "unavailable" }));
  expect((await blocked.run("telegram_voice", { text: "Raw speech", final: true })).status).toBe("failed");
  expect(blocked.spoken).toEqual([]);
  expect(blocked.calls).toEqual([]);
});
test("progress drafts pass through ThinkFeel before Telegram", async () => {
  const f = fixture(true, async () => ({ status: "blocked", reason: "invalid_response" }));
  expect((await f.run("telegram_progress", { text: "Raw update", draftId: 1 })).status).toBe("failed");
  expect(f.calls).toEqual([]);
});
const photo = {
  owner: "123",
  kind: "photo" as const,
  fileId: "owned_photo",
  mimeType: "image/jpeg",
};
const incoming = (
  id = "turn-1",
  owner = "123",
  extra: Record<string, unknown> = {},
) =>
  event("MessageReceived", {
    id,
    text: "Please inspect this",
    source: "telegram",
    chat: owner,
    sender: owner,
    telegram: { messageId: 10, media: [{ ...photo, owner }] },
    ...extra,
  });
function fixture(capture = true, compose?: ThinkFeelComposer) {
  const events: AikoEvent[] = [incoming()],
    calls: string[] = [],
    activities: string[] = [],
    uploads: FormData[] = [],
    spoken: string[] = [];
  let status: "delivered" | "unknown" | "rejected" = "delivered",
    processed = 0,
    visionCalls = 0,
    speakCalls = 0,
    captureCalls = 0;
  let screenshot = {
    owner: "123",
    mimeType: "image/png" as "image/png" | "image/jpeg",
    bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]),
  };
  const telegram = {
    ...createTelegramOutbound({
      token: "fixture-token-not-secret",
      allowedUsers: new Set(["123"]),
      fetch: async (url, init) => {
        const method = String(url).split("/").at(-1)!;
        if (method === "sendChatAction") {
          activities.push(JSON.parse(String(init?.body)).action);
          return Response.json({ ok: true, result: true });
        }
        calls.push(method);
        if (init?.body instanceof FormData) uploads.push(init.body);
        if (status === "unknown") throw new Error("provider timeout");
        return status === "rejected"
          ? Response.json({ ok: false }, { status: 400 })
          : Response.json({ ok: true, result: { message_id: 99 } });
      },
    }),
    media: createTelegramMedia({
      token: "fixture-token-not-secret",
      fetch: async (url) =>
        String(url).endsWith("getFile")
          ? Response.json({
              ok: true,
              result: { file_id: "owned_photo", file_path: "photos/owned.jpg" },
            })
          : new Response(new Uint8Array([255, 216, 255]).buffer),
      processor: async ({ media }) => {
        processed++;
        return {
          status: "processed",
          images: [
            {
              mimeType: "image/jpeg",
              data: new Uint8Array([255, 216, 255]),
              sourceFileId: media.fileId,
            },
          ],
        };
      },
    }),
  };
  const native = createTelegramTools({
    owner: "123",
    compose,
    telegram,
    redact: (text) => text.replaceAll("fake-sensitive", "[redacted]"),
    inspectImages: async () => {
      visionCalls++;
      return "Observed a blue square.";
    },
    speak: async (text) => {
      spoken.push(text);
      speakCalls++;
      return new Uint8Array([1, 2, 3]);
    },
    captureScreenshot: capture
      ? async () => {
          captureCalls++;
          return screenshot;
        }
      : undefined,
  });
  const log = {
    read: Effect.sync(() => [...events]),
    head: Effect.sync(() => events.length),
    readFrom: (after: number) => Effect.sync(() => events.slice(after)),
    append: (items: readonly { type: string }[]) =>
      Effect.sync(() => {
        events.push(...(items as AikoEvent[]));
      }),
  };
  const run = (
    name: string,
    input: unknown = {},
    callId = name,
    thread = "user-123",
    turn = "turn-1",
  ) =>
    Effect.runPromise(
      native
        .find((t) => t.spec.name === name)!
        .run(input, { callId, turn, signal: signal() })
        .pipe(
          Effect.provideService(Self, {
            actor: "aiko",
            instance: "fixture",
            thread,
          }),
          Effect.provideService(EventLog, log),
        ),
    ) as Promise<TelegramReceipt>;
  return {
    events,
    calls,
    activities,
    uploads,
    spoken,
    native,
    telegram,
    run,
    set status(value: typeof status) {
      status = value;
    },
    get processed() {
      return processed;
    },
    get visionCalls() {
      return visionCalls;
    },
    get speakCalls() {
      return speakCalls;
    },
    get captureCalls() {
      return captureCalls;
    },
    set screenshot(value: typeof screenshot) {
      screenshot = value;
    },
  };
}
describe("native Telegram capability tools", () => {
  test("attachments come only from this owner's message/reply/received album and never another tenant", async () => {
    const f = fixture();
    f.events[0] = incoming("turn-1", "123", {
      telegram: {
        messageId: 10,
        media: [photo],
        mediaGroupId: "album1",
        replyTo: { media: [{ ...photo, fileId: "replied_photo" }] },
      },
    });
    f.events.push(
      incoming("other-turn", "123", {
        telegram: {
          media: [{ ...photo, fileId: "album_photo" }],
          mediaGroupId: "album1",
        },
      }),
      incoming("foreign", "456"),
      incoming("older", "123", {
        telegram: { media: [{ ...photo, fileId: "old_photo" }] },
      }),
    );
    const listed = await f.run("telegram_attachments");
    expect(listed.attachments?.map((item) => item.fileId)).toEqual([
      "owned_photo",
      "replied_photo",
      "album_photo",
    ]);
    expect(
      (await f.run("telegram_attachments", {}, "bad", "user-456")).status,
    ).toBe("rejected");
    expect(
      f.events.filter((e) => e.type === "AikoTelegramActionStarted"),
    ).toHaveLength(0);
    expect(
      (await f.run("telegram_inspect", { fileId: "not_owned" })).status,
    ).toBe("rejected");
    expect(f.processed).toBe(0);
  });
  test("inspection makes one configured vision capability call, caches receipt and never logs image bytes", async () => {
    const f = fixture(),
      input = { fileId: "owned_photo", question: "What is shown?" };
    const first = await f.run("telegram_inspect", input);
    expect(first.status).toBe("processed");
    expect(first.text).toContain("blue square");
    expect(await f.run("telegram_inspect", input)).toEqual(first);
    expect(f.processed).toBe(1);
    expect(f.visionCalls).toBe(1);
    expect(
      (await f.run("telegram_inspect", { ...input, question: "Changed" }))
        .status,
    ).toBe("rejected");
    expect(JSON.stringify(f.events)).not.toContain("data:");
    expect(JSON.stringify(f.events)).not.toContain('"images"');
  });
  test("send intent commits before external call and settled replay never resends", async () => {
    const f = fixture(),
      input = {
        kind: "photo",
        fileId: "owned_photo",
        caption: "fake-sensitive update",
        final: true,
      };
    const first = await f.run("telegram_send", input);
    expect(first).toMatchObject({
      status: "delivered",
      final: true,
      providerId: "99",
      reply: "[redacted] update",
    });
    expect(await f.run("telegram_send", input)).toEqual(first);
    expect(f.calls).toEqual(["sendPhoto"]);
    expect(
      f.events
        .filter((e) => e.type.startsWith("AikoTelegramAction"))
        .map((e) => e.type),
    ).toEqual(["AikoTelegramActionStarted", "AikoTelegramActionSettled"]);
    expect(
      (await f.run("telegram_send", { ...input, fileId: "foreign" })).status,
    ).toBe("rejected");
    expect(f.calls).toHaveLength(1);
  });
  test("crash after started before settled recovers unknown without sending again", async () => {
    const f = fixture(),
      input = { kind: "photo", fileId: "owned_photo", final: true };
    await f.run("telegram_send", input);
    f.events.splice(
      f.events.findIndex((e) => e.type === "AikoTelegramActionSettled"),
      1,
    );
    expect(await f.run("telegram_send", input)).toMatchObject({
      status: "unknown",
      final: true,
    });
    expect(f.calls).toHaveLength(1);
    expect(await f.run("telegram_send", input)).toMatchObject({
      status: "unknown",
    });
    expect(f.calls).toHaveLength(1);
  });
  test("provider unknown is retained; a separate native turn can reuse provider call ID", async () => {
    const f = fixture();
    f.status = "unknown";
    const input = { kind: "text", text: "Reply", final: true };
    expect((await f.run("telegram_send", input, "provider-id")).status).toBe(
      "unknown",
    );
    expect((await f.run("telegram_send", input, "provider-id")).status).toBe(
      "unknown",
    );
    expect(f.calls).toHaveLength(1);
    f.events.push(incoming("turn-2"));
    f.status = "delivered";
    expect(
      (await f.run("telegram_send", input, "provider-id", "user-123", "turn-2"))
        .status,
    ).toBe("delivered");
    expect(f.calls).toHaveLength(2);
  });
  test("native voice uses injected synthesizer, uploads OGG, and reuses the final receipt", async () => {
    const f = fixture(),
      input = { text: "A spoken answer", final: true };
    expect((await f.run("telegram_voice", input)).status).toBe("delivered");
    expect((await f.run("telegram_voice", input)).status).toBe("delivered");
    expect(f.speakCalls).toBe(1);
    expect(f.calls).toEqual(["sendVoice"]);
    expect(f.activities).toEqual(["record_voice", "upload_voice"]);
    expect(JSON.stringify(f.events)).not.toContain('"bytes"');
    expect(JSON.stringify(f.events)).toContain("A spoken answer");
  });
  test("fresh screenshot uploads only captured owner bytes, retains a safe final receipt, and never captures twice", async () => {
    const f = fixture(),
      input = { caption: "fake-sensitive screen", replyTo: 10, final: true };
    const first = await f.run("telegram_screenshot", input);
    expect(first).toMatchObject({
      status: "delivered",
      final: true,
      providerId: "99",
      reply: "[redacted] screen",
    });
    expect(await f.run("telegram_screenshot", input)).toEqual(first);
    expect(f.captureCalls).toBe(1);
    expect(f.calls).toEqual(["sendPhoto"]);
    expect(f.activities).toEqual(["upload_photo"]);
    expect(f.uploads).toHaveLength(1);
    const body = f.uploads[0]!;
    expect(body.get("chat_id")).toBe("123");
    expect(body.get("caption")).toBe("[redacted] screen");
    expect(JSON.parse(String(body.get("reply_parameters")))).toEqual({
      message_id: 10,
      allow_sending_without_reply: true,
    });
    const file = [...(body.values() as Iterable<unknown>)].find(
      (value: unknown) => value instanceof Blob,
    );
    if (!(file instanceof Blob)) throw new Error("Expected private image upload");
    expect(file.type).toBe("image/png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3,
    ]);
    const durable = JSON.stringify(f.events);
    expect(durable).not.toContain('"bytes"');
    expect(durable).not.toContain("data:image");
    expect(durable).not.toContain("browser-screenshot.png");
    expect(durable).not.toContain("fake-sensitive");
  });
  test("screenshot rejects foreign callers or capture owners, invalid signatures, oversized uploads and URLs", async () => {
    const foreign = fixture();
    expect(
      (await foreign.run("telegram_screenshot", {}, "foreign", "user-456"))
        .status,
    ).toBe("rejected");
    expect(foreign.captureCalls).toBe(0);
    for (const screenshot of [
      {
        owner: "456",
        mimeType: "image/png" as const,
        bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
      },
      {
        owner: "123",
        mimeType: "image/png" as const,
        bytes: new Uint8Array([1, 2, 3]),
      },
      {
        owner: "123",
        mimeType: "image/jpeg" as const,
        bytes: new Uint8Array(10 * 1024 * 1024 + 1),
      },
    ]) {
      const f = fixture();
      f.screenshot = screenshot;
      expect((await f.run("telegram_screenshot")).status).toBe("rejected");
      expect(f.calls).toEqual([]);
    }
    expect(
      (
        await foreign.run("telegram_screenshot", {
          url: "https://evil.invalid",
        })
      ).status,
    ).toBe("rejected");
    expect(foreign.captureCalls).toBe(0);
  });
  test("missing screenshot capability and invalid captions never capture or send", async () => {
    const missing = fixture(false);
    expect((await missing.run("telegram_screenshot")).status).toBe(
      "unsupported",
    );
    const bounded = fixture();
    expect(
      (await bounded.run("telegram_screenshot", { caption: "x".repeat(1025) }))
        .status,
    ).toBe("rejected");
    expect(missing.captureCalls + bounded.captureCalls).toBe(0);
    expect([...missing.calls, ...bounded.calls]).toEqual([]);
  });
  test("screenshot crash cut after intent is unknown and neither capture nor upload is replayed", async () => {
    const f = fixture(),
      input = { final: true };
    await f.run("telegram_screenshot", input);
    f.events.splice(
      f.events.findIndex((e) => e.type === "AikoTelegramActionSettled"),
      1,
    );
    expect(await f.run("telegram_screenshot", input)).toMatchObject({
      status: "unknown",
      final: true,
    });
    expect(await f.run("telegram_screenshot", input)).toMatchObject({
      status: "unknown",
      final: true,
    });
    expect(f.captureCalls).toBe(1);
    expect(f.calls).toEqual(["sendPhoto"]);
  });
  test("voice activity shares typing renewal and resets after release or abort", async () => {
    const f = fixture(),
      abort = new AbortController();
    const stopRecording = await f.telegram.activity(
      "123",
      "record_voice",
      abort.signal,
    );
    await f.telegram.action("123", signal());
    const stopUploading = await f.telegram.activity(
      "123",
      "upload_voice",
      abort.signal,
    );
    await f.telegram.action("123", signal());
    await stopUploading();
    await f.telegram.action("123", signal());
    abort.abort();
    const newUpload = f.telegram.activity("123", "upload_photo", signal());
    await stopRecording();
    await f.telegram.action("123", signal());
    await newUpload();
    await f.telegram.action("123", signal());
    expect(f.activities).toEqual([
      "record_voice",
      "record_voice",
      "upload_voice",
      "upload_voice",
      "record_voice",
      "upload_photo",
      "upload_photo",
      "typing",
    ]);
  });
  test("tools cannot fetch URLs or select a destination, and progress needs an owned sent message", async () => {
    const f = fixture();
    expect(
      (
        await f.run("telegram_send", {
          kind: "photo",
          fileId: "https://evil.invalid",
        })
      ).status,
    ).toBe("rejected");
    expect(
      (
        await f.run(
          "telegram_send",
          { kind: "text", text: "x", chat: "456" },
          "injected",
        )
      ).status,
    ).toBe("rejected");
    expect(
      (await f.run("telegram_progress", { text: "progress", messageId: 555 }))
        .status,
    ).toBe("rejected");
    expect(f.calls).toHaveLength(0);
    await f.run(
      "telegram_send",
      { kind: "text", text: "Started" },
      "owned-sent",
    );
    expect(
      (
        await f.run(
          "telegram_progress",
          { text: "progress", messageId: 99 },
          "update",
        )
      ).status,
    ).toBe("delivered");
    expect(f.calls).toEqual(["sendMessage", "editMessageText"]);
  });
});
describe("fixed one-call vision adapter", () => {
  test("Cerebras vision uses its own pinned endpoint and key with no Codegraff fallback", async () => {
    const calls: string[] = [];
    const vision = createTelegramVision({provider:"cerebras",apiKey:"cerebras-vision-fixture",model:"qwen-3.8-27b",fetch:async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cerebras-vision-fixture");
      expect(JSON.parse(String(init?.body))).toMatchObject({model:"qwen-3.8-27b",reasoning_effort:"none",stream:false});
      return Response.json({choices:[{message:{content:"A blue square."}}]});
    }});
    expect(await vision({owner:"123",question:"Describe",signal:signal(),images:[{mimeType:"image/png",data:new Uint8Array([1]),sourceFileId:"owned"}]})).toBe("A blue square.");
    expect(calls).toEqual(["https://api.cerebras.ai/v1/chat/completions"]);
    const unavailable = createTelegramVision({provider:"cerebras",apiKey:"cerebras-vision-fixture",model:"qwen-3.8-27b",fetch:async url => {calls.push(String(url));return new Response("unavailable",{status:503});}});
    await expect(unavailable({owner:"123",question:"Describe",signal:signal(),images:[{mimeType:"image/png",data:new Uint8Array([1]),sourceFileId:"owned"}]})).rejects.toThrow("vision_unavailable");
    expect(calls).toEqual(["https://api.cerebras.ai/v1/chat/completions","https://api.cerebras.ai/v1/chat/completions"]);
  });
  test("uses actual multimodal input and no second model/tool loop", async () => {
    let calls = 0,
      body: any;
    const vision = createTelegramVision({
      apiKey: "fixture-vision-key",
      model: "fixture-model",
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe(
          "https://gateway.codegraff.com/v1/chat/completions",
        );
        body = JSON.parse(String(init?.body));
        return Response.json({
          choices: [{ message: { content: "A small blue square." } }],
        });
      },
    });
    expect(
      await vision({
        owner: "123",
        question: "Describe",
        signal: signal(),
        images: [
          {
            mimeType: "image/png",
            data: new Uint8Array([1, 2, 3]),
            sourceFileId: "owned",
            atSeconds: 5,
          },
        ],
      }),
    ).toBe("A small blue square.");
    expect(calls).toBe(1);
    expect(body.messages[1].content.at(-1).image_url.url).toBe(
      "data:image/png;base64,AQID",
    );
    expect(body.tools).toBeUndefined();
    expect(body.stream).toBe(false);
  });
  test("a failed provider returns a sanitized error, not invented visual content", async () => {
    const vision = createTelegramVision({
      apiKey: "private-vision-fixture",
      model: "fixture-model",
      fetch: async () => {
        throw new Error("https://private-vision-fixture/");
      },
    });
    await expect(
      vision({
        owner: "123",
        question: "Describe",
        signal: signal(),
        images: [
          {
            mimeType: "image/jpeg",
            data: new Uint8Array([1]),
            sourceFileId: "owned",
          },
        ],
      }),
    ).rejects.toThrow("vision_unavailable");
  });
});

for (const capability of [
  {
    name: "telegram_voice",
    arguments: { text: "Actual spoken answer", final: true },
    method: "sendVoice",
    reply: "Actual spoken answer",
  },
  {
    name: "telegram_screenshot",
    arguments: { caption: "Actual browser screenshot", final: true },
    method: "sendPhoto",
    reply: "Actual browser screenshot",
  },
])
  test(`real native host starts/stops typing, sends ${capability.name} once and suppresses duplicate text across restart`, async () => {
    const f = fixture(),
      dir = await mkdtemp("/tmp/aiko-telegram-native-");
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    let starts = 0,
      stops = 0,
      plainSends = 0;
    const definition = () => {
      const typing = createTelegramTyping("123", {
        typing: () => {
          starts++;
          let stopped = false;
          return async () => {
            if (!stopped) {
              stopped = true;
              stops++;
            }
          };
        },
      });
      cleanup.push(typing.close);
      return actor({
        name: "aiko",
        methods: { message: agentMessageMethod },
        components: [
          typing.component,
          infer([tool(f.native), outputValidateOnce]),
          voiceAndOutbox(
            "123",
            createVoice({ enabled: false, persona: "fixture" }),
            async () => {
              plainSends++;
              return { status: "delivered", providerId: "999" };
            },
            { live: true, redact: (text) => text },
          ),
        ],
      });
    };
    const model = Layer.succeed(Infer, {
      resolve: () => ({
        model: { provider: "fixture", model_id: "native-telegram" },
      }),
      react: (request) =>
        Effect.succeed(
          request.trajectory.some((e) => e.type === "ToolReturned")
            ? {
                kind: "complete" as const,
                output: "This duplicate should not be sent.",
              }
            : {
                kind: "call" as const,
                name: capability.name,
                callId: "native-final-media",
                arguments: capability.arguments,
              },
        ),
    });
    const options = {
      database: join(dir, "actor.sqlite"),
      actorName: "aiko",
      actorInstance: "test",
      keyOf: telegramEventKey,
      layersFor: () => model,
    };
    let host = await createBunHost({
      ...options,
      actorFor: () => definition(),
    });
    cleanup.push(() => host.close());
    await host.commitRoot(host.self("user-123"), incoming());
    await host.wake("user-123");
    let log = await host.read("user-123");
    expect(log.some((e) => e.type === "TurnCompleted")).toBe(true);
    expect(f.calls).toEqual([capability.method]);
    expect(plainSends).toBe(0);
    expect(starts).toBe(1);
    expect(stops).toBe(1);
    expect(
      log.find((e) => e.type === "AikoReplyPrepared")?.result,
    ).toMatchObject({ text: capability.reply });
    await host.close();
    host = await createBunHost({ ...options, actorFor: () => definition() });
    await host.recover();
    log = await host.read("user-123");
    expect(f.calls).toEqual([capability.method]);
    expect(plainSends).toBe(0);
    expect(starts).toBe(1);
    expect(
      log.filter((e) => e.type === "AikoTelegramActionSettled"),
    ).toHaveLength(1);
  }, 30_000);

test("typing lifecycle closes on failure, cancellation and explicit host shutdown", async () => {
  for (const terminal of ["TurnFailed", "TurnCancelled"]) {
    let started = 0,
      stopped = 0;
    const typing = createTelegramTyping("123", {
      typing: () => {
        started++;
        return async () => {
          stopped++;
        };
      },
    });
    cleanup.push(typing.close);
    const machine = typing.component.machine;
    let state = machine.step(machine.initial(), incoming());
    const first = machine.output(state).transitions[0];
    expect(first?.kind).toBe("effect");
    if (first?.kind !== "effect") throw new Error("expected native effect");
    const startEvents = await Effect.runPromise(
      first.act(first.input, signal()) as Effect.Effect<readonly AikoEvent[]>,
    );
    for (const e of startEvents) state = machine.step(state, e);
    state = machine.step(state, event(terminal, { turn: "turn-1" }));
    const stop = machine.output(state).transitions[0];
    if (stop?.kind !== "effect") throw new Error("expected native stop");
    await Effect.runPromise(
      stop.act(stop.input, signal()) as Effect.Effect<readonly AikoEvent[]>,
    );
    expect(started).toBe(1);
    expect(stopped).toBe(1);
    await typing.close();
    expect(stopped).toBe(1);
  }
});

test("cold replay never restarts typing for terminal turns without delivery receipts", () => {
  for (const terminal of ["TurnCompleted", "TurnFailed", "TurnCancelled"]) {
    const typing = createTelegramTyping("123", {
      typing: () => { throw Error("Historical turn must not start typing"); },
    }, { waitForDelivery: true });
    const machine = typing.component.machine;
    let state = machine.step(machine.initial(), incoming());
    state = machine.step(state, event("AikoTelegramTypingStarted", {
      turn: "turn-1", epoch: 0, activation: "previous-process",
    }));
    state = machine.step(state, event(terminal, { turn: "turn-1", epoch: 0 }));
    expect(machine.output(state).transitions).toHaveLength(0);
    state = machine.step(state, event("TurnResumed", { turn: "turn-1", epoch: 1 }));
    expect(machine.output(state).transitions).toHaveLength(1);
    state = machine.step(state, event("AikoDeliverySettled", { turn: "turn-1", epoch: 0 }));
    expect(machine.output(state).transitions).toHaveLength(1);
  }
});

test("strict-provider null optional arguments do not reject a normal final reply", async () => {
  const f = fixture(true, async text => ({status:"ready",text,persona:"fixture"}));
  expect(await f.run("send_message", {kind:"text",text:"Hello",replyTo:null,buttons:null,caption:null,fileId:null,fileIds:null,final:true})).toMatchObject({status:"delivered",final:true});
  expect(f.calls).toHaveLength(1);
});

test("native drafts keep typing through composition and fence delivery by resume epoch and owner", async () => {
  let starts = 0, stops = 0;
  const drafts: {id: number; text: string; context: unknown}[] = [];
  const typing = createTelegramTyping("123", {
    typing: () => { starts++; return async () => { stops++; }; },
    draft: async (_owner, id, text, _signal, context) => {
      drafts.push({id, text, context}); return {status:"delivered"};
    },
  }, {waitForDelivery:true});
  cleanup.push(typing.close);
  const machine = typing.component.machine;
  let state = machine.step(machine.initial(), {...incoming(), telegram:{messageThreadId:44}});
  const settle = async () => {
    const transition = machine.output(state).transitions[0];
    if (transition?.kind !== "effect") throw Error("Expected typing effect");
    const events = await Effect.runPromise(transition.act(transition.input, signal()) as Effect.Effect<readonly AikoEvent[]>);
    for (const e of events) state = machine.step(state, e);
  };
  await settle();
  expect(drafts[0]).toMatchObject({text:"",context:{canStop:true,messageThreadId:44}});
  state = machine.step(state, event("TurnCompleted", {turn:"turn-1",epoch:0}));
  expect(machine.output(state).transitions).toHaveLength(0);
  expect(stops).toBe(0);
  state = machine.step(state, event("TurnResumed", {turn:"turn-1",epoch:1}));
  await settle();
  expect(starts).toBe(2);
  expect(stops).toBe(1);
  expect(drafts[1]!.id).not.toBe(drafts[0]!.id);
  state = machine.step(state, event("AikoDeliverySettled", {turn:"turn-1",epoch:0,result:{status:"delivered"}}));
  state = machine.step(state, event("AikoTelegramActionSettled", {turn:"turn-1",epoch:1,result:{owner:"456",final:true,status:"delivered"}}));
  expect(machine.output(state).transitions).toHaveLength(0);
  state = machine.step(state, event("ToolCalled", {turn:"turn-1",epoch:1,callId:"search",name:"memory_recall"}));
  // A tool call does not automatically narrate progress; the actor chooses a send/progress tool.
  expect(machine.output(state).transitions).toHaveLength(0);
  expect(drafts.at(-1)).toMatchObject({id:drafts[1]!.id,text:""});
  state = machine.step(state, event("AikoDeliverySettled", {turn:"turn-1",epoch:1,result:{status:"delivered"}}));
  await settle();
  expect(stops).toBe(2);
});
