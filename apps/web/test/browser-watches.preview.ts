import { mkdir } from "node:fs/promises";
import { savedToolsFixtureApi } from "./saved-tools.fixture-api";
import type {
  WatchConfig,
  WatchDiscovery,
  WatchStatus,
} from "../src/lib/browser-watches";
const outdir = "artifacts/browser-events/ui/preview";
await mkdir(outdir, { recursive: true });
const build = await Bun.build({
  entrypoints: ["apps/web/test/browser-watches.fixture.tsx"],
  outdir,
  target: "browser",
  define: { "import.meta.env": "{}" },
  minify: false,
});
if (!build.success) throw Error("Watch preview build failed");
const discovery: WatchDiscovery = {
  sites: [
    {
      connectionId: "site-fixture",
      label: "Example Mail",
      origin: "https://example.test",
      connectionRevision: "fixture-r1",
      sourceGeneration: 1,
      expiresAt: Date.now() + 3_600_000,
      events: [
        {
          id: "push",
          label: "A push message arrives",
          kind: "push",
          outcome: "received",
        },
        {
          id: "notification",
          label: "A notification appears",
          kind: "notification",
          outcome: "displayed",
        },
      ],
    },
  ],
  actions: [
    {
      id: "aiko",
      label: "Ask Aiko",
      description: "Give Aiko a task for each matching event.",
      supportsInstruction: true,
      action: { kind: "actor", instruction: "Summarize each matching message." },
    },
    {
      id: "saved-summary",
      label: "Summarize the latest message",
      description: "Runs your saved summary action.",
      action: {
        kind: "harness",
        digest: `sha256:${"a".repeat(64)}`,
        contractDigest: `sha256:${"b".repeat(64)}`,
        input: {},
      },
    },
  ],
  defaults: { expiresInMs: 86_400_000, backlog: 32, maxOccurrences: 100 },
};
let watches: WatchStatus[] = [],
  example = false,
  unavailable = false;
