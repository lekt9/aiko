// Cloudflare Worker entrypoint. Deploy with `wrangler deploy`. The upstream key
// lives as a Worker secret (`wrangler secret put CODEGRAFF_API_KEY`), never in code.
import { handleRequest, type ProxyEnv } from "./proxy";

export default {
  fetch(request: Request, env: ProxyEnv): Promise<Response> {
    return handleRequest(request, env);
  },
};
