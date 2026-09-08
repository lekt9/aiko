import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { composioClient, composioSession, integrationIdentity, integrationResult } from "../src/composio.ts";
import { agentmailSession } from "../src/agentmail.ts";
import { configuredIntegrations, parseIntegrationOwners } from "../src/integrations.ts";
import { FileConnectorStore } from "../src/connectors-store.ts";
import { DynamicTools, DynamicToolDenied, type DynamicToolBinding } from "../src/dynamic-tools.ts";
import { GeneralMcp } from "../src/general-mcp.ts";
import { redactor } from "../src/security.ts";

const signal = () => AbortSignal.timeout(5000);
const empty = { type: "object", properties: {}, additionalProperties: false };
function store() {
  const data = new Map<string, any>();
  return { data, get: async (key: string) => structuredClone(data.get(key)), set: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); }, list: async () => [...data.values()] };
}
function sdkFixture() {
  const created: any[] = [], resumed: string[] = [], executed: any[] = [], delivered: string[][] = [];
  let active = true, canConnect = true, outcome: any = { logId: "log_fixture", data: { answer: "read result" } }, tags = ["readOnlyHint"];
  const sdk: any = {
    create: async (user: string, config: unknown) => { created.push({ user, config }); return session(`session-${created.length}`); },
    sessions: { use: async (id: string) => { resumed.push(id); return session(id); } },
    tools: { getRawComposioToolBySlug: async (slug: string) => ({ slug, toolkit: { slug: "fixture" }, tags, inputParameters: { type: "object", properties: { user_id: { type: "string" } }, additionalProperties: false } }) },
  };
  const session = (sessionId: string) => ({ sessionId,
    tools: async () => ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_GET_TOOL_SCHEMAS", "COMPOSIO_MANAGE_CONNECTIONS", "COMPOSIO_MULTI_EXECUTE_TOOL", "COMPOSIO_REMOTE_BASH_TOOL"].map(name => ({ type: "function", function: {
      name, description: "Fixture", parameters: { type: "object", properties: { session_id: { type: "string" }, session: { type: "object" }, queries: { type: "array" } } },
    } })),
    execute: async (name: string, args: unknown) => { executed.push({ sessionId, name, args }); if (outcome instanceof Error) throw outcome; return outcome; },
  });
  const storage = store();
  const options = (owner = "123") => ({ owner, instance: "fixture", apiKey: "private-composio-fixture-key", store: storage, sdk,
    current: () => active, canConnect: async () => canConnect,
    deliverLinks: async (links: string[]) => { delivered.push(links); return "delivered" as const; },
  });
  return { options, storage, created, resumed, executed, delivered, active: (v: boolean) => { active = v; }, connect: (v: boolean) => { canConnect = v; }, outcome: (v: any) => { outcome = v; }, tags: (v: string[]) => { tags = v; } };
}

