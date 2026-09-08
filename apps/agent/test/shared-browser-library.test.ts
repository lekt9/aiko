import { createRequire } from "node:module";
import { expect, test } from "bun:test";
import { existsSync, realpathSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentBrowserClient } from "@unbrowse/browser-harness/client";
import { prepareTrustedNetworkEntries } from "@unbrowse/browser-harness/network-observation";

const root = resolve(import.meta.dir, "../../..");
const shared = resolve(root, "../unbrowse-playground/runtime");

test("both Unlock import contexts resolve the live sibling library, not a snapshot", async () => {
  const manifest = JSON.parse(readFileSync(resolve(shared, "package.json"), "utf8"));
  for (const [file, link] of [
    ["package.json", "link:../unbrowse-playground/runtime"],
    ["apps/agent/package.json", "link:../../../unbrowse-playground/runtime"],
  ] as const) {
    const packagePath = resolve(root, file);
    expect(JSON.parse(readFileSync(packagePath, "utf8")).dependencies["@unbrowse/browser-harness"]).toBe(link);
    const require = createRequire(packagePath);
    for (const [name, path] of Object.entries(manifest.exports)) {
      const specifier = `@unbrowse/browser-harness${name === "." ? "" : name.slice(1)}`;
      expect(realpathSync(require.resolve(specifier))).toBe(realpathSync(resolve(shared, path as string)));
    }
  }
  const client = await import(pathToFileURL(resolve(shared, "src/agent-browser-client.ts")).href);
  const observation = await import(pathToFileURL(resolve(shared, "src/trusted-network.ts")).href);
  expect(AgentBrowserClient).toBe(client.AgentBrowserClient);
  expect(prepareTrustedNetworkEntries).toBe(observation.prepareTrustedNetworkEntries);
  expect(existsSync(resolve(root, "packages/browser-runtime"))).toBe(false);
  expect(existsSync(resolve(root, "packages/browser-harness"))).toBe(false);
});

test("the detached Codegraff bundle uses shared primitives without the playground agent loop", async () => {
  // Match the production build's clean process and module-resolution context.
  const child = Bun.spawn([process.execPath, "-e", `
    const { realpathSync } = await import("node:fs");
    const sharedClient = realpathSync("../unbrowse-playground/runtime/src/agent-browser-client.ts");
    const options = {entrypoints:["apps/agent/src/sandbox-runner.ts"], target:"bun", external:["@huggingface/transformers"], minify:true, metafile:true};
    const result = await Bun.build(options);
    if (!result.success) throw new Error(result.logs.map(String).join("\\n"));
    // Simulate a shared-source edit during compilation only; never modify either checkout or execute the bundle.
    let visited = false;
    const changed = await Bun.build({...options, plugins:[{name:"shared-source-edit-probe", setup(build) {
      build.onLoad({filter:/agent-browser-client\\.ts$/}, async args => {
        if (realpathSync(args.path) !== sharedClient) return;
        visited = true;
        return {contents: await Bun.file(args.path).text() + '\\nconsole.info("shared-source-edit-probe");', loader:"ts"};
      });
    }}]});
    if (!changed.success) throw new Error(changed.logs.map(String).join("\\n"));
    const digest = async output => new Bun.CryptoHasher("sha256").update(await output.arrayBuffer()).digest("hex");
    console.log(JSON.stringify({inputs:Object.keys(result.metafile.inputs), visited,
      original:await digest(result.outputs[0]), changed:await digest(changed.outputs[0])}));
  `], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const evidence = JSON.parse(stdout) as { inputs: string[]; visited: boolean; original: string; changed: string };
  expect(evidence.visited).toBe(true);
  expect(evidence.changed).not.toBe(evidence.original);
  const inputs = new Set(evidence.inputs.map(path => realpathSync(resolve(root, path))));
  for (const file of ["agent-browser-client", "cdp-network-listener", "observed-network", "trusted-network", "har-facts"]) {
    expect(inputs.has(realpathSync(resolve(shared, `src/${file}.ts`)))).toBe(true);
  }
  expect([...inputs].some(path => /\/packages\/browser-(runtime|harness)\//.test(path))).toBe(false);
  expect(inputs.has(realpathSync(resolve(root, "apps/agent/src/cdp-background-listener.ts")))).toBe(true);
  expect([...inputs].some(path => path === resolve(shared, "src/agent-browser-agent.ts") || path === resolve(shared, "browse-thread.ts"))).toBe(false);
  const oldTardie = realpathSync(resolve(shared, "node_modules/tardie"));
  expect([...inputs].some(path => path.startsWith(`${oldTardie}/`))).toBe(false);
}, 30_000);
