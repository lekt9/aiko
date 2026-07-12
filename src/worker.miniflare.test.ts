// Proves the Worker ARTIFACT RUNS under the real Cloudflare runtime (workerd via
// Miniflare), not just that it compiles. dispatchFetch drives the Worker in-process
// — no socket, so the loopback flakiness that masked earlier `wrangler dev` probes
// cannot hide whether the handler actually answers. The upstream codegraff call is
// intercepted by an outbound service so the test is hermetic (no network, no key).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Miniflare } from "miniflare";

let mf: Miniflare;
let lastOutbound: { url: string; auth: string | null; body: string | null } | null = null;

beforeAll(async () => {
  // Bundle src/worker.ts (+ its ./proxy import) to a single ESM module for the runtime.
  const built = await Bun.build({ entrypoints: ["./src/worker.ts"], target: "browser", format: "esm" });
  if (!built.success) throw new Error(`worker bundle failed: ${built.logs.join("\n")}`);
  const script = await built.outputs[0].text();

  mf = new Miniflare({
    modules: true,
    script,
    bindings: { CODEGRAFF_API_KEY: "cg_sk_miniflare", DEFAULT_MODEL: "deepseek-v4-pro" },
    // Intercept the Worker's outbound fetch to the codegraff gateway.
    async outboundService(request) {
      lastOutbound = {
        url: request.url,
        auth: request.headers.get("authorization"),
        body: request.method === "POST" ? await request.text() : null,
      };
      return Response.json({
        model: "deepseek-v4-pro",
        choices: [{ message: { role: "assistant", content: "MINIFLARE_OK" } }],
      });
    },
  });
  // Force the runtime to spin up before the first test.
  await mf.ready;
});

afterAll(async () => {
  await mf?.dispose();
});

describe("Worker artifact under workerd (Miniflare)", () => {
  it("serves /health in-runtime without any upstream call", async () => {
    const res = await mf.dispatchFetch("http://proxy.local/health");
    expect(res.status).toBe(200);
    expect((await res.json<{ ok: boolean }>()).ok).toBe(true);
  });

  it("runs a chat completion: injects the key, rewrites the model, returns upstream content", async () => {
    const res = await mf.dispatchFetch("http://proxy.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    const json = await res.json<{ choices: Array<{ message: { content: string } }> }>();
    expect(json.choices[0].message.content).toBe("MINIFLARE_OK");

    // The Worker really ran: it hit the upstream with the injected key and rewrote the model.
    expect(lastOutbound?.url).toBe("https://gateway.codegraff.com/v1/chat/completions");
    expect(lastOutbound?.auth).toBe("Bearer cg_sk_miniflare");
    expect(JSON.parse(lastOutbound?.body ?? "{}").model).toBe("deepseek-v4-pro");
  });
});
