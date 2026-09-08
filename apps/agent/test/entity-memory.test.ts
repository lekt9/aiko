import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import {
  actor,
  agentMessageMethod,
  infer,
  system,
  tool,
  Infer,
  outputValidateOnce,
} from "tardie";
import { Self } from "tardie/core/runtime";
import { createBunHost } from "tardie/bun/host";
import {
  memoryTools,
  memoryPath,
  openMemory,
  type MemoryBinding,
  type MemoryReceipt,
} from "../src/memory.ts";
import { createAikoActor, event, type AikoEvent } from "../src/actor.ts";
import { createVoice } from "../src/voice.ts";
import { redactor } from "../src/security.ts";
import type { Observation, RecallResult } from "entity-learn";
import type { ReadReceipt } from "../src/capabilities.ts";

import { memoryTestAuthority } from "./memory-authority-fixture.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const stateDir = await mkdtemp("/tmp/aiko-entity-test-");
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const authority = memoryTestAuthority(stateDir);
  cleanup.push(() => authority.close());
  let reads = 0;
  const binding = (owner = "123", thread = "thread-one"): MemoryBinding => ({
    stateDir,
    owner,
    thread,
    ...authority.binding(owner),
    redact: redactor(["fixture-private-key-123456"]),
    readPage: async () => {
      reads++;
      return [];
    },
  });
  const run = <Result = MemoryReceipt>(
    name: string,
    input: unknown,
    callId: string,
    bound = binding(),
    signal = new AbortController().signal,
    turn?: string,
  ) => {
    const native = memoryTools(bound).find(
      (entry) => entry.spec.name === name,
    )!;
    return Effect.runPromise(
      native.run(input, { callId, signal, turn }).pipe(
        Effect.provideService(Self, {
          actor: "aiko",
          instance: "test",
          thread: bound.thread,
        }),
      ),
    ) as Promise<Result>;
  };
  return {
    stateDir,
    binding,
    run,
    get reads() {
      return reads;
    },
  };
}
const note = {
  subject: "preferences/clock",
  title: "Master clock",
  type: "decision",
  payload: { take: "B", timezone: "UTC" },
};
const saved = (receipt: MemoryReceipt) =>
  receipt.result as unknown as Observation;

