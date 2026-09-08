import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Layer } from "effect";
import { actor, agentMessageMethod } from "tardie";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { createHostedChannels, channelHarnessHandlers } from "../src/channel-host.ts";
import { channelWiringAppendAllowed, channelWiringEventKey } from "../src/channel-wiring.ts";
import { channelLogSourceAppendAllowed, channelLogSourceEventKey } from "../src/channel-log-source.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryEventKey, type HarnessLibraryBinding, type HarnessJournal } from "../src/harness-library.ts";
import { BROWSER_EVENT_SCHEMA, browserBatchSignature, browserEventAppendAllowed, browserEventKey, type BrowserEventBatch } from "../src/browser-events.ts";
import { browserWatchAppendAllowed, browserWatchEventKey, browserWatchHarnessDefinitions, createBrowserWatches, type BrowserWatchConfig, type BrowserWatchBindings, type BrowserWatchDispatch } from "../src/browser-watches.ts";
import { channelDigest } from "../src/channel-bindings.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { hostedChannelDeadlines, hostedChannelWaitMethod, hostedChannelDeadlineKey } from "../src/registry-host.ts";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
const signal = () => AbortSignal.timeout(20_000);
async function fixture(options: { configCurrent?: BrowserWatchBindings["configCurrent"]; acknowledgeGap?: BrowserWatchBindings["acknowledgeGap"]; authorize?: BrowserWatchBindings["authorize"]; deferConsumer?: boolean; execute?: BrowserWatchBindings["execute"]; reconcile?: BrowserWatchBindings["reconcile"] } = {}) {
  const owner = "watch-owner", thread = `user-${owner}`, db = new Database(":memory:");
  let runtime = 1;
  let alarm: number | null = null, authorized = true, consumerEnabled = !options.deferConsumer;
  let pauseFailures = 0, losePauseAcknowledgement = false, wrongStatusGeneration = false, foreignStatusProducer = false, omitPausedThrough = false, staleLifecycle = false;
  let renewalFailures = 0, loseRenewalAcknowledgement = false, stallRenewal = false;
  const privateLeases = new Map<string, { producer: string; generation: number; lifecycleRevision: number; leaseRevision: number; expiresAt: number; state: string; pausedThrough?: number }>();
  const privateHeads = new Map<string, number>();
  const storage: AccountStorage = { sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {},
    getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const calls: BrowserWatchDispatch[] = [], leaseCalls: string[] = [], leaseRequests: Parameters<BrowserWatchBindings["configureLease"]>[0][] = [], definitions = browserWatchHarnessDefinitions();
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>, hosted: ReturnType<typeof createHostedChannels>, watches: ReturnType<typeof createBrowserWatches>;
  const journal: HarnessJournal = { read: () => host.read(thread), append: async events => { for (const event of events) await host.commitRoot(host.self(thread), event); } };
  const binding: HarnessLibraryBinding = { owner, thread, blobs: harnessBlobStore(sqliteWorkflowKV(db)), guard: () => {},
    verifiers: new Map(definitions.map(d => [d.verifier.digest, d.verifier])), context: async () => ({ placement: "local", runtimeDigest: harnessDigest(["watch-fixture-v1", runtime]), bindings: {} }),
    authorize: async () => authorized, execute: async (job, s) => {
      const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, s);
      return result.error ? { status: "failed", evidence: ["quickjs-error"] } : { status: "succeeded", output: result.result as any, evidence: ["real-quickjs"] };
    } };
  const library = new HarnessLibrary(binding, journal);
  const open = async () => {
    hosted = createHostedChannels(owner, () => host, { authorize: async () => false, authenticate: async () => undefined, artifactAllowed: async () => false,
      execute: async () => { throw Error("no-provider"); }, validateReceipt: async () => false }, {
      wiring: channelHarnessHandlers(binding, journal, async (o, a) => o === owner && a === "watch-grant" && authorized),
      logSources: { current: () => authorized, grants: () => watches?.sourceGrants() ?? [] },
      browserProducers: { current: () => authorized, grant: p => watches?.producerGrants().find(g => g.producer === p) },
    });
    watches = createBrowserWatches({ owner, journal: hosted.wiringJournal, library, wiring: hosted.wiring!, sources: hosted.logSources!, receivingAuthority: "watch-grant",
      current: () => authorized, authorize: options.authorize ?? (async () => authorized),
      configCurrent: options.configCurrent,
      prepareLease: async (c, identity) => ({ grant: { owner, ...identity, profile: "owned", generation: c.sourceGeneration, connectionId: c.connectionId,
        connectionRevision: c.connectionRevision, origins: [c.origin], kinds: [c.kind], active: true, expiresAt: c.expiresAt, secret: "fixture-producer-private-key-000000000" }, ingestUrl: `https://aiko.example/v1/browser-events/${owner}` }),
      configureLease: async lease => { leaseCalls.push(`configure:${lease.grant.producer}`); leaseRequests.push(structuredClone(lease));
        if (lease.leaseRevision && stallRenewal) await new Promise(() => {});
        if (lease.leaseRevision && renewalFailures-- > 0) throw Error("private-renewal-unavailable");
        const previous = privateLeases.get(lease.grant.producer), paused = previous?.state === "paused" && previous.lifecycleRevision === (lease.lifecycleRevision ?? 0);
        privateLeases.set(lease.grant.producer, { ...previous, producer: lease.grant.producer, generation: lease.grant.generation, lifecycleRevision: lease.lifecycleRevision ?? 0,
          leaseRevision: lease.leaseRevision ?? 0, expiresAt: lease.grant.expiresAt, state: paused ? "paused" : "watching" });
        if (lease.leaseRevision && loseRenewalAcknowledgement) { loseRenewalAcknowledgement = false; throw Error("private-renewal-acknowledgement-lost"); }
      },
      pauseLease: async (producer, _signal, lifecycleRevision) => { leaseCalls.push(`pause:${producer}`); if (pauseFailures-- > 0) throw Error("private-runner-unavailable");
        const lease = privateLeases.get(producer); if (lease && lease.lifecycleRevision !== lifecycleRevision) throw Error("private-lease-incarnation-mismatch");
        if (lease) { lease.state = "paused"; lease.pausedThrough = privateHeads.get(producer) ?? 0; } if (losePauseAcknowledgement) throw Error("pause-acknowledgement-lost"); },
      leaseStatus: async producer => { const status = privateLeases.get(producer); return status && { ...status, ...(wrongStatusGeneration ? { generation: status.generation + 1 } : {}), ...(foreignStatusProducer ? { producer: "foreign-private-producer" } : {}), ...(omitPausedThrough ? {pausedThrough:undefined} : {}), ...(staleLifecycle ? {lifecycleRevision:0} : {}) }; },
      acknowledgeGap: options.acknowledgeGap,
      execute: async (intent, s) => { calls.push(structuredClone(intent)); return options.execute ? options.execute(intent, s) : { status: "completed", result: { acknowledgement: "accepted" } }; },
      reconcile: options.reconcile,
    });
    const definition = actor({ name: "aiko", methods: { message: agentMessageMethod, channelWait: hostedChannelWaitMethod }, components: [hostedChannelDeadlines(owner), hosted.wiring!.component, hosted.logSources!.component, ...(consumerEnabled ? [watches.component] : [])] });
    host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "watch-test", ownsThread: t => t === thread,
      actorFor: () => definition, layersFor: () => Layer.empty,
      keyOf: e => browserWatchEventKey(e) ?? browserEventKey(e) ?? channelLogSourceEventKey(e) ?? channelWiringEventKey(e) ?? harnessLibraryEventKey(e) ?? hostedChannelDeadlineKey(e),
      canAppend: (_t, batch, read) => browserWatchAppendAllowed(batch, read) && browserEventAppendAllowed(batch, read) && channelLogSourceAppendAllowed(batch, read) && channelWiringAppendAllowed(batch, read) && harnessLibraryAppendAllowed(batch, read),
    });
    await watches.refresh();
  };
  await open();
  await host.commitRoot(host.self(thread), { type: "WatchFixtureStarted", id: "fixture", at: Date.now() });
  cleanups.push(async () => { await host.close(); db.close(); });
  const config: BrowserWatchConfig = { id: "new-request", label: "New requests", connectionId: "site", connectionRevision: "r1", sourceGeneration: 1, origin: "https://site.example", kind: "push", outcome: "received",
    action: { kind: "actor", instruction: "Summarize the new request" }, expiresAt: Date.now() + 600_000, backlog: 8, maxOccurrences: 256 };
  let sequence = 0;
  const push = async (cause?: string) => {
    const grant = watches.producerGrants()[0]!;
    const b: BrowserEventBatch = { schema: BROWSER_EVENT_SCHEMA, producer: grant.producer, epoch: grant.epoch, generation: grant.generation,
      items: [{ sequence: ++sequence, occurrence: `occurrence-${sequence}`, kind: "push", observedAt: Date.now(), sourceId: `cdp-${sequence}`, fields: { origin: config.origin, outcome: "received" }, payload: { body: "PRIVATE_PUSH_CONTENT_12345", requestId: sequence }, ...(cause ? { cause } : {}) }] };
    privateHeads.set(grant.producer, Math.max(privateHeads.get(grant.producer) ?? 0, sequence));
    await hosted.browserAdmission!(b, browserBatchSignature(b, grant.secret));
    return b;
  };
  return { config, calls, leaseCalls, leaseRequests, library, get watches() { return watches; }, push, drive: () => host.recover(), events: () => host.read(thread),
    restart: async () => { await host.close(); await open(); }, enableConsumer: async () => { consumerEnabled = true; await host.close(); await open(); }, drift: () => { runtime++; }, revoke: () => { authorized = false; }, restoreAuthority: () => { authorized = true; },
    failPauses: (count: number) => { pauseFailures = count; }, losePauseAcknowledgement: () => { losePauseAcknowledgement = true; }, wrongStatusGeneration: () => { wrongStatusGeneration = true; }, foreignStatusProducer: () => { foreignStatusProducer = true; },
    failRenewals: (count: number) => { renewalFailures = count; }, loseRenewalAcknowledgement: () => { loseRenewalAcknowledgement = true; },
    stallRenewal: () => { stallRenewal = true; }, get watchBlobs() { return hosted.wiringJournal.blobs!; },
    alarm: () => host.alarm(), nextAlarm: () => alarm,
    queueThrough: (through: number, producer?: string) => { privateHeads.set(producer ?? watches.producerGrants()[0]!.producer, through); },
    omitPausedThrough: () => { omitPausedThrough = true; }, staleLifecycle: () => { staleLifecycle = true; },
    nativeReceipt: (event: Event) => host.commitRoot(host.self(thread), event),
    append: (events: Event[]) => hosted.journal.append(events), admission: (b: BrowserEventBatch) => hosted.browserAdmission!(b, browserBatchSignature(b, watches.producerGrants()[0]!.secret)) };
}

