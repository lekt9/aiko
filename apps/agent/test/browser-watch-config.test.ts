import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Event } from "tardie/core/event";
import { parseBrowserWatchDeployment, configuredBrowserWatchPolicy, type BrowserWatchDeployment } from "../src/browser-watch-config.ts";
import { ConnectorEngine, connectorStorePrefix, type ConnectorStore } from "../src/connectors.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, type HarnessLibraryBinding, type HarnessVerifier } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { channelSeal } from "../src/channel-custody.ts";
import { BROWSER_EVENT_SCHEMA } from "../src/browser-events.ts";
import type { BrowserWatchConfig, BrowserWatchDispatch } from "../src/browser-watches.ts";
import type { NativeBrowserWatchPolicyOptions } from "../src/browser-watch-policy.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";

const owner = "123", connectionId = "11111111-1111-4111-8111-111111111111";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const signal = () => AbortSignal.timeout(5000);
const deployment = (): BrowserWatchDeployment => ({ version: 1, ingressOrigin: "https://ingress.example.com", owners: {
  [owner]: { sources: [{ connectionId, label: "Connected requests", origin: "https://site.example.com", sourceGeneration: 3,
    events: [{ id: "request", label: "New request", kind: "push", outcome: "received" }] }],
    actions: [{ id: "investigate", label: "Investigate", supportsInstruction: true, action: { kind: "actor", instruction: "Investigate the new request" } }],
    defaults: { expiresInMs: 60000, backlog: 8, maxOccurrences: 100 } },
} });
const parse = (value: unknown) => parseBrowserWatchDeployment(JSON.stringify(value));

