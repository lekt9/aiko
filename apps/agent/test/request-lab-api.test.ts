import { expect, test } from "bun:test";
import { requestLabApi, type RequestLabRunner } from "../src/request-lab-api.ts";

function fixture(run?: RequestLabRunner, scopes = ["read", "write"]) {
  return (method = "GET", body?: unknown, query = "") => requestLabApi({
    request: new Request("http://fixture/api/control/request-lab" + query, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    principal: { owner: "123", operator: false, scopes },
    allowed: account => account === "123", run,
    serialize: async operation => operation(),
  });
}

test("lab discovery is read-only and checks account boundaries", async () => {
  let calls = 0;
  const request = fixture(async () => { calls++; return {}; });
  const response = await request();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ available: true, mode: "controlled-fixture" });
  expect((await request("GET", undefined, "?account=456")).status).toBe(403);
  expect((await request("GET", undefined, "?run=changed")).status).toBe(400);
  expect(calls).toBe(0);
  expect(await (await fixture()()).json()).toMatchObject({ available: false });
});

test("only a bounded authorized scenario reaches the lab runner", async () => {
  const calls: string[] = [];
  const run: RequestLabRunner = async (scenario, signal) => { signal.throwIfAborted(); calls.push(scenario); return { scenario }; };
  const request = fixture(run);
  expect(await (await request("POST", { account: "123", scenario: "changed" })).json()).toEqual({ scenario: "changed" });
  expect((await fixture(run, ["read"])("POST", { account: "123", scenario: "changed" })).status).toBe(403);
  expect((await request("POST", { account: "456", scenario: "changed" })).status).toBe(403);
  for (const body of [null, [], { account: "123", scenario: "publish" },
    { account: "123", scenario: "changed", url: "https://example.com" },
    { account: "123", scenario: "x".repeat(1000) }]) {
    expect((await request("POST", body)).status).toBe(400);
  }
  expect(calls).toEqual(["changed"]);
});

test("unsupported hosts and internal errors are explicit without leaking error details", async () => {
  const body = { account: "123", scenario: "baseline" };
  expect((await fixture()("POST", body)).status).toBe(501);
  const response = await fixture(async () => { throw new Error("PRIVATE_SENTINEL"); })("POST", body);
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: "lab_failed" });
});
