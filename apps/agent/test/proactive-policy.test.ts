import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { handles } from "tardie/core/actor/contract";
import { component } from "tardie/core/component";
import type { Event } from "tardie/core/event";
import { harnessDigest } from "../src/harness-library.ts";
import { defaultProactivePreferences, proactiveAppendAllowed, proactiveBatchAt, proactiveEligibility, proactiveEventKey,
  proactivePolicy, proactivePreferences, proactiveWaitMethod, validateProactivePreferences, type ProactivePreferences } from "../src/proactive-policy.ts";

const topic = harnessDigest(["fixture-topic"]), otherTopic = harnessDigest(["other-topic"]);
const now = Date.parse("2026-09-08T10:00:00Z");
const preferences = (patch: Partial<ProactivePreferences> = {}, previousRevision = "default", id = "prefs-one", owner = "123", at = now): Event => {
  const value = { ...structuredClone(defaultProactivePreferences), ...patch };
  return { type: "AikoProactivePreferencesSet", owner, id, at, previousRevision, preferences: value, preferencesDigest: harnessDigest(value) };
};
const decision = (id = "decision", at = now, topics = [topic]) => ({ id, at, topics });
const accepted = (id = "decision", at = now): Event => ({ type: "AikoProactiveAccepted", id, owner: "123", chat: "123", at, decisionAt: at,
  supports: ["obs_fixture"], topics: [topic], batchAt: at, batchWindowMs: 0 });
const dispatch = (id = "decision", at = now, claimId = "attempt-one"): Event[] => [
  { type: "AikoProactiveDispatchAuthorized", id, decisionId: id, owner: "123", chat: "123", turn: `proactive:${id}`, epoch: 0, at,
    supports: ["obs_fixture"], topics: [topic], policyRevision: "default", claimId },
  { type: "AikoDeliveryStarted", turn: `proactive:${id}`, epoch: 0, at, proactiveClaimId: claimId },
];

test("preferences reject invalid bounds, zones and ambiguous full-day quiet intervals", () => {
  for (const patch of [{ dailyLimit: -1 }, { dailyLimit: 201 }, { batchWindowMs: 3_600_001 }, { dismissedTopics: [topic, topic] },
    { quietHours: { timeZone: "No/Such_Zone", startMinute: 0, endMinute: 1 } },
    { quietHours: { timeZone: "UTC", startMinute: 0, endMinute: 0 } }])
    expect(() => validateProactivePreferences({ ...defaultProactivePreferences, ...patch })).toThrow();
  expect(validateProactivePreferences({ ...defaultProactivePreferences, enabled: false }).enabled).toBe(false);
});

test("owner-scoped preference CAS survives projection and rejects stale writers and conflicting operation reuse", () => {
  const first = preferences({ dailyLimit: 2 }), stale = preferences({ dailyLimit: 100 }, "default", "stale");
  expect(proactiveAppendAllowed([first], () => [], "user-123")).toBe(true);
  expect(proactiveAppendAllowed([first], () => [], "user-456")).toBe(false);
  expect(proactiveAppendAllowed([stale], () => [first])).toBe(false);
  expect(proactiveAppendAllowed([first], () => [first])).toBe(false);
  const second = preferences({ enabled: false }, "prefs-one", "prefs-two");
  expect(proactiveAppendAllowed([second], () => [first])).toBe(true);
  expect(proactivePreferences([first, stale, second], "123")).toMatchObject({ revision: "prefs-two", preferences: { enabled: false } });
  expect(proactivePreferences([first, second], "456").revision).toBe("default");
});

test("quiet hours use the owner's calendar across overnight and repeated DST hours", () => {
  const quiet = preferences({ quietHours: { timeZone: "America/New_York", startMinute: 22 * 60, endMinute: 7 * 60 } });
  const fallBack = Date.parse("2026-11-01T05:30:00Z");
  expect(proactivePolicy([quiet], "123", decision("night", fallBack), fallBack)).toMatchObject({ status: "defer", reason: "quiet-hours", dueAt: Date.parse("2026-11-01T12:00:00Z") });
  const springForward = Date.parse("2026-03-08T06:30:00Z");
  expect(proactivePolicy([quiet], "123", decision("spring", springForward), springForward).dueAt).toBe(Date.parse("2026-03-08T11:00:00Z"));
  const daylight = Date.parse("2026-11-01T12:00:00Z");
  expect(proactivePolicy([quiet], "123", decision("day", daylight), daylight).status).toBe("allow");
});

test("dismissals, cooldown and charged unknown dispatches survive restart and UTC day rollover", () => {
  const rows = [preferences({ cooldownMs: 60_000, dailyLimit: 1 }), ...dispatch("prior", now - 10_000).map(e => ({ ...e, policyRevision: "prefs-one" })),
    { type: "AikoDeliverySettled", turn: "proactive:prior", at: now, result: { status: "unknown" } }];
  expect(proactivePolicy(structuredClone(rows), "123", decision(), now)).toMatchObject({ status: "defer", reason: "daily-interruption-budget", dueAt: Date.parse("2026-09-09T00:00:00Z") });
  const tomorrow = Date.parse("2026-09-09T00:00:00Z");
  expect(proactivePolicy(rows, "123", decision("new-day", tomorrow), tomorrow).status).toBe("allow");
  expect(proactivePolicy([preferences({ dismissedTopics: [topic] })], "123", decision(), now).reason).toBe("topic-dismissed");
  expect(proactivePolicy([preferences({ dismissedTopics: [topic] })], "123", decision("other", now, [otherTopic]), now).status).toBe("allow");
  const cooldown = [preferences({ cooldownMs: 60_000 }), ...dispatch("prior", now - 10_000)];
  expect(proactivePolicy(cooldown, "123", decision(), now)).toMatchObject({ status: "defer", reason: "cooldown", dueAt: now + 50_000 });
});

