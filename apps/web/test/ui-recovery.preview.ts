// Loopback-only UI regression fixture. No credentials, providers or account service.
import { mkdir } from "node:fs/promises";
import { CONSOLE_HTML } from "../../agent/src/console";
const outdir = process.env.UI_RECOVERY_BUILD_DIR ?? "artifacts/agents-principles-fixes-2026-09-08/ui-build";
await mkdir(outdir, { recursive: true });
const build = await Bun.build({ entrypoints: ["apps/web/test/ui-recovery.fixture.tsx", "apps/web/test/ui-console.fixture.ts"], outdir, target: "browser", define: { "import.meta.env": "{}" },
  // Exercise current workspace source even when another worker has not rebuilt dist.
  plugins: [{ name: "workspace-protocol", setup(build) { build.onResolve({ filter: /^@unlock\/protocol$/ }, () => ({ path: `${process.cwd()}/packages/protocol/src/index.ts` })); } }],
});
if (!build.success) throw Error(build.logs.join("\n"));
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.UI_RECOVERY_PORT ?? 4196), fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>UI recovery fixture</title><link rel="stylesheet" href="/ui-recovery.fixture.css"></head><body><main id="root"></main><script type="module" src="/ui-recovery.fixture.js"></script></body></html>', { headers: {
    "content-type": "text/html", "content-security-policy": "default-src 'self'; img-src 'none'; connect-src 'none'; style-src 'self' 'unsafe-inline'", "cache-control": "no-store",
  } });
  if (path === "/console") return new Response(CONSOLE_HTML.replace("<script>", '<script src="/ui-console.fixture.js"></script><script>'), { headers: {
    "content-type": "text/html", "content-security-policy": "default-src 'self'; img-src 'none'; connect-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'", "cache-control": "no-store",
  } });
  if (["/ui-recovery.fixture.js", "/ui-recovery.fixture.css", "/ui-console.fixture.js"].includes(path)) return new Response(Bun.file(outdir + path));
  return new Response("Not found", { status: 404 });
} });
console.log(`UI recovery fixture: ${server.url}`);
