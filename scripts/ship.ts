#!/usr/bin/env bun
/** One hosted release: build -> add/commit/push -> gates -> publish -> readback.
 * A Git checkpoint is not release acceptance. Uncertain publishes are read-only
 * on recovery; they never trigger an automatic second deployment. */
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rename, readdir, lstat, readlink, rm, open, cp } from "node:fs/promises";
import { dirname, join, resolve, relative } from "node:path";
import ts from "typescript";
import { redactor } from "../apps/agent/src/security.ts";
import { buildCloudflare, agentDirectory, wranglerConfig } from "./build-aiko-cloudflare.ts";
import { cloudflareSecrets, cloudflareState, workspaceRoot } from "./cloudflare-paths.ts";
import { prepareCloudflareDeployment, deployCloudflare, type CloudflareRelease } from "./deploy-aiko-cloudflare.ts";

const generated = new Set(["apps/agent/assets/runner.txt", "apps/agent/assets/compute-runner.txt", "apps/agent/assets/coding-runner.txt"]);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const SHIP_CHECKS = [
  ["pnpm", "typecheck"],
  ["pnpm", "exec", "tsc", "--project", "scripts/tsconfig.ship.json"],
  ["pnpm", "test"],
  ["bun", "--no-env-file", "test", "./scripts/ship.test.ts", "./scripts/cloudflare-paths.test.ts"],
  ["pnpm", "test:e2e:aiko"],
  ["pnpm", "aiko:cloud:verify"],
] as const;

export interface ReleaseReceipt {
  version: 1;
  id: string;
  worker: string;
  url: string;
  branch: string;
  remote: string;
  ref: string;
  source: string;
  browserSource: string;
  browserCommit: string;
  browserDirty: boolean;
  commit?: string;
  assets: { path: string; sha256: string; bytes: number }[];
  buildDigest?: string;
  phase: "preparing" | "pushing" | "checking" | "publishing" | "verifying" | "verified";
  checks: string[];
  error?: string;
}

export function shipOptions(args: string[]) {
  const options = { message: "Release hosted Aiko", dryRun: false, verify: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--message" || arg === "-m") {
      const message = args[++i];
      if (!message?.trim() || message.startsWith("--") || /[\x00-\x1f]/.test(message) || message.length > 200) throw Error("Use --message with a nonempty, single-line commit message (up to 200 characters).");
      options.message = message;
    } else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw Error(`Unknown release argument: ${arg}. Run pnpm ship --help.`);
  }
  if (options.dryRun && options.verify) throw Error("Choose --dry-run or --verify, not both.");
  return options;
}

/** Argument arrays only; no shell interpolation. Logs are redacted before disk
 * or terminal output. Timeouts stop only this command's own process group. */
async function command(args: readonly string[], cwd = workspaceRoot, log?: string, redact = (value: string) => value, extraEnv: NodeJS.ProcessEnv = {}) {
  const child = spawn(args[0]!, args.slice(1), { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv, WRANGLER_SEND_METRICS: "false" } });
  const chunks: Buffer[] = [];
  child.stdout.on("data", chunk => chunks.push(chunk));
  child.stderr.on("data", chunk => chunks.push(chunk));
  const stop = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch {} };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let interrupted = false;
  const abort = () => { interrupted = true; stop("SIGTERM"); escalation ??= setTimeout(() => stop("SIGKILL"), 5000); };
  const timer = setTimeout(abort, 30 * 60_000);
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  try {
    const code = await new Promise<number | null>((done, fail) => { child.once("error", fail); child.once("close", done); });
    const output = redact(Buffer.concat(chunks).toString("utf8"));
    if (log) await writeFile(log, output, { mode: 0o600 });
    if (code !== 0 || interrupted) throw Error(`${args[0]} ${args[1] ?? ""} failed (${interrupted ? "interrupted or timed out" : code}).${log ? ` See ${log}.` : ` ${output.slice(-1200)}`}`);
    return output;
  } finally {
    clearTimeout(timer); clearTimeout(escalation);
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
  }
}

const git = (args: readonly string[], cwd = workspaceRoot) => command(["git", ...args], cwd).then(output => args.includes("-z") ? output : output.trim());
export async function sourceSnapshot(root: string, excluded: ReadonlySet<string> = new Set()) {
  const files = [...new Set((await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)).split("\0").filter(Boolean))].sort();
  const leaves: [string, string][] = [];
  for (const file of files) {
    if (excluded.has(file)) continue;
    try {
      const stat = await lstat(join(root, file));
      if (stat.isDirectory()) throw Error(`Nested Git repository requires an explicit release binding: ${file}`);
      leaves.push([file, sha(`${stat.mode}:` + (stat.isSymbolicLink() ? await readlink(join(root, file)) : sha(await readFile(join(root, file))))) ]);
    } catch (error) {
      // An already-deleted file has no source bytes; staging that deletion
      // must not change the source fingerprint.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      else throw error;
    }
  }
  return sha(JSON.stringify(leaves));
}

