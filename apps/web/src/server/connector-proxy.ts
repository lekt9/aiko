import { LOGIN_IMPORT_MAX_BYTES, LOGIN_IMPORT_SIZE_MESSAGE } from "@unlock/protocol";

const actions = new Set([
  "session",
  "connect",
  "apps/connect",
  "native",
  "complete",
  "disconnect",
  "discover",
  "browser",
  "execute",
  "route",
  "password-managers/add",
  "password-managers/unlock-parameters",
  "password-managers/unlock",
  "password-managers/browse",
  "password-managers/select",
  "password-managers/remove",
  "password-managers/fill",
  "password-managers/authorize",
  "password-managers/callback",
  "imports/logins",
]);

/** Forward end-user authentication only; never attach an operator token. */
export async function handleConnectorRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const loginImport = url.pathname === "/api/connectors/imports/logins";
  const library = url.pathname === "/api/harness/library" || url.pathname.startsWith("/api/harness/library/");
  const watches = url.pathname === "/api/channels/browser-watches" || url.pathname.startsWith("/api/channels/browser-watches/");
  const approvals = url.pathname === "/api/approvals";
  const promises = url.pathname === "/api/promises" || url.pathname.startsWith("/api/promises/");
  const databases = url.pathname === "/api/databases" || url.pathname.startsWith("/api/databases/");
  const observedApproval = url.pathname === "/api/observed-actions/approval";
  const messages = url.pathname === "/api/messages";
  const secretary =
    url.pathname === "/api/secretary" ||
    url.pathname.startsWith("/api/secretary/");
  const action = url.pathname.slice(
    (library ? "/api/harness/library" : promises ? "/api/promises" : watches ? "/api/channels/browser-watches" : databases ? "/api/databases" : observedApproval ? "/api/observed-actions/approval" : messages ? "/api/messages" : approvals ? "/api/approvals" : secretary ? "/api/secretary" : "/api/connectors").length,
  );
  const allowed = library ? !url.search && (request.method === "GET" && action === "" || request.method === "POST" && ["/inspect", "/revise", "/evaluate", "/promote", "/recall", "/run", "/output", "/from-request"].includes(action))
    : promises ? !url.search && (request.method === "GET" && action === "" || request.method === "POST" && action === "/decision")
    : watches ? !url.search && (request.method === "GET" && ["", "/discovery"].includes(action) || request.method === "POST" && ["/configure", "/control", "/sample", "/reconcile", "/acknowledge-gap", "/renew", "/reauthorize"].includes(action))
    : databases ? request.method === "GET" && (action === "" || action === "/changes" || action === "/sources" || /^\/(?:artifacts|operations|approvals|mappings)\/[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(action)) || request.method === "POST" && ["/query", "/field", "/commands", "/cancel"].includes(action)
    : observedApproval ? request.method === "POST"
    : messages ? request.method === "GET"
    :
    request.method === "GET"
      ? action === "" || (secretary && action === "/work") || (!secretary && ["/connections", "/apps", "/password-managers", "/native/progress"].includes(action))
      : request.method === "POST" &&
        (approvals ? action === "" : secretary
          ? ["/contact", "/history", "/work"].includes(action)
          : actions.has(action.slice(1)));
  const json = (error: string, status: number) =>
    Response.json(
      { error },
      { status, headers: { "cache-control": "no-store" } },
    );
  if (!allowed) return json("connector_route_unavailable", 404);
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) return json("invalid_origin", 403);
  const auth =
    request.headers.get("authorization") ??
    (request.headers.has("x-telegram-init-data")
      ? `tma ${request.headers.get("x-telegram-init-data")}`
      : "");
  if (!auth.startsWith("tma ") && !auth.startsWith("tms ") && !auth.startsWith("Bearer "))
    return json("authentication_required", 401);
  const configured = process.env.AIKO_CONNECTOR_ORIGIN;
  if (!configured) return json("connector_service_unavailable", 503);
  try {
    const origin = new URL(configured);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      (origin.protocol !== "https:" &&
        !(
          origin.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)
        ))
    )
      return json("connector_service_unavailable", 503);
    const target = new URL(url.pathname + url.search, origin);
    const headers: Record<string, string> = { Authorization: auth };
    let body: string | undefined;
    if (request.method === "POST") {
      if (
        !request.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json")
      )
        return json("json_required", 415);
      // Private login bodies are forwarded without logging or persistence.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (
            bytes > (loginImport ? LOGIN_IMPORT_MAX_BYTES : library ? 262_144 : watches ? 32_768 : databases ? 1_048_576 : secretary && action === "/history" ? 1_000_000 : 16_384)
          ) {
            await reader.cancel();
            if (loginImport) return Response.json(
              { error: "request_too_large", message: LOGIN_IMPORT_SIZE_MESSAGE },
              { status: 413, headers: { "cache-control": "no-store" } },
            );
            return json("request_too_large", 413);
          }
          chunks.push(chunk.value);
        }
      }
      body = await new Blob(chunks as BlobPart[]).text();
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(["/native", "/password-managers/fill"].includes(action) ? 120_000 : action.startsWith("/password-managers") ? 35_000 : 30_000)]),
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      return json("connector_service_unavailable", 502);
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return json("connector_service_unavailable", 503);
  }
}
