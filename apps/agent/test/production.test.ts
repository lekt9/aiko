import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, cp } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { createService } from "../src/server.ts";
import { type AikoConfig, PERSONA } from "../src/config.ts";
import { ModelBudget } from "../src/model-budget.ts";
import { createTelegramPoller } from "../src/telegram-polling.ts";
import { readPublicPage, extractPublicHTML } from "../src/public-web.ts";
import { backupState } from "../src/backup.ts";
import { controlCommand, workStatus } from "../src/telegram-control.ts";
import { event } from "../src/actor.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  configOverride: Partial<AikoConfig> = {},
  overrides: Parameters<typeof createService>[1] = {},
) {
  const stateDir = await mkdtemp("/tmp/aiko-production-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const config: AikoConfig = {
    stateDir,
    mode: "live",
    instanceId: "stable",
    port: 4242,
    operatorToken: "operator-test-secret-123456789012345",
    modelKey: "model-test-secret-123456789012345",
    persona: PERSONA,
    voiceEnabled: false,
    voiceKey: "thinkfeel-fixture-key",
    allowedUsers: new Set(["123", "456"]),
    botToken: "123:fixture-only-token",
    webhookSecret: "fixture-webhook-secret-1234567890123",
    publicWeb: true,
    ...configOverride,
  };
  const configuredOverrides = {
    voiceFetch: async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return Response.json({ personified: body.raw });
    },
    ...overrides,
  };
  let service = await createService(config, configuredOverrides);
  cleanup.push(() => service.close());
  const request = (path: string, body?: object) =>
    service.fetch(
      new Request(`http://127.0.0.1:4242${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${config.operatorToken}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return {
    config,
    request,
    get service() {
      return service;
    },
    restart: async (patch: Partial<AikoConfig> = {}, next: Parameters<typeof createService>[1] = configuredOverrides) => {
      await service.close();
      Object.assign(config, patch);
      service = await createService(config, { ...configuredOverrides, ...next });
    },
  };
}
const answerModel = (text: string) =>
  Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "production-test" },
    }),
    react: () => Effect.succeed({ kind: "complete" as const, output: text }),
  });
const update = (id: number, user: number, text: string) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 1,
    from: { id: user, is_bot: false },
    chat: { id: user, type: "private" },
    text,
  },
});

test("live replies deliver real model prose, not demo templates, while redacting credentials", async () => {
  const f = await fixture(
    {},
    {
      model: answerModel(
        "A leap year has 366 days. model-test-secret-123456789012345",
      ),
    },
  );
  await f.request("/v1/messages", {
    id: "live_answer_001",
    text: "How long is a leap year?",
  });
  await f.service.host.drive();
  const result = await (await f.request("/v1/messages")).json();
  expect(result.messages.at(-1).text).toContain("366 days");
  expect(result.messages.at(-1).text).not.toContain(f.config.modelKey);
  expect(result.messages.at(-1).source).toBe("thinkfeel");
  const status = await (await f.request("/v1/status")).json();
  expect(status.fixtures).toBe(false);
  expect(status.memory.logFollower.status).toBe("current");
});

test("live API replies never expose raw drafts when ThinkFeel is unavailable", async () => {
  const f = await fixture({}, {
    model: answerModel("Raw response must stay private"),
    voiceFetch: async () => new Response("unavailable", { status: 503 }),
  });
  await f.request("/v1/messages", { id: "thinkfeel_failure_001", text: "Explain this" });
  await f.service.host.drive();
  const result = await (await f.request("/v1/messages")).json();
  expect(result.messages.at(-1)).toMatchObject({ text: "I couldn’t safely prepare my reply. Please try again.", source: "service", reason: "unavailable" });
  expect(JSON.stringify(result)).not.toContain("Raw response must stay private");
});

test("demo-to-live cutover preserves native identity, old history and entity memory without a database reset", async () => {
  const f = await fixture({ mode: "demo", instanceId: "demo" });
  await f.request("/v1/messages", {
    id: "cutover_note_001",
    text: "Remember: Launch reviews use UTC",
  });
  await f.service.host.drive();
  const before = await (await f.request("/v1/memory/recall?search=UTC")).json();
  const citation = before.items[0].observation.id;
  await f.restart(
    { mode: "live" },
    { model: answerModel("Live inference is answering this question.") },
  );
  expect(
    (await (await f.request(`/v1/memory/observations/${citation}`)).json())
      .observation.id,
  ).toBe(citation);
  expect(
    (await (await f.request("/v1/messages")).json()).messages[0].text,
  ).toContain("Launch reviews");
  await f.request("/v1/messages", {
    id: "cutover_live_002",
    text: "Are you there?",
  });
  await f.service.host.drive();
  expect(
    (await (await f.request("/v1/messages")).json()).messages.at(-1).text,
  ).toContain("Live inference");
});

test("public page tool reads only an exact owner-supplied URL, records citations and denies model-constructed URLs", async () => {
  let reads = 0,
    target = "https://example.com/";
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "web-test" } }),
    react: (request) => {
      expect(
        request.tools.some((tool) =>
          ["apps_list", "demo_issues_list"].includes(tool.name),
        ),
      ).toBe(false);
      const result = request.trajectory.findLast(
        (e) => e.type === "ToolReturned" && e.turn === request.identity.turn,
      );
      return Effect.succeed(
        result
          ? { kind: "complete" as const, output: "The page was handled." }
          : {
              kind: "call" as const,
              name: "web_read",
              callId: `${request.identity.turn}:web`,
              arguments: { url: target },
            },
      );
    },
  });
  const f = await fixture(
    {},
    {
      model,
      webRead: async (url) => {
        reads++;
        return {
          url,
          title: "A real public page",
          text: "heliotropecitron",
          truncated: false,
        };
      },
    },
  );
  await f.request("/v1/messages", {
    id: "web_allowed_001",
    text: "Read https://example.com/",
  });
  await f.service.host.drive();
  expect(reads).toBe(1);
  const recalled = await (
    await f.request("/v1/memory/recall?search=heliotropecitron")
  ).json();
  expect(recalled.items[0].observation.producer.kind).toBe("tool");
  expect(recalled.items[0].observation.payload.url).toBe(
    "https://example.com/",
  );
  target = "https://example.com/?private=exfiltration";
  await f.request("/v1/messages", {
    id: "web_denied_002",
    text: "Read https://example.com/",
  });
  await f.service.host.drive();
  expect(reads).toBe(1);
  const parsed = await extractPublicHTML(
    "<title>Reader test</title><script>DO_NOT_COPY_SCRIPT</script><p>Visible evidence.</p>",
  );
  expect(parsed.title).toBe("Reader test");
  expect(parsed.text).toContain("Visible evidence");
  expect(parsed.text).not.toContain("DO_NOT_COPY_SCRIPT");
  for (const url of [
    "http://127.0.0.1/",
    "http://169.254.169.254/",
    "https://user:password@example.com/",
    "file:///etc/passwd",
  ])
    await expect(
      readPublicPage(url, new AbortController().signal),
    ).rejects.toThrow();
});

test("offline backup refuses an active host and restores native history and pinned memory", async () => {
  const f = await fixture({ mode: "demo" });
  await f.request("/v1/messages", {
    id: "backup_note_001",
    text: "Remember: Backup launch uses UTC",
  });
  await f.service.host.drive();
  const memory = await (await f.request("/v1/memory/recall?search=UTC")).json();
  const parent = await mkdtemp("/tmp/aiko-backup-test-");
  cleanup.push(async () => {
    await f.service.close();
    await rm(parent, { recursive: true, force: true });
  });
  const snapshot = join(parent, "snapshot"),
    restored = join(parent, "restored");
  await expect(backupState(f.config, snapshot)).rejects.toThrow();
  await f.service.close();
  const manifest = await backupState(f.config, snapshot);
  for (const file of manifest.files)
    expect(
      createHash("sha256")
        .update(await readFile(join(snapshot, file.path)))
        .digest("hex"),
    ).toBe(file.sha256);
  await cp(snapshot, restored, { recursive: true });
  await f.restart({ stateDir: restored });
  expect(
    (await (await f.request("/v1/messages")).json()).messages[0].text,
  ).toContain("Backup launch");
  expect(
    (
      await (
        await f.request(
          `/v1/memory/observations/${memory.items[0].observation.id}`,
        )
      ).json()
    ).observation.id,
  ).toBe(memory.items[0].observation.id);
});

test("durable inference reservations bound real HTTP calls per account and globally across restarts", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-budget-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const limits = { globalPerDay: 3, accountPerDay: 2, maxConcurrent: 1 };
  let budget = new ModelBudget(stateDir, limits);
  cleanup.push(async () => budget.close());
  let calls = 0;
  const upstream = async (_url: unknown, init?: RequestInit) => {
    if (init?.redirect === "error")
      throw new TypeError("Workers does not support redirect:error");
    expect(init?.redirect).toBe("manual");
    calls++;
    return new Response("data: [DONE]\n\n");
  };
  const call = async (owner: string) =>
    (
      await budget.transport(owner, upstream)(
        "https://gateway.codegraff.com/v1/chat/completions",
        { method: "POST", body: JSON.stringify({ max_tokens: 1024 }) },
      )
    ).text();
  await call("alice");
  await call("alice");
  await expect(call("alice")).rejects.toThrow("allowance");
  await call("bob");
  expect(calls).toBe(3);
  expect(budget.status("alice").active).toBe(0);
  budget.close();
  budget = new ModelBudget(stateDir, limits);
  await expect(call("bob")).rejects.toThrow("allowance");
  expect(calls).toBe(3);
  expect(budget.status("bob").accountCalls).toBe(1);
});

test("inference abort releases an unconsumed stream slot; failed requests stay charged and errors are sanitized", async () => {
  const dir = await mkdtemp("/tmp/aiko-budget-abort-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const budget = new ModelBudget(dir, {
    globalPerDay: 2,
    accountPerDay: 2,
    maxConcurrent: 1,
  });
  cleanup.push(async () => budget.close());
  const controller = new AbortController();
  let cancelled = 0;
  const endpoint = "https://gateway.codegraff.com/v1/chat/completions";
  const body = JSON.stringify({ max_tokens: 1024 });
  const response = await budget.transport(
    "alice",
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("data: pending\\n\\n"));
          },
          cancel() {
            cancelled++;
          },
        }),
      ),
  )(endpoint, { method: "POST", body, signal: controller.signal });
  expect(budget.status("alice").active).toBe(1);
  controller.abort();
  await Bun.sleep(0);
  expect(budget.status("alice").active).toBe(0);
  expect(cancelled).toBe(1);
  await response.body?.cancel();
  const failed = await budget.transport(
    "alice",
    async () => new Response("provider-sensitive-body", { status: 500 }),
  )(endpoint, { method: "POST", body });
  expect(await failed.text()).not.toContain("provider-sensitive-body");
  expect(budget.status("alice").accountCalls).toBe(2);
  await expect(
    budget.transport("alice")(endpoint, { method: "POST", body }),
  ).rejects.toThrow("allowance");
});

test("model transport never follows credential-bearing redirects and releases its slot", async () => {
  const dir = await mkdtemp("/tmp/aiko-budget-redirect-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const budget = new ModelBudget(dir);
  cleanup.push(async () => budget.close());
  let calls = 0;
  const response = await budget.transport("alice", async (_url, init) => {
    calls++;
    expect(init?.redirect).toBe("manual");
    return new Response("sensitive redirect body", {
      status: 302,
      headers: { location: "https://untrusted.invalid/steal" },
    });
  })("https://gateway.codegraff.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ max_tokens: 1024 }),
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("sensitive");
  expect(calls).toBe(1);
  expect(budget.status("alice").active).toBe(0);
});

test("Telegram controls are durable, owner-scoped and do not spend model requests", async () => {
  let calls = 0,
    sends = 0;
  const model = Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "fixture", model_id: "control-test" },
    }),
    react: () => {
      calls++;
      return Effect.succeed({
        kind: "complete" as const,
        output: "Must not run",
      });
    },
  });
  const f = await fixture(
    {},
    {
      model,
      telegramFetch: async () => {
        sends++;
        return Response.json({ ok: true, result: { message_id: 1 } });
      },
    },
  );
  const accept = (value: object) =>
    f.service.acceptTelegram(
      new Request("http://127.0.0.1/telegram/webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": f.config.webhookSecret! },
        body: JSON.stringify(value),
      }),
    );
  for (const [id, text] of [
    [1, "/start"],
    [2, "/status"],
    [3, "/cancel"],
  ] as const) {
    expect(await accept(update(id, 123, text))).toBe("accepted");
    await f.service.host.drive();
  }
  expect(calls).toBe(0);
  expect(sends).toBe(3);
  expect(await accept(update(1, 123, "/start"))).toBe("duplicate");
  await f.service.host.drive();
  expect(sends).toBe(3);
  expect((await f.service.host.read("user-456")).length).toBe(0);
  expect(JSON.stringify(await f.service.host.read("user-123"))).toContain(
    "Inference: live",
  );
  await f.restart();
  expect(await accept(update(2, 123, "/status"))).toBe("duplicate");
  await f.service.host.drive();
  expect(sends).toBe(3);
});

test("status questions reply through ThinkFeel while the main inference is still blocked", async () => {
  let started = false;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sent: string[] = [];
  const f = await fixture({}, {
    model: Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "blocked" } }),
      react: () => { started = true; return Effect.promise(async () => { await blocked; return { kind: "complete" as const, output: "Finished" }; }); },
    }),
    telegramFetch: async (url, init) => {
      if (String(url).endsWith("/sendMessage")) sent.push(JSON.parse(String(init?.body)).text);
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  const accept = (id: number, text: string) => f.service.acceptTelegram(new Request("http://127.0.0.1/telegram/webhook", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": f.config.webhookSecret! }, body: JSON.stringify(update(id, 123, text)),
  }));
  cleanup.push(async () => { release(); });
  expect(await accept(200, "Research this for me")).toBe("accepted");
  for (let i = 0; !started && i < 100; i++) await Bun.sleep(10);
  expect(started).toBe(true);
  await f.service.host.seed("user-123", [event("AikoBrowserActionStarted", { id: "browser-1", turn: "telegram:200", owner: "123" })]);
  expect(await accept(201, "what's happening?")).toBe("accepted");
  for (let i = 0; !sent.length && i < 100; i++) await Bun.sleep(10);
  expect(sent.some(text => text.includes("browser action is in progress"))).toBe(true);
  const log = await f.service.host.read("user-123");
  expect(log.some(e => e.type === "TurnCompleted" && e.turn === "telegram:200")).toBe(false);
  expect(log.find(e => e.type === "AikoReplyPrepared" && e.turn === "telegram:201")?.result).toMatchObject({ source: "thinkfeel" });
});

test("status matching is narrow and completed work is not reported as running", () => {
  expect(controlCommand("What's happening?")).toBe("status");
  expect(controlCommand("What's happening? Also book a table")).toBeUndefined();
  expect(workStatus([event("MessageReceived", { id: "one" }), event("TurnCompleted", { turn: "one" })])).toContain("no unfinished");
});

test("durable Telegram inbox redacts before storage and allows another account past a busy account", async () => {
  const f = await fixture({}, { model: answerModel("unused") });
  const delivered: number[] = [];
  const service = {
    prepareTelegram: f.service.prepareTelegram,
    acceptTelegram: async (request: Request) => {
      const value = await request.json();
      if (value.update_id === 1) return "busy" as const;
      delivered.push(value.update_id);
      return "accepted" as const;
    },
  };
  let batch = [
    update(1, 123, `Remember: ${f.config.operatorToken}`),
    update(2, 456, "Hello"),
  ];
  const poller = createTelegramPoller(f.config, service, async () =>
    Response.json({ ok: true, result: batch }),
  );
  await poller.pollOnce();
  expect(delivered).toEqual([2]);
  expect(poller.status().pending).toBe(1);
  batch = [update(3, 123, "/cancel")];
  await poller.pollOnce();
  expect(delivered).toEqual([2, 3]);
  expect(poller.status().pending).toBe(0);
  await poller.close();
  const hash = createHash("sha256").update("123").digest("hex").slice(0, 24);
  expect(
    (
      await readFile(join(f.config.stateDir, `telegram-${hash}.sqlite`))
    ).includes(Buffer.from(f.config.operatorToken)),
  ).toBe(false);
});