export function secretProblem(path: string, bytes: Uint8Array, secrets: readonly string[]) {
  const name = path.split("/").at(-1)!;
  if (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|.*\.(?:key|pem|p12|pfx)|id_rsa|id_ed25519)$/i.test(name) && !/\.(?:example|sample|template)$/.test(name)) return "private credential file";
  const text = Buffer.from(bytes).toString("utf8");
  if (secrets.some(value => value.length >= 12 && text.includes(value))) return "configured secret value";
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}/.test(text)) return "private key or access token";
}

export async function scanReleaseFiles(root: string, secrets: readonly string[]) {
  const files = (await git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root)).split("\0").filter(Boolean);
  for (const path of files) {
    let bytes: Buffer;
    try { bytes = (await lstat(join(root, path))).isSymbolicLink() ? Buffer.from(await readlink(join(root, path))) : await readFile(join(root, path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    const problem = secretProblem(path, bytes, secrets);
    if (problem) throw Error(`Refusing to commit ${path}: ${problem}. Remove it from the release; no secret value is shown.`);
  }
}

export async function assetManifest(root: string, base = root): Promise<ReleaseReceipt["assets"]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: ReleaseReceipt["assets"] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await assetManifest(path, base));
    else if (entry.isFile()) { const bytes = await readFile(path); files.push({ path: "/" + relative(base, path).split("/").join("/"), sha256: sha(bytes), bytes: bytes.length }); }
    else throw Error(`Static assets cannot contain symlinks: ${path}`);
  }
  return files;
}

/** Shared by the release and its local prebuilt-Worker witness; no publishing. */
export async function buildReleaseArtifacts(directory: string) {
  const config = ts.parseConfigFileTextToJson(wranglerConfig, await readFile(wranglerConfig, "utf8"));
  if (config.error) throw Error("Invalid Wrangler build configuration.");
  const frozen = join(directory, "built");
  await buildCloudflare({ outdir: join(frozen, "worker") });
  await lstat(join(frozen, "worker/cloudflare.js"));
  await cp(join(agentDirectory, "public"), join(frozen, "public"), { recursive: true, errorOnExist: true, force: false });
  const prebuiltConfig = join(frozen, "wrangler.json");
  await writeFile(prebuiltConfig, JSON.stringify({ ...config.config, main: "worker/cloudflare.js", base_dir: "worker", no_bundle: true,
    find_additional_modules: true, assets: { ...config.config.assets, directory: "./public" } }, null, 2), { mode: 0o600 });
  return { frozen, prebuiltConfig, buildDigest: sha(JSON.stringify(await assetManifest(frozen))), assets: await assetManifest(join(frozen, "public")) };
}

function releaseOrigin(url: string) {
  const origin = new URL(url);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw Error("Release URL must be a bare HTTPS origin.");
  return origin;
}

export async function verifyRelease(receipt: ReleaseReceipt, token: string, fetcher: typeof fetch = fetch) {
  if (!receipt.commit || !receipt.assets.some(asset => asset.path === "/connect.html")) throw Error("Incomplete release receipt; no verified build to compare.");
  const origin = releaseOrigin(receipt.url);
  const request = (path: string, auth = false) => fetcher(new URL(path, origin), {
    headers: auth ? { authorization: `Bearer ${token}` } : {}, redirect: "error", signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  const ready = await request("/ready");
  const health = await ready.json() as { storage?: string; harness?: string; release?: CloudflareRelease };
  if (!ready.ok || health.storage !== "durable-object" || health.harness !== "tardie@0.22.0" ||
      health.release?.id !== receipt.id || health.release.commit !== receipt.commit || health.release.browserSource !== receipt.browserSource)
    throw Error("The destination is not serving this exact release. Do not republish automatically; inspect Wrangler deployments and retry pnpm ship --verify.");
  for (const asset of receipt.assets) {
    if (!/^\/(?!\/)[A-Za-z0-9_./-]+$/.test(asset.path) || asset.path.split("/").includes("..") || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) throw Error("Invalid static asset receipt.");
    // Vite copies a sample CSV too, but the Worker deliberately does not expose
    // arbitrary public-directory files. Verify the actual routed surface.
    if (!["/connect.html", "/password-manager-callback.html"].includes(asset.path) && !asset.path.startsWith("/assets/")) continue;
    const response = await request(asset.path === "/connect.html" ? "/connect" : asset.path);
    if (!response.ok || !response.body) throw Error(`Deployed Mini App asset unavailable: ${asset.path}`);
    const hash = createHash("sha256"); let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > asset.bytes) throw Error(`Deployed Mini App asset size differs: ${asset.path}`);
      hash.update(chunk);
    }
    if (bytes !== asset.bytes || hash.digest("hex") !== asset.sha256) throw Error(`Deployed Mini App asset differs from the build: ${asset.path}`);
  }
  for (const path of ["/", "/control"]) if (!(await request(path)).ok) throw Error(`Hosted page unavailable: ${path}`);
  if ((await request("/v1/messages")).status !== 401) throw Error("Unauthenticated actor access did not fail closed.");
  if (!token || !(await request("/v1/messages", true)).ok) throw Error("Canary could not read the native account runtime.");
}