test("renewal extends cumulative limits without replacing source history or action generation", async () => {
  const f = await fixture(); const config = { ...f.config, maxOccurrences: 1 };
  await f.watches.configure(config, 0, signal()); await f.push(); await f.drive();
  const original = await f.events(), grant = f.watches.producerGrants()[0]!;
  const args = { id: config.id, expectedGeneration: 1, expectedLeaseRevision: 0, expiresAt: config.expiresAt + 60_000, maxOccurrences: 3 };
  expect(await f.watches.renew(args, signal())).toMatchObject({ status: "confirmed", leaseRevision: 1 });
  expect(await f.watches.inspect(config.id)).toMatchObject([{ generation: 1, leaseRevision: 1, budget: { used: 1, limit: 3, remaining: 2 } }]);
  expect(f.watches.producerGrants()[0]).toMatchObject({ producer: grant.producer, epoch: grant.epoch, secret: grant.secret });
  await f.restart(); await f.watches.renew(args, signal()); await f.push(); await f.drive();
  const rows = await f.events();
  expect(f.calls).toHaveLength(2);
  expect(rows.filter(e => e.type === "AikoChannelLogSourceCut")).toEqual(original.filter(e => e.type === "AikoChannelLogSourceCut"));
  expect(rows.filter(e => e.type === "AikoChannelLogSourceExhausted")).toEqual(original.filter(e => e.type === "AikoChannelLogSourceExhausted"));
  expect(rows.filter(e => e.type === "AikoChannelLogSourceRenewed")).toHaveLength(1);
  expect(f.leaseRequests.filter(lease => lease.leaseRevision === 1)).toHaveLength(1);
  await expect(f.watches.renew({ ...args, maxOccurrences: 4 }, signal())).rejects.toThrow("watch_renewal_conflict");
  await expect(f.watches.renew({ ...args, expectedGeneration: 2 }, signal())).rejects.toThrow("watch_renewal_unavailable");
});

