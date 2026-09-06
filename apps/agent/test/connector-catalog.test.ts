import { test, expect, spyOn } from "bun:test";
import { ConnectorEngine, type ConnectorStore } from "../src/connectors.ts";
import type { HttpFetch } from "../src/security.ts";
import { CatalogCache } from "../src/connectors-catalog.ts";
const store: ConnectorStore = { get: async () => undefined, set: async () => {}, list: async () => [] };
const env = { ARCADE_API_KEY: "fixture-key-never-real" };
const tool = (name: string, extra = {}) => ({ qualified_name: name, toolkit: { name: name.split(".")[0], version: "1.2.3" }, input: { parameters: [{ name: "query", required: true, description: "Search query", value_schema: { val_type: "string" } }] }, ...extra });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const page = (items: unknown[], offset = 0, total_count = items.length) => ({ items, offset, total_count });
const providers = [{ id: "arcade-google", provider_id: "google", status: "active", type: "oauth2" }, { id: "arcade-slack", provider_id: "slack", status: "active", type: "oauth2" }];

test("metadata-free production tools match documented Gmail and Slack website identities", async () => {
 const tools = [tool("Gmail.ListEmails"), tool("Slack.GetMessages"), tool("SlackApi.ListChannels"), tool("Other.Read")];
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async url => json(String(url).includes("tools?") ? page(tools) : page(providers)) });
 for (const query of ["Gmail", "gmail.com", "mail.google.com", "slack.com", "team.slack.com"]) expect((await engine.search(query)).status).toBe("available");
 expect((await engine.search("slack.com")).connectors.map(c => c.name)).toEqual(["Slack.GetMessages", "SlackApi.ListChannels"]);
 expect(await engine.search("slack.com.evil.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
 expect(await engine.search("unknown.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
 const description = await engine.describe("arcade:Gmail.ListEmails");
 expect(description.toolkit.version).toBe("1.2.3");
 expect(description.inputSchema).toMatchObject({ type: "object", properties: { query: { type: "string" } }, required: ["query"] });
 expect(description.domainEvidence.some(e => e.source === "documented-toolkit")).toBe(true);
});

test("1000-page loading coalesces across concurrent searches and engine instances with shared scope", async () => {
 const tools = Array.from({ length: 2501 }, (_, i) => tool(`Service.Read${i}`)); tools[2500] = tool("Gmail.ListEmails");
 const requests: string[] = []; let inflight = 0; let peak = 0;
 const transport: HttpFetch = async (url: any) => {
  requests.push(String(url)); const parsed = new URL(String(url));
  if (parsed.pathname.endsWith("auth_providers")) return json(page(providers));
  expect(parsed.searchParams.get("limit")).toBe("1000");
  inflight++; peak = Math.max(peak, inflight); await new Promise(resolve => setTimeout(resolve, 2)); inflight--;
  const offset = Number(parsed.searchParams.get("offset")); return json(page(tools.slice(offset, offset + 1000), offset, tools.length));
 };
 const first = new ConnectorEngine({ owner: "123", store, env, fetch: transport });
 const second = new ConnectorEngine({ owner: "456", store, env, fetch: transport });
 const results = await Promise.all([first.search("gmail.com"), second.search("Gmail"), first.listCatalog()]);
 expect(results[0]).toMatchObject({ status: "available", catalogSize: 2501 });
 expect(requests.filter(u => u.includes("tools?"))).toHaveLength(3); expect(peak).toBeLessThanOrEqual(3);
 await first.describe("arcade:Gmail.ListEmails"); await first.search("gmail.com"); expect(requests).toHaveLength(4);
 const catalog = await first.listCatalog(); catalog[0]!.domains.push("poisoned.com");
 expect((await second.listCatalog())[0]!.domains).not.toContain("poisoned.com");
});

test("catalog key rotation isolates cache entries and pins the loading scope", async () => {
 const mutable = { ARCADE_API_KEY: "scope-one-key-material" }; const headers: string[] = [];
 const transport: HttpFetch = async (url: any, init?: any) => {
  headers.push(new Headers(init.headers).get("Authorization")!);
  const offset = Number(new URL(String(url)).searchParams.get("offset"));
  if (offset === 0 && mutable.ARCADE_API_KEY.includes("one")) { mutable.ARCADE_API_KEY = "scope-two-key-material"; return json(page([tool("One.First")], 0, 2)); }
  if (offset === 1) return json(page([tool("One.Second")], 1, 2));
  return json(page([tool("Two.Read")]));
 };
 const engine = new ConnectorEngine({ owner: "123", store, env: mutable, fetch: transport });
 expect((await engine.listCatalog()).map(t => t.name)).toEqual(["One.First", "One.Second"]);
 expect(headers.slice(0, 2)).toEqual(["Bearer scope-one-key-material", "Bearer scope-one-key-material"]);
 expect((await engine.listCatalog())[0]!.name).toBe("Two.Read");
});

test("expired snapshots fail closed, cooldown coalesces failure and recovery refreshes", async () => {
 const cache = new CatalogCache(); let now = 1000000; let calls = 0; let failing = false;
 const clock = spyOn(Date, "now").mockImplementation(() => now);
 const api = async () => { calls++; if (failing) throw new Error("no access"); return page([tool("Gmail.ListEmails")]); };
 try {
  await cache.catalog(api, s => s); await cache.catalog(api, s => s); expect(calls).toBe(1);
  now += 300001; failing = true;
  await expect(cache.catalog(api, s => s)).rejects.toThrow();
  await expect(cache.catalog(api, s => s)).rejects.toThrow(); expect(calls).toBe(2);
  now += 5001; failing = false; expect((await cache.catalog(api, s => s)).tools).toHaveLength(1); expect(calls).toBe(3);
 } finally { clock.mockRestore(); }
});

test("semantic service categories are retained without pretending to be website domains", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async () => json(page([tool("Gmail.ListEmails", { metadata: { classification: { service_domains: ["EMAIL"] } } })])) });
 expect((await engine.search("gmail.com")).status).toBe("available");
 expect((await engine.describe("arcade:Gmail.ListEmails")).metadata).toMatchObject({ classification: { service_domains: ["EMAIL"] } });
 expect((await engine.search("unknown.com")).status).toBe("unavailable");
});

