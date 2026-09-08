import { request as httpsRequest } from "node:https";
import { publicAddress } from "./browser-proxy.ts";
import { webhookTarget, type WebhookTransport } from "./webhook-adapter.ts";

/** Node/Bun egress port; Worker hosts must inject an owner sandbox transport.
 * DNS is resolved once, all answers checked, then the selected IPv4 is pinned.
 * node:https verifies the original TLS hostname and never follows redirects. */
export function createNodeWebhookTransport(options: {
  lookup?: (hostname: string) => Promise<string[]>;
  request?: typeof httpsRequest;
} = {}): WebhookTransport {
  return { dispatchBoundary: "request", request: async input => {
    const url = webhookTarget(input.url);
    if (input.redirect !== "manual" || !["GET", "POST"].includes(input.method)) throw Error("webhook_transport_policy");
    input.signal.throwIfAborted();
    const address = await publicAddress(url.hostname, options.lookup);
    await input.beforeDispatch();
    input.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const req = (options.request ?? httpsRequest)(url.href, {
        method: input.method, family: 4, agent: false, signal: input.signal,
        lookup: (_host, _options, callback) => callback(null, address, 4),
        headers: { ...input.headers, "accept-encoding": "identity", "user-agent": "Aiko/1.0 (webhook)" },
      }, response => {
        const status = response.statusCode ?? 0;
        // POST acceptance needs only headers; do not hydrate a private response.
        if (input.method === "POST" || status !== 200) {
          response.destroy();
          resolve({ status });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > input.maxResponseBytes) { response.destroy(); reject(Error("webhook_response_limit")); }
          else chunks.push(chunk);
        });
        response.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", () => reject(Error("webhook_response_interrupted")));
      });
      req.on("error", () => reject(Error("webhook_dispatch_unknown")));
      req.end(input.body);
    });
  } };
}
