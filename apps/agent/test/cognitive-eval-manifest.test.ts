import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cognitiveSource } from "../scripts/cognitive-eval/manifest.ts";

test("evaluation manifest detects added/deleted workspace source, exported dist and linked browser drift", async () => {
  const root = await mkdtemp("/tmp/cognitive-manifest-");
  const put = async (path: string, data = "{}") => {
    const full = join(root, path); await mkdir(join(full, ".."), { recursive: true }); await writeFile(full, data);
  };
  try {
    for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/agent/package.json", "apps/agent/tsconfig.json", "apps/server/package.json", "apps/server/certs/supabase-prod-ca-2021.crt", "apps/agent/scripts/cognitive-eval/tsconfig.json", "scripts/telegram-eval/evaluator.py", "linked-browser/package.json"])
      await put(path);
    for (const path of ["apps/agent/src", "apps/agent/assets", "apps/server/src", "packages/protocol/src", "drizzle", "apps/agent/node_modules/@unbrowse"])
      await mkdir(join(root, path), { recursive: true });
    await symlink(join(root, "linked-browser"), join(root, "apps/agent/node_modules/@unbrowse/browser-harness"));
    const initial = await cognitiveSource(root);
    expect(initial.files["@dependency/browser-harness/package.json"]).toBeDefined();
    await put("packages/protocol/src/new.ts", "export const value = 1;");
    expect((await cognitiveSource(root)).digest).not.toBe(initial.digest);
    await rm(join(root, "packages/protocol/src/new.ts"));
    expect((await cognitiveSource(root)).digest).toBe(initial.digest);
    await put("packages/protocol/dist/index.js", "export const value = 2;");
    const compiled = await cognitiveSource(root);
    expect(compiled.files["packages/protocol/dist/index.js"]).toBeDefined();
    await put("linked-browser/src/har.ts", "export const version = 3;");
    const linked = await cognitiveSource(root);
    expect(linked.digest).not.toBe(compiled.digest);
    expect(linked.files["@dependency/browser-harness/src/har.ts"]).toBeDefined();
    await put("apps/server/src/crypto.ts", "export const version = 4;");
    expect((await cognitiveSource(root)).digest).not.toBe(linked.digest);
  } finally { await rm(root, { recursive: true, force: true }); }
});
