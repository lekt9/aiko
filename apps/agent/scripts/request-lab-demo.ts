/** Local, synthetic demonstration. No external providers, browser sessions or Telegram sends. */
import { mkdtemp, rm } from "node:fs/promises";
import { createService } from "../src/server.ts";
import { credentialDigest } from "../src/plane-auth.ts";

process.umask(0o077);
const port = Number(process.env.REQUEST_LAB_PORT ?? 4246);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid REQUEST_LAB_PORT");
const stateDir = await mkdtemp("/tmp/aiko-request-lab-demo-");
// This credential is public fixture data and grants access only to the isolated local demo.
const token = "request-lab-public-demo-token-123456789";
const service = await createService({
  mode: "demo", port, stateDir, instanceId: "request-lab-demo", persona: "Request lab demonstration",
  operatorToken: "request-lab-public-operator-token-123456789",
  voiceEnabled: false, allowedUsers: new Set(["123"]),
  planeCredentials: [{ account: "123", digest: credentialDigest(token), scopes: ["read", "write"] }],
});
await service.host.commitRoot(service.host.self("user-123"), {
  type: "AikoHooksConfigured", id: "local-demo", paused: true, at: Date.now(),
});
const server = Bun.serve({
  hostname: "127.0.0.1", port, maxRequestBodySize: 24_576,
  async fetch(request) {
    const response = await service.fetch(request);
    if (new URL(request.url).pathname !== "/control" || request.method !== "GET") return response;
    // Auto-open only this disposable demo. Production CONTROL_HTML keeps normal authentication.
    const boot = `<script>
      document.getElementById('token').value=${JSON.stringify(token)};
      const panel=document.getElementById('workspace-wrap');
      const observer=new MutationObserver(()=>{if(!panel.hidden){observer.disconnect();document.getElementById('request-lab-tab').click();}});
      observer.observe(panel,{attributes:true,attributeFilter:['hidden']});
      setTimeout(()=>observer.disconnect(),10000);
      document.getElementById('login').requestSubmit();
    </script>`;
    return new Response((await response.text()).replace("</body>", boot + "</body>"), {
      status: response.status, headers: response.headers,
    });
  },
});
console.info(`Request lab: http://127.0.0.1:${port}/control`);
console.info("Local example data; automatic fixture login. Stop with Ctrl+C.");
async function close() {
  server.stop(true);
  await service.close();
  await rm(stateDir, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
