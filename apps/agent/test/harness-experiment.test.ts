import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Layer } from "effect";
import { actor, handles, Infer } from "tardie";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryComponent, harnessLibraryEventKey, harnessLibraryState, type HarnessArtifact, type HarnessContract, type HarnessLibraryBinding, type HarnessVerifier, type HarnessWitness } from "../src/harness-library.ts";
import { createHarnessSandboxBinding, type HarnessSandboxAuthority } from "../src/harness-sandbox.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { validateRouterInput } from "../src/connector-router-host.ts";
import { HarnessExperiment, harnessExperimentComponent, harnessExperimentLifecycle, harnessExperimentState, harnessExperimentWaitMethod, type HarnessExperimentBinding, type HarnessExperimentRequest } from "../src/harness-experiment.ts";
import { compareHarnessTrials, harnessDominates, harnessParetoFrontier, selectHarnessFrontier, type HarnessComparisonPolicy } from "../src/harness-pareto.ts";
import { createHarnessReflection } from "../src/harness-reflection.ts";
import { createModelRouting, parseModelRouting } from "../src/model-routing.ts";
import { ModelBudget } from "../src/model-budget.ts";
import { registryModelBudget } from "../src/registry-model-budget.ts";
import { harnessReflectionBudgetDenial } from "../src/harness-experiment-log.ts";
import { HarnessExperimentTrials, harnessExperimentTrialEventKey, harnessExperimentTrialIsChild } from "../src/harness-experiment-trials.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const signal = () => AbortSignal.timeout(20000);
const policy: HarnessComparisonPolicy = { version: 1, objectives: [{ metric: "networkRequests", direction: "min", tolerance: 0 }], qualityTolerance: 0 };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "harness-experiment-"));
  const db = new Database(join(directory, "db.sqlite"));
  cleanup.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  let requests = 0, preparations = 0, proposals = 0, jobs = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => { requests++; const url = new URL(req.url), n = Number(url.searchParams.get("n")); return Response.json({ value: url.pathname === "/overfit" && n < 0 ? 0 : n * 2 }); } });
  cleanup.push(async () => { await server.stop(true); });
  const origin = server.url.origin, runtimeDigest = await sandboxEnvironment("experiment-fixture-v1");
  const authority: HarnessSandboxAuthority = { owner: "123", active: true, runtimeDigest, contextRef: "fixture-v1", authorityRef: "controlled-read", sessionRevision: null, effects: ["read"], origins: [origin], methods: ["GET"], budget: { wallMs: 5000, requests: 4, outputBytes: 32768 } };
  const sandbox = localHarnessSandbox({ owner: "123", environmentDigest: runtimeDigest, journal: await sandboxJobJournal(db, join(directory, "key")), send: async (req, signal) => {
    const response = await fetch(req.url, { signal, method: req.method, redirect: "manual" });
    return { status: response.status, headers: { "content-type": "application/json" }, body: await response.json(), classification: "application" };
  } });
  const sandboxOptions = { placement: "local" as const, current: async () => authority, sandbox: { harnessEnvironment: sandbox.harnessEnvironment,
    harnessJob: async (job: Parameters<typeof sandbox.harnessJob>[0], s?: AbortSignal) => { jobs++; return sandbox.harnessJob(job, s); } } };
  const bridge = createHarnessSandboxBinding({ ...sandboxOptions, owner: "123", thread: "user-123" });
  const verifier: HarnessVerifier = { digest: harnessDigest("experiment-fixed-double-check"), evaluatorDigest: harnessDigest("experiment-dataset-v1"), cases: [{ id: "positive", input: { n: 2 }, split: "development" }, { id: "zero", input: { n: 0 }, split: "development" }, { id: "hidden-negative", input: { n: -817 }, split: "held-out" }], async verify({ input, output }) { const passed = (output as any).value === (input as any).n * 2; return { passed, evidence: [passed ? "fixed-double-satisfied" : "fixed-double-violated"], quality: passed ? 1 : 0 }; } };
  const binding: HarnessLibraryBinding = { owner: "123", thread: "user-123", blobs: harnessBlobStore(sqliteWorkflowKV(db)), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {}, authorizeEvaluation: async () => true, ...bridge };
  const events: Event[] = [];
  const journal = { read: async () => [...events], append: async (batch: Event[]) => {
    if (!harnessLibraryAppendAllowed(batch, () => events)) throw Error("Atomic append fence");
    for (const event of batch) if (!events.some(e => harnessLibraryEventKey(e) === harnessLibraryEventKey(event))) events.push(structuredClone(event));
  } };
  const library = new HarnessLibrary(binding, journal);
  const contract: HarnessContract = { version: 1, outcome: "Return twice the supplied value from the controlled read service", effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, outputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, applicability: { fixture: "controlled-double" }, timeoutMs: 5000 };
  const contractDigest = await library.registerContract(contract);
  const step = (id: string, dependsOn: string[] = []) => ({ id, dependsOn, method: "GET", origin, path: "/double", pathParameters: {}, query: { n: { kind: "input", name: "n" } }, headers: {}, expectedStatuses: [200] });
  const graph = { schemaVersion: 2, executorAbi: "site-harness/1", siteId: "fixture", version: "1", sourceCaptureDigest: harnessDigest("capture"), allowedOrigins: [origin], actions: [{ id: "double", inputs: [{ name: "n", type: "number", required: true }], steps: [step("redundant"), step("read", ["redundant"])] }] };
  const source = JSON.stringify({ graph, actionId: "double" });
  const artifact: HarnessArtifact = { version: 1, name: "double", description: contract.outcome, runtime: "network", entrypoint: "network.json", files: { "network.json": source }, dependencies: [], contractDigest, sources: [{ uri: "fixture:double", revision: "v1", digest: harnessDigest(source), license: "fixture" }] };
  const baselineDigest = await library.record(artifact);
  await library.evaluate(baselineDigest, "stable", signal());
  await library.promote(baselineDigest, "stable", 0, signal());
  const regime = { fixtures: "double-v1", reset: "stateless-no-result-cache", cache: "uncached", order: "baseline-first-candidate-order", model: "deterministic-reflector-fixture" };
  const optimized = structuredClone(graph); optimized.actions[0]!.steps = [step("read")];
  const feedback: unknown[] = [];
  const optimization: HarnessExperimentBinding = { library: binding, regime, authorize: async () => true,
    prepare: async input => { preparations++; return { regimeDigest: harnessDigest(regime), evidence: ["stateless-controlled-service-ready"], costUsd: null, measurements: { networkRequests: 0, browserStarts: 0, modelCalls: 0, tokens: 0 } }; },
    propose: async input => { proposals++; feedback.push(structuredClone(input)); return { hypothesis: "Both steps perform the same stateless read; remove the redundant request and preserve the final read.", files: { "network.json": JSON.stringify({ graph: optimized, actionId: "double" }) }, tokens: 0, costUsd: 0 }; },
  };
  const experiment = new HarnessExperiment(optimization, journal);
  const request: HarnessExperimentRequest = { id: "bounded", baselineDigest, mutableFiles: ["network.json"], repeats: 2, policy, limits: { candidates: 1, runs: 12, wallMs: 60000, proposalTokens: 2048, costUsd: 3 } };
  const counts = () => ({ requests, preparations, proposals, jobs });
  return { directory, db, events, journal, library, binding, experiment, optimization, request, baselineDigest, contract, verifier, artifact, optimized, graph, feedback, counts, authority, sandboxOptions };
}
async function finish(f: Awaited<ReturnType<typeof fixture>>, experiment = f.experiment) {
  for (let i = 0; i < 40 && !harnessExperimentState(f.events, "123", f.request.id).settled; i++) await experiment.advance(f.request.id, signal());
  return experiment.status(f.request.id);
}

