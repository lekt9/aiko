import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Infer } from "tardie";
import { createModelRouting, parseModelRouting } from "../src/model-routing.ts";
import { parseModelCapabilities } from "../src/model-capabilities.ts";

const request = {
  trajectory: [
    { type: "MessageReceived", id: "turn", text: "Read evidence", at: 1 },
  ],
  identity: {
    actor: "aiko",
    instance: "account",
    thread: "user-123",
    turn: "turn",
  },
  system: "Use indexed browser actions",
  tools: [],
};
const run = (
  layer: ReturnType<ReturnType<typeof createModelRouting>["layer"]>,
  overrides: Partial<typeof request> = {},
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Infer).react({ ...request, ...overrides });
    }).pipe(Effect.provide(layer)),
  );
const chat = () =>
  new Response(
    `data: ${JSON.stringify({ id: "reply", choices: [{ index: 0, delta: { content: "Checked" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 15 } } })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
function responses() {
  const events = [
    {
      type: "response.created",
      response: {
        id: "resp1",
        status: "in_progress",
        model: "fixture-responses",
      },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: "msg1",
        type: "message",
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      item_id: "msg1",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg1",
      output_index: 0,
      content_index: 0,
      delta: "Checked",
    },
    {
      type: "response.output_text.done",
      item_id: "msg1",
      output_index: 0,
      content_index: 0,
      text: "Checked",
    },
    {
      type: "response.completed",
      response: {
        id: "resp1",
        status: "completed",
        model: "fixture-responses",
        output: [
          {
            id: "msg1",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [
              { type: "output_text", text: "Checked", annotations: [] },
            ],
          },
        ],
        usage: {
          input_tokens: 20,
          output_tokens: 2,
          total_tokens: 22,
          input_tokens_details: { cached_tokens: 15 },
        },
      },
    },
  ];
  return new Response(
    events
      .map(
        (event, i) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`,
      )
      .join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
