import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { backupState } from "./backup.ts";
import type { AikoConfig } from "./config.ts";
import { threadBinding } from "./account-binding.ts";
import { acquireOfflineSourceLease, exportAikoCloudflare, type OfflineSourceLease, type MigrationEnvelope, type MigrationInventory } from "./migration-export.ts";
import { boundedText, equalSecret, safeUserId } from "./security.ts";
import { TELEGRAM_ALLOWED_UPDATES } from "./telegram-normalize.ts";

const UNIT = "unlock-aiko.service";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CutoverError("invalid-response");
  return value as ObjectValue;
};
function assert(ok: unknown, code: string): asserts ok { if (!ok) throw new CutoverError(code); }
export class CutoverError extends Error {
  constructor(readonly code: string, readonly progress?: string) { super(code); this.name = "CutoverError"; }
}
export type ServiceState = { active: "active" | "inactive"; enabled: boolean };
export interface CutoverIO {
  fetch: typeof fetch;
  service(action: "status" | "stop" | "start" | "disable"): Promise<ServiceState>;
  backup: typeof backupState;
  export: typeof exportAikoCloudflare;
  lease: typeof acquireOfflineSourceLease;
  now(): number;
}
export interface CutoverOptions {
  config: AikoConfig;
  cloudflare: { AIKO_CLOUDFLARE_URL?: string; AIKO_E2E_OWNER?: string };
  artifactDir: string;
  /** Fresh private run directory, outside the original state; contains backup, export and progress. */
  runDir: string;
  execute?: boolean;
}
type AccountEvidence = {
  account: string; id: string; status: "attempted" | "imported" | "duplicate";
  verified: boolean; threads: number; events: number; historySha256: string;
  memoryRoot: string; memorySha256: string;
};
export interface CutoverEvidence {
  format: "aiko.cloudflare-cutover/v1"; verified: boolean; dryRun: boolean;
  actor: "aiko"; instance: "demo"; url: string; startedAt: number; completedAt?: number;
  stage: string; sourceWasActive: boolean; sourceStopped: boolean; sourceDisabled: boolean;
  witnesses: Record<string, { file: string; sha256: string; at: number }>;
  transportAttestedAt: number[];
  sourceAccounts: string[]; accounts: AccountEvidence[];
  backup?: { directory: string; files: number; manifestSha256: string };
  export?: { directory: string; inventorySha256: string };
  telegram?: { botIdHash: string; cursorFile: string; next: number; acknowledgement: "attempted" | "verified";
    newerUpdatesReturned?: number; webhook: "not_attempted" | "attempted" | "verified" };
  error?: string; recovery?: string; localFallback?: "restarted" | "already_offline" | "manual_required";
}

