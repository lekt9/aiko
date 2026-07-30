import { afterEach, describe, expect, it, mock } from "bun:test";
import { handleRequest, type ProxyEnv, resolveModel } from "./proxy";

const ENV: ProxyEnv = { CODEGRAFF_API_KEY: "cg_sk_test", DEFAULT_MODEL: "deepseek-v4-pro" };

afterEach(() => {
  mock.restore();
});

describe("resolveModel", () => {
  it("maps placeholder ids to the default", () => {
    for (const p of ["", "default", "auto", "unbrowse", "UNBROWSE-DEFAULT"]) {
      expect(resolveModel(p, "deepseek-v4-pro")).toBe("deepseek-v4-pro");
    }
  });
  it("passes an explicit model through untouched", () => {
    expect(resolveModel("claude-opus-4.8", "deepseek-v4-pro")).toBe("claude-opus-4.8");
  });
});

describe("handleRequest", () => {
  it("answers /health without an upstream call", async () => {
    const res = await handleRequest(new Request("http://x/health"), ENV);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("500s when the upstream key is missing", async () => {
    const res = await handleRequest(new Request("http://x/v1/chat/completions", { method: "POST", body: "{}" }), {});
    expect(res.status).toBe(500);
  });

  it("injects the upstream key and rewrites a placeholder model", async () => {
    let seenAuth: string | null = null;
    let seenBody: unknown = null;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      seenAuth = new Headers(init.headers).get("authorization");
      seenBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const req = new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "default", messages: [] }),
    });
    const res = await handleRequest(req, ENV);
    expect(res.status).toBe(200);
    expect(seenAuth).toBe("Bearer cg_sk_test"); // client sent none; proxy injected it
    expect((seenBody as { model: string }).model).toBe("deepseek-v4-pro"); // placeholder rewritten
  });

  it("collapses /v1/models to a single unbrowse-default entry", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await handleRequest(new Request("http://x/v1/models"), ENV);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe("unbrowse-default");
  });

  it("forwards a non-model path (search) verbatim with the key", async () => {
    let seenUrl = "";
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      seenUrl = url;
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer cg_sk_test");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await handleRequest(new Request("http://x/v1/search", { method: "POST", body: '{"query":"hi"}' }), ENV);
    expect(seenUrl).toBe("https://gateway.codegraff.com/v1/search");
  });

  // Load-bearing invariant: model rewriting must touch ONLY chat/completions/responses.
  // If it rewrote a search or sandbox body, the key-free tools would silently corrupt.
  it("does NOT rewrite the body of a non-chat path even when it carries a 'model' field", async () => {
    let seenBody = "";
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      seenBody = init.body as string;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const original = '{"query":"hi","model":"default"}';
    await handleRequest(new Request("http://x/v1/search", { method: "POST", body: original }), ENV);
    expect(seenBody).toBe(original); // byte-for-byte passthrough — "default" NOT expanded
  });

  // Security invariant (verified live in step 5): a client-supplied Authorization must be
  // REPLACED with the upstream key, never forwarded — otherwise a client could reach the
  // upstream with its own/forged credentials instead of the proxy's.
  it("REPLACES a client-supplied Authorization header with the upstream key", async () => {
    let seenAuth: string | null = null;
    globalThis.fetch = mock(async (_url: string, init: RequestInit) => {
      seenAuth = new Headers(init.headers).get("authorization");
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const req = new Request("http://x/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer cg_sk_STOLEN_BOGUS" },
      body: JSON.stringify({ model: "default", messages: [] }),
    });
    await handleRequest(req, ENV);
    expect(seenAuth).toBe("Bearer cg_sk_test"); // upstream key, NOT the client's bogus one
  });

  it("retries a transient upstream 500 and succeeds on a later attempt", async () => {
    let n = 0;
    globalThis.fetch = mock(async () => {
      n++;
      if (n < 3) return new Response('{"error":{"message":"internal error"}}', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await handleRequest(
      new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "default" }) }),
      ENV,
    );
    expect(res.status).toBe(200); // recovered after two 500s
    expect(n).toBe(3);
  });

  it("gives up after exhausting retries on persistent 5xx (returns the last status)", async () => {
    let n = 0;
    globalThis.fetch = mock(async () => {
      n++;
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch;
    const res = await handleRequest(
      new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "default" }) }),
      ENV,
    );
    expect(res.status).toBe(503);
    expect(n).toBe(3); // initial + 2 retries
  });

  // Dual upstream: model calls -> xAI, search/sandbox -> codegraff.
  const XENV: ProxyEnv = {
    CODEGRAFF_API_KEY: "cg_sk_test",
    DEFAULT_MODEL: "deepseek-v4-pro",
    XAI_API_KEY: "xai-test",
    XAI_DEFAULT_MODEL: "grok-4.5",
  };

  it("routes chat/completions to xAI with the xAI key and grok-4.5 default", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    let seenModel = "";
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get("authorization");
      seenModel = JSON.parse(init.body as string).model;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await handleRequest(
      new Request("http://x/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "default" }) }),
      XENV,
    );
    expect(seenUrl).toBe("https://api.x.ai/v1/chat/completions");
    expect(seenAuth).toBe("Bearer xai-test");
    expect(seenModel).toBe("grok-4.5"); // placeholder -> xAI default
  });

  it("still routes /v1/search to codegraff with the codegraff key (xAI has no such endpoint)", async () => {
    let seenUrl = "";
    let seenAuth: string | null = null;
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenAuth = new Headers(init.headers).get("authorization");
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    await handleRequest(new Request("http://x/v1/search", { method: "POST", body: '{"query":"hi"}' }), XENV);
    expect(seenUrl).toBe("https://gateway.codegraff.com/v1/search");
    expect(seenAuth).toBe("Bearer cg_sk_test");
  });

  it("answers an OPTIONS preflight with CORS headers and no upstream call", async () => {
    let called = false;
    globalThis.fetch = mock(async () => {
      called = true;
      return new Response("");
    }) as unknown as typeof fetch;
    const res = await handleRequest(new Request("http://x/v1/chat/completions", { method: "OPTIONS" }), ENV);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(called).toBe(false);
  });
});
