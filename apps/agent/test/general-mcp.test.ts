import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { EventLog } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import {
  actor,
  agentMessageMethod,
  codeMode,
  infer,
  Infer,
  outputValidateOnce,
} from "tardie";
import { GeneralMcp } from "../src/general-mcp.ts";
import {
  mcpHttpConnector,
  type McpHttpServer,
} from "../src/general-mcp-http.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import {
  createCloudflareAccountHost,
  type AccountStorage,
} from "../src/cloudflare-host.ts";
import type { Event } from "tardie/core/event";
import { mcpStdioConnector } from "../src/general-mcp-stdio.ts";

const dbs: Database[] = [],
  clients: GeneralMcp[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  for (const db of dbs.splice(0)) db.close();
});
const schema = {
  type: "object" as const,
  properties: { id: { type: "integer" } },
  required: ["id"],
  additionalProperties: false,
};
test("local MCP stdio runs the configured executable and confines environment inheritance", async () => {
  const previous = process.env.AIKO_MCP_TEST_PRIVATE_PARENT;
  process.env.AIKO_MCP_TEST_PRIVATE_PARENT = "fixture-only-private-value";
  const server = {
    id: "local",
    revision: "v1",
    description: "Local fixture",
    tools: { echo: "read" as const },
    command: process.execPath,
    cwd: process.cwd(),
    args: [new URL("./fixtures/mcp-stdio-server.ts", import.meta.url).pathname],
    env: { MCP_FIXTURE_ALLOWED: "explicit" },
  };
  const connector = mcpStdioConnector(() => [server]);
  const client = await connector(server, AbortSignal.timeout(10000));
  try {
    expect((await client.listTools()).tools[0].name).toBe("echo");
    const result = await client.callTool({
      name: "echo",
      arguments: { text: "held-out-message" },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "held-out-message" }],
      structuredContent: { allowed: "explicit", inheritedPrivate: false },
    });
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.AIKO_MCP_TEST_PRIVATE_PARENT;
    else process.env.AIKO_MCP_TEST_PRIVATE_PARENT = previous;
  }
});
function fixture() {
  let active = true,
    writeSchema: unknown = schema,
    outcome = "ok";
  const requests: any[] = [];
  const servers: McpHttpServer[] = [
    {
      id: "fixture",
      revision: "r1",
      description: "Granted fixture service",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer PRIVATE_TRANSPORT_TOKEN" },
      tools: { read: "read", write: "write" },
    },
  ];
  const fakeFetch = (async (url: any, init: any) => {
    expect(new URL(String(url)).origin).toBe("https://mcp.example.test");
    expect(init.redirect).toBe("error");
    if (init.method === "GET") return new Response(null, { status: 405 });
    const req = JSON.parse(init.body);
    requests.push(req);
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer PRIVATE_TRANSPORT_TOKEN",
    );
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: req.id, result });
    if (req.method === "initialize")
      return reply({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "1" },
      });
    if (!req.id) return new Response(null, { status: 202 });
    if (req.method === "tools/list")
      return reply({
        tools: [
          { name: "read", description: "Read fixture", inputSchema: schema },
          {
            name: "write",
            description: "Write fixture",
            inputSchema: writeSchema,
          },
          {
            name: "secret_admin",
            description: "Outside the grant",
            inputSchema: schema,
            annotations: { readOnlyHint: true },
          },
        ],
      });
    if (req.method === "tools/call") {
      if (outcome === "lost") throw Error("Connection lost after remote write");
      if (outcome === "revoked") active = false;
      return reply({
        content: [{ type: "text", text: "PRIVATE_MCP_RESULT" }],
        structuredContent: { id: req.params.arguments.id },
        isError: false,
      });
    }
    throw Error(`Unexpected method ${req.method}`);
  }) as typeof fetch;
  const binding = {
    owner: "123",
    thread: "user-123",
    servers: () => servers,
    current: async () => active,
    connect: mcpHttpConnector(() => servers, fakeFetch),
    redact: (s: string) => s,
  };
  const mcp = new GeneralMcp(binding);
  clients.push(mcp);
  const rows: Event[] = [];
  const invoke = async (method: string, args: unknown, instance = mcp) => {
    const tool = instance
      .tools()
      .find((t) => t.spec.name === `mcp_server_${method}`)!;
    return Effect.runPromise(
      tool
        .run(args, {
          callId: `mcp-${rows.length}-${requests.length}`,
          turn: "turn",
          signal: new AbortController().signal,
        })
        .pipe(
          Effect.provideService(Self, {
            actor: "aiko",
            thread: "user-123",
            instance: "demo",
          } as any),
          Effect.provideService(EventLog, {
            read: Effect.sync(() => rows),
            append: (events: Event[]) =>
              Effect.sync(() => {
                rows.push(...events);
                return events;
              }),
          } as any),
        ),
    ) as Promise<any>;
  };
  return {
    mcp,
    binding,
    rows,
    servers,
    requests,
    invoke,
    setActive: (v: boolean) => {
      active = v;
    },
    changeSchema: (v: unknown) => {
      writeSchema = v;
    },
    setOutcome: (v: string) => {
      outcome = v;
    },
  };
}

