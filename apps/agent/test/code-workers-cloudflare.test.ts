import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serialize, deserialize } from "node:v8";
import { Effect } from "effect";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { workerGrantOf } from "../src/code-agents.ts";

function durableStorage(db: Database) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS fixture_kv(key TEXT PRIMARY KEY,value BLOB NOT NULL)",
  );
  const get = async (key: string) => {
    const row = db
      .query("SELECT value FROM fixture_kv WHERE key=?")
      .get(key) as { value: Uint8Array } | null;
    return row ? deserialize(row.value) : undefined;
  };
  const put = async (key: string, value: unknown) => {
    db.query("INSERT OR REPLACE INTO fixture_kv VALUES(?,?)").run(
      key,
      serialize(value),
    );
  };
  const storage: any = {
    get,
    put,
    delete: async (key: string) => {
      db.query("DELETE FROM fixture_kv WHERE key=?").run(key);
    },
    list: async ({ prefix = "" } = {}) =>
      new Map(
        db
          .query("SELECT key,value FROM fixture_kv WHERE key LIKE ?")
          .all(prefix + "%")
          .map((row: any) => [row.key, deserialize(row.value)]),
      ),
    sql: {
      exec: (q: string, ...a: any[]) => {
        const rows = db.query(q).all(...a);
        return {
          toArray: () => rows,
          [Symbol.iterator]: () => rows[Symbol.iterator](),
        };
      },
    },
    transactionSync: (fn: () => unknown) => db.transaction(fn)(),
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(storage),
    sync: async () => {},
    getAlarm: async () => (await get("fixture-alarm")) ?? null,
    setAlarm: (at: number) => put("fixture-alarm", at),
    deleteAlarm: async () => storage.delete("fixture-alarm"),
  };
  return storage;
}
function sse(value: string, call = false, id = "fixture-execute") {
  return new Response(
    [
      {
        id: "fixture",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: call
              ? {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id,
                      type: "function",
                      function: {
                        name: "execute",
                        arguments: JSON.stringify({ code: value }),
                      },
                    },
                  ],
                }
              : { role: "assistant", content: value },
            finish_reason: null,
          },
        ],
      },
      {
        id: "fixture",
        object: "chat.completion.chunk",
        choices: [
          { index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.0001 },
      },
    ]
      .map((row) => `data: ${JSON.stringify(row)}\n\n`)
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
}
async function buildWorkerSource(entrypoint: string) {
  const build = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    format: "esm",
    conditions: ["workerd"],
    external: ["node:*"],
    plugins: [
      {
        name: "platform",
        setup(builder) {
          builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({
            path: "workers",
            namespace: "platform",
          }));
          builder.onLoad({ filter: /.*/, namespace: "platform" }, () => ({
            loader: "js",
            contents:
              "export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }",
          }));
          builder.onLoad({ filter: /\.(sh|py|txt)$/ }, async ({ path }) => ({
            loader: "text",
            contents: await Bun.file(path).text(),
          }));
        },
      },
    ],
  });
  if (!build.success) throw Error(build.logs.map(String).join("\n"));
  return await build.outputs[0]!.text();
}

