import { randomUUID } from "node:crypto";
import type { routerCaller } from "./connector-router-host.ts";
import type { ConnectorEngine } from "./connectors.ts";
import { boundedText } from "./security.ts";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
/** Owner-facing validation messages are static strings; storage faults stay generic. */
async function managerRoute(run: () => Promise<unknown>): Promise<Response> {
  try {
    return json(await run());
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message && !/storage|store|unavailable|private sign-in/i.test(message))
      return json(
        { error: "invalid_input", message: message.slice(0, 300) },
        400,
      );
    throw error;
  }
}
/** Called only after host authentication/scope checks; engine is bound to that principal. */
export async function connectorApi(
  request: Request,
  engine: ConnectorEngine,
  route?: ReturnType<typeof routerCaller>,
): Promise<Response> {
  const url = new URL(request.url),
    path = url.pathname.replace(/^\/v1\//, "/api/");
  try {
    if (request.method === "GET" && path === "/api/connectors/native/progress") {
      const id = url.searchParams.get("connectionId") ?? "";
      if (!/^[a-f0-9-]{36}$/.test(id)) return json({ error: "invalid_query" }, 400);
      return json(await engine.nativeProgress(id));
    }
    await engine.flushEvents();
    if (request.method === "GET") {
      if (path === "/api/connectors") {
        if (
          [...url.searchParams.keys()].some((k) => k !== "query") ||
          (url.searchParams.get("query") ?? "").length > 256
        )
          return json({ error: "invalid_query" }, 400);
        return json(await engine.search(url.searchParams.get("query") ?? ""));
      }
      if (path === "/api/connectors/connections")
        return json({ connections: await engine.connections(), nativeInline: (await engine.apps()).nativeInline });
      if (path === "/api/connectors/password-managers")
        return json({ managers: await engine.managers(), providers: engine.managerProviders() });
      return json({ error: "not_found" }, 404);
    }
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    const body = JSON.parse(
      await boundedText(new Response(request.body), 8192),
    );
    if (path === "/api/connectors/route" && route) {
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some(
          (k) => !["query", "tasks", "previousDecisionId"].includes(k),
        )
      )
        return json({ error: "invalid_body" }, 400);
      const input =
        typeof body.query === "string" &&
        body.query.trim() &&
        body.query.length <= 1000
          ? { tasks: [{ id: "request", query: body.query }] }
          : body;
      return json(
        await route("route", input, {
          callId: randomUUID(),
          turn: "http",
          signal: request.signal,
        }),
      );
    }
    const fields: Record<string, string[]> = {
      "/api/connectors/native": [
        "connectionId",
        "action",
        "username",
        "password",
        "code",
        "x",
        "y",
        "text",
        "key",
        "delta",
        "url",
      ],
      "/api/connectors/complete": ["connectionId"],
      "/api/connectors/disconnect": ["connectionId"],
      "/api/connectors/discover": ["domain", "evidenceUrls"],
      "/api/connectors/browser": ["domain"],
      "/api/connectors/execute": ["connectionId", "input", "toolId"],
    };
    if (path === "/api/connectors/password-managers/add")
      return await managerRoute(() => engine.addManager(body));
    if (["/api/connectors/password-managers/authorize", "/api/connectors/password-managers/callback"].includes(path)) {
      if (!body || typeof body.managerId !== "string" || !/^[a-f0-9-]{36}$/.test(body.managerId) || Object.keys(body).some((key) => !["managerId", "state", "code"].includes(key)))
        return json({ error: "invalid_body" }, 400);
      if (path.endsWith("/authorize")) return await managerRoute(() => engine.authorizeManager(body.managerId));
      if (typeof body.state !== "string" || body.state.length > 100 || typeof body.code !== "string") return json({ error: "invalid_body" }, 400);
      return await managerRoute(() => engine.finishManagerAuthorization(body.managerId, body.state, body.code));
    }
    if (path === "/api/connectors/password-managers/remove") {
      if (
        typeof body.managerId !== "string" ||
        !/^[a-f0-9-]{36}$/.test(body.managerId)
      )
        return json({ error: "invalid_body" }, 400);
      return await managerRoute(() => engine.removeManager(body.managerId));
    }
    if (path === "/api/connectors/password-managers/fill") {
      if (
        typeof body.connectionId !== "string" ||
        typeof body.managerId !== "string" ||
        typeof body.reference !== "string" ||
        Object.keys(body).some(
          (k) =>
            !["connectionId", "managerId", "reference", "username"].includes(k),
        )
      )
        return json({ error: "invalid_body" }, 400);
      if (body.username !== undefined && typeof body.username !== "string")
        return json({ error: "invalid_body" }, 400);
      return await managerRoute(() =>
        engine.fillFromManager(
          body as {
            connectionId: string;
            managerId: string;
            reference: string;
            username?: string;
          },
          request.signal,
        ),
      );
    }
    if (path === "/api/connectors/imports/logins") {
      if (
        !Array.isArray(body.rows) ||
        Object.keys(body).some((k) => k !== "rows")
      )
        return json({ error: "invalid_body" }, 400);
      return await managerRoute(() => engine.importLogins(body.rows));
    }
    const allowed = fields[path];
    if (!allowed) return json({ error: "not_found" }, 404);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => !allowed.includes(k)) ||
      typeof body[allowed[0]] !== "string" ||
      !body[allowed[0]].trim() ||
      body[allowed[0]].length > 2048
    )
      return json({ error: "invalid_body" }, 400);
    if (path === "/api/connectors/native") {
      const { connectionId, ...input } = body;
      return json(await engine.nativeControl(connectionId, input, request.signal));
    }
    if (path.endsWith("/complete"))
      return json(await engine.completeAuth(body.connectionId));
    if (path.endsWith("/disconnect"))
      return json(await engine.disconnect(body.connectionId));
    if (path.endsWith("/browser"))
      return json({ ...await engine.connectBrowser(body.domain), nativeInline: (await engine.apps()).nativeInline });
    if (path.endsWith("/discover")) {
      if (
        body.evidenceUrls !== undefined &&
        (!Array.isArray(body.evidenceUrls) ||
          body.evidenceUrls.length > 8 ||
          body.evidenceUrls.some(
            (v: unknown) => typeof v !== "string" || v.length > 2048,
          ))
      )
        return json({ error: "invalid_body" }, 400);
      return json(await engine.discover(body.domain, body.evidenceUrls));
    }
    if (
      !body.input ||
      typeof body.input !== "object" ||
      Array.isArray(body.input)
    )
      return json({ error: "invalid_body" }, 400);
    return json(
      await engine.execute(body.connectionId, body.input, body.toolId),
    );
  } catch (error) {
    // Never reflect provider bodies or authorization data into errors.
    if (error instanceof SyntaxError)
      return json({ error: "invalid_body" }, 400);
    return json(
      {
        error: "connector_unavailable",
        message:
          "This connection operation could not be verified. Retry status before repeating an action.",
      },
      409,
    );
  }
}
