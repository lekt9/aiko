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

  // The #1 deploy mistake is forgetting `wrangler secret put CODEGRAFF_API_KEY`.
  // The Worker must fail LOUD (500), never silently pass a keyless request upstream.
  it("fails loud with 500 when the CODEGRAFF_API_KEY secret is missing (forgotten `wrangler secret put`)", async () => {
    const built = await Bun.build({ entrypoints: ["./src/worker.ts"], target: "browser", format: "esm" });
    const script = await built.outputs[0].text();
    let outboundCalled = false;
    const bare = new Miniflare({
      modules: true,
      script,
      bindings: { DEFAULT_MODEL: "deepseek-v4-pro" }, // NOTE: no CODEGRAFF_API_KEY
      async outboundService() {
        outboundCalled = true;
        return Response.json({});
      },
    });
    try {
      const res = await bare.dispatchFetch("http://proxy.local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "default", messages: [] }),
      });
      expect(res.status).toBe(500);
      expect(outboundCalled).toBe(false); // never reached upstream — no keyless leak
    } finally {
      await bare.dispose();
    }
  });
});

// Real-runtime behavior: the deployed Worker must stream, route, and defend auth the
// same way the pure handler does — proven INSIDE workerd, where a ReadableStream
// passthrough can behave differently than in a mock.
describe("Worker runtime behavior (workerd edges + adversarial)", () => {
  it("GOLDEN edge — streams an SSE response body through unbuffered", async () => {
    const built = await Bun.build({ entrypoints: ["./src/worker.ts"], target: "browser", format: "esm" });
    const script = await built.outputs[0].text();
    const stream = new Miniflare({
      modules: true,
      script,
      bindings: { CODEGRAFF_API_KEY: "cg_sk_x", DEFAULT_MODEL: "deepseek-v4-pro" },
      async outboundService() {
        // Emit three SSE frames as a stream, exactly like a streamed completion.
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode("data: a\n\n"));
            controller.enqueue(enc.encode("data: b\n\n"));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      },
    });
    try {
      const res = await stream.dispatchFetch("http://proxy.local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "default", stream: true, messages: [] }),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const text = await res.text();
      expect(text).toContain("data: a");
      expect(text).toContain("data: b");
      expect(text).toContain("[DONE]");
    } finally {
      await stream.dispose();
    }
  });

  it("EDGE — an unknown (non-/v1) path returns 404 without an upstream call", async () => {
    const res = await mf.dispatchFetch("http://proxy.local/nope");
    expect(res.status).toBe(404);
  });

  it("EDGE — an OPTIONS preflight returns 204 with CORS headers", async () => {
    const res = await mf.dispatchFetch("http://proxy.local/v1/chat/completions", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("ADVERSARIAL — replaces a client-supplied Authorization with the upstream key", async () => {
    await mf.dispatchFetch("http://proxy.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cg_sk_CLIENT_FORGED" },
      body: JSON.stringify({ model: "default", messages: [] }),
    });
    expect(lastOutbound?.auth).toBe("Bearer cg_sk_miniflare"); // upstream key, not the client's
  });
});
