import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { actor } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { followLogMemory } from "../src/log-memory.ts";
import { openMemory, type MemoryBinding } from "../src/memory.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
const row = (type: string, data: Record<string, unknown>) => ({ type, at: 1, ...data });
type Cut = "none" | "committed" | "partial";
async function fixture(cut: Cut = "none", gap = false) {
  const stateDir = await mkdtemp("/tmp/aiko-log-continuation-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  let reads = 0;
  const binding: MemoryBinding = { stateDir, owner: "123", thread: "user-123", redact: s => s,
    readPage: async (after, limit) => {
      reads++;
      const rows = await host.readPage("user-123", after, limit);
      // Preserve real native seq values: simulate a missing retained row, never renumber.
      return gap ? rows.filter(r => r.seq !== 11) : rows;
    },
  };
  const open = async (mode: Cut) => {
    const original = followLogMemory(binding);
    const mounted = mode === "none" ? original : { ...original, machine: { ...original.machine,
      output: (state: ReturnType<typeof original.machine.initial>) => {
        const out = original.machine.output(state);
        return { ...out, transitions: out.transitions.map(t => t.kind !== "effect" ? t : { ...t,
          act: (...args: Parameters<typeof t.act>) => {
            // Native heterogeneous transitions erase their input to never. Inspect
            // the actual dispatched input through an unknown boundary, not a cast.
            const input: unknown = args[0];
            if (mode === "partial") {
              if (!input || typeof input !== "object" || !("after" in input) || typeof input.after !== "number")
                return Effect.die(new Error("unexpected follower effect input"));
              if (input.after >= 800) return Effect.die(new Error("cut after retained partial"));
            }
            return t.act(...args).pipe(Effect.tap(() => mode === "committed"
              ? Effect.die(new Error("cut after DB commit")) : Effect.void));
          },
        }) };
      },
    } };
    return createBunHost({ database: join(stateDir, "actor.sqlite"), actorName: "aiko", actorInstance: "independent", actorFor: () => actor({ name: "aiko", methods: {}, components: [mounted] }) });
  };
  let host = await open(cut);
  cleanup.push(async () => { await host.close(); });
  await host.commitRoot(host.self(binding.thread), row("FixtureRoot", { id: "root" }));
  await host.seed(binding.thread, Array.from({ length: 850 }, (_, i) => row("ToolReturned", {
    callId: `native-call-${i}`, name: "fixture", result: "PRIVATE_RESULT_DO_NOT_INDEX", arguments: { value: "PRIVATE_ARGUMENT_DO_NOT_INDEX" },
  })));
  await host.seed(binding.thread, [row("AikoReplyPrepared", { turn: "only-turn", result: { text: "done", source: "template" } })]);
  const retained = await host.readPage(binding.thread, 0, 2000);
  const target = retained.at(-1)!.seq;
  const observations = () => {
    const memory = openMemory(binding);
    try { return memory.journal.page(memory.scope, { limit: 2000 }); } finally { memory.close(); }
  };
  return { binding, target, observations, reads: () => reads, host: () => host,
    restart: async () => { await host.close(); host = await open("none"); await host.recover(); },
  };
}
async function assertComplete(f: Awaited<ReturnType<typeof fixture>>) {
  const events = await f.host().read(f.binding.thread);
  const receipts = events.filter(e => e.type === "AikoLogMemoryFollowed");
  expect(receipts.some(e => e.status === "partial")).toBe(true);
  expect(receipts.at(-1)?.status).toBe("current");
  expect(Number(receipts.at(-1)?.after)).toBeGreaterThanOrEqual(f.target);
  expect(events.filter(e => e.type === "AikoReplyPrepared")).toHaveLength(1);
  expect(events.filter(e => e.type === "MessageReceived")).toHaveLength(0);
  const obs = f.observations();
  expect(obs.length).toBeGreaterThanOrEqual(852);
  expect(new Set(obs.map(o => o.subject)).size).toBe(obs.length);
  const text = JSON.stringify(obs);
  expect(text).not.toContain("PRIVATE_RESULT_DO_NOT_INDEX");
  expect(text).not.toContain("PRIVATE_ARGUMENT_DO_NOT_INDEX");
  const before = obs.map(o => o.id).sort();
  const count = f.reads();
  await f.host().wake(f.binding.thread);
  expect(f.observations().map(o => o.id).sort()).toEqual(before);
  expect(f.reads()).toBe(count);
}
test("native follower drains >800 retained events without another turn and preserves private projection", async () => {
  const f = await fixture(); await f.host().wake(f.binding.thread); await assertComplete(f);
}, 30_000);
test("native follower resumes after retained partial on reopened SQLite host", async () => {
  const f = await fixture("partial");
  await expect(f.host().wake(f.binding.thread)).rejects.toThrow("cut after retained partial");
  const receipts = (await f.host().read(f.binding.thread)).filter(e => e.type === "AikoLogMemoryFollowed");
  expect(receipts).toHaveLength(1); expect(receipts[0]!.status).toBe("partial");
  const ids = f.observations().map(o => o.id);
  await f.restart(); await assertComplete(f);
  const after = new Set(f.observations().map(o => o.id));
  expect(ids.every(id => after.has(id))).toBe(true);
}, 30_000);
test("DB commit before native receipt reuses observations and then continues", async () => {
  const f = await fixture("committed");
  await expect(f.host().wake(f.binding.thread)).rejects.toThrow("cut after DB commit");
  expect((await f.host().read(f.binding.thread)).filter(e => e.type === "AikoLogMemoryFollowed")).toHaveLength(0);
  const ids = f.observations().map(o => o.id); expect(ids).toHaveLength(800);
  await f.restart(); await assertComplete(f);
  const memory = openMemory(f.binding);
  try { for (const o of f.observations().filter(o => ids.includes(o.id))) expect(memory.history(o.subject)).toHaveLength(1); }
  finally { memory.close(); }
}, 30_000);
test("native sequence gap fails closed without cursor advancement or hot loop", async () => {
  const f = await fixture("none", true); await f.host().wake(f.binding.thread);
  const receipts = (await f.host().read(f.binding.thread)).filter(e => e.type === "AikoLogMemoryFollowed");
  expect(receipts).toHaveLength(1); expect(receipts[0]!.status).toBe("error"); expect(receipts[0]!.after).toBe(0);
  expect(f.observations()).toHaveLength(0);
  const reads = f.reads(); await f.host().wake(f.binding.thread); expect(f.reads()).toBe(reads);
}, 30_000);
