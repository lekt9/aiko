import { afterEach, expect, test, vi } from "vitest";
import { handleConnectorRequest } from "../src/server/connector-proxy";
import { connectorRequest } from "../src/lib/connectors";

const originalOrigin = process.env.AIKO_CONNECTOR_ORIGIN;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOrigin === undefined) delete process.env.AIKO_CONNECTOR_ORIGIN;
  else process.env.AIKO_CONNECTOR_ORIGIN = originalOrigin;
});
const decision = JSON.stringify({ id: "fixture-task", hash: "fixture-hash", decision: "approve" });
function request(path: string, method = "GET", headers: Record<string, string> = {}, body = decision) {
  return new Request(`https://web.example${path}`, {
    method, headers: { authorization: "tms fixture-owner", "content-type": "application/json", ...headers },
    ...(method === "POST" ? { body } : {}),
  });
}

test("shared Mini App transport sends promise paths to the account API, not connector actions", async () => {
  vi.stubGlobal("window", {});
  const transport = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ promises: [] }));
  vi.stubGlobal("fetch", transport);
  const authentication = { bearer: "fixture-owner", telegram: false };
  await connectorRequest("/promises", undefined, undefined, authentication);
  await connectorRequest("/promises/decision", JSON.parse(decision), undefined, authentication);
  expect(transport.mock.calls.map(([url]) => url)).toEqual(["/api/promises", "/api/promises/decision"]);
  expect(transport.mock.calls[0]![1].headers).toEqual({ Authorization: "Bearer fixture-owner" });
  expect(transport.mock.calls[1]![1].body).toBe(decision);
});

test("promise routes forward only owner credentials and the exact frozen decision", async () => {
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  const transport = vi.fn(async (_url: URL, _options: RequestInit) => Response.json({ promises: [] }));
  vi.stubGlobal("fetch", transport);
  for (const [path, method] of [["/api/promises", "GET"], ["/api/promises/decision", "POST"]]) {
    const result = await handleConnectorRequest(request(path!, method));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const [url, options] = transport.mock.calls.at(-1)!;
    expect(url.href).toBe(`https://agent.example${path}`);
    expect(options.headers).toEqual({ Authorization: "tms fixture-owner", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) });
    expect(options.body).toBe(method === "POST" ? decision : undefined);
    expect(options.redirect).toBe("error");
  }
});

test("query variants, unsupported methods and unknown promise paths never dispatch", async () => {
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  for (const [path, method] of [["/api/promises?owner=foreign", "GET"], ["/api/promises/decision?owner=foreign", "POST"], ["/api/promises", "POST"], ["/api/promises/decision", "GET"], ["/api/promises/dispatch", "POST"]]) {
    expect((await handleConnectorRequest(request(path!, method))).status).toBe(404);
  }
  expect(transport).not.toHaveBeenCalled();
});

test("promise decisions retain auth, origin, JSON and streamed capacity fences", async () => {
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  const transport = vi.fn(); vi.stubGlobal("fetch", transport);
  for (const [headers, body, status] of [
    [{ authorization: "" }, decision, 401],
    [{ origin: "https://foreign.example" }, decision, 403],
    [{ "content-type": "text/plain" }, decision, 415],
    [{}, "x".repeat(16385), 413],
  ] as const) {
    expect((await handleConnectorRequest(request("/api/promises/decision", "POST", headers, body))).status).toBe(status);
  }
  expect(transport).not.toHaveBeenCalled();
});

test("upstream denial remains a denial, not a successful empty promise list", async () => {
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "forbidden" }, { status: 403 })));
  const result = await handleConnectorRequest(request("/api/promises"));
  expect(result.status).toBe(403);
  expect(await result.json()).toEqual({ error: "forbidden" });
});
