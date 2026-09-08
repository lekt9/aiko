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
  it("forwards database artifacts and decisions with caller credentials and rejects foreign origins", async () => {
    process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
    const fetch = vi.fn(async () => Response.json({ status: "committed" }));
    vi.stubGlobal("fetch", fetch);
    for (const [path, method] of [["/api/databases/field", "POST"], ["/api/databases/mappings/person", "GET"], ["/api/databases/artifacts/projects", "GET"], ["/api/databases/changes", "GET"], ["/api/databases/query", "POST"], ["/api/observed-actions/approval", "POST"], ["/api/messages", "GET"]]) {
      const result = await handleConnectorRequest(new Request(`https://web.example${path}`, { method, headers: { authorization: "Bearer user-only", "content-type": "application/json", origin: "https://web.example" }, ...(method === "POST" ? { body: "{}" } : {}) }));
      expect(result.status).toBe(200);
      const [url, options] = fetch.mock.calls.at(-1) as unknown as [URL, RequestInit];
      expect(url.href).toBe(`https://agent.example${path}`);
      expect((options.headers as Record<string, string>).Authorization).toBe("Bearer user-only");
    }
    const before = fetch.mock.calls.length;
    expect((await handleConnectorRequest(new Request("https://web.example/api/databases/commands", { method: "POST", headers: { origin: "https://foreign.example", authorization: "Bearer user-only" } }))).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(before);
  });
  it("forwards the secretary work surface with the owner's credentials", async () => {
    process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
    const fetch = vi.fn(async () => Response.json({ status: "saved" }));
    vi.stubGlobal("fetch", fetch);
    const result = await handleConnectorRequest(new Request("https://web.example/api/secretary/work", {
      method: "POST", headers: { Authorization: "tma signed-user", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "capture", id: "review" }),
    }));
    expect(result.status).toBe(200);
    const [url, options] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe("https://agent.example/api/secretary/work");
    expect(options.headers).toEqual({ Authorization: "tma signed-user", "Content-Type": "application/json" });
    expect(JSON.parse(String(options.body))).toEqual({ action: "capture", id: "review" });
  });
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
  for (const action of ["add", "authorize", "callback", "unlock-parameters", "unlock", "browse", "select", "fill", "remove"]) {
    const response = await handleConnectorRequest(request(`/password-managers/${action}`, "POST", "{}", "Bearer owner"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect((await handleConnectorRequest(request("/password-managers", "GET"))).status).toBe(200);
  expect((await handleConnectorRequest(request("/password-managers/callback", "POST", "{}", ""))).status).toBe(401);
  expect(fetch).toHaveBeenCalledTimes(10);
});

it("forwards bound OTP privately once and does not retry a lost upstream reply",async()=>{
  process.env.AIKO_CONNECTOR_ORIGIN="https://agent.example";
  const body={connectionId:"11111111-1111-4111-8111-111111111111",action:"credentials",code:"FIXTURE_PRIVATE_OTP",attemptId:"22222222-2222-4222-8222-222222222222",challengeId:"33333333-3333-4333-8333-333333333333",submissionId:"44444444-4444-4444-8444-444444444444",expectedRevision:3};
  const upstream=vi.fn(async()=>{throw Error("upstream lost "+body.code);});vi.stubGlobal("fetch",upstream);
  const response=await handleConnectorRequest(request("/native","POST",JSON.stringify(body)));
  expect(upstream).toHaveBeenCalledTimes(1);
  const [,init]=upstream.mock.calls[0] as unknown as [URL,RequestInit];
  expect(JSON.parse(String(init.body))).toEqual(body);
  expect(response.status).toBe(503);expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).not.toContain(body.code);
});

describe("browser watch owner API proxy",()=>{
  it("forwards only exact owner watch operations through existing account authentication",async()=>{
    process.env.AIKO_CONNECTOR_ORIGIN="https://agent.example";
    const fetch=vi.fn(async()=>Response.json({available:true,result:[]}));vi.stubGlobal("fetch",fetch);
    for(const [suffix,method] of [["","GET"],["/discovery","GET"],["/configure","POST"],["/control","POST"],["/sample","POST"],["/reconcile","POST"],["/acknowledge-gap","POST"]]){
      const path=`/api/channels/browser-watches${suffix}`;
      const response=await handleConnectorRequest(new Request(`https://web.example${path}`,{method,headers:{authorization:"Bearer owner-only",origin:"https://web.example","content-type":"application/json"},...(method==="POST"?{body:"{}"}:{})}));
      expect(response.status).toBe(200);
      const [url,options]=fetch.mock.calls.at(-1) as unknown as [URL,RequestInit];
      expect(url.pathname).toBe(path);expect(options.headers).toMatchObject({Authorization:"Bearer owner-only"});
    }
    const count=fetch.mock.calls.length;
    for(const path of ["/api/channels/browser-watches/arbitrary","/api/channels/browser-watches?owner=another","/api/channels/browser-watches/discovery?token=private"]){
      expect((await handleConnectorRequest(new Request(`https://web.example${path}`,{headers:{authorization:"Bearer owner-only"}}))).status).toBe(404);
    }
    expect(fetch).toHaveBeenCalledTimes(count);
    expect((await handleConnectorRequest(new Request("https://web.example/api/channels/browser-watches"))).status).toBe(401);
  });
});
