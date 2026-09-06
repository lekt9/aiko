import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
import { createBunHost } from "tardie/bun/host";
import {
  WorkflowController,
  createWorkflowStore,
} from "../src/workflow-host.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import {
  ToolWorkflows,
  type WorkflowDefinition,
  type WorkflowDispatcher,
  type RegisteredWorkflowTool,
} from "../src/tool-workflows.ts";

const program: WorkflowDefinition = {
  version: 1,
  id: "combine_catalog",
  parameters: ["query"],
  steps: [
    {
      id: "left",
      toolId: "registered_left",
      dependsOn: [],
      arguments: { query: { kind: "input", name: "query" } },
    },
    {
      id: "right",
      toolId: "registered_right",
      dependsOn: [],
      arguments: { query: { kind: "input", name: "query" } },
    },
    {
      id: "combine",
      toolId: "registered_combine",
      dependsOn: ["left", "right"],
      arguments: {
        left: { kind: "result", step: "left", path: ["value"] },
        right: { kind: "result", step: "right", path: ["value"] },
      },
    },
  ],
  limits: { maxConcurrency: 2, timeoutMs: 5000 },
};
const runtimeInput = "runtime_query_private_sentinel";
const runtimeOutput = "runtime_result_private_sentinel";
const rawActionText = "raw_action_explanation_sentinel";
function registry(owner: string) {
  const calls: { toolId: string; input: unknown }[] = [];
  let active = 0,
    peak = 0,
    release!: () => void;
  const parallel = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tools = new Map<string, RegisteredWorkflowTool>();
  for (const id of [
    "registered_left",
    "registered_right",
    "registered_combine",
  ]) {
    const combine = id.endsWith("combine");
    tools.set(id, {
      owner,
      id,
      effect: "read",
      inputSchema: {
        type: "object",
        properties: combine
          ? { left: { type: "string" }, right: { type: "string" } }
          : { query: { type: "string" } },
        additionalProperties: false,
      },
      validate: (input) =>
        Object.keys(input).sort().join() ===
          (combine ? "left,right" : "query") &&
        Object.values(input).every((v) => typeof v === "string"),
      authorize: async (call) => call.owner === owner,
      execute: async (call) => {
        calls.push({ toolId: id, input: structuredClone(call.input) });
        if (combine)
          return { status: "succeeded", output: { combined: runtimeOutput } };
        active++;
        peak = Math.max(peak, active);
        if (active === 2) release();
        await parallel;
        active--;
        return {
          status: "succeeded",
          output: { value: id + "_" + runtimeOutput },
        };
      },
    });
  }
  const dispatcher: WorkflowDispatcher = {
    resolve: async (c) => (c.owner === owner ? tools.get(c.toolId) : undefined),
  };
  return { calls, dispatcher, peak: () => peak };
}
async function scanDatabaseFiles(directory: string, sentinels: string[]) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanDatabaseFiles(path, sentinels);
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(path);
    for (const sentinel of sentinels)
      expect(bytes.includes(Buffer.from(sentinel))).toBe(false);
  }
}

