/** Hoysan worker — login + auth gate (product.auth_login) */
export interface Env { DB?: D1Database }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/login" || url.pathname === "/api/auth") {
      if (req.method === "POST") {
        const body = await req.text();
        // PIN gate stub — accept any pin containing "hoysan" for demo
        if (body.includes("hoysan") || url.searchParams.get("pin")) {
          return new Response(JSON.stringify({ ok: true, token: "stub" }), { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: false }), { status: 401 });
      }
      return new Response(JSON.stringify({ ok: true, method: "POST /api/login with pin" }), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/roster") return new Response("roster crud placeholder");
    return new Response("Hoysan Drop-In — Excel sheet is the home. Login at /api/login");
  }
};