test("pending bound deliveries reserve admission capacity without falsely charging a provider call", () => {
  const rows = [preferences({ dailyLimit: 1 }), accepted("earlier")];
  expect(proactivePolicy(rows, "123", decision("later"), now).reason).toBe("daily-interruption-budget");
  expect(proactivePolicy(rows, "123", decision("earlier"), now, "dispatch").status).toBe("allow");
  expect(proactivePolicy([...rows, { type: "AikoDeliverySettled", turn: "proactive:earlier", at: now, result: { status: "rejected" } }], "123", decision("later"), now).status).toBe("allow");
});

test("a pending reservation wakes at its original decision expiry when capacity returns before midnight", () => {
  const first = Date.parse("2026-09-08T00:01:00Z"), second = first + 60_000;
  // Acceptance was delayed, but cannot extend a decision's 24-hour lifetime.
  const rows = [preferences({ dailyLimit: 1 }), { ...accepted("earlier", first + 30_000), decisionAt: first }];
  const midnight = Date.parse("2026-09-09T00:00:00Z");
  expect(proactivePolicy(rows, "123", decision("later", second), midnight)).toMatchObject({
    status: "defer", dueAt: first + 86_400_000, reason: "daily-interruption-budget",
  });
  expect(proactivePolicy(rows, "123", decision("later", second), first + 86_400_000).status).toBe("allow");
  // Real/unknown dispatch reservations cannot expire like unstarted work.
  expect(proactivePolicy([...rows, ...dispatch("sent", midnight)], "123", decision("later", second), midnight).status).toBe("suppress");
});

test("atomic dispatch fence spends the final slot once and binds topics, supports, recipient and exact started claim", () => {
  const base = [preferences({ dailyLimit: 1 }), accepted("a"), accepted("b")];
  const one = dispatch("a").map(e => ({ ...e, ...(e.type === "AikoProactiveDispatchAuthorized" ? { policyRevision: "prefs-one" } : {}) }));
  const two = dispatch("b").map(e => ({ ...e, ...(e.type === "AikoProactiveDispatchAuthorized" ? { policyRevision: "prefs-one" } : {}) }));
  expect(proactiveAppendAllowed(one, () => base)).toBe(true);
  expect(proactiveAppendAllowed(two, () => [...base, ...one])).toBe(false);
  expect(proactiveAppendAllowed([one[0]!], () => base)).toBe(false);
  expect(proactiveAppendAllowed([one[1]!], () => base)).toBe(false);
  expect(proactiveAppendAllowed([{ ...one[0]!, topics: [otherTopic] }, one[1]!], () => base)).toBe(false);
  expect(proactiveAppendAllowed([{ ...one[0]!, supports: ["different"] }, one[1]!], () => base)).toBe(false);
  expect(proactiveAppendAllowed([{ ...one[0]!, chat: "456" }, one[1]!], () => base)).toBe(false);
  expect(proactiveAppendAllowed([one[0]!, { ...one[1]!, proactiveClaimId: "other-attempt" }], () => base)).toBe(false);
});

test("a batch retains its first deadline and an old equal-time preference or alarm cannot wake a new wait", () => {
  const row = { ...proactiveWaitMethod.event({ invocation: { method: "proactiveWait", id: "wait-one", epoch: 0 }, input: { decisionId: "older" }, deadlineAt: now + 1000, at: now }),
    owner: "123", topics: [topic], batchAt: now, batchWindowMs: 1000 };
  const batchAt = proactiveBatchAt([row], "123", decision("newer", now + 900));
  expect(batchAt).toBe(now);
  expect(proactivePolicy([preferences({ batchWindowMs: 1000 }), row], "123", { ...decision("newer", now + 900), batchAt }, now + 900).dueAt).toBe(now + 1000);
  expect(proactiveEligibility([preferences(), { type: "AlarmFired", at: now + 1000 }, row], "123", "older")).toBeUndefined();
  expect(proactiveEligibility([row, preferences()], "123", "older")).toBeDefined();
  expect(proactiveEligibility([row, { type: "AlarmFired", at: now + 1000 }], "123", "older")).toBeDefined();
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test("native method deadline survives SQLite reopen without a separate timer component", async () => {
  const dir = await mkdtemp("/tmp/aiko-proactive-native-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const definition = actor({ name: "aiko", methods: { proactiveWait: proactiveWaitMethod }, components: [handles(proactiveWaitMethod, component<Event[], string | undefined, never>({ name: "wait-proof",
    initial: () => [] as Event[], step: (s, e) => [...s, e], output: events => ({ view: proactiveEligibility(events, "123", "deferred"), transitions: [] }) }))] });
  const open = () => createBunHost({ database: join(dir, "actor.sqlite"), actorName: "aiko", actorInstance: "policy-test", actorFor: () => definition,
    keyOf: proactiveEventKey });
  let host = await open();
  cleanup.push(() => host.close());
  const at = Date.now();
  await host.commitRoot(host.self("user-123"), { ...proactiveWaitMethod.event({ invocation: { method: "proactiveWait", id: "native-defer", epoch: 0 }, input: { decisionId: "deferred" }, deadlineAt: at + 100, at }), owner: "123" });
  await host.drive();
  await host.close();
  await Bun.sleep(120);
  host = await open();
  await host.recover();
  await Bun.sleep(10); // Let the native overdue alarm callback execute.
  await host.drive();
  const events = await host.read("user-123");
  expect(events.some(e => e.type === "AlarmFired")).toBe(true);
  expect(proactiveEligibility(events, "123", "deferred")).toBeDefined();
  expect(events.filter(e => e.type === "AikoProactiveDeferred")).toHaveLength(1);
});
