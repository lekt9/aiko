import { afterEach, expect, test } from "bun:test";
import { ConnectorEngine, type ConnectorStore } from "../src/connectors.ts";
import { connectorApi } from "../src/connector-api.ts";
import { handleConnectorRequest } from "../../web/src/server/connector-proxy.ts";
import { previewConnectorCsv, rowsFromPreviews } from "../../web/src/lib/login-import.ts";
import { LOGIN_IMPORT_MAX_BYTES, LOGIN_IMPORT_MAX_ROWS } from "../../../packages/protocol/src/login-import.ts";

const originalFetch = globalThis.fetch;
const originalOrigin = process.env.AIKO_CONNECTOR_ORIGIN;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOrigin === undefined) delete process.env.AIKO_CONNECTOR_ORIGIN;
  else process.env.AIKO_CONNECTOR_ORIGIN = originalOrigin;
});
function fixture() {
  const values = new Map<string, unknown>();
  const store: ConnectorStore = {
    get: async key => structuredClone(values.get(key)),
    set: async (key, value) => { values.set(key, structuredClone(value)); },
    list: async prefix => [...values].filter(([key]) => key.startsWith(prefix)).map(([, value]) => structuredClone(value)),
  };
  const engine = new ConnectorEngine({ owner: "123", store, env: {}, fetch: async () => { throw Error("No provider calls allowed"); } });
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  let calls = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-owner");
    return connectorApi(new Request(String(url), init), engine);
  }) as typeof fetch;
  const request = (body: string, path = "/api/connectors/imports/logins") => new Request(`https://web.example${path}`, {
    method: "POST", headers: { authorization: "Bearer synthetic-owner", "content-type": "application/json" }, body,
  });
  return { values, engine, calls: () => calls, request, send: (body: string) => handleConnectorRequest(request(body)) };
}
const table = (count: number, name = "登录".repeat(30)) => ({
  columns: ["name", "url", "username"].map(label => ({ label, ignored: false })),
  rows: Array.from({ length: count }, (_, i) => ({ row: i + 2, cells: [name, `site${i}.com`, "用".repeat(115) + i], malformed: false })),
});
const preview = (count: number, name?: string) => previewConnectorCsv(table(count, name), { name: 0, domain: 1, identity: 2 }, []);

test("all 500 ready Unicode login rows pass the preview, proxy, account handler and real engine", async () => {
  const f = fixture();
  const rows = rowsFromPreviews(preview(LOGIN_IMPORT_MAX_ROWS));
  expect(rows).toHaveLength(500);
  const body = JSON.stringify({ rows });
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(16384);
  const response = await f.send(body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ imported: 500, updated: 0, skipped: [] });
  expect(await f.engine.connections()).toHaveLength(500);
  expect(f.calls()).toBe(1);
  const foreign = new ConnectorEngine({ owner: "456", store: { get: async () => undefined, set: async () => {}, list: async () => [...f.values.values()] }, env: {} });
  expect(await foreign.connections()).toEqual([]);
});

test("row overflow is rejected consistently before storage", async () => {
  const f = fixture();
  expect(rowsFromPreviews(preview(501))).toEqual([]);
  const rows = Array.from({ length: 501 }, (_, i) => ({ website: `site${i}.com` }));
  const response = await f.send(JSON.stringify({ rows }));
  expect(response.status).toBe(413);
  expect((await response.json()).message).toContain("500");
  expect(f.values.size).toBe(0);
  await expect(f.engine.importLogins(rows)).rejects.toThrow("500");
});

test("preview and both HTTP layers reject UTF-8 byte overflow with actionable errors", async () => {
  const f = fixture();
  const name = "用".repeat(400_000);
  const previews = preview(1, name);
  expect(rowsFromPreviews(previews)).toEqual([]);
  expect(previews[0].message).toContain("too large");
  const body = JSON.stringify({ rows: [{ website: "site.com", name }] });
  expect(body.length).toBeLessThan(LOGIN_IMPORT_MAX_BYTES);
  expect(new TextEncoder().encode(body).length).toBeGreaterThan(LOGIN_IMPORT_MAX_BYTES);
  for (const response of [await f.send(body), await connectorApi(f.request(body), f.engine)]) {
    expect(response.status).toBe(413);
    expect((await response.json()).message).toContain("fewer logins");
  }
  expect(f.calls()).toBe(0);
  expect(f.values.size).toBe(0);
});

test("the byte limit is inclusive and cancels an oversized chunked import", async () => {
  const f = fixture();
  const json = JSON.stringify({ rows: [{ website: "site.com" }] });
  const exact = json + " ".repeat(LOGIN_IMPORT_MAX_BYTES - json.length);
  expect((await f.send(exact)).status).toBe(200);
  expect(f.calls()).toBe(1);
  for (const route of [handleConnectorRequest, (request: Request) => connectorApi(request, f.engine)]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode(exact)); c.enqueue(new Uint8Array([32])); },
      cancel() { cancelled = true; },
    });
    const request = new Request(f.request("{}").url, { method: "POST", headers: f.request("{}").headers, body: stream, duplex: "half" } as RequestInit);
    expect((await route(request)).status).toBe(413);
    expect(cancelled).toBe(true);
  }
  expect(f.calls()).toBe(1);
});

test("ordinary connector routes retain their smaller caps and malformed imports make no changes", async () => {
  const f = fixture();
  expect((await handleConnectorRequest(f.request(" ".repeat(17000), "/api/connectors/native"))).status).toBe(413);
  expect(f.calls()).toBe(0);
  expect((await connectorApi(f.request(" ".repeat(9000), "/api/connectors/native"), f.engine)).status).toBe(409);
  for (const body of ["null", "{", '{"rows":[]}', '{"rows":[],"owner":"456"}']) {
    expect((await f.send(body)).status).toBe(400);
  }
  expect(f.values.size).toBe(0);
});
