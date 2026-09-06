import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getRequestListener } from "@hono/node-server";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { errors as oidcErrors } from "oidc-provider";
import { id, z } from "@unlock/protocol";
import { Vault, type RuntimePrincipal } from "./vault.js";
import { OwnerAuth, type OwnerSession } from "./owner-auth.js";
import { OAuth } from "./oauth.js";
import { Runtime } from "./runtime.js";
import { Maintainer } from "./worker.js";
import { Imports } from "./imports.js";
import { digest, same } from "./crypto.js";
import { VaultError } from "./errors.js";
import { SsoContexts } from "./sso.js";
type Variables = { owner: OwnerSession; principal: RuntimePrincipal };
export function createApplication(
  vault: Vault,
  owner: OwnerAuth,
  oauth: OAuth,
  runtime: Runtime,
  maintainer: Maintainer,
) {
  const app = new Hono<{ Variables: Variables }>(),
    imports = new Imports(vault),
    sso = new SsoContexts(vault),
    origin = owner.origin;
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 2_097_152,
      onError: (c) => c.json({ error: { code: "CAPACITY" } }, 413),
    }),
  );
  app.onError((error, c) => {
    const fault =
      error instanceof VaultError
        ? error
        : error instanceof z.ZodError || error instanceof SyntaxError
          ? new VaultError("INVALID_INPUT")
          : new VaultError("UNAVAILABLE", 503);
    return c.json({ error: { code: fault.code } }, fault.status);
  });
  app.notFound((c) => c.json({ error: { code: "NOT_FOUND" } }, 404));
  app.get("/health", (c) =>
    c.json({ service: "unlock", version: "1", mode: "vault" }),
  );
  app.get("/ready", async (c) => {
    await vault.db.query("SELECT 1");
    return c.json({ ok: true });
  });
  app.get("/", (c) =>
    c.html(
      '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Unlock vault service</title><h1>Unlock vault service</h1><p>Authenticated API: /v1. Agent authorization server: /oauth.</p><p><a href="/auth/login">Sign in as owner</a></p><p>This service is separate from the synthetic UI preview. Configure your trusted client with this origin.</p></html>',
    ),
  );
  app.get("/auth/login", async (c) => {
    const result = await owner.begin(c.req.query("returnTo") ?? "/");
    c.header("Set-Cookie", result.cookie);
    return c.redirect(result.url, 302);
  });
  app.get("/auth/callback", async (c) => {
    const url = new URL(c.req.url);
    const result = await owner.finish(
      new URL(url.pathname + url.search, origin),
      c.req.header("cookie"),
    );
    for (const cookie of result.cookies)
      c.header("Set-Cookie", cookie, { append: true });
    return c.redirect(result.returnTo, 302);
  });
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json({
      resource: oauth.resource,
      authorization_servers: [origin + "/oauth"],
      scopes_supported: [
        "sessions:read",
        "sessions:write",
        "maintenance:request",
      ],
      bearer_methods_supported: ["header"],
    }),
  );
  app.use("/v1/*", async (c, next) => {
    if (c.req.path.startsWith("/v1/runtime/")) {
      const token = c.req.header("authorization");
      if (!token?.startsWith("Bearer ") || token.length > 16384) {
        c.header(
          "WWW-Authenticate",
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        );
        throw new VaultError("UNAUTHENTICATED", 401);
      }
      c.set("principal", await oauth.authenticate(token.slice(7)));
    } else {
      const session = await owner.session(c.req.header("cookie"));
      if (!session) throw new VaultError("UNAUTHENTICATED", 401);
      if (
        !["GET", "HEAD"].includes(c.req.method) &&
        (c.req.header("origin") !== origin ||
          !same(c.req.header("x-unlock-csrf") ?? "", session.csrf))
      )
        throw new VaultError("FORBIDDEN", 403);
      if (
        c.req.path.startsWith("/v1/owner/") &&
        vault.now() > session.expiresAt - 8 * 3600_000 + 15 * 60000
      )
        throw new VaultError("REAUTH_REQUIRED", 401);
      c.set("owner", session);
    }
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      !c.req.header("content-type")?.startsWith("application/json")
    )
      throw new VaultError("INVALID_INPUT");
    await next();
  });
  app.get("/v1/me", (c) =>
    c.json({ tenantId: c.get("owner").tenant, csrf: c.get("owner").csrf }),
  );
  app.post("/v1/logout", async (c) => {
    c.header("Set-Cookie", await owner.logout(c.get("owner")));
    return c.json({ ok: true });
  });
  app.get("/v1/connections", async (c) =>
    c.json(await vault.list(c.get("owner").tenant)),
  );
  app.patch("/v1/connections/:id", async (c) =>
    c.json(
      await vault.update(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.delete("/v1/connections/:id", async (c) =>
    c.json(
      await vault.remove(c.get("owner").tenant, id.parse(c.req.param("id"))),
    ),
  );
  app.get("/v1/profiles", async (c) =>
    c.json(await vault.profiles(c.get("owner").tenant)),
  );
  app.post("/v1/profiles", async (c) =>
    c.json(
      await vault.saveProfile(c.get("owner").tenant, await c.req.json()),
      201,
    ),
  );
  app.patch("/v1/profiles/:id", async (c) =>
    c.json(
      await vault.saveProfile(
        c.get("owner").tenant,
        await c.req.json(),
        id.parse(c.req.param("id")),
      ),
    ),
  );
  app.put("/v1/profiles/:id/assignments", async (c) => {
    const value = z
      .object({ connectionIds: z.array(id).max(2000) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await vault.assign(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
        value.connectionIds,
      ),
    );
  });
  app.get("/v1/sources", async (c) =>
    c.json(await vault.sources(c.get("owner").tenant)),
  );
  app.delete("/v1/sources/:id", async (c) =>
    c.json(
      await vault.disconnectSource(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
      ),
    ),
  );
  app.get("/v1/clients", async (c) =>
    c.json(await vault.clients(c.get("owner").tenant)),
  );
  app.post("/v1/clients", async (c) =>
    c.json(
      await vault.createClient(c.get("owner").tenant, await c.req.json()),
      201,
    ),
  );
  app.patch("/v1/clients/:id", async (c) =>
    c.json(
      await vault.updateClient(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.delete("/v1/clients/:id", async (c) =>
    c.json(
      await vault.revokeClient(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
      ),
    ),
  );
  app.get("/v1/events", async (c) =>
    c.json(await vault.events(c.get("owner").tenant)),
  );
  app.get("/v1/jobs", async (c) =>
    c.json(await maintainer.jobs(c.get("owner").tenant)),
  );
  app.post("/v1/owner/connections", async (c) =>
    c.json(await vault.add(c.get("owner").tenant, await c.req.json()), 201),
  );
  app.post("/v1/owner/connections/:id/credential", async (c) =>
    c.json(
      await vault.reveal(c.get("owner").tenant, id.parse(c.req.param("id"))),
    ),
  );
  app.put("/v1/owner/connections/:id/credential", async (c) => {
    const input = z
      .object({ password: z.string(), version: z.number().int() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await vault.setPassword(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
        input.password,
        input.version,
      ),
    );
  });
  app.post("/v1/owner/connections/:id/session", async (c) =>
    c.json(
      await runtime.importSession(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.post("/v1/owner/sources", async (c) =>
    c.json(
      await vault.addSource(c.get("owner").tenant, await c.req.json()),
      201,
    ),
  );
  app.put("/v1/owner/sources/:id", async (c) =>
    c.json(
      await vault.reconnectSource(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.post("/v1/owner/imports/preview", async (c) =>
    c.json(
      await imports.preview(c.get("owner").tenant, await c.req.json()),
      201,
    ),
  );
  app.post("/v1/owner/imports/:id/commit", async (c) =>
    c.json(
      await imports.commit(
        c.get("owner").tenant,
        id.parse(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.delete("/v1/owner/imports/:id", async (c) =>
    c.json(
      await imports.cancel(c.get("owner").tenant, id.parse(c.req.param("id"))),
    ),
  );
  app.get("/v1/sso", async (c) =>
    c.json(await sso.list(c.get("owner").tenant)),
  );
  app.post("/v1/owner/sso", async (c) =>
    c.json(await sso.save(c.get("owner").tenant, await c.req.json()), 201),
  );
  app.put("/v1/owner/sso/:id", async (c) =>
    c.json(
      await sso.save(
        c.get("owner").tenant,
        await c.req.json(),
        id.parse(c.req.param("id")),
      ),
    ),
  );
  app.delete("/v1/sso/:id", async (c) =>
    c.json(
      await sso.disable(c.get("owner").tenant, id.parse(c.req.param("id"))),
    ),
  );
  app.get("/v1/runtime/connections", async (c) =>
    c.json(await runtime.connections(c.get("principal"))),
  );
  app.get("/v1/runtime/connections/:id/status", async (c) => {
    return c.json(
      await runtime.status(c.get("principal"), id.parse(c.req.param("id"))),
    );
  });
  app.delete("/v1/runtime/connections/:id/session", async (c) => {
    await runtime.revoke(c.get("principal"), id.parse(c.req.param("id")));
    return c.body(null, 204);
  });
  app.get("/v1/runtime/connections/:id/session", async (c) =>
    c.json(
      await runtime.retrieve(c.get("principal"), id.parse(c.req.param("id"))),
    ),
  );
  app.put("/v1/runtime/connections/:id/session", async (c) =>
    c.json(
      await runtime.sync(
        c.get("principal"),
        id.parse(c.req.param("id")),
        await c.req.json(),
      ),
    ),
  );
  app.post("/v1/runtime/connections/:id/renew", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    return c.json(
      await maintainer.enqueue(c.get("principal"), id.parse(c.req.param("id"))),
      202,
    );
  });
  return app;
}
export function createHttpServer(
  vault: Vault,
  owner: OwnerAuth,
  oauth: OAuth,
  runtime: Runtime,
  maintainer: Maintainer,
) {
  const app = createApplication(vault, owner, oauth, runtime, maintainer),
    listener = getRequestListener(app.fetch),
    expected = new URL(owner.origin);
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.headers.host !== expected.host) {
        res.writeHead(400);
        res.end();
        return;
      }
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (expected.protocol === "https:")
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
      const window = Math.floor(vault.now() / 60000),
        rate = digest(`${req.socket.remoteAddress}:${window}`);
      if (req.url !== "/health") {
        const count = await vault.db.query<{ count: number }>(
          "INSERT INTO rate_limits(key,count,expires_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=rate_limits.count+1 RETURNING count",
          [rate, (window + 2) * 60000],
        );
        if (count.rows[0].count > 600) {
          res.writeHead(429, {
            "Retry-After": "60",
            "Content-Type": "application/json",
          });
          res.end('{"error":{"code":"RATE_LIMITED"}}');
          return;
        }
      }
      delete req.headers["x-forwarded-host"];
      req.headers["x-forwarded-proto"] = expected.protocol.slice(0, -1);
      if (/^\/oauth\/interaction\/[A-Za-z0-9_-]+$/.test(req.url ?? "")) {
        await oauth.interaction(req, res);
        return;
      }
      if (req.url?.startsWith("/.well-known/oauth-authorization-server/oauth"))
        req.url = "/oauth/.well-known/oauth-authorization-server";
      if (req.url?.startsWith("/oauth/")) {
        (req as IncomingMessage & { originalUrl?: string }).originalUrl =
          req.url;
        req.url = req.url.slice("/oauth".length);
        oauth.provider.callback()(req, res);
        return;
      }
      await listener(req, res);
    } catch (error) {
      const fault =
        error instanceof VaultError
          ? error
          : error instanceof oidcErrors.OIDCProviderError
            ? new VaultError("INVALID_INPUT")
            : new VaultError("UNAVAILABLE", 503);
      if (!res.headersSent)
        res.writeHead(fault.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
      res.end(JSON.stringify({ error: { code: fault.code } }));
    }
  };
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 50;
  return server;
}
