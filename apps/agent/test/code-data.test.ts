import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  codeMode,
  infer,
  Infer,
  outputValidateOnce,
} from "tardie";
import { CodeHarness } from "../src/code-harness.ts";
import {
  CodeData,
  codeDataEventKey,
  codeDataPointer,
} from "../src/code-data.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { codeResultCustody } from "../src/code-result-custody.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import type { Event } from "tardie/core/event";
import { nodeStorage } from "entity-learn";
import { Memory } from "entity-learn/cloudflare";
import { browserMemoryGraph } from "../src/browser-memory-graph.ts";
import { indexToolArtifact } from "../src/log-memory.ts";
import { modelRequest } from "tardie/inference/request";
import { createWorkflowStore } from "../src/workflow-host.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function database() {
  const db = new Database(":memory:");
  dbs.push(db);
  return db;
}
function storage(): AccountStorage {
  const db = database();
  let alarm: number | null = null;
  return {
    sql: {
      exec: (q, ...args) => {
        const rows = db.query(q).all(...(args as any));
        return { toArray: () => rows as never };
      },
    },
    transactionSync: (fn) => db.transaction(fn)(),
    sync: async () => {},
    getAlarm: async () => alarm,
    setAlarm: async (at) => {
      alarm = at;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
}
const sourceSpec = {
  name: "indexed_fixture_read",
  description: "Read an owner-scoped captured browser result",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};
const marker = "PRIVATE_BROWSER_ROW_725";

test("native execute retains multi-MiB data across cold restart and rechecks input-specific source revocation", async () => {
  const state = storage(),
    kv = sqliteWorkflowKV(database());
  let active = true,
    sourceActive = true,
    reads = 0;
  const opened: Awaited<ReturnType<typeof createCloudflareAccountHost>>[] = [];
  const retainedSpec = {
    ...sourceSpec,
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
      additionalProperties: false,
    },
  };
  const native = {
    spec: retainedSpec,
    authorizeRetained: async (input: unknown) =>
      sourceActive && (input as any)?.action === "saved-read",
    run: () =>
      Effect.sync(() => {
        reads++;
        return {
          rows: Array.from({ length: 2200 }, (_, id) => ({
            id,
            active: id % 2 === 0,
            text: marker,
            padding: "x".repeat(1050),
          })),
        };
      }),
  };
  async function run(turn: string, code: string, check: (result: any) => void) {
    let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
    const harness = new CodeHarness(
      "123",
      "user-123",
      runCodeSegment,
      (s) => s,
      undefined,
      codeResultCustody({
        owner: "123",
        thread: "user-123",
        blobs: harnessBlobStore(kv),
        read: () => host.read("user-123"),
        current: () => active,
        currentData: () => active,
        tools: () => [retainedSpec],
      }),
    );
    const definition = actor({
      name: "aiko",
      methods: { message: agentMessageMethod },
      components: [
        infer([codeMode([harness.package([native])]), outputValidateOnce]),
      ],
    });
    let attempts = 0;
    const model = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "data" } }),
      react: (request) => {
        if (attempts++ === 0)
          return Effect.succeed({
            kind: "call" as const,
            name: "execute",
            callId: `code-${turn}`,
            arguments: { code },
          });
        check(
          request.trajectory.findLast((e) => e.type === "ToolReturned")
            ?.result as any,
        );
        return Effect.succeed({
          kind: "complete" as const,
          output: `verified-${turn}`,
        });
      },
    });
    host = await createCloudflareAccountHost({
      storage: state,
      actorName: "aiko",
      actorInstance: "data",
      ownsThread: (t) => t === "user-123",
      actorFor: () => definition,
      layersFor: () =>
        Layer.merge(harness.inference(model), harness.sandboxLayer()),
    });
    opened.push(host);
    await host.commitRoot(host.self("user-123"), {
      type: "MessageReceived",
      id: turn,
      text: turn,
      at: Date.now(),
    });
    await host.drive();
    const rows = await host.read("user-123");
    expect(rows.findLast((e) => e.type === "TurnCompleted")?.output).toBe(
      `verified-${turn}`,
    );
    expect(JSON.stringify(rows)).not.toContain(marker);
    await host.close();
    return rows;
  }
  await run(
    "retain",
    "const h=await tools.call({name:'indexed_fixture_read',arguments:{action:'saved-read'}});const b=await tools.bind({name:'captured',handle:h,expectedGeneration:0});return {kind:h.kind,bytes:h.bytes,generation:b.generation};",
    (result) => {
      expect(result.result).toMatchObject({
        kind: "aiko-data.v1",
        generation: 1,
      });
      expect(result.result.bytes).toBeGreaterThan(2 * 1024 * 1024);
    },
  );
  const rows = await run(
    "restart",
    "const b=await tools.load({name:'captured'});return await tools.query({handle:b.handle,path:'/rows',filter:{path:'/active',op:'eq',value:true},offset:3,limit:2,fields:['/id','/text']});",
    (result) => {
      expect(result.result).toEqual({
        value: [
          { "/id": 6, "/text": marker },
          { "/id": 8, "/text": marker },
        ],
        total: 1100,
        offset: 3,
        nextOffset: 5,
      });
    },
  );
  expect(reads).toBe(1);
  expect(
    rows.filter((e) => e.type === "AikoCodeDataRead").length,
  ).toBeGreaterThanOrEqual(2);
  const retained = rows.find((e) => e.type === "AikoCodeDataRetained")!;
  const graph = browserMemoryGraph(
    rows.map((event, index) => ({ seq: index + 1, event })),
  );
  expect(
    graph.edges.some(
      (edge) =>
        edge.from === `artifact:${retained.ref}` &&
        edge.relation === "derived_from",
    ),
  ).toBe(true);
  const memory = new Memory({
    storage: nodeStorage(":memory:"),
    scope: "aiko:123",
  });
  try {
    for (const event of rows) indexToolArtifact(memory, event, "123", (s) => s);
    const stored = memory.recall({
      type: "tool-artifact",
      limit: 20,
      depth: 2,
      maxNodes: 64,
    });
    const data = stored.items.find(
      (item) => (item.observation.payload as any).ref === retained.ref,
    )!.observation;
    expect(data.dependsOn).toHaveLength(1);
    expect(memory.get(data.dependsOn[0]!)!.observation.payload).toEqual({
      digest: (retained.dependencies as any[])[0].digest,
    });
    expect(JSON.stringify(memory.exportArchive())).not.toContain(marker);
    expect(JSON.stringify(graph)).not.toContain(marker);
  } finally {
    memory.close();
  }
  sourceActive = false;
  await run(
    "revoked",
    "return await tools.load({name:'captured'});",
    (result) => expect(result.result.error).toContain("source authority"),
  );
  expect(reads).toBe(1);
  active = false;
  await run(
    "account-revoked",
    "return await tools.retain({value:[1,2,3]});",
    (result) => expect(result.result.error).toContain("source authority"),
  );
});

