import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { EventLog, withWatermark } from "tardie/core/log";
import { createBunHost } from "tardie/bun/host";
import { actionApprovalEventKey, createActionApprovals, type ActionApproval } from "../src/action-approval.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
const human = { owner: "alice", subject: "telegram:alice", authenticated: true as const };
async function fixture(dedup = true) {
  const dir = await mkdtemp("/tmp/action-approval-");
  const options = { database: join(dir, "actor.sqlite"), actorName: "aiko", actorInstance: "test", actorFor: () => undefined, ...(dedup ? { keyOf: actionApprovalEventKey } : {}) };
  let host = await createBunHost(options);
  cleanups.push(async () => { await host.close(); await rm(dir, { recursive: true, force: true }); });
  const thread = "user-alice";
  await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "approval-test-start", at: 1 });
  // Real native host SQLite event store, adapted to the native EventLog port.
  const log = withWatermark({ read: Effect.promise(() => host.read(thread)), append: events => Effect.promise(() => host.seed(thread, events)) });
  const run = <A, E>(effect: Effect.Effect<A, E, EventLog>, signal?: AbortSignal) => Effect.runPromise(effect.pipe(Effect.provideService(EventLog, log)), { signal });
  let time = 100;
  const core = () => createActionApprovals({ owner: "alice", thread, now: () => time });
  const input = { id: "action-1", operation: "telegram_send", connectionId: "telegram-alice", connectionRevision: "revision-1", expiresAt: 1000, payload: { text: "Final ThinkFeel text", destination: "alice" } };
  const prepare = () => run(core().prepare(input));
  const approve = (s: ActionApproval) => run(core().decide(human, { id: s.prepared.id, hash: s.prepared.hash, decision: "approve" }));
  const exact = (s: ActionApproval) => ({ id: s.prepared.id, hash: s.prepared.hash, payload: s.prepared.payload, connectionId: s.prepared.connectionId, connectionRevision: s.prepared.connectionRevision });
  return { run, core, input, prepare, approve, exact, tick: (n: number) => { time = n; }, reopen: async () => { await host.close(); host = await createBunHost(options); }, events: () => host.read(thread) };
}

test("immutable final payload is durable; IDs and hashes cannot be rebound", async () => {
  const f = await fixture();
  const state = await f.prepare();
  f.input.payload.text = "changed draft";
  expect(state.prepared.payload).toEqual({ text: "Final ThinkFeel text", destination: "alice" });
  expect(Object.isFrozen(state.prepared.payload)).toBe(true);
  await expect(f.prepare()).rejects.toThrow();
  await f.reopen();
  expect(await f.run(f.core().get("action-1"))).toEqual(state);
  await expect(f.run(f.core().prepare({ ...f.input, id: "bad", payload: { n: NaN } }))).rejects.toThrow();
});

test("HTTP decisions require an independently authenticated owner and exact hash", async () => {
  const f = await fixture(), s = await f.prepare();
  const body = { id: s.prepared.id, hash: s.prepared.hash, decision: "approve" };
  const request = (data = body) => new Request("https://local/approval", { method: "POST", body: JSON.stringify(data) });
  expect((await f.run(f.core().handleDecision(request(), () => Effect.succeed(undefined)))).status).toBe(403);
  expect((await f.run(f.core().handleDecision(request(), () => Effect.succeed({ ...human, owner: "bob" })))).status).toBe(403);
  expect((await f.run(f.core().handleDecision(request({ ...body, hash: "wrong" }), () => Effect.succeed(human)))).status).toBe(409);
  expect((await f.run(f.core().handleDecision(request(), () => Effect.succeed(human)))).status).toBe(200);
  expect((await f.run(f.core().get(body.id)))?.state).toBe("approved");
});

for (const dedup of [true, false]) test(`concurrent approvals and dispatch have one durable winner (keyed=${dedup})`, async () => {
  const f = await fixture(dedup), s = await f.prepare();
  const clicks = await Promise.all(Array.from({ length: 12 }, () => f.approve(s)));
  expect(new Set(clicks.map(c => c.token)).size).toBe(1);
  let calls = 0;
  const work = () => Effect.sync(() => { calls++; return "succeeded" as const; });
  await Promise.all(Array.from({ length: 12 }, () => f.run(f.core().dispatch(f.exact(s), work))));
  expect(calls).toBe(1);
  expect((await f.run(f.core().get(s.prepared.id)))?.state).toBe("settled");
  await f.reopen();
  await f.run(f.core().dispatch(f.exact(s), work));
  expect(calls).toBe(1);
});

test("competing approve/reject clicks cannot change the winning decision", async () => {
  const f = await fixture(), s = await f.prepare();
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => f.run(f.core().decide(human, { id: s.prepared.id, hash: s.prepared.hash, decision: i % 2 ? "approve" : "reject" }))));
  expect(new Set(results.map(s => s.token)).size).toBe(1);
});

