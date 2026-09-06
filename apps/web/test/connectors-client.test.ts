import { afterEach, describe, expect, it, vi } from "vitest";
import { connectorRequest } from "../src/lib/connectors";
afterEach(() => vi.unstubAllGlobals());
function setup() {
  vi.stubGlobal("window", {
    Telegram: { WebApp: { initData: "fixture-signed-data" } },
  });
  const fetch = vi.fn(async () => Response.json({ connections: [] }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
describe("connector account authentication", () => {
  it("sends Telegram signed data in dedicated header, not Authorization", async () => {
    const fetch = setup();
    await connectorRequest("?query=github");
    const [, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.headers).toEqual({
      "x-telegram-init-data": "fixture-signed-data",
    });
    expect(options.cache).toBe("no-store");
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
  it("unauthorized responses offer both sign-in paths without echoing remote secrets", async () => {
    setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ message: "private-upstream-secret" }, { status: 401 }),
      ),
    );
    await expect(connectorRequest("/connections")).rejects.toThrow(
      "Sign in with an Aiko account credential",
    );
    await expect(connectorRequest("/connections")).rejects.not.toThrow(
      "private-upstream-secret",
    );
  });
});
