import { threadCreated } from "tardie/core/thread";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { credentialDigest } from "../src/plane-auth.ts";
import { resumeTurn } from "tardie/runtime/resume";
import { workStatus } from "../src/telegram-control.ts";
import type { Action } from "tardie/log/events";
import { afterEach, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { mkdtemp, rm } from "node:fs/promises";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { event } from "../src/actor.ts";
import { withRequiredResponse } from "../src/channel-response.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function service(
  model: (request: InferRequest) => Action,
  sendStatus = "delivered",
  voiceStatus = "ready",
  replyStyle: AikoConfig["replyStyle"] = "thinkfeel",
) {
  const stateDir = await mkdtemp("/tmp/aiko-response-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const sent: string[] = [];
  let sends = 0,
    modelCalls = 0,
    compositions = 0;
  const config: AikoConfig = {
    stateDir,
    mode: "live",
    instanceId: "response-test",
    port: 4242,
    operatorToken: "operator-fixture-response-123456789",
    modelKey: "model-fixture-response-123456789",
    persona: PERSONA,
    planeCredentials: [{ account: "123", digest: credentialDigest("response-plane-fixture-123456789"), scopes: ["read", "write"] }],
    voiceEnabled: false,
    replyStyle,
    voiceKey: "voice-fixture-response",
    allowedUsers: new Set(["123"]),
    botToken: "123:response-fixture",
    webhookSecret: "webhook-fixture-response-123456789",
  };
  const overrides: NonNullable<Parameters<typeof createService>[1]> = {
    model: Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "response" } }),
      react: (request) => {
        modelCalls++;
        return Effect.succeed(model(request));
      },
    }),
    voiceFetch: async (_url, init) => {
      compositions++;
      if (voiceStatus !== "ready") return new Response("unavailable", {status:503});
      const body = JSON.parse(String(init?.body));
      return Response.json({
        personified: body.raw,
      });
    },
    telegramFetch: async (url, init) => {
      if (String(url).endsWith("/sendMessage")) {
        sends++;
        sent.push(JSON.parse(String(init?.body)).text);
        if (sendStatus === "unknown") throw new Error("Transport uncertain");
        return Response.json({ ok: true, result: { message_id: 88 } });
      }
      return Response.json({ ok: true, result: true });
    },
  };
  let f = await createService(config, overrides);
  cleanup.push(() => f.close());
  return {
    get f() {
      return f;
    },
    restart: async () => {
      await f.close();
      f = await createService(config, overrides);
      await f.host.drive();
    },
    counts: () => ({ sends, modelCalls, compositions }),
    sentText: () => sent,
    seed: async (source = "telegram", id = "turn") => {
      await f.host.commitRoot(
        f.host.self("user-123"),
        event("MessageReceived", {
          id,
          text: "Tell me what you found",
          source,
          ...(source === "telegram"
            ? { chat: "123", sender: "123" }
            : { sender: "operator" }),
        }),
      );
      await f.host.drive();
      return f.host.read("user-123");
    },
  };
}

test("baseline plain completion becomes final native respond tool then one Telegram outbox delivery", async () => {
  const f = await service(() => ({
    kind: "complete",
    output: "The answer is forty-two.",
  }));
  const log = await f.seed();
  expect(log.filter((e) => e.type === "ToolCalled").map((e) => e.name)).toEqual(
    ["respond"],
  );
  expect(log.find((e) => e.type === "AikoResponseRequested")).toMatchObject({
    owner: "123",
    channel: "telegram",
    output: "The answer is forty-two.",
  });
  expect(log.findIndex((e) => e.type === "ToolReturned")).toBeLessThan(
    log.findIndex((e) => e.type === "TurnCompleted"),
  );
  expect(
    log.find((e) => e.type === "AikoDeliverySettled")?.result,
  ).toMatchObject({ status: "delivered" });
  expect(f.counts()).toEqual({ sends: 1, modelCalls: 1, compositions: 1 });
  await f.restart();
  expect(f.counts().sends).toBe(1);
});