test("integration key formats remain redacted even after a host key rotation", () => {
  const sanitize = redactor();
  expect(sanitize("ak_fixture_private_key_123 am_us_" + "f".repeat(64))).toBe("[redacted] [redacted]");
});
test("SDK retries, redirect forwarding, automatic files and telemetry are disabled", async () => {
  const client = (await composioClient("fixture-only-key")).getClient();
  expect(client.maxRetries).toBe(0);
  expect(client.fetchOptions?.redirect).toBe("error");
  expect(client.logLevel).toBe("off");
});
test("Composio sessions persist per instance/owner, resume after restart, and never reuse another tenant", async () => {
  const f = sdkFixture();
  await composioSession(f.options(), signal());
  await composioSession(f.options(), signal());
  await composioSession(f.options("456"), signal());
  expect(f.created.map(c => c.user)).toEqual([integrationIdentity("fixture", "123"), integrationIdentity("fixture", "456")]);
  expect(f.resumed).toEqual(["session-1"]);
  expect(f.created[0].config).toMatchObject({ tags: ["readOnlyHint"], sandbox: { enable: false }, manageConnections: { enable: true } });
  expect(integrationIdentity("another", "123")).not.toBe(f.created[0].user);
  const key = [...f.storage.data.keys()][0]!;
  f.storage.data.set(key, { ...f.storage.data.get(key), owner: "456" });
  await expect(composioSession(f.options(), signal())).rejects.toThrow("Foreign");
  expect(f.resumed).toHaveLength(1);
});
test("session schemas hide identity controls and remote execution; actual app schemas are validated before multi execution", async () => {
  const f = sdkFixture(), session = await composioSession(f.options(), signal());
  const catalog = await session.listTools();
  expect(catalog.tools.map(t => t.name)).not.toContain("COMPOSIO_REMOTE_BASH_TOOL");
  expect(catalog.tools[0]!.inputSchema.properties).not.toHaveProperty("session_id");
  expect(catalog.tools[0]!.inputSchema.properties).not.toHaveProperty("session");
  const call = (tool_slug: string, args = {}) => session.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug, arguments: args }] } });
  await expect(call("COMPOSIO_MANAGE_CONNECTIONS")).rejects.toThrow("nested meta");
  await expect(call("COMPOSIO_REMOTE_BASH_TOOL")).rejects.toThrow("nested meta");
  f.tags(["destructiveHint"]);
  await expect(call("FIXTURE_WRITE")).rejects.toThrow("read-only");
  f.tags(["readOnlyHint"]);
  await expect(call("FIXTURE_READ", { invalid: true })).rejects.toThrow("schema");
  expect(f.executed).toHaveLength(0);
  // App-level user_id=me is not the Composio tenant ID. Real Gmail schemas use it.
  await call("FIXTURE_READ", { user_id: "me" });
  expect(f.executed).toHaveLength(1);
  await expect(session.callTool({ name: "COMPOSIO_SEARCH_TOOLS", arguments: { user_id: "456" } })).rejects.toThrow("host-bound");
  await expect(session.callTool({ name: "COMPOSIO_SEARCH_TOOLS", arguments: { session: { id: "foreign" } } })).rejects.toThrow("host-bound");
  await session.callTool({ name: "COMPOSIO_SEARCH_TOOLS", arguments: { queries: [] } });
  expect(f.executed.at(-1).args.session).toEqual({ generate_id: true });
});
test("Connect Links stay on the trusted delivery edge; foreign URLs, forced reconnects and untrusted turns are rejected", async () => {
  const f = sdkFixture(), session = await composioSession(f.options(), signal());
  f.outcome({ logId: "log_link", data: { redirect_url: "https://connect.composio.dev/link/opaque", foreign: "https://attacker.test/?code=secret" } });
  f.connect(false);
  const input = { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: ["gmail"] } };
  await expect(session.callTool(input)).rejects.toThrow("Telegram");
  expect(f.executed).toHaveLength(0);
  f.connect(true);
  const result = await session.callTool(input);
  expect(result).toMatchObject({ status: "authorization_required", delivery: "delivered", logId: "log_link" });
  expect(f.delivered).toEqual([["https://connect.composio.dev/link/opaque"]]);
  expect(JSON.stringify(result)).not.toContain("https:");
  await expect(session.callTool({ ...input, arguments: { ...input.arguments, reinitiate_all: true } })).rejects.toThrow("replace existing");
  f.active(false);
  await expect(session.listTools()).rejects.toThrow("revoked");
});
test("private sign-in content, serialized credentials and authorization URLs cannot become ordinary API results", () => {
  const result = integrationResult({ messages: [{ subject: "Your verification <b>code</b>", text: "123456" }], text: '{"cookie":"private","answer":42}', link: "https://example.test/login?code=private", authorization: "private", safe: "News article" }, s => s);
  expect(result).toMatchObject({ messages: [{ status: "private_sign_in" }], text: { answer: 42 }, safe: "News article" });
  expect(JSON.stringify(result)).not.toContain("123456");
  expect(JSON.stringify(result)).not.toContain('"private"');
});
test("nested app failures are failed results, not a successful multi-execute receipt", async () => {
  const f = sdkFixture(), session = await composioSession(f.options(), signal());
  f.outcome({ logId: "log_partial", data: { error_count: 1, success_count: 0 } });
  expect(await session.callTool({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "FIXTURE_READ", arguments: {} }] } })).toMatchObject({ isError: true, logId: "log_partial" });
});
test("provider errors do not echo provider bodies, and connection failures are not retried", async () => {
  const f = sdkFixture(), session = await composioSession(f.options(), signal());
  f.outcome(Object.assign(Error("private provider payload"), { status: 503, headers: new Headers({ "x-request-id": "request_fixture" }) }));
  await expect(session.callTool({ name: "COMPOSIO_SEARCH_TOOLS", arguments: {} })).rejects.toThrow("HTTP 503");
  expect(f.executed).toHaveLength(1);
});

