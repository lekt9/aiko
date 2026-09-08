import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { Infer } from "tardie";
import { createModelRouting, parseModelRouting } from "../src/model-routing.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { hydrateProviderCompaction } from "../src/model-compaction.ts";
import { withRoleInference } from "../src/inference-routing.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
const model = { provider: "codegraff", model_id: "fixture-responses" };
const identity = {
  actor: "aiko",
  instance: "fixture",
  thread: "user-123",
  turn: "turn",
};
const compacted = [
  {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "PRIVATE_COMPACTION_CONTEXT" }],
  },
  {
    type: "compaction",
    id: "cmp1",
    encrypted_content: "opaque-provider-state",
  },
];
function fixture() {
  const db = new Database(":memory:");
  dbs.push(db);
  const kv = sqliteWorkflowKV(db);
  const env = {
    AIKO_MODEL: model.model_id,
    AIKO_ALLOW_PAID_INFERENCE: "true",
    CODEGRAFF_API_KEY: "fixture",
    AIKO_MODEL_CAPABILITIES: JSON.stringify({
      "codegraff/fixture-responses": {
        protocol: "openai-responses",
        serverCompaction: true,
      },
    }),
  };
  let active = true,
    status = 200,
    output = compacted;
  const wires: any[] = [],
    charges: any[] = [];
  const options = {
    owner: "123",
    env,
    config: parseModelRouting(env),
    compactionBlobs: harnessBlobStore(kv),
    authorizeCompaction: async () => active,
    throttleRetryDelaysMs: [],
    budget: {
      transport:
        (owner: string, upstream: any) => async (url: any, init: any) => {
          charges.push({ owner, url, body: JSON.parse(init.body) });
          return upstream(url, init);
        },
    },
    fetch: async (url: any, init: any) => {
      const body = JSON.parse(init.body);
      wires.push({ url, body });
      if (String(url).endsWith("/compact"))
        return Response.json(
          {
            output,
            usage: {
              input_tokens: 90,
              output_tokens: 20,
              total_tokens: 110,
              input_tokens_details: { cached_tokens: 12 },
            },
          },
          { status },
        );
      const events = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            id: "message",
            type: "message",
            role: "assistant",
            content: [],
          },
        },
        {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          item_id: "message",
          delta: "Continued",
        },
        {
          type: "response.completed",
          response: {
            id: "response",
            status: "completed",
            output: [],
            usage: { input_tokens: 10, output_tokens: 2 },
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
    },
  };
  return {
    options,
    wires,
    charges,
    setActive: (v: boolean) => {
      active = v;
    },
    bad: () => {
      output = [];
    },
    fail: () => {
      status = 503;
    },
  };
}
const old = [
  { type: "MessageReceived", id: "old", text: "Earlier fact", at: 1 },
  { type: "TurnCompleted", turn: "old", output: "Finished earlier", at: 2 },
];

test("native compaction hook uses the budgeted standalone endpoint, seals the full output, and a fresh routing layer reuses it verbatim", async () => {
  const f = fixture(),
    router = createModelRouting(f.options);
  const request = {
    trajectory: old,
    identity,
    model,
    system: "Keep source references",
    tools: [],
  };
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Infer).compact!(request, "compact-old");
    }).pipe(Effect.provide(router.layer("conversation"))),
  );
  expect(result).toMatchObject({
    state: {
      kind: "aiko-provider-compaction.v1",
      owner: "123",
      thread: "user-123",
    },
    usage: { promptTokens: 90, completionTokens: 20, cachedPromptTokens: 12 },
  });
  expect(JSON.stringify(result?.state)).not.toContain("PRIVATE_");
  expect(f.wires[0]).toMatchObject({
    url: "https://gateway.codegraff.com/v1/responses/compact",
    body: { model: model.model_id, instructions: "Keep source references" },
  });
  expect(f.wires[0].body.max_tokens).toBeUndefined();
  expect(f.wires[0].body.max_output_tokens).toBeUndefined();
  expect(f.charges[0].body.max_tokens).toBe(1024);
  const checkpoint = {
    type: "CompactionCompleted",
    keepFrom: "m:next",
    summary: "",
    providerState: result!.state,
    model,
    at: 3,
  };
  const current = {
    type: "MessageReceived",
    id: "next",
    text: "Continue",
    at: 4,
  };
  const fresh = createModelRouting({
    ...f.options,
    compactionBlobs: harnessBlobStore(sqliteWorkflowKV(dbs[0]!)),
  });
  const answer = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* Infer).react({
        ...request,
        identity: { ...identity, turn: "next" },
        trajectory: [...old, checkpoint, current],
      });
    }).pipe(Effect.provide(fresh.layer("conversation"))),
  );
  expect(answer).toMatchObject({ kind: "complete", output: "Continued" });
  expect(f.wires[1].body.input.slice(0, compacted.length)).toEqual(compacted);
  expect(JSON.stringify(f.wires[1].body.input)).not.toContain("Earlier fact");
  expect(JSON.stringify(f.wires[1].body.input)).toContain("Continue");
  expect(f.charges).toHaveLength(2);
});

