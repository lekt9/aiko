import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryComponent, harnessLibraryTools, type HarnessLibraryBinding, type HarnessArtifact } from "../src/harness-library.ts";
import { builtinHarnessDefinitions } from "../src/harness-builtins.ts";
import { HarnessAcquisition, harnessAcquisitionTools, harnessAcquisitionTask } from "../src/harness-acquisition.ts";
import { createHarnessSandboxBinding, type HarnessSandboxAuthority } from "../src/harness-sandbox.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { harnessSkillDeriver, harnessSkillForwarder } from "../src/harness-skill.ts";
import { proactiveAcquisitionOutcome, currentProactiveOutcome, proactiveOutcomeAvailable, proactiveAppendAllowed } from "../src/proactive-policy.ts";
import { foregroundHooks, createIndexerActor, createReflectionActor } from "../src/background.ts";
import { voiceAndOutbox } from "../src/actor.ts";
import type { MemoryBinding } from "../src/memory.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const signal = () => AbortSignal.timeout(15000);
async function fixture(notifications = false) {
  const directory = await mkdtemp("/tmp/harness-acquisition-"), privateDb = new Database(join(directory, "private.sqlite"));
  cleanups.push(async () => { privateDb.close(); await rm(directory, { recursive: true, force: true }); });
  const definitions = builtinHarnessDefinitions();
  const runtimeDigest = await sandboxEnvironment("acquisition-fixture-v1");
  const authority: HarnessSandboxAuthority = { owner: "123", active: true, runtimeDigest, contextRef: "compute-v1", authorityRef: "pure-v1", sessionRevision: null, effects: ["read"], origins: [], methods: [], budget: { wallMs: 5000, requests: 0, outputBytes: 131072 } };
  const sandbox = localHarnessSandbox({ owner: "123", environmentDigest: runtimeDigest, journal: await sandboxJobJournal(privateDb, join(directory, "job-key")) });
  let jobs = 0, models = 0, environmentReads = 0, reflections = 0;
  const deliveries: string[] = [];
  let beforeNotice: (() => void) | undefined;
  const receipts: any[] = [];
  const binding: HarnessLibraryBinding = {
    owner: "123", thread: "user-123", blobs: harnessBlobStore(sqliteWorkflowKV(privateDb)),
    verifiers: new Map(definitions.map(d => [d.verifier.digest, d.verifier])), guard: () => {},
    ...createHarnessSandboxBinding({ owner: "123", thread: "user-123", placement: "local", current: async () => authority,
      sandbox: { harnessEnvironment: async s => { environmentReads++; return sandbox.harnessEnvironment(s); }, harnessJob: async (job, s) => { jobs++; const receipt = await sandbox.harnessJob(job, s); receipts.push(receipt); return receipt; } },
    }),
  };
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>, db!: Database, program = "return 'unset';";
  const journal = { read: () => host.read(binding.thread), append: async (events: Event[]) => { for (const event of events) await host.commitRoot(host.self(binding.thread), event); } };
  const open = async () => {
    db = new Database(join(directory, "native.sqlite"));
    const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
    const harness = new CodeHarness("123", binding.thread, runCodeSegment, s => s);
    const memory = (thread: string): MemoryBinding => ({ stateDir: directory, owner: "123", thread, redact: s => s,
      readPage: (after, limit) => host.readPage(thread, after, limit),
      readSourcePage: (source, after, limit) => {
        if (source.actor !== "aiko" || source.instance !== "acquisition-test" || ![binding.thread, "background-123-indexer", "background-123-reflection"].includes(source.thread))
          throw Error("Source binding unavailable");
        return host.readPage(source.thread, after, limit);
      },
    });
    const hooks = foregroundHooks(memory(binding.thread), binding);
    const foreground = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [harnessLibraryComponent("123"), harnessSkillForwarder(binding),
      ...(notifications ? [{ ...hooks, keys: { prefixes: ["aiko-background:", "aiko-proactive:"], keyOf: (e: Event) => { const key = hooks.keys?.keyOf(e); return key?.startsWith("aiko-harness:") ? undefined : key; } } },
        voiceAndOutbox("123", input => Effect.sync(() => {
          if (input.kind === "task" && input.receipt.startsWith("Capability verified")) beforeNotice?.();
          return { text: input.kind === "task" ? input.receipt : "Task complete", source: "template" as const };
        }),
          async (_chat, text) => { deliveries.push(text); return { status: "delivered" }; }, { live: true, redact: s => s, memory: memory(binding.thread), library: binding })] : []),
      infer([codeMode([harness.package([...harnessLibraryTools(binding), ...harnessAcquisitionTools(binding)])]), outputValidateOnce])] });
    const background = notifications ? createIndexerActor(memory("background-123-indexer"), undefined, binding)
      : actor({ name: "aiko", methods: {}, components: [harnessSkillDeriver(binding)] });
    const reflection = createReflectionActor(memory("background-123-reflection"));
    const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "acquisition" } }), react: (request: any) => {
      models++;
      if (request.identity.thread === "background-123-reflection") {
        reflections++;
        const message = request.trajectory.findLast((e: Event) => e.type === "MessageReceived" && e.source === "background");
        const input = JSON.parse(message.text);
        return Effect.succeed({ kind: "complete" as const, output: JSON.stringify({ decision: "notify", reason: "Requested capability is verified", text: "Capability verified for your task.", supports: input.changed.map((c: any) => c.observation).slice(0, 1) }), mode: { kind: "local", name: "validate-once" } });
      }
      const returned = request.trajectory.findLast((e: Event) => e.type === "ToolReturned" && e.turn === request.identity.turn);
      if (!returned) return Effect.succeed({ kind: "call" as const, name: "execute", callId: `compose:${request.identity.turn}`, arguments: { code: program } });
      expect(returned.result.error).toBeUndefined();
      return Effect.succeed({ kind: "complete" as const, output: "Acquisition task settled" });
    } });
    host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "acquisition-test", ownsThread: t => [binding.thread, "background-123-indexer", "background-123-reflection"].includes(t),
      actorFor: t => t === binding.thread ? foreground : t === "background-123-indexer" ? background : reflection,
      layersFor: thread => thread === binding.thread ? Layer.merge(harness.inference(model), harness.sandboxLayer()) : model,
      ...(notifications ? { canAppend: (thread: string, events: readonly Event[], read: () => readonly Event[]) => proactiveAppendAllowed(events, read, thread) } : {}) });
  };
  await open(); cleanups.push(async () => { await host.close(); db.close(); });
  return { binding, authority, definitions, receipts, journal,
    library: new HarnessLibrary(binding, journal), acquisition: new HarnessAcquisition(binding, journal),
    counts: () => ({ jobs, models, environmentReads }), notificationCounts: () => ({ reflections, notices: deliveries.filter(t => t.startsWith("Capability verified")).length }),
    events: () => host.read(binding.thread),
    backgroundEvents: () => host.read("background-123-indexer"), reflectionEvents: () => host.read("background-123-reflection"),
    beforeNotice: (fn: () => void) => { beforeNotice = fn; },
    async task(code: string, id: string) { program = code;
      if (notifications) await host.commitRoot(host.self(binding.thread), { type: "AikoHooksActivated", id: "background-v1", at: Date.now() });
      await host.commitRoot(host.self(binding.thread), { type: "MessageReceived", id, text: "Use the requested capability", ...(notifications ? { source: "telegram", chat: "123" } : {}), at: Date.now() }); await host.drive(); },
    async restart() { await host.close(); db.close(); await open(); await host.recover(); },
    erase(hash: string) { privateDb.query("DELETE FROM workflow_records WHERE key=?").run(`harness-blobs:${harnessDigest("123")}:${hash}`); },
  };
}