test("Native BunHost executes parallel workflow, hydrates transient outputs, crystallizes and lists using real SQLite", async () => {
  const directory = await mkdtemp("/tmp/aiko-workflow-host-");
  const database = new Database(join(directory, "workflows.sqlite"));
  database.exec("PRAGMA journal_mode=WAL");
  const store = createWorkflowStore(sqliteWorkflowKV(database)),
    registered = registry("alice");
  const controller = new WorkflowController(
    "alice",
    "user-alice",
    { store, dispatcher: registered.dispatcher },
    (s) => s,
  );
  let hydrated = false,
    listed = false;
  let nativeRunId: string | undefined;
  const model = Layer.succeed(Infer, {
    resolve: () => ({
      model: { provider: "test", model_id: "workflow-controller" },
    }),
    react: (req) => {
      const rows = req.trajectory.filter(
        (e) => e.type === "ToolReturned",
      ) as any[];
      if (!rows.length)
        return Effect.succeed({
          kind: "call" as const,
          callId: "run",
          name: "workflow_run",
          arguments: {
            program: JSON.stringify(program),
            input: JSON.stringify({ query: runtimeInput }),
          },
          text: rawActionText,
        });
      if (rows.length === 1) {
        const result = rows[0].result;
        nativeRunId = result.receipt?.runId;
        hydrated = JSON.stringify(result.untrustedToolResults ?? {}).includes(
          runtimeOutput,
        );
        return Effect.succeed({
          kind: "call" as const,
          callId: "save",
          name: "workflow_crystallize",
          arguments: { workflowId: program.id, runId: nativeRunId },
        });
      }
      if (rows.length === 2)
        return Effect.succeed({
          kind: "call" as const,
          callId: "list",
          name: "workflow_list",
          arguments: {},
        });
      listed = rows[2].result.untrustedToolResults.some(
        (r: any) => r.definition.id === program.id && r.reusable === true,
      );
      return Effect.succeed({
        kind: "complete" as const,
        output: "Workflow completed and saved.",
      });
    },
  });
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [infer([tool(controller.tools()), outputValidateOnce])],
  });
  const host = await createBunHost({
    database: join(directory, "actor.sqlite"),
    actorName: "aiko",
    actorInstance: "workflow-test",
    actorFor: () => definition,
    layersFor: () => controller.inference(model),
  });
  try {
    await host.commitRoot(host.self("user-alice"), {
      type: "MessageReceived",
      id: "request",
      text: "Run and save the registered workflow",
      at: Date.now(),
    });
    await host.wake("user-alice");
    const events = await host.read("user-alice");
    expect(hydrated).toBe(true);
    expect(listed).toBe(true);
    expect(registered.peak()).toBe(2);
    expect(registered.calls).toHaveLength(3);
    expect(registered.calls[2]!.input).toEqual({
      left: "registered_left_" + runtimeOutput,
      right: "registered_right_" + runtimeOutput,
    });
    expect((await store.getDefinition("alice", program.id))?.reusable).toBe(
      true,
    );
    expect((await store.getRun("alice", nativeRunId!))?.status).toBe(
      "succeeded",
    );
    expect(events.filter((e) => e.type === "ToolReturned")).toHaveLength(3);
    for (const sentinel of [runtimeInput, runtimeOutput, rawActionText])
      expect(JSON.stringify(events)).not.toContain(sentinel);
    await scanDatabaseFiles(directory, [
      runtimeInput,
      runtimeOutput,
      rawActionText,
    ]);
    const reopened = new Database(join(directory, "workflows.sqlite"));
    try {
      expect(
        (
          await createWorkflowStore(sqliteWorkflowKV(reopened)).getDefinition(
            "alice",
            program.id,
          )
        )?.provenance?.runId,
      ).toBe(nativeRunId);
    } finally {
      reopened.close();
    }
  } finally {
    await host.close();
    database.close();
    await scanDatabaseFiles(directory, [
      runtimeInput,
      runtimeOutput,
      rawActionText,
    ]);
    await rm(directory, { recursive: true, force: true });
  }
});

