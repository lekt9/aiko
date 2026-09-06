import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "entity-learn";
import { verifyEntityLearn, verifyLibraryFiles } from "../../../scripts/check-entity-learn.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageDir = join(root, "packages/entity-learn");
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

test("the native agent resolves the pinned complete core, not an old tarball or Tardie 0.5 adapter", () => {
  expect(verifyEntityLearn(root)).toMatchObject({ verified: true, legacyAdapterExported: false, networkCalls: 0,
    integration: { tardie: "0.22.0", effect: "4.0.0-rc.110" } });
  for (const name of ["Memory", "Knowledge", "SemanticIndex", "memoryGraph", "renderKnowledgeHtml", "tardigradeLogSource", "openRouterEmbeddings"] as const)
    expect(typeof core[name]).toBe("function");
  expect(() => Bun.resolveSync("entity-learn/tardigrade", join(root, "apps/agent"))).toThrow();
});

test("source verification rejects changed, extra, missing and symlinked files without executing them", async () => {
  const directory = await mkdtemp("/tmp/aiko-memory-dependency-"); temporary.push(directory);
  await cp(join(packageDir, "lib"), join(directory, "lib"), { recursive: true });
  await cp(join(packageDir, "provenance.json"), join(directory, "provenance.json"));
  expect(verifyLibraryFiles(directory).files.length).toBeGreaterThan(20);
  const file = join(directory, "lib/index.ts"); const original = await readFile(file);
  await writeFile(file, "throw new Error('must never execute verification input');");
  expect(() => verifyLibraryFiles(directory)).toThrow("source drift: lib/index.ts");
  await writeFile(file, original);
  const extra = join(directory, "lib/unreviewed.ts"); await writeFile(extra, "");
  expect(() => verifyLibraryFiles(directory)).toThrow("file set drifted"); await rm(extra);
  await rm(file); expect(() => verifyLibraryFiles(directory)).toThrow("file set drifted");
  await symlink(join(packageDir, "lib/index.ts"), file);
  expect(() => verifyLibraryFiles(directory)).toThrow("Unsafe library source");
});
