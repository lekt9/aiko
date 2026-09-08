// Synthetic transport for the shipped console. Never reaches an account host.
(() => {
  const fixture = {
    sends: [] as { id: string; text: string }[],
    commits: new Map<string, string>(),
    messageReads: 0,
    release: (_outcome: "accepted" | "lost") => {},
  };
  Object.assign(window, { consoleFixture: fixture });
  window.fetch = async (input, init) => {
    const path = String(input);
    if (path === "/api/status") return Response.json({ mode: "fixture", model: "synthetic", voice: "exact", toolCallLimit: 0, memory: { engine: "fixture", version: "1" }, gates: [], browser: "disabled", telegram: false });
    if (path === "/api/browser") return Response.json({ enabled: false, pending: [], observations: [] });
    if (path === "/api/messages" && !init?.body) {
      fixture.messageReads++;
      return Response.json({ messages: [...fixture.commits].map(([id, text]) => ({ id, role: "user", text })), pending: [], deliveries: [] });
    }
    if (path === "/api/messages" && init?.body) {
      const sent = JSON.parse(String(init.body)) as { id: string; text: string };
      fixture.sends.push(sent);
      if (fixture.commits.has(sent.id) && fixture.commits.get(sent.id) !== sent.text) throw Error("Fixture ID rebound to different text");
      fixture.commits.set(sent.id, sent.text);
      return new Promise((resolve, reject) => {
        const abort = () => reject(init.signal!.reason);
        init.signal?.addEventListener("abort", abort, { once: true });
        fixture.release = outcome => {
          init.signal?.removeEventListener("abort", abort);
          if (outcome === "lost") reject(new TypeError("Synthetic response lost after save"));
          else resolve(Response.json({ status: "accepted" }));
        };
      });
    }
    throw Error(`Unexpected console fixture request: ${path}`);
  };
})();
