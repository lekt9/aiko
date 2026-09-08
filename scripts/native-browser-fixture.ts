/** Local HTTPS fixture for real-Chrome login and request-memory verification.
 * Use only an isolated test browser with explicit fixture-host mappings. */
const key = process.env.UNLOCK_FIXTURE_TLS_KEY;
const cert = process.env.UNLOCK_FIXTURE_TLS_CERT;
if (!key || !cert) throw Error("Fixture TLS files required");
const port = Number(process.env.UNLOCK_FIXTURE_PORT ?? 0);
if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
  throw Error("UNLOCK_FIXTURE_PORT must be an integer from 0 to 65535");
const sessions = new Set<string>();
const form =
  '<form method="post" action="/login"><label>Email<input autocomplete="username" name="username"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form>';
const app =
  '<a href="/logout">Sign out</a><a href="/projects">Projects</a><a href="/projects?id=12">Project 12</a><main>Project review due tomorrow</main>';
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  tls: { key: Bun.file(key), cert: Bun.file(cert) },
  async fetch(request) {
    const url = new URL(request.url);
    if (
      !["replay-fixture.aiko.ai", "login-fixture.aiko.ai"].includes(
        url.hostname,
      )
    )
      return new Response(null, { status: 404 });
    const cookie = request.headers.get("cookie") ?? "";
    const signedIn = [...sessions].some((id) => cookie.includes(`sid=${id}`));
    const html = (text: string, headers: Record<string, string> = {}) =>
      new Response(text, {
        headers: { "Content-Type": "text/html", ...headers },
      });
    if (url.hostname === "replay-fixture.aiko.ai") {
      if (url.pathname === "/")
        return html(app, {
          "Set-Cookie":
            "replay=fixture-only; Path=/; Secure; HttpOnly; SameSite=Lax",
        });
      if (
        url.pathname === "/unauthorized" ||
        !cookie.includes("replay=fixture-only")
      )
        return new Response(null, { status: 401 });
      if (url.pathname === "/redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://other-fixture.aiko.ai/" },
        });
      if (url.pathname === "/items")
        return Response.json({ item: "fresh-item" });
      if (
        url.pathname === "/details" &&
        url.searchParams.get("item") === "fresh-item"
      )
        return Response.json({ name: "TRANSIENT_BROWSER_RESULT" });
    } else {
      if (url.pathname === "/login" && request.method === "POST") {
        const fields = await request.formData();
        if (
          fields.get("username") !== "fixture-user" ||
          fields.get("password") !== "fixture-password"
        )
          return html(form);
        const id = crypto.randomUUID();
        sessions.add(id);
        return new Response(null, {
          status: 303,
          headers: {
            Location: "/",
            "Set-Cookie": `sid=${id}; Path=/; Secure; HttpOnly; SameSite=Lax`,
          },
        });
      }
      if (url.pathname === "/logout") {
        sessions.clear();
        return html(form);
      }
      if (url.pathname === "/" || url.pathname === "/projects")
        return html(signedIn ? app : form);
    }
    return new Response(null, { status: 404 });
  },
});
console.log(`Unlock fixture listening on https://127.0.0.1:${server.port}`);