test("renewal recovers a lost private acknowledgement from a native deadline after restart", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal());
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    f.loseRenewalAcknowledgement();
    const args = { id: f.config.id, expectedGeneration: 1, expectedLeaseRevision: 0, expiresAt: f.config.expiresAt + 60_000, maxOccurrences: 300 };
    expect(await f.watches.renew(args, signal())).toMatchObject({ status: "pending", attempts: 1, nextAt: now + 1000 });
    expect(f.watches.producerGrants()[0]!.expiresAt).toBe(f.config.expiresAt);
    await f.drive(); await f.restart(); now += 1000; await f.alarm();
    expect(await f.watches.inspect(f.config.id)).toMatchObject([{ leaseRevision: 1, renewal: { status: "confirmed", attempts: 2 } }]);
    expect(f.leaseRequests.filter(lease => lease.leaseRevision === 1)).toHaveLength(1);
    expect((await f.events()).filter(e => e.type === "AikoChannelLogSourceRenewed")).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("renewal has a fixed retry budget and cannot confirm without an atomic source amendment", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); f.failRenewals(10);
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const args = { id: f.config.id, expectedGeneration: 1, expectedLeaseRevision: 0, expiresAt: f.config.expiresAt + 60_000, maxOccurrences: 300 };
    await f.watches.renew(args, signal()); await f.drive();
    const requested = (await f.events()).find(e => e.type === "AikoBrowserWatchLeaseRenewalRequested")!;
    await expect(f.append([{ type: "AikoBrowserWatchLeaseRenewalChecked", owner: "watch-owner", id: `${requested.id}:1`, at: now,
      requestId: requested.id, watchId: f.config.id, leaseRevision: 1, attempt: 1, deadlineAt: requested.deadlineAt, status: "confirmed" }])).rejects.toThrow();
    for (let attempt = 1; attempt < 4; attempt++) {
      const status = (await f.watches.inspect(f.config.id))[0] as any;
      expect(status.renewal.status).toBe("pending"); now = status.renewal.nextAt; await f.alarm();
    }
    expect(await f.watches.inspect(f.config.id)).toMatchObject([{ leaseRevision: 0, renewal: { status: "needs-attention", attempts: 4 } }]);
    now += 120_000; await f.restart(); await f.alarm(); await f.watches.renew(args, signal());
    expect(f.leaseRequests.filter(lease => lease.leaseRevision === 1)).toHaveLength(4);
    await expect(f.watches.renew({ ...args, expectedLeaseRevision: 1 }, signal())).rejects.toThrow("watch_renewal_revision_conflict");
    expect((await f.events()).filter(e => e.type === "AikoChannelLogSourceRenewed")).toHaveLength(0);
  } finally { clock.mockRestore(); }
});

test("renewal refuses a lifecycle change during private lease custody instead of retaining a stale request", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal());
  await f.watches.control(f.config.id, "paused", 0, signal());
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const original = f.watchBlobs.putPrivate;
  f.watchBlobs.putPrivate = async (owner, value) => {
    if ((value as any)?.leaseRevision === 1 && (value as any)?.renewalFrom) { entered(); await released; }
    return original(owner, value);
  };
  const request = f.watches.renew({ id: f.config.id, expectedGeneration: 1, expectedLeaseRevision: 0, expiresAt: f.config.expiresAt + 60_000, maxOccurrences: 300 }, signal());
  await held;
  try { await f.watches.control(f.config.id, "active", 1, signal()); } finally { release(); }
  await expect(request).rejects.toThrow("watch_renewal_revision_conflict");
  expect((await f.events()).filter(e => e.type === "AikoBrowserWatchLeaseRenewalRequested")).toHaveLength(0);
  expect(await f.watches.inspect(f.config.id)).toMatchObject([{ status: "watching", leaseRevision: 0 }]);
});

test("an unresponsive renewal releases the private mutation queue when its caller deadline expires", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); f.stallRenewal();
  const controller = new AbortController();
  const request = f.watches.renew({ id: f.config.id, expectedGeneration: 1, expectedLeaseRevision: 0, expiresAt: f.config.expiresAt + 60_000, maxOccurrences: 300 }, controller.signal);
  const bounded = request.then(value => ({ status: "returned", value }), () => ({ status: "aborted" }));
  const timeout = setTimeout(() => controller.abort(), 20);
  try {
    await bounded;
    expect(await f.watches.control(f.config.id, "paused", 0, signal())).toMatchObject({ status: "paused", release: { status: "confirmed" } });
    expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(1);
    expect(f.leaseRequests.filter(lease => lease.leaseRevision === 1)).toHaveLength(1);
    expect((await f.events()).filter(e => e.type === "AikoBrowserWatchLeaseRenewalChecked" && e.status === "confirmed")).toHaveLength(0);
  } finally { clearTimeout(timeout); }
}, 1000);

test("expired unconfirmed renewal can read its retained receipt before a fresh revision extends collection", async () => {
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const f = await fixture(), config = { ...f.config, expiresAt: now + 2000 };
    await f.watches.configure(config, 0, signal()); f.loseRenewalAcknowledgement();
    const args = { id: config.id, expectedGeneration: 1, expectedLeaseRevision: 0, expiresAt: now + 4000, maxOccurrences: 300 };
    expect(await f.watches.renew(args, signal())).toMatchObject({ status: "pending" });
    now += 65_000; await f.restart();
    expect(await f.watches.renew(args, signal())).toMatchObject({ status: "confirmed", leaseRevision: 1 });
    expect(f.watches.producerGrants()[0]!.active).toBe(false);
    expect(f.leaseRequests.filter(lease => lease.leaseRevision === 1)).toHaveLength(1);
    expect(await f.watches.renew({ ...args, expectedLeaseRevision: 1, expiresAt: now + 60_000 }, signal())).toMatchObject({ status: "confirmed", leaseRevision: 2 });
    await f.push(); await f.drive();
    expect(f.calls).toHaveLength(1);
    expect((await f.events()).filter(e => e.type === "AikoChannelLogSourceCut")).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("current deployment cuts retained producer and source grants across reconstruction", async () => {
  let configured = true;
  const f = await fixture({ configCurrent: () => configured });
  await f.watches.configure(f.config, 0, signal());
  const batch = await f.push(); await f.drive();
  expect(f.calls).toHaveLength(1);
  const intent = f.calls[0]!;
  expect(f.watches.dispatchCurrent(intent)).toBe(true);
  configured = false;
  expect(f.watches.producerGrants()[0]!.active).toBe(false);
  expect(f.watches.sourceGrants()[0]!.active).toBe(false);
  expect(f.watches.dispatchCurrent(intent)).toBe(false);
  await f.restart();
  expect(f.watches.producerGrants()[0]!.active).toBe(false);
  expect(f.watches.sourceGrants()[0]!.active).toBe(false);
  await expect(f.admission(batch)).rejects.toThrow();
  expect(await f.watches.inspect()).toMatchObject([{ status: "needs-attention", lastTaskStatus: "completed" }]);
  expect(f.calls).toHaveLength(1);
});

test("real native source → checked QuickJS mapping → keyed task, with replay and host restart", async () => {
  const f = await fixture();
  expect(await f.watches.configure(f.config, 0, signal())).toMatchObject({ generation: 1, status: "watching" });
  const batch = await f.push(); await f.drive();
  expect(f.calls).toHaveLength(1);
  const events = await f.events();
  expect(events.some(e => e.type === "AikoChannelLogSourceProgress" && e.disposition === "accepted")).toBe(true);
  expect(events.some(e => e.type === "AikoHarnessChecked" && (e.witness as any).status === "satisfied")).toBe(true);
  expect(events.filter(e => e.type === "AikoBrowserWatchSettled").map(e => e.status)).toEqual(["completed"]);
  expect(events.some(e => e.type === "AikoChannelWiringConsumed")).toBe(true);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_PUSH_CONTENT_12345");
  expect(JSON.stringify(events)).not.toContain("fixture-producer-private-key");
  expect(events.some(e => e.type === "MessageReceived" || e.type === "InferenceRequested")).toBe(false);
  await f.restart(); await f.admission(batch); await f.drive();
  expect(f.calls).toHaveLength(1);
  expect(await f.watches.inspect()).toMatchObject([{ status: "watching", lastTaskStatus: "completed" }]);
  expect(await f.watches.sample(f.config.id, signal())).toMatchObject({ status: "available", payload: { requestId: 1 } });
});

test("pause cut cancels undispatched work; resume accepts future events; source excludes self causes", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal());
  await f.push(); await f.watches.control(f.config.id, "paused", 0, signal());
  expect(f.watches.producerGrants()[0]!.active).toBe(false);
  await f.watches.control(f.config.id, "active", 1, signal()); await f.drive();
  expect(f.calls).toHaveLength(0);
  expect((await f.events()).some(e => e.type === "AikoChannelLogSourceProgress" && e.reason === "watch_pause_cut")).toBe(true);
  await f.push(`watch:${f.config.id}:descendant`); await f.drive(); expect(f.calls).toHaveLength(0);
  await f.push(); await f.drive(); expect(f.calls).toHaveLength(1);
  await expect(f.watches.control(f.config.id, "paused", 0, signal())).rejects.toThrow("watch_control_conflict");
  f.revoke(); await expect(f.watches.sample(f.config.id, signal())).rejects.toThrow("watch_authority_unavailable"); expect(f.calls).toHaveLength(1);
});

