import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { event, type AikoEvent } from "../src/actor.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of disposers.splice(0).reverse()) await close();
});
async function setup(
  overrides: Partial<AikoConfig> = {},
  options: Parameters<typeof createService>[1] = {},
) {
  const stateDir = await mkdtemp(join(tmpdir(), "aiko-test-"));
  disposers.push(() => rm(stateDir, { recursive: true, force: true }));
  const config: AikoConfig = {
    mode: "demo",
    port: 4242,
    stateDir,
    operatorToken: "test-operator-not-a-real-secret-123456",
    persona: PERSONA,
    voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]),
    ...overrides,
  };
  let service = await createService(config, options);
  disposers.push(() => service.close());
  const request = (
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ) =>
    service.fetch(
      new Request(`http://127.0.0.1:4242${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${config.operatorToken}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  return {
    get service() {
      return service;
    },
    request,
    config,
    restart: async () => {
      await service.close();
      service = await createService(config, options);
    },
  };
}

describe("native Tardie vertical slice", () => {
  test("the real GLM adapter handles a mocked OpenAI tool stream without paid requests", async () => {
    let calls = 0;
    const app = await setup(
      { mode: "live", modelKey: "fixture-model-key", voiceKey: "thinkfeel-runtime-fixture" },
      {
        voiceFetch: async (_url, init) => Response.json({ personified: JSON.parse(String(init?.body)).raw }),
        modelFetch: async (url, init) => {
          expect(String(url)).toBe(
            "https://gateway.codegraff.com/v1/chat/completions",
          );
          const body = JSON.parse(String(init?.body));
          expect(body.model).toBe("glm-5.3-flash");
          for (const name of [
            "web_read",
            "memory_recall",
            "memory_remember",
            "memory_refresh_logs",
          ]) {
            expect(
              body.tools.some(
                (t: { function: { name: string } }) => t.function.name === name,
              ),
            ).toBe(true);
          }
          expect(
            body.tools.some(
              (t: { function: { name: string } }) =>
                t.function.name === "demo_issues_list" ||
                t.function.name === "apps_list",
            ),
          ).toBe(false);
          calls++;
          const delta =
            calls === 1
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "fixture_call_1",
                      type: "function",
                      function: {
                        name: "memory_remember",
                        arguments: JSON.stringify({
                          subject: "preferences/clock",
                          title: "Use UTC",
                          type: "note",
                          payload: { timezone: "UTC" },
                        }),
                      },
                    },
                  ],
                }
              : {
                  role: "assistant",
                  content:
                    "I posted the reply. This unsafe draft must never be delivered.",
                };
          const chunk = (delta: object, reason: string | null) => ({
            id: "fixture-completion",
            object: "chat.completion.chunk",
            created: 1,
            model: "glm-5.3-flash",
            choices: [{ index: 0, delta, finish_reason: reason }],
          });
          return new Response(
            `data: ${JSON.stringify(chunk(delta, null))}\n\ndata: ${JSON.stringify(chunk({}, calls === 1 ? "tool_calls" : "stop"))}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    await app.request("/api/messages", {
      id: "model_wire_001",
      text: "Remember that we use UTC",
    });
    await app.service.host.drive();
    const messages = (await (await app.request("/api/messages")).json())
      .messages;
    expect(calls).toBe(2);
    expect(messages.at(-1).text).toContain("Saved an agent memory claim");
    expect(messages.at(-1).text).not.toContain("I posted the reply");
    expect(
      JSON.stringify(await app.service.host.read("user-local")),
    ).not.toContain("fixture-model-key");
  }, 30_000);

  test("a second host cannot race the same outbox database", async () => {
    const app = await setup();
    await expect(createService(app.config)).rejects.toThrow("already in use");
  });

  test("recovery after send-start does not repeat an ambiguous Telegram send", async () => {
    let sends = 0;
    const app = await setup(
      {
        botToken: "123:test-only",
        webhookSecret: "test_webhook_secret_123456789012345",
      },
      {
        telegramFetch: async () => {
          sends++;
          throw new Error("must not send");
        },
      },
    );
    await app.service.host.commitRoot(
      app.service.host.self("user-123"),
      event("MessageReceived", {
        id: "telegram:88",
        text: "Hello",
        source: "telegram",
        chat: "123",
        sender: "123",
      }),
    );
    await app.service.host.seed("user-123", [
      event("TurnCompleted", { turn: "telegram:88", output: "Hello" }),
      event("AikoReplyPrepared", {
        turn: "telegram:88",
        epoch: 0,
        result: { text: "Hi! How can I help?", source: "template" },
      }),
      event("AikoDeliveryStarted", { turn: "telegram:88", epoch: 0 }),
    ]);
    await app.restart();
    expect(sends).toBe(0);
    const log = (await app.service.host.read("user-123")) as AikoEvent[];
    expect(log.find((e) => e.type === "AikoDeliverySettled")?.result).toEqual({
      status: "unknown",
    });
  });

  test("real actor tool execution, exact receipts, durable dedup and restart", async () => {
    const app = await setup();
    const body = { id: "request_0001", text: "Show sample GitHub issues" };
    expect((await app.request("/api/messages", body)).status).toBe(202);
    await app.service.host.drive();
    let log = (await app.service.host.read("user-local")) as AikoEvent[];
    expect(log.filter((e) => e.type === "ToolReturned" && (e.result as any)?.kind !== "channel-response")).toHaveLength(1);
    expect(log.filter(e => e.type === "ToolCalled").at(-1)?.name).toBe("respond");
    expect(log.filter((e) => e.type === "AikoReplyPrepared")).toHaveLength(1);
    const first = await (await app.request("/api/messages")).json();
    expect(first.messages[1].text).toContain("#17");
    expect(first.messages[1].text).toContain("synthetic data");
    expect(first.messages[1].text).toContain("Nothing has been posted");
    await app.restart();
    expect(
      (await (await app.request("/api/messages", body)).json()).status,
    ).toBe("duplicate");
    await app.service.host.drive();
    log = (await app.service.host.read("user-local")) as AikoEvent[];
    expect(log.filter((e) => e.type === "MessageReceived")).toHaveLength(1);
    expect(log.filter((e) => e.type === "AikoReplyPrepared")).toHaveLength(1);
    expect(
      (await (await app.request("/api/messages")).json()).messages,
    ).toEqual(first.messages);
  }, 30_000);

  test("native memory persists cited fixtures across restart without a second source read", async () => {
    const app = await setup();
    await app.request("/api/messages", {
      id: "request_0001",
      text: "Show sample issues",
    });
    await app.service.host.drive();
    await app.restart();
    await app.request("/api/messages", {
      id: "request_0002",
      text: "Search memory for calendar",
    });
    await app.service.host.drive();
    const data = await (await app.request("/api/messages")).json();
    expect(data.messages.at(-1).text).toContain("Recorded memory");
    expect(data.messages.at(-1).text).toContain("obs_");
    expect(data.messages.at(-1).text).toContain("timezone");
    expect(
      ((await app.service.host.read("user-local")) as AikoEvent[]).filter(
        (e) => e.type === "ToolCalled" && e.name === "demo_issues_list",
      ),
    ).toHaveLength(1);
    expect(
      (await app.service.host.read("user-456")).filter(
        (e) => e.type === "MessageReceived",
      ),
    ).toHaveLength(0);
  });

  test("authenticated console stores actual notes and explicitly observes real native thread metadata", async () => {
    const app = await setup();
    await app.request("/api/messages", {
      id: "remember_note_1",
      text: "Remember: Use UTC for the launch",
    });
    await app.service.host.drive();
    expect(
      (await (await app.request("/api/messages")).json()).messages.at(-1).text,
    ).toContain("Saved an agent memory claim");
    await app.restart();
    await app.request("/api/messages", {
      id: "recall_note_2",
      text: "Search memory for UTC",
    });
    await app.service.host.drive();
    const messages = (await (await app.request("/api/messages")).json())
      .messages;
    expect(messages.at(-1).text).toContain("Use UTC for the launch");
    expect(messages.at(-1).text).not.toContain("synthetic data");
    await app.request("/api/messages", {
      id: "observe_log_3",
      text: "Refresh logs",
    });
    await app.service.host.drive();
    const events = (await app.service.host.read("user-local")) as AikoEvent[];
    expect(
      events.filter((e) => e.type === "ToolReturned" && (e.result as any)?.kind === "memory-receipt").at(-1)?.result,
    ).toMatchObject({
      kind: "memory-receipt",
      operation: "refresh_logs",
      outcome: "ok",
    });
    expect(
      (await (await app.request("/api/status")).json()).memory,
    ).toMatchObject({ engine: "entity-learn", version: "0.2.0" });
  });

  test("operator auth, origin, host, unsupported methods and malformed requests fail closed", async () => {
    const app = await setup();
    expect(
      (
        await app.request("/api/messages", undefined, {
          authorization: "Bearer wrong",
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/api/messages", undefined, {
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.service.fetch(new Request("http://evil.example/health")))
        .status,
    ).toBe(403);
    expect(
      (await app.request("/api/messages", { id: "../escape", text: "Hello" }))
        .status,
    ).toBe(400);
    expect(
      (
        await app.request("/api/messages", {
          id: "request_0001",
          text: "x".repeat(4001),
        })
      ).status,
    ).toBe(400);
    expect((await app.request("/api/cancel", { id: "missing" })).status).toBe(
      404,
    );
    expect((await app.request("/telegram/webhook", {})).status).toBe(503);
  });

  test("known credentials are redacted before persistence and logs omit provider keys", async () => {
    const app = await setup({ voiceKey: "fixture-voice-key-123456" });
    await app.request("/api/messages", {
      id: "request_0001",
      text: "hello fixture-voice-key-123456 password=hunter123",
    });
    await app.service.host.drive();
    const log = JSON.stringify(await app.service.host.read("user-local"));
    expect(log).not.toContain("fixture-voice-key");
    expect(log).not.toContain("hunter123");
    expect(log).not.toContain(app.config.operatorToken);
  });

  test("model failure becomes a truthful template, not an invented success", async () => {
    const model = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "failure" } }),
      react: () =>
        Effect.succeed({
          kind: "fail" as const,
          error: "fixture provider unavailable",
        }),
    });
    const app = await setup({}, { model });
    await app.request("/api/messages", {
      id: "request_0001",
      text: "Show issues",
    });
    await app.service.host.drive();
    const data = await (await app.request("/api/messages")).json();
    expect(data.messages.at(-1).text).toContain("couldn’t finish");
    expect(data.pending).toHaveLength(0);
  });

  test("recovery after voice start uses one template without rebilling", async () => {
    let calls = 0;
    const app = await setup(
      { voiceEnabled: true, voiceKey: "test-voice" },
      {
        voiceFetch: async () => {
          calls++;
          throw new Error("Must not execute");
        },
      },
    );
    await app.service.host.commitRoot(
      app.service.host.self("user-local"),
      event("MessageReceived", {
        id: "recovery_001",
        text: "Hello",
        source: "local",
      }),
    );
    await app.service.host.seed("user-local", [
      event("TurnCompleted", { turn: "recovery_001", output: "Hello" }),
      event("AikoVoiceStarted", { turn: "recovery_001", epoch: 0 }),
    ]);
    await app.restart();
    const data = await (await app.request("/api/messages")).json();
    expect(calls).toBe(0);
    expect(data.messages.at(-1).reason).toBe("recovered");
  });

  test("Telegram verified private input, tenant isolation and persisted unknown delivery are not retried", async () => {
    let sends = 0;
    const app = await setup(
      {
        botToken: "123:test-only",
        webhookSecret: "test_webhook_secret_123456789012345",
      },
      {
        telegramFetch: async () => {
          sends++;
          throw new Error("ambiguous timeout");
        },
      },
    );
    const update = (id: number, user: number, type = "private") => ({
      update_id: id,
      message: {
        message_id: id,
        date: Math.floor(Date.now() / 1000),
        text: "Show sample issues",
        from: { id: user, is_bot: false },
        chat: { id: user, type },
      },
    });
    const headers = {
      "x-telegram-bot-api-secret-token": app.config.webhookSecret!,
    };
    expect(
      (
        await app.request("/telegram/webhook", update(1, 123), {
          "x-telegram-bot-api-secret-token": "wrong",
        })
      ).status,
    ).toBe(401);
    await app.request("/telegram/webhook", update(1, 123, "group"), headers);
    await app.request("/telegram/webhook", update(1, 999), headers);
    expect(await app.service.host.threads()).toHaveLength(0);
    await app.request("/telegram/webhook", update(1, 123), headers);
    await app.service.host.drive();
    expect(sends).toBe(1);
    let log = (await app.service.host.read("user-123")) as AikoEvent[];
    expect(log.find((e) => e.type === "AikoDeliverySettled")?.result).toEqual({
      status: "unknown", reason: "transport",
    });
    expect(log.filter((e) => e.type === "MessageReceived")).toHaveLength(1);
    await app.restart();
    await app.request("/telegram/webhook", update(1, 123), headers);
    await app.service.host.drive();
    expect(sends).toBe(1);
    expect(
      (await app.request("/api/messages").then((r) => r.json())).messages,
    ).toHaveLength(0);
    log = (await app.service.host.read("user-123")) as AikoEvent[];
    expect(log.filter((e) => e.type === "AikoReplyPrepared")).toHaveLength(1);
  }, 30_000);
});