test("native actor acquires a generated candidate, executes fresh inputs, derives SKILL and reuses after disk restart", async () => {
  const f = await fixture();
  expect((await f.acquisition.catalog()).capabilities).toHaveLength(4);
  expect(f.counts()).toEqual({ jobs: 0, models: 0, environmentReads: 0 });
  const candidate = structuredClone(f.definitions.find(d => d.artifact.name === "text.chunk")!.artifact);
  const code = "const out = []; let part = ''; let count = 0; for (const char of input.text) { part += char; if (++count === input.maxCharacters) { out.push(part); part = ''; count = 0; } } if (part) out.push(part); return out;";
  candidate.files["main.js"] = code;
  candidate.sources = [{ uri: "fixture:actor-derived-chunker", revision: "1", digest: harnessDigest(code), license: "fixture" }];
  const digest = harnessDigest(candidate);
  await f.task(`const acquired = await tools.call({name:'harness_acquire', arguments:{name:'text.chunk', operationId:'first-acquisition', candidate:${JSON.stringify(candidate)}}}); if (acquired.status !== 'ready') throw Error('acquisition failed'); const result = await tools.call({name:'harness_run',arguments:{digest:acquired.harnessDigest,input:{text:'secret-voice-731 🎧',maxCharacters:3},operationId:'first-message'}}); return {status:result.status};`, "first");
  expect((await f.events()).find(e => e.type === "AikoHarnessAcquisitionSettled")?.status).toBe("verified");
  expect((await f.events()).find(e => e.type === "AikoHarnessAcquisitionRequested")?.task).toMatchObject({ version: 1, thread: "user-123", turn: "first", callId: expect.any(String) });
  const outcome = proactiveAcquisitionOutcome(await f.events(), "123", "first-acquisition");
  expect(outcome).toMatchObject({ kind: "harness-acquisition", operationId: "first-acquisition", task: { turn: "first" } });
  expect(proactiveAcquisitionOutcome(await f.events(), "456", "first-acquisition")).toBeUndefined();
  expect(currentProactiveOutcome(await f.events(), "123", { ...outcome, task: { ...outcome!.task, turn: "unrelated" } })).toBe(false);
  expect((await f.library.output("first-message")).output).toEqual(["sec", "ret", "-vo", "ice", "-73", "1 🎧"]);
  expect(f.receipts).toHaveLength(5);
  expect(f.receipts.every(r => r.status === "completed" && r.browserStarts === 0)).toBe(true);
  const doc = await f.library.skill(digest);
  expect(doc.status).toBe("evaluated");
  expect(doc.markdown).not.toContain("secret-voice-731");
  const before = await f.events(), counts = f.counts();
  await f.restart();
  expect(await f.events()).toEqual(before);
  expect(f.counts()).toEqual(counts);
  expect((await f.library.skill(digest)).markdown).toBe(doc.markdown);
  expect(proactiveAcquisitionOutcome(await f.events(), "123", "first-acquisition")).toEqual(outcome);
  await f.task("const acquired = await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'second-acquisition'}}); if (!acquired.reused) throw Error('expected reuse'); return await tools.call({name:'harness_call',arguments:{name:'text.chunk',contractDigest:acquired.contractDigest,input:{text:'second message',maxCharacters:6},operationId:'second-message'}});", "second");
  expect((await f.library.output("second-message")).output).toEqual(["second", " messa", "ge"]);
  expect(f.counts().jobs).toBe(6);
  expect((await f.events()).filter(e => e.type === "AikoHarnessEvaluationStarted")).toHaveLength(1);
  expect(proactiveAcquisitionOutcome(await f.events(), "123", "second-acquisition")).toBeUndefined();
  const history = await f.events(), promotion = history.find(e => e.type === "AikoHarnessPromoted")!;
  expect(currentProactiveOutcome(history.filter(e => e.type !== "AikoHarnessChecked"), "123", outcome)).toBe(false);
  expect(currentProactiveOutcome([...history, { ...promotion, type: "AikoHarnessRetired", previousGeneration: promotion.generation, generation: Number(promotion.generation) + 1 }], "123", outcome)).toBe(false);
});