test("unknown external effects stay held across restart and reconcile without replay", async () => {
  let confirmed = false, reconciles = 0;
  const f = await fixture({ execute: async () => ({ status: "unknown" }), reconcile: async () => { reconciles++; return { status: confirmed ? "completed" : "unknown" }; } });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const operation = f.calls[0]!.operationId;
  await f.restart(); await f.drive(); expect(f.calls).toHaveLength(1); expect(reconciles).toBe(0);
  expect(await f.watches.reconcile(operation, "check-1", signal())).toMatchObject({ status: "unknown" });
  await f.watches.reconcile(operation, "check-1", signal()); expect(reconciles).toBe(1);
  confirmed = true;
  expect(await f.watches.reconcile(operation, "check-2", signal())).toMatchObject({ status: "completed" });
  expect(f.calls).toHaveLength(1);
});

test("collection lease expiry stops execution and resume while current authority can check existing receipts", async () => {
  let connectionCurrent = true, receipts = 0;
  const operations: string[] = [];
  const f = await fixture({
    authorize: async (_config, operation) => { operations.push(operation); return connectionCurrent; },
    execute: async () => ({ status: "unknown" }),
    reconcile: async (intent, s) => {
      // The default native harness adapter makes this same physical authority recheck.
      expect(await f.watches.authorizeAction(intent, "reconcile", s)).toBe(true);
      receipts++;
      return { status: "completed" };
    },
  });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const intent = f.calls[0]!;
  await f.watches.control(f.config.id, "paused", 0, signal());
  await f.restart();
  const clock = spyOn(Date, "now").mockReturnValue(f.config.expiresAt + 1);
  try {
    operations.length = 0;
    expect(f.watches.producerGrants()[0]!.active).toBe(false);
    expect(f.watches.dispatchCurrent(intent)).toBe(false);
    await expect(f.watches.authorizeAction(intent, "execute", signal())).rejects.toThrow("watch_authority_unavailable");
    await expect(f.watches.control(f.config.id, "active", 1, signal())).rejects.toThrow("watch_authority_unavailable");
    connectionCurrent = false;
    await expect(f.watches.reconcile(intent.operationId, "receipt-1", signal())).rejects.toThrow("watch_authority_unavailable");
    expect((await f.events()).filter(e => e.type === "AikoBrowserWatchReconcileRequested")).toHaveLength(0);
    connectionCurrent = true;
    f.revoke();
    await expect(f.watches.reconcile(intent.operationId, "receipt-1", signal())).rejects.toThrow("watch_reconcile_invalid");
    f.restoreAuthority();
    expect(await f.watches.authorizeAction({ ...intent, action: { kind: "actor", instruction: "Changed action" } }, "reconcile", signal())).toBe(false);
    expect(await f.watches.reconcile(intent.operationId, "receipt-1", signal())).toMatchObject({ status: "completed" });
    expect(operations.length).toBeGreaterThan(0);
    expect(operations.every(operation => operation === "reconcile")).toBe(true);
    expect(receipts).toBe(1); expect(f.calls).toHaveLength(1); expect(f.leaseRequests).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("pending actor receipts hold backlog across restart and settle only on a matching native response", async () => {
  const deadlineAt = Date.now() + 120_000;
  const pending = { status: "pending" as const, receipt: { kind: "actor" as const, id: "private-native-call" }, deadlineAt };
  let completed = false, checks = 0;
  const f = await fixture({ execute: async () => pending, reconcile: async () => { checks++; return completed ? { status: "completed" } : pending; } });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  expect(f.calls).toHaveLength(1);
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "pending", lastTaskDeadlineAt: deadlineAt }]);
  expect((await f.events()).some(e => e.type === "AikoChannelWiringConsumed")).toBe(false);
  expect((await f.events()).filter(e => e.type === "AikoBrowserWatchActionAccepted")).toHaveLength(1);
  expect(JSON.stringify((await f.events()).filter(e => e.type === "AikoBrowserWatchActionAccepted"))).not.toContain("private-native-call");
  const before = checks;
  await f.restart(); await f.drive(); expect(f.calls).toHaveLength(1); expect(checks).toBe(before);
  await f.nativeReceipt({ type: "ResponseReceived", id: "unrelated", call: "another-call", at: Date.now() }); await f.drive();
  await f.nativeReceipt({ type: "CallTimedOut", owner: "foreign-owner", id: pending.receipt.id, at: Date.now() }); await f.drive();
  expect(checks).toBe(before);
  completed = true;
  await f.nativeReceipt({ type: "ResponseReceived", id: "reply", call: pending.receipt.id, at: Date.now() }); await f.drive();
  expect(checks).toBe(before + 1); expect(f.calls).toHaveLength(1);
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "completed" }]);
  expect((await f.events()).filter(e => e.type === "AikoChannelWiringConsumed")).toHaveLength(1);
  await f.restart(); await f.drive(); expect(checks).toBe(before + 1);
});

