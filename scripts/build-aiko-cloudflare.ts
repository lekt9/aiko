import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
export const agentDirectory = join(root, "apps/agent");
export const wranglerConfig = resolve(process.env.AIKO_WRANGLER_CONFIG ?? join(agentDirectory, "wrangler.jsonc"));

export async function buildCloudflare() {
  for (const name of ["@unlock/protocol", "@unlock/sdk"]) {
    const child = Bun.spawn(["pnpm", "--filter", name, "build"], { cwd: root, stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error(`Dependency build failed: ${name}`);
  }
  const runner = await Bun.build({
    entrypoints: [join(agentDirectory, "src/sandbox-runner.ts")],
    target: "bun", external: ["@huggingface/transformers"], minify: true,
  });
  if (!runner.success) throw new AggregateError(runner.logs, "Trusted browser runner build failed");
  await mkdir(join(agentDirectory, "assets"), { recursive: true });
  await Bun.write(join(agentDirectory, "assets/runner.txt"), runner.outputs[0]!);
  const compute=await Bun.build({entrypoints:[join(agentDirectory,"src/compute-runner-main.ts")],target:"bun",minify:true});
  if(!compute.success)throw new AggregateError(compute.logs,"Trusted compute runner build failed");
  await Bun.write(join(agentDirectory,"assets/compute-runner.txt"),compute.outputs[0]!);
  const coding=await Bun.build({entrypoints:[join(agentDirectory,"src/coding-workspace-main.ts")],target:"bun",minify:true});
  if(!coding.success)throw new AggregateError(coding.logs,"Trusted coding workspace runner build failed");
  await Bun.write(join(agentDirectory,"assets/coding-runner.txt"),coding.outputs[0]!);
  for (const args of [
    ["pnpm", "--filter", "@unlock/web", "exec", "vite", "build", "--config", "vite.connectors.config.ts"],
    ["pnpm", "exec", "tsc", "--noEmit", "-p", "tsconfig.cloudflare.json"],
    ["pnpm", "exec", "wrangler", "deploy", "--config", wranglerConfig, "--dry-run"],
  ]) {
    const child = Bun.spawn(args, { cwd: agentDirectory, stdout: "inherit", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error(`Cloud build failed: ${args.slice(0, 4).join(" ")}`);
  }
}
if (import.meta.main) await buildCloudflare();
