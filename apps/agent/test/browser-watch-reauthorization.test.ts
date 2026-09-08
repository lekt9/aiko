import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { actor } from "tardie";
import { Layer } from "effect";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { createBrowserWatchReauthorization, browserWatchRestoreAppendAllowed, browserWatchRestoreHeld, browserWatchRestorePrefix, type BrowserWatchRestorePermit } from "../src/browser-watch-reauthorization.ts";
import { browserWatchEventKey, browserWatchNextWake, type BrowserWatchConfig, type BrowserWatchLease } from "../src/browser-watches.ts";
import { browserEventKey, BROWSER_EVENT_SCHEMA } from "../src/browser-events.ts";
import { browserWatchRestorePrefixDigest } from "../src/browser-watch-restore.ts";
import { harnessDigest } from "../src/harness-library.ts";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** Real native SQLite commit and restart; only private restore confirmation is
 * simulated. Full browser/transport joins live in the assembly tests. */
async function fixture() {
  const owner = "restore-owner", thread = `user-${owner}`, now = Date.now(), challenge = crypto.randomUUID();
  let db = new Database(":memory:"), alarm: number | null = null, active = true, paused = false, lifecycle = 0;
  let permitCommitHook: (() => void) | undefined, proofHook: (() => Promise<void>) | undefined;
  let losePermit = false, loseClear = false, calls = 0, spoofAck = false;
  const occurrences = [harnessDigest("one").slice(7), harnessDigest("two").slice(7)];
  const config: BrowserWatchConfig = { id: "fixture", label: "Fixture", connectionId: "site", connectionRevision: "1", sourceGeneration: 1,
    origin: "https://site.example", kind: "push", outcome: "received", action: { kind: "actor", instruction: "Review" }, expiresAt: now + 3_600_000, backlog: 8, maxOccurrences: 256 };
  const lease: BrowserWatchLease = { grant: { owner, producer: "producer", epoch: "epoch", profile: "profile", generation: 1, connectionId: "site", connectionRevision: "1",
    origins: [config.origin], kinds: ["push"], active: true, expiresAt: config.expiresAt, registeredAt: now - 1000, secret: "private-fixture-secret-01234567890123456789" }, ingestUrl: `https://aiko.example/v1/browser-events/${owner}` };
  const proof: any = { owner, producer: "producer", profile: "profile", epoch: "epoch", generation: 1, connectionId: "site", connectionRevision: "1",
    lifecycleRevision: 0, leaseRevision: 0, expiresAt: config.expiresAt, challenge, at: now, queue: { head: 2, acknowledged: 0, offered: 2 } };
  let status: any = { producer: "producer", generation: 1, lifecycleRevision: 0, leaseRevision: 0, expiresAt: config.expiresAt, state: "needs-attention",
    reason: "restore-authorization-required", restore: { challenge, at: now, queue: { ...proof.queue } } };
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>, engine!: ReturnType<typeof createBrowserWatchReauthorization>;
  const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as any[]); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
    setAlarm: async value => { alarm = value; }, deleteAlarm: async () => { alarm = null; } };
  const read = () => host.read(thread);
  let tail = Promise.resolve();
  const journal = { read, transact: <T>(fn: (events: readonly Event[]) => { events: Event[]; result: T }) => {
    const work = tail.then(async () => {
      const result = fn(await read());
      if (result.events.length) await host.appendControl(thread, result.events, { wake: true });
      if (losePermit && result.events.some(e => e.type === "AikoBrowserWatchRestorePermitted")) { losePermit = false; throw Error("lost_native_ack"); }
      return result.result;
    }); tail = work.then(() => undefined, () => undefined); return work;
  } };
  const make = () => engine = createBrowserWatchReauthorization({ owner, journal, refresh: async () => {},
    scope: () => ({ config, lease, generation: 1, lifecycleRevision: lifecycle, active: !paused }),
    current: () => active, authorize: async (_config, signal) => { signal.throwIfAborted(); if (!active) throw Error("revoked"); },
    mutate: async (_producer, task) => task(),
    status: async () => structuredClone(status),
    restoreProof: async (_producer, _challenge, hostThrough) => {
      await proofHook?.();
      return { ...structuredClone(proof), hostThrough, prefixDigest: proof.prefixDigest ?? browserWatchRestorePrefixDigest({ owner, producer: "producer", epoch: "epoch", generation: 1 }, occurrences.slice(0, hostThrough).map((id, i) => [i + 1, id])) };
    },
    reauthorizeLease: async (permit: BrowserWatchRestorePermit) => {
      calls++; status = { ...status, deliveryEpoch: permit.deliveryEpoch, acknowledged: spoofAck ? 0 : permit.hostThrough, state: "watching", reason: "collecting" }; delete status.restore;
      if (loseClear) { loseClear = false; throw Error("lost_private_ack"); }
      return structuredClone(status);
    },
  });
  const definition = actor({ name: "aiko", methods: {}, components: [] });
  const open = async () => { host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "fixture", ownsThread: t => t === thread,
    actorFor: () => definition, layersFor: () => Layer.empty, keyOf: e => browserWatchEventKey(e) ?? browserEventKey(e),
    canAppend: (_thread, events, prior) => {
      if (events.some(e => e.type === "AikoBrowserWatchRestorePermitted")) { permitCommitHook?.(); permitCommitHook = undefined; }
      return engine.admissionAllowed(events, prior);
    } }); make(); };
  await open();
  await host.commitRoot(host.self(thread), { type: "FixtureStarted", id: "root", at: now });
  await host.seed(thread, [{ type: "AikoBrowserWatchPrepared", owner, id: "fixture:1", watchId: "fixture", generation: 1, at: now },
    { type: "AikoBrowserWatchActivated", owner, id: "fixture:1", watchId: "fixture", generation: 1, at: now },
    { type: "AikoBrowserPushObserved", schema: BROWSER_EVENT_SCHEMA, owner, producer: "producer", epoch: "epoch", generation: 1, sequence: 1,
      id: "producer:epoch:1:1", occurrence: occurrences[0], at: now }]);
  cleanup.push(async () => { await host.close(); db.close(); });
  const input = { id: "fixture", expectedGeneration: 1, expectedLifecycleRevision: 0, expectedLeaseRevision: 0, challenge };
  return { owner, config, lease, proof, input, read, get engine() { return engine; }, get calls() { return calls; },
    run: (signal = AbortSignal.timeout(5000)) => engine.reauthorize(input, signal),
    revokeAtCommit: () => { permitCommitHook = () => { active = false; }; },
    pauseAtProof: () => { proofHook = async () => { paused = true; }; },
    mutateProof: (value: object) => Object.assign(proof, value),
    losePermit: () => { losePermit = true; }, loseClear: () => { loseClear = true; },
    wrongAck: () => { spoofAck = true; },
    holdProof: (fn: () => Promise<void>) => { proofHook = fn; },
    restart: async () => { await host.close(); const bytes = db.serialize(); db.close(); db = Database.deserialize(bytes); await open(); },
    appendEvent: async (sequence: number) => host.seed(thread, [{ type: "AikoBrowserPushObserved", schema: BROWSER_EVENT_SCHEMA, owner,
      producer: "producer", epoch: "epoch", generation: 1, sequence, id: `producer:epoch:1:${sequence}`, occurrence: occurrences[sequence - 1], at: now }]),
  };
}

