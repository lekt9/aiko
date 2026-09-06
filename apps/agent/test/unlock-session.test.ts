import { describe, expect, test } from "bun:test";
import { ensureUnlockSession, retrieveUnlockSession } from "../src/unlock-session.ts";

const CONNECTION_ID = "c0000000-0000-4000-8000-000000000001";
const JOB_ID = "00000000-0000-4000-8000-000000000009";
const ORIGIN = "https://vendor.com";
const PREFIX = "https://vault.example.com/v1/runtime/connections";
const CONFIG = {
  origin: "https://vault.example.com",
  accounts: {
    "123": {
      token: "runtime-token-1234567890",
      tenantId: "tenant-1",
      profileId: "profile-1",
      runtimeId: "runtime-1",
      connections: { "vendor.com": CONNECTION_ID },
    },
  },
};
const SEARCH = async () => ({ status: "absent" as const, fallbackAllowed: true, connectors: [], message: "No match." });
const SIGNAL = new AbortController().signal;
const COOKIE = {
  name: "sid", value: "fresh-session-value", domain: ".vendor.com", path: "/",
  expires: -1, secure: true, httpOnly: true, sameSite: "Lax" as const, hostOnly: false,
};

/** Fake vault runtime API. `verified` flips when the renewal is accepted. */
function vaultHarness(input: { initialVerified?: boolean; renewable?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let verified = input.initialVerified ?? false;
  const renewable = input.renewable ?? true;
  const transport = (async (target: RequestInfo | URL, init?: RequestInit) => {
    const url = String(target);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ url, method, body });
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (method === "POST" && url === `${PREFIX}/${CONNECTION_ID}/renew`) {
      verified = true;
      return json({ id: JOB_ID }, 202);
    }
    if (method === "GET" && url === `${PREFIX}/${CONNECTION_ID}/status`) {
      return json({
        tenantId: "tenant-1", profileId: "00000000-0000-4000-8000-000000000002", runtimeId: "00000000-0000-4000-8000-000000000003", connectionId: CONNECTION_ID,
        allowedDomains: ["vendor.com"], verified, revision: verified ? 3 : 1,
        expiresAt: Date.now() + 60000, renewable: !verified && renewable,
      });
    }
    if (method === "GET" && url === `${PREFIX}/${CONNECTION_ID}/session`) {
      return json({
        connectionId: CONNECTION_ID, profileId: "00000000-0000-4000-8000-000000000002", runtimeId: "00000000-0000-4000-8000-000000000003", revision: 3,
        allowedDomains: ["vendor.com"], expiresAt: Date.now() + 60000, cookies: [COOKIE],
      });
    }
    return json({ error: { code: "NOT_FOUND" } }, 404);
  }) as typeof fetch;
  const allow = new Set([`${PREFIX}:GET`, `${PREFIX}/${CONNECTION_ID}/status:GET`, `${PREFIX}/${CONNECTION_ID}/session:GET`, `${PREFIX}/${CONNECTION_ID}/renew:POST`]);
  return { calls, transport, allow };
}

describe("ensureUnlockSession", () => {
  test("renews an expired renewable session via the stored password server-side, then retrieves it", async () => {
    const vault = vaultHarness();
    const grant = await ensureUnlockSession({
      owner: "123", origin: ORIGIN, config: CONFIG, search: SEARCH, signal: SIGNAL, transport: vault.transport, renew: true,
    });
    expect(grant).toMatchObject({ connectionId: CONNECTION_ID, revision: "3", domains: ["vendor.com"], renewed: true });
    expect(grant?.cookies).toHaveLength(1);
    expect(vault.calls.some(c => c.method === "POST" && c.url === `${PREFIX}/${CONNECTION_ID}/renew` && c.body === "{}")).toBe(true);
    for (const call of vault.calls) expect(vault.allow.has(`${call.url}:${call.method}`)).toBe(true);
  });

  test("a healthy verified session is retrieved without renewal", async () => {
    const vault = vaultHarness({ initialVerified: true });
    const grant = await ensureUnlockSession({
      owner: "123", origin: ORIGIN, config: CONFIG, search: SEARCH, signal: SIGNAL, transport: vault.transport, renew: true,
    });
    expect(grant).toMatchObject({ connectionId: CONNECTION_ID, revision: "3" });
    expect(grant?.renewed ?? false).toBe(false);
    expect(vault.calls.some(c => c.method === "POST")).toBe(false);
  });

  test("fail closed: a non-renewable unverified session returns undefined without renewal", async () => {
    const vault = vaultHarness({ renewable: false });
    const grant = await ensureUnlockSession({
      owner: "123", origin: ORIGIN, config: CONFIG, search: SEARCH, signal: SIGNAL, transport: vault.transport, renew: true,
    });
    expect(grant).toBeUndefined();
    expect(vault.calls.some(c => c.method === "POST")).toBe(false);
  });

  test("renewal stays opt-in: retrieval without renew never requests maintenance", async () => {
    const vault = vaultHarness();
    const grant = await retrieveUnlockSession({
      owner: "123", origin: ORIGIN, config: CONFIG, search: SEARCH, signal: SIGNAL, transport: vault.transport,
    });
    expect(grant).toBeUndefined();
    expect(vault.calls.some(c => c.method === "POST")).toBe(false);
  });

  test("only the status/session/renew surface is ever requested, never owner or password endpoints", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const transport = (async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = String(target);
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
      if (method === "GET" && url === `${PREFIX}/${CONNECTION_ID}/status`) {
        return json({
          tenantId: "tenant-1", profileId: "00000000-0000-4000-8000-000000000002", runtimeId: "00000000-0000-4000-8000-000000000003",
          connectionId: CONNECTION_ID, allowedDomains: ["vendor.com"], verified: true, revision: 3,
          expiresAt: Date.now() + 60000, renewable: false,
        });
      }
      if (method === "GET" && url === `${PREFIX}/${CONNECTION_ID}/session`) {
        return json({
          connectionId: CONNECTION_ID, profileId: "00000000-0000-4000-8000-000000000002", runtimeId: "00000000-0000-4000-8000-000000000003",
          revision: 3, allowedDomains: ["vendor.com"], expiresAt: Date.now() + 60000, cookies: [COOKIE],
        });
      }
      return json({ error: { code: "NOT_FOUND" } }, 404);
    }) as typeof fetch;
    const grant = await ensureUnlockSession({
      owner: "123", origin: ORIGIN, config: CONFIG, search: SEARCH, signal: SIGNAL, transport, renew: true,
    });
    expect(grant).toMatchObject({ connectionId: CONNECTION_ID, revision: "3" });
    const allow = new Set([`${PREFIX}/${CONNECTION_ID}/status:GET`, `${PREFIX}/${CONNECTION_ID}/session:GET`, `${PREFIX}/${CONNECTION_ID}/renew:POST`]);
    for (const call of calls) expect(allow.has(`${call.url}:${call.method}`)).toBe(true);
    // No owner plane, no passwords endpoint, no writes.
    expect(calls.some(c => !c.url.startsWith(`${PREFIX}/`) || c.method !== "GET")).toBe(false);
  });
});