test("repeated compaction includes the entire previous compacted window and rejects cross-thread/owner/model or revoked custody", async () => {
  const f = fixture(),
    router = createModelRouting(f.options),
    request = { trajectory: old, identity, model, system: "", tools: [] };
  const compact = (previous?: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Infer).compact!({ ...request, previous });
      }).pipe(Effect.provide(router.layer("conversation"))),
    );
  const first = await compact();
  await compact(first!.state);
  expect(f.wires[1].body.input.slice(0, compacted.length)).toEqual(compacted);
  const custody = {
    blobs: f.options.compactionBlobs,
    current: f.options.authorizeCompaction,
  };
  await expect(
    hydrateProviderCompaction(first!.state, "456", identity, model, custody),
  ).rejects.toThrow("authority");
  await expect(
    hydrateProviderCompaction(
      first!.state,
      "123",
      { ...identity, thread: "ag.other" },
      model,
      custody,
    ),
  ).rejects.toThrow("authority");
  await expect(
    hydrateProviderCompaction(
      first!.state,
      "123",
      identity,
      { ...model, model_id: "different" },
      custody,
    ),
  ).rejects.toThrow("authority");
  f.setActive(false);
  await expect(
    hydrateProviderCompaction(first!.state, "123", identity, model, custody),
  ).rejects.toThrow("authority");
  expect(await compact()).toBeUndefined();
  expect(f.wires).toHaveLength(2);
});

test("invalid provider output and HTTP failure never produce a checkpoint", async () => {
  const f = fixture(),
    router = createModelRouting(f.options),
    request = { trajectory: old, identity, model, system: "", tools: [] };
  const invoke = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Infer).compact!(request);
      }).pipe(Effect.provide(router.layer("conversation"))),
    );
  f.bad();
  expect(await invoke()).toBeUndefined();
  f.fail();
  expect(await invoke()).toBeUndefined();
  expect(f.charges).toHaveLength(2);
});

test("foreground role routing compacts the exact historic model, including configured fallbacks", async () => {
  const f = fixture();
  const env = {
    ...f.options.env,
    AIKO_MODEL: "fixture-chat",
    AIKO_RAG_FALLBACKS: JSON.stringify([
      { provider: model.provider, model: model.model_id },
    ]),
  };
  const router = createModelRouting({
    ...f.options,
    env,
    config: parseModelRouting(env),
  });
  const request = {
    trajectory: old,
    identity,
    model,
    system: "Preserve indexed sources",
    tools: [],
  };
  const layer = withRoleInference(
    (role) => router.layer(role),
    (ref) => router.layerFor(ref),
  );
  const run = (selected = model) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Infer).compact!({ ...request, model: selected });
      }).pipe(Effect.provide(layer)),
    );
  expect(await run()).toMatchObject({ state: { model: model.model_id } });
  expect(f.wires[0]).toMatchObject({
    url: "https://gateway.codegraff.com/v1/responses/compact",
    body: { model: model.model_id },
  });
  expect(
    await run({ provider: "codegraff", model_id: "retired-model" }),
  ).toBeUndefined();
  expect(f.wires).toHaveLength(1);
});