test("pending action deadline uses the native host alarm, releases backlog as unknown and never resends", async () => {
  const deadlineAt = Date.now() + 120_000;
  const pending = { status: "pending" as const, receipt: { kind: "actor" as const, id: "deadline-native-call" }, deadlineAt };
  let checks = 0;
  const f = await fixture({ execute: async () => pending, reconcile: async () => { checks++; return pending; } });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  expect(f.nextAlarm()).toBe(deadlineAt);
  await f.restart();
  const before = checks, clock = spyOn(Date, "now").mockReturnValue(deadlineAt + 1);
  try { await f.alarm(); await f.drive(); } finally { clock.mockRestore(); }
  expect(checks).toBe(before + 1); expect(f.calls).toHaveLength(1);
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "unknown" }]);
  expect((await f.events()).filter(e => e.type === "AikoChannelWiringConsumed")).toHaveLength(1);
  await f.nativeReceipt({ type: "ResponseReceived", id: "late-reply", call: pending.receipt.id, at: Date.now() }); await f.drive();
  expect(checks).toBe(before + 1); expect(f.calls).toHaveLength(1);
});

test("restart after the pending deadline preserves a native terminal receipt that arrived before it", async () => {
  const deadlineAt = Date.now() + 120_000;
  const pending = { status: "pending" as const, receipt: { kind: "actor" as const, id: "completed-before-deadline" }, deadlineAt };
  let completed = false;
  const f = await fixture({ execute: async () => pending, reconcile: async () => completed ? { status: "completed" } : pending });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  await f.nativeReceipt({ type: "ResponseReceived", id: "retained-terminal-reply", call: pending.receipt.id, at: deadlineAt - 1 });
  completed = true;
  await f.restart();
  const clock = spyOn(Date, "now").mockReturnValue(deadlineAt + 1);
  try { await f.alarm(); await f.drive(); } finally { clock.mockRestore(); }
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "completed" }]);
  expect((await f.events()).filter(e => e.type === "AikoBrowserWatchSettled").map(e => e.status)).toEqual(["completed"]);
  expect(f.calls).toHaveLength(1);
});

test("explicit unknown receipt checks can become pending without reclaiming consumed backlog", async () => {
  const deadlineAt = Date.now() + 120_000;
  const pending = { status: "pending" as const, receipt: { kind: "channel" as const, id: "private-reconcile-output" }, deadlineAt };
  let completed = false, checks = 0;
  const f = await fixture({ execute: async () => ({ status: "unknown" }), reconcile: async intent => {
    expect(intent.reconciliationRequestId).toBe("check-pending"); checks++;
    return completed ? { status: "completed" } : pending;
  } });
  f.config.action = { kind: "webhook", destination: "owned-webhook" };
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const operationId = f.calls[0]!.operationId;
  expect(await f.watches.reconcile(operationId, "check-pending", signal())).toMatchObject({ status: "pending" });
  await f.drive();
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "pending" }]);
  expect((await f.events()).filter(e => e.type === "AikoChannelWiringConsumed")).toHaveLength(1);
  const before = checks;
  expect(await f.watches.reconcile(operationId, "other-check", signal())).toMatchObject({ status: "pending" });
  expect(checks).toBe(before);
  await f.restart(); await f.drive(); expect(checks).toBe(before);
  completed = true;
  await f.nativeReceipt({ type: "AikoChannelReconcileSettled", owner: "watch-owner", id: "reconcile-result", outputId: pending.receipt.id, at: Date.now(), result: { status: "delivered" } });
  await f.drive();
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "completed" }]);
  expect((await f.events()).filter(e => e.type === "AikoBrowserWatchReconcileRequested")).toHaveLength(1);
  expect((await f.events()).filter(e => e.type === "AikoChannelWiringConsumed")).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
});

test("crash after dispatch claim adopts the existing pending receipt and rejects malformed pending facts", async () => {
  const pending = { status: "pending" as const, receipt: { kind: "actor" as const, id: "already-started-call" }, deadlineAt: Date.now() + 120_000 };
  const f = await fixture({ deferConsumer: true, reconcile: async () => pending });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const events = await f.events(), source = events.find(e => e.type === "AikoChannelWiringAccepted" && e.invocation)!;
  const event = events.find(e => e.type === "AikoBrowserPushObserved")!;
  const operationId = `watch:${f.config.id}:1:${channelDigest(["watch-owner", event.id, f.config.action])}`;
  await f.append([{ type: "AikoBrowserWatchStarted", owner: "watch-owner", id: operationId, at: Date.now(), watchId: f.config.id, generation: 1, source: source.id, eventId: event.id }]);
  await f.enableConsumer(); await f.drive();
  expect(f.calls).toHaveLength(0);
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "pending" }]);
  const rows = await f.events(), accepted = rows.find(e => e.type === "AikoBrowserWatchActionAccepted")!;
  const before = rows.slice(0, rows.indexOf(accepted));
  expect(browserWatchAppendAllowed([{ ...accepted, generation: 2 }], () => before)).toBe(false);
  expect(browserWatchAppendAllowed([{ ...accepted, deadlineAt: Number(accepted.at) + 86400001 }], () => before)).toBe(false);
  expect(browserWatchAppendAllowed([{ ...accepted, jobRef: { ...(accepted.jobRef as object), owner: "foreign" } }], () => before)).toBe(false);
  expect(browserWatchAppendAllowed([{ ...accepted, requestId: "unrequested", id: `${operationId}:unrequested:accepted` }], () => before)).toBe(false);
  const receiptRevision = harnessDigest("invented-receipt-revision");
  expect(browserWatchAppendAllowed([{ type: "AikoBrowserWatchActionReceiptChecked", owner: "watch-owner", id: `${accepted.id}:${receiptRevision}`, acceptedId: accepted.id, operationId, receiptRevision, at: Date.now() }], () => rows)).toBe(false);
  await f.restart(); await f.drive(); expect(f.calls).toHaveLength(0);
});

