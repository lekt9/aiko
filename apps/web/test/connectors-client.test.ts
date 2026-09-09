import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorRequest, websiteDomain, loginConnectionId, clearMiniAppSession } from "../src/lib/connectors";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeLoginPanel } from "../src/components/native-login-panel";
afterEach(() => {vi.unstubAllGlobals();clearMiniAppSession();});
it("login fields wait for private metadata without password-manager instructions", () => {
  const request = vi.fn();
  const markup = renderToStaticMarkup(
    createElement(NativeLoginPanel, {
      connectionId: "fixture",
      domain: "example.com",
      request,
      onClose: () => {},
    }),
  );
  expect(markup).not.toContain('name="username"');
  expect(markup).not.toContain('name="password"');
  expect(markup).toContain("Getting your login ready…");
  expect(markup).not.toContain("Use a password manager");
  expect(markup).not.toContain("Could not confirm sign-in");
  expect(markup).not.toContain("Sign in on website");
  expect(markup).not.toContain("native-login-browser");
  expect(markup).toContain('aria-busy="true"');
  expect(request).not.toHaveBeenCalled();
});
describe("app drawer website entry", () => {
  it.each([
    ["notion.so", "notion.so"],
    ["  HTTPS://GitHub.com/login  ", "github.com"],
    ["mail.example.com/path?tab=login", "mail.example.com"],
  ])("normalizes an explicit address: %s", (input, expected) => {
    expect(websiteDomain(input)).toBe(expected);
  });
  it.each([
    "",
    "LinkedIn",
    "not a website.com",
    "http://example.com",
    "javascript:alert(1)",
    "https://user:secret@example.com",
    "user@example.com",
    "https://example.com:444",
  ])("rejects guessed or unsafe addresses: %s", (input) => {
    expect(websiteDomain(input)).toBeUndefined();
  });
});
function setup() {
  vi.stubGlobal("window", {
    Telegram: { WebApp: { initData: "fixture-signed-data" } },
  });
  const fetch = vi.fn(async (input:RequestInfo|URL) => Response.json(String(input)==="/api/connectors/session"?{token:"fixture-session-token"}:{connections:[]}));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("connector account authentication", () => {
  it("exchanges Telegram signed data once, then sends only the account session token", async () => {
    const fetch = setup();
    await connectorRequest("?query=github");
    const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.headers).toEqual({
      "x-telegram-init-data": "fixture-signed-data", "Content-Type":"application/json",
    });
    expect(options.cache).toBe("no-store");
    const [url,readOptions]=fetch.mock.calls[1] as unknown as [string,RequestInit];
    expect(url).toBe("/api/connectors?query=github");
    expect(readOptions.headers).toEqual({Authorization:"tms fixture-session-token"});
    await connectorRequest("/connections");
    expect(fetch.mock.calls.filter(call=>call[0]==="/api/connectors/session")).toHaveLength(1);
  });
  it("explicit browser account bearer takes precedence without mixing identities", async () => {
    const fetch = setup();
    await connectorRequest(
      "/connect",
      { connectorId: "arcade:GitHub.List" },
      undefined,
      { bearer: "fixture-account-key" },
    );
    const [url, options] = fetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/connectors/connect");
    expect(options.headers).toEqual({
      Authorization: "Bearer fixture-account-key",
      "Content-Type": "application/json",
    });
    expect(options.body).not.toContain("fixture-account-key");
  });
  it("signed-out requests do not silently reuse Telegram credentials", async () => {
    const fetch = setup();
    await connectorRequest("/connections", undefined, undefined, {
      telegram: false,
    });
    const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.headers).toEqual({});
  });
  it("unauthorized responses explain the active sign-in path without echoing remote secrets", async () => {
    setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "private-upstream-secret" }, { status: 401 }),
      ),
    );
    await expect(connectorRequest("/connections")).rejects.toThrow(
      "Close this mini app and reopen it",
    );
    await expect(connectorRequest("/connections",undefined,undefined,{telegram:false})).rejects.toThrow("Sign in with an Aiko account credential");
    await expect(connectorRequest("/connections")).rejects.not.toThrow(
      "private-upstream-secret",
    );
  });
});

const loginId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
it("Mini App launch selects only a single connection ID", () => {
  expect(loginConnectionId(`?connection=${loginId}`)).toBe(loginId);
  for (const query of ["", "?connection=secret", `?connection=${loginId}&connection=${loginId}`, "?connection=https://other.example"]) {
    expect(loginConnectionId(query)).toBeUndefined();
  }
});

it("watch requests reuse owner authentication and do not fall under connector routes",async()=>{
  vi.stubGlobal("window",{});
  const fetch=vi.fn(async()=>Response.json({available:true,result:[]}));vi.stubGlobal("fetch",fetch);
  await connectorRequest("/channels/browser-watches/discovery",undefined,undefined,{bearer:"owner-only",telegram:false});
  expect(fetch.mock.calls[0]).toMatchObject(["/api/channels/browser-watches/discovery",{headers:{Authorization:"Bearer owner-only"},cache:"no-store",credentials:"same-origin"}]);
  fetch.mockResolvedValueOnce(Response.json({error:"watch_operation_unavailable"},{status:503}));
  await expect(connectorRequest("/channels/browser-watches",undefined,undefined,{bearer:"owner-only",telegram:false})).rejects.toThrow("unavailable for this account");
});

it("leaving during Telegram exchange releases only that caller and never dispatches its login", async () => {
  setup();
  let resolveSession!: (response: Response) => void;
  const fetch = vi.fn((url: RequestInfo | URL) => String(url).endsWith("/session")
    ? new Promise<Response>(resolve => { resolveSession = resolve; })
    : Promise.resolve(Response.json({ connections: [] })));
  vi.stubGlobal("fetch", fetch);
  const leaving = new AbortController();
  const login = connectorRequest("/native", { action: "form" }, leaving.signal);
  const other = connectorRequest("/connections");
  leaving.abort();
  await expect(login).rejects.toMatchObject({ name: "AbortError" });
  resolveSession(Response.json({ token: "fixture-session" }));
  await expect(other).resolves.toEqual({ connections: [] });
  expect(fetch.mock.calls.map(call => call[0])).toEqual(["/api/connectors/session", "/api/connectors/connections"]);
});

it.each(["form", "finish", "status"])("bounds %s metadata reads independently of private submissions", async action => {
  vi.stubGlobal("window", {});
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetch = vi.fn((_url: RequestInfo | URL, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
  }));
  vi.stubGlobal("fetch", fetch);
  try {
    const read = connectorRequest("/native", { action }, undefined, { telegram: false });
    expect(timeout).toHaveBeenCalledWith(20_000);
    deadline.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(read).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally { timeout.mockRestore(); }
});
