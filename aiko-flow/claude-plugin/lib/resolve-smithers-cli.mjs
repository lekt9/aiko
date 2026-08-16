// Resolve the Smithers CLI without letting an installed plugin escape to a
// mutable checkout or the network.
//
// The native plugin loader supplies GROK_PLUGIN_ROOT (or CLAUDE_PLUGIN_ROOT).
// When present, that packaged runtime is authoritative: it is checked before cwd
// and AIKO_SMITHERS_RUNTIME, and an incomplete package is refused rather than
// falling through to bunx. Outside an installed plugin, developers still get the
// nearest source checkout and may explicitly select another checkout.
//
// Dependency-free (Node built-ins only): this module is copied verbatim into
// every plugin directory that ships standalone. `scripts/check-local-smithers.mjs`
// enforces that the copies stay byte-identical.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Entry point of the CLI inside a source checkout, relative to the repo root. */
export const SOURCE_CLI_ENTRY = "apps/cli/src/index.js";

/** `name` of the monorepo root manifest; the marker that identifies a checkout. */
export const SOURCE_ROOT_PACKAGE_NAME = "smithers-monorepo";

/**
 * True when `directory` is the root of a Smithers source checkout. Both the
 * CLI entry and the root manifest name must match, so an unrelated project
 * that happens to contain `apps/cli/` is never mistaken for one.
 *
 * @param {string} directory
 */