test("a pending receipt cannot silently change jobs or extend its deadline", async () => {
  const deadlineAt = Date.now() + 120_000;
  const f = await fixture({ execute: async () => ({ status: "pending", receipt: { kind: "actor", id: "original-job" }, deadlineAt }),
    reconcile: async () => ({ status: "pending", receipt: { kind: "actor", id: "replacement-job" }, deadlineAt: deadlineAt + 1000 }) });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  expect(await f.watches.inspect()).toMatchObject([{ lastTaskStatus: "unknown" }]);
  expect((await f.events()).filter(e => e.type === "AikoBrowserWatchActionAccepted")).toHaveLength(1);
  expect((await f.events()).filter(e => e.type === "AikoChannelWiringConsumed")).toHaveLength(1);
  await f.restart(); await f.drive(); expect(f.calls).toHaveLength(1);
});

test("explicit upgrade keeps already accepted work on its old action and rejects stale edits", async () => {
  const f = await fixture({ deferConsumer: true }); await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const next = { ...f.config, action: { kind: "actor" as const, instruction: "Prepare the revised summary" } };
  await f.watches.configure(next, 1, signal());
  await f.enableConsumer();
  await f.push(); await f.drive();
  expect(f.calls.map(c => c.generation)).toEqual([1, 2]);
  expect(f.calls.map(c => c.action)).toEqual([f.config.action, next.action]);
  await expect(f.watches.configure(next, 1, signal())).rejects.toThrow("watch_generation_conflict");
  await expect(f.watches.configure({ ...next, origin: "https://other.example" }, 2, signal())).rejects.toThrow("watch_source_immutable");
});


test("crash after native dispatch claim reconciles existing operation and never executes it again", async () => {
  let receipts = 0;
  const f = await fixture({ deferConsumer: true, reconcile: async () => { receipts++; return { status: "unknown" }; } });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const events = await f.events(), source = events.find(e => e.type === "AikoChannelWiringAccepted" && e.invocation)!;
  const event = events.find(e => e.type === "AikoBrowserPushObserved")!;
  const operationId = `watch:${f.config.id}:1:${channelDigest(["watch-owner", event.id, f.config.action])}`;
  await f.append([{ type: "AikoBrowserWatchStarted", owner: "watch-owner", id: operationId, at: Date.now(), watchId: f.config.id, generation: 1, source: source.id, eventId: event.id }]);
  await f.enableConsumer(); await f.drive();
  expect(f.calls).toHaveLength(0); expect(receipts).toBe(1);
  expect((await f.events()).find(e => e.type === "AikoBrowserWatchSettled")?.status).toBe("unknown");
  await f.restart(); await f.drive(); expect(receipts).toBe(1);
});


test("erased checked output is unavailable, releases backlog and never fabricates an action", async () => {
  const f = await fixture({ deferConsumer: true });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const source = (await f.events()).find(e => e.type === "AikoChannelWiringAccepted" && e.invocation)!;
  await f.library.binding.blobs.erase!("watch-owner", (source.valueRef as any).ref, "erase-mapping-output");
  await f.enableConsumer(); await f.drive();
  expect(f.calls).toHaveLength(0);
  expect((await f.events()).find(e => e.type === "AikoBrowserWatchSettled")?.status).toBe("failed");
  expect((await f.events()).some(e => e.type === "AikoChannelWiringConsumed" && e.source === source.id)).toBe(true);
});

test("erasing private watch configuration invalidates cached authority and future dispatch", async () => {
  const f = await fixture({ deferConsumer: true });
  await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const prepared = (await f.events()).find(e => e.type === "AikoBrowserWatchPrepared")!;
  await f.library.binding.blobs.erase!("watch-owner", (prepared.configRef as any).ref, "erase-watch-configuration");
  await f.watches.refresh(); expect(f.watches.producerGrants()).toEqual([]);
  await f.enableConsumer(); await f.drive();
  expect(f.calls).toHaveLength(0);
  expect(await f.watches.inspect()).toMatchObject([{ status: "needs-attention", reason: "private_configuration_unavailable" }]);
});

test("a burst larger than both port backlogs drains every occurrence without extra model work", async () => {
  const f = await fixture({ deferConsumer: true }); await f.watches.configure({ ...f.config, backlog: 2 }, 0, signal());
  const baseline = (await f.events()).filter(e => e.type === "AikoHarnessRunStarted").length;
  for (let i = 0; i < 11; i++) await f.push();
  await f.drive();
  expect(f.calls).toHaveLength(0);
  await f.enableConsumer(); await f.drive();
  expect((await f.events()).filter(e => e.type === "AikoHarnessRunStarted")).toHaveLength(baseline + 11);
  expect(f.calls).toHaveLength(11);
  expect(new Set(f.calls.map(c => c.operationId)).size).toBe(11);
  const events = await f.events();
  expect(events.filter(e => e.type === "AikoBrowserWatchSettled" && e.status === "completed")).toHaveLength(11);
  expect(events.some(e => e.type === "MessageReceived" || e.type === "InferenceRequested")).toBe(false);
});


test("held checked output revalidates handler context before publication after restart", async () => {
  const f = await fixture({ deferConsumer: true }); await f.watches.configure({ ...f.config, backlog: 1 }, 0, signal());
  for (let i = 0; i < 3; i++) await f.push();
  await f.drive(); const runs = (await f.events()).filter(e => e.type === "AikoHarnessRunStarted").length;
  f.drift(); await f.enableConsumer(); await f.drive();
  expect(f.calls).toHaveLength(1);
  expect((await f.events()).filter(e => e.type === "AikoHarnessRunStarted")).toHaveLength(runs);
  expect((await f.events()).filter(e => e.type === "AikoChannelWiringSettled" && e.status === "rejected")).toHaveLength(2);
});


test("gap acknowledgement is fenced to retained watch and current loss count without resuming or replaying", async () => {
  const acknowledgements: [string,number,number][] = [];
  let missed=3;
  const f=await fixture({acknowledgeGap:async(producer,generation,count)=>{
    if(count!==missed)throw Error("browser_watch_gap_changed");
    acknowledgements.push([producer,generation,count]);
    return {state:"paused",coverageGap:{generation,missed,acknowledged:count}};
  }});
  await f.watches.configure(f.config,0,signal());await f.drive();
  await f.watches.control(f.config.id,"paused",0,signal());
  const grant=f.watches.producerGrants()[0]!;
  await expect(f.watches.acknowledgeGap(f.config.id,2,3,signal())).rejects.toThrow("watch_generation_conflict");
  missed=4;
  await expect(f.watches.acknowledgeGap(f.config.id,1,3,signal())).rejects.toThrow("browser_watch_gap_changed");
  expect(acknowledgements).toEqual([]);
  expect(await f.watches.acknowledgeGap(f.config.id,1,4,signal())).toMatchObject({state:"paused",coverageGap:{missed:4,acknowledged:4}});
  expect(acknowledgements).toEqual([[grant.producer,grant.generation,4]]);
  expect(f.watches.producerGrants()[0]!.active).toBe(false);
  expect(f.calls).toHaveLength(0);
  expect((await f.events()).filter(e=>e.type==="AikoBrowserWatchStarted")).toHaveLength(0);
});


