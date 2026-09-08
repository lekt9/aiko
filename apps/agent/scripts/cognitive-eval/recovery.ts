import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { actor, Infer } from "tardie";
import { EventLog } from "tardie/core/log";
import type { Event } from "tardie/core/event";
import { createAikoActor } from "../../src/actor.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../../src/cloudflare-host.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryState, type HarnessContract, type HarnessLibraryBinding, type HarnessVerifier } from "../../src/harness-library.ts";
import { harnessSkillDeriver } from "../../src/harness-skill.ts";
import { CodeHarness } from "../../src/code-harness.ts";
import { runCodeSegment } from "../../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../../src/workflow-store.ts";
import type { CognitiveCase } from "./catalog.ts";

export type RecoveryArm = "current-control" | "bounded-recovery";

/** Supplied strategy scripts exercise the production actor and retained library.
 * Both arms can use ordinary checked alternate/prerequisite calls. The candidate
 * additionally exposes its native recovery operation; this does not evaluate
 * autonomous strategy choice. A safe unknown is not scored as reconciliation. */
export async function runRecoveryCase(fixture: CognitiveCase, arm: RecoveryArm, scratch?: string) {
  if (fixture.driver !== "recovery-native") throw Error("Scenario driver is not implemented");
  const dir = scratch ?? await mkdtemp("/tmp/cognitive-recovery-"), owner = "123", thread = "user-123";
  const privateDb = new Database(":memory:"), nativeDb = new Database(":memory:");
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>> | undefined;
  try {
    let ready = false, revision = 1, dispatches = 0, taskDispatches = 0, writes = 0, receiptReads = 0, observed: any;
    let parentDeadline: number | undefined, activeChildren = 0, maxActiveChildren = 0;
    const providerReceipts = new Map<string, { input: string; output: number }>();
    const verifier: HarnessVerifier = { digest: harnessDigest("cognitive-recovery-scale/v1"), evaluatorDigest: harnessDigest("cognitive-recovery-scale-cases/v1"),
      cases: [{ id: "development", input: { n: 2 }, split: "development" }, { id: "held-out", input: { n: 13 }, split: "held-out" }],
      async verify({ input, output }) { return { passed: output === (input as { n: number }).n * 2, evidence: ["independent-scale-equality"], quality: null }; } };
    const contract: HarnessContract = { version: 1, outcome: "Return twice the supplied number", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
      outputSchema: { type: "number" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {}, timeoutMs: 1000 };
    const binding: HarnessLibraryBinding = { owner, thread, blobs: harnessBlobStore(sqliteWorkflowKV(privateDb)), verifiers: new Map([[verifier.digest, verifier]]),
      context: async () => ({ placement: "local", runtimeDigest: harnessDigest("cognitive-recovery-quickjs/v1"), bindings: { revision } }),
      authorize: async () => true, authorizeEvaluation: async () => true, guard: () => {},
      execute: async (job, s) => {
        dispatches++; const task = !job.operationId.startsWith("eval:"); if (task) taskDispatches++;
        const child = task && ["prepare", "alternate"].includes(job.artifact.name) && fixture.scenario === "concurrent-strategies";
        if (child) { activeChildren++; maxActiveChildren = Math.max(maxActiveChildren, activeChildren); }
        try {
        if (child) await new Promise(resolve => setTimeout(resolve, 50));
        if (task && job.artifact.name === "prepare") ready = true;
        if (task && job.contract.effect === "write") writes++;
        if (task && fixture.scenario === "ordinary-wait") await new Promise(resolve => setTimeout(resolve, 25));
        const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input, ready }, ambient: { at: 0, seed: job.operationId }, history: [] }, s);
        if (task && job.artifact.name === "prepare" && fixture.scenario === "cancel-during-child") {
          await host!.commitRoot(host!.self(thread), { type: "CancellationRequested", request: "fixture-cancel", cause: "requested", at: Date.now(), invocation: { method: "message", id: "task", epoch: 0 } });
        }
        if (task && fixture.scenario === "unknown-write" && job.contract.effect === "write") {
          if (!result.error) providerReceipts.set(job.operationId, { input: harnessDigest(job.input), output: result.result as number });
          return { status: "unknown", evidence: ["synthetic-write-applied-response-lost"] };
        }
        return { status: result.error ? "failed" : "succeeded", output: result.result as number, evidence: ["synthetic-quickjs-receipt"], costUsd: 0,
          measurements: { modelCalls: 0, tokens: 0, networkRequests: 0, browserStarts: 0 } };
        } finally { if (child) activeChildren--; }
      },
      reconcile: async (job, s) => {
        s.throwIfAborted(); receiptReads++;
        const receipt = providerReceipts.get(job.operationId);
        if (!receipt || receipt.input !== harnessDigest(job.input)) return { status: "unknown", evidence: ["synthetic-provider-receipt-unavailable"] };
        return { status: "succeeded", output: receipt.output, evidence: ["synthetic-provider-original-receipt"], costUsd: 0,
          measurements: { modelCalls: 0, tokens: 0, networkRequests: 0, browserStarts: 0 } };
      } };
    const journal = { read: () => host!.read(thread), append: async (events: Event[]) => { for (const e of events) await host!.commitRoot(host!.self(thread), e); } };
    const library = new HarnessLibrary(binding, journal), code = new CodeHarness(owner, thread, runCodeSegment, text => text);
    const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = nativeDb.query(q).all(...args as any); return { toArray: () => rows as never }; } },
      transactionSync: fn => nativeDb.transaction(fn)(), sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
    let program = "";
    const definition = createAikoActor({ owner, memory: { owner, thread, stateDir: dir, redact: text => text, readPage: async (after, limit) => host!.readPage(thread, after, limit) },
      harnessLibrary: binding, codeHarness: code, cognitiveRecovery: arm === "bounded-recovery", background: false, requireThinkFeel: false,
      voice: input => Effect.succeed({ text: input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : "Fixture reply", source: "template" as const }),
      send: async () => ({ status: "delivered" as const, providerId: "synthetic-recovery-reply" }),
      extraTools: [{ spec: { name: "fixture_transition", description: "Read a declared synthetic provider receipt or change fixture state. Offline evaluation only.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
        run: () => Effect.gen(function* () {
          const log = yield* EventLog;
          if (fixture.scenario === "changed-evidence") { revision++; ready = true; }
          if (fixture.scenario === "schema-refresh") { revision++; ready = false; }
          if (fixture.scenario === "recovery-deadline") yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, Math.max(0, parentDeadline! - Date.now()) + 5)));
          const receipt = fixture.scenario === "unknown-write" ? { operationId: "write-one", providerStatus: "applied", output: 14, authority: "synthetic-owner-123" } : null;
          yield* log.append([{ type: "AikoCognitiveFixtureTransition", scenario: fixture.scenario, receipt, revision, at: Date.now() }]);
          return { status: "applied", receipt };
        }) }] });
    const inference = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "cognitive-scripted-v1" } }), react: (request: any) => {
      const returned = request.trajectory.findLast((e: Event) => e.type === "ToolReturned" && e.turn === request.identity.turn);
      if (!returned) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "fixture-compose", arguments: { code: program } });
      if (returned.result.error) throw Error(`Fixture composition failed: ${returned.result.error}`);
      observed = returned.result.result;
      return Effect.succeed({ kind: "complete" as const, output: "The controlled recovery attempt has ended. Its receipts retain the checked outcome and any remaining blocker." });
    } });
    const open = () => createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "cognitive-eval", ownsThread: t => [thread, "background-123-indexer"].includes(t),
      actorFor: t => t === thread ? definition : actor({ name: "aiko", methods: {}, components: [harnessSkillDeriver(binding)] }),
      layersFor: t => t === thread ? Layer.merge(code.inference(inference), code.sandboxLayer()) : inference,
      canAppend: (_thread, batch, read) => harnessLibraryAppendAllowed(batch, read) });
    host = await open();
    const seed = async (name: string, source: string, effect: HarnessContract["effect"] = "read", promote = false) => {
      const contractDigest = await library.registerContract({ ...contract, effect });
      const digest = await library.record({ version: 1, name, description: "Synthetic recovery evaluation", runtime: "javascript", entrypoint: "main.js", files: { "main.js": source }, dependencies: [],
        sources: [{ uri: "fixture:cognitive-recovery", revision: "1", digest: harnessDigest(source), license: "test-fixture" }], contractDigest });
      if (promote) { await library.evaluate(digest, name, AbortSignal.timeout(5000)); await library.promote(digest, name, 0, AbortSignal.timeout(5000)); }
      return { name, digest, contractDigest, input: fixture.input };
    };
    const parent = await seed("parent", "return ready ? input.n * 2 : -1;"), good = await seed("alternate", "return input.n * 2;", "read", true);
    const prepare = await seed("prepare", "return input.n * 2;", "write", true), writer = await seed("writer", "return input.n * 2;", "write", true);
    const run = (target: typeof parent, id: string, input = fixture.input) => `await tools.call({name:'harness_run',arguments:${JSON.stringify({ digest: target.digest, input, operationId: id })}})`;
    const call = (target: typeof parent, id: string) => `await tools.call({name:'harness_call',arguments:${JSON.stringify({ name: target.name, contractDigest: target.contractDigest, input: fixture.input, operationId: id })}})`;
    const recover = (strategy: string, target?: typeof parent) => `await tools.call({name:'harness_recover',arguments:{impasseId:second.impasseId,strategy:${JSON.stringify(strategy)}${target ? `,procedure:${JSON.stringify({ name: target.name, contractDigest: target.contractDigest, input: fixture.input })}` : ""}}})`;
    const steps = ["let first, second, last, child, partial, receipt, stale, contenders;"];
    if (fixture.scenario === "ordinary-wait") steps.push(`last = ${run(good, "wait-one")};`);
    else if (fixture.scenario === "unknown-write") steps.push(`first = ${run(writer, "write-one")}; receipt = await tools.call({name:'fixture_transition',arguments:{}}); const readers = await tools.search({query:'harness_reconcile'}); if(readers.some(t => t.name === 'harness_reconcile')) receipt = await tools.call({name:'harness_reconcile',arguments:{operationId:'write-one',reconciliationId:'read-one'}}); second = ${run(writer, "write-one")}; last = ${run(prepare, "write-other-transport")};`);
    else {
      if (fixture.scenario === "owner-information") steps.push(`partial = ${run(good, "partial-one")};`);
      if (fixture.scenario === "partial-results") steps.push(`partial = [${run(good, "partial-one")}, ${run(good, "partial-two", { n: 8 })}];`);
      steps.push(`first = ${run(parent, "failure-one")}; second = ${run(parent, fixture.scenario === "receipt-reread" ? "failure-one" : "failure-two")};`);
      switch (fixture.scenario) {
        case "equivalent-failure": steps.push(`last = ${run(parent, "failure-three")};`); break;
        case "receipt-reread": steps.push("last = second;"); break;
        case "changed-evidence": steps.push(`await tools.call({name:'fixture_transition',arguments:{}}); last = ${run(parent, "changed-state")};`); break;
        case "alternate-capability": steps.push(`last = second.impasseId ? ${recover("alternate-capability", good)} : ${call(good, "alternate-parent")};`); break;
        case "checked-prerequisite": case "parent-still-failing": case "cancel-during-child": case "recovery-deadline": {
          const target = fixture.scenario === "parent-still-failing" ? good : prepare;
          if (fixture.scenario === "recovery-deadline") steps.push(`await tools.call({name:'fixture_transition',arguments:{}});`);
          steps.push(`if(second.impasseId) last = ${recover("verified-procedure", target)}; else { child = ${call(target, "checked-child")}; if(child.status === 'satisfied') last = ${run(parent, "resumed-parent")}; }`); break;
        }
        case "concurrent-strategies":
          steps.push(`if(second.impasseId) contenders = await Promise.all([${recover("verified-procedure", prepare).replace(/^await /, "")}, ${recover("refresh-schema", good).replace(/^await /, "")}]); else contenders = await Promise.all([(async()=>{const child=${call(prepare, "prepare-child")}; return child.status==='satisfied' ? ${run(parent, "first-parent")} : child;})(), (async()=>{const child=${call(good, "alternate-child")}; return child.status==='satisfied' ? ${run(parent, "second-parent")} : child;})()]); last=contenders.find(r=>['recovered','satisfied'].includes(r.status));`); break;
        case "schema-refresh":
          steps.push(`await tools.call({name:'fixture_transition',arguments:{}}); stale = ${call(prepare, "stale-schema")}; await tools.call({name:'harness_evaluate',arguments:{digest:${JSON.stringify(prepare.digest)},evaluationId:'refreshed-schema'}}); await tools.call({name:'harness_promote',arguments:{digest:${JSON.stringify(prepare.digest)},evaluationId:'refreshed-schema',expectedGeneration:0}}); if(second.impasseId) last = ${recover("refresh-schema", prepare)}; else { child = ${call(prepare, "refreshed-child")}; if(child.status==='satisfied') last = ${run(parent, "refreshed-parent")}; }`); break;
        case "partial-results":
          steps.push(`if(second.impasseId) { ${recover("owner-information")}; ${recover("refresh-schema")}; last = ${recover("verified-procedure")}; } else last = {status:'blocked',reason:'recovery-strategies-exhausted',partialResults:partial.map((r,i)=>({operationId:['partial-one','partial-two'][i],status:r.status}))}; const results = last.partialResults || []; receipt = await Promise.all(results.map(r=>tools.call({name:'harness_output',arguments:{operationId:r.operationId}})));`); break;
        case "owner-information": steps.push(`last = second.impasseId ? ${recover("owner-information")} : {status:'blocked',reason:'owner-information-required',partialResults:[{operationId:'partial-one',status:partial.status}]};`); break;
        case "strategy-exhaustion": steps.push(`if(second.impasseId) { await ${recover("owner-information").replace(/^await /, "")}; await ${recover("refresh-schema").replace(/^await /, "")}; last = ${recover("verified-procedure")}; } else last = {status:'blocked',reason:'no-retained-strategy-budget'};`); break;
        default: throw Error("Recovery scenario lacks an executable script");
      }
    }
    steps.push("return {first,second,last,child,partial,receipt,stale,contenders};"); program = steps.join("\n");
    ready = false;
    const coldDispatches = dispatches, start = performance.now();
    parentDeadline = fixture.scenario === "recovery-deadline" ? Date.now() + 1500 : undefined;
    await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "task", source: "telegram", chat: owner, text: fixture.prompt, at: Date.now(), ...(parentDeadline ? { deadlineAt: parentDeadline } : {}) });
    await host.drive();
    const events = await host.read(thread), state = harnessLibraryState(events, owner);
    const impasses = events.filter(e => e.type === "AikoHarnessImpasseRecorded"), settlements = events.filter(e => e.type === "AikoHarnessRecoverySettled");
    const checks: { criterion: string; passed: boolean; evidence: unknown }[] = [];
    const check = (criterion: string, passed: boolean, evidence: unknown) => checks.push({ criterion, passed, evidence });
    check("native-terminal", events.some(e => e.type === (fixture.scenario === "cancel-during-child" ? "TurnCancelled" : "TurnCompleted") && e.turn === "task"), events.filter(e => /Turn(Completed|Failed|Cancelled)/.test(e.type)).map(e => e.type));
    check("no-false-recovery", settlements.every(e => e.status !== "recovered" || state.witnesses.get(String(e.parentWitnessId))?.status === "satisfied"), settlements.map(e => ({ status: e.status, parentWitnessId: e.parentWitnessId })));
    const satisfied = [...state.witnesses.values()].filter(w => !w.operationId.startsWith("eval:") && w.status === "satisfied");
    switch (fixture.scenario) {
      case "equivalent-failure": check("third-identical-execution-stopped", taskDispatches === 2 && observed?.last?.status === "blocked", { taskDispatches, last: observed?.last }); break;
      case "receipt-reread": check("one-failure-no-impasse", taskDispatches === 1 && impasses.length === 0 && observed?.last?.status === "violated", { taskDispatches, impasses: impasses.length }); break;
      case "changed-evidence": check("changed-state-checked", taskDispatches === 3 && state.witnesses.get("changed-state")?.status === "satisfied", { taskDispatches, witness: state.witnesses.get("changed-state") }); break;
      case "ordinary-wait": check("legitimate-wait-completes", taskDispatches === 1 && impasses.length === 0 && satisfied.length === 1, { taskDispatches, impasses: impasses.length }); break;
      case "alternate-capability": check("exact-parent-outcome", taskDispatches === 3 && satisfied.some(w => w.contractDigest === parent.contractDigest), { taskDispatches, satisfied }); break;
      case "checked-prerequisite": check("checked-child-then-parent", taskDispatches === 4 && satisfied.some(w => w.harnessDigest === prepare.digest) && satisfied.some(w => w.harnessDigest === parent.digest), { taskDispatches, satisfied }); break;
      case "parent-still-failing": check("child-does-not-complete-parent", taskDispatches === 4 && satisfied.length === 1 && !satisfied.some(w => w.harnessDigest === parent.digest) && ["failed", "violated"].includes(observed?.last?.status), { taskDispatches, last: observed?.last }); break;
      case "owner-information": check("partial-result-receipt-returned", observed?.last?.status === "blocked" && observed?.last?.partialResults?.some((r: any) => r.operationId === "partial-one" && state.witnesses.get(r.operationId)?.status === "satisfied") === true, { partial: state.witnesses.get("partial-one"), last: observed?.last }); break;
      case "strategy-exhaustion": check("retained-two-strategy-limit", events.filter(e => e.type === "AikoHarnessRecoveryStarted").length === 2 && observed?.last?.reason === "recovery-strategies-exhausted" && taskDispatches === 2, { last: observed?.last, taskDispatches }); break;
      case "cancel-during-child": {
        const cancelled = events.findIndex(e => e.type === "CancellationRequested" && (e.invocation as any)?.id === "task");
        check("cancelled-parent-not-resumed", cancelled >= 0 && taskDispatches === 3 && !events.slice(cancelled + 1).some(e => e.type === "AikoHarnessRunStarted" && e.harnessDigest === parent.digest), { cancelled, taskDispatches });
        check("child-does-not-complete-cancelled-task", !settlements.some(e => e.status === "recovered") && !satisfied.some(w => w.harnessDigest === parent.digest), settlements); break;
      }
      case "recovery-deadline":
        check("original-deadline-preserved", taskDispatches === 2 && observed?.last?.reason === "parent-recovery-budget-expired" && impasses.some(e => e.deadlineAt === parentDeadline), { taskDispatches, parentDeadline, last: observed?.last, impasses }); break;
      case "concurrent-strategies":
        check("one-live-recovery-subgoal", maxActiveChildren === 1 && taskDispatches <= 4 && satisfied.some(w => w.harnessDigest === parent.digest), { maxActiveChildren, taskDispatches, contenders: observed?.contenders });
        check("retained-strategy-bound", events.filter(e => e.type === "AikoHarnessRecoveryStarted").length >= 1 && events.filter(e => e.type === "AikoHarnessRecoveryStarted").length <= 2, settlements); break;
      case "schema-refresh": {
        const refreshed = events.find(e => e.type === "AikoHarnessEvaluated" && e.id === "refreshed-schema");
        check("old-schema-does-not-authorize-dispatch", !events.some(e => e.type === "AikoHarnessRunStarted" && e.id === "stale-schema"), observed?.stale);
        check("fresh-schema-child-and-parent-checked", refreshed?.eligible === true && taskDispatches === 4 && satisfied.some(w => w.harnessDigest === prepare.digest && w.contextDigest === refreshed.contextDigest) && satisfied.some(w => w.harnessDigest === parent.digest && w.contextDigest === refreshed.contextDigest), { refreshed: refreshed?.id, satisfied, taskDispatches }); break;
      }
      case "partial-results":
        check("exhausted-parent-retains-useful-partials", observed?.last?.reason === "recovery-strategies-exhausted" && ["partial-one", "partial-two"].every(id => observed?.last?.partialResults?.some((r: any) => r.operationId === id && r.status === "satisfied")) && [14,16].every(output => observed?.receipt?.some((r: any) => r.output === output)) && taskDispatches === 4 && !satisfied.some(w => w.harnessDigest === parent.digest), { last: observed?.last, taskDispatches, outputs: observed?.receipt?.map((r: any) => r.output) }); break;
      case "unknown-write":
        check("uncertain-write-not-repeated", writes === 1, { writes, last: observed?.last });
        check("provider-receipt-reconciled-to-checked-outcome", state.witnesses.get("write-one")?.status === "satisfied", { observedReceipt: observed?.receipt, witness: state.witnesses.get("write-one") });
        check("original-uncertainty-kept-in-lineage", events.some(e => e.type === "AikoHarnessChecked" && e.id === "write-one" && (e.witness as any)?.status === "unknown"), "original-write-check"); break;
    }
    const beforeRestart = dispatches;
    await host.close(); host = await open(); await host.recover();
    check("restart-replay", harnessDigest(await host.read(thread)) === harnessDigest(events) && dispatches === beforeRestart, { before: beforeRestart, after: dispatches });
    return { id: fixture.id, category: fixture.category, split: fixture.split, arm, passed: checks.every(c => c.passed), checks, modelMode: "offline-scripted", actor: "aiko", instance: "cognitive-eval", thread, events,
      metrics: { elapsedMs: performance.now() - start, nativeModelCalls: events.filter(e => e.type === "ModelCalled").length, executions: dispatches, coldExecutions: coldDispatches, taskExecutions: taskDispatches, receiptReads, providerSpendUsd: 0, providerTokens: null, humanQuality: null },
      scope: "Actual actor/native tools; supplied strategies and synthetic provider receipts. No autonomous recovery-quality claim." };
  } finally { await host?.close(); nativeDb.close(); privateDb.close(); await rm(dir, { recursive: true, force: true }); }
}
