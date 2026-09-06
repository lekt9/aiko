import { it, describe, expect, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVaultBridge,
  wrapVaultTools,
  type VaultAgent,
} from "../../packages/sdk/src/agent.js";
import { createVaultClient } from "../../packages/sdk/src/vault.js";
import { createCdpCookieAdapter } from "../../packages/sdk/src/cdp.js";
import { EncryptedFileTokenStore } from "../../packages/sdk/src/oauth.js";
import { UnlockError } from "../../packages/sdk/src/transport.js";
import { cookie } from "./helpers.js";
function bridgeFixture() {
  const binding = {
      connectionId: randomUUID(),
      profileId: randomUUID(),
      runtimeId: randomUUID(),
      domains: ["service.test"],
    },
    material = {
      ...binding,
      allowedDomains: binding.domains,
      cookies: [cookie()],
      revision: 1,
      expiresAt: Date.now() + 300000,
    };
  const { domains: _domains, ...session } = material;
  let revision = 1,
    cookies = [cookie()];
  const client: VaultAgent = {
    connections: vi.fn(),
    requestRenewal: vi.fn(),
    retrieve: vi.fn(async () => ({ ...session, revision })),
    sync: vi.fn(async (_id, input) => {
      if (input.revision !== revision)
        throw new UnlockError("CONFLICT", 409, "Recover");
      revision++;
      return { revision };
    }),
  };
  const browser = {
      replaceCookies: vi.fn(async (value: ReturnType<typeof cookie>[]) => {
        cookies = structuredClone(value);
      }),
      exportCookies: vi.fn(async () => structuredClone(cookies)),
    },
    bridge = createVaultBridge(client, browser, binding);
  return { binding, client, browser, bridge, rotate: () => revision++ };
}
describe("production SDK boundaries", () => {
  it("hydrates once and delegates original tools exactly once without changing their results", async () => {
    const f = bridgeFixture(),
      click = vi.fn(async (value: string) => ({ text: "Clicked " + value })),
      tools = wrapVaultTools({ click }, f.bridge);
    const results = await Promise.all([tools.click("one"), tools.click("two")]);
    expect(results).toEqual([{ text: "Clicked one" }, { text: "Clicked two" }]);
    expect(click).toHaveBeenCalledTimes(2);
    expect(f.client.retrieve).toHaveBeenCalledTimes(1);
    expect(f.client.sync).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(results)).not.toContain("verified-alice");
    expect(f.bridge.status()).toEqual({ ready: true, revision: 3 });
  });
  it("does not replay a successful action when CAS sync fails and requires explicit recovery", async () => {
    const f = bridgeFixture(),
      action = vi.fn(async () => ({ ok: true })),
      observe = vi.fn();
    await f.bridge.initialize();
    f.rotate();
    expect(await f.bridge.run(action, observe)).toEqual({ ok: true });
    expect(observe).toHaveBeenCalledWith("CONFLICT");
    expect(f.bridge.status().ready).toBe(false);
    await expect(f.bridge.run(action)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(action).toHaveBeenCalledTimes(1);
    await f.bridge.recover();
    expect(await f.bridge.run(action)).toEqual({ ok: true });
  });
  it("blocks the browser after failed recovery and snapshots its immutable binding", async () => {
    const f = bridgeFixture(),
      original = f.binding.connectionId;
    f.binding.connectionId = randomUUID();
    await f.bridge.initialize();
    expect(f.client.retrieve).toHaveBeenLastCalledWith(original, undefined);
    vi.mocked(f.client.retrieve).mockRejectedValue(
      new UnlockError("REVOKED", 403, "Revoked"),
    );
    await expect(f.bridge.recover()).rejects.toMatchObject({ code: "REVOKED" });
    expect(f.bridge.status().ready).toBe(false);
    const action = vi.fn(async () => true);
    await expect(f.bridge.run(action)).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(action).not.toHaveBeenCalled();
  });
  it("stops before an action if its verified session lifetime expires", async () => {
    const f = bridgeFixture();
    await f.bridge.initialize();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
    try {
      const action = vi.fn(async () => true);
      await expect(f.bridge.run(action)).rejects.toMatchObject({
        code: "RECOVERY_REQUIRED",
      });
      expect(action).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
  it("syncs after a failed browser action without replacing its error", async () => {
    const f = bridgeFixture(),
      error = new Error("ordinary tool failure");
    await expect(
      f.bridge.run(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(f.client.sync).toHaveBeenCalledTimes(1);
  });
  it("rejects an unexpected profile/domain binding before importing cookies", async () => {
    const f = bridgeFixture();
    vi.mocked(f.client.retrieve).mockResolvedValue({
      ...(await f.client.retrieve(f.binding.connectionId)),
      profileId: randomUUID(),
    });
    await expect(f.bridge.initialize()).rejects.toMatchObject({
      code: "BINDING_MISMATCH",
    });
    expect(f.browser.replaceCookies).not.toHaveBeenCalled();
  });
  it("validates successful response shapes and redacts errors, oversized bodies and unsafe base URLs", async () => {
    const bad = createVaultClient({
      baseUrl: "https://vault.test/v1",
      transport: async () =>
        new Response(JSON.stringify({ password: "SYNTHETIC-RESPONSE-CANARY" })),
    });
    await expect(bad.connections.list()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: "Unlock returned an invalid response.",
    });
    const oversized = createVaultClient({
      baseUrl: "https://vault.test/v1",
      transport: async () => new Response("x".repeat(2_097_153)),
    });
    await expect(oversized.me()).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(() =>
      createVaultClient({ baseUrl: "http://public.test/v1" }),
    ).toThrow();
    expect(() =>
      createVaultClient({ baseUrl: "https://user:password@vault.test/v1" }),
    ).toThrow();
  });
  it("keeps OAuth token files encrypted and private across store instances", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlock-tokens-")),
      path = join(directory, "tokens"),
      key = randomBytes(32),
      first = new EncryptedFileTokenStore(path, key);
    try {
      await first.withLock(async (_state, save) =>
        save({
          tokens: {
            accessToken: "SYNTHETIC-ACCESS-CANARY",
            refreshToken: "SYNTHETIC-REFRESH-CANARY",
            expiresAt: 1,
          },
        }),
      );
      expect(
        (await readFile(path)).includes(Buffer.from("SYNTHETIC-ACCESS-CANARY")),
      ).toBe(false);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const second = new EncryptedFileTokenStore(path, key);
      expect(
        await second.withLock(async (state) => state.tokens?.expiresAt),
      ).toBe(1);
      await expect(
        new EncryptedFileTokenStore(path, randomBytes(32)).withLock(
          async () => true,
        ),
      ).rejects.toMatchObject({ code: "TOKEN_STORAGE" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("serializes independent file-store instances across a refresh-sized critical section", async () => {
    const directory = await mkdtemp(join(tmpdir(), "unlock-token-lock-")),
      path = join(directory, "tokens"),
      key = randomBytes(32),
      a = new EncryptedFileTokenStore(path, key),
      b = new EncryptedFileTokenStore(path, key);
    try {
      const order: string[] = [];
      let entered!: () => void;
      const started = new Promise<void>((r) => (entered = r)),
        first = a.withLock(async (_state, save) => {
          order.push("a");
          entered();
          await new Promise((r) => setTimeout(r, 100));
          await save({ binding: "written" });
          order.push("a-done");
        });
      await started;
      await Promise.all([
        first,
        b.withLock(async (state) => {
          order.push("b");
          expect(state.binding).toBe("written");
        }),
      ]);
      expect(order).toEqual(["a", "a-done", "b"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("requires isolated CDP contexts, preserves host-only/partition semantics and never clears unrelated domains", async () => {
    const sent: {
        method: string;
        params: Record<string, unknown>;
        session?: string;
      }[] = [],
      partition = {
        topLevelSite: "https://top.test",
        hasCrossSiteAncestor: true,
      },
      cdp = {
        async send(
          method: string,
          params: Record<string, unknown>,
          session?: string,
        ) {
          sent.push({ method, params, session });
          if (method === "Target.getTargetInfo")
            return { targetInfo: { browserContextId: "isolated" } };
          if (method === "Target.attachToTarget")
            return { sessionId: "private-session" };
          if (method === "Storage.getCookies")
            return {
              cookies: [
                { ...cookie(), session: true, partitionKey: partition },
                { ...cookie("other", "unrelated.test"), session: true },
              ],
            };
          return {};
        },
      };
    const adapter = await createCdpCookieAdapter(cdp, {
      browserContextId: "isolated",
      targetId: "target",
    });
    expect(await adapter.exportCookies(["service.test"])).toEqual([
      { ...cookie(), partitionKey: partition },
    ]);
    await adapter.replaceCookies(
      [{ ...cookie(), partitionKey: partition }],
      ["service.test"],
    );
    expect(sent.filter((c) => c.method === "Network.deleteCookies")).toEqual([
      {
        method: "Network.deleteCookies",
        params: {
          name: "sid",
          domain: "service.test",
          path: "/",
          partitionKey: partition,
        },
        session: "private-session",
      },
    ]);
    expect(sent.some((c) => c.method === "Storage.clearCookies")).toBe(false);
    const set = sent.find((c) => c.method === "Storage.setCookies")!.params
      .cookies as Record<string, unknown>[];
    expect(set[0]).not.toHaveProperty("domain");
    expect(set[0]).toHaveProperty("url", "https://service.test/");
    await expect(
      createCdpCookieAdapter(cdp, {
        browserContextId: "wrong",
        targetId: "target",
      }),
    ).rejects.toMatchObject({ code: "BROWSER_UNAVAILABLE" });
  });
});
