import { Effect } from "effect";
import type { Event } from "tardie/core/event";
import { EventLog, withWatermark } from "tardie/core/log";
import { createPromises, promiseReviewOrder, promiseState } from "./promises.ts";

export interface PromiseApiHost {
  read(): Promise<readonly Event[]>;
  append(events: readonly Event[]): Promise<void>;
  wake(): Promise<unknown>;
}
/** Called only after the host authenticates the account principal independently. */
export async function promiseApi(request: Request, owner: string, principal: { owner: string; scopes: readonly string[]; operator?: boolean } | undefined, host: PromiseApiHost) {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  if (!principal) return json({ error: "unauthorized" }, 401);
  if (principal.operator || principal.owner !== owner || !principal.scopes.includes(request.method === "GET" ? "read" : "write")) return json({ error: "forbidden" }, 403);
  const url = new URL(request.url);
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin) return json({ error: "invalid_origin" }, 403);
  const path = url.pathname.replace(/^\/v1\//, "/api/");
  if (!(path === "/api/promises" && request.method === "GET" || path === "/api/promises/decision" && request.method === "POST")) return json({ error: "not_found" }, 404);
  const thread = `user-${owner}`;
  const log = withWatermark({ read: Effect.promise(host.read), append: events => Effect.promise(() => host.append(events)) });
  const service = createPromises({ owner, thread });
  if (request.method === "GET") return Effect.runPromise(Effect.gen(function* () {
    const rows = [...promiseState(yield* log.read).records.values()].filter(r => r.owner === owner && r.thread === thread)
      .sort(promiseReviewOrder).slice(0, 32);
    const promises = [];
    for (const row of rows) promises.push(yield* service.get(row.id));
    return json({ promises });
  }).pipe(Effect.provideService(EventLog, log)));
  const response = await Effect.runPromise(service.handleDecision(request, () => Effect.succeed({ owner, subject: `account:${owner}`, authenticated: true as const })).pipe(Effect.provideService(EventLog, log)));
  // Native recovery owns dispatch; response acknowledgement never owns the task lifetime.
  if (response.ok) {
    try { await host.wake(); }
    catch {
      // The decision is already durable. Do not turn a wake failure into a
      // failed approval or invite a different task/consent attempt.
      const saved: unknown = await response.json();
      return json({ ...(saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}), warning: "decision_saved_execution_pending" }, 202);
    }
  }
  return response;
}
