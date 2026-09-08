import { afterEach, expect, test, vi } from "vitest";
import { connectorRequest } from "../src/lib/connectors";
import { handleConnectorRequest } from "../src/server/connector-proxy";
const original = process.env.AIKO_CONNECTOR_ORIGIN;
afterEach(() => {
  vi.unstubAllGlobals();
  if (original === undefined) delete process.env.AIKO_CONNECTOR_ORIGIN;
  else process.env.AIKO_CONNECTOR_ORIGIN = original;
});
const operations = [
  "inspect",
  "revise",
  "evaluate",
  "promote",
  "recall",
  "run",
  "output",
  "from-request",
];
test("library client shares owner authentication and exact account endpoint paths", async () => {
  vi.stubGlobal("window", {});
  const fetch = vi.fn(async () =>
    Response.json({ available: true, result: {} }),
  );
  vi.stubGlobal("fetch", fetch);
  for (const operation of ["", ...operations])
    await connectorRequest(
      "/harness/library" + (operation ? "/" + operation : ""),
      operation ? { operationId: "stable" } : undefined,
      undefined,
      { bearer: "owner-token", telegram: false },
    );
  expect(fetch.mock.calls).toHaveLength(9);
  expect(fetch.mock.calls[0][0]).toBe("/api/harness/library");
  for (const [url, init] of fetch.mock.calls as unknown as [
    string,
    RequestInit,
  ][]) {
    expect(url).not.toContain("/connectors");
    expect(init.headers).toMatchObject({ Authorization: "Bearer owner-token" });
  }
});
test("proxy forwards fixed library operations with end-user credentials only", async () => {
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  const fetch = vi.fn(async () =>
    Response.json({ available: true, result: {} }),
  );
  vi.stubGlobal("fetch", fetch);
  for (const operation of operations) {
    const response = await handleConnectorRequest(
      new Request("https://web.example/api/harness/library/" + operation, {
        method: "POST",
        headers: {
          authorization: "tms user-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId: "stable" }),
      }),
    );
    expect(response.status).toBe(200);
  }
  expect(fetch.mock.calls).toHaveLength(8);
  for (const [url, init] of fetch.mock.calls as unknown as [
    URL,
    RequestInit,
  ][]) {
    expect(url.origin).toBe("https://agent.example");
    expect(init.headers).toEqual({
      Authorization: "tms user-session",
      "Content-Type": "application/json",
    });
  }
});
test("proxy refuses arbitrary methods, paths, cross-origin mutation and missing auth", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  process.env.AIKO_CONNECTOR_ORIGIN = "https://agent.example";
  for (const [path, method] of [
    ["/run", "GET"],
    ["/unknown", "POST"],
    ["?url=https://other.example", "GET"],
    ["/inspect", "PUT"],
  ]) {
    const response = await handleConnectorRequest(
      new Request("https://web.example/api/harness/library" + path, {
        method,
        headers: { authorization: "tms owner" },
      }),
    );
    expect(response.status).toBe(404);
  }
  expect(
    (
      await handleConnectorRequest(
        new Request("https://web.example/api/harness/library"),
      )
    ).status,
  ).toBe(401);
  expect(
    (
      await handleConnectorRequest(
        new Request("https://web.example/api/harness/library/run", {
          method: "POST",
          headers: {
            authorization: "tms owner",
            origin: "https://other.example",
          },
        }),
      )
    ).status,
  ).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
});
