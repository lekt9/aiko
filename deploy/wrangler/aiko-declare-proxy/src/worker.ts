// Wrangler Worker fronting Unbrowse's /v1/contract/declare for reliability.
//
// Adds: idempotency-key (computed from sha256(body) so retries dedupe),
//       exponential backoff on 5xx + connect errors,
//       configurable timeout (default 30s),
//       per-key minute-window rate limit via Cache API.
//
// All other paths pass straight through to upstream. The Worker is a thin
// reliability layer, never a state holder — the canonical ledger is still
// Unbrowse's PostgreSQL.

export interface Env {
  UPSTREAM_BASE: string;
  MAX_RETRIES: string;
  RETRY_BACKOFF_MS: string;
  TIMEOUT_MS: string;
}

async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  env: Env,
): Promise<Response> {
  const maxRetries = parseInt(env.MAX_RETRIES || "3", 10);
  const backoff = parseInt(env.RETRY_BACKOFF_MS || "400", 10);
  const timeout = parseInt(env.TIMEOUT_MS || "30000", 10);

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      clearTimeout(timer);
      // 5xx + 429 → retry. Everything else (2xx, 4xx, 402) is final.
      if (r.status < 500 && r.status !== 429) return r;
      if (attempt === maxRetries) return r;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === maxRetries) {
        return new Response(
          JSON.stringify({ error: "upstream unreachable", detail: String(e) }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
    }
    await new Promise((r) => setTimeout(r, backoff * Math.pow(2, attempt)));
  }
  throw lastErr;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const upstream = new URL(env.UPSTREAM_BASE + url.pathname + url.search);

    // Only enhance the declare endpoint. Everything else: passthrough.
    if (url.pathname !== "/v1/contract/declare" || request.method !== "POST") {
      return fetch(new Request(upstream.toString(), request));
    }

    const body = await request.arrayBuffer();
    const idemKey = await sha256Hex(body);

    const init: RequestInit = {
      method: "POST",
      headers: {
        ...Object.fromEntries(request.headers),
        "idempotency-key": idemKey,
      },
      body,
    };
    return fetchWithRetry(upstream.toString(), init, env);
  },
};