for (const executionKind of ["execute", "workflow"] as const)
  test(`native ${executionKind} context checkpoints retain source authority through chained compaction and cold reconstruction`, async () => {
    const state = storage(),
      kv = sqliteWorkflowKV(database());
    let sourceActive = true,
      host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
    const native = {
      spec: sourceSpec,
      authorizeRetained: async () => sourceActive,
      run: () => Effect.succeed({ text: marker }),
    };
    const fresh = () =>
      new CodeHarness(
        "123",
        "user-123",
        runCodeSegment,
        (s) => s,
        createWorkflowStore(kv),
        codeResultCustody({
          owner: "123",
          thread: "user-123",
          blobs: harnessBlobStore(kv),
          read: () => host.read("user-123"),
          current: () => true,
          currentData: () => true,
          tools: () => [sourceSpec],
        }),
      );
    const harness = fresh(),
      model = { provider: "fixture", model_id: "data" };
    const definition = actor({
      name: "aiko",
      methods: { message: agentMessageMethod },
      components: [
        infer([
          codeMode([harness.package([native])]),
          harness.workflowComponent(),
          outputValidateOnce,
        ]),
      ],
    });
    let attempts = 0;
    const action = {
      kind: "call" as const,
      name: executionKind === "execute" ? "execute" : "code_workflow_run",
      callId: "read-code",
      arguments: {
        code: "return await tools.call({name:'indexed_fixture_read',arguments:{}});",
        ...(executionKind === "workflow"
          ? {
              id: "private-read",
              input: {},
              inputSchema: { type: "object" },
              outputSchema: { type: "object" },
              dependencies: [sourceSpec.name],
            }
          : {}),
      },
    };
    const source = Layer.succeed(Infer, {
      resolve: () => ({ model }),
      react: () =>
        Effect.succeed(
          attempts++ === 0
            ? action
            : { kind: "complete" as const, output: "Read complete" },
        ),
    });
    host = await createCloudflareAccountHost({
      storage: state,
      actorName: "aiko",
      actorInstance: "data",
      ownsThread: (t) => t === "user-123",
      actorFor: () => definition,
      layersFor: () =>
        Layer.merge(harness.inference(source), harness.sandboxLayer()),
    });
    try {
      await host.commitRoot(host.self("user-123"), {
        type: "MessageReceived",
        id: "read",
        text: "Read",
        at: 1,
      });
      await host.drive();
      const trajectory = await host.read("user-123"),
        identity = {
          actor: "aiko",
          instance: "data",
          thread: "user-123",
          turn: "compact",
        };
      let compacted = 0;
      const seen: any[] = [];
      const provider = Layer.succeed(Infer, {
        resolve: () => ({ model }),
        compact: (
          request: import("tardie/inference/contract").CompactionRequest,
        ) =>
          Effect.sync(() => {
            compacted++;
            if (compacted === 1)
              expect(JSON.stringify(request.trajectory)).toContain(marker);
            else
              expect(request.previous).toEqual({
                opaque: "provider-private-context",
                generation: 1,
              });
            return {
              state: {
                opaque: "provider-private-context",
                generation: compacted,
              },
            };
          }),
        react: (request: import("tardie").InferRequest) =>
          Effect.sync(() => {
            seen.push(modelRequest(request.trajectory, { ...request, model }));
            return { kind: "complete" as const, output: "Next" };
          }),
      });
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Infer).compact!({
            trajectory,
            identity,
            model,
            system: "",
            tools: [],
          });
        }).pipe(Effect.provide(harness.inference(provider))),
      );
      expect(result?.state).toMatchObject({
        kind: "aiko-code-compaction.v1",
        sources: [{ tool: sourceSpec.name }],
      });
      expect(JSON.stringify(result?.state)).not.toContain(marker);
      const chained = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Infer).compact!({
            trajectory: [],
            identity,
            model,
            system: "",
            tools: [],
            previous: result!.state,
          });
        }).pipe(Effect.provide(harness.inference(provider))),
      );
      expect(chained?.state).toMatchObject({
        sources: [{ tool: sourceSpec.name }],
      });
      const checkpoint = {
        type: "CompactionCompleted",
        keepFrom: "m:next",
        summary: "",
        providerState: chained!.state,
        model,
        at: 3,
      };
      const restored = fresh();
      restored.package([native]);
      const request = {
        identity: { ...identity, turn: "next" },
        model,
        system: "",
        tools: [],
        trajectory: [
          ...trajectory,
          checkpoint,
          { type: "MessageReceived", id: "next", text: "Continue", at: 4 },
        ],
      };
      const run = (h: CodeHarness) =>
        Effect.runPromise(
          Effect.gen(function* () {
            return yield* (yield* Infer).react(request);
          }).pipe(Effect.provide(h.inference(provider))),
        );
      await run(restored);
      expect(seen[0].providerState).toEqual({
        opaque: "provider-private-context",
        generation: 2,
      });
      sourceActive = false;
      await run(restored);
      await run(harness);
      expect(seen[1].providerState).toBeUndefined();
      expect(seen[2].providerState).toBeUndefined();
      expect(JSON.stringify(seen.slice(1))).not.toContain(marker);
      const denied = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Infer).compact!({
            ...request,
            previous: chained!.state,
          });
        }).pipe(Effect.provide(restored.inference(provider))),
      );
      expect(denied).toBeUndefined();
      expect(compacted).toBe(2);
    } finally {
      await host.close();
    }
  });

