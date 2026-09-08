import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { serialize, deserialize } from "node:v8";
import { Effect } from "effect";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import {replayKeys,unwrapReplay,sealReplay} from "../src/codegraff.ts";
import { workerGrantOf } from "../src/code-agents.ts";
import { BROWSER_ACTOR_PROFILE, BROWSER_ACTOR_INSTRUCTIONS, BROWSER_DELEGATION_INSTRUCTIONS, browserTaskOutput } from "../src/browser-actor.ts";

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

test.each(["compute","browser"] as const)("production Cloudflare %s worker honors configured model/effort, executes scoped tools and recovers its child", async (scope) => {
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
        if (scope === "browser") {
          expect(JSON.stringify(body.messages)).toContain("Browser specialist (browser-v1)");
          expect(body.messages.some((message: any) => message.role === "system" && message.content.includes(BROWSER_ACTOR_INSTRUCTIONS))).toBe(true);
        } else expect(JSON.stringify(body.messages)).not.toContain("Browser specialist (browser-v1)");
        if (!childCalled) {
          childCalled = true;
          return sse(
            (scope==="browser" ? "const contract=await tools.describe({name:'worker_index_describe'});if(!contract.inputSchema?.properties?.toolDigest)throw Error('Native graph contract missing');const index=await tools.call({name:'worker_index_search',arguments:{query:'saved page'}});if(index.definitions?.length!==0)throw Error('Unexpected indexed fixture route');const nav=await tools.call({name:'worker_browser_navigate',arguments:{origin:'https://vendor.com',url:'https://vendor.com/private-page'}});if(nav.status!=='completed')throw Error('Scoped navigate blocked');const click=await tools.call({name:'worker_browser_click',arguments:{origin:'https://vendor.com',selector:'#save'}});if(click.status!=='completed')throw Error('Scoped click blocked');return click;" : "const manifest=await tools.call({name:'project_context_manifest',arguments:{}});if(!manifest.instructions?.length)throw Error('Project context missing');const mcp=await tools.call({name:'mcp_server_list',arguments:{}});if(!mcp.servers?.some(server=>server.id==='inventory'))throw Error('Configured MCP missing');return await tools.call({name:'sandbox_status',arguments:{}});"),
            true,
            "worker-exec",
          );
        }
        return sse(scope === "browser" ? JSON.stringify({ status: "completed", summary: "Worker observed status.", sources: [{ url: "https://vendor.com/private-page", finding: "Save action completed" }], receipts: [], nextStep: "" }) : "Worker observed status.");
      }
      if (
        !parentCalled &&
        body.tools?.some((t: any) => t.function?.name === "execute")
      ) {
        parentCalled = true;
        expect(body.messages.some((message: any) => message.role === "system" && message.content.includes(BROWSER_DELEGATION_INSTRUCTIONS))).toBe(true);
        return sse(
          `return await agents.run({text:'Inspect worker fixture status',scope:'${scope}',${scope==="browser"?"origins:['https://vendor.com'],browserOperations:['navigate','click'],":""}placement:'independent',background:true,model:{provider:'codegraff',model_id:'worker-model'},effort:'high',mcp:[{server:'inventory',tools:['list_projects']}]});`,
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
    // Exercise the production owner API mount, not a direct promise service call.
    const promiseRequest = (method = "GET") => new Request(`https://fixture.invalid/api/promises${method === "POST" ? "/decision" : ""}`, {
      method, ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: "{}" } : {}),
    });
    const listed = await account.handle("123", promiseRequest(), { owner: "123", scopes: ["read"] });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ promises: [] });
    expect((await account.handle("123", promiseRequest(), { owner: "foreign", scopes: ["read"] })).status).toBe(403);
    expect((await account.handle("123", promiseRequest(), { owner: "123", scopes: ["read"], operator: true })).status).toBe(403);
    expect((await account.handle("123", promiseRequest("POST"), { owner: "123", scopes: ["read"] })).status).toBe(403);
    expect((await account.handle("123", promiseRequest("POST"), { owner: "123", scopes: ["read", "write"] })).status).toBe(400);
    const uploads:string[]=[],commands:string[]=[],browserCalls:string[]=[];
    if(scope==="browser") {
      const sandbox=runtime.capabilities.sandbox,keys=replayKeys();
      sandbox.ensure=async()=>"browser-vm-fixture";
      sandbox.upload=async(_id:string,_path:string,text:string)=>{uploads.push(text);};
      sandbox.exec=async(_id:string,command:string)=>{
        commands.push(command);
        if(command.endsWith(" health"))return JSON.stringify({replayPublicKey:keys.publicKey});
        if(command.endsWith(" drain"))return JSON.stringify({events:[]});
        if(command.endsWith(" close"))return '{}';
        const {key,value}=unwrapReplay(JSON.parse(uploads.at(-1)!),keys.privateKey);
        if(value.operation==="authorize-inspection")return JSON.stringify(sealReplay({output:true},key));
        expect(value.operation).toBe("execute-scoped");
        expect(value.policy).toEqual({origin:"https://vendor.com",origins:["https://vendor.com"]});
        const action=value.action.action;browserCalls.push(action);
        if(action==="click")toolCalls++;
        return JSON.stringify(sealReplay({output:action==="url"?{url:"https://vendor.com/private-page"}:action==="snapshot"?{snapshot:"[button Save]"}:{text:"TRANSIENT_CLOUDFLARE_PAGE"}},key));
      };
    }
    await host.commitRoot(host.self("user-123"), {
      type: "MessageReceived",
      id: "turn",
      text: "Inspect status through a delegated worker",
      at: 1,
    });
    const drive=host.drive();
    if(scope==="browser") {
      let approval:any;
      for(let i=0;i<1000;i++){approval=runtime.capabilities.browser.status("123").pending[0];if(approval)break;await Bun.sleep(5);}
      expect(approval).toBeDefined();expect(toolCalls).toBe(0);
      expect((await host.read("user-123")).some((e:any)=>e.type==="AikoBrowserApprovalRequested")).toBe(true);
      expect(runtime.capabilities.browser.decide("123",approval.id,true)).toBe(true);
    }
    await drive;
    if(scope==="browser") {
      expect(browserCalls.filter(name=>name==="navigate")).toHaveLength(1);
      expect(browserCalls.filter(name=>name==="click")).toHaveLength(1);
      expect(commands.join()+uploads.join()).not.toMatch(/private-page|TRANSIENT_CLOUDFLARE_PAGE|#save/);
      await runtime.capabilities.browser.close();
    }
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
    if(scope==="browser") {
      expect(rows.find((event: any) => event.type === "AikoWorkerGranted")).toMatchObject({ profile: BROWSER_ACTOR_PROFILE });
      expect((await host.read(child)).find((event: any) => event.type === "MessageReceived")?.output).toEqual({ name: browserTaskOutput.name, schema: browserTaskOutput.schema });
      expect(JSON.stringify([...rows,...await host.read(child)])).not.toContain("TRANSIENT_CLOUDFLARE_PAGE");
    }
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
    if (scope === "browser") expect((await restored.host.read("user-123")).find((event: any) => event.type === "AikoWorkerGranted")?.profile).toBe(BROWSER_ACTOR_PROFILE);
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
    // Exercise the production HTTP projection during the outbox's composition
    // interval, after a native terminal but before the reply is prepared.
    const statusTurn = "worker-status-fixture";
    const readMessages = async () => {
      const response = await account.handle("123", new Request("https://fixture.invalid/api/messages"), {
        operator: false, owner: "123", scopes: ["read"],
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const callsBeforeStatus = requests.length;
    await restored.host.seed("user-123", [
      { type: "MessageReceived", id: statusTurn, text: "Prepare reply", at: 100 },
      { type: "TurnCompleted", turn: statusTurn, epoch: 0, output: "Ready", at: 101 },
      { type: "AikoVoiceStarted", turn: statusTurn, epoch: 0, at: 102 },
    ]);
    expect(await readMessages()).toMatchObject({ pending: [], preparing: [statusTurn] });
    await restored.host.seed("user-123", [
      { type: "AikoReplyPrepared", turn: statusTurn, epoch: 0, result: { text: "Ready" }, at: 103 },
    ]);
    expect(await readMessages()).toMatchObject({ pending: [], preparing: [] });
    expect(requests.length).toBe(callsBeforeStatus);
    await restored.host.close();
  } finally {
    db.close();
  }
}, 20000);
