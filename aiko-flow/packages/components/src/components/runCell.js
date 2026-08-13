import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Walk from `start` toward filesystem root looking for `cell/run.py`.
 * @param {string} start
 * @returns {string | null}
 */
function walkForRunner(start) {
  let dir = resolve(start);
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, "cell", "run.py");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Locate Cell's canonical runner. Pin with `AIKO_CELL_RUNNER`.
 * Never invent a second builder.
 * @param {{ cwd?: string }} [opts]
 * @returns {string}
 */
export function findCellRunner(opts = {}) {
  const pinned = process.env.AIKO_CELL_RUNNER;
  if (pinned && existsSync(pinned)) return pinned;
  const home = process.env.AIKO_HOME || join(process.env.HOME || "", ".aiko");
  for (const candidate of [
    join(home, "packages", "cell", "current", "run.py"),
    join(home, "cell", "run.py"),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const fromCwd = walkForRunner(opts.cwd ?? process.cwd());
  if (fromCwd) return fromCwd;
  try {
    const fromHere = walkForRunner(fileURLToPath(new URL(".", import.meta.url)));
    if (fromHere) return fromHere;
  } catch {
    // import.meta.url unavailable in some bundles
  }
  throw new Error(
    "cell runner missing: set AIKO_CELL_RUNNER to cell/run.py, or run from a tree that contains cell/",
  );
}

/**
 * Fire a Cell as a Smithers harness step. Returns membrane outputs plus
 * the Merkle manifest. Secrets in Cell inputs are Cell's problem — this
 * wrapper does not add a second auth path.
 *
 * @param {{
 *   cell: string;
 *   inputs?: Record<string, unknown>;
 *   timeoutMs?: number;
 *   cwd?: string;
 * }} opts
 * @returns {Promise<{
 *   outputs: Record<string, unknown>;
 *   manifest: unknown;
 *   digest: string | null;
 *   cell: string;
 * }>}
 */
export async function runCell(opts) {
  const cell = resolve(opts.cwd ?? process.cwd(), opts.cell);
  const runner = findCellRunner({ cwd: opts.cwd ?? process.cwd() });
  const work = await mkdtemp(join(tmpdir(), "smithers-cell-"));
  const inputsPath = join(work, "inputs.json");
  const outDir = join(work, "out");
  try {
    await writeFile(inputsPath, JSON.stringify(opts.inputs ?? {}), "utf8");

    await new Promise((resolvePromise, reject) => {
      const child = spawn("python3", [runner, "run", cell, "--inputs", inputsPath, "--out", outDir], {
        cwd: opts.cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`cell timed out after ${opts.timeoutMs ?? 60_000}ms: ${cell}`));
      }, opts.timeoutMs ?? 60_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`cell run failed (${code}): ${stderr.trim() || cell}`));
          return;
        }
        resolvePromise(undefined);
      });
    });

    const outputs = {};
    let manifest = null;
    let digest = null;
    const names = await readdir(outDir).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const value = JSON.parse(await readFile(join(outDir, name), "utf8"));
      if (name === "manifest.json") {
        manifest = value;
        if (value && typeof value === "object" && typeof value.digest === "string") {
          digest = value.digest;
        }
        continue;
      }
      outputs[name.slice(0, -".json".length)] = value;
    }
    return { outputs, manifest, digest, cell };
  } finally {
    // Inputs may contain account material. A native workflow element must not
    // turn its scratch directory into a second credential store.
    await rm(work, { recursive: true, force: true });
  }
}