test("actual MCP client discovers only granted tools, calls exact schema, and rejects forged or changed schemas before dispatch", async () => {
  const f = fixture(),
    catalogue = await f.invoke("tools", { server: "fixture" });
  expect(catalogue.tools.map((t: any) => t.name)).toEqual(["read", "write"]);
  const tool = catalogue.tools.find((t: any) => t.name === "write");
  expect(
    await f.invoke("call", {
      server: "fixture",
      tool: "write",
      schemaDigest: tool.schemaDigest,
      arguments: { id: 17 },
    }),
  ).toMatchObject({ structuredContent: { id: 17 } });
  const calls = () => f.requests.filter((r) => r.method === "tools/call");
  expect(calls()).toHaveLength(1);
  expect(calls()[0].params._meta["aiko/native-call-id"]).toMatch(/^mcp-/);
  expect(
    (
      await f.invoke("call", {
        server: "fixture",
        tool: "secret_admin",
        schemaDigest: tool.schemaDigest,
        arguments: { id: 1 },
      })
    ).error,
  ).toContain("schema");
  f.changeSchema({ ...schema, required: ["id", "name"] });
  expect(
    (
      await f.invoke("call", {
        server: "fixture",
        tool: "write",
        schemaDigest: tool.schemaDigest,
        arguments: { id: 1 },
      })
    ).error,
  ).toContain("changed");
  expect(calls()).toHaveLength(1);
  f.setActive(false);
  expect((await f.invoke("tools", { server: "fixture" })).error).toContain(
    "grant",
  );
  expect(JSON.stringify(f.rows)).not.toContain("PRIVATE_");
});

test("MCP disconnect state survives client reconstruction and reconnect uses a fresh protocol session", async () => {
  const f = fixture();
  await f.invoke("connect", { server: "fixture" });
  await f.invoke("disconnect", { server: "fixture" });
  const fresh = new GeneralMcp(f.binding);
  clients.push(fresh);
  const before = f.requests.length;
  expect(
    (await f.invoke("tools", { server: "fixture" }, fresh)).error,
  ).toContain("disconnected");
  expect(f.requests.length).toBe(before);
  expect((await f.invoke("list", {}, fresh)).servers[0].status).toBe(
    "disabled",
  );
  expect((await f.invoke("connect", { server: "fixture" }, fresh)).status).toBe(
    "connected",
  );
  expect(f.requests.filter((r) => r.method === "initialize")).toHaveLength(2);
});

