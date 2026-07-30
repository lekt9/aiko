// Local / Bun entrypoint: `CODEGRAFF_API_KEY=cg_sk_... bun server.ts`.
// Same handler the Cloudflare Worker uses, so local behavior matches production.
import { handleRequest, type ProxyEnv } from "./src/proxy";

const port = Number(process.env.PORT ?? 8787);

Bun.serve({
  port,
  fetch(request: Request): Promise<Response> {
    return handleRequest(request, process.env as ProxyEnv);
  },
});

console.log(`unbrowse-proxy listening on http://localhost:${port} -> ${process.env.UPSTREAM_BASE ?? "gateway.codegraff.com"}`);
