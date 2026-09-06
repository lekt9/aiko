import { describe, it, expect, vi } from "vitest";
import { createUnlockClient, UnlockError } from "../packages/sdk/src/index";
import {
  createRuntimeClient,
  createSessionBridge,
  type SessionMaterial,
  type SessionCookie,
} from "../packages/sdk/src/runtime";
import { createDemoService } from "../apps/web/src/server/demo";
const baseUrl = "http://127.0.0.1:4173/api";
function setup() {
  const handler = createDemoService();
  const transport: typeof fetch = (url, options) =>
    handler(new Request(url, options));
  return {
    api: createUnlockClient({ baseUrl, transport }),
    runtime: createRuntimeClient({ baseUrl, transport }),
    transport,
  };
}
const binding = { connectionId: "github", profileId: "builder" };
describe("management API and strict fixture boundary", () => {
  it("returns derived metadata without cookie material", async () => {
    const { api } = setup();
    const data = await api.workspace();
    expect(data.connections).toHaveLength(4);
    expect(data.profiles).toHaveLength(3);
    expect(JSON.stringify(data)).not.toContain("synthetic-not-a-real-session");
    expect(JSON.stringify(data)).not.toContain('"cookies"');
    expect(await api.sessions.list()).toHaveLength(4);
  });
  it.each(["native", "session", "import", "reference", "sso"] as const)(
    "connects a %s fixture and assigns standing access",
    async (mode) => {
      const { api } = setup();
      const c = await api.connections.connect({
        fixture: "vercel",
        mode,
        profileIds: ["builder"],
      });
      expect(c.revision).toBe(1);
      expect(c.domain).toBe("vercel.example.test");
      expect((await api.profiles.list())[0].connectionIds).toContain(c.id);
      expect(c.sourceMode).toBe(
        (
          {
            native: "native",
            session: "native",
            import: "snapshot",
            reference: "reference",
            sso: "sso",
          } as const
        )[mode],
      );
    },
  );
  it("rejects duplicates with a stable error", async () => {
    const { api } = setup();
    await expect(
      api.connections.connect({
        fixture: "github",
        mode: "native",
        profileIds: [],
      }),
    ).rejects.toMatchObject({ code: "DUPLICATE", status: 409 });
  });
  it("rejects arbitrary secret-bearing fields and unknown fixtures without reflecting them", async () => {
    const { transport } = setup();
    const result = await transport(`${baseUrl}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fixture: "vercel",
        mode: "native",
        profileIds: [],
        password: "DO-NOT-REFLECT",
      }),
    });
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain("DO-NOT-REFLECT");
  });
  it("validates all assignments before creating a connection", async () => {
    const { api } = setup();
    await expect(
      api.connections.connect({
        fixture: "vercel",
        mode: "native",
        profileIds: ["unknown"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await api.connections.list()).toHaveLength(4);
  });
  it("renews atomically and refuses a challenge until recovery", async () => {
    const { api } = setup();
    const c = await api.connections.action("github", "refresh");
    expect(c.revision).toBe(25);
    await api.connections.action("github", "challenge");
    await expect(
      api.connections.action("github", "refresh"),
    ).rejects.toMatchObject({ code: "CHALLENGE" });
    await api.connections.action("github", "pause");
    await expect(
      api.connections.action("github", "resume"),
    ).rejects.toMatchObject({ code: "CHALLENGE" });
    expect((await api.connections.action("github", "recover")).revision).toBe(
      26,
    );
  });
  it("pauses maintenance without revoking an unexpired runtime session", async () => {
    const { api, runtime } = setup();
    await api.connections.action("github", "pause");
    expect((await runtime.retrieve(binding)).revision).toBe(24);
  });
  it("blocks disconnected sources, leaves imports independent, and requires recovery on reconnect", async () => {
    const { api } = setup();
    await api.sources.update("onepassword", false);
    expect(
      (await api.connections.list()).find((c) => c.id === "github")?.status,
    ).toBe("source-unavailable");
    expect(
      (await api.connections.list()).find((c) => c.id === "figma")?.status,
    ).toBe("healthy");
    await expect(
      api.connections.action("github", "refresh"),
    ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    await api.sources.update("onepassword", true);
    expect(
      (await api.connections.list()).find((c) => c.id === "github")?.status,
    ).toBe("challenge");
    await api.connections.action("github", "recover");
  });
  it("never reconnects an unimplemented provider", async () => {
    await expect(
      setup().api.sources.update("nordpass", true),
    ).rejects.toMatchObject({ code: "DEMO_ONLY" });
  });
  it("revocation strips assignments and blocks future retrieval and sync", async () => {
    const { api, runtime } = setup();
    const m = await runtime.retrieve(binding);
    await api.connections.action("github", "revoke");
    expect((await api.profiles.list())[0].connectionIds).not.toContain(
      "github",
    );
    await expect(runtime.retrieve(binding)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(runtime.sync(m)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      api.connections.action("github", "recover"),
    ).rejects.toMatchObject({ code: "REVOKED" });
  });
  it("creates, renames, assigns and disables a profile", async () => {
    const { api, runtime } = setup();
    const p = await api.profiles.create({
      name: "Release agent",
      description: "Release operations",
    });
    expect(p.connectionIds).toEqual([]);
    await api.profiles.update(p.id, {
      name: "Release runner",
      connectionIds: ["github", "github"],
    });
    expect(
      (await api.profiles.list()).find((x) => x.id === p.id)?.connectionIds,
    ).toEqual(["github"]);
    await runtime.retrieve({ connectionId: "github", profileId: p.id });
    await api.profiles.update(p.id, { enabled: false });
    await expect(
      runtime.retrieve({ connectionId: "github", profileId: p.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each([
    "http://example.com/callback",
    "javascript:alert(1)",
    "https://example.com/#token",
    "https://user:pass@example.com/callback",
    "https://example.com/callback?token=abc",
  ])("rejects unsafe redirect %s", async (redirectUri) => {
    await expect(
      setup().api.clients.create({
        name: "Runner",
        redirectUri,
        profileId: "builder",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("registers validated demo OAuth config without issuing a credential", async () => {
    const client = await setup().api.clients.create({
      name: "Runner",
      redirectUri: "http://127.0.0.1:8787/callback",
      profileId: "builder",
    });
    expect(client.id).toMatch(/^demo_client_/);
    expect(client).not.toHaveProperty("secret");
    expect(client).not.toHaveProperty("token");
  });
  it("persists settings within the service and explicitly resets", async () => {
    const { api } = setup();
    await api.settings.update({ name: "New studio", digest: false });
    expect((await api.workspace()).settings.name).toBe("New studio");
    expect((await api.reset()).settings.name).toBe("Studio workspace");
  });
  it("rejects cross-origin writes and non-loopback hosts", async () => {
    const service = createDemoService();
    expect(
      (
        await service(
          new Request(`${baseUrl}/reset`, {
            method: "POST",
            headers: {
              origin: "https://attacker.example",
              "content-type": "application/json",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await service(new Request("http://public.example/api/workspace")))
        .status,
    ).toBe(403);
  });
});
describe("seeded profile editing", () => {
  it("accepts the existing punctuation when the full edit form is saved", async () => {
    const { api } = setup();
    const original = (await api.profiles.list())[0];
    expect(original.description).toContain(",");
    const result = await api.profiles.update(original.id, {
      name: "Build worker",
      description: original.description,
      enabled: false,
      connectionIds: [...original.connectionIds, "notion"],
    });
    expect(result.name).toBe("Build worker");
    expect(result.enabled).toBe(false);
    expect(result.connectionIds).toContain("notion");
  });
});
describe("bounded demo routing", () => {
  it("does not accept extra path segments for write endpoints", async () => {
    const { transport } = setup();
    for (const path of [
      "reset/extra",
      "clients/extra",
      "runtime/session/extra",
    ]) {
      const response = await transport(`${baseUrl}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(404);
    }
  });
  it("bounds profile growth until an explicit reset", async () => {
    const { api } = setup();
    for (let i = 0; i < 47; i++)
      await api.profiles.create({
        name: `Runner ${i}`,
        description: "Demo runner",
      });
    await expect(
      api.profiles.create({ name: "Overflow", description: "Demo runner" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await api.profiles.list()).toHaveLength(50);
    expect((await api.reset()).profiles).toHaveLength(3);
  });
});
describe("trusted runtime bridge", () => {
  function fixtureBrowser() {
    let cookies: SessionCookie[] = [];
    return {
      replaceCookies: vi.fn(async (next: SessionCookie[]) => {
        cookies = structuredClone(next);
      }),
      exportCookies: vi.fn(async () => structuredClone(cookies)),
    };
  }
  it("hydrates once, serializes concurrent calls and synchronizes versions", async () => {
    const { runtime } = setup();
    const browser = fixtureBrowser();
    const bridge = createSessionBridge(runtime, browser, binding);
    await Promise.all([bridge.initialize(), bridge.initialize()]);
    expect(browser.replaceCookies).toHaveBeenCalledTimes(1);
    const versions = await Promise.all([bridge.sync(), bridge.sync()]);
    expect(versions.map((x) => x.revision)).toEqual([25, 26]);
    expect(await bridge.initialize()).toEqual({ revision: 26 });
    expect(browser.replaceCookies).toHaveBeenCalledTimes(1);
    await bridge.recover();
    expect(browser.replaceCookies).toHaveBeenCalledTimes(2);
  });
  it("fails a stale sync instead of overwriting a renewal and supports explicit recovery", async () => {
    const { api, runtime } = setup();
    const bridge = createSessionBridge(runtime, fixtureBrowser(), binding);
    await bridge.initialize();
    await api.connections.action("github", "refresh");
    await expect(bridge.sync()).rejects.toMatchObject({ code: "CONFLICT" });
    await bridge.recover();
    expect(await bridge.sync()).toEqual({ revision: 26 });
  });
  it("rejects an unbound profile", async () => {
    await expect(
      setup().runtime.retrieve({
        connectionId: "github",
        profileId: "research",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects cookie scope escalation before browser import", async () => {
    const { runtime } = setup();
    const m = await runtime.retrieve(binding);
    m.cookies[0].domain = "google.com";
    const bad = { retrieve: async () => m, sync: runtime.sync };
    const browser = fixtureBrowser();
    await expect(
      createSessionBridge(bad, browser, binding).initialize(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(browser.replaceCookies).not.toHaveBeenCalled();
  });
  it("rejects a mismatched binding before browser import", async () => {
    const { runtime } = setup();
    const m = await runtime.retrieve(binding);
    m.profileId = "another";
    await expect(
      createSessionBridge(
        { ...runtime, retrieve: async () => m },
        fixtureBrowser(),
        binding,
      ).initialize(),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects arbitrary cookie values at the synthetic API", async () => {
    const { runtime } = setup();
    const m = await runtime.retrieve(binding);
    m.cookies[0].value = "not-a-fixture";
    await expect(runtime.sync(m)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
  it("requires initialization before sync", async () => {
    const { runtime } = setup();
    await expect(
      createSessionBridge(runtime, fixtureBrowser(), binding).sync(),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
describe("transport", () => {
  it("resolves token provider for every request and never retries writes", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('{"error":{"code":"CONFLICT"}}', { status: 409 }),
      );
    const token = vi.fn().mockResolvedValue("synthetic-test-token");
    const api = createUnlockClient({ baseUrl, transport, token });
    await expect(
      api.connections.action("github", "refresh"),
    ).rejects.toBeInstanceOf(UnlockError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledTimes(1);
    expect(
      new Headers(transport.mock.calls[0][1]?.headers).get("Authorization"),
    ).toBe("Bearer synthetic-test-token");
    expect(transport.mock.calls[0][1]?.redirect).toBe("error");
  });
  it("does not echo response bodies, arbitrary error codes, or transport errors", async () => {
    const api = createUnlockClient({
      baseUrl,
      transport: async () =>
        new Response('{"error":{"code":"LEAK-ME"},"token":"SECRET"}', {
          status: 500,
        }),
    });
    await expect(api.workspace()).rejects.toMatchObject({
      code: "HTTP_ERROR",
      message: "Unlock request failed.",
    });
    const bad = createUnlockClient({
      baseUrl,
      transport: async () => {
        throw new Error("DO-NOT-LOG");
      },
    });
    await expect(bad.workspace()).rejects.toMatchObject({
      code: "NETWORK_ERROR",
      message: "Unable to reach Unlock.",
    });
  });
  it("bounds slow token resolution with a timeout", async () => {
    const api = createUnlockClient({
      baseUrl,
      timeoutMs: 10,
      token: () => new Promise(() => {}),
    });
    await expect(api.workspace()).rejects.toMatchObject({ code: "TIMEOUT" });
  });
  it("cancels without sending a pre-aborted request", async () => {
    const transport = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      createUnlockClient({ baseUrl, transport }).workspace({
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("cancels an in-flight request even when a custom transport ignores signal", async () => {
    const controller = new AbortController();
    const api = createUnlockClient({
      baseUrl,
      transport: () => new Promise(() => {}),
    });
    const pending = api.workspace({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });
  it("reports malformed success responses safely", async () => {
    await expect(
      createUnlockClient({
        baseUrl,
        transport: async () => new Response("not-json"),
      }).workspace(),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