test("native restore permit proves contiguous identity and survives SQLite reopen without replay or another epoch", async () => {
  const f = await fixture();
  expect(await f.run()).toMatchObject({ status: "confirmed", attempts: 1 }); expect(f.calls).toBe(1);
  const rows = await f.read(), permit = rows.find(e => e.type === "AikoBrowserWatchRestorePermitted")!;
  expect(permit).toMatchObject({ hostThrough: 1, queueHead: 2, queueAcknowledged: 0, previousDeliveryEpoch: null });
  expect(permit.prefixDigest).toBe(browserWatchRestorePrefix(rows, { owner: f.owner, producer: "producer", epoch: "epoch", sourceGeneration: 1 }).prefixDigest);
  expect(JSON.stringify(rows)).not.toContain(f.lease.grant.secret);
  await f.restart(); expect(await f.run()).toMatchObject({ status: "confirmed" }); expect(f.calls).toBe(1);
  expect((await f.read()).filter(e => e.type === permit.type)).toHaveLength(1);
});
for (const invalid of ["rollback", "ack-ahead", "wrong-occurrence", "missing-queue"] as const) test(`restore remains held for ${invalid} private proof`, async () => {
  const f = await fixture();
  if (invalid === "rollback") f.mutateProof({ queue: { head: 0, acknowledged: 0, offered: 0 } });
  if (invalid === "ack-ahead") f.mutateProof({ queue: { head: 2, acknowledged: 2, offered: 2 } });
  if (invalid === "wrong-occurrence") f.mutateProof({ prefixDigest: "0".repeat(64) });
  if (invalid === "missing-queue") f.mutateProof({ queue: undefined });
  expect(await f.run()).toMatchObject({ status: "pending", attempts: 1 }); expect(f.calls).toBe(0);
  const rows = await f.read(); expect(browserWatchRestoreHeld(rows, f.owner, "fixture")).toBe(true);
  expect(rows.some(e => e.type === "AikoBrowserWatchRestorePermitted")).toBe(false);
  expect(browserWatchNextWake(rows, f.owner)).toBeGreaterThan(Date.now());
});
test("actual commit revocation and a lifecycle pause during proof prevent private release", async () => {
  for (const cut of ["commit", "pause"] as const) {
    const f = await fixture(); if (cut === "commit") f.revokeAtCommit(); else f.pauseAtProof();
    await expect(f.run()).rejects.toThrow(); expect(f.calls).toBe(0);
    expect((await f.read()).some(e => e.type === "AikoBrowserWatchRestorePermitted")).toBe(false);
  }
});
test("lost permit and private acknowledgements reuse the exact retained epoch after restart", async () => {
  for (const boundary of ["permit", "private"] as const) {
    const f = await fixture(); if (boundary === "permit") f.losePermit(); else f.loseClear();
    expect(await f.run()).toMatchObject({ status: "pending" });
    const permit = (await f.read()).find(e => e.type === "AikoBrowserWatchRestorePermitted")!; expect(permit).toBeDefined();
    await f.restart(); expect(await f.run()).toMatchObject({ status: "confirmed" });
    expect((await f.read()).filter(e => e.type === permit.type)).toEqual([permit]); expect(f.calls).toBe(1);
  }
});
test("a changed native prefix after proof cannot commit its stale permission", async () => {
  const f = await fixture(); f.holdProof(async () => { await f.appendEvent(2); });
  expect(await f.run()).toMatchObject({ status: "pending" }); expect(f.calls).toBe(0);
  expect((await f.read()).some(e => e.type === "AikoBrowserWatchRestorePermitted")).toBe(false);
});
test("retries are finite and status without matching acknowledged prefix cannot confirm", async () => {
  const f = await fixture(); f.mutateProof({ prefixDigest: "0".repeat(64) });
  for (let i = 0; i < 5; i++) await f.run();
  const rows = await f.read(); expect(rows.filter(e => e.type === "AikoBrowserWatchRestoreChecked")).toHaveLength(4);
  expect(browserWatchNextWake(rows, f.owner)).toBeUndefined(); expect(f.calls).toBe(0);
  const other = await fixture(); other.wrongAck(); expect(await other.run()).toMatchObject({ status: "pending" });
  expect((await other.read()).some(e => e.type === "AikoBrowserWatchRestoreChecked" && e.status === "confirmed")).toBe(false);
});
test("restore structural guard rejects unbound secret fields and noncontiguous native history", async () => {
  const f = await fixture(); await f.run(); const rows = await f.read(), permit = rows.find(e => e.type === "AikoBrowserWatchRestorePermitted")!;
  const before = rows.slice(0, rows.indexOf(permit));
  expect(browserWatchRestoreAppendAllowed([{ ...permit, secret: "not-a-permit-field" }], () => before)).toBe(false);
  expect(browserWatchRestoreAppendAllowed([permit], () => before.filter(e => !browserEventKey(e)))).toBe(false);
  expect(() => browserWatchRestorePrefix([...before, { ...before.find(e => browserEventKey(e))!, id: "gap", sequence: 3 }],
    { owner: f.owner, producer: "producer", epoch: "epoch", sourceGeneration: 1 })).toThrow();
});