test("cache keys remain stable across turns and host reconstruction, separate owners/threads/prompt changes, and retain provider cache usage", async () => {
  const bodies: any[] = [];
  const env = {
    AIKO_MODEL: "fixture-cache",
    AIKO_ALLOW_PAID_INFERENCE: "true",
    CODEGRAFF_API_KEY: "fixture",
    AIKO_MODEL_CAPABILITIES: JSON.stringify({
      "codegraff/fixture-cache": {
        promptCache: { kind: "openai", retention: "24h" },
        contextWindowTokens: 131072,
      },
    }),
  };
  const router = (owner = "123") =>
    createModelRouting({
      owner,
      env,
      config: parseModelRouting(env),
      fetch: async (_, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return chat();
      },
    });
  const result = await run(router().layer("conversation"));
  await run(router().layer("conversation"), {
    identity: { ...request.identity, turn: "next" },
  });
  await run(router("456").layer("conversation"));
  await run(router().layer("conversation"), {
    identity: { ...request.identity, thread: "ag.child" },
  });
  await run(router().layer("conversation"), { system: "Changed prefix" });
  expect(result).toMatchObject({
    kind: "complete",
    usage: { cachedPromptTokens: 15 },
  });
  expect(bodies[0].prompt_cache_key).toBe(bodies[1].prompt_cache_key);
  expect(
    new Set([bodies[0], ...bodies.slice(2)].map((b) => b.prompt_cache_key))
      .size,
  ).toBe(4);
  expect(bodies[0].prompt_cache_key).toMatch(/^aiko-[a-f0-9]{56}$/);
  expect(bodies[0].prompt_cache_retention).toBe("24h");
  expect(
    router().contextFor({ provider: "codegraff", model_id: "fixture-cache" }),
  ).toEqual({ contextWindowTokens: 131072, maxOutputTokens: 1024 });
});
test("Responses route uses the native adapter, exact pinned egress and the same accounting ledger with protocol output limits", async () => {
  const wires: any[] = [],
    charges: any[] = [];
  const env = {
    AIKO_MODEL: "fixture-responses",
    AIKO_ALLOW_PAID_INFERENCE: "true",
    CODEGRAFF_API_KEY: "fixture",
    AIKO_MODEL_EFFORTS: JSON.stringify({
      "codegraff/fixture-responses": ["high"],
    }),
    AIKO_MODEL_CAPABILITIES: JSON.stringify({
      "codegraff/fixture-responses": {
        protocol: "openai-responses",
        maxOutputTokens: 512,
        promptCache: { kind: "openai" },
        serverCompaction: true,
      },
    }),
  };
  const router = createModelRouting({
    owner: "123",
    env,
    config: parseModelRouting(env),
    effort: "high",
    throttleRetryDelaysMs: [],
    budget: {
      transport: (owner, upstream) => async (url, init) => {
        charges.push({ owner, url, body: JSON.parse(String(init?.body)) });
        return upstream!(url, init);
      },
    },
    fetch: async (url, init) => {
      wires.push({ url, body: JSON.parse(String(init?.body)) });
      return responses();
    },
  });
  const result = await run(router.layer("conversation"));
  expect(result).toMatchObject({
    kind: "complete",
    output: "Checked",
    usage: { cachedPromptTokens: 15 },
  });
  expect(wires).toHaveLength(1);
  expect(wires[0].url).toBe("https://gateway.codegraff.com/v1/responses");
  expect(wires[0].body).toMatchObject({
    model: "fixture-responses",
    max_output_tokens: 512,
    store: false,
    reasoning: { effort: "high" },
  });
  expect(wires[0].body.max_tokens).toBeUndefined();
  expect(wires[0].body.messages).toBeUndefined();
  expect(wires[0].body.input).toBeArray();
  expect(charges[0]).toMatchObject({
    owner: "123",
    url: "https://gateway.codegraff.com/v1/chat/completions",
    body: { max_tokens: 512 },
  });
});
test("unsupported capabilities fail before network effects", () => {
  expect(() =>
    parseModelCapabilities(
      '{"cerebras/qwen-3.8-27b":{"protocol":"openai-responses"}}',
    ),
  ).toThrow("Unsupported Cerebras");
  expect(() =>
    parseModelCapabilities('{"codegraff/model":{"serverCompaction":true}}'),
  ).toThrow("Responses");
  expect(() =>
    parseModelCapabilities(
      '{"codegraff/model":{"promptCache":{"kind":"automatic-guessed"}}}',
    ),
  ).toThrow("cache");
  expect(() =>
    parseModelCapabilities('{"codegraff/model":{"contextWindowTokens":-1}}'),
  ).toThrow("context");
  expect(() =>
    parseModelCapabilities('{"codegraff/model":{"parallelToolCalls":"true"}}'),
  ).toThrow("parallel");
  expect(() =>
    parseModelCapabilities('{"codegraff/model":{"promptCache":false}}'),
  ).toThrow("cache");
  expect(() =>
    parseModelCapabilities('{"codegraff/model":{"promptCache":null}}'),
  ).toThrow("cache");
});

test("Cerebras parallel calls follow each model capability and explicit deployment overrides", async () => {
  for (const [model, override, expected] of [
    ["qwen-3.8-27b", undefined, true],
    ["gemma-4-31b", undefined, true],
    ["gpt-oss-120b", undefined, false],
    ["qwen-3.8-27b", false, false],
    ["gpt-oss-120b", true, true],
  ] as const) {
    let wire: any;
    const env = {
      AIKO_CONVERSATION_PROVIDER: "cerebras",
      AIKO_CONVERSATION_MODEL: model,
      AIKO_ALLOW_PAID_INFERENCE: "true",
      CEREBRAS_API_KEY: "fixture",
      AIKO_MODEL_CAPABILITIES: JSON.stringify({
        [`cerebras/${model}`]:
          override === undefined ? {} : { parallelToolCalls: override },
      }),
    };
    const router = createModelRouting({
      owner: "123",
      env,
      config: parseModelRouting(env),
      fetch: async (_, init) => {
        wire = JSON.parse(String(init?.body));
        return chat();
      },
    });
    expect(await run(router.layer("conversation"))).toMatchObject({
      kind: "complete",
    });
    expect(wire.parallel_tool_calls).toBe(expected);
  }
});
