import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { harnessDigest } from "../../src/harness-library.ts";

export const sourceScope = "Agent/server/database-client source, agent assets and evaluation drivers/grader; workspace package source, existing exported dist files and manifests; resolved browser-harness source; lock and build configuration. Installed registry package bytes are not copied into this digest.";

/** Re-enumerate on every capture: added/deleted source files are drift too.
 * Workspace and linked runtime source must not hide behind an unchanged lock. */
export async function cognitiveSource(root: string) {
  const files: Record<string, string> = {};
  const add = async (key: string, path: string) => { files[key] = createHash("sha256").update(await readFile(path)).digest("hex"); };
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/agent/package.json", "apps/agent/tsconfig.json", "apps/server/package.json", "apps/server/certs/supabase-prod-ca-2021.crt", "apps/agent/scripts/cognitive-eval/tsconfig.json", "scripts/telegram-eval/evaluator.py"])
    await add(path, join(root, path));
  for (const base of ["apps/agent/src", "apps/server/src", "apps/agent/assets", "apps/agent/scripts/cognitive-eval", "packages", "drizzle"])
    for (const path of await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(root, base), onlyFiles: true }))) {
      if (path.split("/").some(p => ["node_modules", ".git"].includes(p))) continue;
      if (base.endsWith("assets") || /\.(ts|tsx|js|mjs|json|py)$/.test(path)) await add(`${base}/${path}`, join(root, base, path));
    }
  const browser = await realpath(resolve(root, "apps/agent/node_modules/@unbrowse/browser-harness"));
  // Separate globs: Bun's brace alternation across slash depths can silently
  // produce an empty result. A linked package must include its manifest.
  await add("@dependency/browser-harness/package.json", join(browser, "package.json"));
  for (const pattern of ["*.ts", "src/**/*.ts"])
    for (const path of await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: browser, onlyFiles: true })))
      await add(`@dependency/browser-harness/${path}`, join(browser, path));
  return { files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))), digest: harnessDigest(files) };
}

if (import.meta.main) console.log(JSON.stringify(await cognitiveSource(resolve(import.meta.dir, "../../../.."))));
