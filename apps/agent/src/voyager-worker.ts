import { threadBinding } from "./account-binding.ts";
import { boundedText, safeUserId } from "./security.ts";
import { openVoyagerSession, sealVoyagerSession, validVoyagerToken, voyagerCookie } from "./voyager-session.ts";
import { VOYAGER_HELP, VOYAGER_LOGIN, voyagerAccounts, voyagerErrorPage } from "./voyager-ui.ts";

export type VoyagerEnv = {
  VOYAGER_ASSETS: { fetch(request: Request): Promise<Response> };
  AIKO_PRODUCTION: { fetch(request: Request): Promise<Response> };
  AIKO_PRODUCTION_URL: string;
  AIKO_VOYAGER_SESSION_KEY: string;
};
type Account = { account: string; foreground: string; threads: number };
type Row = { seq: number; event: Record<string, unknown> & { type: string } };
type EventPage = { events: Row[]; hasMore: boolean; nextAfter: number };
type ReadPath = "/v1/status" | "/api/control/accounts" | "/api/control/threads" | "/api/control/events";
class Refused extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
const redirect = (path: string, cookie?: string) => new Response(null, { status: 303, headers: { location: path, ...(cookie ? { "set-cookie": cookie } : {}) } });
const problem = (status: number, detail: string) => Response.json({
  type: "https://tardigrade.dev/problems/voyager-access", title: status === 401 ? "Sign in required" : status === 403 ? "Access denied" : "Production viewer", status, detail,
}, { status, headers: { "content-type": "application/problem+json" } });
function protect(response: Response) {
  const result = new Response(response.body, response);
  result.headers.set("cache-control", "no-store");
  result.headers.set("x-content-type-options", "nosniff");
  result.headers.set("referrer-policy", "no-referrer");
  result.headers.set("x-frame-options", "DENY");
  result.headers.set("content-security-policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return result;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function invalidUpstream(): never { throw new Refused(502, "The production trace response was incomplete. Try again shortly."); }
function query(url: URL, allowed: readonly string[]) {
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length)
    throw new Refused(400, "This viewer does not accept those query parameters.");
}
function integer(value: string | null, fallback: number, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === null) return fallback;
  if (!/^\d{1,16}$/.test(value)) throw new Refused(400, "Use a non-negative integer cursor or page size.");
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > maximum) throw new Refused(400, "The cursor or page size is out of range.");
  return result;
}

/** Only these four GETs reach the existing production service. A browser cannot
 * choose an upstream, write path, forwarded header, credential owner or method. */
