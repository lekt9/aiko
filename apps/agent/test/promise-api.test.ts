import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Infer } from "tardie";
import { withPromiseExecution } from "../src/promise-execution.ts";
import { EventLog, withWatermark } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { createPromises, promiseState, promiseTools } from "../src/promises.ts";
import { promiseApi } from "../src/promise-api.ts";

function fixture() {
  const rows: Event[] = [];
  let wakes = 0, now = Date.now();
  const host = { read: async () => rows, append: async (events: readonly Event[]) => { rows.push(...events); }, wake: async () => { wakes++; } };
  const log = withWatermark({ read: Effect.promise(host.read), append: events => Effect.promise(() => host.append(events)) });
  const service = createPromises({ owner: "123", thread: "user-123", now: () => now });
  const run = <T>(effect: Effect.Effect<T, unknown, EventLog>) => Effect.runPromise(effect.pipe(Effect.provideService(EventLog, log)));
  const principal = { owner: "123", scopes: ["read", "write"] };
  const payload = { kind: "harness" as const, segment: { version: 1 as const, code: 'return await tools.call({name:"fixture_send",arguments:finalPayload});', values: { finalPayload: { destination: "fixture-recipient", text: "Final ThinkFeel text", attachment: "fixture-file" } }, packages: { tools: ["call"] }, ambient: { at: now, seed: "fixture" }, history: [] } };
  const prepare = (id = "promise-fixture") => run(service.prepare({ intentId: id, payload, when: { kind: "approval" } }));
  const api = (method: string, body?: unknown, auth: typeof principal | undefined = principal, origin?: string) => promiseApi(new Request(`https://fixture.test/api/promises${method === "POST" ? "/decision" : ""}`, { method, headers: origin ? { origin } : {}, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "123", auth, host);
  return { rows, host, run, service, prepare, api, payload, principal, wakes: () => wakes, expire: () => { now += 31 * 86400_000; } };
}

test("owner API lists the frozen final payload and accepts exact consent, not agent decisions", async () => {
  const f = fixture(), prepared = await f.prepare();
  const response = await f.api("GET");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const review = (await response.json()).promises[0];
  expect(review.payload).toEqual(f.payload);
  expect(review.hash).toBe(prepared.hash);
  const response2 = await f.api("POST", { id: review.id, hash: review.hash, decision: "approve" });
  expect(response2.status).toBe(200);
  expect((await response2.json()).promise.state).toBe("resolved");
  expect(f.wakes()).toBe(1);
  expect(promiseTools("123", text => text).map(t => t.spec.name)).toEqual(["promise_prepare", "promise_cancel", "promise_list"]);
});

test("account, scope, operator, origin and hostile JSON cannot approve or disclose another owner's work", async () => {
  const f = fixture(), prepared = await f.prepare();
  const body = { id: prepared.id, hash: prepared.hash, decision: "approve" };
  for (const auth of [{ owner: "456", scopes: ["read", "write"] }, { owner: "123", scopes: ["read"] }, { ...f.principal, operator: true }]) {
    expect((await promiseApi(new Request("https://fixture.test/v1/promises/decision", { method: "POST", body: JSON.stringify(body) }), "123", auth, f.host)).status).toBe(403);
  }
  expect((await promiseApi(new Request("https://fixture.test/api/promises"), "123", undefined, f.host)).status).toBe(401);
  expect((await f.api("GET", undefined, { owner: "456", scopes: ["read"] })).status).toBe(403);
  expect((await f.api("POST", body, f.principal, "https://foreign.test")).status).toBe(403);
  expect((await f.api("POST", { ...body, owner: "123" })).status).toBe(400);
  expect((await f.api("POST", { ...body, hash: "stale" })).status).toBe(409);
  expect((await f.api("POST", { ...body, id: "missing" })).status).toBe(404);
  expect(promiseState(f.rows).records.get(prepared.id)?.state).toBe("pending");
  expect(f.wakes()).toBe(0);
});

test("cancel and approval races preserve the winning transition; cancelled and expired records never reopen", async () => {
  const f = fixture(), prepared = await f.prepare();
  const decisions = await Promise.all(["cancel", "approve"].map(decision => f.api("POST", { id: prepared.id, hash: prepared.hash, decision })));
  const final = promiseState(f.rows).records.get(prepared.id)!;
  expect(final.state).toBe("cancelled");
  expect(decisions.map(r => r.status)).toEqual([200, 409]);
  expect((await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "approve" })).status).toBe(409);
  const expiring = await f.prepare("promise-expire"); f.expire();
  await f.run(f.service.get(expiring.id));
  expect((await f.api("POST", { id: expiring.id, hash: expiring.hash, decision: "approve" })).status).toBe(409);
  expect((await f.prepare("promise-expire")).hash).toBe(expiring.hash);
});