test("explicit receipt checks retain their watch request identity and finite budget across restart", async () => {
  const checked: string[]=[];
  const f=await fixture({execute:async()=>({status:"unknown"}),reconcile:async intent=>{
    checked.push(intent.reconciliationRequestId!);return {status:"unknown"};
  }});
  await f.watches.configure(f.config,0,signal());await f.push();await f.drive();
  const operation=f.calls[0]!.operationId;
  for(let i=1;i<=7;i++)await f.watches.reconcile(operation,`check-${i}`,signal());
  await f.restart();await f.watches.reconcile(operation,"check-7",signal());
  await expect(f.watches.reconcile(operation,"check-8",signal())).rejects.toThrow("watch_reconcile_budget_exhausted");
  expect(checked).toEqual(Array.from({length:7},(_,i)=>`check-${i+1}`));
  const rows=await f.events(), started=rows.find(e=>e.type==="AikoBrowserWatchStarted")!;
  const requests=rows.filter(e=>e.type==="AikoBrowserWatchReconcileRequested");
  expect(requests).toHaveLength(7);
  expect(requests.every(e=>e.operationId===operation&&e.source===started.source&&e.watchId===f.config.id)).toBe(true);
  expect(browserWatchAppendAllowed([{...requests[0]!,id:`foreign:forged`,operationId:"foreign",requestId:"forged"}],()=>rows)).toBe(false);
  expect(f.calls).toHaveLength(1);
});

test("pause cut survives a crash before private revocation and native recovery releases without executing queued tasks", async () => {
  const f = await fixture({ deferConsumer: true }); await f.watches.configure(f.config, 0, signal());
  await f.push(); await f.drive();
  const producer = f.watches.producerGrants()[0]!, at = Date.now();
  await f.append([{ type: "AikoBrowserWatchControlled", owner: "watch-owner", id: `${f.config.id}:1`, at, watchId: f.config.id,
    status: "paused", controlRevision: 1, cut: 1, release: { producer: producer.producer, generation: producer.generation, deadlineAt: at + 60_000 } }]);
  await f.watches.refresh(); expect(f.watches.producerGrants()[0]!.active).toBe(false);
  expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(0);
  await f.enableConsumer(); await f.drive();
  expect(f.calls).toHaveLength(0);
  expect(await f.watches.inspect(f.config.id)).toMatchObject([{ status: "paused", release: { status: "confirmed", attempts: 1 } }]);
  expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(1);
  await f.restart(); await f.drive();
  expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(1);
});

test("failed private pause resumes from native alarm after restart, while resume stays fenced", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); f.failPauses(1);
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const paused = await f.watches.control(f.config.id, "paused", 0, signal());
    expect(paused).toMatchObject({ status: "paused", release: { status: "pending", attempts: 1, nextAt: now + 1000 } });
    await expect(f.watches.control(f.config.id, "active", 1, signal())).rejects.toThrow("watch_lease_release_unconfirmed");
    await f.drive();
    expect((await f.events()).some(e => e.type === "AikoHostedChannelDeadline" && Number((e.call as any).deadlineAt) === now + 1000)).toBe(true);
    await f.restart(); now += 1000; await f.alarm();
    expect(await f.watches.inspect(f.config.id)).toMatchObject([{ status: "paused", release: { status: "confirmed", attempts: 2 } }]);
    expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(2); expect(f.calls).toHaveLength(0);
    expect(await f.watches.control(f.config.id, "active", 1, signal())).toMatchObject({ status: "watching" });
    expect(f.leaseCalls.filter(call => call.startsWith("configure:"))).toHaveLength(2);
  } finally { clock.mockRestore(); }
});

test("lost pause acknowledgement is reconciled from exact private status; wrong generation exhausts a finite release budget", async () => {
  const acknowledged = await fixture(); await acknowledged.watches.configure(acknowledged.config, 0, signal()); acknowledged.losePauseAcknowledgement();
  expect(await acknowledged.watches.control(acknowledged.config.id, "paused", 0, signal())).toMatchObject({ release: { status: "confirmed", attempts: 1 } });
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); f.wrongStatusGeneration();
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    await f.watches.control(f.config.id, "deleted", 0, signal()); await f.drive();
    for (let attempt = 1; attempt < 4; attempt++) {
      const status = (await f.watches.inspect(f.config.id))[0] as any;
      expect(status.release.status).toBe("pending"); now = status.release.nextAt; await f.alarm();
    }
    expect(await f.watches.inspect(f.config.id)).toMatchObject([{ status: "deleted", release: { status: "needs-attention", attempts: 4 } }]);
    expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(4);
    now += 120_000; await f.restart(); await f.alarm();
    expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(4); expect(f.calls).toHaveLength(0);
  } finally { clock.mockRestore(); }
});

test("trusted disconnect atomically cuts matching watches after account revocation and releases their private leases", async () => {
  const f = await fixture({ deferConsumer: true }); await f.watches.configure(f.config, 0, signal());
  await f.watches.configure({ ...f.config, id: "same-connection" }, 0, signal());
  await f.watches.configure({ ...f.config, id: "other-connection", connectionId: "other" }, 0, signal());
  await f.push(); await f.drive(); f.revoke();
  expect(await f.watches.disconnect(f.config.connectionId, signal())).toMatchObject({ status: "paused", watches: [f.config.id, "same-connection"] });
  const controls = (await f.events()).filter(e => e.type === "AikoBrowserWatchControlled");
  expect(controls.map(e => e.watchId)).toEqual([f.config.id, "same-connection"]);
  expect(controls.every(e => e.reason === "connection-disconnected" && e.status === "paused")).toBe(true);
  expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(2);
  // Restoring account access cannot remove the retained disconnect cuts.
  f.restoreAuthority(); await f.enableConsumer(); await f.drive(); expect(f.calls).toHaveLength(0);
  await f.watches.disconnect(f.config.connectionId, signal());
  expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(2);
});

test("retained release scope survives configuration erasure, and elapsed release deadlines never launch another private call", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); f.failPauses(1);
  let now = Date.now(); const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    await f.watches.control(f.config.id, "paused", 0, signal()); await f.drive();
    const config = (await f.events()).find(e => e.type === "AikoBrowserWatchPrepared")!;
    await f.library.binding.blobs.erase!("watch-owner", (config.configRef as any).ref, "erase-after-pause-cut");
    await f.restart(); now += 1000; await f.alarm();
    expect(await f.watches.inspect(f.config.id)).toMatchObject([{ reason: "private_configuration_unavailable", release: { status: "confirmed", attempts: 2 } }]);
    expect(f.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(2);
  } finally { clock.mockRestore(); }
  const expired = await fixture(); await expired.watches.configure(expired.config, 0, signal()); expired.failPauses(4);
  now = Date.now(); const expiredClock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    await expired.watches.control(expired.config.id, "paused", 0, signal()); await expired.drive();
    now += 60_001; await expired.restart(); await expired.alarm();
    expect(await expired.watches.inspect(expired.config.id)).toMatchObject([{ release: { status: "needs-attention", attempts: 2, reason: "private_pause_deadline_elapsed" } }]);
    expect(expired.leaseCalls.filter(call => call.startsWith("pause:"))).toHaveLength(1);
  } finally { expiredClock.mockRestore(); }
});

