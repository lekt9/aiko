import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createService } from "../src/server.ts";
import { PERSONA, type AikoConfig } from "../src/config.ts";
import { credentialDigest } from "../src/plane-auth.ts";
import { accountDirectory } from "../src/accounts.ts";
import { openMemory } from "../src/memory.ts";
import { CONTROL_HTML } from "../src/control.ts";
import { GRAPH_SCRIPT } from "../src/control-graph.ts";
import { controlApi } from "../src/control-api.ts";
import { nodeStorage } from "entity-learn";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const ownerToken = "aiko_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const operatorToken = "graph-fixture-operator-12345678901234567890";
const write = (key: string) => ({ key, producer: { kind: "tool" as const, reference: "fixture" } });

test("authenticated graph read preserves owner boundaries, suppression and no-store without provisioning a browser", async () => {
  const stateDir = await mkdtemp("/tmp/aiko-graph-"); cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  const config: AikoConfig = { stateDir, mode: "demo", port: 4242, operatorToken, persona: PERSONA, voiceEnabled: false,
    allowedUsers: new Set(["123", "456"]), browser: { executablePath: "fixture-never-execute", domains: ["*"] },
    planeCredentials: [{ account: "123", digest: credentialDigest(ownerToken), scopes: ["read"] }] };
  let browserStarts = 0;
  const service = await createService(config, { browserFactory: async () => { browserStarts++; throw new Error("Must not provision"); } });
  cleanups.push(() => service.close());
  const binding = (owner: string) => ({ stateDir: accountDirectory(stateDir, owner), owner, thread: `user-${owner}`, redact: (s: string) => s, readPage: async () => [] });
  let sourceId = "";
  for (const owner of ["123", "456"]) {
    const memory = openMemory(binding(owner));
    try { const source = memory.remember({ subject: "source", title: owner === "123" ? "<img src=x onerror=alert(1)>" : "FOREIGN_LABEL", type: "note", payload: { text: "PAYLOAD_MUST_NOT_LEAVE" } }, write("source"));
      memory.remember({ subject: "derived", title: "Supported note", type: "note", payload: null, supports: [source.id] }, write("derived"));
      if (owner === "123") sourceId = source.id;
    } finally { memory.close(); }
  }
  const receipt = { type: "AikoRequestMemoryIndexed", id: "11111111-1111-4111-8111-111111111111", toolDigest: "sha256:" + "a".repeat(64), pointerId: "obs_" + "b".repeat(64), model: "fixture-local", at: 1000 };
  await service.host.commitRoot(service.host.self("user-123"), receipt);
  await service.host.commitRoot(service.host.self("user-123"), { ...receipt, at: 1001 }); // Redelivery keeps the occurrence, even when host ingress adds a new timestamp.
  expect((await service.host.read("user-123")).filter(e => e.type === receipt.type)).toHaveLength(1);
  const request = (suffix = "", token = ownerToken) => service.fetch(new Request("http://127.0.0.1/api/control/memory-graph" + suffix, { headers: { authorization: "Bearer " + token } }));
  expect((await request("", "invalid")).status).toBe(401);
  expect((await request("?account=456")).status).toBe(403);
  const response = await request(); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  const data = await response.json();
  expect(data).toMatchObject({ account: "123", readOnly: true, knowledge: { status: "available" }, browser: { status: "available", pointerAvailability: "not-checked" } });
  expect(data.knowledge.edges.some((e: any) => e.relation === "supports")).toBe(true);
  expect(data.browser.nodes.some((n: any) => n.kind === "request-pointer")).toBe(true);
  expect(JSON.stringify(data)).not.toMatch(/PAYLOAD_MUST_NOT_LEAVE|FOREIGN_LABEL/);
  expect(JSON.stringify(await (await request("?account=456", operatorToken)).json())).toContain("FOREIGN_LABEL");
  for (const suffix of ["?browserAfter=-1", "?browserAfter=1.2", "?browserAfter=9007199254740992", "?after=bad", "?execute=true"]) expect((await request(suffix)).status).toBe(400);
  const memory = openMemory(binding("123")); try { memory.forget("source", sourceId, "forget"); } finally { memory.close(); }
  expect((await (await request()).json()).knowledge.nodes).toEqual([]);
  expect(browserStarts).toBe(0);
  const html = await service.fetch(new Request("http://127.0.0.1/control")); expect((await html.text())).toContain('id="graph-tab"');
});

