import { expect, test } from "bun:test";
import { handleDemoRequest } from "../apps/web/src/server/demo.ts";

// This checks the machine-readable capture contract, not a real web build.
// All mutations stay inside this process's synthetic demo module.
test("HTTP evidence mode emits one complete JSON report without progress text", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return handleDemoRequest(request);
    if (path === "/not-a-real-page") return new Response("Not found", { status: 404 });
    return new Response('<html lang="en"></html>', { headers: { "content-type": "text/html" } });
  } });
  const child = Bun.spawn(["node", "scripts/http-smoke.mjs", "--json"], {
    cwd: new URL("../", import.meta.url).pathname,
    env: { PATH: process.env.PATH!, UNLOCK_BASE_URL: server.url.origin },
    stdout: "pipe", stderr: "pipe",
  });
  const deadline = setTimeout(() => child.kill(), 15_000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, stderr).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.origin).toBe(server.url.origin);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThan(0);
    expect(report.checks).toHaveLength(report.passed);
    expect(stdout).not.toContain("PASS:");
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill();
    await child.exited;
    await server.stop(true);
  }
}, 20_000);