test("production Cloudflare worker honors configured model/effort, executes scoped tools and recovers its child", async () => {
  // A fresh builder must not inherit Bun's module-resolution cache from the
  // Node fixture imports while resolving the Worker's workerd conditions.
  const entrypoint = new URL("../src/cloudflare.ts", import.meta.url).pathname;
  const builder = Bun.spawn([process.execPath, "-e",
    `const buildWorkerSource = ${buildWorkerSource.toString()}; process.stdout.write(await buildWorkerSource(${JSON.stringify(entrypoint)}));`,
  ], { stdout: "pipe", stderr: "pipe" });
  const [source, errors, exit] = await Promise.all([
    new Response(builder.stdout).text(), new Response(builder.stderr).text(), builder.exited,
  ]);
  expect(exit, errors).toBe(0);
  const url = URL.createObjectURL(
    new Blob([source], {
      type: "application/javascript",
    }),
  );
  let module: any;
  try {
    module = await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const db = new Database(":memory:"),
    storage = durableStorage(db);
  let account: any,
    toolCalls = 0,
    parentCalled = false,
    childCalled = false;
  const requests: any[] = [];
  const id = (name: string) => ({
    name,
    equals: (other: any) => other?.name === name,
    toString: () => name,
  });
  const env: any = {
    AIKO_MODE: "live",
    AIKO_CODE_MODE: "true",
    AIKO_INSTANCE_ID: "code-worker-fixture",
    AIKO_REPLY_STYLE: "direct",
    AIKO_OPERATOR_TOKEN: "fixture-worker-operator-123456789012345",
    CODEGRAFF_API_KEY: "fixture-model-key",
    AIKO_ALLOWED_USERS: "123",
    AIKO_VOICE_ENABLED: "false",
    AIKO_CONVERSATION_MODEL: "parent-model",
    AIKO_RAG_MODEL: "worker-model",
    AIKO_MODEL_EFFORTS: JSON.stringify({ "codegraff/worker-model": ["high"] }),
    AIKO_MCP_SERVERS: JSON.stringify({
      "123": [
        {
          id: "inventory",
          revision: "fixture-1",
          description: "Configured inventory",
          tools: { list_projects: "read" },
          url: "https://mcp.vendor.com/api",
          headerRefs: { Authorization: "INVENTORY_MCP_TOKEN" },
        },
      ],
    }),
    INVENTORY_MCP_TOKEN: "Bearer PRIVATE_MCP_HEADER_73912",
    AIKO_PROJECT_CONTEXT: (owner: string, thread: string) => ({
      owner,
      thread,
      redact: (text: string) => text,
      source: {
        read: async (path: string) =>
          path === "AGENTS.md" ? "PROJECT_SCOPE_" + thread : undefined,
        list: async () => [],
      },
    }),
    AIKO_REGISTRY_SANDBOX: () => ({
      placement: "local",
      codeTransport: runCodeSegment,
      sandbox: {
        harnessEnvironment: async () => "sha256:" + "1".repeat(64),
        harnessJob: async () => {
          throw Error("Unexpected harness job");
        },
      },
    }),
    AIKO_WORKER_TOOLS: (_owner: string, thread: string) => [
      {
        spec: {
          name: "sandbox_status",
          description: "Inspect configured worker fixture",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
        run: () =>
          Effect.sync(() => {
            expect(thread.startsWith("ag.")).toBe(true);
            toolCalls++;
            return { status: "ready", observed: true };
          }),
      },
    ],
    AIKO_MODEL_FETCH: async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      requests.push(body);
      if (body.model === "worker-model") {
        expect(body.reasoning_effort).toBe("high");
        expect(JSON.stringify(body.messages)).toContain("PROJECT_SCOPE_ag.");
        if (!childCalled) {
          childCalled = true;
          return sse(
            "const manifest=await tools.call({name:'project_context_manifest',arguments:{}});if(!manifest.instructions?.length)throw Error('Project context missing');const mcp=await tools.call({name:'mcp_server_list',arguments:{}});if(!mcp.servers?.some(server=>server.id==='inventory'))throw Error('Configured MCP missing');return await tools.call({name:'sandbox_status',arguments:{}});",
            true,
            "worker-exec",
          );
        }
        return sse("Worker observed status.");
      }
      if (
        !parentCalled &&
        body.tools?.some((t: any) => t.function?.name === "execute")
      ) {
        parentCalled = true;
        return sse(
          "return await agents.run({text:'Inspect worker fixture status',scope:'compute',placement:'independent',background:true,model:{provider:'codegraff',model_id:'worker-model'},effort:'high',mcp:[{server:'inventory',tools:['list_projects']}]});",
          true,
          "parent-exec",
        );
      }
      return sse("Parent accepted worker.");
    },
  };
  const ctx = {
    id: id(module.accountObjectName("123")),
    storage,
    waitUntil: () => {},
    blockConcurrencyWhile: (fn: () => unknown) => fn(),
  };
  env.AIKO_ACCOUNTS = { idFromName: id, getByName: () => account };
  account = new module.AikoAccountDO(ctx, env);
  try {
    const runtime = await account.open("123").catch((error: unknown) => {
      throw error;
    });
    // Open is a private TypeScript method but this calls the production assembly unchanged.
    const host = runtime.host;
    await host.commitRoot(host.self("user-123"), {
      type: "MessageReceived",
      id: "turn",
      text: "Inspect status through a delegated worker",
      at: 1,
    });
    await host.drive();
    const rows = await host.read("user-123"),
      claim = rows.find((e: any) => e.type === "ChildCreated");
    expect(claim).toBeDefined();
    expect(toolCalls).toBe(1);
    expect(requests.some((body) => body.model === "worker-model")).toBe(true);
    const child = claim.address.thread;
    expect(
      workerGrantOf(
        {
          owner: "123",
          thread: child,
          readParent: () => host.read("user-123"),
        },
        rows,
        await host.read(child),
      ),
    ).toMatchObject({
      model: { provider: "codegraff", model_id: "worker-model" },
      effort: "high",
      mcp: [
        {
          server: "inventory",
          revision: "fixture-1",
          tools: ["list_projects"],
        },
      ],
    });
    expect(JSON.stringify(requests)).not.toContain("PRIVATE_MCP_HEADER_73912");
    expect(
      JSON.stringify([...rows, ...(await host.read(child))]),
    ).not.toContain("PRIVATE_MCP_HEADER_73912");
    expect(
      (await host.read(child)).some((e: any) => e.type === "TurnCompleted"),
    ).toBe(true);
    await host.close();
    account = new module.AikoAccountDO(ctx, env);
    const restored = await account.open("123");
    await restored.host.recover();
    expect(toolCalls).toBe(1);
    expect(
      (await restored.host.read(child)).some(
        (e: any) => e.type === "TurnCompleted",
      ),
    ).toBe(true);
    const nativeAlarm = restored.host.alarm;
    restored.host.alarm = async () => { throw new Error("fixture alarm recovery failure"); };
    try {
      const beforeRetry = Date.now();
      await storage.setAlarm(beforeRetry + 3600000);
      await account.alarm();
      expect(await storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(await storage.getAlarm()).toBeGreaterThanOrEqual(beforeRetry);
      const earlier = Date.now() + 500;
      await storage.setAlarm(earlier);
      await account.alarm();
      expect(await storage.getAlarm()).toBe(earlier);
      const stale = Date.now() - 5000;
      await storage.setAlarm(stale);
      await account.alarm();
      expect(await storage.getAlarm()).toBeGreaterThan(stale + 5000);
    } finally {
      restored.host.alarm = nativeAlarm;
    }
    await restored.host.close();
  } finally {
    db.close();
  }
}, 20000);
