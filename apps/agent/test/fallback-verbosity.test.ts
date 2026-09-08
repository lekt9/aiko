import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { Layer } from "effect";
import { event, voiceAndOutbox, type AikoEvent } from "../src/actor.ts";
import { createVoice } from "../src/voice.ts";
import { parseFallbackVerbosity, verboseFallbackText } from "../src/fallback-verbosity.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture(since = 0, enabled = true, activate = true) {
  const dir = await mkdtemp("/tmp/aiko-verbose-");
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  const definition = actor({ name: "aiko", methods: {}, components: [voiceAndOutbox(
    "123", createVoice({ enabled: false, persona: "fixture" }),
    async (_owner, text) => { sent.push(text); return { status: "delivered" }; },
    { live: true, browserAnswers: true, requireThinkFeel: true, redact: text => text.replaceAll("fixture-secret", "[redacted]"), verboseFallbacks: enabled, verboseFallbacksSince: since },
  )] });
  const open = () => createBunHost({ database: join(dir, "actor.sqlite"), actorName: "aiko", actorInstance: "test", actorFor: () => definition, layersFor: () => Layer.empty });
  let host = await open();
  cleanup.push(() => host.close());
  return {
    sent,
    seed: async (extra: AikoEvent[] = [], terminal = "TurnCompleted", at = Date.now()) => {
      const rows = [event("MessageReceived", { id: "turn", text: "Find the result", source: "telegram", chat: "123" }), ...extra, { ...event(terminal, { turn: "turn", epoch: 0 }), at }];
      for (const row of rows) {
        await host.commitRoot(host.self("user-123"), row);
        if (activate && row.type === "MessageReceived") await host.drive();
      }
      await host.drive();
      return host.read("user-123");
    },
    restart: async () => { await host.close(); host = await open(); await host.drive(); },
  };
}

test("verbosity configuration validates switch and replay cutoff", () => {
  expect(parseFallbackVerbosity("true", "123")).toEqual({ verboseFallbacks: true, verboseFallbacksSince: 123 });
  expect(parseFallbackVerbosity().verboseFallbacks).toBe(false);
  expect(() => parseFallbackVerbosity("yes")).toThrow();
  expect(() => parseFallbackVerbosity("true", "NaN")).toThrow();
  expect(() => parseFallbackVerbosity("true", "-1")).toThrow();
});

for (const terminal of ["TurnCompleted", "TurnFailed", "TurnCancelled"]) test(`${terminal} without a usable result sends one fallback across restart`, async () => {
  const f = await fixture();
  const log = await f.seed([], terminal);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toContain(`Fallback: ${{ TurnCompleted: "no_result", TurnFailed: "turn_failed", TurnCancelled: "cancelled" }[terminal]}`);
  expect(log.find(e => e.type === "AikoDeliverySettled")?.result).toMatchObject({ status: "delivered" });
  await f.restart();
  expect(f.sent).toHaveLength(1);
});

test("missing answer shows redacted tool results without scheduling a second turn", async () => {
  const f = await fixture();
  await f.seed([event("ToolReturned", { turn: "turn", result: { kind: "read-receipt", owner: "123", text: "Found 3 items; fixture-secret" } })]);
  expect(f.sent[0]).toContain("Fallback: missing_answer");
  expect(f.sent[0]).toContain("Found 3 items; [redacted]");
});

test("uncertain browser fallback exposes status but never page or form contents", async () => {
  const f = await fixture();
  await f.seed([event("ToolReturned", { turn: "turn", result: { kind: "browser-receipt", owner: "123", action: "click", status: "unknown", text: "private page and form values" } })]);
  expect(f.sent[0]).toContain("Fallback: browser_uncertain");
  expect(f.sent[0]).toContain("Browser click: unknown.");
  expect(f.sent[0]).not.toContain("private page");
});

test("activation does not replay historical silent turns", async () => {
  const f = await fixture(200, true, false);
  await f.seed([], "TurnCompleted", 100);
  await f.restart();
  expect(f.sent).toHaveLength(0);
});

test("non-verbose mode delivers a usable failure notice once", async () => {
  const f = await fixture(0, false);
  await f.seed();
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).not.toContain("Fallback:");
  await f.restart();
  expect(f.sent).toHaveLength(1);
});

test("verbose receipts fit a chat message and disclose truncation", () => {
  const text = verboseFallbackText("receipt_summary", Array.from({length: 12}, () => ({kind: "read-receipt", text: "x".repeat(1000)})), x => x);
  expect(text.length).toBeLessThanOrEqual(3500);
  expect(text).toContain("Recorded tool results");
  expect(text).toContain("shortened or omitted");
});

test("real browser operation and allowlisted blocker are shown without private payloads", () => {
 const text=verboseFallbackText("browser_uncertain",[{kind:"browser-receipt",operation:"agent_browser_url",status:"blocked",reason:"private_sign_in_pending",text:"private form password"}],x=>x);
 expect(text).toContain("Browser agent_browser_url: blocked.");
 expect(text).toContain("Finish or cancel the active sign-in");
 expect(text).not.toContain("private form password");
 const unsafe=verboseFallbackText("browser_uncertain",[{kind:"browser-receipt",operation:"agent_browser_url",status:"blocked",reason:"private-password",text:"secret"}],x=>x);
 expect(unsafe).not.toContain("private-password");
});