test("replacing an MCP server revokes old mounted tools and changes retained-source definitions on reconstruction", async () => {
  const f = fixture(),
    mounted = f.mcp.tools(),
    old = mounted.find((tool) => tool.spec.name === "mcp_server_call")!;
  const args = {
    server: "fixture",
    tool: "read",
    schemaDigest: "unused",
    arguments: { id: 7 },
  };
  expect(await old.authorizeRetained!(args)).toBe(true);
  f.servers[0] = { ...f.servers[0]!, revision: "r2" };
  expect(await old.authorizeRetained!(args)).toBe(false);
  const fresh = new GeneralMcp(f.binding);
  clients.push(fresh);
  const replacement = fresh
    .tools()
    .find((tool) => tool.spec.name === "mcp_server_call")!;
  expect(replacement.spec).not.toEqual(old.spec);
  expect(await replacement.authorizeRetained!(args)).toBe(true);
  expect(f.requests).toHaveLength(0);
});

for (const outcome of ["lost", "revoked"])
  test(`MCP ${outcome} acknowledgement after dispatch reports unknown outcome with native identity`, async () => {
    const f = fixture(),
      catalogue = await f.invoke("tools", { server: "fixture" });
    const write = catalogue.tools.find((tool: any) => tool.name === "write");
    f.setOutcome(outcome);
    const result = await f.invoke("call", {
      server: "fixture",
      tool: "write",
      schemaDigest: write.schemaDigest,
      arguments: { id: 81 },
    });
    expect(result).toMatchObject({ status: "unknown" });
    expect(result.operationId).toMatch(/^mcp-/);
    expect(result.instruction).toContain("before repeating a write");
    expect(
      f.requests.filter((request) => request.method === "tools/call"),
    ).toHaveLength(1);
    expect(
      f.rows.findLast((event) => event.type === "AikoMcpToolObserved"),
    ).toMatchObject({ status: "unknown", callId: result.operationId });
    expect(JSON.stringify(f.rows)).not.toContain("PRIVATE_");
  });

test("MCP tool adapter executes through real native code mode and journals structural receipts without transport credentials or results", async () => {
  const f = fixture(),
    db = new Database(":memory:");
  dbs.push(db);
  let alarm: number | null = null;
  const storage: AccountStorage = {
    sql: {
      exec: (sql, ...args) => {
        const rows = db.query(sql).all(...(args as any));
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
  const harness = new CodeHarness("123", "user-123", runCodeSegment, (s) => s);
  const definition = actor({
    name: "aiko",
    methods: { message: agentMessageMethod },
    components: [
      infer([codeMode([harness.package(f.mcp.tools())]), outputValidateOnce]),
    ],
  });
  let count = 0;
  const model = Layer.succeed(Infer, {
    resolve: () => ({ model: { provider: "fixture", model_id: "mcp" } }),
    react: (request) => {
      if (count++ === 0)
        return Effect.succeed({
          kind: "call" as const,
          name: "execute",
          callId: "mcp-native",
          arguments: {
            code: "const catalog=await tools.call({name:'mcp_server_tools',arguments:{server:'fixture'}});const t=catalog.tools.find(t=>t.name==='read');const r=await tools.call({name:'mcp_server_call',arguments:{server:'fixture',tool:t.name,schemaDigest:t.schemaDigest,arguments:{id:42}}});return r.structuredContent;",
          },
        });
      expect(
        (
          request.trajectory.findLast((e) => e.type === "ToolReturned")
            ?.result as any
        ).result,
      ).toEqual({ id: 42 });
      return Effect.succeed({ kind: "complete" as const, output: "verified" });
    },
  });
  const host = await createCloudflareAccountHost({
    storage,
    actorName: "aiko",
    actorInstance: "mcp",
    ownsThread: (t) => t === "user-123",
    actorFor: () => definition,
    layersFor: () =>
      Layer.merge(harness.inference(model), harness.sandboxLayer()),
  });
  await host.commitRoot(host.self("user-123"), {
    type: "MessageReceived",
    id: "mcp",
    text: "read",
    at: 1,
  });
  await host.drive();
  const rows = await host.read("user-123");
  expect(rows.find((e) => e.type === "TurnCompleted")?.output).toBe("verified");
  expect(
    rows.some((e) => e.type === "AikoMcpToolObserved" && e.tool === "read"),
  ).toBe(true);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_");
  await host.drive();
  expect(f.requests.filter((r) => r.method === "tools/call")).toHaveLength(1);
  await host.close();
});
