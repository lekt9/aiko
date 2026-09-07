import { test, expect, beforeEach, afterAll } from "bun:test";
import { ConnectorEngine, connectorDomain, connectorStorePrefix, type ConnectorStore } from "../src/connectors.ts";
import { randomUUID } from "node:crypto";
import { FileConnectorStore } from "../src/connectors-store.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const original = process.env.ARCADE_API_KEY;
beforeEach(() => { process.env.ARCADE_API_KEY = "test-only-arcade-key"; });
afterAll(() => { if (original === undefined) delete process.env.ARCADE_API_KEY; else process.env.ARCADE_API_KEY = original; });
class Store implements ConnectorStore {
 rows = new Map<string, unknown>();
 async get(k: string) { return structuredClone(this.rows.get(k)); }
 async set(k: string, v: unknown) { this.rows.set(k, structuredClone(v)); }
 async list(p: string) { return [...this.rows].filter(([k]) => k.startsWith(p)).map(([, v]) => structuredClone(v)); }
}
const tool = (name = "GitHub.List", domain = "github.com") => ({ qualified_name: name, toolkit: { name: "GitHub" }, metadata: { classification: { service_domains: [domain] } } });
const page = (items = [tool()], offset = 0, total_count = items.length) => ({ items, offset, total_count });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const make = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>, owner = "123", store = new Store()) => new ConnectorEngine({ owner, store, fetch: async (u, i) => String(u).endsWith("admin/auth_providers") ? reply(page([])) : handler(String(u), i) });
/** Arcade OAuth login flows were removed; tests seed connected rows directly. */
const seedConnected = async (store: ConnectorStore, owner = "123", overrides: Record<string, unknown> = {}) => {
 const id = randomUUID();
 const row = { id, owner, connectorId: "arcade:GitHub.List", provider: "arcade", status: "connected", createdAt: Date.now(), expiresAt: Date.now() + 600000, toolName: "GitHub.List", ...overrides };
 await store.set(`${connectorStorePrefix(owner)}connection:${id}`, row);
 return row as { id: string; createdAt: number };
};

