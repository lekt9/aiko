import { describe, it, expect } from "vitest";
import { MockAgent } from "undici";
import {
  createHttpRecipe,
  type RecipeContext,
} from "../../apps/server/src/recipes.js";
import { cookie, secret } from "./helpers.js";
const config = {
  id: "fixture-http",
  origin: "https://service.test",
  identityPath: "/identity",
  identityField: "username",
  loginPath: "/login",
  refreshPath: "/refresh",
};
const context = (): RecipeContext => ({
  identity: "alice",
  website: "https://service.test",
  domains: ["service.test"],
  cookies: [],
  signal: AbortSignal.timeout(3000),
  password: async () => secret,
  sso: async () => undefined,
});
describe("operator-approved fixed-origin authentication recipes", () => {
  it("logs in privately, verifies destination identity and captures all cookie paths", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    try {
      const pool = mock.get(config.origin);
      pool.intercept({ path: "/login", method: "POST" }).reply(
        200,
        {},
        {
          headers: {
            "set-cookie": [
              "sid=verified-alice; Path=/; Secure; HttpOnly; SameSite=Lax",
              "scoped=scoped-value; Path=/app; Secure; HttpOnly; SameSite=Strict",
            ],
          },
        },
      );
      pool
        .intercept({ path: "/identity", method: "GET" })
        .reply(200, { username: "alice" });
      const result = await createHttpRecipe(config, mock).renew(context());
      expect(result.identity).toBe("alice");
      expect(result.cookies.map((c) => c.path)).toEqual(["/", "/app"]);
      expect(JSON.stringify(result)).not.toContain(secret);
      mock.assertNoPendingInterceptors();
    } finally {
      await mock.close();
    }
  });
  it("refreshes existing sessions before touching a password and bounds declared expiry", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    try {
      mock
        .get(config.origin)
        .intercept({ path: "/refresh", method: "POST" })
        .reply(
          200,
          {},
          {
            headers: {
              "set-cookie":
                "sid=rotated; Path=/; Secure; HttpOnly; Max-Age=900",
            },
          },
        );
      mock
        .get(config.origin)
        .intercept({ path: "/identity" })
        .reply(200, { username: "alice" });
      const ctx = context();
      ctx.cookies = [cookie()];
      ctx.password = async () => {
        throw new Error("Password should not be requested");
      };
      const result = await createHttpRecipe(
        { ...config, maxSessionMs: 60000 },
        mock,
      ).renew(ctx);
      expect(result.cookies[0].value).toBe("rotated");
      expect(result.expiresAt).toBeLessThanOrEqual(Date.now() + 60000);
    } finally {
      await mock.close();
    }
  });
  it("supports a private CSRF bootstrap and never accepts an unverified identity", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    try {
      const pool = mock.get(config.origin);
      pool
        .intercept({ path: "/bootstrap" })
        .reply(200, { csrf: "SYNTHETIC-CSRF" });
      pool
        .intercept({
          path: "/login",
          method: "POST",
          body: (body) =>
            new URLSearchParams(String(body)).get("csrf") === "SYNTHETIC-CSRF",
        })
        .reply(
          200,
          {},
          { headers: { "set-cookie": "sid=wrong-user; Path=/; Secure" } },
        );
      pool.intercept({ path: "/identity" }).reply(200, { username: "bob" });
      await expect(
        createHttpRecipe(
          {
            ...config,
            bootstrapPath: "/bootstrap",
            csrfField: "csrf",
            form: true,
          },
          mock,
        ).renew(context()),
      ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    } finally {
      await mock.close();
    }
  });
  it("rejects cross-origin configuration, private IP origins and context substitution", async () => {
    for (const origin of [
      "http://service.test",
      "https://127.0.0.1",
      "https://169.254.169.254",
      "https://[::1]",
    ])
      expect(() => createHttpRecipe({ ...config, origin })).toThrow();
    expect(() =>
      createHttpRecipe({ ...config, loginPath: "https://evil.test/steal" }),
    ).toThrow();
    const mock = new MockAgent();
    mock.disableNetConnect();
    try {
      await expect(
        createHttpRecipe(config, mock).renew({
          ...context(),
          website: "https://evil.test",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      await mock.close();
    }
  });
  it("does not follow redirects, echo provider error bodies or accept partitioned cookies through HTTP jars", async () => {
    const mock = new MockAgent();
    mock.disableNetConnect();
    try {
      mock
        .get(config.origin)
        .intercept({ path: "/identity" })
        .reply(302, "SYNTHETIC-PROVIDER-ERROR", {
          headers: { location: "https://evil.test" },
        });
      const recipe = createHttpRecipe(config, mock);
      await expect(recipe.verify(context())).rejects.toMatchObject({
        code: "UNAVAILABLE",
      });
      const ctx = context();
      ctx.cookies = [
        {
          ...cookie(),
          partitionKey: {
            topLevelSite: "https://top.test",
            hasCrossSiteAncestor: false,
          },
        },
      ];
      await expect(recipe.verify(ctx)).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
    } finally {
      await mock.close();
    }
  });
});