export interface ShipOperations {
  checkpoint(): Promise<string>;
  push(commit: string): Promise<void>;
  checks(): Promise<void>;
  unchanged(): Promise<void>;
  publish(release: CloudflareRelease): Promise<string>;
  verify(): Promise<void>;
  save(): Promise<void>;
}
/** Fixed release order, exposed only so failure boundaries can be challenged. */
export async function runShip(receipt: ReleaseReceipt, operations: ShipOperations) {
  receipt.commit = await operations.checkpoint();
  receipt.phase = "pushing"; await operations.save();
  await operations.push(receipt.commit);
  receipt.phase = "checking"; await operations.save();
  await operations.checks();
  await operations.unchanged();
  receipt.phase = "publishing"; await operations.save();
  receipt.url = await operations.publish({ id: receipt.id, commit: receipt.commit, browserSource: receipt.browserSource });
  receipt.phase = "verifying"; await operations.save();
  await operations.verify();
  receipt.phase = "verified"; await operations.save();
}

async function main() {
  process.umask(0o077);
  const options = shipOptions(process.argv.slice(2));
  if (options.help) {
    console.log("pnpm ship [--message \"Release description\"]\n\nBuild the Mini App + Tardigrade/DO Worker + runner bundles, git add/commit/push this checkout, run all release checks, deploy once and verify the destination.\n  --dry-run  Show the target and plan; no build, staging, push or deployment.\n  --verify   Recheck the last pushed/deployed release without publishing again.\n\nExisting private Cloudflare/Aiko configuration and installed workspace/sibling dependencies are required. No webhook cutover, database migration, optional vault or playground-app deployment.");
    return;
  }
  const common = resolve(workspaceRoot, await git(["rev-parse", "--git-common-dir"]));
  const receiptPath = join(common, "aiko-ship.json"), lockPath = join(common, "aiko-ship.lock");
  const lock = await open(lockPath, "wx", 0o600).catch(() => { throw Error(`Another release may be running. Inspect ${lockPath} before removing a stale lock.`); });
  await lock.writeFile(String(process.pid));
  try {
    let old: ReleaseReceipt | undefined;
    try { old = JSON.parse(await readFile(receiptPath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const save = async (receipt: ReleaseReceipt) => {
      const pending = receiptPath + ".pending";
      await writeFile(pending, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
      await rename(pending, receiptPath);
      await mkdir(join(workspaceRoot, "artifacts/ship", receipt.id), { recursive: true });
      await writeFile(join(workspaceRoot, "artifacts/ship", receipt.id, "release.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });
    };
    const remoteHas = async (receipt: ReleaseReceipt) => {
      const head = (await git(["ls-remote", "--exit-code", receipt.remote, receipt.ref])).split(/\s/)[0];
      if (head !== receipt.commit) throw Error("Remote branch no longer matches this release commit. Nothing will be deployed.");
    };
    if (options.verify) {
      if (!old || old.version !== 1) throw Error("No release receipt. Run pnpm ship first.");
      await remoteHas(old);
      const state = await cloudflareState();
      if (state.AIKO_CLOUDFLARE_URL !== old.url) throw Error("The configured deployment URL changed. Inspect the old release before sending its canary credential anywhere.");
      await verifyRelease(old, state.AIKO_E2E_TOKEN ?? "");
      old.phase = "verified"; delete old.error; await save(old);
      console.log(`Verified ${old.commit}: ${old.url}/connect`);
      return;
    }
    if (old && ["publishing", "verifying"].includes(old.phase)) throw Error("The last deployment is not confirmed. Run pnpm ship --verify; do not submit it again.");
    const branch = await git(["branch", "--show-current"]);
    if (!branch) throw Error("Check out a branch before shipping; detached HEAD is not a release target.");
    const remote = await git(["config", `branch.${branch}.remote`]).catch(() => "origin");
    const ref = await git(["config", `branch.${branch}.merge`]).catch(() => `refs/heads/${branch}`);
    const fetchUrl = await git(["remote", "get-url", remote]);
    if (remote === "." || fetchUrl !== await git(["remote", "get-url", "--push", remote])) throw Error("Release remote must have matching fetch/push URLs; inspect the Git configuration.");
    await git(["diff", "--check"]);
    if ((await git(["ls-files", "--unmerged"])).length) throw Error("Resolve Git conflicts before shipping.");
    for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
      const path = resolve(workspaceRoot, await git(["rev-parse", "--git-path", name]));
      if (await lstat(path).then(() => true, () => false)) throw Error("Finish the active Git merge/rebase/cherry-pick before shipping.");
    }
    const config = ts.parseConfigFileTextToJson(wranglerConfig, await readFile(wranglerConfig, "utf8"));
    if (config.error || typeof config.config?.name !== "string") throw Error("Invalid Wrangler release configuration.");
    if (typeof config.config.main !== "string" || resolve(dirname(wranglerConfig), config.config.main) !== join(agentDirectory, "src/cloudflare.ts") || config.config.build?.command)
      throw Error("pnpm ship supports the hosted Aiko entry point without custom build hooks. Other applications need their own explicit release target.");
    const state = await cloudflareState();
    const url = state.AIKO_CLOUDFLARE_URL;
    if (!url) throw Error("Set AIKO_CLOUDFLARE_URL to the intended existing deployment before shipping. First-time provisioning uses aiko:cloud:deploy.");
    const origin = releaseOrigin(url);
    if (origin.hostname.endsWith(".workers.dev") && origin.hostname.split(".")[0] !== config.config.name) throw Error("Wrangler Worker name differs from AIKO_CLOUDFLARE_URL. Select the correct target before shipping.");
    console.log(`Ship ${branch} -> ${remote}/${ref.replace("refs/heads/", "")} -> ${config.config.name} (${url})`);
    console.log("Includes: Mini App, console/API/Telegram handler, Tardigrade actors, both Durable Object classes, browser/compute/coding runner bundles.");
    console.log("Plan: build -> git add --all / commit / push -> types + tests + UI + workerd checks -> one deploy -> release and asset readback.");
    console.log(await git(["status", "--short"]));
    if (options.dryRun) return;
    const prepared = await prepareCloudflareDeployment();
    const allSecrets = await cloudflareSecrets();
    const sensitive = [...Object.entries(allSecrets).filter(([key]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/.test(key)).map(([, value]) => value).filter((value): value is string => !!value), ...Object.values(prepared.secrets), prepared.state.AIKO_E2E_TOKEN!];
    const redact = redactor(sensitive);
    if (secretProblem("commit-message", Buffer.from(options.message), sensitive)) throw Error("Remove secret material from the commit message.");
    await scanReleaseFiles(workspaceRoot, sensitive);
    const browserRoot = resolve(workspaceRoot, "../unbrowse-playground");
    const source = await sourceSnapshot(workspaceRoot, generated), browserSource = await sourceSnapshot(browserRoot);
    const configHash = sha(await readFile(wranglerConfig));
    const privateConfigHash = sha(JSON.stringify({ values: allSecrets, state }));
    const unchanged = async () => {
      if (source !== await sourceSnapshot(workspaceRoot, generated) || browserSource !== await sourceSnapshot(browserRoot) || configHash !== sha(await readFile(wranglerConfig))) throw Error("Sources changed during this release (including the linked browser runtime). Nothing further will be deployed. Review changes and run a new release.");
      if (privateConfigHash !== sha(JSON.stringify({ values: await cloudflareSecrets(), state: await cloudflareState() }))) throw Error("Private deployment configuration changed during this release. Review it before publishing; no credentials will be overwritten.");
    };
    const receipt: ReleaseReceipt = { version: 1, id: randomUUID(), worker: config.config.name, url, branch, remote, ref, source, browserSource,
      browserCommit: await git(["rev-parse", "HEAD"], browserRoot), browserDirty: !!(await git(["status", "--porcelain"], browserRoot)), phase: "preparing", checks: [], assets: [] };
    const directory = join(workspaceRoot, "artifacts/ship", receipt.id);
    await save(receipt);
    try {
      console.log("Building every hosted component…");
      await command(["pnpm", "--filter", "@unlock/agent", "exec", "wrangler", "whoami"], workspaceRoot, join(directory, "cloudflare-auth.log"), redact);
      const { frozen, prebuiltConfig, buildDigest, assets } = await buildReleaseArtifacts(directory);
      await unchanged();
      receipt.buildDigest = buildDigest;
      receipt.assets = assets;
      await command(["pnpm", "exec", "wrangler", "deploy", "--config", prebuiltConfig, "--no-bundle", "--dry-run"], agentDirectory, join(directory, "prebuilt-check.log"), redact);
      const bundles = await Promise.all([...generated].map(async (path): Promise<[string, string]> => [path, sha(await readFile(join(workspaceRoot, path)))]));
      const artifactsUnchanged = async () => {
        if (receipt.buildDigest !== sha(JSON.stringify(await assetManifest(frozen))) || JSON.stringify(receipt.assets) !== JSON.stringify(await assetManifest(join(agentDirectory, "public")))) throw Error("Built artifacts changed during verification.");
        for (const [path, hash] of bundles) if (sha(await readFile(join(workspaceRoot, path))) !== hash) throw Error("Runner bundle changed during verification.");
      };
      const releaseUnchanged = async () => {
        await unchanged(); await artifactsUnchanged(); await remoteHas(receipt);
        if (await git(["rev-parse", "HEAD"]) !== receipt.commit || await git(["branch", "--show-current"]) !== branch || await git(["status", "--porcelain"])) throw Error("Git changed after the release checkpoint.");
      };
      await runShip(receipt, {
        checkpoint: async () => {
          if (await git(["branch", "--show-current"]) !== branch) throw Error("The active branch changed during preparation.");
          await scanReleaseFiles(workspaceRoot, sensitive);
          await git(["add", "--all"]);
          await unchanged();
          await git(["diff", "--cached", "--check"]);
          if (await git(["diff", "--cached", "--name-only"])) await command(["git", "commit", "-m", options.message], workspaceRoot, join(directory, "commit.log"), redact);
          if (await git(["status", "--porcelain"])) throw Error("Working tree changed during commit. Review it before shipping.");
          return git(["rev-parse", "HEAD"]);
        },
        push: async commit => {
          console.log(`Pushing ${commit.slice(0, 12)} (source checkpoint, not release acceptance)…`);
          await command(["git", "push", remote, `${commit}:${ref}`], workspaceRoot, join(directory, "push.log"), redact);
          await remoteHas(receipt);
        },
        checks: async () => {
          for (const [i, args] of SHIP_CHECKS.entries()) {
            console.log(`Check ${i + 1}/${SHIP_CHECKS.length}: ${args.join(" ")}…`);
            await command(args, workspaceRoot, join(directory, `check-${i + 1}.log`), redact, { AIKO_PORTABLE_BUILD_CONFIG: prebuiltConfig });
            receipt.checks.push(args.join(" ")); await save(receipt);
          }
        },
        unchanged: releaseUnchanged,
        publish: release => deployCloudflare({ prepared, release, prebuiltConfig, beforePublish: releaseUnchanged }),
        verify: () => verifyRelease(receipt, prepared.state.AIKO_E2E_TOKEN!),
        save: () => save(receipt),
      });
      console.log(`\nReleased and verified ${receipt.commit}\nMini App: ${receipt.url}/connect\nConsole: ${receipt.url}/\nControl: ${receipt.url}/control\nReceipt: ${directory}/release.json`);
      if (receipt.browserDirty) console.log("Linked browser sources were dirty: their exact content digest is in the receipt; their repository was not committed or pushed by this command.");
      console.log("Telegram webhook unchanged. Rebuilt runners are included; live VM adoption was not forced or verified.");
    } catch (error) {
      receipt.error = redact(error instanceof Error ? error.message : "Release failed"); await save(receipt);
      throw Error(`${receipt.error}\nStopped in ${receipt.phase}. Receipt: ${directory}/release.json${["publishing", "verifying"].includes(receipt.phase) ? "\nRecovery: pnpm ship --verify (no republish)." : "\nNo deployment was attempted; any successful Git checkpoint/push remains."}`);
    }
  } finally { await lock.close(); await rm(lockPath, { force: true }); }
}

if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : "Release failed"); process.exitCode = 1; });