test("a caller cannot manufacture a task association or attach an unassociated acquisition to a new task", async () => {
  const f = await fixture();
  await expect(f.acquisition.acquire({ name: "text.chunk", operationId: "forged-task" }, signal(),
    { version: 1, thread: "user-123", turn: "not-received", callId: "not-called" })).rejects.toThrow("task unavailable");
  expect(f.counts().jobs).toBe(0);
  expect((await f.acquisition.acquire({ name: "text.chunk", operationId: "unassociated" }, signal())).status).toBe("ready");
  expect(proactiveAcquisitionOutcome(await f.events(), "123", "unassociated")).toBeUndefined();
  const before = f.counts().jobs;
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'unassociated'}});", "later-task");
  expect(f.counts().jobs).toBe(before);
  expect((await f.events()).find(e => e.type === "AikoHarnessAcquisitionRequested" && e.id === "unassociated")?.task).toBeUndefined();
});

test("native task association distinguishes epochs and an exact cancellation request invalidates readiness before terminal cancellation", async () => {
  const f = await fixture();
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'cancel-ready'}});", "cancel-ready-task");
  const rows = await f.events(), outcome = proactiveAcquisitionOutcome(rows, "123", "cancel-ready")!;
  expect(outcome).toBeDefined();
  const cancellation = { type: "CancellationRequested", request: "cancel-native-task", cause: "requested", at: Date.now(),
    invocation: { method: "message", id: outcome.task.turn, epoch: 0 } };
  expect(proactiveAcquisitionOutcome([...rows, cancellation], "123", "cancel-ready")).toBeUndefined();
  expect(proactiveAcquisitionOutcome([...rows, { ...cancellation, invocation: { ...cancellation.invocation, epoch: 1 } }], "123", "cancel-ready")).toEqual(outcome);
  expect(proactiveAcquisitionOutcome([...rows, { ...cancellation, invocation: { ...cancellation.invocation, method: "channelWait" } }], "123", "cancel-ready")).toEqual(outcome);
  const call = { turn: "reopened-task", callId: "package-epoch-2" };
  const next: Event[] = [
    { type: "MessageReceived", id: call.turn, epoch: 1, text: "Previous attempt", at: Date.now() },
    { type: "MessageReceived", id: call.turn, epoch: 2, text: "Current attempt", at: Date.now() },
    { type: "PackageCalled", ...call, epoch: 2, at: Date.now() },
    { type: "AikoCodeToolStarted", ...call, owner: "123", tool: "harness_acquire", at: Date.now() },
  ];
  expect(harnessAcquisitionTask(next, "123", "user-123", call)).toEqual({ version: 1, thread: "user-123", ...call, epoch: 2 });
  expect(harnessAcquisitionTask(next.filter(e => e.type !== "MessageReceived" || e.epoch !== 2), "123", "user-123", call)).toBeUndefined();
});