describe("real entity-learn engine in native Tardie tools", () => {
  test("constructing the native tool surface has no storage or source side effects", async () => {
    const f = await fixture();
    const bindings = memoryTools(f.binding());
    const component = tool(bindings);
    expect(
      component.machine.output(component.machine.initial()).view.tools.length,
    ).toBe(14);
    expect(existsSync(join(f.stateDir, "memory"))).toBe(false);
    expect(f.reads).toBe(0);
    const names = bindings.map((t) => t.spec.name);
    expect(names).not.toContain("memory_search");
    expect(names).not.toContain("execute");
    expect(names).not.toContain("memory_register_source");
  });

  test("native call identity reuses the exact receipt and rejects changed replay input", async () => {
    const f = await fixture();
    const first = await f.run("memory_remember", note, "call-one");
    expect(first.outcome).toBe("ok");
    expect(saved(first).id).toMatch(/^obs_[a-f0-9]{64}$/);
    expect(saved(first).producer.kind).toBe("agent");
    expect(saved(first).producer.reference).toContain("thread-one#call-one");
    const replay = await f.run("memory_remember", note, "call-one");
    expect(replay).toEqual(first);
    const conflict = await f.run(
      "memory_remember",
      { ...note, payload: { take: "C" } },
      "call-one",
    );
    expect(conflict.result).toEqual({
      error: { code: "idempotency_conflict" },
    });
    expect((await stat(memoryPath(f.stateDir, "123"))).mode & 0o777).toBe(
      0o600,
    );
  });

  test("reused provider call IDs in different native turns do not collide", async () => {
    const f = await fixture();
    const first = saved(
      await f.run(
        "memory_remember",
        note,
        "provider-call-1",
        undefined,
        undefined,
        "turn-one",
      ),
    );
    const second = saved(
      await f.run(
        "memory_remember",
        { ...note, subject: "preferences/other-clock" },
        "provider-call-1",
        undefined,
        undefined,
        "turn-two",
      ),
    );
    expect(first.id).not.toBe(second.id);
    expect(second.producer.reference).toContain("@turn-two");
  });

  test("different threads share authorized owner memory but different owners cannot read or cite it", async () => {
    const f = await fixture();
    const first = saved(await f.run("memory_remember", note, "call-one"));
    const sameOwner = await f.run(
      "memory_recall",
      { search: "clock" },
      "recall-one",
      f.binding("123", "thread-two"),
    );
    expect(
      (sameOwner.result as unknown as RecallResult).items[0].observation.id,
    ).toBe(first.id);
    const foreign = f.binding("456", "thread-two");
    expect(
      (
        await f.run(
          "memory_get",
          { observation: first.id },
          "get-foreign",
          foreign,
        )
      ).result,
    ).toBeNull();
    expect(
      (
        await f.run(
          "memory_recall",
          { search: "clock" },
          "recall-foreign",
          foreign,
        )
      ).result,
    ).toMatchObject({ items: [] });
    expect(
      (
        await f.run(
          "memory_remember",
          { ...note, supports: [first.id] },
          "cite-foreign",
          foreign,
        )
      ).result,
    ).toEqual({ error: { code: "evidence_unavailable" } });
    expect(memoryPath(f.stateDir, "123")).not.toBe(
      memoryPath(f.stateDir, "456"),
    );
  });

  test("scope/path/provenance injection and credential-shaped memory are rejected", async () => {
    const f = await fixture();
    for (const field of ["scope", "path", "producer", "source", "command"]) {
      expect(
        (
          await f.run(
            "memory_remember",
            { ...note, [field]: "untrusted" },
            `bad-${field}`,
          )
        ).result,
      ).toEqual({ error: { code: "invalid_input" } });
    }
    expect(
      (
        await f.run(
          "memory_recall",
          { search: "clock", scope: "aiko:456" },
          "foreign-scope",
        )
      ).outcome,
    ).toBe("error");
    for (const payload of [
      { password: "do-not-save" },
      { text: "fixture-private-key-123456" },
    ]) {
      expect(
        (await f.run("memory_remember", { ...note, payload }, "credential"))
          .result,
      ).toEqual({ error: { code: "sensitive_material" } });
    }
    expect(
      (await f.run("memory_recall", {}, "check-empty")).result,
    ).toMatchObject({ items: [] });
  });

  test("correction is conditional, historical bytes stay pinned, and forgetting suppresses derived evidence", async () => {
    const f = await fixture();
    const first = saved(await f.run("memory_remember", note, "write1"));
    const derived = saved(
      await f.run(
        "memory_remember",
        {
          subject: "decisions/summary",
          type: "summary",
          title: "Clock summary",
          payload: { chosen: "B" },
          supports: [first.id],
          dependsOn: [first.id],
        },
        "summary1",
      ),
    );
    const second = saved(
      await f.run(
        "memory_remember",
        { ...note, payload: { take: "C" }, supersedes: first.id },
        "write2",
      ),
    );
    expect(
      (await f.run("memory_get", { observation: first.id }, "get1")).result,
    ).toMatchObject({
      observation: { payload: { take: "B", timezone: "UTC" } },
    });
    expect(
      (await f.run("memory_get", { observation: derived.id }, "get2")).result,
    ).toMatchObject({ freshness: "stale" });
    expect(
      (
        await f.run(
          "memory_remember",
          { ...note, supersedes: first.id },
          "race",
        )
      ).result,
    ).toEqual({ error: { code: "head_conflict" } });
    expect(
      (await f.run("memory_history", { subject: note.subject }, "history"))
        .result,
    ).toHaveLength(2);
    const forgotten = await f.run(
      "memory_forget",
      { subject: note.subject, expected: second.id },
      "forget",
    );
    expect(forgotten.result).toMatchObject({ forgotten: true, erased: false });
    expect(forgotten.text).toContain("does not erase");
    expect(
      (await f.run("memory_get", { observation: derived.id }, "get3")).result,
    ).toBeNull();
    expect((await f.run("memory_remember", note, "write1")).result).toEqual({
      error: { code: "forgotten" },
    });
  });

  test("native selective erasure uses scan preconditions and replays its receipt without deleting unrelated memory", async () => {
    const f = await fixture();
    const source = saved(await f.run("memory_remember", { ...note, payload: "ERASE_NATIVE_PAYLOAD" }, "erase-source"));
    const dependent = saved(await f.run("memory_remember", { subject: "derived/erase", title: "Derived erasure marker",
      type: "summary", payload: "ERASE_NATIVE_PAYLOAD", supports: [source.id] }, "erase-dependent"));
    const kept = saved(await f.run("memory_remember", { ...note, subject: "keep/unrelated", payload: "Keep this" }, "erase-keep"));
    const linked = saved(await f.run("memory_remember", { subject: "keep/linked", title: "Independent fact with a navigation link",
      type: "fact", payload: "Independent linked fact", links: [{ subject: source.subject, relation: "see-also" }] }, "erase-linked"));
    const scan = await f.run("memory_scan", {}, "erase-scan");
    const request = { subject: source.subject, expected: source.id, expectedScopeVersion: (scan.result as any).sourceVersion };
    const erased = await f.run("memory_erase", request, "erase-native");
    expect(erased.outcome).toBe("ok");
    expect(erased.result).toMatchObject({ erased: true, retired: false, subjects: 2, observations: 2 });
    expect((erased.result as any).observationIds).toEqual([source.id, dependent.id].sort());
    const replacement = (erased.result as unknown as { replacements: { previous: string; observation: string }[] }).replacements.find(r => r.previous === linked.id);
    expect(replacement).toBeDefined();
    expect(replacement!.observation).not.toBe(linked.id);
    expect(erased.text).toContain("require separate cleanup");
    const memory = openMemory(f.binding());
    try {
      expect(memory.get(source.id)).toBeNull();
      expect(memory.get(dependent.id)).toBeNull();
      expect(memory.get(kept.id)?.state).toBe("current");
      expect(memory.get(linked.id)).toBeNull();
      expect(memory.get(replacement!.observation)?.observation.payload).toBe("Independent linked fact");
      expect(memory.get(replacement!.observation)?.observation.links).toEqual([]);
      expect(JSON.stringify(memory.exportArchive())).not.toContain("ERASE_NATIVE_PAYLOAD");
      memory.rebuild();
      expect(memory.get(source.id)).toBeNull();
      expect(memory.get(replacement!.observation)?.observation.payload).toBe("Independent linked fact");
    } finally { memory.close(); }
    // Reopen through ordinary tools, then replay the original erasure after another write.
    await f.run("memory_remember", { ...note, subject: "keep/later" }, "erase-later");
    const replay = await f.run<MemoryReceipt>("memory_erase", request, "erase-native");
    expect(replay).toEqual(erased);
    expect((await f.run("memory_erase", { ...request, subject: kept.subject }, "erase-native")).outcome).toBe("error");
    expect((await f.run("memory_remember", { ...note, payload: "ERASE_NATIVE_PAYLOAD" }, "erase-source")).outcome).toBe("error");
    expect((await f.run("memory_get", { observation: kept.id }, "erase-kept-read")).result).not.toBeNull();
    expect(f.reads).toBe(0);
  });

  test("native erasure rejects changed scope, wrong head, missing version and foreign targets", async () => {
    const f = await fixture();
    const source = saved(await f.run("memory_remember", note, "erase-race-source"));
    const scan = await f.run("memory_scan", {}, "erase-race-scan");
    const request = { subject: source.subject, expected: source.id, expectedScopeVersion: (scan.result as any).sourceVersion };
    const kept = saved(await f.run("memory_remember", { ...note, subject: "unrelated/race" }, "erase-race-write"));
    expect((await f.run("memory_erase", request, "erase-race")).result).toEqual({ error: { code: "scope_conflict" } });
    const fresh = await f.run("memory_scan", {}, "erase-race-rescan");
    const next = { ...request, expectedScopeVersion: (fresh.result as any).sourceVersion };
    expect((await f.run("memory_erase", { ...next, expected: kept.id }, "erase-wrong-head")).result).toEqual({ error: { code: "head_conflict" } });
    expect((await f.run("memory_erase", { subject: source.subject, expected: source.id }, "erase-no-version")).outcome).toBe("error");
    expect((await f.run("memory_erase", next, "erase-foreign", f.binding("456"))).outcome).toBe("error");
    const cancelled = new AbortController(); cancelled.abort();
    expect((await f.run("memory_erase", next, "erase-cancelled", f.binding(), cancelled.signal)).outcome).toBe("error");
    const memory = openMemory(f.binding());
    try {
      expect(memory.get(source.id)?.state).toBe("current");
      expect(memory.get(kept.id)?.state).toBe("current");
      expect(memory.journal.scopeVersion(memory.scope)).toBe(next.expectedScopeVersion);
    } finally { memory.close(); }
    expect(memoryTools(f.binding()).find(t => t.spec.name === "memory_erase")!.speculativeRead).toBe(false);
  });

  test("recall reports actual byte-limit coverage and never executes a source", async () => {
    const f = await fixture();
    await f.run(
      "memory_remember",
      { ...note, payload: { text: "x".repeat(2000) } },
      "big1",
    );
    const result = (
      await f.run("memory_recall", { search: "clock", maxBytes: 600 }, "small")
    ).result as unknown as RecallResult;
    expect(result.coverage).toBe("partial");
    expect(result.reasons).toContain("byte_budget");
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(600);
    expect(f.reads).toBe(0);
    expect(
      (await f.run("memory_recall", { maxBytes: 200_000 }, "oversized"))
        .outcome,
    ).toBe("error");
  });

  test("explicit fixture source reads cite real observations; disabled sources stay disabled", async () => {
    const f = await fixture();
    const read = await f.run<ReadReceipt>("demo_issues_list", {}, "issues1");
    expect(read.observations).toHaveLength(2);
    expect(read.text).toContain(read.observations![0].id);
    expect(await f.run<ReadReceipt>("demo_issues_list", {}, "issues1")).toEqual(
      read,
    );
    const memory = openMemory(f.binding());
    try {
      const source = memory.sources().find((s) => s.id === "demo.issues.list")!;
      memory.approveSource(
        source.id,
        source.revision,
        false,
        "operator-disable",
      );
    } finally {
      memory.close();
    }
    expect((await f.run("demo_issues_list", {}, "issues2")).result).toEqual({
      error: { code: "source_disabled" },
    });
    expect(
      (await f.run("memory_sources", {}, "source-list")).result,
    ).toMatchObject({ sources: [{ id: "demo.issues.list", enabled: false }] });
  });

  test("the actual log-source adapter imports bounded metadata without replay or transcript copying", async () => {
    const f = await fixture();
    let reads = 0;
    const marker = join(f.stateDir, "must-not-exist");
    const read = await f.run<ReadReceipt>(
      "demo_issues_list",
      {},
      "linked-issues",
    );
    const bound = {
      ...f.binding(),
      readPage: async (after: number, limit: number) => {
        reads++;
        return Array.from({ length: limit }, (_, index) => ({
          seq: after + index + 1,
          event:
            index === 0
              ? event("ToolReturned", { result: read, at: 1 })
              : event("ToolCalled", {
                  callId: `old-${index}`,
                  name: "execute",
                  arguments: {
                    command: `touch ${marker}`,
                    password: "private-history-do-not-copy",
                  },
                  at: 1,
                }),
        }));
      },
    };
    const refresh = await f.run("memory_refresh_logs", {}, "log-read", bound);
    expect(refresh.result).toMatchObject({
      error: null,
      coverage: { complete: false, reasons: ["event_limit"], nextAfter: 25 },
    });
    expect(reads).toBe(1);
    const recalled = await f.run(
      "memory_recall",
      { search: "ToolCalled", limit: 2 },
      "log-recall",
      bound,
    );
    expect(
      (recalled.result as unknown as RecallResult).items.length,
    ).toBeGreaterThan(0);
    expect(JSON.stringify(recalled)).not.toContain("private-history");
    expect(JSON.stringify(recalled)).not.toContain("touch");
    expect(existsSync(marker)).toBe(false);
    const linked = await f.run(
      "memory_recall",
      { search: "ToolReturned", depth: 1, maxBytes: 12000 },
      "linked-recall",
      bound,
    );
    expect(
      (linked.result as unknown as RecallResult).items.map(
        (hit) => hit.observation.id,
      ),
    ).toContain(read.observations![0].id);
    await f.run("memory_refresh_logs", {}, "log-read", bound);
    expect(reads).toBe(1); // persisted source outcome, not a repeat read
  });

  test("unsafe memory files and already-cancelled work fail closed", async () => {
    const f = await fixture();
    const binding = f.binding();
    const memory = openMemory(binding);
    memory.close();
    const target = join(f.stateDir, "elsewhere");
    await writeFile(target, "not-a-database", { mode: 0o600 });
    await rm(memoryPath(f.stateDir, binding.owner));
    await symlink(target, memoryPath(f.stateDir, binding.owner));
    expect((await f.run("memory_recall", {}, "bad-file")).result).toEqual({
      error: { code: "unsafe_store" },
    });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(
      (
        await f.run(
          "memory_remember",
          note,
          "cancelled",
          binding,
          cancelled.signal,
        )
      ).outcome,
    ).toBe("error");
  });

  test("real durable Tardie host recovers a memory commit before ToolReturned acknowledgement", async () => {
    const f = await fixture();
    const database = join(f.stateDir, "actor.sqlite");
    const bound = f.binding("123", "conversation");
    const inference = Layer.succeed(Infer, {
      resolve: () => ({ model: { provider: "fixture", model_id: "memory" } }),
      react: (request) =>
        Effect.succeed(
          request.trajectory.some((e) => e.type === "ToolReturned")
            ? { kind: "complete" as const, output: "Memory returned" }
            : {
                kind: "call" as const,
                callId: "durable-write",
                name: "memory_remember",
                arguments: note,
              },
        ),
    });
    const crashing = actor({
      name: "aiko",
      methods: { message: agentMessageMethod },
      components: [
        infer([
          system("Use memory"),
          tool(memoryTools(bound)),
          outputValidateOnce,
        ]),
      ],
    });
    let host = await createBunHost({
      database,
      actorName: "aiko",
      actorInstance: "test",
      actorFor: () => crashing,
      layersFor: () => inference,
      // Fail the durable acknowledgement boundary after memory committed.
      // A tool defect is an ordinary captured tool error, not process loss.
      canAppend: (_thread, events) => {
        if (events.some(event => event.type === "ToolReturned"))
          throw new Error("simulated process loss after memory commit");
        return true;
      },
    });
    cleanup.push(() => host.close());
    await host.commitRoot(
      host.self("conversation"),
      event("MessageReceived", {
        id: "remember-one",
        text: "Remember the clock",
      }),
    );
    await expect(host.drive()).rejects.toThrow();
    const before = openMemory(bound);
    let original: Observation;
    try {
      original = before.recall({ subject: note.subject }).items[0].observation;
    } finally {
      before.close();
    }
    expect(
      (await host.read("conversation")).filter(
        (e) => e.type === "ToolReturned",
      ),
    ).toHaveLength(0);
    await host.close();
    const stable = createAikoActor({
      owner: "123",
      memory: bound,
      voice: createVoice({ enabled: false, persona: "fixture" }),
    });
    host = await createBunHost({
      database,
      actorName: "aiko",
      actorInstance: "test",
      actorFor: () => stable,
      layersFor: () => inference,
    });
    await host.recover();
    const log = (await host.read("conversation")) as AikoEvent[];
    expect(log.filter((e) => e.type === "ToolReturned")).toHaveLength(1);
    expect(
      saved(log.find((e) => e.type === "ToolReturned")!.result as MemoryReceipt)
        .id,
    ).toBe(original!.id);
    const after = openMemory(bound);
    try {
      expect(after.history(note.subject)).toHaveLength(1);
    } finally {
      after.close();
    }
  });
});