async function production(env: VoyagerEnv, request: Request, token: string, path: ReadPath, params: Record<string, string> = {}): Promise<unknown> {
  const origin = new URL(env.AIKO_PRODUCTION_URL);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Refused(503, "The production viewer is not configured.");
  const target = new URL(path, origin);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  try {
    const response = await env.AIKO_PRODUCTION.fetch(new Request(target, {
      method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      // workerd rejects redirect:"error". Never follow redirects with a bearer;
      // manual mode lets the non-2xx check below refuse every redirect instead.
      redirect: "manual", signal: AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]),
    }));
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      throw new Refused(response.status, response.status === 404 ? "This thread is not available through the production control API." : "Your current production credential does not permit this read. Sign in again or choose an account you can access.");
    }
    if (!response.ok) { await response.body?.cancel(); throw new Refused(503, "Production is temporarily unavailable. Try again shortly."); }
    return JSON.parse(await boundedText(response, path === "/api/control/events" ? 8 * 1024 * 1024 : 512 * 1024));
  } catch (error) {
    if (error instanceof Refused) throw error;
    throw new Refused(503, "Production did not respond with a bounded trace result. Try again shortly.");
  }
}
async function accounts(env: VoyagerEnv, request: Request, token: string): Promise<Account[]> {
  const data = await production(env, request, token, "/api/control/accounts");
  if (!record(data) || !Array.isArray(data.accounts) || data.accounts.length > 1000) invalidUpstream();
  return data.accounts.map((value: unknown) => {
    if (!record(value) || typeof value.account !== "string" || !safeUserId(value.account) ||
        typeof value.foreground !== "string" || threadBinding(value.foreground)?.owner !== value.account ||
        typeof value.threads !== "number" || !Number.isSafeInteger(value.threads) || value.threads < 0) invalidUpstream();
    return { account: value.account, foreground: value.foreground, threads: value.threads };
  });
}
async function threads(env: VoyagerEnv, request: Request, token: string, owner: string) {
  const data = await production(env, request, token, "/api/control/threads", { account: owner });
  if (!record(data) || data.account !== owner || !Array.isArray(data.threads) || data.threads.length > 1000) invalidUpstream();
  return data.threads.map((value: unknown) => {
    if (!record(value) || typeof value.id !== "string" || threadBinding(value.id)?.owner !== owner) invalidUpstream();
    // The control API exposes explicit owner roots, not arbitrary native children.
    return { id: value.id, depth: 0 };
  });
}
async function events(env: VoyagerEnv, request: Request, token: string, thread: string, after: number, limit: number): Promise<EventPage> {
  const data = await production(env, request, token, "/api/control/events", { thread, after: String(after), limit: String(limit) });
  if (!record(data) || data.thread !== thread || !Array.isArray(data.events) || data.events.length > limit ||
      typeof data.hasMore !== "boolean" || !Number.isSafeInteger(data.nextAfter)) invalidUpstream();
  let previous = after;
  const rows = data.events.map((value: unknown): Row => {
    if (!record(value) || typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq <= previous ||
        !record(value.event) || typeof value.event.type !== "string") invalidUpstream();
    previous = value.seq;
    return { seq: value.seq, event: value.event as Row["event"] };
  });
  if (data.nextAfter !== previous || (data.hasMore && rows.length === 0)) invalidUpstream();
  return { events: rows, hasMore: data.hasMore, nextAfter: previous };
}
const sse = (frames: readonly { seq: number; event: unknown }[], retry: number) => new Response(
  `retry: ${retry}\n\n${frames.map(row => `id: ${row.seq}\ndata: ${JSON.stringify(row.event)}\n\n`).join("")}: snapshot complete\n\n`,
  { headers: { "content-type": "text/event-stream; charset=utf-8" } },
);

