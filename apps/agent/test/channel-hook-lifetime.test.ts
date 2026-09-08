import { expect, test } from "bun:test";
import { fixture } from "./channel-wiring.test.ts";
import { channelDigest, CHANNEL_PROVENANCE } from "../src/channel-bindings.ts";
import {
  hookClosure,
  hookPendingDisposition,
  hookPortOpen,
} from "../src/channel-hook-lifetime.ts";
import {
  channelWiringAppendAllowed,
  channelWiringNextWake,
} from "../src/channel-wiring.ts";
const owner = "alice",
  execution = "channel-handler:fixture",
  namespace = "child:" + channelDigest("fixed-parent");
const event = (kind: string, id: string, data: object = {}) => ({
  type: `AikoChannelWiring${kind}`,
  id,
  owner,
  provenance: CHANNEL_PROVENANCE,
  at: 0,
  ...data,
});
const handler = { harness: "a".repeat(64), contract: "b".repeat(64) };
test("native cleanup preserves uncertain dispatch, cancels queued custody and restores exact identity", async () => {
  const f = await fixture({
    bindings: {
      authorizeAdoption: async (a) =>
        a.execution === execution &&
        a.authorityRef === "grant" &&
        a.expiresAt <= Date.now() + 60000
          ? channelDigest("explicit-standing-policy-v1")
          : undefined,
      execute: async () => ({
        status: "pending",
        evidence: "physical_ack_missing",
      }),
    },
  });
  await f.commitNative({ type: "FixtureStarted", id: "start", at: 0 });
  const deadline = Date.now() + 60000;
  await f.commitNative(
    event("ManagementGranted", execution, {
      namespace,
      parentOperation: "parent-op",
      deadline,
      grantRef: "private-grant",
    }),
  );
  const a = await f.run(
    f.api.bind({
      name: namespace + ":0",
      operationId: namespace + ":0",
      schema: "fixture.v1",
      directions: ["inbox", "outbox"],
      authorityRef: "grant",
    }),
  );
  const b = await f.run(
    f.api.bind({
      name: namespace + ":1",
      operationId: namespace + ":1",
      schema: "fixture.v1",
      directions: ["inbox", "outbox"],
      authorityRef: "grant",
    }),
  );
  const input = { channel: a.channel, generation: 1 },
    output = { channel: b.channel, generation: 1 };
  await f.run(
    f.api.connect({
      name: namespace + ":2",
      operationId: namespace + ":2",
      generation: 1,
      input,
      output: { ...output, mode: "port" },
      handler,
      accepts: "fixture.v1",
      authorityRef: "grant",
      start: "after-registration",
    }),
  );
  await f.run(
    f.api.emit({
      port: input,
      schema: "fixture.v1",
      value: { text: "private-pending" },
      occurrence: "one",
      correlation: "one",
      authorityRef: "grant",
    }),
  );
  await f.drive();
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringStarted"),
  ).toBe(true);
  await expect(
    f.run(
      f.api.adopt({
        execution,
        operationId: "unsafe-adoption",
        authorityRef: "grant",
        expiresAt: Date.now() + 30000,
      }),
    ),
  ).rejects.toThrow("uncertainty");
  await expect(
    f.run(
      f.api.adopt({
        execution,
        operationId: "foreign",
        authorityRef: "foreign",
        expiresAt: Date.now() + 30000,
      }),
    ),
  ).rejects.toThrow();
  expect(
    (await f.read()).some((e) => e.type === "AikoChannelWiringHookAdopted"),
  ).toBe(false);
  await f.commitNative({
    type: "TurnCancelled",
    turn: execution,
    epoch: 0,
    at: Date.now(),
  });
  await f.drive();
  const rows = await f.read(),
    cleanup = rows.find((e) => e.type === "AikoChannelWiringHookCleaned");
  expect(cleanup?.reason).toBe("cancelled");
  expect(JSON.stringify(cleanup?.pending)).toContain("unknown_retained");
  expect(JSON.stringify(rows)).not.toContain("private-pending");
  expect(hookPortOpen(rows, owner, input, Date.now())).toBe(false);
  await expect(
    f.run(
      f.api.emit({
        port: input,
        schema: "fixture.v1",
        value: { text: "late" },
        occurrence: "late",
        correlation: "late",
        authorityRef: "grant",
      }),
    ),
  ).rejects.toThrow();
  const starts = rows.filter((e) => e.type === "AikoChannelWiringStarted");
  await f.restart();
  await f.drive();
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringStarted"),
  ).toEqual(starts);
  expect(
    (await f.read()).filter((e) => e.type === "AikoChannelWiringHookCleaned"),
  ).toEqual([cleanup!]);
  expect(channelWiringNextWake(await f.read(), owner)).toBeUndefined();
});
test("expiry and cancel fences apply before cleanup effects; standing adoption is explicit and cannot resurrect or extend itself", () => {
  const g = {
    execution,
    namespace,
    parentOperation: "parent-op",
    deadline: 100,
  };
  const port = { channel: "owned", generation: 1 };
  const rows = [
    event("ManagementGranted", execution, g),
    event("Bound", "owned:1", { port, operationId: namespace + ":0" }),
  ];
  expect(hookClosure(rows, owner, g, 101)).toBe("expired");
  expect(hookPortOpen(rows, owner, port, 101)).toBe(false);
  expect(
    channelWiringAppendAllowed(
      [
        event("HookAdopted", execution, {
          ...g,
          expiresAt: Date.now() + 10000,
        }),
      ],
      () => rows,
    ),
  ).toBe(false);
  const adopted = [
    ...rows,
    event("HookAdopted", execution, {
      ...g,
      expiresAt: 200,
      policyDigest: "fixed-standing-policy",
    }),
    event("HandlerChecked", execution, { status: "unavailable" }),
  ];
  expect(hookClosure(adopted, owner, g, 150)).toBeUndefined();
  expect(hookClosure(adopted, owner, g, 200)).toBe("expired");
  expect(
    hookClosure([...adopted, event("HookRetired", execution)], owner, g, 150),
  ).toBe("revoked");
  expect(hookPendingDisposition(rows, owner, g)).toEqual([]);
  expect(hookPortOpen(rows, "foreign", port, 101)).toBe(true); // no authority is conferred by this metadata projection
  expect(channelWiringNextWake(rows, owner)).toBe(101);
});
test("native deadline wake after restart cleans up task ports without a separate timer", async () => {
  const f = await fixture();
  await f.commitNative({ type: "FixtureStarted", id: "expiry", at: 0 });
  const deadline = Date.now() + 250;
  await f.commitNative(
    event("ManagementGranted", execution, {
      namespace,
      parentOperation: "expiry-parent",
      deadline,
      grantRef: "private-grant",
    }),
  );
  const p = await f.run(
    f.api.bind({
      name: namespace + ":0",
      operationId: namespace + ":0",
      schema: "fixture.v1",
      directions: ["inbox"],
      authorityRef: "grant",
    }),
  );
  await f.run(
    f.api.emit({
      port: { channel: p.channel, generation: 1 },
      schema: "fixture.v1",
      value: { text: "queued-before-expiry" },
      occurrence: "queued",
      correlation: "queued",
      authorityRef: "grant",
    }),
  );
  expect(channelWiringNextWake(await f.read(), owner)).toBe(deadline + 1);
  await f.restart();
  await Bun.sleep(Math.max(1, deadline - Date.now() + 5));
  await f.commitNative({ type: "AlarmFired", at: Date.now() });
  await f.drive();
  const cleanup = (await f.read()).find(
    (e) => e.type === "AikoChannelWiringHookCleaned",
  );
  expect(cleanup?.reason).toBe("expired");
  expect(JSON.stringify(cleanup?.pending)).toContain(
    "cancelled_before_handoff",
  );
  await expect(
    f.run(
      f.api.adopt({
        execution,
        operationId: "late",
        authorityRef: "grant",
        expiresAt: Date.now() + 10000,
      }),
    ),
  ).rejects.toThrow();
  expect(f.calls).toBe(0);
});