test("changed payload/revision/connection cannot dispatch; expiry blocks approval and execution", async () => {
  const f = await fixture(), s = await f.prepare();
  await f.approve(s);
  let calls = 0;
  const work = () => Effect.sync(() => { calls++; return "succeeded" as const; });
  for (const change of [{ payload: { text: "changed" } }, { connectionRevision: "revision-2" }, { connectionId: "other" }, { hash: "bad" }])
    await expect(f.run(f.core().dispatch({ ...f.exact(s), ...change }, work))).rejects.toThrow();
  f.tick(1000);
  expect((await f.run(f.core().dispatch(f.exact(s), work))).state).toBe("expired");
  expect((await f.approve(s)).state).toBe("expired");
  expect(calls).toBe(0);
});

test("cancellation/revocation are durable and race safely with dispatch", async () => {
  const f = await fixture(), s = await f.prepare();
  await f.approve(s);
  let calls = 0;
  await Promise.all([
    f.run(f.core().cancel(s.prepared.id, "revoked")),
    f.run(f.core().dispatch(f.exact(s), () => Effect.sync(() => { calls++; return "unknown" as const; }))),
  ]);
  const state = await f.run(f.core().get(s.prepared.id));
  expect(["rejected", "unknown"]).toContain(state!.state);
  await f.run(f.core().dispatch(f.exact(s), () => Effect.sync(() => { calls++; return "succeeded" as const; })));
  expect(calls).toBeLessThanOrEqual(1);
  const second = await f.run(f.core().prepare({ ...f.input, id: "second" }));
  expect((await f.run(f.core().cancel(second.prepared.id, "cancelled")))?.state).toBe("rejected");
  expect((await f.approve(second)).state).toBe("rejected");
});

test("provider defects settle unknown and are never retried after reopening", async () => {
  const f = await fixture(), s = await f.prepare();
  await f.approve(s);
  let calls = 0;
  const work = () => Effect.sync(() => { calls++; throw new Error("response lost"); });
  expect((await f.run(f.core().dispatch(f.exact(s), work))).state).toBe("unknown");
  await f.reopen();
  expect((await f.run(f.core().dispatch(f.exact(s), work))).state).toBe("unknown");
  expect(calls).toBe(1);
});

test("durable fence exists before work; cancellation during work remains unknown", async () => {
  const f = await fixture(), s = await f.prepare();
  await f.approve(s);
  let enter!: () => void;
  const entered = new Promise<void>(r => { enter = r; });
  let finish!: () => void;
  const waiting = new Promise<void>(r => { finish = r; });
  let calls = 0;
  const pending = f.run(f.core().dispatch(f.exact(s), () => Effect.promise(async () => { calls++; enter(); await waiting; return "succeeded" as const; })));
  await entered;
  expect((await f.run(f.core().get(s.prepared.id)))?.state).toBe("dispatched");
  expect((await f.run(f.core().dispatch(f.exact(s), () => Effect.succeed("succeeded")))).state).toBe("dispatched");
  await f.run(f.core().cancel(s.prepared.id, "cancelled"));
  finish();
  expect((await pending).state).toBe("unknown");
  expect(calls).toBe(1);
});

test("Effect interruption leaves a consumed fence across native host restart", async () => {
  const f = await fixture(), s = await f.prepare();
  await f.approve(s);
  const controller = new AbortController();
  let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  let calls = 0;
  const pending = f.run(f.core().dispatch(f.exact(s), () => Effect.gen(function* () {
    calls++;
    entered();
    yield* Effect.never;
    return "succeeded" as const;
  })), controller.signal).catch(() => undefined);
  await ready;
  controller.abort();
  await pending;
  await f.reopen();
  const recovered = await f.run(f.core().get(s.prepared.id));
  expect(["dispatched", "unknown"]).toContain(recovered!.state);
  expect((await f.run(f.core().markUnknown(s.prepared.id)))?.state).toBe("unknown");
  expect((await f.run(f.core().dispatch(f.exact(s), () => Effect.sync(() => { calls++; return "succeeded" as const; })))).state).toBe("unknown");
  expect(calls).toBe(1);
});

test("same-ID prepare races cannot overwrite payload, and another owner cannot see consent", async () => {
  const f = await fixture(false);
  const outcomes = await Promise.allSettled([
    f.prepare(),
    f.run(f.core().prepare({ ...f.input, payload: { text: "different final payload" } })),
  ]);
  expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(o => o.status === "rejected")).toHaveLength(1);
  const bob = createActionApprovals({ owner: "bob", thread: "user-alice" });
  expect(await f.run(bob.get("action-1"))).toBeUndefined();
});