test("BM25 retrieval ranks task words and provider identities, qualified names are not mistaken for domains", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async () => json(page([
  tool("Gmail.ListEmails", { description: "Find search email messages in mailbox" }),
  tool("Other.SendAlert", { description: "Send a notification to Gmail" }),
  tool("Slack.ListChannels", { description: "List team workspace channels" }),
 ])) });
 expect((await engine.search("Gmail")).connectors[0]!.name).toBe("Gmail.ListEmails");
 expect((await engine.search("find mailbox messages")).connectors[0]!.name).toBe("Gmail.ListEmails");
 expect((await engine.search("Gmail.ListEmails")).connectors[0]!.name).toBe("Gmail.ListEmails");
});

test("auth providers are represented without executable claims, endpoints, clients or secret values", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async u => json(String(u).includes("tools?") ? page([tool("Other.Read")]) : page([{ ...providers[0], oauth2: { client_id: "client-sensitive", client_secret: "secret-sensitive", authorize_request: { endpoint: "https://accounts.google.com/o/oauth2/auth", params: { secret: "hidden" } } } }])) });
 const result = await engine.search("gmail.com");
 expect(result).toMatchObject({ status: "available", connectors: [], fallbackAllowed: false });
 expect(result.authProviders?.[0]).toMatchObject({ kind: "auth_provider", executable: false, authorizationDomains: ["accounts.google.com"] });
 expect(JSON.stringify(result)).not.toMatch(/client-sensitive|secret-sensitive|hidden|oauth2\/auth/);
 await expect(engine.connect("arcade-google")).rejects.toThrow();
});

