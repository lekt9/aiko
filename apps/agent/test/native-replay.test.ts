import { expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor } from "tardie";
import { component, composeComponents } from "tardie/core/component";
import { effect } from "tardie/core/effect";
import { materializeProjection } from "tardie/core/projection";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

const algebra = { empty: [] as number[], combine: (a: number[], b: number[]) => [...a, ...b] };

test("native replay derives only observed prefixes and caches undefined values without losing forks", () => {
  let outputs = 0;
  const p = materializeProjection({
    initial: () => 0,
    step: (state: number, e: Event) => e.type === "Advance" ? state + 1 : state,
    output: (state: number) => { outputs++; return state % 2 ? undefined : state; },
  });
  let state = p.initial();
  for (let i = 0; i < 20_000; i++) state = p.step(state, { type: "Advance" });
  expect(outputs).toBe(0);
  expect(p.output(state)).toBe(20_000);
  expect(p.output(state)).toBe(20_000);
  expect(outputs).toBe(1);
  const fork = p.step(state, { type: "Advance" });
  expect(p.output(fork)).toBeUndefined();
  expect(p.output(fork)).toBeUndefined();
  expect(outputs).toBe(2);
  expect(p.step(fork, { type: "Irrelevant" })).toBe(fork);
  expect(p.output(state)).toBe(20_000);
});

test("nested compositions retain current views, stable children and cancellation state without prefix outputs", () => {
  const outputs = [0, 0];
  const make = (index: number) => component({
    name: `counter-${index}`,
    initial: () => 0,
    step: (state: number, e: Event) => e.type === `Advance${index}` ? state + 1 : state,
    output: (state: number) => { outputs[index]++; return { view: [state], transitions: [] }; },
    cancelState: (state: number) => [effect({ key: `cleanup:${index}:${state}`, input: null, act: () => Effect.succeed([]) })],
  });
  const a = make(0), b = make(1);
  const nested = composeComponents("outer", algebra, [composeComponents("inner", algebra, [a]), b]);
  const flat = composeComponents("flat", algebra, [a, b]);
  let state = nested.machine.initial(), reference = flat.machine.initial();
  for (let i = 0; i < 20_000; i++) {
    const event = { type: "Advance0" };
    state = nested.machine.step(state, event);
    reference = flat.machine.step(reference, event);
  }
  expect(outputs).toEqual([0, 0]);
  const cancellation = { request: "cancel", invocation: { method: "message", id: "turn", epoch: 0 }, cause: "requested" as const };
  expect(nested.machine.cancel!(state, cancellation).map(t => t.key)).toEqual(["cleanup:0:20000", "cleanup:1:0"]);
  expect(outputs).toEqual([0, 0]);
  expect(nested.machine.output(state).view).toEqual([20_000, 0]);
  expect(flat.machine.output(reference).view).toEqual([20_000, 0]);
  const before = [...outputs];
  const fork = nested.machine.step(state, { type: "Advance0" });
  expect(nested.machine.output(fork).view).toEqual([20_001, 0]);
  expect(outputs).toEqual([before[0] + 1, before[1]]);
  expect(nested.machine.output(state).view).toEqual([20_000, 0]);
  const other = nested.machine.step(state, { type: "Advance1" });
  expect(nested.machine.output(other).view).toEqual([20_000, 1]);
  expect(nested.machine.output(fork).view).toEqual([20_001, 0]);
});

test("deferred composition reconciliation sees the full current history and rejects invented work", () => {
  const work = effect({ key: "work", input: null, act: () => Effect.succeed([]) });
  const child = component({ name: "constant", initial: () => null, step: s => s,
    output: () => ({ view: [] as number[], transitions: [work] }) });
  let observed: readonly Event[] = [];
  const composed = composeComponents("reconciled", algebra, [child], { reconcile: (log, work) => {
    observed = log;
    return log.at(-1)?.type === "Allow" ? work : [];
  } });
  const initial = composed.machine.initial();
  const allowed = composed.machine.step(initial, { type: "Allow" });
  const revoked = composed.machine.step(allowed, { type: "Revoke" });
  expect(composed.machine.output(revoked).transitions).toEqual([]);
  expect(observed.map(e => e.type)).toEqual(["Allow", "Revoke"]);
  expect(composed.machine.output(allowed).transitions).toEqual([work]);
  expect(observed.map(e => e.type)).toEqual(["Allow"]);
  const foreign = composeComponents("foreign", algebra, [child], { reconcile: () => [
    effect({ key: "foreign", input: null, act: () => Effect.succeed([]) }),
  ] });
  expect(() => foreign.machine.output(foreign.machine.initial())).toThrow("outside its transition set");
  const duplicate = composeComponents("duplicate", algebra, [child], { reconcile: (_log, work) => [work[0]!, work[0]!] });
  expect(() => duplicate.machine.output(duplicate.machine.initial())).toThrow("more than once");
});

test("an output failure blocks native effects, then recovers the current prefix without replaying a settled effect", async () => {
  let blocked = true, calls = 0;
  const definition = actor({ name: "replay", methods: {}, components: [
    component({ name: "work", keys: { prefixes: ["probe:"], keyOf: e => e.type === "Done" ? "probe:done" : undefined },
      initial: () => ({ requested: false, done: false }),
      step: (s, e) => ({ requested: s.requested || e.type === "Start", done: s.done || e.type === "Done" }),
      output: s => ({ view: undefined, transitions: s.requested && !s.done ? [effect({ key: "probe:done", input: null,
        act: () => Effect.sync(() => { calls++; return [{ type: "Done", at: Date.now() }]; }) })] : [] }) }),
    component({ name: "failing-output", initial: () => false, step: (s, e) => s || e.type === "Start",
      output: s => { if (s && blocked) throw Error("output blocked"); return { view: undefined, transitions: [] }; } }),
  ] });
  const db = new Database(":memory:");
  const storage: AccountStorage = {
    sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as never[]); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {},
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
  };
  const open = () => createCloudflareAccountHost({ storage, actorName: "replay", actorInstance: "test",
    ownsThread: t => t === "user-123", actorFor: () => definition,
    // Effect 4 declares Layer's provided-services parameter contravariantly, and this
    // actor's inferred services include `unknown`, so the empty layer must be typed
    // accordingly even though its components use no services.
    layersFor: () => Layer.empty as Layer.Layer<unknown> });
  let host = await open();
  onTestFinished(async () => { await host.close(); db.close(); });
  await host.commitRoot(host.self("user-123"), { type: "Start", at: Date.now() });
  await expect(host.wake("user-123")).rejects.toThrow("output blocked");
  expect(calls).toBe(0);
  blocked = false;
  await host.recover();
  expect(calls).toBe(1);
  const events = await host.read("user-123");
  await host.close(); host = await open(); await host.recover();
  expect(calls).toBe(1);
  expect(await host.read("user-123")).toEqual(events);
});