async function nativeTrialFixture(input?: Awaited<ReturnType<typeof fixture>>, automatic = true, lifecycleOnly = false) {
  const f = input ?? await fixture();
  const native = new Database(join(f.directory, "native-experiment.sqlite"));
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost<any>>>;
  let pause: "dispatch" | "execute" | "return" | "join" | undefined;
  let alarm: number | null = null;
  cleanup.push(async () => { await host?.close(); native.close(); });
  const storage: AccountStorage = { sql: { exec: (sql, ...args) => { const rows = native.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
    transactionSync: fn => native.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  f.journal.read = () => host.read("user-123").then(rows => [...rows]);
  f.journal.append = async rows => { for (const row of rows) await host.commitRoot(host.self("user-123"), row); };
  const trials = new HarnessExperimentTrials({ binding: f.binding, journal: f.journal, sandbox: async () => f.sandboxOptions,
    readThread: thread => host.read(thread), authorize: async (scope, s) => {
      s.throwIfAborted();
      const state = harnessExperimentState(await host.read("user-123"), "123", scope.experimentId);
      const reserved = state.reservations.get(scope.operationId);
      return !!state.registered && !state.cancelled && !state.settled && state.candidates.includes(scope.harnessDigest) &&
        reserved?.kind === "trial" && reserved.harnessDigest === scope.harnessDigest && reserved.phase === scope.phase &&
        reserved.caseRef === harnessDigest(scope.caseId) && reserved.repeat === scope.repeat && Number(state.registered.deadlineAt) === scope.deadlineAt;
    } });
  f.optimization.trials = trials;
  const experiment = new HarnessExperiment(f.optimization, f.journal);
  const gated = <T extends ReturnType<HarnessExperimentTrials["worker"]>>(source: T) => ({ ...source, machine: { ...source.machine,
    output: (state: any) => { const output = source.machine.output(state); return { ...output,
      transitions: output.transitions.filter(t => !pause || !t.key.startsWith(`aiko-harness-trial:${pause}:`)) }; } } });
  const open = async () => {
    const parent = actor({ name: "aiko", methods: { harnessExperimentWait: harnessExperimentWaitMethod }, components: [
      harnessLibraryComponent("123"), ...(automatic ? [handles(harnessExperimentWaitMethod, lifecycleOnly ? harnessExperimentLifecycle("123") : harnessExperimentComponent(f.optimization))] : []), gated(trials.component()),
    ] });
    const child = actor({ name: "aiko", methods: {}, components: [gated(trials.worker())] });
    host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "experiment-child-integration", ownsThread: t => t === "user-123",
      allowChild: (parent, child) => parent === "user-123" && harnessExperimentTrialIsChild(child),
      actorFor: t => t === "user-123" ? parent : harnessExperimentTrialIsChild(t) ? child : undefined,
      layersFor: () => Layer.empty, keyOf: e => harnessExperimentTrialEventKey(e) ?? harnessLibraryEventKey(e),
      canAppend: (_thread, rows, read) => harnessLibraryAppendAllowed(rows, read) });
  };
  await open(); await host.seed("user-123", f.events);
  return { ...f, experiment, trials, native, get host() { return host; }, setPause: (value: typeof pause) => { pause = value; },
    reopen: async () => { await host.close(); await open(); await host.recover(); },
  };
}

test("native child trials drive complete fixed development and held-out optimization without parent executions", async () => {
  const f = await nativeTrialFixture(), before = f.counts();
  await f.experiment.start(f.request, signal());
  await f.host.drive();
  const result = await f.experiment.status(f.request.id), rows = await f.journal.read();
  expect(result.status).toBe("promoted");
  expect(result.trials).toBe(12);
  expect(f.counts().jobs - before.jobs).toBe(12);
  expect(f.counts().requests - before.requests).toBe(18);
  expect(f.counts().preparations).toBe(12);
  expect(f.counts().proposals).toBe(1);
  const mirrors = rows.filter(e => e.type === "AikoHarnessExperimentTrialWitness");
  expect(mirrors).toHaveLength(12);
  expect(new Set(mirrors.map(e => e.childThread)).size).toBe(12);
  expect(rows.filter(e => e.type === "AikoHarnessRunStarted" && String(e.id).startsWith("experiment:"))).toHaveLength(0);
  const state = harnessLibraryState(rows, "123");
  for (const mirror of mirrors) {
    const child = await f.host.read(String(mirror.childThread));
    expect(child.filter(e => e.type === "AikoHarnessRunStarted")).toHaveLength(1);
    expect(child.filter(e => e.type === "AikoHarnessChecked")).toHaveLength(1);
    expect(String(harnessDigest(state.witnesses.get(String(mirror.id))))).toBe(String(mirror.witnessDigest));
    const trial = rows.find(e => e.type === "AikoHarnessExperimentTrialSettled" && e.id === mirror.id)!;
    expect((trial.accounting as any).latencyMs).toBeGreaterThanOrEqual((mirror.witness as HarnessWitness).latencyMs);
  }
  expect(JSON.stringify(rows)).not.toContain('"n":-817');
  expect(JSON.stringify(f.feedback)).not.toContain("hidden-negative");
  const done = f.counts(), retained = structuredClone(rows);
  await f.reopen(); await f.host.drive();
  expect(await f.experiment.status(f.request.id)).toEqual(result);
  expect(f.counts()).toEqual(done);
  expect(await f.journal.read()).toEqual(retained);
}, 30000);

test("native trial controller recovers a prepared child handoff with one reset and one execution per trial", async () => {
  const f = await nativeTrialFixture(); f.setPause("execute");
  await f.experiment.start(f.request, signal()); const before = f.counts();
  await f.host.drive();
  const paused = await f.journal.read();
  expect(paused.filter(e => e.type === "AikoHarnessExperimentPrepared")).toHaveLength(1);
  expect(paused.filter(e => e.type === "AikoHarnessTrialDispatched")).toHaveLength(1);
  expect(f.counts().jobs).toBe(before.jobs);
  expect(f.counts().preparations).toBe(1);
  f.setPause(undefined); await f.reopen(); await f.host.drive();
  expect((await f.experiment.status(f.request.id)).status).toBe("promoted");
  expect(f.counts().preparations).toBe(12);
  expect(f.counts().jobs - before.jobs).toBe(12);
}, 30000);

test("native child witness mirror rejects altered scores and cannot masquerade as a different library invocation", async () => {
  const f = await nativeTrialFixture(await fixture(), false);
  await f.experiment.start(f.request, signal()); await f.experiment.advance(f.request.id, signal()); await f.host.drive();
  await f.experiment.advance(f.request.id, signal());
  const rows = await f.journal.read(), mirror = rows.find(e => e.type === "AikoHarnessExperimentTrialWitness")!;
  expect(mirror).toBeDefined();
  const beforeMirror = rows.slice(0, rows.indexOf(mirror));
  expect(harnessLibraryAppendAllowed([mirror], () => beforeMirror)).toBe(true);
  for (const update of [{ childThread: "harness-trial-" + "f".repeat(64) }, { witnessRef: harnessDigest("forged-ref") },
    { inputRef: "missing-ref" }, { inputRef: harnessDigest("other-input") }, { caseId: "heldout" }, { phase: "held-out" }, { repeat: 7 }]) {
    expect(harnessLibraryAppendAllowed([{ ...mirror, ...update }], () => beforeMirror)).toBe(false);
  }
  const witness = { ...(mirror.witness as HarnessWitness), quality: 100, measurements: { networkRequests: 0, browserStarts: 0, modelCalls: 0, tokens: 0 } };
  const fake = { ...mirror, witness, witnessDigest: harnessDigest(witness) };
  expect(harnessLibraryAppendAllowed([fake], () => beforeMirror)).toBe(false);
  expect(harnessLibraryState([...beforeMirror, fake], "123").witnesses.has(String(mirror.id))).toBe(false);
  const library = new HarnessLibrary(f.binding, f.journal), counts = f.counts();
  await expect(library.run(f.baselineDigest, { n: 999 }, String(mirror.id), signal(), { caseId: String(mirror.caseId) })).rejects.toThrow("identity conflict");
  expect(f.counts()).toEqual(counts);
}, 30000);

test("bounded reflection optimizes real sandbox reads, preserves the held-out boundary and replays only facts", async () => {
  const f = await fixture(), before = f.counts();
  await f.experiment.start(f.request, signal());
  const result = await finish(f);
  expect(result.status).toBe("promoted");
  expect(result.trials).toBe(12);
  expect(f.counts().requests - before.requests).toBe(18);
  expect(f.counts().jobs - before.jobs).toBe(12);
  expect(f.counts().proposals).toBe(1);
  expect(f.counts().preparations).toBe(12);
  expect(JSON.stringify(f.feedback)).not.toContain("hidden-negative");
  expect(JSON.stringify(f.feedback)).not.toContain("-817");
  expect(JSON.stringify(f.events)).not.toContain('"n":-817');
  const opened = f.events.findIndex(e => e.type === "AikoHarnessExperimentHeldOutOpened");
  expect(opened).toBeGreaterThan(f.events.findIndex(e => e.type === "AikoHarnessExperimentProposalSettled"));
  expect(f.events.slice(opened).some(e => e.type === "AikoHarnessExperimentReserved" && e.kind === "proposal")).toBe(false);
  const comparison = await f.binding.blobs.get("123", (result.result as any).comparisonRef) as any[];
  expect(comparison.map(c => c.metrics.networkRequests.mean)).toEqual([6, 3]);
  expect(comparison.every(c => c.metrics.costUsd === null)).toBe(true);
  expect(comparison.every(c => c.metrics.modelCalls === null)).toBe(true);
  const settledCounts = f.counts(), saved = structuredClone(f.events);
  const recovered = new HarnessExperiment(f.optimization, f.journal);
  expect(await recovered.advance(f.request.id, signal())).toEqual(result);
  expect(await recovered.start(f.request, signal())).toEqual(result);
  expect(f.counts()).toEqual(settledCounts);
  expect(f.events).toEqual(saved);
  await expect(recovered.start({ ...f.request, repeats: 3 }, signal())).rejects.toThrow("identity conflict");
});

test("a development winner failing the final set cannot replace the stable artifact", async () => {
  const f = await fixture();
  f.optimization.propose = async () => ({ hypothesis: "Use the shorter endpoint; its negative-input defect must fail the fixed oracle", files: { "network.json": JSON.stringify({ graph: { ...f.optimized, actions: [{ ...f.optimized.actions[0], steps: [{ ...f.optimized.actions[0]!.steps[0], path: "/overfit" }] }] }, actionId: "double" }) }, tokens: 0, costUsd: null });
  await f.experiment.start(f.request, signal());
  const result = await finish(f);
  expect(result.status).toBe("retained-baseline");
  expect([...harnessLibraryState(f.events, "123").heads.values()][0]!.harnessDigest).toBe(f.baselineDigest);
  expect(f.events.some(e => e.type === "AikoHarnessChecked" && (e.witness as HarnessWitness).status === "violated")).toBe(true);
});

async function reflectedFixture(mode: "good" | "lost-ack" | "tool" | "wrong-files" | "over-limit" | "no-usage" | "partial-usage" | "http-error" = "good", prime = true, daily?: "bun" | "worker") {
  const f = await fixture(), budget = new ModelBudget(f.directory, daily ? { accountPerDay: 1, globalPerDay: 5, maxConcurrent: 2 } : undefined);
  cleanup.push(async () => budget.close());
  const requests: any[] = [];
  const env = { AIKO_ALLOW_PAID_INFERENCE: "true", CODEGRAFF_API_KEY: "fixture-provider-key" };
  let allowed = true, lost = mode === "lost-ack";
  const options = { library: f.binding, journal: f.journal, instance: "reflection-fixture", regime: f.optimization.regime,
    authorize: async () => allowed,
    routing: { owner: "123", env, budget: daily === "worker" ? registryModelBudget("123", sqliteWorkflowKV(f.db), 1) : budget, config: parseModelRouting(env, { maxOutputTokens: 256 }),
      fetch: async (_url: any, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        if (mode === "http-error") return new Response("unavailable", { status: 503 });
        const value = { hypothesis: "Remove the duplicate read and retain the required result.", files: mode === "wrong-files" ? { "contract.json": "replacement" } : { "network.json": JSON.stringify({ graph: f.optimized, actionId: "double" }) } };
        const delta = mode === "tool" ? { role: "assistant", tool_calls: [{ index: 0, id: "forbidden", type: "function", function: { name: "execute", arguments: '{"code":"return 1"}' } }] }
          : { role: "assistant", content: JSON.stringify(value) };
        return new Response([
          { id: "proposal", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] },
          { id: "proposal", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: mode === "tool" ? "tool_calls" : "stop" }],
            ...(mode === "no-usage" ? {} : { usage: { prompt_tokens: 100, ...(mode === "partial-usage" ? {} : { completion_tokens: mode === "over-limit" ? 257 : 31 }), cost: 0.02 } }) },
        ].map(x => `data: ${JSON.stringify(x)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
      },
    },
  };
  let reflection = createHarnessReflection(options);
  f.optimization.regime.model = harnessDigest(reflection.policy());
  f.optimization.propose = async (input, signal) => {
    const result = await reflection.propose(input, signal);
    if (lost) { lost = false; reflection = createHarnessReflection(options); throw Error("lost-controller-acknowledgement"); }
    return result;
  };
  f.optimization.recoverProposal = (input, signal) => reflection.recoverProposal(input, signal);
  if (prime) {
    await f.experiment.start(f.request, signal());
    // Four development trials complete before the first reflection request.
    for (let n = 0; n < 4; n++) await f.experiment.advance(f.request.id, signal());
  }
  return { f, budget, requests, reflection, options, revoke: () => { allowed = false; } };
}

async function spendDailyAllowance(f: Awaited<ReturnType<typeof reflectedFixture>>) {
  const routing = createModelRouting(f.options.routing);
  const result = await Effect.runPromise(Effect.gen(function* () {
    const infer = yield* Infer;
    return yield* infer.react({ identity: { actor: "aiko", instance: "ordinary-conversation", thread: "user-123", turn: "ordinary" },
      trajectory: [{ type: "MessageReceived", id: "ordinary", text: "Answer this message", at: Date.now() }], system: "Answer", tools: [] });
  }).pipe(Effect.provide(routing.layer("conversation"))));
  expect(result.kind).toBe("complete");
  expect(f.requests).toHaveLength(1);
}

test("actual shared Bun and Worker daily ledgers settle denied native reflection without another physical call", async () => {
  for (const daily of ["bun", "worker"] as const) {
    const reflection = await reflectedFixture("good", true, daily), { f, requests } = reflection;
    await spendDailyAllowance(reflection);
    const before = f.counts();
    const outcome = await f.experiment.advance(f.request.id, signal());
    expect(outcome.status).toBe("budget-exhausted");
    expect(outcome.result?.reason).toBe("daily-model-budget-exhausted");
    expect(outcome.costUsd).toBeNull();
    expect(outcome.candidates).toEqual([f.baselineDigest]);
    expect(requests).toHaveLength(1);
    expect(f.counts()).toEqual(before);
    const receipt = f.events.find(e => e.type === "AikoHarnessReflectionSettled")!;
    expect(receipt).toMatchObject({ status: "budget-exhausted", physicalCalls: 0, tokens: null, costUsd: null,
      denial: { version: 1, owner: "123", scope: "account", limit: 1 } });
    expect(harnessReflectionBudgetDenial(receipt, f.events.slice(0, f.events.indexOf(receipt)))).toBe(true);
    expect(f.events.some(e => e.type === "AikoHarnessExperimentProposalMeasured" || e.type === "AikoHarnessExperimentHeldOutOpened")).toBe(false);
    const retained = structuredClone(f.events);
    expect(await new HarnessExperiment(f.optimization, f.journal).advance(f.request.id, signal())).toEqual(outcome);
    expect(f.events).toEqual(retained);
    expect(requests).toHaveLength(1);
  }
});

test("daily denial survives interrupted settlement and native metadata restart without private execution bindings", async () => {
  for (const daily of ["bun", "worker"] as const) {
    const reflection = await reflectedFixture("good", true, daily), { f, requests } = reflection;
    await spendDailyAllowance(reflection);
    const interrupted = new HarnessExperiment(f.optimization, { read: f.journal.read, append: async rows => {
      if (rows.some(e => e.type === "AikoHarnessExperimentSettled")) throw Error("Interrupted daily settlement");
      await f.journal.append(rows);
    } });
    await expect(interrupted.advance(f.request.id, signal())).rejects.toThrow("Interrupted daily settlement");
    const cut = harnessExperimentState(f.events, "123", f.request.id);
    expect(cut.budgetDenied?.status).toBe("budget-exhausted");
    expect(cut.settled).toBeUndefined();
    let privateReads = 0;
    f.binding.blobs.get = async () => { privateReads++; throw Error("Private bytes unavailable"); };
    f.binding.context = async () => { privateReads++; throw Error("Execution unavailable"); };
    const before = f.counts(), recovered = await nativeTrialFixture(f, true, true);
    await recovered.host.recover(); await recovered.host.drive();
    const outcome = await recovered.experiment.status(f.request.id);
    expect(outcome.status).toBe("budget-exhausted");
    expect(outcome.result?.reason).toBe("daily-model-budget-exhausted");
    expect(privateReads).toBe(0);
    expect(f.counts()).toEqual(before);
    expect(requests).toHaveLength(1);
    await recovered.reopen(); await recovered.host.drive();
    expect(await recovered.experiment.status(f.request.id)).toEqual(outcome);
    expect((await recovered.journal.read()).filter(e => e.type === "AikoHarnessExperimentSettled")).toHaveLength(1);
    expect(privateReads).toBe(0); expect(f.counts()).toEqual(before); expect(requests).toHaveLength(1);
  }
});

test("daily denial receipt requires exact native lineage and cannot replace cancellation or prior physical evidence", async () => {
  const reflection = await reflectedFixture("good", true, "bun"), { f } = reflection;
  await spendDailyAllowance(reflection); await f.experiment.advance(f.request.id, signal());
  const receipt = f.events.find(e => e.type === "AikoHarnessReflectionSettled")!;
  const before = f.events.slice(0, f.events.indexOf(receipt));
  expect(harnessLibraryAppendAllowed([receipt], () => before)).toBe(true);
  for (const patch of [{ owner: "456" }, { experimentId: "foreign" }, { claimId: "foreign" }, { reservationClaimId: "foreign" },
    { parentDigest: harnessDigest("foreign") }, { requestDigest: harnessDigest("foreign") }, { policyDigest: harnessDigest("foreign") },
    { requestedMaxTokens: 1 }, { physicalCalls: 1 }, { tokens: 0 }, { costUsd: 0 }, { responseRef: harnessDigest("response") },
    { denial: { ...(receipt.denial as object), owner: "456" } }, { at: Number(harnessExperimentState(before, "123", f.request.id).registered!.deadlineAt) }]) {
    const altered = { ...receipt, ...patch };
    expect(harnessReflectionBudgetDenial(altered, before)).toBe(false);
    expect(harnessLibraryAppendAllowed([altered], () => before)).toBe(false);
    expect(harnessExperimentState([...before, altered], "123", f.request.id).budgetDenied).toBeUndefined();
  }
  for (const type of ["AikoHarnessExperimentRegistered", "AikoHarnessExperimentReserved", "AikoHarnessReflectionRequested"])
    expect(harnessLibraryAppendAllowed([receipt], () => before.filter(e => e.type !== type))).toBe(false);
  for (const type of ["AikoHarnessExperimentCancelled", "AikoHarnessExperimentSettled", "AikoHarnessExperimentSearchClosed",
    "AikoHarnessReflectionSettled", "AikoHarnessExperimentProposalSettled", "AikoHarnessExperimentProposalMeasured"]) {
    const history = [...before, { type, owner: "123", experimentId: f.request.id, id: receipt.id, physicalCalls: 1, at: receipt.at }];
    expect(harnessLibraryAppendAllowed([receipt], () => history)).toBe(false);
  }
  expect(harnessLibraryAppendAllowed([{ ...receipt, status: "unknown" }], () => [...before, receipt])).toBe(false);
  const settled = f.events.find(e => e.type === "AikoHarnessExperimentSettled")!;
  expect(harnessLibraryAppendAllowed([settled], () => before)).toBe(false);
  expect(harnessLibraryAppendAllowed([settled], () => [...before, receipt])).toBe(true);
  expect(harnessLibraryAppendAllowed([settled], () => [...before, receipt,
    { type: "AikoHarnessExperimentCancelled", owner: "123", experimentId: f.request.id, id: f.request.id, at: receipt.at }])).toBe(false);
  expect(() => validateRouterInput([receipt])).toThrow();
});

test("cancellation committed at denial or terminal append wins during native recovery", async () => {
  for (const boundary of ["AikoHarnessReflectionSettled", "AikoHarnessExperimentSettled"]) {
    const reflection = await reflectedFixture("good", true, "worker"), { f, requests } = reflection;
    await spendDailyAllowance(reflection);
    const append = f.journal.append;
    let cancelled = false;
    f.journal.append = async rows => {
      if (!cancelled && rows.some(e => e.type === boundary)) {
        cancelled = true;
        await append([{ type: "AikoHarnessExperimentCancelled", owner: "123", id: f.request.id, experimentId: f.request.id, at: Date.now() }]);
      }
      await append(rows);
    };
    if (boundary === "AikoHarnessExperimentSettled") await expect(f.experiment.advance(f.request.id, signal())).rejects.toThrow("Atomic append fence");
    else expect((await f.experiment.advance(f.request.id, signal())).status).toBe("cancelled");
    const before = f.counts(), recovered = await nativeTrialFixture(f, true, true);
    await recovered.host.recover(); await recovered.host.drive();
    expect((await recovered.experiment.status(f.request.id)).status).toBe("cancelled");
    expect((await recovered.journal.read()).filter(e => e.type === "AikoHarnessExperimentSettled")).toHaveLength(1);
    expect(f.counts()).toEqual(before); expect(requests).toHaveLength(1);
  }
});

test("native Infer reflection uses the shared ledger, a physical token cap and development-only context", async () => {
  const { f, requests, budget } = await reflectedFixture();
  const outcome = await finish(f);
  expect(outcome.status).toBe("promoted");
  expect(requests).toHaveLength(1);
  expect(requests[0].max_tokens).toBe(256);
  expect(requests[0].tools ?? []).toHaveLength(0);
  expect(JSON.stringify(requests)).not.toContain("hidden-negative");
  expect(JSON.stringify(requests)).not.toContain("-817");
  expect(JSON.stringify(requests)).not.toContain("fixture-provider-key");
  expect(f.events.filter(e => e.type === "AikoHarnessReflectionRequested")).toHaveLength(1);
  expect(f.events.find(e => e.type === "AikoHarnessExperimentProposalMeasured")).toMatchObject({ tokens: 31, costUsd: 0.02, physicalCalls: 1 });
  expect(budget.status("123").accountCalls).toBe(1);
  const before = f.counts(); await finish(f, new HarnessExperiment(f.optimization, f.journal));
  expect(requests).toHaveLength(1); expect(f.counts()).toEqual(before);
});

test("native Infer and isolated child trials compose through one durable experiment and shared model ledger", async () => {
  const reflection = await reflectedFixture("good", false), f = await nativeTrialFixture(reflection.f), before = f.counts();
  await f.experiment.start(f.request, signal()); await f.host.drive();
  expect((await f.experiment.status(f.request.id)).status).toBe("promoted");
  expect(f.counts().jobs - before.jobs).toBe(12);
  expect(f.counts().preparations).toBe(12);
  expect(reflection.requests).toHaveLength(1);
  expect(reflection.budget.status("123").accountCalls).toBe(1);
  expect((await f.journal.read()).filter(e => e.type === "AikoHarnessExperimentTrialWitness")).toHaveLength(12);
  const done = f.counts(); await f.reopen(); await f.host.drive();
  expect(f.counts()).toEqual(done); expect(reflection.requests).toHaveLength(1);
}, 30000);

test("a retained native proposal recovers a lost controller acknowledgement without another model call", async () => {
  const { f, requests } = await reflectedFixture("lost-ack");
  expect((await f.experiment.advance(f.request.id, signal())).status).toBe("unknown");
  expect(harnessExperimentState(f.events, "123", f.request.id).settled).toBeUndefined();
  expect((await finish(f, new HarnessExperiment(f.optimization, f.journal))).status).toBe("promoted");
  expect(requests).toHaveLength(1);
  expect(f.events.filter(e => e.type === "AikoHarnessReflectionSettled" && e.status === "succeeded")).toHaveLength(1);
});

test("native reflection rejects tool output, frozen-file edits, excess usage and retries", async () => {
  for (const mode of ["tool", "wrong-files", "over-limit", "http-error"] as const) {
    const { f, requests } = await reflectedFixture(mode);
    const expected = mode === "over-limit" ? "budget-exhausted" : "unknown";
    expect((await f.experiment.advance(f.request.id, signal())).status).toBe(expected);
    expect((await f.experiment.advance(f.request.id, signal())).status).toBe(expected);
    expect(requests).toHaveLength(1);
    expect(harnessExperimentState(f.events, "123", f.request.id).candidates).toEqual([f.baselineDigest]);
    expect(f.events.some(e => e.type === "AikoHarnessReflectionSettled" && e.status === "succeeded")).toBe(false);
    if (mode === "over-limit") {
      // The physical policy (256) is narrower than the experiment brief (2048).
      expect(requests[0].max_tokens).toBe(256);
      expect(harnessExperimentState(f.events, "123", f.request.id).tokenExceeded?.tokens).toBe(257);
      expect((await f.experiment.status(f.request.id)).result?.reason).toBe("proposal-token-limit-exceeded");
      expect(f.events.some(e => e.type === "AikoHarnessExperimentHeldOutOpened")).toBe(false);
    }
  }
});

test("reported token overrun recovers terminal settlement without private artifacts or another model call", async () => {
  const { f, requests } = await reflectedFixture("over-limit");
  const interrupted = new HarnessExperiment(f.optimization, {
    read: f.journal.read,
    append: async rows => {
      if (rows.some(e => e.type === "AikoHarnessExperimentSettled")) throw Error("Interrupted budget settlement");
      await f.journal.append(rows);
    },
  });
  await expect(interrupted.advance(f.request.id, signal())).rejects.toThrow("Interrupted budget settlement");
  const cut = harnessExperimentState(f.events, "123", f.request.id);
  expect(cut.tokenExceeded?.tokens).toBe(257);
  expect(cut.settled).toBeUndefined();
  f.binding.blobs.get = async () => { throw Error("Private bytes unavailable"); };
  f.binding.context = async () => { throw Error("Execution unavailable"); };
  const before = f.counts(), recovered = await nativeTrialFixture(f, true, true);
  await recovered.host.recover();
  await recovered.host.drive();
  const outcome = await recovered.experiment.status(f.request.id);
  expect(outcome.status).toBe("budget-exhausted");
  expect(outcome.result?.reason).toBe("proposal-token-limit-exceeded");
  expect(outcome.knownCostUsd).toBe(0.02);
  expect(requests).toHaveLength(1);
  expect(f.counts()).toEqual(before);
  await recovered.reopen();
  expect(await recovered.experiment.status(f.request.id)).toEqual(outcome);
  expect(f.counts()).toEqual(before);
  expect(requests).toHaveLength(1);
});

test("native reflection preserves missing usage and current authority before a physical call", async () => {
  const missing = await reflectedFixture("no-usage");
  await missing.f.experiment.advance(missing.f.request.id, signal());
  expect(missing.f.events.find(e => e.type === "AikoHarnessExperimentProposalMeasured")).toMatchObject({ tokens: null, costUsd: null });
  const partial = await reflectedFixture("partial-usage");
  await partial.f.experiment.advance(partial.f.request.id, signal());
  expect(partial.f.events.find(e => e.type === "AikoHarnessExperimentProposalMeasured")).toMatchObject({ tokens: null, costUsd: 0.02 });
  expect(partial.f.events.find(e => e.type === "AikoHarnessExperimentProposalSettled")).toMatchObject({ tokens: null });
  const denied = await reflectedFixture(); denied.revoke();
  expect((await denied.f.experiment.advance(denied.f.request.id, signal())).status).toBe("unknown");
  expect(denied.requests).toHaveLength(0);
  expect(denied.budget.status("123").accountCalls).toBe(0);
});

test("concurrent advance cannot duplicate trial dispatch or overwrite a running owner's decision", async () => {
  const f = await fixture();
  await f.experiment.start(f.request, signal());
  const before = f.counts();
  await Promise.all([f.experiment.advance(f.request.id, signal()), f.experiment.advance(f.request.id, signal())]);
  expect(f.counts().jobs - before.jobs).toBe(1);
  expect(harnessExperimentState(f.events, "123", f.request.id).settled).toBeUndefined();
  expect((await finish(f)).status).toBe("promoted");
});

test("checked trial recovery never resets fixtures or repeats completed sandbox work", async () => {
  const f = await fixture(); await f.experiment.start(f.request, signal());
  await f.experiment.advance(f.request.id, signal());
  const trial = f.events.find(e => e.type === "AikoHarnessExperimentTrialSettled")!;
  f.events.splice(f.events.indexOf(trial), 1);
  const before = f.counts();
  await new HarnessExperiment(f.optimization, f.journal).advance(f.request.id, signal());
  expect(f.counts()).toEqual(before);
  expect(f.events.find(e => e.type === "AikoHarnessExperimentTrialSettled" && e.id === trial.id)?.witnessDigest).toBe(trial.witnessDigest);
});

test("lost reservation evidence remains unknown, and cancellation or deadlines never reopen its dispatch", async () => {
  const f = await fixture(); await f.experiment.start(f.request, signal());
  await f.experiment.advance(f.request.id, signal());
  const trial = f.events.find(e => e.type === "AikoHarnessExperimentTrialSettled")!;
  f.events.splice(0, f.events.length, ...f.events.filter(e => !(e.id === trial.id && ["AikoHarnessExperimentTrialSettled", "AikoHarnessChecked"].includes(e.type))));
  const before = f.counts(), recovered = new HarnessExperiment(f.optimization, f.journal);
  expect((await recovered.advance(f.request.id, signal())).status).toBe("unknown");
  expect(f.counts()).toEqual(before);
  await recovered.cancel(f.request.id, signal());
  expect((await recovered.advance(f.request.id, signal())).status).toBe("cancelled");
  expect(f.counts()).toEqual(before);
});

test("changed evaluator fixtures and forbidden source files are rejected before promotion", async () => {
  const f = await fixture(); await f.experiment.start(f.request, signal());
  (f.verifier.cases as any[]).push({ id: "new", input: { n: 12 }, split: "development" });
  expect((await f.experiment.advance(f.request.id, signal())).status).toBe("blocked");
  expect(f.counts().preparations).toBe(0);
  const g = await fixture();
  g.optimization.propose = async () => ({ hypothesis: "Edit the trusted checker", files: { "verifier.ts": "return true" }, tokens: 0, costUsd: null });
  await g.experiment.start(g.request, signal());
  expect((await finish(g)).status).toBe("unknown");
  expect(harnessExperimentState(g.events, "123", g.request.id).candidates).toEqual([g.baselineDigest]);
  expect(g.events.some(e => e.type === "AikoHarnessExperimentHeldOutOpened")).toBe(false);
});

test("cost ceilings reserve before dispatch, and missing cost cannot become free comparison evidence", async () => {
  const f = await fixture();
  f.optimization.costCeilingUsd = { trial: 2, proposal: 2 };
  await f.experiment.start(f.request, signal());
  expect((await finish(f)).status).toBe("budget-exhausted");
  expect(f.counts().preparations).toBe(1);
  expect(f.counts().proposals).toBe(0);
});

test("fixture authorization precedes reset, and known preparation cost stops execution even with unknown totals", async () => {
  const f = await fixture();
  f.binding.authorizeEvaluation = async () => false;
  await f.experiment.start(f.request, signal());
  const before = f.counts();
  expect((await f.experiment.advance(f.request.id, signal())).status).toBe("blocked");
  expect(f.counts()).toEqual(before);
  const g = await fixture();
  g.optimization.costCeilingUsd = { trial: 1, proposal: 1 };
  g.optimization.prepare = async input => ({ regimeDigest: input.regimeDigest, evidence: ["trusted-cost-receipt"], costUsd: 11 });
  await g.experiment.start(g.request, signal());
  const jobs = g.counts().jobs;
  const result = await g.experiment.advance(g.request.id, signal());
  expect(result.status).toBe("budget-exhausted");
  expect(result.knownCostUsd).toBe(11);
  expect(result.costUsd).toBeNull();
  expect(g.counts().jobs).toBe(jobs);
});

test("cancellation committed at the promotion append boundary prevents publication", async () => {
  const f = await fixture(); let injected = false;
  const journal = { read: f.journal.read, append: async (batch: Event[]) => {
    if (batch.some(e => e.type === "AikoHarnessPromoted")) {
      injected = true;
      await f.journal.append([{ type: "AikoHarnessExperimentCancelled", owner: "123", id: f.request.id, experimentId: f.request.id, at: Date.now() }]);
    }
    await f.journal.append(batch);
  } };
  const experiment = new HarnessExperiment(f.optimization, journal);
  await experiment.start(f.request, signal());
  expect((await finish(f, experiment)).status).toBe("cancelled");
  expect(injected).toBe(true);
  expect([...harnessLibraryState(f.events, "123").heads.values()][0]?.harnessDigest).toBe(f.baselineDigest);
  expect(f.events.filter(e => e.type === "AikoHarnessPromoted")).toHaveLength(1);
});

test("no supported hypothesis terminates native optimization before exposing the held-out set", async () => {
  const input = await fixture();
  let proposals = 0;
  input.optimization.propose = async () => {
    proposals++;
    return { hypothesis: "No trace-supported change remains", files: null, tokens: 0, costUsd: null };
  };
  const f = await nativeTrialFixture(input), before = f.counts();
  await f.experiment.start(f.request, signal());
  await f.host.drive();
  const result = await f.experiment.status(f.request.id), rows = await f.journal.read();
  expect(result.status).toBe("retained-baseline");
  expect(result.result?.reason).toBe("no-supported-hypothesis");
  expect(result.trials).toBe(4);
  expect(proposals).toBe(1);
  expect(f.counts().jobs - before.jobs).toBe(4);
  expect(rows.some(e => e.type === "AikoHarnessExperimentHeldOutOpened")).toBe(false);
  expect(rows.filter(e => e.type === "AikoHarnessExperimentReserved" && e.kind === "trial").every(e => e.phase === "development")).toBe(true);
  const count = f.counts();
  await f.reopen();
  await f.host.drive();
  expect(await f.experiment.status(f.request.id)).toEqual(result);
  expect(f.counts()).toEqual(count);
  expect(proposals).toBe(1);
  expect(harnessLibraryState(await f.journal.read(), "123").heads).toEqual(harnessLibraryState(rows, "123").heads);
});

test("retained no-hypothesis receipt settles with metadata-only lifecycle after interrupted settlement", async () => {
  const f = await fixture();
  f.optimization.propose = async () => ({ hypothesis: "", files: null, tokens: 0, costUsd: null });
  await f.experiment.start(f.request, signal());
  for (let i = 0; i < 4; i++) await f.experiment.advance(f.request.id, signal());
  const interrupted = new HarnessExperiment(f.optimization, {
    read: f.journal.read,
    append: async rows => {
      // The real proposal receipt commits; its terminal append is unavailable.
      if (rows.some(e => e.type === "AikoHarnessExperimentSettled")) throw Error("Interrupted terminal append");
      await f.journal.append(rows);
    },
  });
  await expect(interrupted.advance(f.request.id, signal())).rejects.toThrow("Interrupted terminal append");
  const cut = harnessExperimentState(f.events, "123", f.request.id);
  expect(cut.noHypothesis?.status).toBe("no-hypothesis");
  expect(cut.settled).toBeUndefined();
  const reserved = [...cut.reservations.values()].find(e => e.kind === "trial")!;
  expect(harnessLibraryAppendAllowed([{ ...reserved, id: "late-trial" }], () => f.events)).toBe(false);
  expect(harnessLibraryAppendAllowed([{ type: "AikoHarnessExperimentHeldOutOpened", owner: "123", experimentId: f.request.id, id: "late-final-set" }], () => f.events)).toBe(false);
  f.optimization.propose = async () => { throw Error("Recovery must not reflect"); };
  f.binding.context = async () => { throw Error("Execution unavailable"); };
  f.binding.blobs.get = async () => { throw Error("Private artifacts unavailable"); };
  const count = f.counts(), recovered = await nativeTrialFixture(f, true, true);
  await recovered.host.recover();
  await recovered.host.drive();
  const result = await recovered.experiment.status(f.request.id);
  expect(result.status).toBe("retained-baseline");
  expect(result.result?.reason).toBe("no-supported-hypothesis");
  expect(f.counts()).toEqual(count);
  await recovered.reopen();
  await recovered.host.drive();
  expect(await recovered.experiment.status(f.request.id)).toEqual(result);
  expect(f.counts()).toEqual(count);
  expect((await recovered.journal.read()).filter(e => e.type === "AikoHarnessExperimentSettled")).toHaveLength(1);
});

test("absolute experiment deadline survives restart without another sandbox invocation", async () => {
  const f = await fixture(); await f.experiment.start(f.request, signal());
  const before = f.counts(), actual = Date.now;
  try {
    Date.now = () => Number(harnessExperimentState(f.events, "123", f.request.id).registered!.deadlineAt) + 1;
    expect((await new HarnessExperiment(f.optimization, f.journal).advance(f.request.id, signal())).status).toBe("budget-exhausted");
  } finally { Date.now = actual; }
  expect(f.counts()).toEqual(before);
});

test("an exposed final set cannot be tuned again in another experiment", async () => {
  const f = await fixture(); await f.experiment.start(f.request, signal());
  const first = await finish(f);
  const request = { ...f.request, id: "another", baselineDigest: (first.result as any).selectedDigest };
  await f.experiment.start(request, signal());
  let result = await f.experiment.status(request.id);
  for (let i = 0; i < 20 && result.status === "pending"; i++) result = await f.experiment.advance(request.id, signal());
  expect(result.status).toBe("blocked");
  expect((result.result as any).reason).toBe("held-out-set-already-exposed-use-new-final-set");
  expect(f.events.filter(e => e.type === "AikoHarnessExperimentHeldOutOpened")).toHaveLength(1);
  expect(f.events.some(e => e.type === "AikoHarnessExperimentReserved" && e.experimentId === request.id && e.phase === "held-out")).toBe(false);
});

test("native actor effects advance the experiment and restored SQLite history performs no more work", async () => {
  const f = await fixture(); await f.experiment.start(f.request, signal());
  const native = new Database(":memory:"); cleanup.push(async () => { native.close(); });
  let alarm: number | null = null;
  const storage: AccountStorage = { sql: { exec: (query, ...args) => { const rows = native.query(query).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => native.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const definition = actor({ name: "aiko", methods: { harnessExperimentWait: harnessExperimentWaitMethod }, components: [harnessLibraryComponent("123"), handles(harnessExperimentWaitMethod, harnessExperimentComponent(f.optimization))] });
  const makeHost = () => createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "experiment-fixture", ownsThread: t => t === "user-123", actorFor: () => definition, layersFor: () => Layer.empty, canAppend: (_thread, events, read) => harnessLibraryAppendAllowed(events, read) });
  const host = await makeHost();
  for (const event of f.events) await host.commitRoot(host.self("user-123"), event);
  await host.drive();
  const events = await host.read("user-123");
  expect(harnessExperimentState(events, "123", f.request.id).settled?.status).toBe("promoted");
  expect(events.filter(e => e.type === "AikoHarnessExperimentTrialSettled")).toHaveLength(12);
  const before = f.counts();
  const recovered = await makeHost(); await recovered.drive();
  expect(f.counts()).toEqual(before);
  expect(await recovered.read("user-123")).toEqual(events);
});

test("native method alarms expire idle and foreground-blocked experiments after host reconstruction", async () => {
  for (const scenario of ["unknown-reservation", "foreground-pending", "execution-unavailable"]) {
    const f = await fixture();
    f.request.limits.wallMs = 350;
    await f.experiment.start(f.request, signal());
    const deadline = Number(harnessExperimentState(f.events, "123", f.request.id).registered!.deadlineAt);
    if (scenario === "unknown-reservation") {
      await f.journal.append([{ type: "AikoHarnessExperimentReserved", owner: "123", experimentId: f.request.id,
        id: `experiment:${harnessDigest([f.request.id, f.baselineDigest, "development", "positive", 0]).slice(7)}`,
        kind: "trial", claimId: "lost-host-claim", costCeilingUsd: null, at: Date.now() }]);
    } else await f.journal.append([{ type: "MessageReceived", id: "foreground", text: "Still running", at: Date.now() }]);
    const before = f.counts(), native = new Database(":memory:");
    cleanup.push(async () => { native.close(); });
    let alarm: number | null = null;
    const storage: AccountStorage = { sql: { exec: (query, ...args) => { const rows = native.query(query).all(...args as any); return { toArray: () => rows as never }; } },
      transactionSync: fn => native.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
      setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
    const definition = (executable: boolean) => actor({ name: "aiko", methods: { harnessExperimentWait: harnessExperimentWaitMethod }, components: [
      harnessLibraryComponent("123"), handles(harnessExperimentWaitMethod,
        executable ? harnessExperimentComponent(f.optimization) : harnessExperimentLifecycle("123")),
    ] });
    const open = (executable = true) => createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "deadline-fixture", ownsThread: t => t === "user-123",
      actorFor: () => definition(executable), layersFor: () => Layer.empty, canAppend: (_thread, batch, read) => harnessLibraryAppendAllowed(batch, read) });
    const host = await open();
    for (const event of f.events) await host.commitRoot(host.self("user-123"), event);
    await host.drive();
    const armed = await host.read("user-123");
    expect((armed.find(e => e.type === "AikoHarnessExperimentDeadline")!.call as any).deadlineAt).toBe(deadline);
    expect(alarm).not.toBeNull();
    expect(f.counts()).toEqual(before);
    await host.close();
    if (scenario === "execution-unavailable") {
      f.binding.blobs.get = async () => { throw Error("Private brief storage unavailable"); };
      f.optimization.prepare = async () => { throw Error("Execution unavailable"); };
      f.optimization.propose = async () => { throw Error("Model unavailable"); };
    }
    const restored = await open(scenario !== "execution-unavailable");
    // Exercise the real host alarm after its retained deadline, not a changed
    // Date.now or a manually forged experiment terminal receipt.
    await Bun.sleep(Math.max(1, deadline - Date.now() + 5));
    await restored.alarm();
    const settled = await restored.read("user-123");
    expect(settled.some(e => e.type === "AlarmFired" && Number(e.at) >= deadline)).toBe(true);
    expect(harnessExperimentState(settled, "123", f.request.id).settled).toMatchObject({ status: "budget-exhausted", reason: "absolute-deadline-expired" });
    expect(f.counts()).toEqual(before);
    await restored.recover();
    expect((await restored.read("user-123")).filter(e => e.type === "AikoHarnessExperimentSettled")).toHaveLength(1);
    expect(f.counts()).toEqual(before);
    await restored.close();
  }
});

test("Pareto comparisons retain tradeoffs, reject witness reuse and do not select missing quality", () => {
  const digest = harnessDigest("comparison"), make = (name: string, latency: number, cost: number | null, quality: number | null = 1) => {
    const h = harnessDigest(name);
    return compareHarnessTrials({ harnessDigest: h, contextDigest: digest, evaluatorDigest: digest, datasetDigest: digest, regimeDigest: digest, policy: { ...policy, objectives: [{ metric: "costUsd", direction: "min", tolerance: 0 }, { metric: "latencyMs", direction: "min", tolerance: 0 }] }, cases: [{ id: "a", split: "development" }], repeats: 2, trials: [0, 1].map(repeat => ({ phase: "development", caseId: "a", repeat, witness: { harnessDigest: h, contractDigest: digest, verifierDigest: digest, evaluatorDigest: digest, operationId: `${name}-${repeat}`, contextDigest: digest, status: "satisfied", evidence: ["checked"], quality, latencyMs: latency, costUsd: cost } })) });
  };
  const p = { ...policy, objectives: [{ metric: "costUsd" as const, direction: "min" as const, tolerance: 0 }, { metric: "latencyMs" as const, direction: "min" as const, tolerance: 0 }] };
  const cheap = make("cheap", 20, 1), fast = make("fast", 5, 3), dominated = make("dominated", 25, 5), missing = make("missing", 0, null), noQuality = make("no-quality", 0, 0, null);
  expect(harnessParetoFrontier([cheap, fast, dominated], p).map(c => c.harnessDigest)).toEqual([cheap.harnessDigest, fast.harnessDigest]);
  expect(harnessDominates(missing, cheap, p)).toBe(false);
  expect(selectHarnessFrontier([missing, noQuality], p)).toBeUndefined();
  expect(selectHarnessFrontier([cheap, fast], p)?.harnessDigest).toBe(cheap.harnessDigest);
  const h = harnessDigest("reuse"), w: HarnessWitness = { harnessDigest: h, contractDigest: digest, verifierDigest: digest, evaluatorDigest: digest, operationId: "same", contextDigest: digest, status: "satisfied", evidence: ["checked"], quality: 1, latencyMs: 1, costUsd: null };
  expect(() => compareHarnessTrials({ harnessDigest: h, contextDigest: digest, evaluatorDigest: digest, datasetDigest: digest, regimeDigest: digest, policy, cases: [{ id: "a", split: "development" }], repeats: 2, trials: [0, 1].map(repeat => ({ phase: "development", caseId: "a", repeat, witness: w })) })).toThrow("identity");
});

test("the experiment's declared numeric generation budget does not admit credential data", () => {
  expect(() => validateRouterInput({ limits: { proposalTokens: 100 } }, 0, ["proposalTokens"])).not.toThrow();
  expect(() => validateRouterInput({ limits: { proposalTokens: 100 } })).toThrow("Credentials");
  for (const payload of [{ proposalTokens: "secret-value" }, { proposalTokens: { nested: "value" } }, { proposalTokens: 100, token: "secret-value" }, { proposalTokens: 100, password: 123456 }]) {
    expect(() => validateRouterInput(payload, 0, ["proposalTokens"])).toThrow("Credentials");
  }
});
