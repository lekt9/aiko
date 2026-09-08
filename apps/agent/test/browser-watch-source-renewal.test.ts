import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { Effect, Layer } from "effect";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { createChannelLogSources, channelLogSourceAppendAllowed, channelLogSourceEventKey, channelLogSourceLease, channelLogSourceSchema, type ChannelLogSourceGrant } from "../src/channel-log-source.ts";
import { createChannelWiring, channelWiringAppendAllowed, channelWiringEventKey, type ChannelWiringBindings, type WiringJournal } from "../src/channel-wiring.ts";
import { CHANNEL_PROVENANCE, channelDigest } from "../src/channel-bindings.ts";
import { BROWSER_EVENT_SCHEMA, browserEventAppendAllowed, browserEventKey } from "../src/browser-events.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const owner = "renewal-owner", thread = `user-${owner}`, watchId = "watch", sourceAuthority = `watch-source:${watchId}`;
const schema = channelLogSourceSchema("browser-push");

/** The private confirmation is deliberately a trusted fixture fact here. The
 * real native watch/private transport join has separate integration coverage. */
async function fixture() {
  const directory = await mkdtemp("/tmp/watch-source-renewal-");
  let db = new Database(join(directory, "host.sqlite")), alarm: number | null = null;
  let current = true, receiving = true, lostAcknowledgement = false, revokeAtCommit = false;
  const grant: ChannelLogSourceGrant = { owner, id: sourceAuthority, kind: "browser-push", active: true, receivingAuthority: "fixture-receiving",
    expiresAt: Date.now() + 600000, maxBindings: 1, browserOperationId: "source" };
  const executed: number[] = [];
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  let channels!: { wiring: ReturnType<typeof createChannelWiring>; logSources: ReturnType<typeof createChannelLogSources> };
  const open = async () => {
    const storage: AccountStorage = { sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
      transactionSync: run => db.transaction(run)(), sync: async () => {}, getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
    const bindings: ChannelWiringBindings = { blobs: harnessBlobStore(sqliteWorkflowKV(db)), authorize: async (account, authority) => current && receiving && account === owner && authority === "fixture-receiving",
      resolve: async () => ({ eligible: true, accepts: schema, emits: "fixture.result", effects: ["pure", "channel.reply"], inputSchema: { type: "object" }, outputSchema: { type: "object" } }),
      execute: async (_pin, input, key) => { executed.push((input as any).value.sequence); return { status: "satisfied", output: { sequence: (input as any).value.sequence }, evidence: `fixture:${key}` }; },
      reconcile: async () => ({ status: "pending", evidence: "fixture-no-replay" }),
    };
    let serial = Promise.resolve();
    const journal: WiringJournal = { blobs: bindings.blobs, read: () => host.read(thread),
      transact: (fn, validate) => {
        const work = serial.then(async () => {
          if (revokeAtCommit) { current = false; revokeAtCommit = false; }
          const next = fn(await host.read(thread)); await validate?.();
          await host.seed(thread, next.events); return next.result;
        });
        serial = work.then(() => undefined, () => undefined); return work;
      },
    };
    const wiring = createChannelWiring(owner, journal, bindings);
    channels = { wiring, logSources: createChannelLogSources(owner, journal, wiring, { current: () => current, grants: () => [grant] }, t => host.read(t)) };
    const definition = actor({ name: "aiko", methods: {}, components: [channels.wiring!.component, channels.logSources!.component] });
    host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "source-renewal", ownsThread: t => t === thread,
      actorFor: () => definition, layersFor: () => Layer.empty,
      keyOf: e => channelLogSourceEventKey(e) ?? channelWiringEventKey(e) ?? browserEventKey(e),
      canAppend: (_t, batch, read) => channelLogSourceAppendAllowed(batch, read) && channelWiringAppendAllowed(batch, read) && browserEventAppendAllowed(batch, read),
    });
  };
  await open();
  cleanup.push(async () => { await host.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const run = <T>(work: Effect.Effect<T, any, any>) => Effect.runPromise(work.pipe(Effect.provideService(Self, { actor: "aiko", instance: "source-renewal", thread })) as Effect.Effect<T, any>);
  const emit = async (sequence: number) => host.commitRoot(host.self(thread), { type: "AikoBrowserPushObserved", schema: BROWSER_EVENT_SCHEMA,
    owner, id: `push:${sequence}`, producer: "fixture-producer", epoch: "fixture-epoch", generation: 1, sequence, occurrence: `push:${sequence}`,
    kind: "push", connectionId: "fixture-connection", connectionRevision: "1", observedAt: Date.now(), fields: { origin: "https://example.com", outcome: "received" }, at: Date.now() });
  // History before the source was registered must never become new work.
  await emit(1);
  const inlet = await run(channels.wiring!.api.bind({ name: "in", schema, directions: ["inbox", "outbox"], authorityRef: "fixture-receiving", operationId: "in", backlog: 8 })) as any;
  const outlet = await run(channels.wiring!.api.bind({ name: "out", schema: "fixture.result", directions: ["inbox", "outbox"], authorityRef: "fixture-receiving", operationId: "out" })) as any;
  await run(channels.wiring!.api.connect({ name: "handler", generation: 1, input: { channel: inlet.channel, generation: inlet.generation }, accepts: schema,
    handler: { harness: "a".repeat(64), contract: "b".repeat(64) }, output: { channel: outlet.channel, generation: outlet.generation, mode: "port" },
    authorityRef: "fixture-receiving", start: "after-registration", operationId: "connect" }));
  const registered = await run(channels.logSources!.api.register({ operationId: "source", source: "browser-push", sourceAuthority, receivingAuthority: "fixture-receiving",
    port: { channel: inlet.channel, generation: inlet.generation }, expiresAt: grant.expiresAt, maxOccurrences: 2 })) as any;
  const id = registered.id as string;
  const prepare = async (revision = 1, ceiling = 4, extraExpiry = revision * 1000, confirmed = true) => {
    const args = { id, leaseRevision: revision, expiresAt: registered.expiresAt + extraExpiry, maxOccurrences: ceiling, watchRenewalId: `renew:${revision}` };
    grant.browserLease = { revision, expiresAt: args.expiresAt, maxOccurrences: ceiling, requestId: args.watchRenewalId };
    await host.commitRoot(host.self(thread), { type: "AikoBrowserWatchLeaseRenewalRequested", id: args.watchRenewalId, owner, watchId,
      leaseRevision: revision, expiresAt: args.expiresAt, maxOccurrences: ceiling, at: Date.now() });
    const confirmation: Event = { type: "AikoBrowserWatchLeaseRenewalChecked", id: `${args.watchRenewalId}:checked`, owner, requestId: args.watchRenewalId, status: "confirmed", at: Date.now() };
    if (confirmed) await host.commitRoot(host.self(thread), confirmation);
    return { args, confirmation };
  };
  return { id, grant, executed, emit, prepare, rows: () => host.read(thread), drive: () => host.recover(),
    renew: async (args: Parameters<typeof channels.logSources.api.renew>[0], confirmation?: Event) => {
      const result = await run(channels.logSources!.api.renew(args, confirmation));
      grant.expiresAt = args.expiresAt;
      if (lostAcknowledgement) { lostAcknowledgement = false; throw Error("fixture-lost-ack-after-commit"); } return result;
    },
    bind: (operationId: string, expiresAt = grant.expiresAt) => run(channels.logSources.api.register({ operationId, source: "browser-push", sourceAuthority,
      receivingAuthority: "fixture-receiving", port: { channel: inlet.channel, generation: inlet.generation }, expiresAt, maxOccurrences: 2 })),
    restart: async () => { await host.close(); db.close(); db = new Database(join(directory, "host.sqlite")); await open(); },
    stop: async (type: "Gap" | "Revoked") => host.commitRoot(host.self(thread), { type: `AikoChannelLogSource${type}`, provenance: CHANNEL_PROVENANCE, owner, id, binding: id, at: Date.now() }),
    current: (value: boolean) => { current = value; }, receiving: (value: boolean) => { receiving = value; },
    revokeAtCommit: () => { revokeAtCommit = true; }, loseAck: () => { lostAcknowledgement = true; },
  };
}

test("native wiring exhaustion renews cumulative capacity without changing cut, cursor, anchors or occurrence identity across disk restart", async () => {
  const f = await fixture(); await f.emit(2); await f.emit(3); await f.emit(4); await f.drive();
  const before = await f.rows(), prior = channelLogSourceLease(before, owner, f.id);
  expect(prior.stop?.type).toBe("AikoChannelLogSourceExhausted"); expect(prior.used).toBe(2); expect(f.executed).toEqual([2, 3]);
  const { args } = await f.prepare(); await f.renew(args);
  const renewed = channelLogSourceLease(await f.rows(), owner, f.id);
  expect(renewed.cut).toEqual(prior.cut); expect(renewed.progress).toEqual(prior.progress); expect(renewed.stop).toBeUndefined();
  expect(renewed.request).toMatchObject({ maxOccurrences: 4 }); expect(renewed.revision).toBe(1);
  await f.restart(); await f.drive(); await f.emit(5); await f.emit(6); await f.drive();
  expect(f.executed).toEqual([2, 3, 4, 5]);
  const after = await f.rows(), second = channelLogSourceLease(after, owner, f.id);
  expect(second.used).toBe(4); expect(second.stop).toMatchObject({ type: "AikoChannelLogSourceExhausted", leaseRevision: 1 });
  const progress = after.filter(e => e.type === "AikoChannelLogSourceProgress");
  expect(progress.map(e => e.id)).toEqual([2, 3, 4, 5].map(sequence => channelDigest([owner, f.id, sequence])));
  await f.restart(); await f.drive(); expect(f.executed).toEqual([2, 3, 4, 5]);
  expect((await f.rows()).filter(e => e.type === "AikoChannelLogSourceCut")).toHaveLength(1);
});

test("time renewal can settle after in-flight observations consume the remaining budget without reopening capacity", async () => {
  const f = await fixture(); await f.emit(2); await f.drive();
  const { args, confirmation } = await f.prepare(1, 2, 1000, false);
  await f.emit(3); await f.emit(4); await f.drive();
  expect(channelLogSourceLease(await f.rows(), owner, f.id).used).toBe(2);
  await f.renew(args, confirmation); await f.restart(); await f.drive();
  const exhausted = channelLogSourceLease(await f.rows(), owner, f.id);
  expect(exhausted.revision).toBe(1);
  expect(exhausted.used).toBe(2);
  expect(exhausted.stop).toMatchObject({ type: "AikoChannelLogSourceExhausted", leaseRevision: 1 });
  expect(f.executed).toEqual([2, 3]);
  const next = await f.prepare(2, 3, 2000); await f.renew(next.args); await f.drive();
  expect(f.executed).toEqual([2, 3, 4]);
  expect((await f.rows()).filter(e => e.type === "AikoChannelLogSourceCut")).toHaveLength(1);
});

test("confirmed paused renewal extends bounds without admitting queued occurrences until explicit resume", async () => {
  const f = await fixture(); const { args, confirmation } = await f.prepare(1, 4, 1000, false);
  f.grant.active = false;
  await f.renew(args, confirmation);
  const rows = await f.rows(), checked = rows.findIndex(e => e.type === confirmation.type), renewed = rows.findIndex(e => e.type === "AikoChannelLogSourceRenewed");
  expect(renewed).toBe(checked + 1);
  await f.emit(2); await f.drive(); await f.restart(); await f.drive(); expect(f.executed).toEqual([]);
  f.grant.active = true;
  await f.emit(3); await f.drive(); expect(f.executed).toEqual([2, 3]);
  expect((await f.rows()).filter(e => e.type === "AikoChannelLogSourceCut")).toHaveLength(1);
});

test("renewal rejects missing or foreign proof, stale/conflicting revisions and reductions", async () => {
  const f = await fixture(); const { args, confirmation } = await f.prepare(1, 4, 1000, false);
  await expect(f.renew(args)).rejects.toThrow("denied");
  for (const changed of [{ owner: "foreign" }, { status: "unknown" }, { requestId: "other" }, { type: "MessageReceived" }])
    await expect(f.renew(args, { ...confirmation, ...changed })).rejects.toThrow("confirmation_invalid");
  expect((await f.rows()).some(e => e.type === "AikoChannelLogSourceRenewed")).toBe(false);
  await f.renew(args, confirmation);
  await expect(f.renew({ ...args, maxOccurrences: 5 })).rejects.toThrow("conflict");
  for (const changed of [{ leaseRevision: 0 }, { leaseRevision: 3 }, { leaseRevision: 2, maxOccurrences: 3 }, { leaseRevision: 2, expiresAt: args.expiresAt - 1 }])
    await expect(f.renew({ ...args, ...changed })).rejects.toThrow("invalid");
  expect((await f.rows()).filter(e => e.type === "AikoChannelLogSourceRenewed")).toHaveLength(1);
});

test("current owner and receiving authority are rechecked at transaction admission", async () => {
  const f = await fixture(); const { args, confirmation } = await f.prepare(1, 4, 1000, false);
  f.receiving(false); await expect(f.renew(args, confirmation)).rejects.toThrow(); f.receiving(true);
  f.revokeAtCommit(); await expect(f.renew(args, confirmation)).rejects.toThrow();
  expect((await f.rows()).some(e => e.type === confirmation.type || e.type === "AikoChannelLogSourceRenewed")).toBe(false);
  f.current(true); await f.renew(args, confirmation);
  expect(channelLogSourceLease(await f.rows(), owner, f.id).revision).toBe(1);
});

test("lost renewal acknowledgement reads retained result and cannot remove Gap or Revoked fences", async () => {
  for (const terminal of ["Gap", "Revoked"] as const) {
    const f = await fixture(); const { args, confirmation } = await f.prepare(1, 4, 1000, false);
    f.loseAck(); await expect(f.renew(args, confirmation)).rejects.toThrow("lost-ack");
    await f.restart(); await f.renew(args, confirmation);
    expect((await f.rows()).filter(e => e.type === "AikoChannelLogSourceRenewed")).toHaveLength(1);
    expect((await f.rows()).filter(e => e.type === confirmation.type)).toHaveLength(1);
    await f.stop(terminal);
    await expect(f.renew(args)).rejects.toThrow("invalid");
    const next = await f.prepare(2, 6); await expect(f.renew(next.args)).rejects.toThrow("invalid");
    await f.emit(2); await f.drive(); expect(f.executed).toEqual([]);
    expect(channelLogSourceLease(await f.rows(), owner, f.id).stop?.type).toBe(`AikoChannelLogSource${terminal}`);
  }
});

test("an exhausted watch grant cannot create a second source cut, and pending expiry grants authorize only the original renewal", async () => {
  const f = await fixture(); await f.emit(2); await f.emit(3); await f.drive();
  expect(channelLogSourceLease(await f.rows(), owner, f.id).stop?.type).toBe("AikoChannelLogSourceExhausted");
  await expect(f.bind("replacement-cut")).rejects.toThrow("grant_denied");
  const confirmedExpiry = f.grant.expiresAt, clock = spyOn(Date, "now").mockImplementation(() => confirmedExpiry + 1000);
  try {
    const { args, confirmation } = await f.prepare(1, 4, 600000, false);
    expect(f.grant.expiresAt).toBe(confirmedExpiry);
    expect(f.grant.browserLease!.expiresAt).toBeGreaterThan(Date.now());
    await expect(f.bind("source", args.expiresAt)).rejects.toThrow("grant_denied");
    await expect(f.bind("replacement-cut", args.expiresAt)).rejects.toThrow("grant_denied");
    await f.renew(args, confirmation);
    expect(channelLogSourceLease(await f.rows(), owner, f.id)).toMatchObject({ revision: 1, used: 2, stop: undefined });
    await f.emit(4); await f.drive(); expect(f.executed).toEqual([2, 3, 4]);
    expect((await f.rows()).filter(e => e.type === "AikoChannelLogSourceCut")).toHaveLength(1);
  } finally { clock.mockRestore(); }
});

test("late exact private confirmation retains expired bounds without admitting work and permits a subsequent fresh revision", async () => {
  const f = await fixture(), { args, confirmation } = await f.prepare(1, 4, 1000, false);
  const clock = spyOn(Date, "now").mockImplementation(() => args.expiresAt + 1000);
  try {
    await f.renew(args, confirmation);
    expect(channelLogSourceLease(await f.rows(), owner, f.id)).toMatchObject({ revision: 1, request: { expiresAt: args.expiresAt } });
    await f.emit(2); await f.drive(); await f.restart(); await f.drive();
    expect(f.executed).toEqual([]);
    await expect(f.bind("source", args.expiresAt)).rejects.toThrow("grant_denied");
    const next = await f.prepare(2, 6, 600000, false);
    await f.renew(next.args, next.confirmation); await f.drive();
    expect(f.executed).toEqual([2]);
    expect(channelLogSourceLease(await f.rows(), owner, f.id).revision).toBe(2);
    expect((await f.rows()).filter(e => e.type === "AikoChannelLogSourceCut")).toHaveLength(1);
  } finally { clock.mockRestore(); }
});
