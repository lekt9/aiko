// Local-only QA fixture. Chrome maps replay-fixture.aiko.ai to this listener.
Bun.serve({
  hostname: "127.0.0.1",
  port: 8190,
  tls: {
    key: Bun.file("/tmp/aiko-replay-qa.key"),
    cert: Bun.file("/tmp/aiko-replay-qa.crt"),
  },
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/")
      return new Response("<h1>Request replay fixture</h1>", {
        headers: {
          "content-type": "text/html",
          "set-cookie":
            "session=fixture-session; HttpOnly; SameSite=Strict; Path=/",
        },
      });
    if (url.pathname === "/redirect")
      return Response.redirect("https://other-fixture.aiko.ai/", 302);
    if (
      url.pathname === "/unauthorized" ||
      !request.headers.get("cookie")?.includes("session=fixture-session")
    )
      return Response.json({ error: "sign in" }, { status: 401 });
    if (url.pathname === "/items") return Response.json({ item: "fresh-item" });
    if (
      url.pathname === "/details" &&
      url.searchParams.get("item") === "fresh-item"
    )
      return Response.json({ name: "TRANSIENT_BROWSER_RESULT" });
    return new Response(null, { status: 404 });
  },
});
