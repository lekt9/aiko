// Local synthetic UI only; network connections and non-fixture routes are blocked.
import { mkdir } from "node:fs/promises";
const outdir = process.env.PROMISES_BUILD_DIR ?? "artifacts/recovery-promises-20260908/ui-build";
await mkdir(outdir, { recursive: true });
const result = await Bun.build({ entrypoints: ["apps/web/test/promises.fixture.tsx"], outdir, target: "browser", sourcemap: "external" });
if (!result.success) throw Error(result.logs.join("\n"));
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PROMISES_PORT ?? 42817), fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/promises.fixture.js") return new Response(Bun.file(`${outdir}/promises.fixture.js`));
  if (path !== "/") return new Response("Not found", { status: 404 });
  return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Promise review fixture</title><style>body{font:16px/1.5 system-ui;margin:16px;color:#162020;background:#fff}main{max-width:760px;margin:auto}button,summary{min-height:44px;cursor:pointer}button{margin:4px;padding:8px}textarea{display:block;max-width:100%}pre{font-size:14px}button:focus-visible,summary:focus-visible{outline:3px solid #126476;outline-offset:2px}</style></head><body><div id="root"></div><script type="module" src="/promises.fixture.js"></script></body></html>', { headers: { "content-type": "text/html", "cache-control": "no-store", "content-security-policy": "default-src 'self'; connect-src 'none'; img-src 'none'; style-src 'unsafe-inline'" } });
} });
console.log(`Promise fixture ${server.url}`);