test("independent SQLite workflow hosts fence an in-flight and completed run; definitions and terminal receipts cannot be replaced", async () => {
  const directory = await mkdtemp("/tmp/aiko-workflow-fence-");
  const db1 = new Database(join(directory, "workflow.sqlite")),
    db2 = new Database(join(directory, "workflow.sqlite"));
  const first = createWorkflowStore(sqliteWorkflowKV(db1)),
    second = createWorkflowStore(sqliteWorkflowKV(db2));
  let started!: () => void,
    release!: () => void,
    calls = 0;
  const began = new Promise<void>((r) => {
      started = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const dispatcher: WorkflowDispatcher = {
    resolve: async ({ owner, toolId }) => ({
      owner,
      id: toolId,
      effect: "read",
      inputSchema: { type: "object" },
      validate: () => true,
      authorize: async () => true,
      execute: async () => {
        calls++;
        started();
        await gate;
        return { status: "succeeded", output: runtimeOutput };
      },
    }),
  };
  const a = new ToolWorkflows({ owner: "alice", store: first, dispatcher }),
    b = new ToolWorkflows({ owner: "alice", store: second, dispatcher });
  const single: WorkflowDefinition = {
    version: 1,
    id: "single",
    parameters: ["query"],
    steps: [program.steps[0]!],
  };
  try {
    await a.define(single);
    const running = a.run({
      workflowId: "single",
      runId: "same_run",
      input: { query: runtimeInput },
    });
    await began;
    expect(
      (
        await b.run({
          workflowId: "single",
          runId: "same_run",
          input: { query: "different_runtime_input" },
        })
      ).status,
    ).toBe("unknown");
    expect(calls).toBe(1);
    release();
    const settled = await running;
    expect(settled.status).toBe("succeeded");
    expect(
      await b.run({
        workflowId: "single",
        runId: "same_run",
        input: { query: runtimeInput },
      }),
    ).toEqual(settled);
    expect(calls).toBe(1);
    await expect(
      second.finishRun("alice", { ...settled, status: "running" }),
    ).rejects.toThrow();
    const saved = (await first.getDefinition("alice", "single"))!;
    await expect(
      second.putDefinition("alice", { ...saved, digest: "conflicting" }),
    ).rejects.toThrow();
    const bob = new ToolWorkflows({ owner: "bob", store: second, dispatcher });
    expect(await bob.list()).toEqual([]);
    await expect(
      bob.run({
        workflowId: "single",
        runId: "same_run",
        input: { query: runtimeInput },
      }),
    ).rejects.toThrow();
    await expect(
      bob.crystallize({ workflowId: "single", runId: "same_run" }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
    await scanDatabaseFiles(directory, [
      runtimeInput,
      runtimeOutput,
      "different_runtime_input",
    ]);
  } finally {
    release();
    db1.close();
    db2.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("native workflow opaque handles cannot cross owner threads", async () => {
  const directory = await mkdtemp("/tmp/aiko-workflow-owner-");
  const db = new Database(join(directory, "workflow.sqlite"));
  const registered = registry("alice"),
    controller = new WorkflowController(
      "alice",
      "user-alice",
      {
        store: createWorkflowStore(sqliteWorkflowKV(db)),
        dispatcher: registered.dispatcher,
      },
      (s) => s,
    );
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "test", model_id: "owner" } }),
    react: (req) =>
      Effect.succeed(
        req.trajectory.some((e) => e.type === "ToolReturned")
          ? { kind: "complete" as const, output: "Access checked." }
          : {
              kind: "call" as const,
              callId: "foreign",
              name: "workflow_run",
              arguments: {
                program: JSON.stringify(program),
                input: JSON.stringify({ query: runtimeInput }),
              },
            },
      ),
  });
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [infer([tool(controller.tools()), outputValidateOnce])],
  });
  const host = await createBunHost({
    database: join(directory, "actor.sqlite"),
    actorName: "aiko",
    actorInstance: "foreign-test",
    actorFor: () => definition,
    layersFor: () => controller.inference(model),
  });
  try {
    await host.commitRoot(host.self("user-bob"), {
      type: "MessageReceived",
      id: "foreign",
      text: "Attempt foreign workflow",
      at: Date.now(),
    });
    await host.wake("user-bob");
    const events = await host.read("user-bob");
    expect(registered.calls).toHaveLength(0);
    expect(
      (events.find((e) => e.type === "ToolReturned") as any).result.status,
    ).toBe("blocked");
    expect(await controller.engine.list()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain(runtimeInput);
  } finally {
    await host.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("configured credential redaction applies before workflow outputs enter model inference", async () => {
  const directory = await mkdtemp("/tmp/aiko-workflow-redaction-");
  const db = new Database(join(directory, "workflow.sqlite"));
  const registered = registry("alice");
  const controller = new WorkflowController(
    "alice",
    "user-alice",
    {
      store: createWorkflowStore(sqliteWorkflowKV(db)),
      dispatcher: registered.dispatcher,
    },
    (s) => s.replaceAll(runtimeOutput, "[redacted]"),
  );
  let visible = "";
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "test", model_id: "redaction" } }),
    react: (req) => {
      if (!req.trajectory.some((e) => e.type === "ToolReturned"))
        return Effect.succeed({
          kind: "call" as const,
          callId: "run",
          name: "workflow_run",
          arguments: {
            program: JSON.stringify(program),
            input: JSON.stringify({ query: runtimeInput }),
          },
        });
      visible = JSON.stringify(req.trajectory);
      return Effect.succeed({
        kind: "complete" as const,
        output: "Results inspected safely.",
      });
    },
  });
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [infer([tool(controller.tools()), outputValidateOnce])],
  });
  const host = await createBunHost({
    database: join(directory, "actor.sqlite"),
    actorName: "aiko",
    actorInstance: "redaction-test",
    actorFor: () => definition,
    layersFor: () => controller.inference(model),
  });
  try {
    await host.commitRoot(host.self("user-alice"), {
      type: "MessageReceived",
      id: "redaction",
      text: "Inspect registered workflow results",
      at: Date.now(),
    });
    await host.wake("user-alice");
    expect(registered.calls).toHaveLength(3);
    expect(visible).not.toContain(runtimeOutput);
    expect(visible).toContain("[redacted]");
  } finally {
    await host.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workflow inference preserves ordinary completion output shape, including after an older workflow turn", async () => {
  const db = new Database(":memory:");
  const controller = new WorkflowController("alice", "user-alice", {
    store: createWorkflowStore(sqliteWorkflowKV(db)),
    dispatcher: { resolve: async () => undefined },
  }, () => { throw new Error("Non-workflow output must not enter workflow redaction"); });
  try {
    for (const output of ["ordinary answer", { decision: "notify", supports: ["evidence"], count: 2 }, ["structured", { value: true }]]) {
      // The default Infer type declares string output; probe structured host-adapter payloads
      // at the runtime seam as well, so this wrapper cannot coerce them accidentally.
      const action = { kind: "complete" as const, output } as unknown as { kind: "complete"; output: string };
      const base = Layer.succeed(Infer, {
        resolve: () => ({ model: { provider: "test", model_id: "test" } }),
        react: () => Effect.succeed(action),
      });
      const result = await Effect.runPromise(Effect.gen(function* () {
        const model = yield* Infer;
        return yield* model.react({
          identity: { thread: "user-alice", turn: "ordinary-current", epoch: 0 },
          trajectory: [{ type: "ToolReturned", turn: "old-workflow", result: { kind: "workflow-receipt", owner: "alice" } }],
        } as unknown as import("tardie").InferRequest);
      }).pipe(Effect.provide(controller.inference(base))));
      expect(result).toBe(action);
      expect<unknown>(result.kind === "complete" && result.output).toBe(output);
    }
  } finally { db.close(); }
});
