import { boundedText } from "./security.ts";

export type RequestLabScenario = "baseline" | "unchanged" | "changed" | "missing_dependency";
export type RequestLabRunner = (scenario: RequestLabScenario, signal: AbortSignal) => Promise<unknown>;

const scenarios = new Set<RequestLabScenario>(["baseline", "unchanged", "changed", "missing_dependency"]);
const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

/** Controlled checks have their own disposable store and never execute owner-supplied requests. */
export async function requestLabApi(input: {
  request: Request;
  principal: { owner: string; operator: boolean; scopes: readonly string[] };
  allowed: (account: string) => boolean;
  run?: RequestLabRunner;
  serialize: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<Response> {
  const { request, principal } = input;
  const url = new URL(request.url);
  if (request.method === "GET") {
    if ([...url.searchParams.keys()].some(key => key !== "account")) return json({ error: "invalid_query" }, 400);
    if (!input.allowed(url.searchParams.get("account") ?? principal.owner)) return json({ error: "forbidden" }, 403);
    return json({
      available: !!input.run,
      mode: "controlled-fixture",
      reason: input.run
        ? "Checks use the real compiler and memory with example responses in a disposable store."
        : "Run the local Request lab to execute controlled checks. This host only exposes recorded account evidence.",
    });
  }
  if (request.method !== "POST") return json({ error: "not_found" }, 404);
  if (!principal.scopes.includes("write")) return json({ error: "forbidden" }, 403);
  if (url.search || !request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "invalid_request" }, 400);
  let body: unknown;
  try { body = JSON.parse(await boundedText(new Response(request.body), 512)); }
  catch { return json({ error: "invalid_body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid_body" }, 400);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "account,scenario" || typeof value.account !== "string" ||
      typeof value.scenario !== "string" || !scenarios.has(value.scenario as RequestLabScenario)) return json({ error: "invalid_body" }, 400);
  if (!input.allowed(value.account)) return json({ error: "forbidden" }, 403);
  const run = input.run;
  if (!run) return json({ error: "lab_unavailable" }, 501);
  const scenario = value.scenario as RequestLabScenario;
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]);
  return input.serialize(async () => {
    try {
      signal.throwIfAborted();
      const report = await run(scenario, signal);
      signal.throwIfAborted();
      return json(report);
    } catch {
      return json({ error: signal.aborted ? "lab_cancelled" : "lab_failed" }, signal.aborted ? 408 : 500);
    }
  });
}