export function isSmithersSourceRoot(directory) {
  if (!existsSync(join(directory, SOURCE_CLI_ENTRY))) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    return manifest?.name === SOURCE_ROOT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/**
 * Walk upward from `from` and return the nearest Smithers source checkout root,
 * or null when there is none.
 *
 * @param {string} from
 * @returns {string | null}
 */
export function findSmithersSourceRoot(from) {
  let current = resolve(from);
  while (true) {
    if (isSmithersSourceRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Refuse a packaged control surface whose pinned operational bytes moved. */
function verifyPackagedIntegrity(pluginRoot) {
  const receiptPath = join(pluginRoot, ".aiko-control-integrity.json");
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(`installed Smithers integrity receipt is missing or invalid: ${error.message}`);
  }
  if (receipt?.format !== 1 || receipt?.name !== "control" || receipt?.abi !== "smithers-control/v1" || typeof receipt?.version !== "string") {
    throw new Error("installed Smithers version/ABI receipt is incompatible");
  }
  const claimedDigest = receipt.digest;
  const unsigned = { ...receipt };
  delete unsigned.digest;
  const receiptDigest = createHash("sha256").update(stableJson(unsigned)).digest("hex");
  if (claimedDigest !== receiptDigest) throw new Error("installed Smithers integrity receipt digest mismatch");
  if (!receipt.files || typeof receipt.files !== "object") throw new Error("installed Smithers integrity file pins are missing");
  for (const [name, expected] of Object.entries(receipt.files)) {
    if (isAbsolute(name)) throw new Error("installed Smithers integrity path is absolute");
    const file = resolve(pluginRoot, name);
    const rel = relative(resolve(pluginRoot), file);
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      throw new Error(`installed Smithers integrity path escapes package: ${name}`);
    }
    let actual;
    try {
      actual = createHash("sha256").update(readFileSync(file)).digest("hex");
    } catch (error) {
      throw new Error(`installed Smithers pinned file is missing (${name}): ${error.message}`);
    }
    if (actual !== expected) throw new Error(`installed Smithers pinned file was modified: ${name}`);
  }
  if (receipt.files["runtime/bun.lock"] !== receipt.dependency_lock_sha256) {
    throw new Error("installed Smithers dependency lock is not pinned by the receipt");
  }
}

/** Rebuild Bun's internal links from packaged topology, never external paths. */
function ensurePackagedDependencyClosure(runtime) {
  const manifestPath = join(runtime, ".aiko-node-links.json");
  let links;
  try {
    links = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`installed Smithers dependency manifest is missing or invalid: ${error.message}`);
  }
  if (!Array.isArray(links) || links.length === 0) {
    throw new Error("installed Smithers dependency manifest is empty");
  }
  const runtimeRoot = resolve(runtime);
  const inside = (path) => {
    const rel = relative(runtimeRoot, path);
    return rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
  };
  let pending = links;
  while (pending.length > 0) {
    const deferred = [];
    for (const row of pending) {
      if (typeof row?.path !== "string" || typeof row?.target !== "string" || isAbsolute(row.path) || isAbsolute(row.target)) {
        throw new Error("installed Smithers dependency manifest contains an absolute or invalid link");
      }
      const link = resolve(runtimeRoot, row.path);
      const target = resolve(dirname(link), row.target);
      const dependencyPath = row.path.startsWith("node_modules/") || row.path.includes("/node_modules/");
      if (!inside(link) || !inside(target) || !dependencyPath) {
        throw new Error(`installed Smithers dependency link escapes runtime: ${row.path}`);
      }
      if (existsSync(link)) {
        let current;
        try {
          current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
        } catch {
          current = null;
        }
        if (current !== row.target) throw new Error(`installed Smithers dependency link was replaced: ${row.path}`);
        continue;
      }
      // Some .bin links point through another packaged link. Materialize the
      // target link first, then revisit this row without ever resolving outside.
      if (!existsSync(target)) {
        deferred.push(row);
        continue;
      }
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(row.target, link);
    }
    if (deferred.length === pending.length) {
      throw new Error(`installed Smithers dependency targets are missing (${deferred[0].path})`);
    }
    pending = deferred;
  }
}

/**
 * @typedef {object} ResolvedSmithersCli
 * @property {string} command Executable to spawn.
 * @property {string[]} args Leading arguments; append the CLI's own arguments.
 * @property {"packaged" | "workspace"} source Which immutable or development copy this runs.
 * @property {string | null} root Source checkout root, when one was found.
 */

/**
 * @param {string} [from] Directory to resolve from (defaults to the cwd).
 * @returns {ResolvedSmithersCli}
 */
export function resolveSmithersCli(from = process.cwd()) {
  const pluginRoot = process.env.GROK_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  if (pluginRoot) {
    const packagedRuntime = join(pluginRoot, "runtime");
    verifyPackagedIntegrity(pluginRoot);
    if (!isSmithersSourceRoot(packagedRuntime)) {
      throw new Error(`installed Smithers runtime is incomplete: ${packagedRuntime}`);
    }
    ensurePackagedDependencyClosure(packagedRuntime);
    return {
      command: "bun",
      args: [join(packagedRuntime, SOURCE_CLI_ENTRY)],
      source: "packaged",
      root: packagedRuntime,
    };
  }
  const root = findSmithersSourceRoot(from);
  if (root) {
    return { command: "bun", args: [join(root, SOURCE_CLI_ENTRY)], source: "workspace", root };
  }
  const explicitRuntime = process.env.AIKO_SMITHERS_RUNTIME;
  if (explicitRuntime && isSmithersSourceRoot(explicitRuntime)) {
    return {
      command: "bun",
      args: [join(explicitRuntime, SOURCE_CLI_ENTRY)],
      source: "workspace",
      root: explicitRuntime,
    };
  }
  throw new Error("Smithers runtime not found; install the Aiko control package or run inside its source checkout");
}

/**
 * POSIX-quote a single shell word.
 *
 * @param {string} value
 */
function shellQuote(value) {
  return /^[A-Za-z0-9_\-./:=]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The same resolution as {@link resolveSmithersCli}, rendered as a shell
 * command prefix for scripts and agent prompts that build command strings.
 *
 * @param {string} [from]
 * @returns {string}
 */
export function resolveSmithersShellCommand(from = process.cwd()) {
  const { command, args } = resolveSmithersCli(from);
  return [command, ...args].map(shellQuote).join(" ");
}
