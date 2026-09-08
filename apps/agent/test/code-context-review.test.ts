import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { Infer, type InferRequest } from "tardie";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { codeResultCustody } from "../src/code-result-custody.ts";
import { codeInferenceSource, withCodeInferenceSources } from "../src/code-context-custody.ts";
import type { Event } from "tardie/core/event";

test("a legacy checkpoint without inference-source custody cannot restore opaque project guidance", async () => {
  const db = new Database(":memory:");
  try {
    const rows: Event[] = [], blobs = harnessBlobStore(sqliteWorkflowKV(db));
    const harness = new CodeHarness("ownerA", "user-ownerA", runCodeSegment, text => text, undefined, codeResultCustody({
      owner: "ownerA", thread: "user-ownerA", blobs, read: async () => rows, current: () => true, currentData: () => true, tools: () => [],
    }));
    harness.package([]);
    const seen: InferRequest[] = [];
    const layer = harness.inference(Layer.succeed(Infer, { react: request => Effect.sync(() => { seen.push(request); return { kind: "complete" as const, output: "ok" }; }) }));
    const checkpoint = { kind: "aiko-code-compaction.v1", owner: "ownerA", thread: "user-ownerA", sources: [], providerState: { opaque: "PRIVATE_PRE_CUSTODY_PROJECT_GUIDANCE" } };
    await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Infer).react({ identity: { actor: "aiko", instance: "fixture", thread: "user-ownerA", turn: "new" },
      system: "Current project grant was removed", tools: [], trajectory: [{ type: "CompactionCompleted", turn: "old", providerState: checkpoint }] }, "new-key"); }).pipe(Effect.provide(layer)));
    expect(JSON.stringify(seen)).not.toContain("PRIVATE_PRE_CUSTODY_PROJECT_GUIDANCE");
  } finally { db.close(); }
});

test("current project source stamps require the exact native preparation key before model inference", async () => {
  const db = new Database(":memory:");
  try {
    const spec = { name: "project_context_manifest", description: "Granted fixture", inputSchema: { type: "object", properties: { repository: { type: "string" } }, required: ["repository"], additionalProperties: false } };
    const source = codeInferenceSource(spec, { repository: "repo" });
    const rows: Event[] = [{ type: "AikoProjectContextPrepared", owner: "ownerA", thread: "user-ownerA", turn: "turn", key: "other-key", source }];
    const harness = new CodeHarness("ownerA", "user-ownerA", runCodeSegment, text => text, undefined, codeResultCustody({
      owner: "ownerA", thread: "user-ownerA", blobs: harnessBlobStore(sqliteWorkflowKV(db)), read: async () => rows, current: () => true, currentData: () => true, tools: () => [spec],
    }));
    harness.package([{ spec, authorizeRetained: async () => true, run: () => Effect.succeed({}) }]);
    let calls = 0;
    const layer = harness.inference(Layer.succeed(Infer, { react: () => Effect.sync(() => { calls++; return { kind: "complete" as const, output: "ok" }; }) }));
    const request = withCodeInferenceSources({ identity: { actor: "aiko", instance: "fixture", thread: "user-ownerA", turn: "turn" }, system: "Private project guidance", tools: [], trajectory: [] }, [source]);
    const denied = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Infer).react(request, "actual-key"); }).pipe(Effect.provide(layer)));
    expect(denied).toMatchObject({ kind: "fail", failure: { policy: { source: "context_authority_changed" } } }); expect(calls).toBe(0);
    rows.push({ ...rows[0]!, key: "actual-key" });
    expect(await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Infer).react(request, "actual-key"); }).pipe(Effect.provide(layer)))).toMatchObject({ kind: "complete" });
    expect(calls).toBe(1);
  } finally { db.close(); }
});

test("revoking a project source during inference discards the action but retains measured token usage", async () => {
  const db = new Database(":memory:");
  try {
    let active = true;
    const spec = { name: "project_context_manifest", description: "Granted fixture", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
    const source = codeInferenceSource(spec, {}), usage = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };
    const rows: Event[] = [{ type: "AikoProjectContextPrepared", owner: "ownerA", thread: "user-ownerA", turn: "turn", key: "attempt", source }];
    const harness = new CodeHarness("ownerA", "user-ownerA", runCodeSegment, text => text, undefined, codeResultCustody({
      owner: "ownerA", thread: "user-ownerA", blobs: harnessBlobStore(sqliteWorkflowKV(db)), read: async () => rows, current: () => true, currentData: () => true, tools: () => [spec],
    }));
    harness.package([{ spec, authorizeRetained: async () => active, run: () => Effect.succeed({}) }]);
    const layer = harness.inference(Layer.succeed(Infer, { react: () => Effect.sync(() => { active = false; return { kind: "complete" as const, output: "Must be discarded", usage }; }) }));
    const request = withCodeInferenceSources({ identity: { actor: "aiko", instance: "fixture", thread: "user-ownerA", turn: "turn" }, system: "Private project guidance", tools: [], trajectory: [] }, [source]);
    const result = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Infer).react(request, "attempt"); }).pipe(Effect.provide(layer)));
    expect(result).toMatchObject({ kind: "fail", usage }); expect(result).not.toHaveProperty("output");
  } finally { db.close(); }
});
