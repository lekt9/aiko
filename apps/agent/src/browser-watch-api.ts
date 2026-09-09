import { Effect } from "effect";
import { Self } from "tardie/core/runtime";
import { Validator, type Schema } from "@cfworker/json-schema";
import { boundedText } from "./security.ts";
import type { createBrowserWatches } from "./browser-watches.ts";

const operations: Record<string, string> = {
  configure: "browser_watch_configure", control: "browser_watch_control",
  "check-restore": "browser_watch_check_restore", reauthorize: "browser_watch_reauthorize", renew: "browser_watch_renew",
  sample: "browser_watch_sample", reconcile: "browser_watch_reconcile",
  "acknowledge-gap": "browser_watch_acknowledge_gap",
};
const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { "cache-control": "no-store" },
});
/** Owner-authenticated account API using the same scoped native tools as Aiko.
 * The caller never supplies producer credentials or a host execution binding. */
export async function browserWatchApi(
  request: Request, owner: string, watches: ReturnType<typeof createBrowserWatches> | undefined,
  principal: { owner: string; scopes: readonly string[] }, wake: () => void,
): Promise<Response> {
  if (principal.owner !== owner || !principal.scopes.includes(request.method === "GET" ? "read" : "write"))
    return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/(?:api|v1)\/channels\/browser-watches\/?/, "");
  if (url.search) return json({ error: "invalid_query" }, 400);
  if (!["GET", "POST"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
  if (!watches) return json({ available: false, error: "browser_watches_not_configured" }, 503);
  const name = request.method === "GET" && path === "discovery" ? "browser_watch_discovery"
    : request.method === "GET" && path === "" ? "browser_watch_status"
    : request.method === "POST" ? operations[path] : undefined;
  if (!name) return json({ error: "not_found" }, 404);
  const native = watches.tools.find(tool => tool.spec.name === name);
  if (!native) return json({ error: "watch_operation_unavailable" }, 503);
  let body: unknown = {};
  if (request.method === "POST") {
    if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "json_required" }, 415);
    try { body = JSON.parse(await boundedText(new Response(request.body), 32_768)); }
    catch { return json({ error: "invalid_body" }, 400); }
  }
  if (!new Validator(native.spec.inputSchema as Schema).validate(body).valid) return json({ error: "invalid_body" }, 400);
  try {
    const result = await Effect.runPromise(native.run(body, { callId: crypto.randomUUID(), signal: request.signal }).pipe(
      Effect.provideService(Self, { actor: "aiko", instance: "browser-watch-api", thread: `user-${owner}` }),
    ), { signal: request.signal });
    if (request.method === "POST") wake();
    return json({ available: true, result });
  } catch {
    // Private transport/provider errors may contain credential-bearing details.
    return json({ error: "watch_operation_unavailable", message: "The watch could not be updated or read. Refresh its status before trying again." }, 409);
  }
}
