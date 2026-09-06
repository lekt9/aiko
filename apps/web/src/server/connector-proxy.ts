const actions = new Set([
  "connect",
  "complete",
  "disconnect",
  "discover",
  "browser",
  "execute",
  "route",
]);

/** Forward end-user authentication only; never attach an operator token. */
export async function handleConnectorRequest(
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const action = url.pathname.slice("/api/connectors".length);
  const allowed =
    request.method === "GET"
      ? action === "" || action === "/connections"
      : request.method === "POST" && actions.has(action.slice(1));
  const json = (error: string, status: number) =>
    Response.json(
      { error },
      { status, headers: { "cache-control": "no-store" } },
    );
  if (!allowed) return json("connector_route_unavailable", 404);
  const auth = request.headers.get("authorization") ?? (request.headers.has("x-telegram-init-data") ? `tma ${request.headers.get("x-telegram-init-data")}` : "");
  if (!auth.startsWith("tma ") && !auth.startsWith("Bearer "))
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
      // Connector requests contain identifiers, never passwords or imported credentials.
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 16_384) {
            await reader.cancel();
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
      signal: AbortSignal.timeout(30_000),
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
