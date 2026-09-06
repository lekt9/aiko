import { expect, test } from "bun:test";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AgentBrowserClient } from "@unbrowse/browser-harness/client";
import { prepareTrustedNetworkEntries } from "@unbrowse/browser-harness/network-observation";

const root = resolve(import.meta.dir, "../../..");
const shared = resolve(root, "../unbrowse-playground/runtime");

test("Unlock imports the exact playground modules, with no vendored runtime fallback", async () => {
  const manifest = JSON.parse(readFileSync(resolve(shared, "package.json"), "utf8"));
  for (const name of ["client", "trace", "network-listener", "network-observation", "network-compiler", "network-facts", "har", "harness-runtime", "network-tool-catalog", "harness-artifact", "response-semantics"]) {
    const resolved = fileURLToPath(import.meta.resolve(`@unbrowse/browser-harness/${name}`));
    expect(realpathSync(resolved)).toBe(realpathSync(resolve(shared, manifest.exports[`./${name}`])));
  }
  const client = await import(pathToFileURL(resolve(shared, "src/agent-browser-client.ts")).href);
  const observation = await import(pathToFileURL(resolve(shared, "src/trusted-network.ts")).href);
  expect(AgentBrowserClient).toBe(client.AgentBrowserClient);
  expect(prepareTrustedNetworkEntries).toBe(observation.prepareTrustedNetworkEntries);
  expect(existsSync(resolve(root, "packages/browser-runtime"))).toBe(false);
});

test("the detached Codegraff bundle uses shared primitives without the playground agent loop", async () => {
  // Match the production build's clean process and module-resolution context.
  const child = Bun.spawn([process.execPath, "-e", `
    const result = await Bun.build({entrypoints:["apps/agent/src/sandbox-runner.ts"], target:"bun", external:["@huggingface/transformers"], minify:true, metafile:true});
    if (!result.success) throw new Error(result.logs.map(String).join("\\n"));
    console.log(JSON.stringify(Object.keys(result.metafile.inputs)));
  `], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const inputs = new Set((JSON.parse(stdout) as string[]).map(path => realpathSync(resolve(root, path))));
  for (const file of ["agent-browser-client", "cdp-network-listener", "observed-network", "trusted-network", "har-facts"]) {
    expect(inputs.has(realpathSync(resolve(shared, `src/${file}.ts`)))).toBe(true);
  }
  expect([...inputs].some(path => path.includes("/packages/browser-runtime/"))).toBe(false);
  expect([...inputs].some(path => path === resolve(shared, "src/agent-browser-agent.ts") || path === resolve(shared, "browse-thread.ts"))).toBe(false);
  expect([...inputs].some(path => /\/tardie@0\.17\./.test(path))).toBe(false);
}, 30_000);