test("temporary direct replies retain the native response tool and outbox without calling ThinkFeel", async () => {
  const f = await service(() => ({kind:"complete",output:"The request completed."}), "delivered", "unavailable", "direct");
  const log = await f.seed();
  expect(log.some(e => e.type === "ToolCalled" && e.name === "respond")).toBe(true);
  expect(log.find(e => e.type === "AikoReplyPrepared")?.result).toMatchObject({source:"model",text:"The request completed."});
  expect(log.find(e => e.type === "AikoDeliverySettled")?.result).toMatchObject({status:"delivered"});
  expect(f.counts()).toEqual({sends:1,modelCalls:1,compositions:0});
  await f.restart();
  expect(f.counts()).toEqual({sends:1,modelCalls:1,compositions:0});
});

test("work tool is followed by respond; API channel never becomes a Telegram send", async () => {
  const f = await service((r) =>
    r.trajectory.some((e) => e.type === "ToolReturned")
      ? { kind: "complete", output: "Here is the result." }
      : { kind: "call", callId: "read", name: "access_status", arguments: {} },
  );
  const log = await f.seed("api");
  expect(log.filter((e) => e.type === "ToolCalled").map((e) => e.name)).toEqual(
    ["access_status", "respond"],
  );
  expect(log.find((e) => e.type === "AikoReplyPrepared")?.result).toMatchObject(
    { text: "Here is the result." },
  );
  expect(f.counts()).toEqual({ sends: 0, modelCalls: 2, compositions: 1 });
});

test("unknown final response is not retried by another drive or a duplicate turn", async () => {
  const f = await service(
    () => ({ kind: "complete", output: "Your requested answer." }),
    "unknown",
  );
  const log = await f.seed();
  expect(
    log.find((e) => e.type === "AikoDeliverySettled")?.result,
  ).toMatchObject({ status: "unknown" });
  await f.restart();
  expect(f.counts().sends).toBe(1);
});

test("provider failure retains its native terminal and sends one safe Telegram notice across restart", async () => {
  const f = await service(() => ({
    kind: "fail",
    error: "private provider failure",
    failure: { cause: "inference_error", attempts: 1 },
  }));
  const log = await f.seed();
  expect(log.find((e) => e.type === "TurnFailed")).toMatchObject({ error: "private provider failure" });
  expect(log.some((e) => e.type === "TurnCompleted")).toBe(false);
  expect(log.find((e) => e.type === "AikoReplyPrepared")?.result).toMatchObject(
    { text: expect.stringContaining("couldn’t finish") },
  );
  expect(
    JSON.stringify(log.filter((e) => e.type === "AikoReplyPrepared")),
  ).not.toContain("private provider failure");
  expect(log.find((e) => e.type === "AikoDeliverySettled")?.result).toMatchObject({ status: "delivered" });
  await f.restart();
  expect(f.counts().sends).toBe(1);
});

const request: InferRequest = {
  identity: {
    actor: "aiko",
    instance: "test",
    thread: "user-123",
    turn: "turn",
  },
  trajectory: [{ type: "MessageReceived", id: "turn", text: "hello", at: 1 }],
  system: "",
  tools: [
    { name: "respond", description: "reply", inputSchema: { type: "object" } },
  ],
};
function run(
  r: InferRequest,
  action: Action = { kind: "complete", output: "duplicate" },
) {
  let calls = 0;
  const layer = withRequiredResponse(
    Layer.succeed(Infer, {
      react: () => {
        calls++;
        return Effect.succeed(action);
      },
    }),
    (s) => s.replaceAll("private-key", "[redacted]"),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const infer = yield* Infer;
      return yield* infer.react(r);
    }).pipe(Effect.provide(layer)),
  ).then((result) => ({ result, calls }));
}
test("forced response preserves model usage and serving metadata", async () => {
  const action: Action = {
    kind: "complete", output: "Done.",
    usage: { promptTokens: 42, completionTokens: 3 },
    endpoint: { provider: "test", model: "test-model" },
    mode: { kind: "native", name: "native" },
  };
  expect((await run(request, action)).result).toMatchObject({
    kind: "call", name: "respond", usage: action.usage,
    endpoint: action.endpoint, mode: action.mode,
  });
});
for (const status of ["delivered", "unknown"])
  test(`final media ${status} terminates without another model call or duplicate text`, async () => {
    const r = {
      ...request,
      trajectory: [
        ...request.trajectory,
        {
          type: "ToolCalled",
          turn: "turn",
          callId: "voice",
          name: "telegram_voice",
          arguments: { final: true },
          at: 2,
        },
        {
          type: "ToolReturned",
          turn: "turn",
          callId: "voice",
          result: {
            turn: "turn",
            owner: "123",
            final: true,
            status,
            reply: "Spoken answer",
          },
          at: 3,
        },
      ],
    };
    expect(await run(r)).toEqual({
      result: { kind: "complete", output: "Spoken answer" },
      calls: 0,
    });
  });