test("native journal dedup makes simultaneous binding updates conflict; derived values preserve source permissions", async () => {
  const state = storage(),
    kv = sqliteWorkflowKV(database());
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>,
    sourceActive = true;
  const native = {
    spec: sourceSpec,
    run: () => Effect.succeed({ private: marker }),
  };
  const harness = new CodeHarness(
    "123",
    "user-123",
    runCodeSegment,
    (s) => s,
    undefined,
    codeResultCustody({
      owner: "123",
      thread: "user-123",
      blobs: harnessBlobStore(kv),
      read: () => host.read("user-123"),
      current: () => sourceActive,
      currentData: () => true,
      tools: () => [sourceSpec],
    }),
  );
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [
      infer([codeMode([harness.package([native])]), outputValidateOnce]),
    ],
  });
  let attempts = 0;
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "data" } }),
    react: (request) => {
      if (attempts++ === 0)
        return Effect.succeed({
          kind: "call" as const,
          name: "execute",
          callId: "race",
          arguments: {
            code: "const raw=await tools.call({name:'indexed_fixture_read',arguments:{}});const h=await tools.retain({value:{derived:raw.private}});const writes=await Promise.all([tools.bind({name:'race',handle:h,expectedGeneration:0}),tools.bind({name:'race',handle:h,expectedGeneration:0})]);return {writes,bound:await tools.load({name:'race'})};",
          },
        });
      const output = (
        request.trajectory.findLast((e) => e.type === "ToolReturned")
          ?.result as any
      ).result;
      expect(output.writes.filter((r: any) => r.generation === 1)).toHaveLength(
        1,
      );
      expect(output.writes.filter((r: any) => r.error)).toHaveLength(1);
      expect(output.bound.generation).toBe(1);
      return Effect.succeed({ kind: "complete" as const, output: "verified" });
    },
  });
  host = await createCloudflareAccountHost({
    storage: state,
    actorName: "aiko",
    actorInstance: "data",
    ownsThread: (t) => t === "user-123",
    actorFor: () => definition,
    layersFor: () =>
      Layer.merge(harness.inference(model), harness.sandboxLayer()),
  });
  await host.commitRoot(host.self("user-123"), {
    type: "MessageReceived",
    id: "race",
    text: "race",
    at: 1,
  });
  await host.drive();
  expect(
    (await host.read("user-123")).find((e) => e.type === "TurnCompleted")
      ?.output,
  ).toBe("verified");
  const data = new CodeData({
    owner: "123",
    thread: "user-123",
    blobs: harnessBlobStore(kv),
    read: () => host.read("user-123"),
    append: async () => {
      throw Error("read only");
    },
    current: async () => true,
    authorizeSource: async () => sourceActive,
    redact: (s) => s,
  });
  const bound = await data.load("race");
  expect(bound.handle).not.toBeNull();
  sourceActive = false;
  await expect(data.load("race")).rejects.toThrow("source authority");
  await host.close();
});

