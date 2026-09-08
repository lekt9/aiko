import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce, type InferRequest } from "tardie";
import type { Event } from "tardie/core/event";
import { modelRequest } from "tardie/inference/request";
import { CodeHarness } from "../src/code-harness.ts";
import { codeInferenceSource, withCodeInferenceSources } from "../src/code-context-custody.ts";
import { codeResultCustody } from "../src/code-result-custody.ts";
import { ProjectContext } from "../src/project-instructions.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function database() { const db = new Database(":memory:"); databases.push(db); return db; }
function storage(): AccountStorage {
  const db = database(); let alarm: number | null = null;
  return { sql: { exec: (q, ...args) => { const rows=db.query(q).all(...args as any); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
}
const owner = "123", thread = "user-123", marker = "PRIVATE_REPOSITORY_GUIDANCE_726";
const model = { provider: "fixture", model_id: "project" };
const identity = { actor: "aiko", instance: "project", thread, turn: "compact" };
const invoke = <A>(layer: Layer.Layer<Infer>, run: (service: typeof Infer.Service) => Effect.Effect<A>) =>
  Effect.runPromise(Effect.gen(function* () { return yield* run(yield* Infer); }).pipe(Effect.provide(layer)));

test("native automatic project context survives chained/cold compaction and loses opaque state when its source changes", async () => {
  const state = storage(), kv = sqliteWorkflowKV(database());
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>>, active = true, grant = true;
  const project = () => new ProjectContext({ owner, thread, redact: text => text, sourceRevision: "repo-v1",
    authorizeRetained: async () => active, source: { list: async () => [], read: async path => path === "AGENTS.md" ? marker : undefined } });
  const fresh = (context = project()) => {
    const native = context.tools();
    const harness = new CodeHarness(owner, thread, runCodeSegment, text => text, undefined,
      codeResultCustody({ owner, thread, blobs: harnessBlobStore(kv), read: () => host.read(thread), current: () => grant, currentData: () => grant, tools: () => native.map(tool => tool.spec) }));
    harness.package(native); return { harness, context, native };
  };
  const initial = fresh();
  let delivered = 0;
  const base = Layer.succeed(Infer, { resolve: () => ({ model }), react: (request: InferRequest) => Effect.sync(() => {
    expect(request.system).toContain(marker); delivered++; return { kind: "complete" as const, output: "Ready" };
  }) });
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([codeMode([initial.harness.package(initial.native)]), outputValidateOnce])] });
  host = await createCloudflareAccountHost({ storage: state, actorName: "aiko", actorInstance: "project", ownsThread: value => value === thread,
    actorFor: () => definition, layersFor: () => Layer.merge(initial.context.inference(initial.harness.inference(base)), initial.harness.sandboxLayer()) });
  try {
    await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "read", text: "Read project", at: 1 });
    await host.drive();
    const trajectory = await host.read(thread);
    expect(delivered).toBe(1);
    expect(trajectory.find(event => event.type === "AikoProjectContextPrepared")).toMatchObject({ owner, thread, turn: "read", source: { tool: "project_context_manifest", arguments: {} } });
    expect(JSON.stringify(trajectory)).not.toContain(marker);
    let compacted = 0;
    const seen: any[] = [];
    const provider = Layer.succeed(Infer, { resolve: () => ({ model }), compact: () => Effect.sync(() => ({ state: { opaque: "private-provider-window", generation: ++compacted } })),
      react: (request: InferRequest) => Effect.sync(() => { seen.push(modelRequest(request.trajectory, { ...request, model })); return { kind: "complete" as const, output: "Continue" }; }) });
    const request = { identity, trajectory, model, system: "", tools: [] };
    const first = await invoke(initial.harness.inference(provider), service => service.compact!(request));
    expect(first?.state).toMatchObject({ inferenceSources: [{ tool: "project_context_manifest", arguments: {} }] });
    const chained = await invoke(initial.harness.inference(provider), service => service.compact!({ ...request, trajectory: [], previous: first!.state }));
    expect(chained?.state).toMatchObject({ inferenceSources: [{ tool: "project_context_manifest" }] });
    const checkpoint = { type: "CompactionCompleted", keepFrom: "m:next", summary: "", providerState: chained!.state, model, at: 3 };
    const reactRequest = { ...request, identity: { ...identity, turn: "next" }, trajectory: [...trajectory, checkpoint, { type: "MessageReceived", id: "next", text: "Continue", at: 4 }] };
    const reopened = fresh();
    await invoke(reopened.harness.inference(provider), service => service.react(reactRequest));
    expect(seen.at(-1).providerState).toEqual({ opaque: "private-provider-window", generation: 2 });
    active = false;
    await invoke(reopened.harness.inference(provider), service => service.react(reactRequest));
    expect(seen.at(-1).providerState).toBeUndefined();
    expect(await invoke(reopened.harness.inference(provider), service => service.compact!({ ...request, previous: chained!.state }))).toBeUndefined();
    expect(compacted).toBe(2);
    active = true; grant = false;
    await invoke(reopened.harness.inference(provider), service => service.react(reactRequest));
    expect(seen.at(-1).providerState).toBeUndefined();
    grant = true;
    const changed = fresh(new ProjectContext({ ...project().options, sourceRevision: "repo-v2" }));
    await invoke(changed.harness.inference(provider), service => service.react(reactRequest));
    expect(seen.at(-1).providerState).toBeUndefined();
    expect(JSON.stringify(chained!.state)).not.toContain(marker);
  } finally { await host.close(); }
});

test("automatic guidance requires its exact native receipt and discards an action or checkpoint if authority changes during inference", async () => {
  const kv = sqliteWorkflowKV(database()); let active = true, delivered = 0;
  const context = new ProjectContext({ owner, thread, redact: text => text, sourceRevision: "repo-v1", authorizeRetained: async () => active,
    source: { list: async () => [], read: async () => undefined } });
  const native = context.tools(), source = codeInferenceSource(native[0]!.spec, {});
  const rows: Event[] = [{ type: "AikoProjectContextPrepared", owner, thread, turn: "compact", key: "attempt", source }];
  const harness = new CodeHarness(owner, thread, runCodeSegment, text => text, undefined,
    codeResultCustody({ owner, thread, blobs: harnessBlobStore(kv), read: async () => rows, current: () => true, currentData: () => true, tools: () => native.map(tool => tool.spec) }));
  harness.package(native);
  const provider = Layer.succeed(Infer, { resolve: () => ({ model }), react: () => Effect.sync(() => {
    delivered++; active = false; return { kind: "call" as const, callId: "must-not-dispatch", name: "execute", arguments: { code: "return 1" } };
  }), compact: () => Effect.sync(() => { delivered++; active = false; return { state: { opaque: "revoked" } }; }) });
  const layer = harness.inference(provider);
  const request = withCodeInferenceSources({ identity, trajectory: [], model, system: marker, tools: [] }, [source]);
  expect(await invoke(layer, service => service.react(request, "wrong-attempt"))).toMatchObject({ kind: "fail" });
  expect(delivered).toBe(0);
  expect(await invoke(layer, service => service.react(request, "attempt"))).toMatchObject({ kind: "fail", failure: { policy: { source: "context_authority_changed" } } });
  expect(delivered).toBe(1);
  active = true;
  expect(await invoke(layer, service => service.compact!(request, "attempt"))).toBeUndefined();
  expect(delivered).toBe(2);
  active = true; rows.splice(0);
  expect(await invoke(layer, service => service.react(request, "attempt"))).toMatchObject({ kind: "fail" });
  expect(delivered).toBe(2);
});
