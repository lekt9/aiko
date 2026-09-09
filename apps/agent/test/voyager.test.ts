import { describe, expect, test } from "bun:test";
import viewer, { type VoyagerEnv } from "../src/voyager-worker.ts";
import { openVoyagerSession, sealVoyagerSession, SESSION_SECONDS, VOYAGER_COOKIE, voyagerCookie } from "../src/voyager-session.ts";

const origin = "https://viewer.example.test";
const token = "fixture-owner-token-" + "a".repeat(32);
const operator = "fixture-operator-token-" + "b".repeat(32);
const other = "fixture-other-token-" + "c".repeat(32);
const key = "d".repeat(43);
function fixture() {
  const requests: Request[] = [];
  let revoked = false, unavailable = false;
  const rows = Array.from({ length: 205 }, (_, index) => ({ seq: index + 1, event: { type: index === 0 ? "ThreadCreated" : "TextReturned", text: `Production row ${index + 1}` } }));
  const env: VoyagerEnv = {
    AIKO_VOYAGER_SESSION_KEY: key, AIKO_PRODUCTION_URL: "https://production.example.test",
    VOYAGER_ASSETS: { fetch: async () => new Response("<title>voyager</title>", { headers: { "content-type": "text/html" } }) },
    AIKO_PRODUCTION: { fetch: async request => {
      requests.push(request);
      if (unavailable) return Response.json({ private: "provider details must not escape" }, { status: 503 });
      const presented = request.headers.get("authorization")?.slice(7);
      if (revoked || ![token, operator, other].includes(presented ?? "")) return Response.json({}, { status: 401 });
      const owner = presented === other ? "456" : "123", op = presented === operator;
      const url = new URL(request.url);
      if (url.pathname === "/v1/status") return Response.json({ account: owner });
      if (url.pathname === "/api/control/accounts") return Response.json({ accounts: (op ? ["123", "456"] : [owner]).map(account => ({ account, foreground: `user-${account}`, threads: 1 })) });
      if (url.pathname === "/api/control/threads") {
        const account = url.searchParams.get("account");
        if (!op && account !== owner) return Response.json({}, { status: 403 });
        return Response.json({ account, threads: [{ id: `user-${account}` }] });
      }
      if (url.pathname === "/api/control/events") {
        const thread = url.searchParams.get("thread");
        if (!op && thread !== `user-${owner}`) return Response.json({}, { status: 403 });
        const after = Number(url.searchParams.get("after")), limit = Number(url.searchParams.get("limit"));
        const events = rows.filter(row => row.seq > after).slice(0, limit);
        return Response.json({ thread, events, nextAfter: events.at(-1)?.seq ?? after, hasMore: rows.some(row => row.seq > (events.at(-1)?.seq ?? after)) });
      }
      throw Error("Unexpected production route");
    } },
  };
  const call = (path: string, cookie?: string, init: RequestInit = {}) => viewer.fetch(new Request(origin + path, { ...init, headers: { ...(cookie ? { cookie } : {}), ...init.headers } }), env);
  async function login(value = token) {
    const response = await call("/session", undefined, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token: value }) });
    expect(response.status).toBe(200);
    return response.headers.get("set-cookie")!.split(";", 1)[0]!;
  }
  return { env, requests, rows, call, login, revoke: () => { revoked = true; }, fail: () => { unavailable = true; } };
}

