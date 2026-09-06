/** Offline source/dependency check. No fetch, install, source execution or store access.
 * Hashes detect drift, not a maliciously rewritten manifest. --upstream additionally
 * compares the pinned Git tree in an explicitly supplied local checkout (never HEAD).
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

export function verifyLibraryFiles(directory: string) {
  const provenance = json(join(directory, "provenance.json"));
  check(provenance.schema === "unlock/entity-learn-source/v1" &&
    provenance.repository === "https://github.com/lekt9/entity-learn-private" &&
    /^[a-f0-9]{40}$/.test(provenance.commit) && /^[a-f0-9]{40}$/.test(provenance.libTree), "Invalid entity-learn source pin");
  check(provenance.files && typeof provenance.files === "object" && !Array.isArray(provenance.files), "Missing source hashes");
  const files = Object.keys(provenance.files).sort();
  check(files.length > 0 && files.every(p => /^lib\/[a-z-]+\.ts$/.test(p) && /^[a-f0-9]{64}$/.test(provenance.files[p])), "Invalid source paths/hashes");
  check(!lstatSync(join(directory, "lib")).isSymbolicLink(), "Library directory must not be a symlink");
  const actual = readdirSync(join(directory, "lib")).map(p => `lib/${p}`).sort();
  check(JSON.stringify(actual) === JSON.stringify(files), "entity-learn source file set drifted");
  for (const file of files) {
    const path = join(directory, file); const stat = lstatSync(path);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, `Unsafe library source: ${file}`);
    check(digest(readFileSync(path)) === provenance.files[file], `entity-learn source drift: ${file}`);
  }
  return { provenance, files };
}

export function verifyEntityLearn(root = workspace, upstream?: string) {
  const directory = join(root, "packages/entity-learn");
  const { provenance, files } = verifyLibraryFiles(directory);
  const pkg = json(join(directory, "package.json"));
  check(pkg.name === "entity-learn" && pkg.version === provenance.version && pkg.private === true, "Unexpected workspace package identity");
  check(JSON.stringify(pkg.exports) === JSON.stringify({
    ".": { workerd: "./lib/cloudflare.ts", default: "./lib/index.ts" },
    "./cloudflare": "./lib/cloudflare.ts",
  }), "Only the portable core is exported; the Tardie 0.5 adapter must stay unavailable");
  const app = join(root, "apps/agent"); const consumer = json(join(app, "package.json"));
  check(consumer.dependencies["entity-learn"] === "workspace:*", "Agent no longer consumes the checked library");
  check(realpathSync(Bun.resolveSync("entity-learn", app)) === realpathSync(join(directory, "lib/index.ts")), "Agent resolves a different entity-learn copy");
  for (const name of ["tardie", "effect"] as const) {
    const expected = provenance.integration[name];
    check(typeof expected === "string" && consumer.dependencies[name] === expected &&
      json(join(app, `node_modules/${name}/package.json`)).version === expected, `Unverified native ${name} version`);
  }
  if (upstream !== undefined) {
    const git = (...args: string[]) => execFileSync("git", ["-C", resolve(upstream), ...args], {
      encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10_000,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    }).trim();
    check(git("rev-parse", `${provenance.commit}:lib`) === provenance.libTree, "Pinned upstream library tree mismatch");
    check(JSON.stringify(git("ls-tree", "-r", "--name-only", provenance.commit, "lib").split("\n").sort()) === JSON.stringify(files), "Upstream file set differs");
    for (const file of files) {
      check(git("rev-parse", `${provenance.commit}:${file}`) === git("hash-object", "--no-filters", join(directory, file)), `Upstream bytes differ: ${file}`);
    }
  }
  return { verified: true, repository: provenance.repository, commit: provenance.commit, libTree: provenance.libTree,
    files: files.length, version: pkg.version, integration: provenance.integration, upstreamCompared: upstream !== undefined,
    legacyAdapterExported: false, runtimeDependency: "workspace:*", networkCalls: 0 };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    check(args.length === 0 || (args.length === 2 && args[0] === "--upstream" && args[1]), "Usage: bun scripts/check-entity-learn.ts [--upstream LOCAL_GIT_CHECKOUT]");
    console.log(JSON.stringify(verifyEntityLearn(workspace, args[1]), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "entity-learn verification failed");
    process.exitCode = 1;
  }
}
