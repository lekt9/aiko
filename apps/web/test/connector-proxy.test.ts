import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConnectorRequest } from "../src/server/connector-proxy";
import { safeAuthorizationUrl } from "../src/lib/connectors";
const originalOrigin = process.env.AIKO_CONNECTOR_ORIGIN;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalOrigin === undefined) delete process.env.AIKO_CONNECTOR_ORIGIN;
  else process.env.AIKO_CONNECTOR_ORIGIN = originalOrigin;
});
function request(
  path = "",
  method = "GET",
  body?: string,
  auth = "tma signed-user",
) {
  return new Request(`https://web.example/api/connectors${path}`, {
    method,
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body,
  });
}
describe("account connector proxy", () => {
  it("rejects unauthenticated requests before contacting runtime", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      (await handleConnectorRequest(request("", "GET", undefined, ""))).status,
    ).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("requires explicit service configuration", async () => {
    delete process.env.AIKO_CONNECTOR_ORIGIN;
    expect((await handleConnectorRequest(request())).status).toBe(503);
  });
  it("forwards only end-user auth, fixed path and JSON body", async () => {
    process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
    const fetch = vi.fn(async () => Response.json({ status: "pending" }));
    vi.stubGlobal("fetch", fetch);
    const result = await handleConnectorRequest(
      request(
        "/connect",
        "POST",
        JSON.stringify({ connectorId: "arcade:GitHub.List" }),
      ),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://agent.example/api/connectors/connect");
    expect(options.headers).toEqual({
      Authorization: "tma signed-user",
      "Content-Type": "application/json",
    });
    expect(options.redirect).toBe("error");
    expect(JSON.parse(String(options.body))).toEqual({
      connectorId: "arcade:GitHub.List",
    });
  });
  it("rejects unknown paths and oversized payloads without fetching", async () => {
    process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      (await handleConnectorRequest(request("/admin", "POST", "{}"))).status,
    ).toBe(404);
    expect(
      (
        await handleConnectorRequest(
          request("/connect", "POST", "x".repeat(17000)),
        )
      ).status,
    ).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never accepts credentials embedded in configured origin", async () => {
    process.env.AIKO_CONNECTOR_ORIGIN = "https://operator:secret@agent.example";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect((await handleConnectorRequest(request())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("fails safely without returning upstream exception text", async () => {
    process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("private-token");
      }),
    );
    const result = await handleConnectorRequest(request());
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("private-token");
  });
  it("rejects unsafe authorization links", () => {
    for (const value of [
      "javascript:alert(1)",
      "http://example.com",
      "https://user:password@example.com",
      "//example.com",
      "bad url",
    ])
      expect(safeAuthorizationUrl(value)).toBeUndefined();
    expect(
      safeAuthorizationUrl("https://arcade.dev/authorize?state=opaque"),
    ).toBe("https://arcade.dev/authorize?state=opaque");
  });
});

it("forwards authenticated manager authorization, callback and private fill routes", async () => {
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  for (const action of ["add", "authorize", "callback", "fill", "remove"]) {
    const response = await handleConnectorRequest(request(`/password-managers/${action}`, "POST", "{}", "Bearer owner"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect((await handleConnectorRequest(request("/password-managers", "GET"))).status).toBe(200);
  expect((await handleConnectorRequest(request("/password-managers/callback", "POST", "{}", ""))).status).toBe(401);
  expect(fetch).toHaveBeenCalledTimes(6);
});
