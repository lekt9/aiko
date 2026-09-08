import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, Infer } from "tardie";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { createAikoActor } from "../../src/actor.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../../src/cloudflare-host.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryState, type HarnessContract, type HarnessLibraryBinding, type HarnessVerifier } from "../../src/harness-library.ts";
import { harnessSkillDeriver } from "../../src/harness-skill.ts";
import { builtinHarnessDefinitions } from "../../src/harness-builtins.ts";
import { CodeHarness } from "../../src/code-harness.ts";
import { runCodeSegment } from "../../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../../src/workflow-store.ts";
import type { CognitiveCase } from "./catalog.ts";

export type ProcedureArm = "current-control" | "transfer-contract";
/** Identical supplied programs and task inputs across arms. Only the trusted
 * contract's transfer requirement changes. This is an offline mechanism probe,
 * not a model's autonomous choice or the preserved pre-change source baseline. */
export async function runProcedureCase(fixture: CognitiveCase, arm: ProcedureArm, scratch?: string) {
  if (fixture.driver !== "procedure-native") throw Error("Scenario driver is not implemented");
  const dir = scratch ?? await mkdtemp("/tmp/cognitive-procedure-"), owner = "123", thread = "user-123";
  const privateDb = new Database(":memory:"), nativeDb = new Database(":memory:");
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>> | undefined;
  try {
    const base = builtinHarnessDefinitions().find(d => d.artifact.name === fixture.capability)!;
    const cases = [...structuredClone(base.verifier.cases)];
    if (fixture.scenario === "duplicate-development") for (const c of cases.filter(c => c.split === "held-out")) c.input = structuredClone(cases[0]!.input);
    if (fixture.scenario === "duplicate-held-out-count") cases.push({ ...structuredClone(cases.find(c => c.split === "held-out")!), id: "renamed-duplicate" });
    const minimum = fixture.scenario === "two-novel-inputs" ? 2 : fixture.scenario === "duplicate-held-out-count" ? 3 : 1;
    const contract: HarnessContract = { ...base.contract, evaluatorDigest: harnessDigest(["cognitive-fixture-evaluator/v1", cases]),
      verifierDigest: harnessDigest(["cognitive-fixture-verifier/v1", base.verifier.digest, arm, minimum, cases]),
      ...(arm === "transfer-contract" ? { transfer: { version: 1 as const, minimumNovelHeldOutInputs: minimum } } : {}) };
    const contractDigest = harnessDigest(contract);
    const verifier: HarnessVerifier = { digest: contract.verifierDigest, evaluatorDigest: contract.evaluatorDigest, cases,
      async verify(input, s) {
        if (harnessDigest(input.contract) !== contractDigest) return { passed: false, evidence: ["fixture-contract-changed"], quality: 0 };
        return base.verifier.verify({ ...input, contract: base.contract }, s);
      } };
    const artifact = { ...base.artifact, contractDigest }, hash = harnessDigest(artifact);
    let revision = 1, authority = true, fault = "", dispatches = 0, taskDispatches = 0, sends = 0, observed: any;
    const binding: HarnessLibraryBinding = { owner, thread, blobs: harnessBlobStore(sqliteWorkflowKV(privateDb)), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {},
      context: async () => ({ placement: "local", runtimeDigest: harnessDigest("cognitive-offline-quickjs/v1"), bindings: { revision } }),
      authorize: async () => authority,
      execute: async (job, s) => {
        dispatches++; const task = !job.operationId.startsWith("eval:"); if (task) taskDispatches++;
        if (task && fault === "unknown-replay") return { status: "unknown", evidence: ["synthetic-response-lost"] };
        const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, s);
        return { status: result.error ? "failed" : "succeeded", output: task && fault === "failed-warm-lineage" ? null : result.result as any,
          evidence: ["synthetic-quickjs-receipt"], costUsd: 0, measurements: { networkRequests: 0, browserStarts: 0, modelCalls: 0, tokens: 0 } };
      } };
    const journal = { read: () => host!.read(thread), append: async (events: Event[]) => { for (const e of events) await host!.commitRoot(host!.self(thread), e); } };
    const library = new HarnessLibrary(binding, journal), code = new CodeHarness(owner, thread, runCodeSegment, text => text);
    const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = nativeDb.query(q).all(...args as any); return { toArray: () => rows as never }; } },
      transactionSync: fn => nativeDb.transaction(fn)(), sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
    const definition = createAikoActor({ owner, memory: { owner, thread, stateDir: dir, redact: text => text, readPage: async (after, limit) => host!.readPage(thread, after, limit) },
      harnessLibrary: binding, codeHarness: code, background: false, requireThinkFeel: false,
      voice: input => Effect.succeed({ text: input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : "Fixture reply", source: "template" as const }),
      send: async () => ({ status: "delivered" as const, providerId: `synthetic-${++sends}` }),
      extraTools: [{ spec: { name: "fixture_transition", description: "Apply the predeclared synthetic scenario transition. Only mounted in offline evaluation.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        run: (_raw, call) => Effect.gen(function* () {
          const log = yield* EventLog;
          if (["changed-context", "schema-revision"].includes(fixture.scenario)) revision++;
          if (fixture.scenario === "revoked-authority") authority = false;
          if (["unknown-replay", "failed-warm-lineage"].includes(fixture.scenario)) fault = fixture.scenario;
          if (fixture.scenario === "erased-evidence") {
            const rows = yield* log.read;
            const run = rows.find(e => e.type === "AikoHarnessRunStarted" && cases.some(c => c.split === "held-out" && c.id === e.caseId));
            if (!run) throw Error("Fixture cold evidence missing");
            yield* Effect.promise(() => binding.blobs.erase!(owner, run.inputRef as any, "fixture-erasure"));
          }
          if (fixture.scenario === "retired-route") {
            const head = [...harnessLibraryState(yield* log.read, owner).heads.values()].find(e => e.type === "AikoHarnessPromoted");
            if (!head) throw Error("Fixture promoted route missing");
            yield* log.append([{ ...head, type: "AikoHarnessRetired", id: "fixture-retired", previousGeneration: head.generation, generation: Number(head.generation) + 1, at: Date.now() }]);
          }
          if (fixture.scenario === "cancel-before-reuse") yield* log.append([{ type: "CancellationRequested", request: "fixture-cancel", cause: "requested", at: Date.now(), invocation: { method: "message", id: call.turn, epoch: 0 } }]);
          yield* log.append([{ type: "AikoCognitiveFixtureTransition", scenario: fixture.scenario, at: Date.now() }]);
          return { status: "applied" };
        }) }] });
    const foreign = { ...artifact, name: "foreign-only" }, foreignHash = await binding.blobs.put("456", foreign);
    const target = fixture.scenario === "foreign-artifact" ? foreignHash : hash;
    const argumentsLiteral = JSON.stringify(fixture.input);
    const call = (id: string) => `await tools.call({name:'harness_call',arguments:{name:${JSON.stringify(artifact.name)},contractDigest:${JSON.stringify(contractDigest)},input:${id === "task-two" ? JSON.stringify(fixture.followupInput) : argumentsLiteral},operationId:${JSON.stringify(id)}}})`;
    const program = [
      `let task, promotion;`,
      ["saved-example", "foreign-artifact"].includes(fixture.scenario)
        ? `task = await tools.call({name:'harness_run',arguments:{digest:${JSON.stringify(target)},input:${argumentsLiteral},operationId:'task-one'}});`
        : `await tools.call({name:'harness_evaluate',arguments:{digest:${JSON.stringify(hash)},evaluationId:'cold'}}); promotion = await tools.call({name:'harness_promote',arguments:{digest:${JSON.stringify(hash)},evaluationId:'cold',expectedGeneration:0}}); await tools.call({name:'fixture_transition',arguments:{}}); task = ${call("task-one")};`,
      ["unknown-replay", "settled-replay", "warm-reuse"].includes(fixture.scenario) ? `task = ${call(fixture.scenario === "warm-reuse" ? "task-two" : "task-one")};` : "",
      `const procedure = await tools.call({name:'harness_procedure',arguments:{digest:${JSON.stringify(hash)}}}); return {task,promotion,procedure};`,
    ].join("\n");
    const inference = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "cognitive-scripted-v1" } }), react: (request: any) => {
      const result = request.trajectory.findLast((e: Event) => e.type === "ToolReturned" && e.turn === request.identity.turn);
      if (!result) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "fixture-compose", arguments: { code: program } });
      if (result.result.error) throw Error(`Fixture composition failed: ${result.result.error}`);
      observed = result.result.result;
      return Effect.succeed({ kind: "complete" as const, output: "The controlled task has finished. Its execution receipts record the result and any blocker." });
    } });
    const open = () => createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "cognitive-eval", ownsThread: t => [thread, "background-123-indexer"].includes(t),
      actorFor: t => t === thread ? definition : actor({ name: "aiko", methods: {}, components: [harnessSkillDeriver(binding)] }),
      layersFor: t => t === thread ? Layer.merge(code.inference(inference), code.sandboxLayer()) : inference,
      canAppend: (_thread, batch, read) => harnessLibraryAppendAllowed(batch, read) });
    host = await open();
    await library.registerContract(contract); await library.record(artifact);
    const start = performance.now();
    await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "task", source: "telegram", chat: owner, text: fixture.prompt, at: Date.now() });
    await host.drive();
    const events = await host.read(thread), state = harnessLibraryState(events, owner);
    const witness = state.witnesses.get("task-one");
    let output: unknown;
    if (witness?.status === "satisfied") output = (await library.output("task-one")).output;
    const checks: { criterion: string; passed: boolean; evidence: unknown }[] = [];
    const check = (criterion: string, passed: boolean, evidence: unknown) => checks.push({ criterion, passed, evidence });
    check("native-terminal", events.some(e => e.type === (fixture.scenario === "cancel-before-reuse" ? "TurnCancelled" : "TurnCompleted") && e.turn === "task"), events.filter(e => /Turn(Completed|Failed|Cancelled)/.test(e.type)).map(e => e.type));
    const status = witness?.status ?? (observed?.task?.status === "failed" || fixture.scenario === "cancel-before-reuse" ? "blocked" : "unavailable");
    check("checked-task-outcome", status === fixture.expectedTask, { expected: fixture.expectedTask, observed: status, witnessId: witness?.operationId ?? null });
    if (fixture.expected !== undefined) check("exact-private-output", harnessDigest(output ?? null) === harnessDigest(fixture.expected), witness?.outputRef ?? null);
    if (fixture.expectedTask === "blocked") check("no-task-dispatch", taskDispatches === 0, taskDispatches);
    if (fixture.expectedTask === "unknown") check("uncertain-execution-not-repeated", taskDispatches === 1, taskDispatches);
    if (fixture.scenario === "saved-example") check("narrow-example", observed?.procedure?.basis === "saved-example" && state.heads.size === 0, observed?.procedure?.basis);
    if (["duplicate-development", "duplicate-held-out-count"].includes(fixture.scenario)) check("no-unearned-promotion", ![...state.heads.values()].some(e => e.type === "AikoHarnessPromoted"), state.heads.size);
    if (fixture.scenario === "warm-reuse") {
      check("no-extra-evaluation", taskDispatches === 2 && events.filter(e => e.type === "AikoHarnessEvaluationStarted").length === 1, { taskDispatches });
      const first = events.find(e => e.type === "AikoHarnessRunStarted" && e.id === "task-one"), second = events.find(e => e.type === "AikoHarnessRunStarted" && e.id === "task-two");
      check("fresh-parameter-transfer", !!first && !!second && first.inputRef !== second.inputRef && state.witnesses.get("task-two")?.status === "satisfied", { first: first?.id, second: second?.id });
    }
    if (fixture.scenario === "failed-warm-lineage") check("failure-retained", observed?.procedure?.measurements?.taskRuns?.failed === 1, observed?.procedure?.measurements?.taskRuns);
    if (fixture.scenario === "settled-replay") check("logical-operation-reused", taskDispatches === 1, taskDispatches);
    const beforeRestart = dispatches;
    await host.close(); host = await open(); await host.recover();
    check("restart-replay", harnessDigest(await host.read(thread)) === harnessDigest(events) && dispatches === beforeRestart, { before: beforeRestart, after: dispatches });
    return { id: fixture.id, category: fixture.category, split: fixture.split, arm, passed: checks.every(c => c.passed), checks,
      modelMode: "offline-scripted", actor: "aiko", instance: "cognitive-eval", thread, events,
      metrics: { elapsedMs: performance.now() - start, nativeModelCalls: events.filter(e => e.type === "ModelCalled").length,
        executions: dispatches, taskExecutions: taskDispatches, providerSpendUsd: 0, providerTokens: null, humanQuality: null },
      scope: "Actual actor/native tools with synthetic execution; does not measure autonomous strategy selection or user-facing quality" };
  } finally { await host?.close(); nativeDb.close(); privateDb.close(); await rm(dir, { recursive: true, force: true }); }
}