test("graph API uses injected Worker-style storage, bounds log reads, and discloses independent failed lanes", async () => {
  const storage = nodeStorage(":memory:"); cleanups.push(async () => storage.close());
  // Use the platform-neutral constructor through an injected storage factory, not the filesystem opener.
  const { Memory: CoreMemory } = await import("entity-learn/cloudflare");
  const open = () => new CoreMemory({ storage: { ...storage, close: () => {} }, scope: "aiko:123" });
  open().remember({ subject: "worker", title: "Worker record", type: "note", payload: null }, write("worker"));
  let calls = 0, failLog = false;
  const context = (url: string) => ({
    host: { threads: async () => ["user-123"], readPage: async (_thread: string, after: number, limit: number) => {
      calls++; if (failLog) throw new Error("PRIVATE_ERROR"); expect(limit).toBeLessThanOrEqual(129);
      return Array.from({ length: Math.min(limit, 1100 - after) }, (_, i) => ({ seq: after + i + 1, event: { type: "MessageReceived", text: "DO_NOT_PROJECT" } }));
    } }, config: {}, principal: { owner: "123", operator: false, scopes: ["read"] }, request: new Request(url), url: new URL(url),
    redact: (s: string) => s, serialize: async (fn: () => Promise<unknown>) => fn(), validOwner: (id: string) => id === "123",
    memoryBindingFor: () => ({ owner: "123", thread: "user-123", stateDir: "/proc/must-not-open-files", openMemory: open, redact: (s: string) => s, readPage: async () => [] }),
  } as unknown as Parameters<typeof controlApi>[0]);
  const base = "http://fixture/api/control/memory-graph";
  const first = await (await controlApi(context(base))).json();
  expect(first.knowledge.nodes).toHaveLength(1); expect(first.browser).toMatchObject({ nextAfter: 1024, scanned: 1024, coverage: "partial", reasons: ["event_window"] });
  expect(calls).toBe(8); expect(JSON.stringify(first)).not.toContain("DO_NOT_PROJECT");
  const next = await (await controlApi(context(base + "?browserAfter=1024"))).json(); expect(next.browser).toMatchObject({ scanned: 76, nextAfter: null, reasons: ["page_window"] });
  failLog = true; const failed = await (await controlApi(context(base))).json(); expect(failed.knowledge.status).toBe("available"); expect(failed.browser.status).toBe("unavailable"); expect(JSON.stringify(failed)).not.toContain("PRIVATE_ERROR");
});

test("panel script parses, uses text-only graph nodes, exposes keyboard tabs/list fallback, and clears expired data", () => {
  const scripts = [...CONTROL_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]!);
  expect(scripts).toHaveLength(1); expect(() => new Function(scripts[0]!)).not.toThrow();
  const ids = [...CONTROL_HTML.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); expect(new Set(ids).size).toBe(ids.length);
  expect(GRAPH_SCRIPT).not.toMatch(/innerHTML|insertAdjacentHTML|localStorage|sessionStorage|\.embed\(|\.hydrate\(/);
  for (const value of ['role="tabpanel" aria-labelledby="graph-tab"', 'id="graph-mode"', 'id="graph-detail"', 'id="graph-next"']) expect(CONTROL_HTML).toContain(value);
  expect(GRAPH_SCRIPT).toContain("if(epoch!==state.epoch)return"); expect(GRAPH_SCRIPT).toContain("data=null;selected='';error=");
  expect(CONTROL_HTML).toContain("graphView.reset()"); expect(CONTROL_HTML).toContain("['events','memory','graph','request-lab']");
});