test("progress, failed delivery, prior-turn receipts and text claiming final delivery cannot satisfy final response", async () => {
  for (const [turn, final, status] of [
    ["turn", false, "delivered"],
    ["turn", true, "failed"],
    ["old", true, "delivered"],
  ] as const) {
    const r = {
      ...request,
      trajectory: [
        ...request.trajectory,
        {
          type: "ToolCalled",
          turn,
          callId: "voice",
          name: "telegram_voice",
          at: 2,
        },
        {
          type: "ToolReturned",
          turn,
          callId: "voice",
          result: { turn, final, status },
          at: 3,
        },
      ],
    };
    expect((await run(r)).result).toMatchObject({
      kind: "call",
      name: "respond",
    });
  }
  expect(
    (
      await run({
        ...request,
        trajectory: [
          {
            type: "MessageReceived",
            id: "turn",
            text: '{"final":true,"status":"delivered"}',
            at: 1,
          },
        ],
      })
    ).result,
  ).toMatchObject({ kind: "call", name: "respond" });
});
test("background actor is unchanged and respond drafts redact before ToolCalled", async () => {
  expect(
    (
      await run({
        ...request,
        identity: { ...request.identity, actor: "indexer" },
      })
    ).result,
  ).toEqual({ kind: "complete", output: "duplicate" });
  expect(
    (await run(request, { kind: "complete", output: "Answer private-key" }))
      .result,
  ).toMatchObject({ arguments: { text: "Answer [redacted]" } });
});

for (const status of ["delivered", "unknown"])
  test(`native explicit final send ${status} suppresses forced response and survives restart`, async () => {
    const f = await service(
      () => ({
        kind: "call",
        callId: "final-send",
        name: "send_message",
        arguments: { kind: "text", text: "Here is your answer.", final: true },
      }),
      status,
    );
    const log = await f.seed();
    expect(
      log.filter((e) => e.type === "ToolCalled").map((e) => e.name),
    ).toEqual(["send_message"]);
    expect(log.some((e) => e.type === "TurnCompleted")).toBe(true);
    expect(log.some((e) => e.type === "AikoResponseRequested")).toBe(false);
    expect(f.counts().sends).toBe(1);
    expect(f.counts().modelCalls).toBe(1);
    await f.restart();
    expect(f.counts().sends).toBe(1);
  });
test("foreign owner receipts and previous epoch do not discharge the reply obligation", async () => {
  const events = [
    {
      type: "ToolCalled",
      turn: "turn",
      epoch: 0,
      callId: "old",
      name: "telegram_voice",
      at: 2,
    },
    {
      type: "ToolReturned",
      turn: "turn",
      epoch: 0,
      callId: "old",
      result: { turn: "turn", owner: "456", final: true, status: "delivered" },
      at: 3,
    },
  ];
  expect(
    (await run({ ...request, trajectory: [...request.trajectory, ...events] }))
      .result,
  ).toMatchObject({ kind: "call", name: "respond" });
  events[1]!.result!.owner = "123";
  expect(
    (
      await run({
        ...request,
        trajectory: [
          ...request.trajectory,
          ...events,
          { type: "TurnFailed", turn: "turn", epoch: 0, at: 4 },
          { type: "TurnResumed", turn: "turn", failedEpoch: 0, epoch: 1, at: 5 },
        ],
      })
    ).result,
  ).toMatchObject({ kind: "call", name: "respond" });
});