describe("native production Voyager access", () => {
  test("sign-in creates an encrypted HttpOnly cookie; no bearer in response HTML/JSON or URLs", async () => {
    const f = fixture();
    const response = await f.call("/session", undefined, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }) });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    for (const flag of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"]) expect(cookie).toContain(flag);
    expect(cookie).not.toContain(token);
    expect(await response.text()).not.toContain(token);
    const page = await f.call("/login");
    expect(await page.text()).not.toContain(token);
    expect(f.requests[0]!.url).toBe("https://production.example.test/v1/status");
    expect(f.requests[0]!.headers.get("cookie")).toBeNull();
    expect(f.requests[0]!.headers.get("origin")).toBeNull();
  });
  test("missing, wrong-origin and malformed sign-in requests do not reach production", async () => {
    const f = fixture();
    for (const requestOrigin of [undefined, "https://attacker.example.test"]) {
      expect((await f.call("/session", undefined, { method: "POST", headers: { ...(requestOrigin ? { origin: requestOrigin } : {}), "content-type": "application/json" }, body: JSON.stringify({ token }) })).status).toBe(403);
    }
    expect((await f.call("/session", undefined, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token, owner: "456" }) })).status).toBe(400);
    expect(f.requests).toHaveLength(0);
  });
  test("missing or invalid sessions expose no account metadata, events or streams", async () => {
    const f = fixture();
    for (const path of ["/v1/metadata", "/v1/actors", "/v1/actors/123/threads/stream", "/v1/actors/123/threads/user-123/events"]) {
      expect((await f.call(path)).status).toBe(401);
      expect((await f.call(path, `${VOYAGER_COOKIE}=made-up`)).status).toBe(401);
    }
    expect(f.requests).toHaveLength(0);
    expect((await f.call("/")).headers.get("location")).toBe("/login");
  });
  test("account selection and upstream reads retain current account isolation", async () => {
    const f = fixture(), cookie = await f.login();
    const page = await (await f.call("/accounts", cookie)).text();
    expect(page).toContain("actor=123");
    expect(page).not.toContain("actor=456");
    expect((await f.call("/?actor=456&thread=user-456", cookie)).status).toBe(403);
    expect((await f.call("/v1/actors/456/threads/user-456/events", cookie)).status).toBe(403);
    const before = f.requests.length;
    expect((await f.call("/v1/actors/123/threads/user-456/events", cookie)).status).toBe(403);
    expect(f.requests).toHaveLength(before);
    const op = await f.login(operator);
    expect((await f.call("/v1/actors/456/threads/user-456/events", op)).status).toBe(200);
  });
  test("revocation cuts retained sessions and reconnects without a cached authorization", async () => {
    const f = fixture(), cookie = await f.login();
    expect((await f.call("/v1/actors/123/threads/user-123/events/stream", cookie)).status).toBe(200);
    f.revoke();
    for (const path of ["/session", "/v1/metadata", "/v1/actors/123/threads/stream", "/v1/actors/123/threads/user-123/events/stream"])
      expect((await f.call(path, cookie)).status).toBe(401);
  });
  test("all native mutations and unknown paths fail without a production request", async () => {
    const f = fixture(), cookie = await f.login(), before = f.requests.length;
    for (const method of ["PUT", "POST", "DELETE", "PATCH"])
      for (const path of ["/v1/definitions", "/v1/actors/123", "/v1/actors/123/threads/user-123/events", "/v1/actors/123/threads/user-123/methods/message/calls/new", "/api/control/wake"])
        expect((await f.call(path, cookie, { method })).status).toBe(405);
    expect((await f.call("/api/control/export", cookie)).status).toBe(404);
    expect(f.requests).toHaveLength(before);
  });
  test("event pages and reconnects preserve the exact production sequence and payload", async () => {
    const f = fixture(), cookie = await f.login();
    const first = await f.call("/v1/actors/123/threads/user-123/events", cookie);
    expect(await first.json()).toEqual(f.rows.slice(0, 100));
    const resumed = await f.call("/v1/actors/123/threads/user-123/events/stream?after=100", cookie, { headers: { "last-event-id": "200" } });
    expect(resumed.headers.get("content-type")).toContain("text/event-stream");
    const body = await resumed.text();
    expect(body).toContain(`id: 201\ndata: ${JSON.stringify(f.rows[200]!.event)}`);
    expect(body).not.toContain("id: 200\n");
    expect(body).toContain("id: 205\n");
    expect(body).toContain("retry: 3000");
    const empty = await f.call("/v1/actors/123/threads/user-123/events?after=205", cookie);
    expect(await empty.json()).toEqual([]);
  });
  test("snapshot discovery is owner-bound and does not invent native children", async () => {
    const f = fixture(), cookie = await f.login();
    const response = await f.call("/v1/actors/123/threads/stream", cookie);
    expect(await response.text()).toContain('data: {"type":"ThreadsSnapshot","threads":[{"id":"user-123","depth":0}]}');
    expect(f.requests.at(-1)!.method).toBe("GET");
  });
  test("query smuggling, unsafe cursors and private upstream errors fail safely", async () => {
    const f = fixture(), cookie = await f.login(), before = f.requests.length;
    for (const suffix of ["?after=-1", "?limit=0", "?limit=101", "?after=1&after=2", "?account=456", "?after=9007199254740992"])
      expect((await f.call("/v1/actors/123/threads/user-123/events" + suffix, cookie)).status).toBe(400);
    expect((await f.call("/?actor=123&api=https://attacker.example.test", cookie)).status).toBe(400);
    expect(f.requests).toHaveLength(before);
    f.fail();
    const response = await f.call("/v1/metadata", cookie);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("provider details");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test("cross-origin reads, redirects and malformed upstream pages cannot leak data", async () => {
    const f = fixture(), cookie = await f.login(), before = f.requests.length;
    expect((await f.call("/v1/metadata", cookie, { headers: { origin: "https://attacker.example.test" } })).status).toBe(403);
    expect(f.requests).toHaveLength(before);
    const upstreamRequests: Request[] = [];
    f.env.AIKO_PRODUCTION.fetch = async request => {
      upstreamRequests.push(request);
      return new Response(null, { status: 302, headers: { location: "https://attacker.example.test/collect" } });
    };
    expect((await f.call("/v1/metadata", cookie)).status).toBe(503);
    expect(upstreamRequests[0]!.redirect).toBe("manual");
    expect(upstreamRequests).toHaveLength(1);
    f.env.AIKO_PRODUCTION.fetch = async () => Response.json({ thread: "user-456", events: f.rows.slice(0, 1), nextAfter: 1, hasMore: false });
    const response = await f.call("/v1/actors/123/threads/user-123/events", cookie);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("Production row");
  });
  test("sign-out clears the cookie without any production side effect", async () => {
    const f = fixture(), cookie = await f.login(), before = f.requests.length;
    const response = await f.call("/logout", cookie, { method: "POST", headers: { origin } });
    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(f.requests).toHaveLength(before);
  });
});

test("sessions reject tampering, host changes, expiry and duplicate cookies", async () => {
  const now = Date.now(), value = await sealVoyagerSession(key, origin, token, now);
  const cookie = voyagerCookie(value);
  const request = (host = origin, text = cookie) => new Request(host, { headers: { cookie: text } });
  expect((await openVoyagerSession(key, request(), now))?.token).toBe(token);
  expect(await openVoyagerSession(key, request(), now + SESSION_SECONDS * 1000)).toBeUndefined();
  expect(await openVoyagerSession(key, request("https://another.example.test"), now)).toBeUndefined();
  expect(await openVoyagerSession(key, request(origin, cookie.replace(value, value.slice(0, -6) + "xxxxxx")), now)).toBeUndefined();
  expect(await openVoyagerSession(key, request(origin, cookie + `; ${VOYAGER_COOKIE}=${value}`), now)).toBeUndefined();
});
