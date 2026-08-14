#!/usr/bin/env bun
// Fixture host for the hermetic Telegram-bridge witness.
//
// It does NOT invent a Bot API stub: it starts the existing one
// (packages/integrations/tests/telegram-fixture.js — a real Bun.serve
// speaking the Bot API wire format, with real getUpdates long-poll
// semantics) and puts a small CONTROL server in front of it so processes
// other than this one — the source host, the workflow run, the witness —
// can seed updates and read back the recorded requests.
//
// Control plane (loopback, ephemeral port, no auth surface beyond the port):
//   POST /push      {update}          → { update_id }
//   GET  /requests  ?method=sendPhoto → { requests: [...] }   (arrival order)
//   POST /queue     {method,status,body} → scripted next response
//   POST /reset                        → forget recorded requests
//   GET  /health                       → { ok: true }
//
// Writes {apiBaseUrl, controlUrl, token} to --out and holds until SIGTERM or
// --duration-ms elapses, so a witness can never orphan it.

import { writeFileSync } from "node:fs";
import { startTelegramFixture } from "../../../packages/integrations/tests/telegram-fixture.js";

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=");
    flags[name] = inline ?? argv[++index] ?? "";
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const fixture = startTelegramFixture();
let cleared = 0;

const control = Bun.serve({
  port: Number(flags.port ?? 0),
  hostname: "127.0.0.1",
  idleTimeout: 30,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, apiBaseUrl: fixture.apiBaseUrl });
    }
    if (url.pathname === "/push" && request.method === "POST") {
      const update = await request.json();
      return Response.json({ update_id: fixture.pushUpdate(update) });
    }
    if (url.pathname === "/queue" && request.method === "POST") {
      const body = await request.json();
      fixture.queueResponse(body.method, { status: body.status, body: body.body });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/requests") {
      const method = url.searchParams.get("method");
      const all = fixture.requests.slice(cleared);
      return Response.json({
        // Full arrival order is the point: "typing before the send" is an
        // ordering claim, so the witness needs the sequence, not counts.
        order: all.map((entry) => entry.method),
        requests: method ? all.filter((entry) => entry.method === method) : all,
      });
    }
    if (url.pathname === "/reset" && request.method === "POST") {
      cleared = fixture.requests.length;
      return Response.json({ ok: true, cleared });
    }
    return Response.json({ ok: false, error: "unknown control route" }, { status: 404 });
  },
});

const info = {
  token: fixture.token,
  apiBaseUrl: fixture.apiBaseUrl,
  controlUrl: `http://127.0.0.1:${control.port}`,
};
if (flags.out) {
  writeFileSync(flags.out, `${JSON.stringify(info)}\n`);
}
console.log(JSON.stringify(info));

const stop = () => {
  control.stop(true);
  fixture.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
if (flags["duration-ms"]) {
  setTimeout(stop, Number(flags["duration-ms"]));
}
