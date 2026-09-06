import { afterEach, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, PERSONA, type AikoConfig } from "../src/config.ts";
import { cutoverAikoCloudflare, type CutoverIO, type CutoverOptions, type ServiceState } from "../src/cloudflare-cutover.ts";
import type { MigrationEnvelope, MigrationInventory } from "../src/migration-export.ts";
import { TELEGRAM_ALLOWED_UPDATES } from "../src/telegram-normalize.ts";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(owners = ["123"]) {
  const root = mkdtempSync("/tmp/aiko-cutover-fixture-"); directories.push(root);
  const stateDir = join(root, "source"), artifactDir = join(root, "artifacts");
  mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(artifactDir, { mode: 0o700 });
  const db = new DatabaseSync(join(stateDir, "actor.sqlite"));
  db.exec("CREATE TABLE actor_identity(singleton INTEGER PRIMARY KEY,actor TEXT,instance TEXT); INSERT INTO actor_identity VALUES(1,'aiko','demo'); CREATE TABLE thread_directory(thread TEXT)");
  for (const owner of owners) db.prepare("INSERT INTO thread_directory VALUES(?)").run(`user-${owner}`);
  db.close();
  const config: AikoConfig = { stateDir, mode: "live", instanceId: "demo", port: 4242, operatorToken: "private-operator-fixture-123456789012345",
    botToken: "987654321:private_bot_fixture_1234567890", webhookSecret: "private_webhook_fixture_123456789012345",
    telegramMode: "polling", persona: PERSONA, voiceEnabled: false, allowedUsers: new Set(owners) };
  const url = "https://aiko-agent.fixture.workers.dev";
  const cloudflare = { AIKO_CLOUDFLARE_URL: url, AIKO_E2E_OWNER: "acct_cloudflare_e2e02" };
  const witness = (name: string, data: unknown) => writeFileSync(join(artifactDir, `${name}.json`), JSON.stringify(data), { mode: 0o600 });
  witness("live", { passed: true, url, owner: cloudflare.AIKO_E2E_OWNER, turn: "plane:fixture", startedAt: 1000, searchCalls: 1, browserReads: ["agent_browser_navigate", "agent_browser_snapshot"] });
  witness("speech", { verified: true, at: 1000, voiceBytes: 128, transcript: "Fixture speech" });
  witness("video", { verified: true, at: 1000, videoBytes: 256, frames: 1, transcript: "Fixture video", vision: "Red" });
  const options: CutoverOptions = { config, cloudflare, artifactDir, runDir: join(root, "cutover-run"), execute: true };
  const calls: { path: string; method: string; body?: Record<string, any> }[] = [];
  const serviceCalls: string[] = [];
  const blobs = new Map<string, MigrationEnvelope>();
  let service: ServiceState = { active: "active", enabled: true };
  let leased = false;
  let webhook = "";
  let attestations = 0;
  const switches = { badCursor: false, failedImport: "", tamperedReadback: false, unknownWebhook: false, failDisable: false, invalidAttestation: 0 };
  const io: CutoverIO = {
    now: () => 2000,
    service: async action => {
      serviceCalls.push(action);
      if (action === "stop") service = { ...service, active: "inactive" };
      if (action === "start") { expect(leased).toBe(false); service = { ...service, active: "active" }; }
      if (action === "disable") {
        if (switches.failDisable) throw new Error("fixture disable failed");
        service = { ...service, enabled: false };
      }
      return { ...service };
    },
    lease: () => { leased = true; return { hostLockHeld: true, assertHeld: () => { expect(leased).toBe(true); }, release: () => { leased = false; } }; },
    backup: async (_config, path) => {
      expect(service.active).toBe("inactive");
      mkdirSync(path, { mode: 0o700 });
      const manifest = { version: 1, at: new Date(1000).toISOString(), instanceId: "demo", mode: "live" as const,
        files: [{ path: "actor.sqlite", bytes: 100, sha256: "a".repeat(64) }] };
      writeFileSync(join(path, "backup-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
      return manifest;
    },
    export: ({ outputDir }) => {
      expect(service.active).toBe("inactive");
      mkdirSync(outputDir, { mode: 0o700 });
      const inventory: MigrationInventory = { format: "aiko.offline-migration/v1", actor: "aiko", instance: "demo", sourceOffline: true, hostLockHeld: true,
        accounts: owners.map(account => {
          const envelope: MigrationEnvelope = { id: `migration-${account}`, threads: [{ thread: `user-${account}`, events: [
            { type: "ThreadCreated", address: { actor: "aiko", instance: "demo", thread: `user-${account}` }, depth: 0, at: 1 },
          ] }], memory: { format: "entity-learn.sqlite/v1", scope: `aiko:${account}`, root: "0".repeat(64), journal: [], artifacts: [] } };
          blobs.set(account, envelope);
          const body = JSON.stringify(envelope), file = `${sha(account)}.json`;
          writeFileSync(join(outputDir, file), body, { mode: 0o600 });
          return { account, file, id: envelope.id, bytes: Buffer.byteLength(body), sha256: sha(body),
            memory: { root: envelope.memory.root, journalRows: 0, artifacts: 0 }, threads: [{ thread: `user-${account}`, events: 1,
              sha256: sha(JSON.stringify(envelope.threads[0]!.events)), types: { ThreadCreated: 1 } }] };
        }), actorRegistry: { file: "actor-registry.json", sha256: "b".repeat(64), events: owners.length * 2, directoryEntries: owners.length },
        telegram: [{ file: `telegram-${switches.badCursor ? "f".repeat(24) : sha(config.botToken!.split(":")[0]!).slice(0, 24)}.sqlite`, next: 42, rejected: 1, inbox: 0 }], transportHandoff: "fixture" };
      writeFileSync(join(outputDir, "inventory.json"), JSON.stringify(inventory), { mode: 0o600 });
      return inventory;
    },
    fetch: (async (target: string | URL | Request, init?: RequestInit) => {
      const parsed = new URL(String(target)), path = parsed.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method: init?.method ?? "GET", body });
      if (parsed.origin === "http://127.0.0.1:4242" && path === "/ready")
        return Response.json({ status: "ready", mode: "live", telegram: { running: true } });
      if (parsed.origin === url) {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${config.operatorToken}`);
        if (path === "/ready") return Response.json({ status: "ready", mode: "live", storage: "durable-object", telegram: { enabled: true, mode: "webhook" } });
        if (path === "/api/control/telegram-attest") {
          attestations++;
          expect(body.nonce).toMatch(/^[a-f0-9]{64}$/);
          const proof = createHmac("sha256", config.webhookSecret!)
            .update(JSON.stringify(["aiko.telegram-cutover/v1", body.nonce, config.botToken])).digest("hex");
          return Response.json({ botId: "987654321", proof: switches.invalidAttestation === attestations ? "f".repeat(64) : proof });
        }
        const account = parsed.searchParams.get("account")!;
        if (path === "/api/control/import") {
          expect(leased).toBe(true);
          if (account === switches.failedImport) return Response.json({ error: "fixture" }, { status: 409 });
          expect(body).toEqual(blobs.get(account));
          return Response.json({ status: "imported", threads: body.threads.length, execution: "not_started", memory: "imported_native_journal" }, { status: 201 });
        }
        if (path === "/api/control/export") {
          expect(leased).toBe(true);
          const source = structuredClone(blobs.get(account)!);
          if (switches.tamperedReadback) source.memory.root = "f".repeat(64);
          return Response.json({ account, actor: "aiko", instance: "demo", threads: source.threads, memory: source.memory });
        }
      }
      expect(parsed.origin).toBe("https://api.telegram.org");
      if (path.endsWith("/getMe")) return Response.json({ ok: true, result: { id: 987654321, is_bot: true } });
      if (path.endsWith("/getWebhookInfo")) return Response.json({ ok: true, result: { url: webhook, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], pending_update_count: 1 } });
      if (path.endsWith("/getUpdates")) { expect(leased).toBe(true); return Response.json({ ok: true, result: [{ update_id: 99, message: { text: "Private newer update must remain pending" } }] }); }
      if (path.endsWith("/setWebhook")) {
        expect(leased).toBe(true);
        webhook = body.url;
        if (switches.unknownWebhook) throw new Error("fixture lost response containing PRIVATE-ERROR");
        return Response.json({ ok: true, result: true });
      }
      throw new Error("unexpected fixture request");
    }) as typeof fetch,
  };
  return { root, config, options, io, switches, calls, serviceCalls, witness, state: () => service };
}

test("default cutover is read-only: requires real-shaped witnesses and makes no imports, files or service mutations", async () => {
  const f = fixture();
  const result = await cutoverAikoCloudflare({ ...f.options, execute: false }, f.io);
  expect(result.dryRun).toBe(true); expect(result.verified).toBe(false);
  expect(result.stage).toBe("preflight-passed");
  expect(f.serviceCalls).toEqual(["status"]);
  expect(f.calls.every(call => call.method === "GET" || call.path === "/api/control/telegram-attest")).toBe(true);
  expect(existsSync(f.options.runDir)).toBe(false);
  expect(existsSync(join(f.options.artifactDir, "migration.json"))).toBe(false);
});

test("failed live/media witness blocks before stopping the original unit", async () => {
  const f = fixture(); f.witness("live", { passed: false, startedAt: 1000 });
  await expect(cutoverAikoCloudflare(f.options, f.io)).rejects.toThrow("live-witness-not-passed");
  expect(f.calls).toHaveLength(0); expect(f.serviceCalls).toHaveLength(0);
  expect(existsSync(f.options.runDir)).toBe(false);
});

test("verified cutover imports and reads back each owner before exact offset handoff, preserves newer updates and disables old polling", async () => {
  const f = fixture(["123", "456"]);
  const result = await cutoverAikoCloudflare(f.options, f.io);
  expect(result.verified).toBe(true); expect(result.completedAt).toBe(2000);
  expect(result.accounts.every(account => account.verified)).toBe(true);
  expect(result.accounts).toHaveLength(2);
  expect(result.transportAttestedAt).toHaveLength(2);
  const imports = f.calls.filter(call => call.path === "/api/control/import");
  expect(imports).toHaveLength(2);
  const ack = f.calls.findIndex(call => call.path.endsWith("/getUpdates"));
  const readbacks = f.calls.flatMap((call, index) => call.path === "/api/control/export" ? [index] : []);
  expect(readbacks.every(index => index < ack)).toBe(true);
  expect(f.calls[ack]!.body).toEqual({ offset: 42, timeout: 0, allowed_updates: [...TELEGRAM_ALLOWED_UPDATES] });
  expect(f.calls.filter(call => call.path.endsWith("/getUpdates"))).toHaveLength(1);
  const webhook = f.calls.find(call => call.path.endsWith("/setWebhook"))!;
  expect(webhook.body).toEqual({ url: `${f.options.cloudflare.AIKO_CLOUDFLARE_URL}/telegram/webhook`, secret_token: f.config.webhookSecret,
    allowed_updates: [...TELEGRAM_ALLOWED_UPDATES], drop_pending_updates: false });
  expect(f.state()).toEqual({ active: "inactive", enabled: false });
  expect(f.serviceCalls).not.toContain("start");
  const receipt = readFileSync(join(f.options.artifactDir, "migration.json"), "utf8");
  expect(JSON.parse(receipt)).toEqual(result);
  expect(statSync(join(f.options.artifactDir, "migration.json")).mode & 0o777).toBe(0o600);
  for (const secret of [f.config.botToken!, f.config.webhookSecret!, f.config.operatorToken, "Private newer update"])
    expect(receipt).not.toContain(secret);
  expect(result.telegram?.newerUpdatesReturned).toBe(1);
});

test("partial import failure preserves populated target receipts and safely restarts only the authoritative local fallback", async () => {
  const f = fixture(["123", "456"]); f.switches.failedImport = "456";
  await expect(cutoverAikoCloudflare(f.options, f.io)).rejects.toThrow("remote-http-409");
  expect(f.calls.some(call => /getUpdates|setWebhook/.test(call.path))).toBe(false);
  expect(f.state()).toEqual({ active: "active", enabled: true });
  const receipt = JSON.parse(readFileSync(join(f.options.runDir, "migration.json"), "utf8"));
  expect(receipt.verified).toBe(false); expect(receipt.localFallback).toBe("restarted");
  expect(receipt.accounts).toMatchObject([{ account: "123", verified: true, status: "imported" }, { account: "456", verified: false, status: "attempted" }]);
  expect(receipt.recovery).toContain("Never erase target DOs");
  expect(existsSync(join(f.options.runDir, "pre-cloudflare-backup", "backup-manifest.json"))).toBe(true);
  expect(existsSync(join(f.options.artifactDir, "migration.json"))).toBe(false);
});

test("wrong bot cursor and mismatched full memory readback cannot switch Telegram", async () => {
  for (const reason of ["cursor", "readback"]) {
    const f = fixture(); f.switches.badCursor = reason === "cursor"; f.switches.tamperedReadback = reason === "readback";
    await expect(cutoverAikoCloudflare(f.options, f.io)).rejects.toThrow(reason === "cursor" ? "exact-bot-poller-cursor-required" : "readback-data-mismatch");
    expect(f.calls.some(call => /getUpdates|setWebhook/.test(call.path))).toBe(false);
    expect(f.state().active).toBe("active");
  }
});

test("uncertain webhook outcome never retries the mutation or restarts polling", async () => {
  const f = fixture(); f.switches.unknownWebhook = true;
  await expect(cutoverAikoCloudflare(f.options, f.io)).rejects.toThrow("cutover-step-failed");
  expect(f.calls.filter(call => call.path.endsWith("/setWebhook"))).toHaveLength(1);
  expect(f.serviceCalls).not.toContain("start"); expect(f.serviceCalls).not.toContain("disable");
  expect(f.state().active).toBe("inactive");
  const bytes = readFileSync(join(f.options.runDir, "migration.json"), "utf8"), result = JSON.parse(bytes);
  expect(result.telegram.webhook).toBe("attempted"); expect(result.localFallback).toBe("manual_required");
  expect(bytes).not.toContain("PRIVATE-ERROR"); expect(existsSync(join(f.options.artifactDir, "migration.json"))).toBe(false);
});

test("failure disabling the old unit does not claim verified cutover or automatically restart polling", async () => {
  const f = fixture(); f.switches.failDisable = true;
  await expect(cutoverAikoCloudflare(f.options, f.io)).rejects.toThrow("cutover-step-failed");
  const result = JSON.parse(readFileSync(join(f.options.runDir, "migration.json"), "utf8"));
  expect(result.verified).toBe(false); expect(result.telegram.webhook).toBe("verified");
  expect(result.sourceDisabled).toBe(false); expect(f.serviceCalls).not.toContain("start");
});

test("read-only configuration never creates or chmods a missing source state directory", async () => {
  const f = fixture(); const missing = join(f.root, "must-not-create");
  await expect(loadConfig({ AIKO_SECRET_FILE: join(f.root, "missing.env"), AIKO_STATE_DIR: missing,
    AIKO_OPERATOR_TOKEN: "private-operator-fixture-123456789012345", AIKO_MODE: "demo" }, { readonly: true })).rejects.toThrow();
  expect(existsSync(missing)).toBe(false);
});

test("deployed credential attestation is required before stop and rechecked before acknowledging updates", async () => {
  for (const step of [1, 2]) {
    const f = fixture(); f.switches.invalidAttestation = step;
    await expect(cutoverAikoCloudflare(f.options, f.io)).rejects.toThrow("deployed-telegram-credentials-mismatch");
    expect(f.calls.some(call => /getUpdates|setWebhook/.test(call.path))).toBe(false);
    if (step === 1) {
      expect(f.serviceCalls).not.toContain("stop"); expect(existsSync(f.options.runDir)).toBe(false);
    } else {
      expect(f.state().active).toBe("active");
      const evidence = JSON.parse(readFileSync(join(f.options.runDir, "migration.json"), "utf8"));
      expect(evidence.accounts[0].verified).toBe(true); expect(evidence.localFallback).toBe("restarted");
    }
  }
});