test("one native acquisition produces one task-bound capability notice while promotion and skill derivation stay silent", async () => {
  const f = await fixture(true);
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'notify-acquire'}});", "notify-task");
  expect(f.notificationCounts()).toEqual({ reflections: 1, notices: 1 });
  const foreground = await f.events(), indexer = await f.backgroundEvents(), reflection = await f.reflectionEvents();
  const outcome = proactiveAcquisitionOutcome(foreground, "123", "notify-acquire")!;
  expect(outcome).toBeDefined();
  expect(foreground.filter(e => e.type === "AikoProactiveAccepted")).toMatchObject([{ id: outcome.identity, outcome, chat: "123" }]);
  expect(indexer.some(e => e.type === "AikoKnowledgeChanged" && (e.notification as any)?.outcome?.identity === outcome.identity)).toBe(true);
  expect(reflection.filter(e => e.type === "AikoDecisionRecorded" && e.decision === "silent").length).toBeGreaterThanOrEqual(2);
  expect(foreground.filter(e => e.type === "AikoDeliverySettled" && e.turn === `proactive:${outcome.identity}`)).toMatchObject([{ result: { status: "delivered" } }]);
  const counts = f.counts(); await f.restart();
  expect(f.counts()).toEqual(counts);
  expect(f.notificationCounts()).toEqual({ reflections: 1, notices: 1 });
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'notify-reuse'}});", "reuse-task");
  expect(f.notificationCounts()).toEqual({ reflections: 1, notices: 1 });
  expect(f.counts().jobs).toBe(counts.jobs);
});

test("revoking current execution authority during notice preparation leaves verification historical and prevents dispatch", async () => {
  const f = await fixture(true);
  f.beforeNotice(() => { f.authority.active = false; });
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'revoke-notice'}});", "revoke-task");
  const rows = await f.events(), outcome = proactiveAcquisitionOutcome(rows, "123", "revoke-notice")!;
  expect(outcome).toBeDefined();
  expect(await proactiveOutcomeAvailable(rows, "123", outcome, f.binding, signal())).toBe(false);
  expect(f.notificationCounts()).toEqual({ reflections: 1, notices: 0 });
  expect(rows.filter(e => e.type === "AikoReplySuppressed")).toHaveLength(1);
  expect(rows.filter(e => e.type === "AikoProactiveDispatchAuthorized")).toHaveLength(0);
  await f.restart();
  expect(f.notificationCounts().notices).toBe(0);
});

