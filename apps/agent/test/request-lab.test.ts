import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { nodeStorage } from "entity-learn";
import { Memory } from "entity-learn/cloudflare";
import { ownedNetworkDefinitions } from "../src/capability-builder-network.ts";
import { REQUEST_LAB_SCENARIOS, runRequestLab, type RequestLabScenario } from "../src/request-lab.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { accountDirectory } from "../src/accounts.ts";
import { openMemory } from "../src/memory.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const storageFor = () => {
  const storage = nodeStorage(":memory:");
  cleanup.push(() => storage.close());
  return storage;
};

for (const scenario of REQUEST_LAB_SCENARIOS) test(`controlled request lab measures ${scenario} using actual compiler and memory`, async () => {
  const storage = storageFor();
  const report = await runRequestLab({ scenario, storage });
  expect(report.status).toBe("passed");
  expect(report.checks.every(check => check.passed)).toBe(true);
  expect(report.limits).toMatchObject({ realNetwork: false, realBrowser: false, realModel: false, nativeActorRun: false });
  expect(report.pointer).toMatchObject({ cacheReused: true, embeddingCalls: 2, embeddingModel: "fixture-deterministic-embedding-v1" });
  expect(report.workflow).toMatchObject({ reusable: true, source: "fixed-example", idempotentReuse: true });
  expect(report.workflow.runs[0]).toMatchObject({ status: "succeeded", calls: 2, steps: [{ id: "hydrate", status: "succeeded" }, { id: "inspect", status: "succeeded" }] });
  expect(report.replays[0]).toMatchObject({ status: "completed", changed: null });
  expect(report.replays[0]!.result).toEqual({ caption: "synthetic-replay-caption", queued: 3 });
  expect(report.replays[0]!.requests).toHaveLength(2);
  expect(new URL(report.replays[0]!.requests[1]!.url).searchParams.get("item")).toBe("fresh-baseline-item");
  const definition = ownedNetworkDefinitions(report.evidence.events).find(item => item.toolDigest === report.capture.toolDigest);
  expect(definition?.definition.steps).toHaveLength(2);
  expect(definition?.definition.dependencies).toHaveLength(1);
  const memory = new Memory({ storage, scope: `request-memory:${report.id}` });
  expect(memory.get(report.pointer.id)?.observation.type).toBe("request-pointer");
  expect(memory.get(report.derived.id)?.freshness).toBe(report.derived.after);
  expect(memory.get(report.derived.recomputedId ?? report.derived.id)?.freshness).toBe(report.derived.final);
  for (const edge of report.edges) {
    expect(report.nodes.some(node => node.id === edge.from)).toBe(true);
    expect(report.nodes.some(node => node.id === edge.to)).toBe(true);
  }
  expect(JSON.stringify(report).length).toBeLessThan(64_000);
  expect(JSON.stringify(memory.exportArchive()) + JSON.stringify(report.evidence.events)).not.toMatch(/captured-fixture-caption|synthetic-replay-caption|fresh-baseline-item|fresh-comparison-item/);
  expect(report.evidence.events.some(event => ["CodeDispatched", "CodeSettled", "ToolCalled", "ToolReturned"].includes(event.type))).toBe(false);

  if (scenario === "baseline") {
    expect(report.replays).toHaveLength(1);
    expect(report.derived).toMatchObject({ before: "fresh", after: "fresh", final: "fresh" });
  } else if (scenario === "missing_dependency") {
    expect(report.replays[1]!.status).not.toBe("completed");
    expect(report.replays[1]!.requests).toHaveLength(1);
    expect(report.replays[1]!.observationId).toBeUndefined();
    expect(report.replays[1]!.result).toBeUndefined();
    expect(report.nodes.find(node => node.label === "GET /details")).toMatchObject({ kind: "request", state: "blocked" });
    expect(report.workflow.runs[1]).toMatchObject({ status: "failed", calls: 1, steps: [{ id: "hydrate", status: "failed" }, { id: "inspect", status: "skipped" }] });
    expect(report.derived).toMatchObject({ before: "fresh", after: "fresh", final: "fresh" });
    expect(report.evidence.events.filter(event => event.type === "AikoRequestMemoryChecked")).toHaveLength(1);
  } else {
    expect(report.replays[1]).toMatchObject({ status: "completed", changed: scenario === "changed" });
    expect(report.replays[1]!.result).toEqual({ caption: "synthetic-replay-caption", queued: scenario === "changed" ? 4 : 3 });
    expect(report.replays[1]!.requests).toHaveLength(2);
    expect(new URL(report.replays[1]!.requests[1]!.url).searchParams.get("item")).toBe("fresh-comparison-item");
    expect(report.derived).toMatchObject({ before: "fresh", after: "stale", final: "fresh" });
    expect(report.derived.recomputedId).toBeString();
    if (scenario === "unchanged") expect(report.replays[1]!.responseDigest).toBe(report.replays[0]!.responseDigest);
    else expect(report.replays[1]!.responseDigest).not.toBe(report.replays[0]!.responseDigest);
    expect(report.evidence.events.filter(event => event.type === "AikoRequestMemoryChecked")).toHaveLength(2);
  }
});

