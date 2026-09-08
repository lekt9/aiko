import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Layer } from "effect";
import { actor, agentMessageMethod } from "tardie";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { createHostedChannels, type ChannelHost } from "../src/channel-host.ts";
import { harnessBlobStore, harnessDigest } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import {
  BROWSER_EVENT_SCHEMA, browserBatchSignature, browserEventAppendAllowed, browserEventKey,
  type BrowserEventBatch, type BrowserProducerGrant,
} from "../src/browser-events.ts";

const close: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of close.splice(0)) await fn(); });
async function fixture() {
  const db = new Database(":memory:"), owner = "restore-owner", thread = `user-${owner}`;
  const storage: AccountStorage = { sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => null,
    setAlarm: async () => {}, deleteAlarm: async () => {} };
  let grant: BrowserProducerGrant = { owner, producer: "producer", epoch: "source-epoch", profile: "profile", generation: 1,
    connectionId: "connection", connectionRevision: "revision", origins: ["https://site.example"], kinds: ["push"],
    active: true, registeredAt: Date.now() - 1_000, expiresAt: Date.now() + 600_000, secret: "fixture-only-restore-key-0000000000000" };
  let channels!: ReturnType<typeof createHostedChannels>, native!: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  let beforeAppend: (() => Promise<void>) | undefined, guarded = true, seedCalls = 0, appendCalls = 0;
  const facade: ChannelHost = {
    self: t => native.self(t), read: t => native.read(t), commitRoot: (a, e) => native.commitRoot(a, e),
    seed: async (t, e) => { seedCalls++; await native.seed(t, e); },
    get appendControl() { return guarded ? async (t: string, events: readonly Event[]) => {
      appendCalls++; const hook = beforeAppend; beforeAppend = undefined; await hook?.();
      return native.appendControl(t, events);
    } : undefined; },
  };
  const open = async () => {
    channels = createHostedChannels(owner, () => facade, undefined, {
      custody: harnessBlobStore(sqliteWorkflowKV(db)), browserProducers: { current: () => true, grant: p => p === grant.producer ? grant : undefined },
    });
    const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [] });
    native = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "restore-admission", ownsThread: t => t === thread,
      actorFor: () => definition, layersFor: () => Layer.empty,
      keyOf: e => browserEventKey(e) ?? (e.type === "AikoBrowserWatchRestorePermitted" ? `fixture-permit:${e.id}` : undefined),
      canAppend: (_t, events, read) => browserEventAppendAllowed(events, read) && channels.dispatchAdmissionAllowed(events, read),
    });
  };
  await open();
  close.push(async () => { await native.close(); db.close(); });
  const batch = (sequence: number, deliveryEpoch?: string): BrowserEventBatch => ({ schema: BROWSER_EVENT_SCHEMA,
    producer: grant.producer, epoch: grant.epoch, generation: grant.generation, ...(deliveryEpoch ? { deliveryEpoch } : {}),
    items: [{ sequence, occurrence: `occurrence-${sequence}`, kind: "push", observedAt: grant.registeredAt + 1,
      sourceId: `source-${sequence}`, fields: { origin: grant.origins[0]!, outcome: "received" }, payload: { private: sequence } }],
  });
  // This fixture isolates ingress against retained native history. Restore permit
  // authorization itself is covered by the native watch reauthorization suite.
  const rotate = async (epoch: string, ownerOverride = owner, project = true) => {
    await native.seed(thread, [{ type: "AikoBrowserWatchRestorePermitted", id: epoch, owner: ownerOverride,
      producer: grant.producer, epoch: grant.epoch, sourceGeneration: grant.generation, deliveryEpoch: epoch, at: Date.now() }]);
    if (ownerOverride === owner && project) grant = { ...grant, deliveryEpoch: epoch };
  };
  return { batch, rotate, read: () => native.read(thread), send: (b: BrowserEventBatch, signature = browserBatchSignature(b, grant.secret)) => channels.browserAdmission!(b, signature),
    before: (fn: () => Promise<void>) => { beforeAppend = fn; }, revoke: () => { grant = { ...grant, active: false }; },
    omitGuard: () => { guarded = false; }, counts: () => ({ seedCalls, appendCalls }),
    restart: async () => { await native.close(); await open(); } };
}