test("retirement during the admission readiness await cannot retain a stale accepted capability notice", async () => {
  const f = await fixture(true), authorize = f.binding.authorize;
  let retired = false;
  f.binding.authorize = async (...args) => {
    const allowed = await authorize(...args), rows = await f.events();
    if (!retired && rows.some(e => e.type === "AikoProactiveDecision")) {
      retired = true;
      const promotion = rows.find(e => e.type === "AikoHarnessPromoted")!;
      await f.journal.append([{ ...promotion, type: "AikoHarnessRetired", previousGeneration: promotion.generation,
        generation: Number(promotion.generation) + 1, at: Date.now() }]);
    }
    return allowed;
  };
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'retire-during-admission'}});", "retire-admission-task");
  expect(retired).toBe(true);
  const rows = await f.events();
  expect(rows.filter(e => e.type === "AikoHarnessRetired")).toHaveLength(1);
  expect(rows.filter(e => e.type === "AikoProactiveAccepted")).toHaveLength(0);
  expect(rows.filter(e => e.type === "AikoProactiveSuppressed")).toHaveLength(1);
  expect(f.notificationCounts()).toEqual({ reflections: 1, notices: 0 });
  await f.restart();
  expect(f.notificationCounts().notices).toBe(0);
});

test("capability readiness uses the current source journal even when historical verification and the raw grant still pass", async () => {
  const f = await fixture();
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'source-ready'}});", "source-task");
  const rows = await f.events(), outcome = proactiveAcquisitionOutcome(rows, "123", "source-ready")!;
  expect(await proactiveOutcomeAvailable(rows, "123", outcome, f.binding, signal(), f.journal)).toBe(true);
  const receipt = rows.find(e => e.type === "AikoHarnessAcquisitionSettled")!;
  // A current source projection has lost the dependency head required by this artifact.
  await f.journal.append([{ type: "AikoHarnessSourceCandidateDerived", owner: "123", id: "source-dependency-lost", at: Date.now(),
    harnessDigest: receipt.harnessDigest, sourceId: "missing-current-source", dependencies: [], licenseDigest: harnessDigest("fixture-license") }]);
  expect(currentProactiveOutcome(rows, "123", outcome)).toBe(true);
  expect(await proactiveOutcomeAvailable(rows, "123", outcome, f.binding, signal())).toBe(true);
  expect(await proactiveOutcomeAvailable(rows, "123", outcome, f.binding, signal(), f.journal)).toBe(false);
  await f.restart();
  expect(await proactiveOutcomeAvailable(await f.events(), "123", outcome, f.binding, signal(), f.journal)).toBe(false);
});

test("capability readiness rejects source invalidation during the final context await despite historical verification and the raw grant", async () => {
  const f = await fixture();
  await f.task("return await tools.call({name:'harness_acquire',arguments:{name:'text.chunk',operationId:'source-final-context'}});", "source-final-context-task");
  const rows = await f.events(), outcome = proactiveAcquisitionOutcome(rows, "123", "source-final-context")!;
  const receipt = rows.find(e => e.type === "AikoHarnessAcquisitionSettled" && e.id === outcome.operationId)!;
  expect(receipt.status).toBe("verified");
  expect(await proactiveOutcomeAvailable(rows, "123", outcome, f.binding, signal(), f.journal)).toBe(true);
  const before = f.counts().jobs, contextDigests: string[] = [];
  let authorizations = 0, invalidations = 0;
  const binding: HarnessLibraryBinding = {
    ...f.binding,
    authorize: async (...args) => { authorizations++; return f.binding.authorize(...args); },
    context: async abort => {
      const context = await f.binding.context(abort);
      contextDigests.push(harnessDigest(context));
      if (contextDigests.length === 2) {
        expect(authorizations).toBe(1);
        invalidations++;
        // Keep the actual runtime context and host grant unchanged while the
        // native journal loses the source head required by this verified code.
        await f.journal.append([{ type: "AikoHarnessSourceCandidateDerived", owner: "123", id: "source-final-context-lost", at: Date.now(),
          harnessDigest: receipt.harnessDigest, sourceId: "missing-final-context-source", dependencies: [], licenseDigest: harnessDigest("fixture-license") }]);
      }
      return context;
    },
  };
  expect(await proactiveOutcomeAvailable(rows, "123", outcome, binding, signal(), f.journal)).toBe(false);
  expect(contextDigests).toEqual([String(receipt.contextDigest), String(receipt.contextDigest)]);
  expect(authorizations).toBe(1); expect(invalidations).toBe(1);
  const current = await f.events();
  expect(current.filter(e => e.type === "AikoHarnessSourceCandidateDerived" && e.id === "source-final-context-lost")).toHaveLength(1);
  expect(currentProactiveOutcome(current, "123", outcome)).toBe(true);
  expect(await proactiveOutcomeAvailable(current, "123", outcome, f.binding, signal())).toBe(true);
  expect(await proactiveOutcomeAvailable(current, "123", outcome, f.binding, signal(), f.journal)).toBe(false);
  expect(f.counts().jobs).toBe(before);
  await f.restart();
  expect(await proactiveOutcomeAvailable(await f.events(), "123", outcome, f.binding, signal(), f.journal)).toBe(false);
  expect(f.counts().jobs).toBe(before);
});