test("provider listing failures cannot erase tool matches or prove domain absence", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async u => String(u).includes("tools?") ? json(page([tool("Gmail.ListEmails")])) : json({}, 403) });
 expect(await engine.search("gmail.com")).toMatchObject({ status: "available", authProvidersStatus: "unavailable" });
 expect(await engine.search("unknown.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
 await expect(engine.listAuthProviders()).rejects.toThrow();
});

test("schema and requirements projection preserves parameter names and secret requirements, strips credential values", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async () => json(page([tool("Gmail.Read", {
  input: { parameters: [{ name: "page_token", required: false, value_schema: { val_type: "string", default: "hidden-default" } }, { name: "ids", value_schema: { val_type: "array", inner_val_type: "integer" } }, { name: "data", value_schema: { val_type: "json" } }] },
  requirements: { met: false, authorization: { id: "arcade-google", token: "hidden-token", oauth2: { scopes: ["https://www.googleapis.com/auth/gmail.readonly"] } }, secrets: [{ key: "SERVICE_API_KEY", met: false, value: "hidden-value" }] },
 })])) });
 const description = await engine.describe("arcade:Gmail.Read");
 expect(description.inputSchema).toMatchObject({ properties: { page_token: { type: "string" }, ids: { type: "array", items: { type: "integer" } }, data: {} } });
 expect(description.requirements).toMatchObject({ authorization: { id: "arcade-google" }, secrets: [{ key: "SERVICE_API_KEY", met: false }] });
 expect(JSON.stringify(description)).not.toMatch(/hidden-default|hidden-token|hidden-value/);
});

test("inconsistent later pages never publish a partial cache", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async u => json(String(u).endsWith("offset=0") ? page([tool("Gmail.ListEmails")], 0, 2) : page([], 1, 2)) });
 expect(await engine.search("gmail.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
 await expect(engine.listCatalog()).rejects.toThrow();
});

test("even complete domain metadata cannot enable fallback when provider catalog fails", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async u => String(u).includes("tools?") ? json(page([tool("GitHub.Read", { metadata: { classification: { service_domains: ["github.com"] } } })])) : json({}, 500) });
 expect(await engine.search("unknown.com")).toMatchObject({ status: "unavailable", fallbackAllowed: false });
 await expect(engine.connectBrowser("unknown.com")).rejects.toThrow("Confirmed Arcade absence required");
});

test("router search bounds returned payload but reports full matching count", async () => {
 const tools = Array.from({ length: 75 }, (_, i) => tool(`Gmail.Read${i}`));
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async u => json(String(u).includes("tools?") ? page(tools) : page([])) });
 const result = await engine.search("gmail.com");
 expect(result.connectors).toHaveLength(50); expect(result.totalMatches).toBe(75);
 expect(await engine.listCatalog()).toHaveLength(75);
});

test("provider scope domains support explicit resource identity without guessed brand matching", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async u => json(String(u).includes("tools?") ? page([tool("Custom.Read", { requirements: { authorization: { provider_id: "custom", oauth2: { scopes: ["https://service.net/api/read"] } } } })]) : page([])) });
 const result = await engine.search("service.net"); expect(result.status).toBe("available");
 expect((await engine.describe("arcade:Custom.Read")).domainEvidence).toContainEqual({ domain: "service.net", source: "provider-scope" });
 expect((await engine.search("other.net")).fallbackAllowed).toBe(false);
});

test("formatted schema descriptions redact known key and drop default values", async () => {
 const engine = new ConnectorEngine({ owner: "123", store, env, fetch: async () => json(page([tool("Gmail.Read", { formatted_schema: { function: { parameters: { type: "object", properties: { page_token: { type: "string", description: env.ARCADE_API_KEY, default: "hidden-default" } } } } } })])) });
 const described = await engine.describe("arcade:Gmail.Read");
 expect(described.inputSchema).toMatchObject({ properties: { page_token: { type: "string", description: "[redacted]" } } });
 expect(JSON.stringify(described)).not.toContain("hidden-default");
});