const calls: { operation: string; input: unknown }[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4187,
  async fetch(request) {
    const toolsResponse = await savedToolsFixtureApi(request);
    if (toolsResponse) return toolsResponse;
    const url = new URL(request.url),
      json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url.pathname === "/" || url.pathname === "/connection")
      return new Response(
        '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser watch fixture</title><link rel="stylesheet" href="/browser-watches.fixture.css"></head><body><div id="root"></div><script type="module" src="/browser-watches.fixture.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    if (
      ["/browser-watches.fixture.js", "/browser-watches.fixture.css"].includes(
        url.pathname,
      )
    )
      return new Response(Bun.file(outdir + url.pathname));
    if (url.pathname.startsWith("/preview/") && request.method === "POST") {
      if (url.pathname === "/preview/reset") {
        watches = [];
        example = false;
        unavailable = false;
        calls.length = 0;
        return json({ ok: true });
      }
      const watch = watches[0];
      if (watch && url.pathname.endsWith("release-confirm"))
        watch.release = {
          status: "confirmed",
          attempts: 1,
          deadlineAt: Date.now(),
        };
      if (watch && url.pathname.endsWith("release-failed"))
        watch.release = {
          status: "needs-attention",
          attempts: 3,
          deadlineAt: Date.now(),
        };
      if (watch && url.pathname.endsWith("restore")) {
        watch.status = "needs-attention";
        watch.reauthorization = undefined;
        watch.collector = {state:"needs-attention",reason:"restore-authorization-required",
          restore:{challenge:crypto.randomUUID(),at:Date.now(),queue:{head:12,acknowledged:10,offered:11}}};
      }
      if (url.pathname.endsWith("example")) example = true;
      if (url.pathname.endsWith("unavailable")) unavailable = !unavailable;
      if (watch && url.pathname.endsWith("gap")) {
        watch.status = "needs-attention";
        watch.collector = {
          state: "needs-attention",
          reason: "observation-gap",
          coverageGap: {
            generation: 1,
            missed: 2,
            acknowledged: 0,
            countUncertain: false,
            firstAt: Date.now() - 200,
            lastAt: Date.now(),
          },
        };
      }
      if (watch && url.pathname.endsWith("unknown")) {
        watch.lastTaskStatus = "unknown";
        watch.lastTaskOperationId = "fixture-operation";
      }
      if (watch && url.pathname.endsWith("stale"))
        watch.controlRevision = (watch.controlRevision ?? 0) + 1;
      return json({ ok: true });
    }
    if (url.pathname === "/preview/state") return json({ watches, calls, connectionExpiresAt: discovery.sites[0]!.expiresAt });
    if (
      url.pathname === "/api/connectors/session" &&
      request.headers.get("x-telegram-init-data") === "watch-fixture-init"
    )
      return json({ token: "watch-fixture-session" });
    if (request.headers.get("authorization") === "tms watch-fixture-session") {
      if (url.pathname === "/api/connectors/connections")
        return json({
          connections: [
            {
              id: "site-fixture",
              provider: "browser",
              connectorId: "browser:example.test",
              appName: "Example Mail",
              status: "connected",
            },
          ],
          nativeInline: false,
        });
      if (url.pathname === "/api/approvals") return json({ pending: [] });
    }
    if (
      !["Bearer watch-preview-only", "tms watch-fixture-session"].includes(
        request.headers.get("authorization") ?? "",
      )
    )
      return json({ error: "unauthorized" }, 401);
    if (unavailable)
      return json({ error: "browser_watches_not_configured" }, 503);
    const operation = url.pathname.replace("/api/channels/browser-watches", "");
    if (request.method === "GET")
      return json({
        available: true,
        result: operation === "/discovery" ? discovery : watches,
      });
    const input = (await request.json()) as any;
    calls.push({ operation, input });
    if (operation === "/configure") {
      const prior = watches.find((watch) => watch.id === input.config.id);
      if ((prior?.generation ?? 0) !== input.expectedGeneration)
        return json({ error: "conflict" }, 409);
      const config = input.config as WatchConfig;
      const value = {
        id: config.id,
        label: config.label,
        generation: (prior?.generation ?? 0) + 1,
        controlRevision: prior?.controlRevision ?? 0,
        lifecycleRevision: prior?.lifecycleRevision ?? 0,
        leaseRevision: prior?.leaseRevision ?? 0,
        renewal: prior?.renewal,
        budget: {used: prior?.budget?.used ?? 7, limit: config.maxOccurrences, remaining: config.maxOccurrences - (prior?.budget?.used ?? 7)},
        status: "watching",
        config,
        collector: { state: "watching" },
        source: { activated: true },
      };
      watches = [...watches.filter((watch) => watch.id !== config.id), value];
      return json({ available: true, result: value });
    }
    const watch =
      watches.find((watch) => watch.id === input.id) ||
      watches.find((watch) => watch.lastTaskOperationId === input.operationId);
    if (!watch) return json({ error: "missing" }, 404);
    if (operation === "/check-restore") {
      if (input.requestId !== watch.reauthorization?.requestId || Object.keys(input).some(k => !["id", "requestId"].includes(k)))
        return json({error:"conflict"},409);
      // Receipt settlement preserves the current controls and private collection state.
      watch.reauthorization!.status="confirmed";
      return json({available:true,result:watch.reauthorization});
    }
    if (operation === "/reauthorize") {
      if(input.expectedGeneration!==watch.generation || input.expectedLifecycleRevision!==watch.lifecycleRevision ||
        input.expectedLeaseRevision!==watch.leaseRevision || input.challenge!==(watch.collector?.restore?.challenge??watch.reauthorization?.challenge))
        return json({error:"conflict"},409);
      if(!watch.reauthorization){
        watch.reauthorization={requestId:`restore:${watch.id}`,challenge:input.challenge,status:"pending",attempts:1,deadlineAt:Date.now()+60000};
        // Simulated lost response after clearing; the UI must recover the same request.
        watch.collector={state:"watching"};watch.status="watching";
        return json({error:"fixture_lost_confirmation"},409);
      }
      watch.reauthorization.status="confirmed";watch.status="watching";
      return json({available:true,result:watch.reauthorization});
    }
    if (operation === "/renew") {
      if (input.expectedGeneration !== watch.generation || input.expectedLeaseRevision !== (watch.leaseRevision ?? 0)) return json({error:"conflict"},409);
      if (!watch.renewal) {
        if(input.expiresAt > discovery.sites[0]!.expiresAt! || input.expiresAt < watch.config!.expiresAt || input.maxOccurrences <= watch.config!.maxOccurrences) return json({error:"invalid_limits"},400);
        watch.renewal={leaseRevision:input.expectedLeaseRevision+1,expiresAt:input.expiresAt,maxOccurrences:input.maxOccurrences,status:"pending",attempts:1,deadlineAt:Date.now()+60000};
        return json({error:"fixture_lost_confirmation"},503);
      }
      if(input.expiresAt!==watch.renewal.expiresAt || input.maxOccurrences!==watch.renewal.maxOccurrences) return json({error:"conflict"},409);
      watch.renewal.status="confirmed";
      watch.renewal.coverageLapse={from:Date.now()-2000,to:Date.now(),leaseRevision:watch.renewal.leaseRevision};
      watch.leaseRevision=watch.renewal.leaseRevision;
      watch.config!.expiresAt=input.expiresAt;watch.config!.maxOccurrences=input.maxOccurrences;
      watch.budget={used:watch.budget!.used,limit:input.maxOccurrences,remaining:input.maxOccurrences-watch.budget!.used};
      return json({available:true,result:watch.renewal});
    }
    if (operation === "/control") {
      if (watch.controlRevision !== input.expectedRevision)
        return json({ error: "conflict" }, 409);
      watch.controlRevision++;
      if(input.status === "active") watch.lifecycleRevision=watch.controlRevision;
      watch.status = input.status === "active" ? "watching" : input.status;
      watch.release =
        input.status === "active"
          ? undefined
          : { status: "pending", attempts: 0, deadlineAt: Date.now() + 60000 };
    } else if (operation === "/sample")
      return json({
        available: true,
        result: example
          ? {
              status: "available",
              event: { kind: "push", observedAt: Date.now() },
              payload: {
                title: "Maya replied",
                body: "<img src=x onerror=alert(1)> Please review the agenda.",
              },
            }
          : { status: "waiting-for-example" },
      });
    else if (operation === "/acknowledge-gap") {
      const gap = watch.collector!.coverageGap!;
      if (
        watch.generation !== input.expectedGeneration ||
        gap.missed !== input.missed
      )
        return json({ error: "conflict" }, 409);
      gap.acknowledged = input.missed;
      watch.status = "watching";
    } else if (operation === "/reconcile") watch.lastTaskStatus = "unknown";
    else return json({ error: "missing" }, 404);
    return json({ available: true, result: watch });
  },
});
console.log(`Watch fixture ready at ${server.url}; simulated actions only`);
process.on("SIGTERM", () => {
  server.stop(true);
  process.exit(0);
});