test("concurrent native tasks cannot share an acquisition operation by losing its retained task claim", async () => {
  const f = await fixture();
  const tasks = ["a", "b"].map(id => ({ version: 1 as const, thread: "user-123", turn: `task-${id}`, callId: `call-${id}` }));
  for (const task of tasks) await f.journal.append([
    { type: "MessageReceived", id: task.turn, text: "Acquire a capability", at: Date.now() },
    { type: "AikoCodeToolStarted", id: task.callId, owner: "123", turn: task.turn, callId: task.callId, tool: "harness_acquire", at: Date.now() },
  ]);
  let reads = 0, release!: () => void;
  const rendezvous = new Promise<void>(resolve => { release = resolve; });
  const journal = { ...f.journal, read: async () => {
    const rows = await f.journal.read();
    if (++reads <= 2) { if (reads === 2) release(); await rendezvous; }
    return rows;
  } };
  const results = await Promise.allSettled(tasks.map(task => new HarnessAcquisition(f.binding, journal).acquire({ name: "text.chunk", operationId: "same-acquisition" }, signal(), task)));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  const loser = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  expect(String(loser.reason)).toContain("task identity conflict");
  const rows = await f.events();
  expect(rows.filter(e => e.type === "AikoHarnessAcquisitionRequested")).toHaveLength(1);
  expect(rows.filter(e => e.type === "AikoHarnessEvaluationStarted")).toHaveLength(1);
  const outcome = proactiveAcquisitionOutcome(rows, "123", "same-acquisition")!;
  expect(outcome.task).toEqual(tasks[results.findIndex(r => r.status === "fulfilled")]);
});

test("every builtin passes its fixed semantics in the real sandbox and no evaluation answers are ordinary outputs", async () => {
  const f = await fixture();
  for (const definition of f.definitions) {
    const result = await f.acquisition.acquire({ name: definition.artifact.name, operationId: `seed:${definition.artifact.name}` }, signal());
    expect(result.status).toBe("ready");
    const evaluation = (await f.events()).find(e => e.type === "AikoHarnessEvaluated" && e.id === result.evaluationId)!;
    for (const operation of evaluation.witnessIds as string[]) await expect(f.library.output(operation)).rejects.toThrow("unavailable");
  }
});

test("larger acquisition ceilings preserve the fixed oracle and cannot renew an expired request", async () => {
  const f = await fixture(), original = f.definitions.find(d => d.artifact.name === "text.chunk")!;
  const definition = { ...original, contract: structuredClone(original.contract), artifact: structuredClone(original.artifact) };
  definition.contract.timeoutMs = 120000;
  definition.artifact.contractDigest = harnessDigest(definition.contract);
  const acquisition = new HarnessAcquisition(f.binding, f.journal, [definition]);
  // The larger policy must not make the existing fixed verifier accept a
  // changed contract; real media definitions supply their own matching oracle.
  expect((await acquisition.acquire({ name: definition.artifact.name, operationId: "larger-fixed-evaluation" }, signal())).status).toBe("failed");
  expect((await f.library.list()).active).toHaveLength(0);
  const requested = (await f.events()).find(e => e.type === "AikoHarnessAcquisitionRequested" && e.id === "larger-fixed-evaluation")!;
  expect((requested.limits as {wallMs:number}).wallMs).toBe(definition.verifier.cases.length * 120000);
  expect(Number(requested.deadlineAt)).toBeGreaterThan(Number(requested.at) + 30000);

  const other = f.definitions.find(d => d.artifact.name !== definition.artifact.name)!;
  const cancel = new AbortController();
  const journal = { ...f.journal, append: async (events: Event[]) => {
    await f.journal.append(events);
    if (events.some(e => e.type === "AikoHarnessAcquisitionRequested" && e.id === "interrupted-acquisition")) cancel.abort();
  } };
  const before = f.counts().jobs;
  await expect(new HarnessAcquisition(f.binding, journal).acquire({ name: other.artifact.name, operationId: "interrupted-acquisition" }, cancel.signal)).rejects.toThrow();
  expect(f.counts().jobs).toBe(before);
  const retained = (await f.events()).find(e => e.type === "AikoHarnessAcquisitionRequested" && e.id === "interrupted-acquisition")!;
  const now = Date.now;
  try {
    Date.now = () => Number(retained.deadlineAt) + 1;
    await expect(new HarnessAcquisition(f.binding, f.journal).acquire({ name: other.artifact.name, operationId: "interrupted-acquisition" }, signal())).rejects.toThrow("deadline expired");
  } finally { Date.now = now; }
  expect(f.counts().jobs).toBe(before);
  expect((await f.events()).filter(e => e.type === "AikoHarnessAcquisitionRequested" && e.id === "interrupted-acquisition")).toHaveLength(1);
});