async function handle(request: Request, env: VoyagerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (request.headers.has("origin") && request.headers.get("origin") !== url.origin)
    return problem(403, "Open this viewer directly to sign in or read production traces.");
  if (["/session", "/logout"].includes(url.pathname) && request.method === "POST") {
    if (request.headers.get("origin") !== url.origin) return problem(403, "A same-origin sign-in request is required.");
    query(url, []);
    if (url.pathname === "/logout") return request.headers.get("accept") === "application/json"
      ? Response.json({ status: "signed_out" }, { headers: { "set-cookie": voyagerCookie("", 0) } })
      : redirect("/login", voyagerCookie("", 0));
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") return problem(400, "Submit a token as JSON.");
    let body: unknown;
    try { body = JSON.parse(await boundedText(new Response(request.body), 1024)); }
    catch { return problem(400, "The sign-in request is not valid."); }
    if (!record(body) || Object.keys(body).join(",") !== "token" || !validVoyagerToken(body.token)) return problem(400, "Enter your account or operator token.");
    await production(env, request, body.token, "/v1/status");
    const sealed = await sealVoyagerSession(env.AIKO_VOYAGER_SESSION_KEY, url.origin, body.token);
    return Response.json({ status: "signed_in" }, { headers: { "set-cookie": voyagerCookie(sealed) } });
  }
  // Fail before reading credentials or making any production request. There is
  // intentionally no pass-through route for native invocation, append or replay.
  if (request.method !== "GET") {
    const response = problem(405, "This is a read-only production viewer. Execution and configuration changes are disabled.");
    response.headers.set("allow", "GET");
    return response;
  }
  if (url.pathname === "/healthz") return Response.json({ viewer: "native-voyager", readOnly: true, upstream: "production", status: "configured" });
  if (url.pathname === "/login") return html(VOYAGER_LOGIN);
  if (url.pathname === "/docs") return html(VOYAGER_HELP);
  if (/^\/assets\/[A-Za-z0-9_.-]+\.(?:js|css|woff2?)$/.test(url.pathname)) {
    query(url, []);
    return env.VOYAGER_ASSETS.fetch(new Request(new URL(url.pathname, url.origin)));
  }
  const session = await openVoyagerSession(env.AIKO_VOYAGER_SESSION_KEY, request);
  if (!session) return url.pathname.startsWith("/v1/") || url.pathname === "/session"
    ? problem(401, "Your viewer session ended. Sign in again at /login.") : redirect("/login", voyagerCookie("", 0));
  if (url.pathname === "/session") {
    query(url, []);
    await production(env, request, session.token, "/v1/status");
    return Response.json({ status: "signed_in", expiresAt: session.expiresAt });
  }
  if (url.pathname === "/accounts") { query(url, []); return html(voyagerAccounts(await accounts(env, request, session.token))); }
  if (url.pathname === "/") {
    query(url, ["actor", "thread", "view", "from", "to"]);
    const owner = url.searchParams.get("actor"), thread = url.searchParams.get("thread");
    if (!owner) return redirect("/accounts");
    if (!safeUserId(owner) || (thread && threadBinding(thread)?.owner !== owner)) return problem(403, "Choose an account and a control thread available to your credential.");
    // Recheck the selected account on page navigation, not just at sign-in.
    await threads(env, request, session.token, owner);
    return env.VOYAGER_ASSETS.fetch(new Request(new URL("/index.html", url.origin)));
  }
  if (url.pathname === "/v1/metadata") {
    query(url, []);
    await production(env, request, session.token, "/v1/status");
    return Response.json({ name: "aiko", storage: { kind: "cloudflare-durable-object", location: env.AIKO_PRODUCTION_URL } });
  }
  if (url.pathname === "/v1/actors") {
    query(url, []);
    return Response.json((await accounts(env, request, session.token)).map(account => ({ id: account.account, definition: "aiko" })));
  }
  const route = /^\/v1\/actors\/([^/]+)\/threads(?:\/([^/]+)(?:\/(events)(\/stream)?)?)?$/.exec(url.pathname);
  if (!route) return problem(404, "This native endpoint is not exposed by the read-only viewer. See /docs for its scope.");
  let owner: string, thread: string | undefined;
  try { owner = decodeURIComponent(route[1]!); thread = route[2] === undefined ? undefined : decodeURIComponent(route[2]); }
  catch { return problem(400, "Invalid actor or thread identifier."); }
  if (!safeUserId(owner)) return problem(400, "Invalid account identifier.");
  if (thread === "stream" && !route[3]) {
    query(url, ["after"]);
    integer(url.searchParams.get("after"), 0);
    const snapshot = await threads(env, request, session.token, owner);
    // A complete snapshot needs no retained stream cursor. Closing each bounded
    // read lets EventSource reconnect and production reauthorize every refresh.
    return sse([{ seq: 0, event: { type: "ThreadsSnapshot", threads: snapshot } }], 10_000);
  }
  if (!thread || !route[3]) return problem(404, "Choose a production control thread in Voyager.");
  if (threadBinding(thread)?.owner !== owner) return problem(403, "That thread does not belong to this account, or is not exposed by the control API.");
  query(url, ["after", "limit"]);
  const after = Math.max(integer(url.searchParams.get("after"), 0), route[4] ? integer(request.headers.get("last-event-id"), 0) : 0);
  const limit = integer(url.searchParams.get("limit"), 100, 100);
  if (limit < 1) return problem(400, "Page size must be between 1 and 100.");
  const page = await events(env, request, session.token, thread, after, limit);
  return route[4] ? sse(page.events, page.hasMore ? 250 : 3000) : Response.json(page.events);
}

export default {
  async fetch(request: Request, env: VoyagerEnv): Promise<Response> {
    try { return protect(await handle(request, env)); }
    catch (error) {
      // Never report provider response bodies, session cookies, or bearer values.
      const status = error instanceof Refused ? error.status : 503;
      const detail = error instanceof Refused ? error.message : "The viewer is temporarily unavailable. Try again shortly.";
      if (request.method === "GET" && ["/", "/accounts"].includes(new URL(request.url).pathname))
        return protect(new Response(voyagerErrorPage(detail), { status, headers: { "content-type": "text/html; charset=utf-8" } }));
      return protect(problem(status, detail));
    }
  },
};
