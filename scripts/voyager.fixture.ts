/** Synthetic browser fixture for the real Voyager Worker and pinned UI. No
 * production binding, credentials, model calls, or persistent actor state. */
import { join } from "node:path";
import viewer, { type VoyagerEnv } from "../apps/agent/src/voyager-worker.ts";

const root = join(import.meta.dir, "../apps/agent/dist/voyager");
const ownerToken = "voyager-browser-fixture-owner-not-a-secret-123";
const operatorToken = "voyager-browser-fixture-operator-not-a-secret-123";
const unavailableToken = "voyager-browser-fixture-unavailable-not-a-secret";
let revoked = false;
const received: { method: string; path: string }[] = [];
const rows = [
  { seq: 1, event: { type: "ThreadCreated", address: { actor: "aiko", instance: "demo", thread: "user-123" }, depth: 0 } },
  { seq: 2, event: { type: "MessageReceived", id: "fixture-turn", text: "Viewer fixture conversation", at: 1700000000000 } },
  ...Array.from({ length: 202 }, (_, i) => ({ seq: i + 3, event: { type: "TextReturned", id: `fixture-text-${i}`, turn: "fixture-turn", text: `Synthetic observation ${i + 1}`, at: 1700000000001 + i } })),
  { seq: 205, event: { type: "TurnCompleted", id: "fixture-turn", output: "Viewer fixture completed", at: 1700000000500 } },
];
const env: VoyagerEnv = {
  AIKO_PRODUCTION_URL: "https://production.example.test", AIKO_VOYAGER_SESSION_KEY: "d".repeat(43),
  VOYAGER_ASSETS: { fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path !== "/index.html" && !/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css)$/.test(path)) return new Response(null, { status: 404 });
    const file = Bun.file(join(root, path));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } },
  AIKO_PRODUCTION: { fetch: async request => {
    const url = new URL(request.url), token = request.headers.get("authorization")?.slice(7);
    received.push({ method: request.method, path: url.pathname });
    if (token === unavailableToken) return Response.json({}, { status: 503 });
    if (revoked || ![ownerToken, operatorToken].includes(token ?? "")) return Response.json({}, { status: 401 });
    if (request.method !== "GET") throw Error("The viewer forwarded a mutation");
    if (url.pathname === "/v1/status") return Response.json({ account: "123" });
    if (url.pathname === "/api/control/accounts") return Response.json({ accounts: (token === operatorToken ? ["123", "456"] : ["123"]).map(account => ({ account, foreground: `user-${account}`, threads: 1 })) });
    const account = url.searchParams.get("account") ?? url.searchParams.get("thread")?.slice(5);
    if (account !== "123" && token !== operatorToken) return Response.json({}, { status: 403 });
    if (url.pathname === "/api/control/threads") return Response.json({ account, threads: [{ id: `user-${account}` }] });
    if (url.pathname === "/api/control/events") {
      const after = Number(url.searchParams.get("after")), limit = Number(url.searchParams.get("limit"));
      const events = rows.filter(row => row.seq > after).slice(0, limit), nextAfter = events.at(-1)?.seq ?? after;
      return Response.json({ thread: url.searchParams.get("thread"), events, nextAfter, hasMore: nextAfter < rows.length });
    }
    throw Error("Unexpected production read");
  } },
};
Bun.serve({ hostname: "127.0.0.1", port: 4244, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/__fixture/status") return Response.json({ received, revoked });
  if (url.pathname === "/__fixture/revoke" && request.method === "POST") { revoked = true; return Response.json({ revoked }); }
  return viewer.fetch(request, env);
} });
console.log("Synthetic native Voyager fixture: http://127.0.0.1:4244");