test("candidate self-report, weakened contract, stale evaluator, and unknown capability cannot mint a reusable route", async () => {
  const f = await fixture(), definition = f.definitions.find(d => d.artifact.name === "text.chunk")!;
  const wrong: HarnessArtifact = { ...definition.artifact, files: { "main.js": "return ['looks plausible'];" } };
  expect((await f.acquisition.acquire({ name: wrong.name, operationId: "false-report", candidate: wrong }, signal())).status).toBe("failed");
  expect((await f.library.list()).active).toHaveLength(0);
  const altered = { ...definition.contract, outcome: "Return any nonempty array" };
  const alteredDigest = await f.library.registerContract(altered);
  const forged = await f.library.record({ ...definition.artifact, contractDigest: alteredDigest });
  expect((await f.library.evaluate(forged, "weakened", signal())).eligible).toBe(false);
  await expect(f.acquisition.acquire({ name: wrong.name, operationId: "wrong-contract", candidate: { ...wrong, contractDigest: alteredDigest } }, signal())).rejects.toThrow("fixed capability contract");
  const before = f.counts().jobs;
  expect((await f.acquisition.acquire({ name: "audio.transcribe", operationId: "missing-outcome" }, signal())).reason).toBe("trusted-outcome-contract-unavailable");
  expect(f.counts().jobs).toBe(before);
  definition.verifier.cases[0]!.input = { text: "changed", maxCharacters: 2 };
  await expect(f.acquisition.acquire({ name: wrong.name, operationId: "changed-cases" }, signal())).rejects.toThrow("evaluator unavailable");
});

test("builtin checkers reject split Unicode pairs and inputs below media timestamp precision", async () => {
  const f = await fixture(), text = f.definitions.find(d => d.artifact.name === "text.chunk")!;
  const broken = await text.verifier.verify({ contract: text.contract, artifactDigest: harnessDigest(text.artifact), input: { text: "🎧", maxCharacters: 1 }, output: ["\ud83c", "\udfa7"] }, signal());
  expect(broken.passed).toBe(false);
  const good = await text.verifier.verify({ contract: text.contract, artifactDigest: harnessDigest(text.artifact), input: { text: "🎧", maxCharacters: 1 }, output: ["🎧"] }, signal());
  expect(good.passed).toBe(true);
  const media = await f.acquisition.acquire({ name: "media.sample_times", operationId: "media" }, signal());
  expect(media.status).toBe("ready");
  const jobs = f.counts().jobs;
  const witness = await f.library.run(media.harnessDigest as any, { durationSeconds: Number.MIN_VALUE, count: 2 }, "underflow", signal());
  expect(witness.status).toBe("blocked");
  expect(f.counts().jobs).toBe(jobs);
});

test("concurrent acquisitions share fixed evaluation, retain independent receipts and preserve operation identity", async () => {
  const f = await fixture();
  const acquired = await Promise.all(["first", "second"].map(operationId => f.acquisition.acquire({ name: "json.project", operationId }, signal())));
  expect(acquired.some(r => r.status === "ready")).toBe(true);
  expect(f.counts().jobs).toBe(4);
  expect((await f.acquisition.acquire({ name: "json.project", operationId: "second" }, signal())).status).toBe("ready");
  const candidate = structuredClone(f.definitions[0]!.artifact); candidate.description += " revised";
  await expect(f.acquisition.acquire({ name: "json.project", operationId: "first", candidate }, signal())).rejects.toThrow("identity conflict");
  expect(f.counts().jobs).toBe(4);
});

