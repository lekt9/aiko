import { afterAll, beforeAll, describe, it, expect } from "vitest";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { OwnerAuth } from "../../apps/server/src/owner-auth.js";
import { OAuth } from "../../apps/server/src/oauth.js";
import { createHttpServer } from "../../apps/server/src/api.js";
import { createVaultClient } from "../../packages/sdk/src/vault.js";
import { createVaultOwner } from "../../packages/sdk/src/owner.js";
import { createVaultAgent } from "../../packages/sdk/src/agent.js";
import {
  createAgentOAuth,
  MemoryTokenStore,
} from "../../packages/sdk/src/oauth.js";
import { oidcAdapter } from "../../apps/server/src/oidc-adapter.js";
import {
  database,
  enabled,
  fixture,
  input,
  cookie,
  secret,
} from "./helpers.js";
import {
  HttpBrowser,
  close,
  freePort,
  mockIdentityProvider,
  signingKeys,
} from "./http-helpers.js";
describe.runIf(enabled)("real HTTP, owner OIDC, agent OAuth and SDK", () => {
  let pg: Awaited<ReturnType<typeof database>>,
    f: Awaited<ReturnType<typeof fixture>>,
    idp: Awaited<ReturnType<typeof mockIdentityProvider>>,
    server: Server,
    origin: string,
    owner: OwnerAuth,
    oauth: OAuth,
    browser: HttpBrowser,
    csrf: string;
  beforeAll(async () => {
    pg = await database();
    f = await fixture(pg.db);
    idp = await mockIdentityProvider();
    origin = (await freePort()).origin;
    owner = new OwnerAuth(f.vault, origin, {
      issuer: idp.issuer,
      clientId: "owner-ui",
      allowedSubjects: ["owner-sub"],
      allowLocalHttp: true,
    });
    oauth = new OAuth(
      f.vault,
      owner,
      origin,
      { keys: [signingKeys().privateJwk] },
      [randomBytes(32).toString("hex")],
    );
    server = createHttpServer(f.vault, owner, oauth, f.runtime, f.worker);
    await new Promise<void>((r) =>
      server.listen(Number(new URL(origin).port), "127.0.0.1", r),
    );
    browser = new HttpBrowser();
    expect((await browser.follow(origin + "/auth/login")).status).toBe(200);
    const me = await (await browser.request(origin + "/v1/me")).json();
    csrf = me.csrf;
    expect(typeof csrf).toBe("string");
  }, 30000);
  afterAll(async () => {
    if (server) await close(server);
    if (idp) await close(idp.server);
    await pg?.close();
  });
  const options = () => ({
    baseUrl: origin + "/v1",
    csrf,
    transport: async (url: RequestInfo | URL, init?: RequestInit) =>
      browser.request(String(url), init),
  });
  async function ownerFixture() {
    const management = createVaultClient(options()),
      trusted = createVaultOwner(options()),
      connection = await trusted.add(input),
      profile = await management.profiles.create({ name: "HTTP agent" });
    await management.profiles.assign(profile.id, [connection.id]);
    const client = await management.clients.create({
      name: "HTTP runtime",
      profileId: profile.id,
      connectionIds: [connection.id],
      redirectUris: ["http://127.0.0.1:4949/callback"],
    });
    return { management, trusted, connection, profile, client };
  }
  async function grant(clientId: string, store = new MemoryTokenStore()) {
    const agentOAuth = createAgentOAuth({
        issuer: origin + "/oauth",
        clientId,
        redirectUri: "http://127.0.0.1:4949/callback",
        allowLocalHttp: true,
        store,
      }),
      { url } = await agentOAuth.begin();
    let location = url;
    for (let i = 0; i < 10; i++) {
      const result = await browser.request(location);
      if (result.status >= 300 && result.status < 400) {
        const next = new URL(result.headers.get("location")!, location).href;
        if (next.startsWith("http://127.0.0.1:4949/callback"))
          return { agentOAuth, callback: next };
        location = next;
        continue;
      }
      expect(result.status, new URL(location).pathname).toBe(200);
      const html = await result.text(),
        token = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
      expect(token).toBeTruthy();
      const accepted = await browser.request(location, {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: token!, decision: "approve" }),
      });
      expect(accepted.status).toBe(303);
      location = new URL(accepted.headers.get("location")!, location).href;
    }
    throw new Error("Agent authorization did not finish");
  }
  it("publishes discovery with PKCE and protected-resource metadata; refuses unauthenticated owner APIs", async () => {
    const data = await (
      await fetch(origin + "/oauth/.well-known/openid-configuration")
    ).json();
    expect(data.issuer).toBe(origin + "/oauth");
    expect(data.code_challenge_methods_supported).toEqual(["S256"]);
    expect(
      (await fetch(origin + "/.well-known/oauth-protected-resource")).status,
    ).toBe(200);
    expect(
      (await fetch(origin + "/.well-known/oauth-authorization-server/oauth"))
        .status,
    ).toBe(200);
    expect((await fetch(origin + "/v1/connections")).status).toBe(401);
    expect((await fetch(origin + "/v1/runtime/connections")).status).toBe(401);
  });
  it("authenticates owner through upstream signature, nonce, state and PKCE checks", async () => {
    expect((await createVaultClient(options()).me()).tenantId).toBeTruthy();
    idp.setBadNonce(true);
    const b = new HttpBrowser();
    expect((await b.follow(origin + "/auth/login")).status).toBe(503);
    expect((await b.request(origin + "/v1/me")).status).toBe(401);
    idp.setBadNonce(false);
    idp.setSubject("not-in-owner-allowlist");
    expect(
      (await new HttpBrowser().follow(origin + "/auth/login")).status,
    ).toBe(403);
    idp.setSubject("owner-sub");
  });
  it("binds owner authorization state to the initiating browser and rejects open redirects", async () => {
    const b = new HttpBrowser(),
      start = await b.request(origin + "/auth/login"),
      upstream = await b.request(start.headers.get("location")!),
      callback = upstream.headers.get("location")!;
    expect((await new HttpBrowser().request(callback)).status).toBe(401);
    expect((await b.request(callback)).status).toBe(302);
    expect((await b.request(callback)).status).toBe(401);
    expect(
      (await browser.request(origin + "/auth/login?returnTo=https://evil.test"))
        .status,
    ).toBe(400);
  });
  it("requires same-origin CSRF for writes and redacts malformed/unknown inputs", async () => {
    for (const headers of [
      {},
      { Origin: "https://evil.test", "X-Unlock-CSRF": csrf },
      { Origin: origin, "X-Unlock-CSRF": "wrong" },
    ] as Record<string, string>[])
      expect(
        (
          await browser.request(origin + "/v1/profiles", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: '{"name":"Denied"}',
          })
        ).status,
      ).toBe(403);
    const invalid = await browser.request(origin + "/v1/owner/connections", {
      method: "POST",
      headers: {
        Origin: origin,
        "X-Unlock-CSRF": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...input, unexpected: secret }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain(secret);
  });
  it("implements owner SDK CRUD and encrypted, password-bearing CSV imports over HTTP", async () => {
    const { management, trusted, connection } = await ownerFixture();
    expect(await trusted.revealPassword(connection.id)).toEqual({
      password: secret,
    });
    expect(JSON.stringify(await management.connections.list())).not.toContain(
      secret,
    );
    const preview = await trusted.importCsv.preview({
      csv: `name,url,username,password\nImported,https://imported.test,http-user,${secret}`,
    });
    expect(JSON.stringify(preview)).not.toContain(secret);
    const result = await trusted.importCsv.commit(preview.id, [2]);
    expect(result.imported).toBe(1);
    expect(await trusted.revealPassword(result.connectionIds[0])).toEqual({
      password: secret,
    });
    expect(await trusted.importCsv.commit(preview.id, [2])).toEqual(result);
    await management.connections.delete(result.connectionIds[0]);
  });
  it("requires owner auth and CSRF for browser commits, never accepts runtime authority or raw verification flags", async () => {
    const { trusted, connection, profile, client } = await ownerFixture();
    const path =
      origin + "/v1/owner/connections/" + connection.id + "/browser-login";
    const login = {
      profileId: profile.id,
      runtimeId: client.id,
      version: connection.version,
      identity: connection.identity,
      credential: { password: "SYNTHETIC-BROWSER-PASSWORD" },
      cookies: [cookie()],
    };
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(login),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await browser.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: origin },
          body: JSON.stringify(login),
        })
      ).status,
    ).toBe(403);
    const { agentOAuth, callback } = await grant(client.id);
    await agentOAuth.finish(callback);
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            Authorization: "Bearer " + (await agentOAuth.accessToken()),
          },
          body: JSON.stringify(login),
        })
      ).status,
    ).toBe(401);
    const untrusted = await browser.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: origin,
        "X-Unlock-CSRF": csrf,
      },
      body: JSON.stringify({ ...login, verified: true }),
    });
    expect(untrusted.status).toBe(400);
    expect(await untrusted.text()).not.toContain(login.credential.password);
    const receipt = await trusted.completeBrowserLogin(connection.id, login);
    expect(receipt).toMatchObject({
      version: connection.version + 1,
      revision: 1,
    });
    expect(Object.keys(receipt).sort()).toEqual([
      "expiresAt",
      "revision",
      "version",
    ]);
    expect(await trusted.revealPassword(connection.id)).toEqual(
      login.credential,
    );
  });
  it("authorizes agents once, rejects code replay, binds tokens and revokes future access immediately", async () => {
    const { management, trusted, connection, profile, client } =
        await ownerFixture(),
      { agentOAuth, callback } = await grant(client.id);
    expect(await agentOAuth.finish(callback)).toEqual({ authorized: true });
    await expect(agentOAuth.finish(callback)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const token = await agentOAuth.accessToken(),
      agent = createVaultAgent({
        baseUrl: origin + "/v1",
        token: agentOAuth.accessToken,
      });
    expect((await agent.connections()).map((c) => c.id)).toEqual([
      connection.id,
    ]);
    expect(
      (
        await fetch(origin + "/v1/connections", {
          headers: { Authorization: "Bearer " + token },
        })
      ).status,
    ).toBe(401);
    await trusted.importSession(connection.id, {
      profileId: profile.id,
      runtimeId: client.id,
      cookies: [cookie()],
    });
    expect((await agent.retrieve(connection.id)).revision).toBe(1);
    expect(
      await agent.sync(connection.id, { revision: 1, cookies: [cookie()] }),
    ).toMatchObject({ revision: 2 });
    await expect(
      agent.sync(connection.id, { revision: 1, cookies: [cookie()] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(agent.retrieve(f.connection.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await management.clients.revoke(client.id);
    await expect(agent.connections()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
  it("exposes metadata-only runtime status and revokes via the real OAuth principal", async () => {
    const { trusted, connection, profile, client } = await ownerFixture();
    const { agentOAuth, callback } = await grant(client.id);
    await agentOAuth.finish(callback);
    const headers = {
      Authorization: "Bearer " + (await agentOAuth.accessToken()),
      "Content-Type": "application/json",
    };
    const path = origin + "/v1/runtime/connections/" + connection.id;
    expect((await fetch(path + "/status")).status).toBe(401);
    expect((await fetch(path + "/session", { method: "DELETE" })).status).toBe(
      401,
    );
    expect(
      await (await fetch(path + "/status", { headers })).json(),
    ).toMatchObject({ verified: false });
    await trusted.importSession(connection.id, {
      profileId: profile.id,
      runtimeId: client.id,
      cookies: [cookie()],
    });
    const response = await fetch(path + "/status", { headers });
    expect(response.status).toBe(200);
    const metadata = await response.json();
    expect(Object.keys(metadata).sort()).toEqual([
      "allowedDomains",
      "connectionId",
      "expiresAt",
      "profileId",
      "renewable",
      "revision",
      "runtimeId",
      "tenantId",
      "verified",
    ]);
    expect(metadata).toMatchObject({
      runtimeId: client.id,
      profileId: profile.id,
      connectionId: connection.id,
      allowedDomains: ["service.test"],
      verified: true,
      revision: 1,
    });
    expect(JSON.stringify(metadata)).not.toContain("verified-alice");
    expect(
      (await fetch(path + "/session", { method: "DELETE", headers })).status,
    ).toBe(204);
    expect(
      await (await fetch(path + "/status", { headers })).json(),
    ).toMatchObject({ verified: false });
    expect((await fetch(path + "/session", { headers })).status).toBe(409);
  });
  it("rotates refresh tokens and keeps token IDs encrypted/hashed in PostgreSQL", async () => {
    const { client } = await ownerFixture(),
      store = new MemoryTokenStore(),
      { agentOAuth, callback } = await grant(client.id, store);
    await agentOAuth.finish(callback);
    let oldRefresh = "";
    await store.withLock(async (state, save) => {
      oldRefresh = state.tokens!.refreshToken!;
      expect(oldRefresh).toBeTruthy();
      await save({ ...state, tokens: { ...state.tokens!, expiresAt: 0 } });
    });
    await Promise.all([agentOAuth.accessToken(), agentOAuth.accessToken()]);
    await store.withLock(async (state) => {
      expect(state.tokens!.refreshToken === oldRefresh).toBe(false);
    });
    const rows = await pg.db.query("SELECT * FROM oidc_objects");
    expect(JSON.stringify(rows.rows)).not.toContain(oldRefresh);
    const replay = await fetch(origin + "/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.id,
        refresh_token: oldRefresh,
        resource: origin + "/v1",
      }),
    });
    expect(replay.status).toBe(400);
    const token = await agentOAuth.accessToken();
    await expect(oauth.authenticate(token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
  it("rejects incorrect PKCE and actual HTTP authorization-code replay", async () => {
    const first = await ownerFixture(),
      firstStore = new MemoryTokenStore(),
      firstFlow = await grant(first.client.id, firstStore);
    const bad = await fetch(origin + "/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: first.client.id,
        code: new URL(firstFlow.callback).searchParams.get("code")!,
        code_verifier: "x".repeat(64),
        redirect_uri: "http://127.0.0.1:4949/callback",
        resource: origin + "/v1",
      }),
    });
    expect(bad.status).toBe(400);
    const second = await ownerFixture(),
      store = new MemoryTokenStore(),
      flow = await grant(second.client.id, store);
    const verifier = await store.withLock(
      async (state) => state.pending!.verifier,
    );
    await flow.agentOAuth.finish(flow.callback);
    const replay = await fetch(origin + "/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: second.client.id,
        code: new URL(flow.callback).searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: "http://127.0.0.1:4949/callback",
        resource: origin + "/v1",
      }),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
  }, 20000);
  it("uses an atomic authorization-code consumption gate under concurrency", async () => {
    const Adapter = oidcAdapter(f.vault),
      adapter = new Adapter("AuthorizationCode");
    await adapter.upsert("synthetic-code", { jti: "synthetic-code" }, 60);
    const results = await Promise.allSettled([
      adapter.consume("synthetic-code"),
      adapter.consume("synthetic-code"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await adapter.find("synthetic-code")).toHaveProperty("consumed");
  });
  it("requires recent owner authentication for secret-bearing endpoints but not metadata", async () => {
    const { connection } = await ownerFixture(),
      session = await owner.session(await browser.jar.getCookieString(origin));
    await pg.db.query("UPDATE owner_sessions SET expires_at=$2 WHERE hash=$1", [
      session!.hash,
      Date.now() + 7 * 3600_000,
    ]);
    expect((await browser.request(origin + "/v1/connections")).status).toBe(
      200,
    );
    await expect(
      createVaultOwner(options()).revealPassword(connection.id),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await pg.db.query("UPDATE owner_sessions SET expires_at=$2 WHERE hash=$1", [
      session!.hash,
      Date.now() + 8 * 3600_000,
    ]);
  });
});