function mailFixture() {
  const storage = store(), requests: any[] = [], pods = new Map<string, any>(), inboxes = new Map<string, any>();
  let active = true, foreignPod = false, fail = false;
  const http = async (url: any, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.slice(4), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ path, body, method: init?.method });
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-agentmail-fixture-key");
    if (fail) return new Response("private provider body", { status: 503 });
    if (path === "pods" && body) {
      const prior = [...pods.values()].find(p => p.client_id === body.client_id);
      const pod = prior ?? { pod_id: `pod-${pods.size}`, client_id: body.client_id };
      pods.set(pod.pod_id, pod); return Response.json(pod);
    }
    const parts = path.split("/");
    if (parts[0] === "pods" && parts.length === 2) return Response.json({ ...pods.get(parts[1]!), ...(foreignPod ? { client_id: "foreign" } : {}) });
    if (parts[0] === "pods" && parts[2] === "inboxes" && body) {
      const id = `mail-${inboxes.size}@agentmail.test`;
      const inbox = { pod_id: parts[1], inbox_id: id, email: id, client_id: body.client_id };
      inboxes.set(id, inbox); return Response.json(inbox);
    }
    if (parts[0] === "pods" && parts.length === 4) return Response.json(inboxes.get(decodeURIComponent(parts[3]!)));
    if (parts[0] === "inboxes" && parts[2] === "messages") return Response.json({ count: 1, messages: [{ inbox_id: decodeURIComponent(parts[1]!), subject: "Verification code 123456", text: "PRIVATE_MAIL_BODY", headers: { secret: "PRIVATE_HEADER" } }] });
    throw Error("Unexpected AgentMail route");
  };
  const options = (owner = "123") => ({ owner, instance: "fixture", apiKey: "private-agentmail-fixture-key", store: storage,
    current: () => active, canProvision: async () => true, fetch: http });
  return { options, requests, storage, pods, inboxes, active: (v: boolean) => { active = v; }, foreign: () => { foreignPod = true; }, fail: () => { fail = true; } };
}
const mailCall = (session: ReturnType<typeof agentmailSession>, name: string) => session.callTool({ name, arguments: {} }, undefined, { signal: signal() });
test("AgentMail read does not provision; two owners receive separate pods and no private mail crosses the tool boundary", async () => {
  const f = mailFixture(), a = agentmailSession(f.options()), b = agentmailSession(f.options("456"));
  expect(await mailCall(a, "AGENTMAIL_INBOX_STATUS")).toMatchObject({ status: "not_connected" });
  expect(f.requests).toHaveLength(0);
  const first = await mailCall(a, "AGENTMAIL_CREATE_INBOX"), second = await mailCall(b, "AGENTMAIL_CREATE_INBOX");
  expect(first.address).not.toBe(second.address);
  expect(f.pods.size).toBe(2);
  const result = await mailCall(agentmailSession(f.options()), "AGENTMAIL_INBOX_STATUS");
  expect(result).toEqual({ status: "connected", address: first.address, hasMessages: true });
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE|123456/);
  expect(f.requests.filter(r => r.method === "POST")).toHaveLength(4);
  f.foreign();
  const before = f.requests.filter(r => r.path.startsWith("inboxes/")).length;
  await expect(mailCall(a, "AGENTMAIL_INBOX_STATUS")).rejects.toThrow("ownership");
  expect(f.requests.filter(r => r.path.startsWith("inboxes/")).length).toBe(before);
});
test("AgentMail rechecks revocation, never accepts caller inbox IDs, and does not retry failed provider calls", async () => {
  const f = mailFixture(), a = agentmailSession(f.options());
  await expect(a.callTool({ name: "AGENTMAIL_CREATE_INBOX", arguments: { inbox_id: "foreign" } })).rejects.toThrow("Invalid");
  f.active(false);
  await expect(mailCall(a, "AGENTMAIL_CREATE_INBOX")).rejects.toThrow("revoked");
  expect(f.requests).toHaveLength(0);
  f.active(true); f.fail();
  await expect(mailCall(a, "AGENTMAIL_CREATE_INBOX")).rejects.toThrow("HTTP 503");
  expect(f.requests).toHaveLength(1);
});

