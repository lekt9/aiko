/** Exercise the bundled viewer in real workerd, with a synthetic read-only
 * production service. Bun alone does not enforce edge Request restrictions. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const agent = fileURLToPath(new URL("../apps/agent/", import.meta.url));
// Resolve pnpm's symlink before looking up Wrangler's pinned test runtime.
const require = createRequire(realpathSync(join(agent, "node_modules/wrangler/package.json")));
const { Miniflare, convertV4MiniflareOptions } = require("miniflare");
const scriptPath = process.argv[2];
if (!scriptPath) throw Error("Pass the bundled voyager-worker.js path");
const origin = "https://viewer.example.test", token = "workerd-voyager-fixture-token-not-a-secret";
const requests = [];
let revoked = false, redirect = false;
const miniflare = new Miniflare(convertV4MiniflareOptions({
  modules: true, scriptPath, compatibilityDate: "2026-09-06", compatibilityFlags: ["nodejs_compat"],
  bindings: { AIKO_PRODUCTION_URL: "https://production.example.test", AIKO_VOYAGER_SESSION_KEY: "d".repeat(43) },
  serviceBindings: {
    VOYAGER_ASSETS: async () => new Response("<title>voyager</title>"),
    AIKO_PRODUCTION: async request => {
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname });
      assert.equal(request.method, "GET");
      assert.equal(request.headers.get("authorization"), `Bearer ${token}`);
      assert.equal(request.headers.get("cookie"), null);
      if (redirect) return new Response(null, { status: 302, headers: { location: "https://attacker.example.test" } });
      if (revoked) return Response.json({}, { status: 401 });
      if (url.pathname === "/v1/status") return Response.json({ account: "123" });
      if (url.pathname === "/api/control/events") return Response.json({ thread: "user-123", events: [{ seq: 1, event: { type: "ThreadCreated", depth: 0 } }], nextAfter: 1, hasMore: false });
      throw Error("Unexpected production path");
    },
  },
}));
try {
  const response = await miniflare.dispatchFetch(origin + "/session", {
    method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  assert.equal(response.status, 200, "workerd sign-in must accept the bounded production read");
  const cookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.ok(!cookie.includes(token));
  const events = await miniflare.dispatchFetch(origin + "/v1/actors/123/threads/user-123/events/stream", { headers: { cookie } });
  assert.equal(events.status, 200);
  assert.match(await events.text(), /id: 1\ndata: \{"type":"ThreadCreated","depth":0\}/);
  const before = requests.length;
  const mutation = await miniflare.dispatchFetch(origin + "/v1/actors/123/threads/user-123/events", { method: "POST", headers: { cookie }, body: "{}" });
  assert.equal(mutation.status, 405);
  assert.equal(requests.length, before);
  redirect = true;
  const redirected = await miniflare.dispatchFetch(origin + "/v1/metadata", { headers: { cookie } });
  assert.equal(redirected.status, 503);
  assert.equal(requests.length, before + 1, "a service redirect must not be followed");
  redirect = false; revoked = true;
  const denied = await miniflare.dispatchFetch(origin + "/session", { headers: { cookie } });
  assert.equal(denied.status, 401);
  console.log("PASS: real workerd sign-in, encrypted session, native SSE, write denial, redirect refusal and current revocation");
} finally { await miniflare.dispose(); }