test("snapshot before consent, changed-intent conflicts and exact concurrent preparation identity", async () => {
  const f = fixture();
  const original = structuredClone(f.payload);
  const operation = f.run(f.service.prepare({ intentId: "same", payload: f.payload, when: { kind: "approval" } }));
  // Hashing has crossed an async boundary; mutating caller input must not change it.
  await Promise.resolve();
  f.payload.segment.values.finalPayload.text = "Changed after consent capture";
  const first = await operation;
  expect(first.payload).toEqual(original);
  await expect(f.prepare("same")).rejects.toThrow("another payload");
  const [a, b] = await Promise.all([f.prepare("concurrent"), f.prepare("concurrent")]);
  expect(a.hash).toBe(b.hash); expect(a.expiresAt).toBe(b.expiresAt);
  const fresh = await f.prepare("new-intent");
  expect(fresh.id).not.toBe(first.id);
  (first.payload.segment.values.finalPayload as { text: string }).text = "Mutated returned view";
  expect((await f.run(f.service.get(first.id)))?.payload).toEqual(original);
});

test("wake failure acknowledges the durable decision without claiming dispatch or inviting a new attempt", async () => {
  const f = fixture(), prepared = await f.prepare();
  f.host.wake = async () => { throw Error("Synthetic scheduler unavailable"); };
  const response = await f.api("POST", { id: prepared.id, hash: prepared.hash, decision: "approve" });
  expect(response.status).toBe(202);
  expect(await response.json()).toMatchObject({ warning: "decision_saved_execution_pending", promise: { state: "resolved", hash: prepared.hash } });
  expect(promiseState(f.rows).records.get(prepared.id)?.state).toBe("resolved");
});

test("frozen execution never calls provider compaction, while ordinary turns keep the existing provider", async () => {
  let compactions = 0;
  const base = Layer.succeed(Infer, { react: () => Effect.succeed({ kind: "complete" as const, output: "ordinary" }), compact: () => Effect.sync(() => { compactions++; return { state: "provider" }; }) });
  const layer = withPromiseExecution(base, "123", async () => []);
  const request = { identity: { actor: "aiko", instance: "fixture", thread: "user-123", turn: "promise-execution:missing" }, trajectory: [], system: "", tools: [] };
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* Infer;
    expect(yield* service.compact!(request)).toBeUndefined();
    expect(yield* service.react(request)).toMatchObject({ kind: "fail" });
    expect(yield* service.compact!({ ...request, identity: { ...request.identity, turn: "ordinary" } })).toEqual({ state: "provider" });
  }).pipe(Effect.provide(layer)));
  expect(compactions).toBe(1);
});

test("invalid package bindings and pre-filled execution history cannot be staged as frozen consent", async () => {
  const f = fixture();
  for (const segment of [
    { ...f.payload.segment, packages: { tools: ["constructor"] } },
    { ...f.payload.segment, values: { tools: {} } },
    { ...f.payload.segment, packages: { tools: "call" } },
    { ...f.payload.segment, history: [{ call: { ordinal: 0, packageName: "tools", method: "call", args: {} }, result: "fake receipt" }] },
  ]) {
    await expect(f.run(f.service.prepare({ payload: { kind: "harness", segment } as never, when: { kind: "approval" } }))).rejects.toThrow("Invalid promise payload");
  }
  expect(f.rows).toEqual([]);
});