const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
test("provider records use the real private connector store namespace and survive reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "aiko-integrations-")); directories.push(directory);
  const f = sdkFixture();
  await composioSession({ ...f.options(), store: new FileConnectorStore(directory) }, signal());
  await composioSession({ ...f.options(), store: new FileConnectorStore(directory) }, signal());
  expect(f.created).toHaveLength(1);
  expect(f.resumed).toEqual(["session-1"]);
});
test("deployment binding is foreground/owner-scoped and retained authority disappears on key or eligibility changes", async () => {
  expect(parseIntegrationOwners(undefined)).toEqual([]);
  expect(() => parseIntegrationOwners("123,foreign-owner")).toThrow();
  const config = { owners: ["123"], composioKey: "private-key-fixture" };
  const options = { owner: "123", thread: "user-123", instance: "fixture", config, store: store(), current: () => true, read: async () => [], deliverLinks: async () => "rejected" as const };
  expect(configuredIntegrations({ ...options, owner: "456", thread: "user-456" })).toBeUndefined();
  expect(configuredIntegrations({ ...options, thread: "worker-123" })).toBeUndefined();
  const gateway = configuredIntegrations(options)!;
  const tool = gateway.tools().find(t => t.spec.name === "integration_call")!;
  expect(await tool.authorizeRetained!({ server: "composio", tool: "COMPOSIO_SEARCH_TOOLS" })).toBe(true);
  config.composioKey = "replacement-key";
  expect(await tool.authorizeRetained!({ server: "composio", tool: "COMPOSIO_SEARCH_TOOLS" })).toBe(false);
});
test("provisioning requires the exact current Telegram sender, private chat and native turn before accessing storage", async () => {
  let rows: Event[] = [];
  let reads = 0;
  const gateway = configuredIntegrations({ owner: "123", thread: "user-123", instance: "fixture",
    config: { owners: ["123"], agentmailKey: "private-fixture" }, current: () => true, read: async () => rows,
    store: { ...store(), get: async () => { reads++; throw Error("authorized-store-probe"); } }, deliverLinks: async () => "rejected",
  })!;
  const session = await gateway.binding.connect(gateway.binding.servers()[0]!, signal());
  const input = { name: "AGENTMAIL_CREATE_INBOX", arguments: {}, _meta: { "aiko/native-turn": "current" } };
  for (const change of [{ source: "api" }, { sender: "456" }, { chat: "456" }, { id: "old" }]) {
    rows = [{ type: "MessageReceived", id: "current", source: "telegram", sender: "123", chat: "123", at: 1, ...change }];
    await expect(session.callTool(input)).rejects.toThrow("Telegram");
  }
  expect(reads).toBe(0);
  rows = [{ type: "MessageReceived", id: "current", source: "telegram", sender: "123", chat: "123", at: 1 }];
  await expect(session.callTool(input)).rejects.toThrow("authorized-store-probe");
  expect(reads).toBe(1);
});
test("the generalized runtime preserves MCP names and isolates disconnect lifecycles between transports", async () => {
  const rows: Event[] = [];
  const binding: DynamicToolBinding = { owner: "123", thread: "user-123", current: () => true, redact: s => s,
    servers: () => [{ id: "same-id", revision: "v1", description: "fixture", tools: { read: "read" } }],
    connect: async () => ({ listTools: async () => ({ tools: [{ name: "read", inputSchema: empty }] }), callTool: async () => ({ value: 4 }), close: async () => {} }),
  };
  const mcp = new GeneralMcp(binding), sdk = new DynamicTools(binding);
  const invoke = async (gateway: DynamicTools, method: string, args: unknown) => Effect.runPromise(gateway.tools().find(t => t.spec.name === `${gateway.namespace}_${method}`)!.run(args, { callId: "fixture", turn: "turn", signal: signal() }).pipe(
    Effect.provideService(Self, { actor: "aiko", thread: "user-123", instance: "fixture" } as any),
    Effect.provideService(EventLog, { read: Effect.sync(() => [...rows]), append: (events: Event[]) => Effect.sync(() => { rows.push(...events); return events; }) } as any),
  )) as Promise<any>;
  await invoke(mcp, "disconnect", { server: "same-id" });
  expect((await invoke(new GeneralMcp(binding), "tools", { server: "same-id" })).error).toContain("disconnected");
  expect((await invoke(sdk, "tools", { server: "same-id" })).tools).toHaveLength(1);
  expect(sdk.tools().map(t => t.spec.name)).toContain("integration_call");
  const denied = new DynamicTools({ ...binding, connect: async () => ({
    listTools: async () => ({ tools: [{ name: "read", inputSchema: empty }] }),
    callTool: async () => { throw new DynamicToolDenied("Private approval required before dispatch"); }, close: async () => {},
  }) });
  const catalog = await invoke(denied, "tools", { server: "same-id" });
  expect(await invoke(denied, "call", { server: "same-id", tool: "read", schemaDigest: catalog.tools[0].schemaDigest, arguments: {} })).toMatchObject({ status: "blocked" });
  expect(rows.some(e => e.type === "AikoMcpToolObserved" && e.status === "unknown")).toBe(false);
  await mcp.close(); await sdk.close(); await denied.close();
});
