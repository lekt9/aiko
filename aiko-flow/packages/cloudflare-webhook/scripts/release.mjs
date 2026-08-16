#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(process.env.AIKO_RELEASE_DIR || join(packageRoot, "dist/release"));
const receiptDir = join(outputRoot, "receipts");
const artifactPath = join(outputRoot, "aiko-contract-webhook.mjs");
const artifactReceiptPath = join(outputRoot, "artifact.json");
const configPath = join(packageRoot, "wrangler.toml");
const workerName = "aiko-contract-webhook";
const wrangler = process.env.AIKO_RELEASE_WRANGLER || "wrangler";
const command = process.argv[2] || "capability";
const text = (path) => readFileSync(path, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (path) => JSON.parse(text(path));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); };
const git = (...args) => execFileSync("git", ["-C", packageRoot, ...args], { encoding: "utf8" }).trim();
const run = (file, args, options = {}) => execFileSync(file, args, { cwd: packageRoot, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit", env: process.env });
const receiptPath = (name) => join(receiptDir, `${name}.json`);

function provenance() {
  const gitSha = git("rev-parse", "HEAD");
  const branch = git("branch", "--show-current");
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  const sourceStateDigest = sha256(`${status}\n${git("diff", "--binary", "HEAD")}`);
  if (!/^[0-9a-f]{40,64}$/.test(gitSha)) throw new Error("release requires a pinned git SHA");
  return { gitSha, branch, treeClean: status.length === 0, sourceStateDigest };
}
function requireCleanProtected() {
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  if (status) throw new Error("live release refused: git tree is not clean");
  const p = provenance();
  if (!p.branch) throw new Error("live release refused: detached HEAD");
  return p;
}
function requireCredentials() {
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((key) => !process.env[key]);
  if (missing.length) {
    const gap = { schema: "aiko.capability-gap.v1", capability: "cloudflare.live-deployment", status: "blocked", missing, requiredScope: "one authorized Cloudflare account and Worker/versions/routes/queues read-write", productionChanged: false };
    console.error(JSON.stringify(gap));
    const error = new Error("live Cloudflare capability gap"); error.code = "LIVE_CAPABILITY_GAP"; throw error;
  }
  return process.env.CLOUDFLARE_ACCOUNT_ID;
}
function configSnapshot() {
  const source = text(configPath);
  const named = source.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (named !== workerName) throw new Error("Worker name must come from wrangler.toml");
  const sections = []; let section = "root";
  const rows = { root: {} };
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim(); if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[\[([^\]]+)\]\]$/); if (header) { section = header[1]; const row = {}; sections.push([section, row]); continue; }
    const pair = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/); if (!pair) throw new Error(`unsupported wrangler.toml line: ${line}`);
    let value; try { value = JSON.parse(pair[2]); } catch { throw new Error(`wrangler.toml value must be JSON-compatible: ${pair[1]}`); }
    if (section === "root") rows.root[pair[1]] = value; else sections.at(-1)[1][pair[1]] = value;
  }
  const list = (kind) => sections.filter(([name]) => name === kind).map(([, value]) => value);
  const services = list("services"); const producers = list("queues.producers"); const consumers = list("queues.consumers"); const migrations = list("migrations");
  const required = ["ENDPOINT_MANIFESTS", "WEBHOOK_COORDINATOR", "WEBHOOK_SECRETS", "AIKO_GATEWAY"];
  for (const binding of required) if (!services.some((item) => item.binding === binding)) throw new Error(`missing service binding ${binding}`);
  for (const binding of ["VERIFIED_INGRESS_QUEUE", "WEBHOOK_DLQ"]) if (!producers.some((item) => item.binding === binding)) throw new Error(`missing queue binding ${binding}`);
  if (!consumers.some((item) => item.queue === "verified-contract-ingress" && item.dead_letter_queue === "aiko-webhook-dlq")) throw new Error("queue consumer/DLQ topology is missing");
  return Object.freeze({ worker: named, compatibilityDate: rows.root.compatibility_date, routes: rows.root.routes, bindings: services, queues: { producers, consumers }, migrations });
}
async function packageArtifact() {
  const p = provenance(); const config = configSnapshot(); mkdirSync(outputRoot, { recursive: true });
  run("bun", ["build", "src/worker.ts", "--target=browser", "--format=esm", `--outfile=${artifactPath}`]);
  // A real module invocation is the local Worker gate; it needs no network or account.
  run("node", ["--input-type=module", "-e", `const m=await import(${JSON.stringify(`file://${artifactPath}`)});const r=await m.default.fetch(new Request('https://local.invalid/contract-webhooks/probe',{method:'GET'}),{});if(r.status!==405)process.exit(1)`]);
  const bytes = readFileSync(artifactPath); const snapshotBytes = Buffer.from(JSON.stringify(config));
  const receipt = { schema: "aiko.cloudflare-artifact.v1", ...p, worker: workerName, artifact: "aiko-contract-webhook.mjs", artifactDigest: sha256(bytes), configDigest: sha256(text(configPath)), releaseManifestDigest: sha256(snapshotBytes), config };
  writeJson(artifactReceiptPath, receipt); return receipt;
}
function loadArtifact() {
  if (!existsSync(artifactPath) || !existsSync(artifactReceiptPath)) throw new Error("immutable artifact is absent; run deploy:dry first");
  const receipt = json(artifactReceiptPath); const current = provenance();
  if (receipt.treeClean !== true || current.treeClean !== true || receipt.gitSha !== current.gitSha || receipt.sourceStateDigest !== current.sourceStateDigest || receipt.worker !== workerName || receipt.artifactDigest !== sha256(readFileSync(artifactPath)) || receipt.configDigest !== sha256(text(configPath))) throw new Error("immutable artifact receipt does not match a clean checkout's bytes/config/SHA");
  return receipt;
}
function wranglerCapture(args) { return run(wrangler, args, { capture: true }); }
function extractVersion(output) {
  const patterns = [/Worker Version ID:\s*([A-Za-z0-9-]+)/i, /Version ID:\s*([A-Za-z0-9-]+)/i, /"(?:version_id|id)"\s*:\s*"([A-Za-z0-9-]+)"/i];
  for (const pattern of patterns) { const found = output.match(pattern)?.[1]; if (found) return found; }
  throw new Error("Wrangler upload did not return a version ID");
}
function ensureSecretFree(value) {
  const encoded = JSON.stringify(value);
  for (const secret of [process.env.CLOUDFLARE_API_TOKEN]) if (secret && encoded.includes(secret)) throw new Error("receipt contained secret material");
  if (/(authorization|bearer|password|secretValue|apiToken)/i.test(encoded)) throw new Error("receipt contains a forbidden secret field");
}
function smoke(url, label) {
  if (!url || !/^https:\/\//.test(url)) throw new Error(`${label} smoke URL is required before changing traffic`);
  const result = run("curl", ["--fail", "--silent", "--show-error", "--max-time", "15", url], { capture: true });
  return { url, responseDigest: sha256(result), ok: true };
}
function saveReceipt(name, value) { ensureSecretFree(value); writeJson(receiptPath(name), value); return value; }
function assertReceipt(value, environment) {
  const artifact = loadArtifact();
  if (value?.schema !== "aiko.cloudflare-deploy.v1" || value.environment !== environment || value.gitSha !== artifact.gitSha || value.worker !== workerName || value.artifactDigest !== artifact.artifactDigest || !value.versionId) throw new Error(`${environment} receipt does not pin this immutable artifact`);
  if (value.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error("receipt belongs to another Cloudflare account");
  return artifact;
}
async function dryRun() {
  const artifact = await packageArtifact();
  wranglerCapture(["versions", "upload", artifactPath, "--config", configPath, "--name", workerName, "--no-bundle", "--dry-run"]);
  console.log(JSON.stringify({ status: "hermetic-dry-run-passed", artifactDigest: artifact.artifactDigest, worker: workerName }));
}
async function preview() {
  const accountId = requireCredentials(); const p = requireCleanProtected(); const artifact = loadArtifact();
  if (p.gitSha !== artifact.gitSha) throw new Error("preview SHA differs from packaged artifact");
  const alias = `aiko-webhook-${p.branch.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,30)}-${p.gitSha.slice(0,8)}`;
  const output = wranglerCapture(["versions", "upload", artifactPath, "--config", configPath, "--name", workerName, "--no-bundle", "--strict", "--preview-alias", alias, "--tag", `git-${p.gitSha.slice(0,12)}-${artifact.artifactDigest.slice(0,12)}`]);
  const versionId = extractVersion(output); const check = smoke(process.env.AIKO_WEBHOOK_PREVIEW_SMOKE_URL, "preview");
  const receipt = saveReceipt("preview", { schema: "aiko.cloudflare-deploy.v1", operation: "upload-once", environment: "preview", accountId, worker: workerName, versionId, ...p, artifactDigest: artifact.artifactDigest, configDigest: artifact.configDigest, config: artifact.config, alias, smoke: check, productionChanged: false });
  console.log(JSON.stringify(receipt));
}
async function staging() {
  requireCredentials(); requireCleanProtected(); const previewReceipt = json(receiptPath("preview")); assertReceipt(previewReceipt, "preview");
  // Staging is a second independent smoke of the uploaded preview version, not a fresh upload.
  const check = smoke(process.env.AIKO_WEBHOOK_STAGING_SMOKE_URL || previewReceipt.smoke.url, "staging");
  const receipt = saveReceipt("staging", { ...previewReceipt, operation: "promote-exact-version", environment: "staging", promotedFrom: "preview", smoke: check, productionChanged: false });
  console.log(JSON.stringify(receipt));
}
function currentProductionVersion() {
  const output = wranglerCapture(["deployments", "list", "--config", configPath, "--name", workerName, "--json"]); const values = JSON.parse(output);
  const deployments = Array.isArray(values) ? values : values.deployments || [];
  const newest = deployments[0] || {}; const versions = newest.versions || newest.version_specs || [];
  return versions.find((item) => Number(item.percentage ?? 100) > 0)?.version_id || versions[0]?.versionId || newest.version_id || null;
}
async function promote() {
  requireCredentials(); requireCleanProtected(); const stagingReceipt = json(receiptPath("staging")); assertReceipt(stagingReceipt, "staging");
  wranglerCapture(["versions", "view", stagingReceipt.versionId, "--config", configPath, "--name", workerName, "--json"]);
  const previousVersionId = currentProductionVersion();
  wranglerCapture(["versions", "deploy", `${stagingReceipt.versionId}@100`, "--config", configPath, "--name", workerName, "--yes", "--message", `Promote ${stagingReceipt.gitSha}`]);
  const check = smoke(process.env.AIKO_WEBHOOK_PRODUCTION_SMOKE_URL, "production");
  const receipt = saveReceipt("production", { ...stagingReceipt, operation: "promote-exact-version", environment: "production", promotedFrom: "staging", previousVersionId, smoke: check, productionChanged: true });
  console.log(JSON.stringify(receipt));
}
async function rollback() {
  requireCredentials(); requireCleanProtected(); const production = json(receiptPath("production"));
  if (production?.schema !== "aiko.cloudflare-deploy.v1" || production.environment !== "production" || production.worker !== workerName || production.accountId !== process.env.CLOUDFLARE_ACCOUNT_ID || !production.versionId || !production.gitSha || !production.artifactDigest) throw new Error("production receipt is invalid or belongs to another account/Worker");
  ensureSecretFree(production);
  if (!production.previousVersionId || production.previousVersionId === production.versionId) throw new Error("verified prior production version is absent");
  wranglerCapture(["versions", "view", production.previousVersionId, "--config", configPath, "--name", workerName, "--json"]);
  wranglerCapture(["versions", "deploy", `${production.previousVersionId}@100`, "--config", configPath, "--name", workerName, "--yes", "--message", `Rollback from ${production.versionId}`]);
  const check = smoke(process.env.AIKO_WEBHOOK_PRODUCTION_SMOKE_URL, "rollback");
  const receipt = saveReceipt(`rollback-${Date.now()}`, { schema: "aiko.cloudflare-deploy.v1", operation: "rollback", environment: "production", accountId: production.accountId, worker: workerName, versionId: production.previousVersionId, replacedVersionId: production.versionId, gitSha: production.gitSha, branch: production.branch, artifactDigest: production.artifactDigest, configDigest: production.configDigest, smoke: check, productionChanged: true });
  console.log(JSON.stringify(receipt));
}
function capability() {
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((key) => !process.env[key]);
  const value = missing.length ? { schema: "aiko.capability-gap.v1", capability: "cloudflare.live-deployment", status: "blocked", missing, productionChanged: false } : { schema: "aiko.capability.v1", capability: "cloudflare.live-deployment", status: "available", accountId: process.env.CLOUDFLARE_ACCOUNT_ID };
  console.log(JSON.stringify(value)); if (missing.length) process.exitCode = 2;
}
try {
  if (command === "dry-run") await dryRun(); else if (command === "preview") await preview(); else if (command === "staging") await staging(); else if (command === "promote") await promote(); else if (command === "rollback") await rollback(); else if (command === "capability") capability(); else throw new Error(`unknown release command: ${command}`);
} catch (error) { if (error?.code !== "LIVE_CAPABILITY_GAP") console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