test("interrupted acquisition keeps uncertain execution distinct and recovery only dispatches untouched cases", async () => {
  const f = await fixture(), abort = new AbortController(), execute = f.binding.execute;
  f.binding.execute = async (job, s) => { const result = await execute(job, s); abort.abort(); return result; };
  await expect(f.acquisition.acquire({ name: "json.project", operationId: "interrupted" }, abort.signal)).rejects.toThrow();
  expect(f.counts().jobs).toBe(1);
  const firstOperation = f.receipts[0].operationId;
  f.binding.execute = execute;
  await f.restart();
  const resumed = await f.acquisition.acquire({ name: "json.project", operationId: "interrupted" }, signal());
  expect(resumed.status).toBe("unknown");
  expect(resumed.reason).toBe("evaluation-outcome-unconfirmed");
  expect(f.counts().jobs).toBe(4);
  expect(f.receipts.filter(r => r.operationId === firstOperation)).toHaveLength(1);
  expect((await f.library.list()).active).toHaveLength(0);
  expect((await f.acquisition.acquire({ name: "json.project", operationId: "interrupted" }, signal())).status).toBe("unknown");
  expect(f.counts().jobs).toBe(4);
});

test("completed acquisition rechecks permission and retirement at the settlement boundary changes current readiness", async () => {
  const f = await fixture();
  const acquired = await f.acquisition.acquire({ name: "json.project", operationId: "ready-before" }, signal());
  expect(acquired.status).toBe("ready");
  const authorize = f.binding.authorize, jobs = f.counts().jobs;
  f.binding.authorize = async () => false;
  expect((await f.acquisition.acquire({ name: "json.project", operationId: "ready-before" }, signal())).status).toBe("unavailable");
  f.binding.authorize = authorize;
  const raced = new HarnessAcquisition(f.binding, { read: f.journal.read, append: async batch => {
    if (batch.some(e => e.type === "AikoHarnessAcquisitionSettled")) {
      const head = (await f.library.list()).active[0]!;
      await f.journal.append([{ type: "AikoHarnessRetired", id: "retire-at-append", owner: "123", at: Date.now(), routeKey: head.routeKey, previousGeneration: head.generation, generation: Number(head.generation) + 1 }]);
    }
    await f.journal.append(batch);
  } });
  const result = await raced.acquire({ name: "json.project", operationId: "retirement-race" }, signal());
  expect(result.status).toBe("unavailable");
  expect(result.reason).toBe("selected-route-retired-or-superseded");
  const receipt = (await f.events()).find(e => e.type === "AikoHarnessAcquisitionSettled" && e.id === "retirement-race");
  expect(receipt?.status).toBe("verified");
  expect((await f.events()).some(e => e.type === "AikoHarnessAcquisitionSettled" && e.status === "ready")).toBe(false);
  expect((await f.acquisition.acquire({ name: "json.project", operationId: "ready-before" }, signal())).status).toBe("unavailable");
  expect(f.counts().jobs).toBe(jobs);
});

test("cancellation during the final readiness read cannot return ready", async () => {
  const f = await fixture();
  await f.acquisition.acquire({ name: "json.project", operationId: "before-cancel" }, signal());
  const abort = new AbortController(), authorize = f.binding.authorize, jobs = f.counts().jobs;
  let authorized = false;
  f.binding.authorize = async (...args) => { const result = await authorize(...args); authorized = true; return result; };
  const raced = new HarnessAcquisition(f.binding, { append: f.journal.append, read: async () => { const rows = await f.journal.read(); if (authorized) abort.abort(); return rows; } });
  await expect(raced.acquire({ name: "json.project", operationId: "before-cancel" }, abort.signal)).rejects.toThrow();
  expect(abort.signal.aborted).toBe(true);
  expect(f.counts().jobs).toBe(jobs);
});

test("replay cannot reacquire missing bytes, bypass revocation, or ignore cancellation", async () => {
  const f = await fixture();
  const acquired = await f.acquisition.acquire({ name: "json.project", operationId: "owned" }, signal());
  const jobs = f.counts().jobs;
  f.authority.active = false;
  await expect(f.acquisition.acquire({ name: "json.project", operationId: "revoked" }, signal())).rejects.toThrow("authority unavailable");
  f.authority.active = true;
  f.erase(acquired.harnessDigest as string);
  await expect(f.acquisition.acquire({ name: "json.project", operationId: "owned" }, signal())).rejects.toThrow("unavailable");
  const count = (await f.events()).length;
  await expect(f.acquisition.acquire({ name: "text.chunk", operationId: "cancelled" }, AbortSignal.abort())).rejects.toThrow();
  expect((await f.events()).length).toBe(count);
  expect(f.counts().jobs).toBe(jobs);
  const other = new HarnessAcquisition({ ...f.binding, owner: "456", thread: "user-456" }, f.journal);
  expect((await other.catalog()).active).toHaveLength(0);
});