test("Arcade failures, malformed and empty catalogs never enable fallback", async () => {
 for (const response of [reply({}, 401), reply({}, 429), reply({}, 500), reply({ items: [] }), reply(page([])), reply({ items: [], offset: 0, total_count: 2 })]) {
  const engine = make(() => response.clone());
  expect(await engine.search("unknown.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
  await expect(engine.connectBrowser("unknown.com")).rejects.toThrow();
 }
});
test("missing API key cannot enable fallback", async () => {
 delete process.env.ARCADE_API_KEY;
 expect(await make(() => { throw new Error("must not request"); }).search("service.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
});
test("pagination exhausts catalog before absence and detects matching final page", async () => {
 const calls: string[] = [];
 const engine = make(url => { calls.push(url); return reply(url.endsWith("offset=0") ? page([tool()], 0, 2) : page([tool("Other.Read", "other.com")], 1, 2)); });
 expect(await engine.search("other.com")).toMatchObject({ status: "available", fallbackAllowed: false });
 expect(calls.filter(url => url.includes("tools?"))).toHaveLength(2);
 expect(await engine.search("absent.com")).toMatchObject({ status: "absent", fallbackAllowed: true });
});
test("unclassified or repeated pages cannot establish domain absence", async () => {
 const unknown = { qualified_name: "Other.Read", toolkit: { name: "Other" } };
 expect(await make(() => reply(page([unknown as any]))).search("absent.com")).toMatchObject({ status: "unavailable" });
 expect(await make(() => reply(page([tool()], 0, 2))).search("absent.com")).toMatchObject({ status: "unavailable" });
});
test("owner bound execute strips credentials and ignores logs; foreign owners see nothing", async () => {
 const store = new Store(); const bodies: any[] = [];
 const handler = (url: string, init?: RequestInit) => {
  if (init?.body) bodies.push(JSON.parse(String(init.body)));
  if (url.includes("tools?")) return reply(page());
  return reply({ success: true, output: { value: { count: 2, access_token: "secret", text: "Bearer secret" }, logs: [{ message: "secret" }] } });
 };
 const first = await seedConnected(store);
 const engine = make(handler, "123", store);
 expect(JSON.stringify([...store.rows.values()])).not.toContain("never-persist");
 expect(await engine.execute(first.id, {})).toEqual({ status: "succeeded", value: { count: 2, text: "[redacted authorization]" } });
 expect(bodies.every(b => b.user_id === "123")).toBe(true);
 expect(await make(handler, "456", store).connections()).toEqual([]);
 await engine.disconnect(first.id);
 await expect(engine.execute(first.id, {})).rejects.toThrow();
});
test("SSRF input hosts rejected", () => {
 for (const host of ["127.0.0.1", "localhost", "169.254.169.254", "https://user:password@github.com", "https://github.com:8443", "[::1]", "service.internal", "http://github.com", "github.com/path", "github.com?token=x"]) expect(() => connectorDomain(host)).toThrow();
});
test("generated capabilities persist only same-owner explicit safe endpoint evidence", async () => {
 const store = new Store(); let browserCalls = 0;
 const engine = new ConnectorEngine({ owner: "123", store, fetch: async u => reply(String(u).endsWith("admin/auth_providers") ? page([]) : page()),
  readOwnedLogs: async () => [{ owner: "456", id: "foreign", text: "GET https://absent.com/private" }, { owner: "123", id: "own", text: "GET https://absent.com/api/items\nPOST https://absent.com/api/items\nGET https://absent.com/api?token=secret\nGET https://127.0.0.1/private" }],
  readPublicEvidence: async url => ({ url, truncated: false, text: "GET https://absent.com/api/projects" }),
  secureBrowser: { begin: async () => { browserCalls++; return { authorizationUrl: "https://signin.aiko.com/session" }; } },
 });
 const found = await engine.discover("absent.com", ["https://github.com/org/repo"]);
 expect(found.status).toBe("discovered"); expect(found.capabilities).toHaveLength(3);
 expect(found.capabilities.every(c => c.status === "review_required")).toBe(true);
 expect(JSON.stringify([...store.rows.values()])).not.toMatch(/secret|private/);
 await expect(engine.discover("absent.com", ["https://127.0.0.1/evidence"])).rejects.toThrow();
 expect((await engine.connectBrowser("absent.com")).status).toBe("pending"); expect(browserCalls).toBe(1);
 await expect(engine.connectBrowser("github.com")).rejects.toThrow(); expect(browserCalls).toBe(1);
});
test("file store restores owner records across instances and blocks traversal", async () => {
 const directory = await mkdtemp(join(tmpdir(), "connector-test-"));
 try {
  const store = new FileConnectorStore(directory);
  const connected = await seedConnected(store);
  const reloaded = new ConnectorEngine({ owner: "123", store: new FileConnectorStore(directory) });
  expect(await reloaded.connections()).toEqual([{ id: connected.id, connectorId: "arcade:GitHub.List", provider: "arcade", status: "connected", createdAt: connected.createdAt }]);
  await expect(store.get("../../etc/passwd")).rejects.toThrow();
 } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Cloudflare environment binding supplies only the configured key and redacts echoes", async () => {
 delete process.env.ARCADE_API_KEY;
 const store = new Store();
 const engine = new ConnectorEngine({ owner: "123", store, env: { ARCADE_API_KEY: "cf-test-key-material" }, fetch: async (u, init) => {
  expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer cf-test-key-material");
  expect(init?.redirect).toBe("manual");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  return reply(String(u).includes("tools?") ? page() : { success: true, output: { value: "cf-test-key-material" } });
 }});
 const connection = await seedConnected(store);
 expect(await engine.execute(connection.id, {})).toEqual({ status: "succeeded", value: "[redacted]" });
});
test("provider execution errors never become success or browser fallback", async () => {
 const store = new Store();
 const errorEngine = make(url => reply(url.includes("tools?") ? page() : { success: false, output: { error: { message: "password=private" } } }), "123", store);
 const ready = await seedConnected(store);
 expect(await errorEngine.execute(ready.id, {})).toEqual({ status: "failed", message: "Arcade did not confirm execution success." });
});
test("owned and public evidence are skipped when unavailable, redirected or truncated", async () => {
 const engine = new ConnectorEngine({ owner: "123", store: new Store(), fetch: async u => reply(String(u).endsWith("admin/auth_providers") ? page([]) : page()), readPublicEvidence: async url => ({ url: url + "/redirect", text: "GET https://absent.com/api/items", truncated: false }) });
 expect((await engine.discover("absent.com", ["https://github.com/org/repo"])).status).toBe("needs_evidence");
 await expect(engine.connectBrowser("absent.com")).rejects.toThrow("not configured");
});

test("host log and relay exceptions never expose credentials", async () => {
 const engine = new ConnectorEngine({ owner: "123", store: new Store(), fetch: async u => reply(String(u).endsWith("admin/auth_providers") ? page([]) : page()),
  readOwnedLogs: async () => { throw new Error("password=private"); },
  secureBrowser: { begin: async () => { throw new Error("password=private"); } },
 });
 expect((await engine.discover("absent.com")).status).toBe("needs_evidence");
 await expect(engine.connectBrowser("absent.com")).rejects.toThrow("Secure browser connection could not be started");
});

test("uncertain transport and malformed execution responses are unknown with no retry", async () => {
 const responses: Array<() => Response> = [
  () => { throw new DOMException("private transport details", "TimeoutError"); },
  () => { throw new TypeError("private network details"); },
  () => reply({ message: "private upstream details" }, 500),
  () => reply({ message: "private upstream details" }, 502),
  () => new Response("not JSON private details", { status: 200 }),
  () => reply({}),
  () => reply({ success: "true", output: { value: "ambiguous" } }),
  () => reply({ success: true }),
  () => reply({ success: true, output: {} }),
  () => reply({ success: true, output: [] }),
  () => reply({ success: true, output: { value: "ambiguous", error: { message: "private error" } } }),
 ];
 for (const response of responses) {
  const store = new Store();
  let executions = 0;
  const engine = make(url => {
   if (url.includes("tools?")) return reply(page());
   executions++; return response();
  }, "123", store);
  const connection = await seedConnected(store);
  const result = await engine.execute(connection.id, {});
  expect(result.status).toBe("unknown");
  expect(result.message).toContain("may have executed");
  expect(result.message).toContain("Do not retry automatically");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(executions).toBe(1);
 }
});

test("explicit failure stays failed and confirmed null-valued success stays succeeded", async () => {
 for (const [response, status] of [[{ success: false }, "failed"], [{ success: true, output: { value: null } }, "succeeded"]] as const) {
  const store = new Store();
  const engine = make(url => reply(url.includes("tools?") ? page() : response), "123", store);
  const connection = await seedConnected(store);
  expect((await engine.execute(connection.id, {})).status).toBe(status);
 }
});

test("authorization required persists failed connection and removes stale flow before returning", async () => {
 const store = new Store(); let executions = 0;
 const handler = (url: string) => {
  if (url.includes("tools?")) return reply(page());
  executions++;
  return reply({ success: false, output: { authorization: { id: "untrusted-new-flow", url: "https://api.arcade.dev/auth/new-private-flow", status: "pending" } } });
 };
 const engine = make(handler, "123", store);
 const connection = await seedConnected(store);
 for (const row of store.rows.values()) { (row as any).authorizationUrl = "https://api.arcade.dev/auth/stale-private-flow"; }
 expect(await engine.execute(connection.id, {})).toEqual({ status: "authorization_required", message: "Reconnect this Arcade tool to authorize it." });
 const reloaded = make(handler, "123", store);
 expect(await reloaded.connections()).toEqual([{ id: connection.id, connectorId: "arcade:GitHub.List", provider: "arcade", status: "failed", createdAt: connection.createdAt }]);
 expect(JSON.stringify([...store.rows.values()])).not.toMatch(/private-flow|private-id|untrusted-new-flow/);
 await expect(reloaded.execute(connection.id, {})).rejects.toThrow("not executable");
 expect(executions).toBe(1);
});

test("authorization required is not reported as settled if persistence fails", async () => {
 const store = new Store();
 const engine = make(url => reply(url.includes("tools?") ? page() : { output: { authorization: { status: "pending" } } }), "123", store);
 const connection = await seedConnected(store);
 store.set = async () => { throw new Error("private storage details"); };
 await expect(engine.execute(connection.id, {})).rejects.toThrow("Connection authorization invalidation could not be persisted");
});

test("workerd-compatible manual transport rejects redirects without forwarding credentials", async () => {
 for (const status of [301, 302, 303, 307, 308]) {
  const store = new Store();
  for (const phase of ["catalog", "execute"] as const) {
   const requests: string[] = [];
   const engine = new ConnectorEngine({ owner: "123", store, env: { ARCADE_API_KEY: "fixture-only-redirect-key" }, fetch: async (url, init) => {
    // Model workerd's supported redirect modes, including its rejection of redirect:error.
    if (init?.redirect !== "manual" && init?.redirect !== "follow") throw new TypeError("Unsupported redirect mode");
    expect(init.redirect).toBe("manual");
    const target = String(url); requests.push(target);
    expect(new URL(target).origin).toBe("https://api.arcade.dev");
    const endpoint = target.includes("tools?") ? "catalog" : target.endsWith("authorize") ? "authorize" : "execute";
    if (endpoint === phase) return new Response(null, { status, headers: { Location: "https://untrusted.net/credential-sink" } });
    return reply(endpoint === "catalog" ? page() : { status: "completed" });
   } });
   if (phase === "catalog") {
    expect(await engine.search("github.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
    expect(requests).toHaveLength(1);
   } else {
    const connection = await seedConnected(store);
    expect((await engine.execute(connection.id, {})).status).toBe("unknown");
    expect(requests).toHaveLength(1);
   }
   expect(requests.every(url => new URL(url).hostname === "api.arcade.dev")).toBe(true);
  }
 }
});
