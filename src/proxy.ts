// unbrowse proxy — a thin, credential-injecting front for codegraff's gateway.
//
// The point: end-user clients (aiko-cli) talk to unbrowse and send NO key. This
// server holds the codegraff cg_sk_ key (from env) and injects it upstream, so the
// codegraff credential never ships in the client. It is OpenAI-compatible: every
// /v1/* path is forwarded verbatim to https://gateway.codegraff.com/v1/*, with the
// request/response streamed through unchanged — except /v1/chat/completions and
// /v1/models, where a placeholder model id is rewritten to the configured default
// so callers never have to pick a model.
//
// The handler is Web-standard (Request -> Response) so the SAME code runs as a
// Cloudflare Worker (see worker.ts) and under Bun.serve (see server.ts).

export interface ProxyEnv {
  /** The upstream codegraff key (cg_sk_...). Held here, never sent to clients. */
  CODEGRAFF_API_KEY?: string;
  /** Upstream base, default https://gateway.codegraff.com. */
  UPSTREAM_BASE?: string;
  /** The real model every placeholder id resolves to. */
  DEFAULT_MODEL?: string;
}

const DEFAULT_UPSTREAM = "https://gateway.codegraff.com";
const DEFAULT_MODEL = "deepseek-v4-pro";

// Incoming model ids that mean "just use the default" — the client no longer picks.
const PLACEHOLDER_MODELS = new Set(["", "default", "auto", "unbrowse", "unbrowse-default"]);

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

/** Resolve the model a caller asked for to the real upstream model. */
export function resolveModel(requested: unknown, def: string): string {
  const id = typeof requested === "string" ? requested.trim() : "";
  return PLACEHOLDER_MODELS.has(id.toLowerCase()) ? def : id;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetch the upstream, retrying transient failures. The gateway (DeepSeek behind
 * codegraff) returns intermittent 5xx / 429 ("internal error, please try again")
 * that are safe to retry — the status arrives before any body is streamed, so a
 * retry never re-sends a half-consumed stream. `body` is a string, reusable across
 * attempts. Non-retryable statuses (and success) return on the first response.
 */
async function fetchWithRetry(
  target: string,
  init: { method: string; headers: Headers; body?: BodyInit },
  retries = 2,
): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    last = await fetch(target, init);
    if (!RETRYABLE.has(last.status)) return last;
    if (attempt < retries) {
      await last.body?.cancel().catch(() => {}); // free the failed body before retrying
      await sleep(250 * (attempt + 1)); // 250ms, 500ms
    }
  }
  return last as Response;
}

export async function handleRequest(request: Request, env: ProxyEnv): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  // Liveness — no upstream call, no key needed.
  if (url.pathname === "/" || url.pathname === "/health") {
    return json({ ok: true, service: "unbrowse-proxy", upstream: env.UPSTREAM_BASE ?? DEFAULT_UPSTREAM });
  }

  if (!url.pathname.startsWith("/v1/")) {
    return json({ error: { message: `unknown path ${url.pathname}` } }, 404);
  }

  const upstreamKey = env.CODEGRAFF_API_KEY;
  if (!upstreamKey) {
    return json({ error: { message: "proxy misconfigured: CODEGRAFF_API_KEY is not set" } }, 500);
  }

  const base = (env.UPSTREAM_BASE ?? DEFAULT_UPSTREAM).replace(/\/$/, "");
  const target = base + url.pathname + url.search;
  const def = env.DEFAULT_MODEL ?? DEFAULT_MODEL;

  // Forward headers, but REPLACE auth with our upstream key and drop hop-by-hop noise.
  const headers = new Headers();
  const ct = request.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  headers.set("authorization", `Bearer ${upstreamKey}`);

  // Rewrite the model on the two endpoints that carry one; forward everything else raw.
  let body: BodyInit | undefined;
  const rewritable =
    request.method === "POST" &&
    (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/completions" || url.pathname === "/v1/responses");
  if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") {
    if (rewritable) {
      const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      payload.model = resolveModel(payload.model, def);
      body = JSON.stringify(payload);
      headers.set("content-type", "application/json");
    } else {
      body = await request.text();
    }
  }

  let upstream: Response;
  try {
    upstream = await fetchWithRetry(target, { method: request.method, headers, body });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return json({ error: { message: `upstream fetch failed: ${msg}` } }, 502);
  }

  // Rewrite the advertised model list so clients see a single "unbrowse-default".
  if (url.pathname === "/v1/models" && upstream.ok) {
    return json({ object: "list", data: [{ id: "unbrowse-default", object: "model", owned_by: "unbrowse" }] });
  }

  // Stream the upstream response body straight through (handles SSE token streaming).
  const respHeaders = new Headers(upstream.headers);
  for (const [k, v] of Object.entries(corsHeaders())) respHeaders.set(k, v);
  respHeaders.delete("content-encoding"); // fetch already decoded; avoid a double-encode claim
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