async function fixture() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec("CREATE TABLE watch_connector_records(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  let inside = false, enabled = true, privateCalls = 0, executions = 0, contextReads = 0, contextRevision = 1;
  const denied = async (): Promise<never> => { privateCalls++; throw Error("Discovery must not call a private browser or provider"); };
  const read = (key: string) => {
    const row = db.query("SELECT value FROM watch_connector_records WHERE key=?").get(key) as { value: string } | null;
    return row ? JSON.parse(row.value) : undefined;
  };
  const write = (key: string, value: unknown) => { db.query("INSERT INTO watch_connector_records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(value)); };
  const key = `${connectorStorePrefix(owner)}connection:${connectionId}`;
  const record = { id: connectionId, owner, connectorId: "browser:site.example.com", provider: "browser", status: "connected", createdAt: Date.now(),
    browserVerification: { verified: true, revision: 7, expiresAt: Date.now() + 3600000 }, credentialReference: "PRIVATE_CREDENTIAL_REFERENCE" };
  write(key, record);
  const store: ConnectorStore = { get: async key => read(key), set: async (key, value) => { write(key, value); },
    getSync: key => { expect(inside).toBe(true); return read(key); },
    list: async prefix => db.query("SELECT key,value FROM watch_connector_records ORDER BY key").all().flatMap(raw => {
      const row = raw as { key: string; value: string }; return row.key.startsWith(prefix) ? [JSON.parse(row.value)] : [];
    }) };
  const connections = new ConnectorEngine({ owner, store, secureBrowser: { native: true, begin: denied, status: denied, control: denied, disconnect: denied }, onEvent: denied, fetch: denied });
  const events: Event[] = [], journal = { read: async () => events, append: async (batch: Event[]) => { events.push(...batch); } };
  const verifier: HarnessVerifier = { digest: harnessDigest("config-verifier"), evaluatorDigest: harnessDigest("config-cases"),
    cases: [{ id: "dev", input: { n: 2 }, split: "development" }, { id: "held", input: { n: 7 }, split: "held-out" }],
    verify: async ({ input, output }) => ({ passed: output === (input as { n: number }).n * 2, quality: null, evidence: ["independent-double-check"] }) };
  const binding: HarnessLibraryBinding = { owner, thread: `user-${owner}`, blobs: harnessBlobStore(sqliteWorkflowKV(db)), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {},
    context: async () => { contextReads++; return { placement: "local", runtimeDigest: harnessDigest(["config-quickjs", contextRevision]), bindings: {} }; }, authorize: async () => true,
    execute: async (job, s) => {
      executions++;
      const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, s);
      return { status: "succeeded", output: result.result as number, evidence: ["real-quickjs"] };
    } };
  const library = new HarnessLibrary(binding, journal);
  const contractDigest = await library.registerContract({ version: 1, outcome: "Double the current input", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
    outputSchema: { type: "number" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {}, timeoutMs: 1000 });
  const digest = await library.record({ version: 1, name: "config-double", description: "Double the selected input", runtime: "javascript", entrypoint: "main.js", files: { "main.js": "return input.n * 2;" }, dependencies: [],
    sources: [{ uri: "fixture:config", revision: "1", digest: harnessDigest("config-double-source"), license: "test-fixture" }], contractDigest });
  const runner: NativeBrowserWatchPolicyOptions["runner"] = { watchContext: denied, watchConfigure: denied, watchPause: denied, watchStatus: denied, watchAcknowledgeGap: denied };
  let configuration: BrowserWatchDeployment | undefined = parse(deployment());
  const options = { owner, configuration: () => configuration, connections, runner, library, receivingAuthority: `registry-internal:${owner}`, current: () => enabled };
  const context = { owner, thread: `user-${owner}`, journal: undefined as never, wiring: undefined as never, sources: undefined as never };
  const mount = () => configuredBrowserWatchPolicy(options)!(context);
  const event: BrowserWatchDispatch["event"] = { type: "AikoBrowserPushObserved", schema: BROWSER_EVENT_SCHEMA, owner, id: "event-1", producer: "watch-requests", epoch: "profile-epoch", profile: "owned", generation: 3,
    connectionId, connectionRevision: "7", sequence: 1, occurrence: "occurrence-1", kind: "push", observedAt: Date.now(), at: Date.now(), sourceId: "source-1", fields: { origin: "https://site.example.com", outcome: "received" },
    commitment: await channelSeal(binding.blobs, owner, { id: "source-1" }) };
  const intent: BrowserWatchDispatch = { operationId: "fixture-operation", watchId: "requests", generation: 1, event, action: deployment().owners[owner]!.actions[0]!.action };
  const watchConfig: BrowserWatchConfig = { id: "requests", label: "New requests", connectionId, connectionRevision: "7", sourceGeneration: 3,
    origin: "https://site.example.com", kind: "push", outcome: "received", action: intent.action, expiresAt: Date.now() + 60000, backlog: 8, maxOccurrences: 100 };
  const transaction = <T>(fn: () => T) => db.transaction(() => { inside = true; try { return fn(); } finally { inside = false; } })();
  return { options, context, mount, library, digest, contractDigest, intent, watchConfig, store, transaction,
    get configuration() { return configuration!; }, configure: (next: BrowserWatchDeployment | undefined) => { configuration = next; },
    mutateRecord: (change: (row: typeof record) => void) => { const row = read(key) as typeof record; change(row); write(key, row); },
    privateCalls: () => privateCalls, executions: () => executions, contextReads: () => contextReads, revoke: () => { enabled = false; }, drift: () => { contextRevision++; } };
}

test("deployment parser rejects untrusted shape, destinations and invalid event capabilities", () => {
  expect(parseBrowserWatchDeployment()).toBeUndefined(); expect(parseBrowserWatchDeployment("")).toBeUndefined();
  expect(parse(deployment())).toEqual(deployment());
  const invalid: unknown[] = [null, [], {}, { ...deployment(), version: 2 }, { ...deployment(), unexpected: true }];
  for (const ingressOrigin of ["http://ingress.example.com", "https://127.0.0.1", "https://ingress.example.com/path", "https://user:password@ingress.example.com"])
    invalid.push({ ...deployment(), ingressOrigin });
  const change = (fn: (value: any) => void) => { const value = deployment(); fn(value); invalid.push(value); };
  change(c => { c.owners[owner].sources[0].connectionRevision = "guessed"; });
  change(c => { c.owners[owner].sources[0].expiresAt = Date.now() + 60000; });
  change(c => { c.owners[owner].sources.push(c.owners[owner].sources[0]); });
  change(c => { c.owners[owner].sources[0].events[0].kind = "notification"; });
  change(c => { c.owners[owner].sources[0].events[0].route = "/private"; });
  change(c => { c.owners[owner].actions[0].action = { kind: "webhook", destination: "arbitrary" }; });
  change(c => { c.owners[owner].actions[0].commitCurrent = true; });
  change(c => { c.owners[owner].defaults.backlog = 0; });
  change(c => { c.owners[owner].actions.push(c.owners[owner].actions[0]); });
  for (const value of invalid) expect(() => parse(value)).toThrow("Invalid AIKO_BROWSER_WATCH_CONFIG");
  expect(() => parseBrowserWatchDeployment("{" )).toThrow();
  expect(() => parseBrowserWatchDeployment(" ".repeat(262145))).toThrow();
});

test("deployment parser rejects missing harness inputs and unsafe event mappings", () => {
  const valid = deployment(); valid.owners[owner]!.actions = [{ id: "saved", label: "Saved", action: { kind: "harness", digest: harnessDigest("artifact"), contractDigest: harnessDigest("contract"), input: {}, eventInputs: { value: ["payload", "value"] } } }];
  expect(parse(valid)).toEqual(valid);
  for (const change of [(a: any) => { delete a.input; }, (a: any) => { a.eventInputs = "payload"; },
    (a: any) => { a.eventInputs = { value: [] }; }, (a: any) => { a.eventInputs = { value: ["__proto__"] }; },
    (a: any) => { a.eventInputs = JSON.parse('{"constructor":["payload","value"]}'); }]) {
    const invalid = structuredClone(valid); change(invalid.owners[owner]!.actions[0]!.action);
    expect(() => parse(invalid)).toThrow("Invalid AIKO_BROWSER_WATCH_CONFIG");
  }
});

test("discovery derives current connection revision and expiry without opening the private runner", async () => {
  const f = await fixture(), policy = f.mount();
  expect(policy.library).toBe(f.library);
  const found = await policy.discovery!(signal());
  expect(found.sites).toMatchObject([{ connectionId, connectionRevision: "7", sourceGeneration: 3, origin: "https://site.example.com" }]);
  expect(found.sites[0]!.expiresAt).toBeGreaterThan(Date.now());
  expect(found.actions.map(a => a.id)).toEqual(["investigate"]);
  f.mutateRecord(row => { row.browserVerification.revision = 8; });
  expect((await policy.discovery!(signal())).sites[0]!.connectionRevision).toBe("8");
  expect(JSON.stringify(found)).not.toContain("PRIVATE"); expect(f.privateCalls()).toBe(0); expect(f.executions()).toBe(0); expect(f.contextReads()).toBe(0);
});

test("deployment owner, source domain and current configuration cuts are enforced", async () => {
  const f = await fixture(), policy = f.mount();
  expect(configuredBrowserWatchPolicy({ ...f.options, owner: "456" })).toBeUndefined();
  expect(() => configuredBrowserWatchPolicy(f.options)!({ ...f.context, owner: "456", thread: "user-456" })).toThrow("owner_invalid");
  f.mutateRecord(row => { row.owner = "456"; });
  expect((await policy.discovery!(signal())).sites).toEqual([]);
  f.mutateRecord(row => { row.owner = owner; row.connectorId = "browser:other.example.com"; });
  expect((await policy.discovery!(signal())).sites).toEqual([]);
  f.mutateRecord(row => { row.connectorId = "browser:site.example.com"; });
  f.configuration.owners[owner]!.sources[0]!.events[0]!.label = "Changed deployment";
  expect(policy.current()).toBe(false);
  await expect(policy.discovery!(signal())).rejects.toThrow("authority_unavailable");
  const fresh = f.mount(); expect(fresh.current()).toBe(true);
  f.configure(undefined); expect(fresh.current()).toBe(false);
  expect(configuredBrowserWatchPolicy(f.options)).toBeUndefined(); expect(f.privateCalls()).toBe(0);
});

test("actor commit authority reads current persisted connection state inside the storage transaction", async () => {
  const f = await fixture(), policy = f.mount(), commit = policy.nativeActions!.actor!.commitCurrent;
  expect(f.transaction(() => commit(f.intent))).toBe(true);
  for (const mutate of [(row: any) => { row.browserVerification.revision = 8; }, (row: any) => { row.status = "disconnected"; },
    (row: any) => { row.browserVerification.expiresAt = Date.now() - 1; }, (row: any) => { row.owner = "456"; }]) {
    const g = await fixture(), check = g.mount().nativeActions!.actor!.commitCurrent;
    expect(g.transaction(() => { g.mutateRecord(mutate); return check(g.intent); })).toBe(false);
  }
  expect(f.transaction(() => commit({ ...f.intent, event: { ...f.intent.event, generation: 4 } }))).toBe(false);
  expect(f.transaction(() => commit({ ...f.intent, event: { ...f.intent.event, owner: "456" } }))).toBe(false);
  f.revoke(); expect(f.transaction(() => commit(f.intent))).toBe(false);
  expect(f.privateCalls()).toBe(0);
});

test("missing synchronous connector access fails closed and current deployment removal revokes actor admission", async () => {
  const f = await fixture(), policy = f.mount(), commit = policy.nativeActions!.actor!.commitCurrent;
  delete f.store.getSync;
  expect(f.transaction(() => commit(f.intent))).toBe(false);
  expect((await policy.discovery!(signal())).sites).toHaveLength(1);
  const g = await fixture(), check = g.mount().nativeActions!.actor!.commitCurrent;
  g.configure({ ...g.configuration, owners: {} });
  expect(g.transaction(() => check(g.intent))).toBe(false);
  expect(g.privateCalls()).toBe(0);
});

test("saved harness discovery reads retained evaluation metadata without checking or starting a runtime", async () => {
  const f = await fixture();
  f.configuration.owners[owner]!.actions = [{ id: "saved", label: "Saved", action: { kind: "harness", digest: f.digest, contractDigest: f.contractDigest, input: { n: 9 } } },
    { id: "missing", label: "Missing", action: { kind: "harness", digest: harnessDigest("absent"), contractDigest: f.contractDigest, input: { n: 9 } } }];
  const policy = f.mount();
  expect((await policy.discovery!(signal())).actions).toEqual([]); expect(f.executions()).toBe(0); expect(f.contextReads()).toBe(0);
  await f.library.evaluate(f.digest, "config-evaluation", signal());
  const evaluations = f.executions(), contextReads = f.contextReads(); expect(evaluations).toBeGreaterThan(0);
  expect((await policy.discovery!(signal())).actions.map(action => action.id)).toEqual(["saved"]);
  expect(f.executions()).toBe(evaluations); expect(f.privateCalls()).toBe(0); expect(f.contextReads()).toBe(contextReads);
  // Discovery says this exact saved pin was evaluated. The execution adapter
  // separately checks its current context and may reject it after runtime drift.
  f.drift(); expect((await policy.discovery!(signal())).actions.map(action => action.id)).toEqual(["saved"]);
  expect(f.executions()).toBe(evaluations); expect(f.contextReads()).toBe(contextReads);
});

test("fresh policy rejects retained watches whose source, action or connection revision was removed", async () => {
  const f = await fixture();
  expect(f.transaction(() => f.mount().configCurrent!(f.watchConfig))).toBe(true);
  for (const change of [(c: BrowserWatchDeployment) => { c.owners[owner]!.sources = []; },
    (c: BrowserWatchDeployment) => { c.owners[owner]!.actions = []; },
    (c: BrowserWatchDeployment) => { c.owners[owner]!.sources[0]!.sourceGeneration++; },
    (c: BrowserWatchDeployment) => { c.owners[owner]!.sources[0]!.events[0]!.outcome = "failed"; }]) {
    const g = await fixture(); change(g.configuration);
    const fresh = g.mount(); expect(fresh.current()).toBe(true);
    expect(g.transaction(() => fresh.configCurrent!(g.watchConfig))).toBe(false);
    expect(g.privateCalls()).toBe(0); expect(g.contextReads()).toBe(0);
  }
  f.mutateRecord(row => { row.browserVerification.revision = 8; });
  expect(f.transaction(() => f.mount().configCurrent!(f.watchConfig))).toBe(false);
});

test("webhook deployment accepts only owned destination references and bounded metadata without inline keys",()=>{
  const value=deployment();value.owners[owner]!.webhooks=[{id:"requests-v1",url:"https://hooks.receiver.com/aiko",signingKeyRef:"requests-v1",expiresAt:Date.now()+60000,maxBytes:8192,retentionMs:60000}];
  value.owners[owner]!.actions=[{id:"deliver",label:"Send request",action:{kind:"webhook",destination:"requests-v1"}}];
  expect(parse(value)).toEqual(value);
  for(const change of [(v:any)=>{v.owners[owner].webhooks[0].signingKey="PRIVATE_INLINE_KEY";},(v:any)=>{v.owners[owner].webhooks[0].url="https://127.0.0.1/private";},
    (v:any)=>{v.owners[owner].actions[0].action.destination="foreign";},(v:any)=>{v.owners[owner].webhooks.push(v.owners[owner].webhooks[0]);},
    (v:any)=>{v.owners[owner].webhooks[0].reconcile={url:"https://hooks.receiver.com/receipt",receiptKey:"INLINE_KEY"};},
    (v:any)=>{v.owners[owner].webhooks[0].notAcceptedStatuses=[202];},(v:any)=>{v.owners[owner].webhooks[0].maxBytes=1000000;},
    (v:any)=>{v.owners[owner].actions[0].supportsInstruction=true;}]){
    const bad=structuredClone(value);change(bad);expect(()=>parse(bad)).toThrow("Invalid AIKO_BROWSER_WATCH_CONFIG");
  }
});

test("webhook secret map rejects ambiguous or malformed references with a generic error",async()=>{
  const {parseBrowserWatchWebhookKeys}=await import("../src/browser-watch-config.ts");
  expect(parseBrowserWatchWebhookKeys()).toEqual({});
  expect(parseBrowserWatchWebhookKeys(JSON.stringify({version:1,owners:{[owner]:{key:"a".repeat(32)}}}))).toEqual({[owner]:{key:"a".repeat(32)}});
  for(const raw of ['{',JSON.stringify({version:1,owners:{[owner]:{key:"short"}}}),JSON.stringify({version:1,owners:{[owner]:{key:"a".repeat(31)+"\n"}}}),
    '{"version":1,"owners":{"123":{"__proto__":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}',JSON.stringify({version:2,owners:{}})])
    expect(()=>parseBrowserWatchWebhookKeys(raw)).toThrow("Invalid AIKO_BROWSER_WATCH_WEBHOOK_KEYS");
});