test("lab refuses existing account or reused storage without changing it", async () => {
  const storage = storageFor();
  const first = await runRequestLab({ scenario: "baseline", storage });
  const memory = new Memory({ storage, scope: `request-memory:${first.id}` });
  const prior = memory.exportArchive();
  await expect(runRequestLab({ scenario: "changed", storage })).rejects.toThrow("fresh disposable storage");
  expect(memory.exportArchive()).toEqual(prior);
  const secondStorage = storageFor();
  const second = await runRequestLab({ scenario: "changed", storage: secondStorage });
  expect(second.id).not.toBe(first.id);
  expect(memory.get(second.pointer.id)).toBeNull();
});

test("invalid scenarios and pre-aborted runs stop before storage is used", async () => {
  let touched = false;
  const touch = (): never => { touched = true; throw new Error("Storage touched"); };
  const storage = { exec: touch, prepare: touch, transaction: touch, read: touch, close: touch };
  await expect(runRequestLab({ scenario: "foreign" as RequestLabScenario, storage })).rejects.toThrow("Unknown request lab scenario");
  const controller = new AbortController(); controller.abort();
  await expect(runRequestLab({ scenario: "baseline", storage, signal: controller.signal })).rejects.toThrow();
  expect(touched).toBe(false);
});

test("authenticated service runs lab without modifying its native thread or personal memory", async () => {
  const { createService } = await import("../src/server.ts");
  const stateDir = await mkdtemp("/tmp/aiko-request-lab-service-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const ownerToken = "aiko_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const readToken = "aiko_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const config: AikoConfig = { stateDir, mode: "demo", port: 4242, operatorToken: "request-lab-test-operator-12345678901234567890", persona: PERSONA, voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]), browser: { executablePath: "fixture-never-execute", domains: ["*"] },
    planeCredentials: [{ account: "123", digest: credentialDigest(ownerToken), scopes: ["read", "write"] }, { account: "123", digest: credentialDigest(readToken), scopes: ["read"] }] };
  let browserStarts = 0;
  const service = await createService(config, { browserFactory: async () => { browserStarts++; throw new Error("Lab must not provision a browser"); } });
  cleanup.push(() => service.close());
  const binding = { stateDir: accountDirectory(stateDir, "123"), owner: "123", thread: "user-123", redact: (text: string) => text, readPage: async () => [] };
  const personal = openMemory(binding);
  personal.remember({ subject: "personal-note", title: "Personal note", type: "note", payload: { text: "PRIVATE_OWNER_NOTE" } }, { key: "personal-note", producer: { kind: "user", reference: "fixture" } });
  const beforeMemory = personal.exportArchive(); personal.close();
  await service.host.commitRoot(service.host.self("user-123"), { type: "AikoRequestMemoryIndexUnavailable", id: crypto.randomUUID(), toolDigest: "sha256:" + "a".repeat(64), at: Date.now() });
  const beforeLog = await service.host.read("user-123");
  const beforeThreads = await service.host.threads();
  const endpoint = "http://127.0.0.1/api/control/request-lab";
  const request = (method = "GET", token = ownerToken, account = "123", extraHeaders: Record<string, string> = {}) => service.fetch(new Request(endpoint, {
    method, headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}), ...extraHeaders },
    ...(method === "POST" ? { body: JSON.stringify({ account, scenario: "unchanged" }) } : {}),
  }));
  expect((await request("GET", "invalid")).status).toBe(401);
  expect((await request("POST", readToken)).status).toBe(403);
  expect((await request("POST", ownerToken, "456")).status).toBe(403);
  expect((await request("POST", ownerToken, "123", { origin: "https://foreign.example" })).status).toBe(403);
  const controller = new AbortController(); controller.abort();
  const cancelled = await service.fetch(new Request(endpoint, { method: "POST", signal: controller.signal,
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" }, body: JSON.stringify({ account: "123", scenario: "changed" }) }));
  expect(cancelled.status).toBe(408);
  expect(await cancelled.json()).toEqual({ error: "lab_cancelled" });
  const capability = await request();
  expect(capability.status).toBe(200);
  expect(await capability.json()).toMatchObject({ available: true, mode: "controlled-fixture" });
  const response = await request("POST");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const report = await response.json();
  expect(report).toMatchObject({ scenario: "unchanged", status: "passed", derived: { after: "stale", final: "fresh" }, limits: { nativeActorRun: false } });
  expect(report.replays[1]).toMatchObject({ changed: false, result: { queued: 3 } });
  expect(JSON.stringify(report)).not.toContain("PRIVATE_OWNER_NOTE");
  expect(await service.host.threads()).toEqual(beforeThreads);
  expect(await service.host.read("user-123")).toEqual(beforeLog);
  const afterMemory = openMemory(binding);
  try { expect(afterMemory.exportArchive()).toEqual(beforeMemory); } finally { afterMemory.close(); }
  expect(browserStarts).toBe(0);
});
