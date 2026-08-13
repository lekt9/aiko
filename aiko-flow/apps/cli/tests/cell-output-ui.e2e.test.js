import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { delimiter } from "node:path";
import { createTempRepo, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const require = createRequire(import.meta.url);
function chromium() {
  const browser = require("playwright").chromium;
  if (!existsSync(browser.executablePath()))
    throw new Error("Playwright Chromium is required for the Cell UI acceptance witness");
  return browser;
}
function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
async function waitForHealth(base) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/health`)).ok) return;
    } catch {}
    await Bun.sleep(250);
  }
  throw new Error("Gateway did not become healthy");
}

const workflow = `/** @jsxImportSource smthrs */
import { UI, createSmithers } from "smthrs";
import { z } from "zod/v4";
const { Workflow, Task, smithers, outputs } = createSmithers({
  result: z.object({ roster: z.array(z.object({ worker: z.string(), role: z.string() })) }),
});
export default smithers(() => (
  <Workflow name="cell-output-e2e">
    <UI entry="../ui/cell-output-e2e.tsx" title="Cell output" />
    <Task id="produce-roster" output={outputs.result}>{async () => ({ roster: [{ worker: "Durable Ada 731", role: "operator" }] })}</Task>
  </Workflow>
));
`;
const ui = `/** @jsxImportSource react */
import { createGatewayReactRoot, runIdFromUrl } from "smthrs/gateway-react";
import { CellWorkflowUi } from "smthrs/cell-ui";
const cell = { metadata: { name: "Staffing Cell", description: "Durable visual membrane" }, spec: { membrane: { outputs: { roster: { schema: { type: "array", items: { type: "object", properties: { worker: { type: "string" }, role: { type: "string" } } } }, render: { type: "table", columns: [{ key: "worker", label: "Worker" }, { key: "role", label: "Role" }] } } } } } };
function App(){ return <div data-testid="cell-output-ui"><CellWorkflowUi cell={cell} runId={runIdFromUrl()} nodeIds={{ "output:roster": "produce-roster" }} /></div>; }
createGatewayReactRoot(<App />);
`;

const gatewaySource = `import { Gateway } from "smthrs";
import { resolve } from "node:path";
import workflow from "./workflows/cell-output-e2e.tsx";
const gateway = new Gateway({ workspaceRoot: process.cwd() });
gateway.register("cell-output-e2e", workflow, { entryFile: resolve(".smithers/workflows/cell-output-e2e.tsx") });
await gateway.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? "7331") });
`;

test("Cell visual membrane renders a real durable Smithers node output", async () => {
  const repo = createTempRepo();
  const env = {
    HOME: repo.dir,
    PATH: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
  expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);
  repo.write(".smithers/workflows/cell-output-e2e.tsx", workflow);
  repo.write(".smithers/ui/cell-output-e2e.tsx", ui);
  repo.write(".smithers/gateway.ts", gatewaySource);
  const run = runSmithers(["workflow", "cell-output-e2e"], { cwd: repo.dir, format: "json", env, timeoutMs: 120_000 });
  expect(run.exitCode, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(typeof run.json?.runId).toBe("string");
  const port = await findOpenPort();
  const base = `http://127.0.0.1:${port}`;
  const gateway = spawn(process.execPath, ["run", ".smithers/gateway.ts"], {
    cwd: repo.dir,
    env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let gatewayLog = "";
  gateway.stdout.on("data", (chunk) => (gatewayLog += chunk));
  gateway.stderr.on("data", (chunk) => (gatewayLog += chunk));
  let browser;
  try {
    await waitForHealth(base);
    const response = await fetch(`${base}/v1/rpc/listWorkflows`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filter: { hasUi: true } }),
    });
    const listed = await response.json();
    expect(listed.ok).toBe(true);
    expect(listed.payload).toContainEqual(
      expect.objectContaining({ key: "cell-output-e2e", hasUi: true, uiPath: "/workflows/cell-output-e2e" }),
    );
    browser = await chromium().launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${base}/workflows/cell-output-e2e?runId=${run.json.runId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="cell-output-ui"]', { timeout: 30_000 }).catch(async (error) => {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "<unreadable body>");
      throw new Error(
        `${error.message}\nGateway log:\n${gatewayLog}\nBrowser body:\n${body}\nPage errors:\n${errors.join("\n")}`,
      );
    });
    await page
      .waitForFunction(() => document.body.textContent?.includes("Durable Ada 731"), undefined, { timeout: 30_000 })
      .catch(async (error) => {
        const body = await page
          .locator("body")
          .innerText()
          .catch(() => "<unreadable body>");
        throw new Error(
          `${error.message}\nGateway log:\n${gatewayLog}\nBrowser body:\n${body}\nPage errors:\n${errors.join("\n")}`,
        );
      });
    expect(await page.locator("table").textContent()).toContain("operator");
    expect(errors).toEqual([]);
  } finally {
    try {
      await browser?.close();
    } catch {}
    try {
      gateway.kill("SIGTERM");
    } catch {}
  }
}, 180_000);