test("watching health requires the exact private producer and source generation", async () => {
  const stale = await fixture(); await stale.watches.configure(stale.config, 0, signal()); stale.wrongStatusGeneration();
  expect(await stale.watches.inspect(stale.config.id)).toMatchObject([{ status: "needs-attention", collector: { state: "needs-attention", reason: "collector_scope_mismatch" } }]);
  const foreign = await fixture(); await foreign.watches.configure(foreign.config, 0, signal()); foreign.foreignStatusProducer();
  const health = await foreign.watches.inspect(foreign.config.id);
  expect(health).toMatchObject([{ status: "needs-attention", collector: { state: "needs-attention", reason: "collector_scope_mismatch" } }]);
  expect(JSON.stringify(health)).not.toContain("foreign-private-producer");
});

test("resume retains the private queue floor without changing producer counters, source pins or accepting paused backlog", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); await f.push(); await f.drive();
  const grant = f.watches.producerGrants()[0]!, sourceBefore = (await f.events()).find(e => e.type === "AikoChannelLogSourceCut")!;
  f.queueThrough(5); // Four accepted private observations have not reached the account yet.
  expect(await f.watches.control(f.config.id, "paused", 0, signal())).toMatchObject({ release: { status: "confirmed" } });
  await f.restart();
  await f.watches.control(f.config.id, "active", 1, signal());
  expect(f.leaseRequests.at(-1)).toMatchObject({ grant, lifecycleRevision: 2, resumeFrom: { lifecycleRevision: 0, pausedThrough: 5 } });
  expect(f.watches.sourceGrants()[0]!.browserSequenceCut).toEqual({ producer: grant.producer, epoch: grant.epoch, generation: grant.generation, through: 5 });
  for (let seq = 2; seq <= 5; seq++) { await f.push(); await f.drive(); }
  expect(f.calls).toHaveLength(1);
  expect((await f.events()).filter(e => e.type === "AikoChannelLogSourceProgress" && e.reason === "watch_pause_cut")).toHaveLength(4);
  await f.push(); await f.drive(); expect(f.calls).toHaveLength(2);
  expect(f.calls.at(-1)!.event.sequence).toBe(6);
  const sources = (await f.events()).filter(e => e.type === "AikoChannelLogSourceCut");
  expect(sources).toEqual([sourceBefore]);
  expect(f.watches.producerGrants()[0]).toEqual(grant);
  f.staleLifecycle(); expect(await f.watches.inspect(f.config.id)).toMatchObject([{ status: "needs-attention", collector: { reason: "collector_scope_mismatch" } }]);
});

test("sibling watches use their own producer scope instead of duplicating each other's observed copies", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal());
  await f.watches.configure({ ...f.config, id: "sibling" }, 0, signal());
  await f.push(); await f.drive(); expect(f.calls.map(call => call.watchId)).toEqual([f.config.id]);
  f.queueThrough(5); await f.watches.control(f.config.id, "paused", 0, signal()); await f.watches.control(f.config.id, "active", 1, signal());
  const sibling = f.watches.producerGrants().find(grant => grant.producer === "watch-sibling")!;
  const batch: BrowserEventBatch = { schema: BROWSER_EVENT_SCHEMA, producer: sibling.producer, epoch: sibling.epoch, generation: sibling.generation,
    items: [{ sequence: 1, occurrence: "sibling-occurrence", kind: "push", observedAt: Date.now(), sourceId: "sibling-cdp", fields: { origin: f.config.origin, outcome: "received" } }] };
  await f.admission(batch); await f.drive();
  expect(f.calls.map(call => call.watchId)).toEqual([f.config.id, "sibling"]);
  expect((await f.events()).filter(e => e.type === "AikoChannelLogSourceProgress" && e.reason === "watch_producer_scope")).toHaveLength(2);
});

test("unattested paused status cannot enable resume or forge a private queue floor", async () => {
  const legacy = await fixture(); await legacy.watches.configure(legacy.config, 0, signal()); legacy.omitPausedThrough();
  expect(await legacy.watches.control(legacy.config.id, "paused", 0, signal())).toMatchObject({ release: { status: "pending" } });
  await expect(legacy.watches.control(legacy.config.id, "active", 1, signal())).rejects.toThrow("watch_lease_release_unconfirmed");
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); f.queueThrough(7);
  await f.watches.control(f.config.id, "paused", 0, signal());
  const grant = f.watches.producerGrants()[0]!;
  await expect(f.append([{ type: "AikoBrowserWatchControlled", owner: "watch-owner", id: `${f.config.id}:2`, watchId: f.config.id, at: Date.now(), status: "active", controlRevision: 2, cut: 0,
    resumeFrom: { lifecycleRevision: 0, pausedThrough: 6 }, sequenceCut: { producer: grant.producer, epoch: grant.epoch, generation: grant.generation, through: 7 } }])).rejects.toThrow();
  await f.watches.control(f.config.id, "active", 1, signal());
  const configured = f.leaseRequests.length;
  expect(await f.watches.control(f.config.id, "active", 2, signal())).toMatchObject({ status: "watching", controlRevision: 2 });
  expect(f.leaseRequests).toHaveLength(configured);
});

test("retained source cuts suppress admission even while the in-memory grant projection is stale", async () => {
  const f = await fixture(); await f.watches.configure(f.config, 0, signal()); await f.push();
  const grant = f.watches.producerGrants()[0]!;
  await f.append([{ type: "AikoBrowserWatchControlled", owner: "watch-owner", id: `${f.config.id}:1`, at: Date.now(), watchId: f.config.id,
    status: "paused", controlRevision: 1, cut: 1, sequenceCut: { producer: grant.producer, epoch: grant.epoch, generation: grant.generation, through: 1 } }]);
  // Deliberately retain the old synchronous grant projection at the host seam.
  expect(f.watches.sourceGrants()[0]!.active).toBe(true);
  await f.drive(); expect(f.calls).toHaveLength(0);
  expect((await f.events()).some(e => e.type === "AikoChannelLogSourceProgress" && e.reason === "watch_paused")).toBe(true);
});