test("actual native append rejects an old in-flight envelope after epoch rotation without acknowledging its sequence", async () => {
  const f = await fixture(), old = f.batch(1);
  f.before(() => f.rotate("restored-1"));
  await expect(f.send(old)).rejects.toThrow("browser_admission_unavailable");
  expect((await f.read()).filter(browserEventKey)).toHaveLength(0);
  expect(f.counts()).toEqual({ seedCalls: 0, appendCalls: 1 });
  const fresh = f.batch(1, "restored-1");
  expect(await f.send(fresh)).toMatchObject({ status: "accepted", through: 1, accepted: 1 });
  await f.restart();
  await expect(f.send(old)).rejects.toThrow("browser_producer_unavailable");
  expect(await f.send(fresh)).toMatchObject({ status: "duplicate", through: 1 });
  expect((await f.read()).filter(browserEventKey)).toHaveLength(1);
});

test("new transport epochs preserve historical occurrence receipts and contiguous source sequence", async () => {
  const f = await fixture(); await f.send(f.batch(1));
  const original = (await f.read()).find(browserEventKey)!;
  await f.rotate("restored-1");
  expect(await f.send(f.batch(1, "restored-1"))).toMatchObject({ status: "duplicate", through: 1 });
  expect(harnessDigest((await f.read()).find(browserEventKey)!)).toBe(harnessDigest(original));
  expect(await f.send(f.batch(2, "restored-1"))).toMatchObject({ accepted: 1, through: 2 });
  await f.rotate("restored-2");
  await expect(f.send(f.batch(3, "restored-1"))).rejects.toThrow("unavailable");
  expect(await f.send(f.batch(3, "restored-2"))).toMatchObject({ accepted: 1, through: 3 });
  const observed = (await f.read()).filter(browserEventKey);
  expect(observed.map(e => e.sequence)).toEqual([1, 2, 3]);
  expect(observed.map(e => e.deliveryEpoch)).toEqual([undefined, "restored-1", "restored-2"]);
  expect(new Set(observed.map(e => e.epoch))).toEqual(new Set(["source-epoch"]));
});

test("the actual commit also checks fresh producer authority, and a history seed cannot substitute for the guard", async () => {
  const f = await fixture();
  f.before(async () => f.revoke());
  await expect(f.send(f.batch(1))).rejects.toThrow("browser_admission_unavailable");
  expect((await f.read()).filter(browserEventKey)).toHaveLength(0);
  const missing = await fixture(); missing.omitGuard();
  await expect(missing.send(missing.batch(1))).rejects.toThrow("browser_guarded_commit_required");
  expect(missing.counts()).toEqual({ seedCalls: 0, appendCalls: 0 });
});

test("a delivery epoch is signed and owner scoped; malformed or relabeled envelopes cannot grant authority", async () => {
  const f = await fixture(), old = f.batch(1);
  const signature = browserBatchSignature(old, "fixture-only-restore-key-0000000000000");
  await f.rotate("foreign-restore", "foreign-owner");
  expect(await f.send(old)).toMatchObject({ accepted: 1 });
  await f.rotate("owned-restore");
  await expect(f.send({ ...f.batch(2), deliveryEpoch: "owned-restore" }, signature)).rejects.toThrow("denied");
  for (const value of ["", "x".repeat(161), "bad epoch", null, 1])
    await expect(f.send({ ...f.batch(2), deliveryEpoch: value } as BrowserEventBatch)).rejects.toThrow("browser_batch_invalid");
  expect((await f.read()).filter(browserEventKey)).toHaveLength(1);
});

// Native rows must win even if an async grant projection has not refreshed yet.
test("retained native restore fence rejects stale projection during the actual append", async () => {
  const f = await fixture();
  f.before(() => f.rotate("new-native-epoch", "restore-owner", false));
  await expect(f.send(f.batch(1))).rejects.toThrow("browser_admission_unavailable");
  expect((await f.read()).filter(browserEventKey)).toHaveLength(0);
});