test("working handles reject fabricated, cross-owner, cross-thread, prototype paths and stale replacement generations", async () => {
  const kv = sqliteWorkflowKV(database()),
    blobs = harnessBlobStore(kv),
    rows: Event[] = [],
    seen = new Set<string>();
  let current = true;
  const binding = {
    owner: "123",
    thread: "user-123",
    blobs,
    read: async () => rows,
    append: async (events: Event[]) => {
      for (const e of events) {
        const key = codeDataEventKey(e)!;
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(e);
        }
      }
    },
    current: async () => current,
    authorizeSource: async () => true,
    redact: (s: string) => s,
  };
  const data = new CodeData(binding),
    handle = await data.retain([{ a: 1 }, { a: 2 }], "call1");
  await expect(
    new CodeData({ ...binding, owner: "456" }).query(handle, {}, "x"),
  ).rejects.toThrow("authority");
  await expect(
    new CodeData({ ...binding, thread: "ag.other" }).query(handle, {}, "x"),
  ).rejects.toThrow("authority");
  await expect(
    data.query({ ...handle, ref: `sha256:${"1".repeat(64)}` }, {}, "x"),
  ).rejects.toThrow("authority");
  expect(() => codeDataPointer({}, "/__proto__/polluted")).toThrow("Prototype");
  expect(() => codeDataPointer({}, "/~2")).toThrow("escape");
  expect(await data.query(handle, { count: true }, "count")).toEqual({
    count: 2,
  });
  await data.bind("rows", handle, 0, "bind");
  await expect(data.bind("rows", handle, 0, "stale")).rejects.toThrow(
    "conflict",
  );
  await data.bind("rows", undefined, 1, "drop");
  expect(await new CodeData(binding).load("rows")).toEqual({
    name: "rows",
    generation: 2,
    handle: null,
  });
  await expect(data.bind("rows", handle, 0, "recreate")).rejects.toThrow(
    "conflict",
  );
  current = false;
  await expect(data.query(handle, {}, "revoked")).rejects.toThrow("authority");
});