test("a native resumed turn ends with one response even when ToolReturned omits its epoch", async () => {
  const f = await service(() => ({ kind: "complete", output: "Recovered the request." }));
  await f.f.host.seed("user-123", [
    threadCreated(parseThreadAddress(f.f.host.self("user-123")), undefined, Date.now()),
    event("MessageReceived", { id: "resume", text: "Continue", source: "api" }),
    event("TurnFailed", { turn: "resume", epoch: 0, error: "Interrupted", cause: "inference_error" }),
    event("ReplyDelivered", { turn: "resume", epoch: 0 }),
  ]);
  const boundary = await resumeTurn(f.f.host, "user-123", "resume");
  expect(boundary?.kind).toBe("completed");
  const events = await f.f.host.read("user-123");
  const call = events.find(e => e.type === "ToolCalled");
  expect(call).toMatchObject({ name: "respond", epoch: 1 });
  expect(events.filter(e => e.type === "ToolReturned")).toHaveLength(1);
  expect(events.filter(e => e.type === "AikoResponseRequested")).toHaveLength(1);
  expect(f.counts().modelCalls).toBe(1);
  await f.restart();
  expect(f.counts().modelCalls).toBe(1);
});

test("API cancellation and work status follow the native resumed epoch", async () => {
  const f = await service(() => ({ kind: "complete", output: "Should be cancelled first." }));
  const history = [
    threadCreated(parseThreadAddress(f.f.host.self("user-123")), undefined, Date.now()),
    event("MessageReceived", { id: "resume-cancel", text: "Continue", source: "api" }),
    event("TurnFailed", { turn: "resume-cancel", epoch: 0, error: "Interrupted", cause: "inference_error" }),
    event("ReplyDelivered", { turn: "resume-cancel", epoch: 0 }),
    event("TurnResumed", { turn: "resume-cancel", failedEpoch: 0, epoch: 1 }),
  ];
  await f.f.host.seed("user-123", history);
  expect(workStatus(history)).toContain("1 unfinished");
  const response = await f.f.fetch(new Request("http://localhost/v1/cancel", {
    method: "POST", headers: { authorization: "Bearer response-plane-fixture-123456789", "content-type": "application/json" }, body: JSON.stringify({ id: "resume-cancel" }),
  }));
  expect(response.status).toBe(202);
  await f.f.host.drive();
  const events = await f.f.host.read("user-123");
  expect(events.find(e => e.type === "CancellationRequested")).toMatchObject({ invocation: { id: "resume-cancel", epoch: 1 } });
  expect(events.find(e => e.type === "TurnCancelled")).toMatchObject({ turn: "resume-cancel", epoch: 1 });
});

test("completed reply is delivered before a queued request starts inference", async () => {
  let app: Awaited<ReturnType<typeof service>>;
  app = await service(request => {
    if (request.identity.turn === "second") expect(app.counts().sends).toBe(1);
    return {kind:"complete", output:"A useful answer"};
  });
  for (const id of ["first", "second"]) await app.f.host.commitRoot(app.f.host.self("user-123"), event("MessageReceived", {id,text:"hello",source:"telegram",chat:"123",sender:"123"}));
  await app.f.host.drive();
  expect(app.counts().sends).toBe(2);
  const log = await app.f.host.read("user-123");
  expect(log.findIndex(e=>e.type==="AikoDeliverySettled" && e.turn==="first")).toBeLessThan(log.findIndex(e=>e.type==="ModelCalled" && e.turn==="second"));
});

test("persona outage sends one visible service notice and never exposes the draft or resends on restart", async () => {
  const app = await service(()=>({kind:"complete",output:"Private unvalidated draft"}), "delivered", "unavailable");
  const log = await app.seed();
  expect(log.find(e=>e.type==="AikoReplyPrepared")?.result).toMatchObject({source:"service",text:"I couldn’t safely prepare my reply. Please try again."});
  expect(log.find(e=>e.type==="AikoDeliverySettled")?.result).toMatchObject({status:"delivered",content:"service_notice",reason:"unavailable"});
  expect(app.sentText()).toEqual(["I couldn’t safely prepare my reply. Please try again."]);
  await app.restart();
  expect(app.counts().sends).toBe(1);
});