function privateFile(path: string): string {
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    (!process.getuid || stat.uid === process.getuid()), "private-artifact-required");
  assert(stat.size <= 8_100_000, "artifact-too-large");
  return readFileSync(path, "utf8");
}
function canonicalDirectory(path: string) {
  const stat = lstatSync(path);
  assert(isAbsolute(path) && realpathSync(path) === path && stat.isDirectory() &&
    !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 &&
    (!process.getuid || stat.uid === process.getuid()), "private-canonical-directory-required");
}
function freshRunPath(runDir: string, stateDir: string) {
  const rel = relative(stateDir, runDir);
  assert(isAbsolute(runDir) && resolve(runDir) === runDir && !existsSync(runDir) &&
    (rel === ".." || rel.startsWith(`..${sep}`)) && realpathSync(dirname(runDir)) === dirname(runDir), "fresh-run-directory-required");
}
function save(path: string, evidence: CutoverEvidence, exclusive = false) {
  if (exclusive) assert(!existsSync(path), "verified-artifact-already-exists");
  const staging = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(staging, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(evidence, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  // This target belongs to the current run. Never touch another run's backup or target DO.
  if (exclusive) { linkSync(staging, path); unlinkSync(staging); }
  else renameSync(staging, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function sourceAccounts(config: AikoConfig): string[] {
  const path = join(config.stateDir, "actor.sqlite"), stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink() && (!process.getuid || stat.uid === process.getuid()), "unsafe-source-actor-file");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const identity = db.prepare("SELECT actor,instance FROM actor_identity WHERE singleton=1").get();
    assert(identity?.actor === "aiko" && identity.instance === "demo", "source-identity-must-be-aiko-demo");
    const rows = db.prepare("SELECT thread FROM thread_directory ORDER BY thread").all();
    assert(rows.length > 0 && rows.length <= 10_000, "invalid-source-inventory");
    const owners = new Set<string>();
    for (const row of rows) {
      const binding = typeof row.thread === "string" && threadBinding(row.thread);
      assert(binding, "source-thread-owner-invalid"); owners.add(binding.owner);
    }
    for (const owner of owners) assert(rows.some(row => row.thread === `user-${owner}`), "source-foreground-missing");
    return [...owners].sort();
  } finally { db.close(); }
}
function witnesses(options: CutoverOptions, now: number): CutoverEvidence["witnesses"] {
  const result: CutoverEvidence["witnesses"] = {};
  for (const name of ["live", "speech", "video"]) {
    const file = join(options.artifactDir, `${name}.json`), bytes = privateFile(file), data = object(JSON.parse(bytes));
    const at = name === "live" ? data.startedAt : data.at;
    assert(typeof at === "number" && Number.isFinite(at) && at <= now && now - at <= 72 * 60 * 60_000, `${name}-witness-stale`);
    if (name === "live") {
      assert(data.passed === true && data.url === options.cloudflare.AIKO_CLOUDFLARE_URL &&
        data.owner === options.cloudflare.AIKO_E2E_OWNER && typeof data.turn === "string" &&
        data.turn.startsWith("plane:") && typeof data.searchCalls === "number" && data.searchCalls > 0 &&
        Array.isArray(data.browserReads) && data.browserReads.includes("agent_browser_navigate") &&
        data.browserReads.some(value => typeof value === "string" && /snapshot|get_text/.test(value)), "live-witness-not-passed");
    } else {
      assert(data.verified === true && typeof data.transcript === "string" && data.transcript.trim(), `${name}-witness-not-verified`);
      const size = name === "speech" ? data.voiceBytes : data.videoBytes;
      assert(typeof size === "number" && Number.isSafeInteger(size) && size > 0, `${name}-witness-empty`);
      if (name === "video") assert(typeof data.frames === "number" && data.frames > 0 && typeof data.vision === "string" && data.vision.trim(), "video-witness-incomplete");
    }
    result[name] = { file, sha256: sha(bytes), at };
  }
  return result;
}

async function systemctl(action: "status" | "stop" | "start" | "disable"): Promise<ServiceState> {
  const run = async (args: string[]) => {
    const child = Bun.spawn(["systemctl", "--user", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 55_000 });
    const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert(code === 0, `systemctl-${action}-failed`); return stdout;
  };
  if (action !== "status") await run([action, UNIT]);
  const properties = await run(["show", UNIT, "--property=LoadState,ActiveState,UnitFileState", "--no-pager"]);
  const values = Object.fromEntries(properties.trim().split("\n").map(line => line.split("=")));
  assert(values.LoadState === "loaded" && ["active", "inactive"].includes(values.ActiveState ?? ""), "local-service-not-stable");
  assert(["enabled", "disabled"].includes(values.UnitFileState ?? ""), "local-service-enable-state-unknown");
  return { active: values.ActiveState as ServiceState["active"], enabled: values.UnitFileState === "enabled" };
}
const liveIO: CutoverIO = { fetch, service: systemctl, backup: backupState, export: exportAikoCloudflare, lease: acquireOfflineSourceLease, now: Date.now };

/** Operator-only staged migration. Default is read-only preflight. Never called by an actor. */
export async function cutoverAikoCloudflare(options: CutoverOptions, io: CutoverIO = liveIO): Promise<CutoverEvidence> {
  const { config, runDir } = options;
  const url = options.cloudflare.AIKO_CLOUDFLARE_URL;
  assert(typeof url === "string" && /^https:\/\/aiko-agent\.[a-z0-9-]+\.workers\.dev$/.test(url), "invalid-cloudflare-origin");
  assert(safeUserId(options.cloudflare.AIKO_E2E_OWNER), "invalid-canary-owner");
  assert(config.mode === "live" && (config.instanceId ?? config.mode) === "demo" && config.telegramMode === "polling" &&
    config.operatorToken.length >= 32 && config.botToken && /^\d+:[A-Za-z0-9_-]+$/.test(config.botToken) &&
    config.webhookSecret && /^[A-Za-z0-9_-]{32,256}$/.test(config.webhookSecret), "live-polling-configuration-required");
  canonicalDirectory(config.stateDir); canonicalDirectory(options.artifactDir); freshRunPath(runDir, config.stateDir);
  assert(!existsSync(join(options.artifactDir, "migration.json")), "verified-artifact-already-exists");
  const witness = witnesses(options, io.now());
  const owners = sourceAccounts(config);
  assert(!owners.includes(options.cloudflare.AIKO_E2E_OWNER!), "canary-must-not-be-migration-owner");
  const jsonRequest = async (target: string, method: "GET" | "POST", token?: string, body?: unknown, maximum = 8_100_000): Promise<unknown> => {
    const response = await io.fetch(target, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    assert(response.ok, `remote-http-${response.status}`);
    return JSON.parse(await boundedText(response, maximum));
  };
  const cloud = (path: string, body?: unknown) => jsonRequest(`${url}${path}`, body === undefined ? "GET" : "POST", config.operatorToken, body);
  const telegram = async (method: "getMe" | "getWebhookInfo" | "getUpdates" | "setWebhook", body?: unknown) => {
    const data = object(await jsonRequest(`https://api.telegram.org/bot${config.botToken}/${method}`, body === undefined ? "GET" : "POST", undefined, body, 2_000_000));
    assert(data.ok === true, `telegram-${method}-failed`); return data.result;
  };
  const ensureReady = async () => {
    const ready = object(await cloud("/ready"));
    assert(ready.status === "ready" && ready.mode === "live" && ready.storage === "durable-object" &&
      object(ready.telegram).enabled === true && object(ready.telegram).mode === "webhook", "cloudflare-not-ready");
  };
  await ensureReady();
  const botId = config.botToken!.split(":")[0]!;
  const attested: number[] = [];
  const attestTransport = async () => {
    const nonce = randomBytes(32).toString("hex");
    const proof = object(await cloud("/api/control/telegram-attest", { nonce }));
    const expected = createHmac("sha256", config.webhookSecret!)
      .update(JSON.stringify(["aiko.telegram-cutover/v1", nonce, config.botToken])).digest("hex");
    assert(proof.botId === botId && typeof proof.proof === "string" && /^[a-f0-9]{64}$/.test(proof.proof) &&
      equalSecret(proof.proof, expected), "deployed-telegram-credentials-mismatch");
    attested.push(io.now());
  };
  const me = object(await telegram("getMe"));
  assert(String(me.id) === botId && me.is_bot === true, "telegram-bot-identity-mismatch");
  await attestTransport();
  const beforeWebhook = object(await telegram("getWebhookInfo"));
  assert(beforeWebhook.url === "", "telegram-is-not-using-local-polling");
  const service = await io.service("status");
  if (service.active === "active") {
    const localReady = object(await jsonRequest(`http://127.0.0.1:${config.port}/ready`, "GET"));
    assert(localReady.status === "ready" && localReady.mode === "live" && object(localReady.telegram).running === true,
      "local-polling-service-not-ready");
  }
  const evidence: CutoverEvidence = {
    format: "aiko.cloudflare-cutover/v1", verified: false, dryRun: !options.execute, actor: "aiko", instance: "demo",
    url, startedAt: io.now(), stage: "preflight-passed", sourceWasActive: service.active === "active", sourceStopped: false,
    sourceDisabled: false, witnesses: witness, transportAttestedAt: attested, sourceAccounts: owners, accounts: [],
  };
  if (!options.execute) return evidence;
  mkdirSync(runDir, { mode: 0o700 });
  const progress = join(runDir, "migration.json");
  const record = (stage: string) => { evidence.stage = stage; save(progress, evidence); };
  record("stopping-local-service");
  let webhookAttempted = false;
  let sourceLease: OfflineSourceLease | undefined;
  try {
    if (service.active === "active") assert((await io.service("stop")).active === "inactive", "local-service-did-not-stop");
    assert((await io.service("status")).active === "inactive", "local-service-still-active");
    evidence.sourceStopped = true; record("creating-offline-backup");
    const backupDir = join(runDir, "pre-cloudflare-backup");
    const backup = await io.backup(config, backupDir);
    assert(backup.instanceId === "demo" && backup.files.length > 0, "backup-inventory-invalid");
    evidence.backup = { directory: backupDir, files: backup.files.length,
      manifestSha256: sha(privateFile(join(backupDir, "backup-manifest.json"))) };
    record("exporting-native-histories");
    const exportDir = join(runDir, "native-export");
    sourceLease = io.lease(config.stateDir);
    assert(sourceLease.hostLockHeld, "source-lifetime-lock-required");
    const inventory: MigrationInventory = io.export({ stateDir: config.stateDir, outputDir: exportDir, sourceOffline: true, sourceLease });
    assert(JSON.stringify(inventory.accounts.map(account => account.account).sort()) === JSON.stringify(owners), "source-account-inventory-changed");
    evidence.export = { directory: exportDir, inventorySha256: sha(privateFile(join(exportDir, "inventory.json"))) };
    const cursorFile = `telegram-${sha(botId).slice(0, 24)}.sqlite`;
    // No other token's cursor can acknowledge this bot's updates. A second local
    // poller store is an operator reconciliation requirement, never an offset guess.
    assert(inventory.telegram.length === 1 && inventory.telegram[0]!.file === cursorFile && inventory.telegram[0]!.inbox === 0,
      "exact-bot-poller-cursor-required");
    const next = inventory.telegram[0]!.next;
    assert(Number.isSafeInteger(next) && next >= 0, "invalid-poller-cursor");
    for (const account of inventory.accounts) {
      const bytes = privateFile(join(exportDir, account.file));
      assert(sha(bytes) === account.sha256 && Buffer.byteLength(bytes) === account.bytes && account.bytes <= 8_000_000, "export-file-integrity-mismatch");
      const envelope = object(JSON.parse(bytes)) as unknown as MigrationEnvelope;
      assert(envelope.id === account.id && envelope.memory.scope === `aiko:${account.account}` &&
        envelope.threads.every(history => threadBinding(history.thread)?.owner === account.account), "export-owner-binding-mismatch");
      const imported: AccountEvidence = { account: account.account, id: account.id, status: "attempted", verified: false,
        threads: envelope.threads.length, events: envelope.threads.reduce((n, history) => n + history.events.length, 0),
        historySha256: sha(JSON.stringify(envelope.threads)), memoryRoot: envelope.memory.root,
        memorySha256: sha(JSON.stringify(envelope.memory)) };
      evidence.accounts.push(imported); record("importing-owner-no-drive");
      const result = object(await cloud(`/api/control/import?account=${encodeURIComponent(account.account)}`, envelope));
      assert(["imported", "duplicate"].includes(String(result.status)) && result.threads === imported.threads &&
        result.execution === "not_started" && result.memory === "imported_native_journal", "import-no-drive-receipt-invalid");
      imported.status = result.status as "imported" | "duplicate"; record("verifying-owner-readback");
      const readback = object(await cloud(`/api/control/export?account=${encodeURIComponent(account.account)}`));
      assert(readback.account === account.account && readback.actor === "aiko" && readback.instance === "demo" &&
        Array.isArray(readback.threads), "readback-identity-mismatch");
      const normalized = [...readback.threads].sort((a, b) => String(a.thread).localeCompare(String(b.thread), "en"));
      assert(sha(JSON.stringify(normalized)) === imported.historySha256 &&
        sha(JSON.stringify(readback.memory)) === imported.memorySha256 &&
        object(readback.memory).root === imported.memoryRoot, "readback-data-mismatch");
      imported.verified = true; record("owner-readback-verified");
    }
    assert(evidence.accounts.every(account => account.verified), "all-owner-verification-required");
    // Recheck both boundaries immediately before acknowledging any provider offset.
    await ensureReady();
    await attestTransport();
    assert((await io.service("status")).active === "inactive", "local-service-restarted");
    assert(object(await telegram("getWebhookInfo")).url === "", "webhook-changed-during-migration");
    evidence.telegram = { botIdHash: sha(botId), cursorFile, next, acknowledgement: "attempted", webhook: "not_attempted" };
    record("acknowledging-exported-telegram-cursor");
    const pending = await telegram("getUpdates", { offset: next, timeout: 0, allowed_updates: TELEGRAM_ALLOWED_UPDATES });
    assert(Array.isArray(pending) && pending.every(update => Number.isSafeInteger(object(update).update_id) && Number(object(update).update_id) >= next), "invalid-telegram-offset-result");
    evidence.telegram.acknowledgement = "verified";
    evidence.telegram.newerUpdatesReturned = pending.length;
    // Returned newer updates are intentionally neither stored nor acknowledged.
    // setWebhook preserves them; never advance to max(returned update_id)+1 here.
    record("switching-telegram-webhook");
    webhookAttempted = true; evidence.telegram.webhook = "attempted"; save(progress, evidence);
    assert(await telegram("setWebhook", { url: `${url}/telegram/webhook`, secret_token: config.webhookSecret,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES, drop_pending_updates: false }) === true, "webhook-change-not-accepted");
    const webhook = object(await telegram("getWebhookInfo"));
    assert(webhook.url === `${url}/telegram/webhook` && Array.isArray(webhook.allowed_updates) &&
      JSON.stringify([...webhook.allowed_updates].sort()) === JSON.stringify([...TELEGRAM_ALLOWED_UPDATES].sort()) &&
      (!webhook.last_error_date || Number(webhook.last_error_date) * 1000 < evidence.startedAt), "webhook-readback-mismatch");
    evidence.telegram.webhook = "verified"; record("disabling-previous-polling-unit");
    const disabled = await io.service("disable");
    assert(!disabled.enabled && disabled.active === "inactive", "previous-unit-not-disabled");
    evidence.sourceDisabled = true; evidence.verified = true; evidence.completedAt = io.now();
    evidence.recovery = "Cloudflare now owns delivery. Keep the original state and private backup. Do not restart the old poller while the webhook is active. A rollback requires an explicit operator handoff preserving pending Telegram updates and reconciling all new Cloudflare history; never delete a populated DO to retry.";
    record("completed");
    save(join(options.artifactDir, "migration.json"), evidence, true);
    return evidence;
  } catch (error) {
    evidence.error = error instanceof CutoverError ? error.code : "cutover-step-failed";
    evidence.verified = false;
    evidence.recovery = webhookAttempted
      ? "Webhook outcome may be committed. Keep the local service stopped. Inspect getWebhookInfo and this run's owner receipts before any action; do not restart polling, advance offsets, drop updates, or delete target DOs automatically. Disable the old unit if Cloudflare owns the verified webhook."
      : "Local databases and backup remain authoritative. Imported target accounts are recorded here and must be treated as potentially populated even when a response was lost. Exact same archive/id can be retried only while local history is unchanged; after local fallback resumes, reconcile delta history or use an explicitly reviewed fresh deployment. Never erase target DOs automatically.";
    evidence.localFallback = "manual_required";
    sourceLease?.release();
    if (!webhookAttempted) {
      try {
        assert(object(await telegram("getWebhookInfo")).url === "", "fallback-webhook-not-empty");
        if (evidence.sourceWasActive) {
          assert((await io.service("start")).active === "active", "fallback-start-failed");
          evidence.localFallback = "restarted";
        } else evidence.localFallback = "already_offline";
      } catch { /* Unknown external state is never permission to start a duplicate poller. */ }
    }
    record("failed-requires-operator-review");
    throw new CutoverError(evidence.error, progress);
  } finally {
    sourceLease?.release();
  }
}
