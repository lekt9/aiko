import { expect, test } from "bun:test";
import { compaction, compactionReactor } from "tardie/component/compaction";
import type { Event } from "tardie/core/event";

test("native compaction recovers a large observation log without rescanning every prefix", () => {
  const machine = compaction({ contextWindowTokens: 32_768 }).machine;
  let state = machine.initial();
  const start = performance.now();
  for (let i = 0; i < 20_000; i++) {
    state = machine.step(state, { type: "NetworkFactObserved", id: `fact-${i}`, at: i });
    if (machine.output(state).transitions.length) throw new Error("Observations must not trigger compaction");
  }
  // The former full-transcript scan took seconds and wedged live DO recovery.
  expect(performance.now() - start).toBeLessThan(2_000);
});

test("incremental compaction retains the complete-history guard and checkpoint", () => {
  const policy = { contextWindowTokens: 20_000, fireRatio: 0.8, keepRatio: 0.2 };
  const machine = compaction(policy).machine;
  const complete = compactionReactor(policy);
  let state = machine.initial();
  const log: Event[] = [];
  const events: Event[] = [{ type: "MessageReceived", id: "m0", text: "Inspect results", at: 0 }];
  for (let i = 1; i <= 16; i++) events.push(
    { type: "ToolCalled", callId: `c${i}`, name: "execute", arguments: {}, turn: "m0", at: i * 2 },
    { type: "ToolReturned", callId: `c${i}`, result: { data: "x".repeat(5_000) }, turn: "m0", at: i * 2 + 1 },
  );
  let fired = false;
  for (const event of events) {
    log.push(event);
    state = machine.step(state, event);
    const actual = machine.output(state).transitions;
    fired ||= actual.length > 0;
    expect(actual.map(t => ({ key: t.key, input: t.kind === "effect" ? t.input : undefined })))
      .toEqual(complete(log).map(t => ({ key: t.key, input: t.kind === "effect" ? t.input : undefined })));
  }
  expect(fired).toBe(true);
});
