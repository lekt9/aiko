import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, Infer } from "tardie";
import { createBunHost } from "tardie/bun/host";
import type { Event } from "tardie/core/event";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryState, harnessLibraryAppendAllowed, harnessLibraryEventKey, type HarnessContract, type HarnessExecution, type HarnessLibraryBinding, type HarnessDigest } from "../src/harness-library.ts";
import { recoveryActive, recoveryPartialResults } from "../src/harness-recovery-log.ts";
import { HarnessRecovery, recoveryTask, type RecoveryTask } from "../src/harness-recovery.ts";
import { createHarnessSandboxBinding } from "../src/harness-sandbox.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { createAikoActor } from "../src/actor.ts";
import { harnessSkillDeriver } from "../src/harness-skill.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const signal = () => AbortSignal.timeout(5000);
const task: RecoveryTask = { thread: "user-123", turn: "parent", epoch: 0 };
function fixture() {
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  const events: Event[] = [{ type: "MessageReceived", id: task.turn, epoch: 0, at: Date.now(), text: "Return twice 7" },
    { type: "ToolCalled", callId: "native-run", turn: task.turn, epoch: 0, name: "harness_run" },
    { type: "ToolCalled", callId: "native-reconcile", turn: task.turn, epoch: 0, name: "harness_reconcile" },
    { type: "ToolCalled", callId: "native-recover", turn: task.turn, epoch: 0, name: "harness_recover" }];
  const journal = { read: async () => [...events], append: async (batch: Event[]) => {
    // The same synchronous commit fence is mounted on Bun and Worker hosts.
    const fresh = batch.filter(e => !events.some(old => harnessLibraryEventKey(old) === harnessLibraryEventKey(e)));
    if (!harnessLibraryAppendAllowed(fresh, () => events)) throw Error("Harness append fence rejected");
    events.push(...structuredClone(fresh));
  } };
  const verifier = { digest: harnessDigest("recovery-scale-check-v1"), evaluatorDigest: harnessDigest("recovery-scale-cases-v1"),
    cases: [{ id: "dev", input: { n: 2 }, split: "development" as const }, { id: "protected", input: { n: 13 }, split: "held-out" as const }],
    async verify({ input, output }: any) { return { passed: output === input.n * 2, evidence: ["independent-scale-equality"], quality: null }; } };
  let calls = 0, ready = false, revision = 1;
  const binding: HarnessLibraryBinding = { owner: "123", thread: task.thread, blobs: harnessBlobStore(sqliteWorkflowKV(db)), verifiers: new Map([[verifier.digest, verifier]]),
    context: async () => ({ placement: "local", runtimeDigest: harnessDigest("recovery-quickjs"), bindings: { revision } }),
    authorize: async () => true, authorizeEvaluation: async () => true, guard: () => {},
    execute: async (job, s) => {
      calls++;
      if (job.artifact.name === "prepare") ready = true;
      const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input, ready }, ambient: { at: 0, seed: job.operationId }, history: [] }, s);
      return result.error ? { status: "failed", evidence: ["quickjs-error"] } : { status: "succeeded", output: result.result as number, evidence: ["quickjs-executed"] };
    } };
  const contract: HarnessContract = { version: 1, outcome: "Return twice the supplied number", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, outputSchema: { type: "number" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {}, timeoutMs: 1000 };
  const library = new HarnessLibrary(binding, journal), recovery = new HarnessRecovery(binding, journal);
  const seed = async (name: string, code: string, effect: HarnessContract["effect"] = "read", promote = false) => {
    const contractDigest = await library.registerContract({ ...contract, effect });
    const digest = await library.record({ version: 1, name, description: "Synthetic recovery fixture", runtime: "javascript", entrypoint: "main.js", files: { "main.js": code }, dependencies: [], sources: [{ uri: "fixture:recovery", revision: "1", digest: harnessDigest(code), license: "test-fixture" }], contractDigest });
    if (promote) { await library.evaluate(digest, name, signal()); await library.promote(digest, name, 0, signal()); }
    return { digest, name, contractDigest, input: { n: 7 } };
  };
  const failTwice = async (digest: HarnessDigest) => {
    expect((await recovery.run(digest, { n: 7 }, "failure-1", task, "native-run", signal())).status).toBe("violated");
    const second = await recovery.run(digest, { n: 7 }, "failure-2", task, "native-run", signal());
    expect(second.status).toBe("violated");
    return (second as any).impasseId as string;
  };
  return { db, events, journal, binding, library, recovery, seed, failTwice, calls: () => calls, ready: (value: boolean) => { ready = value; }, revise: () => { revision++; } };
}

test("two equivalent checked failures retain the parent outcome and block a third execution across reconstruction", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;");
  const impasseId = await f.failTwice(bad.digest);
  const impasse = f.events.find(e => e.id === impasseId)!;
  expect(impasse).toMatchObject({ type: "AikoHarnessImpasseRecorded", task, goalRef: task.turn, failures: ["failure-1", "failure-2"], maxStrategies: 2, maxSubgoalDepth: 1, maxExecutions: 4 });
  expect(impasse.successCondition).toBe("Return twice the supplied number");
  const recovered = new HarnessRecovery(f.binding, f.journal);
  expect(await recovered.run(bad.digest, { n: 7 }, "failure-3", task, "native-run", signal())).toMatchObject({ status: "blocked", impasseId });
  expect(f.calls()).toBe(2);
  // A new input/context is a different problem. A receipt read is not a failure.
  await recovered.run(bad.digest, { n: 7 }, "failure-2", task, "native-run", signal());
  f.revise();
  expect((await recovered.run(bad.digest, { n: 7 }, "changed-state", task, "native-run", signal())).status).toBe("violated");
  expect(f.calls()).toBe(3);
});

test("a checked alternate preserves the original input and contract without completing the parent task or replaying", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), good = await f.seed("good", "return input.n * 2;", "read", true);
  const impasseId = await f.failTwice(bad.digest), before = f.calls();
  const input = { impasseId, strategy: "alternate-capability" as const, procedure: { name: good.name, contractDigest: good.contractDigest, input: good.input } };
  expect(await f.recovery.recover(input, task, "native-recover", signal())).toMatchObject({ status: "recovered", parentTaskCompleted: false, contractDigest: bad.contractDigest });
  expect(f.calls()).toBe(before + 1);
  expect(await new HarnessRecovery(f.binding, f.journal).recover(input, task, "native-recover", signal())).toMatchObject({ status: "recovered", freshness: "retained-recovery" });
  expect(f.calls()).toBe(before + 1);
  expect(await f.recovery.recover({ ...input, procedure: { ...input.procedure, input: { n: 8 } } }, task, "native-recover", signal())).toMatchObject({ status: "rejected", reason: "recovery-request-identity-conflict" });
  expect(f.events.some(e => e.type === "TurnCompleted")).toBe(false);
  expect((await f.library.procedure(bad.digest, signal())).recovery.examples).toMatchObject([{ strategy: "alternate-capability", childHarnessDigest: good.digest, scope: "historical-resolution-only" }]);
});

for (const parentReady of [false, true]) test(`prerequisite success requires an independently checked parent (${parentReady ? "recovered" : "still failing"})`, async () => {
  const f = fixture(), bad = await f.seed("parent", "return ready ? input.n * 2 : -1;"), child = await f.seed(parentReady ? "prepare" : "unrelated", "return input.n * 2;", parentReady ? "write" : "read", true);
  f.ready(false);
  const impasseId = await f.failTwice(bad.digest), before = f.calls();
  const result = await f.recovery.recover({ impasseId, strategy: "verified-procedure", procedure: { name: child.name, contractDigest: child.contractDigest, input: child.input } }, task, "native-recover", signal());
  expect(result).toMatchObject({ status: parentReady ? "recovered" : "failed", parentTaskCompleted: false });
  expect(f.calls()).toBe(before + 2);
  expect(f.events.find(e => e.type === "AikoHarnessChecked" && e.id === result.parentWitnessId)?.witness).toMatchObject({ status: parentReady ? "satisfied" : "violated", harnessDigest: bad.digest });
  if (!parentReady) {
    expect((await f.library.procedure(bad.digest, signal())).recovery.examples).toEqual([]);
    expect(await f.recovery.recover({ impasseId, strategy: "refresh-schema", procedure: { name: child.name, contractDigest: child.contractDigest, input: child.input } }, task, "native-recover", signal()))
      .toMatchObject({ status: "blocked", reason: "recovery-procedure-already-attempted" });
    expect(f.calls()).toBe(before + 2);
  }
});

test("recovery blockers return only checked partial receipts from the exact parent", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), good = await f.seed("partial", "return input.n * 2;");
  await f.recovery.run(good.digest, { n: 7 }, "partial-one", task, "native-run", signal());
  const impasseId = await f.failTwice(bad.digest);
  const result = await f.recovery.recover({ impasseId, strategy: "owner-information" }, task, "native-recover", signal());
  expect(result).toMatchObject({ status: "blocked", parentTaskCompleted: false, successCondition: "Return twice the supplied number",
    partialResults: [{ operationId: "partial-one", status: "satisfied", scope: "historical-checked-partial", outputTool: { name: "harness_output", arguments: { operationId: "partial-one" } } }], partialResultsTotal: 1, partialResultsTruncated: false });
  expect((await f.library.output("partial-one")).output).toBe(14);
  await f.recovery.recover({ impasseId, strategy: "refresh-schema" }, task, "native-recover", signal());
  expect(await f.recovery.recover({ impasseId, strategy: "verified-procedure" }, task, "native-recover", signal())).toMatchObject({ reason: "recovery-strategies-exhausted", partialResults: result.partialResults });
  const snapshot = recoveryPartialResults(f.events, "123", task);
  expect(recoveryPartialResults(f.events, "456", task).partialResults).toEqual([]);
  expect(recoveryPartialResults(f.events, "123", { ...task, epoch: 1 }).partialResults).toEqual([]);
  const association = f.events.find(e => e.type === "AikoHarnessTaskBound" && e.id === "partial-one")!;
  const checked = f.events.find(e => e.type === "AikoHarnessChecked" && e.id === "partial-one")!;
  expect(recoveryPartialResults(f.events.map(e => e === checked ? { ...e, witness: { ...(e.witness as Record<string, unknown>), status: "unknown" } } : e), "123", task).partialResults).toEqual([]);
  expect(recoveryPartialResults(f.events.map(e => e === association ? { ...e, task: { ...task, turn: "another-parent" } } : e), "123", task).partialResults).toEqual([]);
  expect(recoveryPartialResults(f.events.map(e => e.type === "AikoHarnessRunStarted" && e.id === "partial-one" ? { ...e, caseId: "held-out" } : e), "123", task).partialResults).toEqual([]);
  const settlement = f.events.find(e => e.type === "AikoHarnessRecoverySettled")!;
  const before = f.events.slice(0, f.events.indexOf(settlement));
  expect(harnessLibraryAppendAllowed([{ ...settlement, partialResults: [{ ...snapshot.partialResults[0], operationId: "foreign" }] }], () => before)).toBe(false);
  expect(await new HarnessRecovery(f.binding, f.journal).recover({ impasseId, strategy: "owner-information" }, task, "native-recover", signal())).toMatchObject({ partialResults: snapshot.partialResults, freshness: "retained-recovery" });
});

test("deadline and repeat-call blockers preserve checked partial work without dispatch or budget reset", async () => {
  const f = fixture(), good = await f.seed("partial", "return input.n * 2;"), bad = await f.seed("bad", "return -1;");
  await f.recovery.run(good.digest, { n: 8 }, "checked-partial", task, "native-run", signal());
  const impasseId = await f.failTwice(bad.digest), before = f.calls();
  const partial = recoveryPartialResults(f.events, "123", task);
  expect(await f.recovery.run(bad.digest, { n: 7 }, "third", task, "native-run", signal())).toMatchObject({
    reason: "equivalent-failure-impasse", ...partial, parentTaskCompleted: false, successCondition: "Return twice the supplied number" });
  // Declared expired retained budget, as in the existing deadline fixture.
  const retainedIndex=f.events.findIndex(e => e.type === "AikoHarnessImpasseRecorded" && e.id === impasseId);
  f.events[retainedIndex]={...f.events[retainedIndex]!,deadlineAt:Date.now()-1};
  for (const controller of [f.recovery, new HarnessRecovery(f.binding, f.journal)]) expect(await controller.recover({ impasseId, strategy: "owner-information" }, task, "native-recover", signal())).toMatchObject({
    reason: "parent-recovery-budget-expired", ...partial, parentTaskCompleted: false, successCondition: "Return twice the supplied number" });
  expect(f.calls()).toBe(before);
  expect(f.events.some(e => e.type === "AikoHarnessRecoveryStarted")).toBe(false);
  expect((await f.library.output("checked-partial")).output).toBe(16);
});

test("uncertain-write handoff retains only checked partial work, never claiming the unknown write failed", async () => {
  const f = fixture(), good = await f.seed("partial", "return input.n * 2;"), writer = await f.seed("writer", "return input.n * 2;", "write");
  await f.recovery.run(good.digest, { n: 8 }, "checked-partial", task, "native-run", signal());
  let writes = 0;
  f.binding.execute = async () => { writes++; return { status: "unknown", evidence: ["lost-acknowledgement"] }; };
  await f.recovery.run(writer.digest, { n: 7 }, "unknown-write", task, "native-run", signal());
  const result = await new HarnessRecovery(f.binding, f.journal).run(writer.digest, { n: 9 }, "new-write", task, "native-run", signal());
  expect(result).toMatchObject({ reason: "uncertain-write-needs-reconciliation", parentTaskCompleted: false,
    partialResults: [{ operationId: "checked-partial", status: "satisfied" }], partialResultsTotal: 1 });
  expect(writes).toBe(1);
  expect(harnessLibraryState(f.events, "123").witnesses.get("unknown-write")?.status).toBe("unknown");
});

test("two distinct strategies exhaust the retained budget and changed arguments cannot reset a strategy", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;");
  const impasseId = await f.failTwice(bad.digest);
  await f.recovery.recover({ impasseId, strategy: "owner-information" }, task, "native-recover", signal());
  await f.recovery.recover({ impasseId, strategy: "refresh-schema" }, task, "native-recover", signal());
  expect(await f.recovery.recover({ impasseId, strategy: "verified-procedure" }, task, "native-recover", signal())).toMatchObject({ status: "blocked", reason: "recovery-strategies-exhausted" });
  expect(f.events.filter(e => e.type === "AikoHarnessRecoveryStarted")).toHaveLength(2);
  expect(f.calls()).toBe(2);
});

test("an uncertain write blocks a different write capability and recovery transport, including after restart", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), write = await f.seed("write", "return input.n * 2;", "write", true);
  const impasseId = await f.failTwice(bad.digest);
  let writes = 0;
  f.binding.execute = async () => { writes++; return { status: "unknown", evidence: ["write-dispatched-response-lost"] }; };
  expect((await f.recovery.run(write.digest, { n: 7 }, "uncertain-write", task, "native-run", signal())).status).toBe("unknown");
  const recovered = new HarnessRecovery(f.binding, f.journal);
  expect(await recovered.run(write.digest, { n: 8 }, "other-write", task, "native-run", signal())).toMatchObject({ status: "blocked", reason: "uncertain-write-needs-reconciliation" });
  expect(await recovered.recover({ impasseId, strategy: "verified-procedure", procedure: { name: write.name, contractDigest: write.contractDigest, input: write.input } }, task, "native-recover", signal())).toMatchObject({ status: "failed", reason: "recovery-prerequisite-unchecked" });
  expect(writes).toBe(1);
});

test("lost sandbox acknowledgement reconciles a real retained write receipt without executing another transport", async () => {
  const f = fixture(), directory = await mkdtemp("/tmp/recovery-receipt-");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const environmentDigest = await sandboxEnvironment("reconciliation-fixture-v1");
  let writes = 0, reads = 0;
  const origin = "https://fixture.example";
  const sandbox = localHarnessSandbox({ owner: "123", environmentDigest, journal: await sandboxJobJournal(f.db, join(directory, "key")),
    send: async () => { writes++; return { status: 200, headers: { "content-type": "application/json" }, body: 14, classification: "application" }; } });
  const bridge = createHarnessSandboxBinding({ owner: "123", thread: task.thread, placement: "local", sandbox,
    current: async () => ({ owner: "123", active: true, runtimeDigest: environmentDigest, contextRef: "fixture-context", authorityRef: "fixture-write", sessionRevision: "1", effects: ["write"], origins: [origin], methods: ["POST"], budget: { requests: 1, wallMs: 1000, outputBytes: 4096 } }) });
  const seed = await f.seed("contract", "return input.n * 2;", "write");
  const graph = { schemaVersion: 2, executorAbi: "site-harness/1", siteId: "fixture", version: "1", sourceCaptureDigest: harnessDigest("fixture-capture"), allowedOrigins: [origin], actions: [{ id: "write", inputs: [{ name: "n", type: "number", required: true }], steps: [{ id: "post", dependsOn: [], method: "POST", origin, path: "/write", pathParameters: {}, query: {}, headers: {}, expectedStatuses: [200] }] }] };
  const hash = await f.library.record({ version: 1, name: "write-network", description: "Synthetic write", runtime: "network", entrypoint: "network.json", files: { "network.json": JSON.stringify({ graph, actionId: "write" }) }, dependencies: [], sources: [], contractDigest: seed.contractDigest });
  Object.assign(f.binding, bridge);
  f.binding.execute = async (job, s) => { await bridge.execute(job, s); throw Error("synthetic lost acknowledgement after sandbox custody"); };
  f.binding.reconcile = async (job, s) => { reads++; return bridge.reconcile!(job, s); };
  expect((await f.recovery.run(hash, { n: 7 }, "original-write", task, "native-run", signal())).status).toBe("unknown");
  const result = await f.recovery.reconcile("original-write", "read-one", task, "native-reconcile", signal());
  expect(result).toMatchObject({ status: "satisfied", operationId: "original-write", parentTaskCompleted: false });
  expect(writes).toBe(1); expect(reads).toBe(1);
  expect(f.events.find(e => e.type === "AikoHarnessChecked" && e.id === "original-write")?.witness).toMatchObject({ status: "unknown" });
  expect(harnessLibraryState(f.events, "123").witnesses.get("original-write")?.status).toBe("satisfied");
  expect((await f.library.output("original-write")).output).toBe(14);
  expect(await new HarnessRecovery(f.binding, f.journal).run(seed.digest, { n: 7 }, "different-transport", task, "native-run", signal())).toMatchObject({ status: "satisfied", reusedFromOperationId: "original-write" });
  expect(await f.recovery.reconcile("original-write", "read-one", task, "native-reconcile", signal())).toMatchObject({ status: "satisfied", freshness: "retained-operation" });
  expect(writes).toBe(1); expect(reads).toBe(1);
  const metadata = await f.library.procedure(hash, signal());
  expect(metadata.measurements.taskRuns).toMatchObject({ executions: 1, unknown: 1 });
  expect(metadata.measurements.reconciliationReads).toMatchObject({ executions: 1, satisfied: 1 });
  const projected = f.events.find(e => e.type === "AikoHarnessReconciled")!;
  expect(harnessLibraryState([...f.events, { ...f.events.find(e => e.type === "AikoHarnessChecked" && e.id === "original-write")! }], "123").witnesses.get("original-write")?.status).toBe("satisfied");
  const before = f.events.slice(0, f.events.indexOf(projected));
  expect(harnessLibraryAppendAllowed([{ ...projected, operationId: "foreign-operation" }], () => before)).toBe(false);
  expect(harnessLibraryAppendAllowed([{ ...projected, task: { ...task, epoch: 1 } }], () => before)).toBe(false);
});

test("unconfirmed or incorrect receipt reads cannot clear uncertainty and have a retained two-read bound", async () => {
  const f = fixture(), write = await f.seed("write", "return input.n * 2;", "write");
  let writes = 0, reads = 0;
  f.binding.execute = async () => { writes++; return { status: "unknown", evidence: ["lost"] }; };
  f.binding.reconcile = async () => { reads++; return reads === 1 ? { status: "unknown", evidence: ["still-running"] } : { status: "succeeded", output: 999, evidence: ["incorrect-provider-result"] }; };
  await f.recovery.run(write.digest, { n: 7 }, "write", task, "native-run", signal());
  for (const id of ["one", "one", "two", "three"]) expect((await f.recovery.reconcile("write", id, task, "native-reconcile", signal())).status).toBe("unknown");
  expect(reads).toBe(2); expect(writes).toBe(1);
  expect(harnessLibraryState(f.events, "123").witnesses.get("write")?.status).toBe("unknown");
  expect(f.events.some(e => e.type === "AikoHarnessReconciled")).toBe(false);
  expect(await f.recovery.run(write.digest, { n: 8 }, "other", task, "native-run", signal())).toMatchObject({ status: "blocked", reason: "uncertain-write-needs-reconciliation" });
});

test("checked reconciliation resumes after projection storage loss and cannot escape parent cancellation", async () => {
  const f = fixture(), write = await f.seed("write", "return input.n * 2;", "write");
  let reads = 0;
  f.binding.execute = async () => ({ status: "unknown", evidence: ["lost"] });
  f.binding.reconcile = async () => { reads++; return { status: "succeeded", output: 14, evidence: ["provider-receipt"] }; };
  await f.recovery.run(write.digest, { n: 7 }, "write", task, "native-run", signal());
  const append = f.journal.append;
  f.journal.append = async batch => { if (batch.some(e => e.type === "AikoHarnessReconciled")) throw Error("storage unavailable"); return append(batch); };
  await expect(f.recovery.reconcile("write", "one", task, "native-reconcile", signal())).rejects.toThrow("storage unavailable");
  expect(reads).toBe(1);
  f.journal.append = append;
  expect(await new HarnessRecovery(f.binding, f.journal).reconcile("write", "one", task, "native-reconcile", signal())).toMatchObject({ status: "satisfied" });
  expect(reads).toBe(1);
  f.events.push({ type: "CancellationRequested", invocation: { method: "message", id: task.turn, epoch: task.epoch } });
  await expect(f.recovery.reconcile("write", "two", task, "native-reconcile", signal())).rejects.toThrow("no longer active");
  expect(reads).toBe(1);
});

for (const fault of ["before-read", "after-read", "revoked", "context", "erased", "deadline"] as const) test(`reconciliation respects ${fault} without manufacturing a completed parent`, async () => {
  const f = fixture(), write = await f.seed("write", "return input.n * 2;", "write");
  let reads = 0;
  f.binding.execute = async () => ({ status: "unknown", evidence: ["lost"] });
  const cancel = () => f.events.push({ type: "CancellationRequested", invocation: { method: "message", id: task.turn, epoch: task.epoch } });
  f.binding.reconcile = async () => { reads++; if (fault === "after-read") cancel(); return { status: "succeeded", output: 14, evidence: ["provider-receipt"] }; };
  await f.recovery.run(write.digest, { n: 7 }, "write", task, "native-run", signal());
  const association = f.events.find(e => e.type === "AikoHarnessTaskBound" && e.id === "write")!;
  if (fault === "before-read") {
    const append = f.journal.append;
    f.journal.append = async batch => { await append(batch); if (batch.some(e => e.type === "AikoHarnessRunStarted" && e.receiptOf === "write")) cancel(); };
  }
  if (fault === "revoked") f.binding.authorize = async () => false;
  if (fault === "context") f.revise();
  if (fault === "erased") await f.binding.blobs.erase!("123", association.inputRef as HarnessDigest, "erase-input");
  if (fault === "deadline") f.events[0] = { ...f.events[0]!, deadlineAt: Date.now() - 1 };
  const result = await f.recovery.reconcile("write", "one", task, "native-reconcile", signal()).catch(() => ({ status: "unknown" }));
  expect(result.status).toBe("unknown");
  expect(reads).toBe(fault === "after-read" ? 1 : 0);
  expect(f.events.some(e => e.type === "AikoHarnessReconciled")).toBe(false);
  expect(harnessLibraryState(f.events, "123").witnesses.get("write")?.status).toBe("unknown");
  expect(f.events.some(e => e.type === "TurnCompleted")).toBe(false);
});

test("concurrent receipt requests cannot exceed their parent's retained read budget", async () => {
  const f = fixture(), write = await f.seed("write", "return input.n * 2;", "write");
  let reads = 0, release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  f.binding.execute = async () => ({ status: "unknown", evidence: ["lost"] });
  f.binding.reconcile = async () => { reads++; await hold; return { status: "unknown", evidence: ["still-running"] }; };
  await f.recovery.run(write.digest, { n: 7 }, "write", task, "native-run", signal());
  const attempts = ["one", "two", "three", "four"].map(id => f.recovery.reconcile("write", id, task, "native-reconcile", signal()).catch(() => ({ status: "unknown" })));
  // Let both admitted readers reach the held provider read. The others must
  // lose the native append transaction, not reserve independent retry loops.
  for (let i = 0; i < 100 && reads < 2; i++) await new Promise(resolve => setTimeout(resolve, 1));
  release();
  expect((await Promise.all(attempts)).every(result => result.status === "unknown")).toBe(true);
  expect(reads).toBe(2);
  expect(f.events.filter(e => e.type === "AikoHarnessRunStarted" && e.receiptOf === "write")).toHaveLength(2);
});

test("task cancellation and mismatched owner/epoch cannot start recovery", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;");
  const impasseId = await f.failTwice(bad.digest);
  expect(recoveryTask(f.events, "456", task.thread, { callId: "native-run", turn: task.turn })).toBeUndefined();
  expect(recoveryTask(f.events, "123", task.thread, { callId: "not-called", turn: task.turn })).toBeUndefined();
  await expect(f.recovery.recover({ impasseId, strategy: "owner-information" }, { ...task, epoch: 1 }, "native-recover", signal())).rejects.toThrow("no longer active");
  f.events.push({ type: "CancellationRequested", invocation: { method: "message", id: task.turn, epoch: 0 } });
  await expect(f.recovery.recover({ impasseId, strategy: "owner-information" }, task, "native-recover", signal())).rejects.toThrow("no longer active");
  expect(f.events.filter(e => e.type === "AikoHarnessRecoveryStarted")).toHaveLength(0);
});

test("native recovery task association cannot borrow explicitly foreign parent or tool rows", () => {
  const f = fixture();
  expect(recoveryActive(f.events, "123", task)).toBe(true); // Legacy native rows need no redundant owner tag.
  const foreignParent = f.events.map(e => e.type === "MessageReceived" ? { ...e, owner: "456" } : e);
  expect(recoveryActive(foreignParent, "123", task)).toBe(false);
  const foreignCall = f.events.map(e => e.type === "ToolCalled" ? { ...e, owner: "456" } : e);
  expect(recoveryTask(foreignCall, "123", task.thread, { callId: "native-run", turn: task.turn })).toBeUndefined();
  expect(recoveryActive([...f.events, { type: "TurnCancelled", turn: task.turn, epoch: 0, owner: "456" }], "123", task)).toBe(true);
  expect(recoveryActive([...f.events, { type: "TurnCancelled", turn: task.turn, epoch: 0, owner: "123" }], "123", task)).toBe(false);
});

for (const shape of ["message", "call", "both"] as const) test(`atomic impasse admission retains the exact native parent deadline (${shape})`, async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), deadlineAt = Date.now() + 30_000;
  f.events[0] = { ...f.events[0]!, ...(shape !== "call" ? { deadlineAt } : {}),
    ...(shape !== "message" ? { call: { deadlineAt: deadlineAt + (shape === "both" ? 1_000 : 0) } } : {}) };
  const impasseId = await f.failTwice(bad.digest), index = f.events.findIndex(e => e.type === "AikoHarnessImpasseRecorded" && e.id === impasseId);
  const impasse = f.events[index]!, before = f.events.slice(0, index);
  expect(impasse.deadlineAt).toBe(deadlineAt);
  expect(harnessLibraryAppendAllowed([{ ...impasse, deadlineAt: deadlineAt + 1 }], () => before)).toBe(false);
  expect(harnessLibraryAppendAllowed([impasse], () => before)).toBe(true);
  expect(harnessLibraryAppendAllowed([{ ...impasse, deadlineAt: deadlineAt - 1 }], () => before)).toBe(true);
  expect(f.calls()).toBe(2);
});

test("malformed original recovery deadlines cannot fall back to a fresh allowance", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;");
  const impasseId = await f.failTwice(bad.digest), index = f.events.findIndex(e => e.type === "AikoHarnessImpasseRecorded" && e.id === impasseId);
  const impasse = f.events[index]!, before = f.events.slice(0, index);
  for (const deadlineAt of ["60000", null, -1, NaN, Infinity, 1.5]) {
    const invalid = before.map(e => e.type === "MessageReceived" ? { ...e, deadlineAt } : e);
    expect(harnessLibraryAppendAllowed([impasse], () => invalid)).toBe(false);
  }
});

test("the host commit fence serializes competing strategy starts", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), child = await f.seed("good", "return input.n * 2;", "read", true);
  const impasseId = await f.failTwice(bad.digest);
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(r => began = r), hold = new Promise<void>(r => release = r);
  const execute = f.binding.execute;
  f.binding.execute = async (job, s) => { began(); await hold; return execute(job, s); };
  const first = f.recovery.recover({ impasseId, strategy: "verified-procedure", procedure: { name: child.name, contractDigest: child.contractDigest, input: child.input } }, task, "native-recover", signal());
  await started;
  expect(await new HarnessRecovery(f.binding, f.journal).recover({ impasseId, strategy: "refresh-schema" }, task, "native-recover", signal())).toMatchObject({ status: "blocked", reason: "recovery-subgoal-already-active" });
  const retained = f.events.find(e => e.type === "AikoHarnessRecoveryStarted")!;
  expect(harnessLibraryAppendAllowed([{ ...retained, id: harnessDigest("racing-start"), strategy: "refresh-schema", claimId: "racer" }], () => f.events)).toBe(false);
  release(); await first;
  expect(f.events.filter(e => e.type === "AikoHarnessRecoveryStarted")).toHaveLength(1);
});

test("restart after a checked prerequisite resumes only the unchecked parent within the original budget", async () => {
  const f = fixture(), bad = await f.seed("parent", "return ready ? input.n * 2 : -1;"), child = await f.seed("prepare", "return input.n * 2;", "write", true);
  f.ready(false);
  const impasseId = await f.failTwice(bad.digest), before = f.calls();
  const request = { impasseId, strategy: "verified-procedure" as const, procedure: { name: child.name, contractDigest: child.contractDigest, input: child.input } };
  const append = f.journal.append;
  // Simulate loss of storage access at the next dispatch boundary, including
  // inability to write a terminal result. The checked child remains durable.
  let crashed = false;
  f.journal.append = async batch => {
    if (batch.some(e => e.type === "AikoHarnessTaskBound" && e.stage === "parent")) crashed = true;
    if (crashed) throw Error("simulated process storage loss");
    return append(batch);
  };
  await expect(f.recovery.recover(request, task, "native-recover", signal())).rejects.toThrow("storage loss");
  expect(f.calls()).toBe(before + 1);
  expect(f.events.filter(e => e.type === "AikoHarnessRecoverySettled")).toHaveLength(0);
  const originalStart = f.events.find(e => e.type === "AikoHarnessRecoveryStarted")!;
  f.journal.append = append;
  expect(await new HarnessRecovery(f.binding, f.journal).recover(request, task, "native-recover", signal())).toMatchObject({ status: "recovered", parentTaskCompleted: false });
  expect(f.calls()).toBe(before + 2);
  expect(f.events.filter(e => e.type === "AikoHarnessRecoveryStarted")).toEqual([originalStart]);
});

test("expired original budget and a retired procedure cannot authorize a recovery execution", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), good = await f.seed("good", "return input.n * 2;", "read", true);
  const impasseId = await f.failTwice(bad.digest), before = f.calls();
  const head = f.events.find(e => e.type === "AikoHarnessPromoted")!;
  await f.journal.append([{ ...head, type: "AikoHarnessRetired", id: "retired-good", previousGeneration: 1, generation: 2 }]);
  expect(await f.recovery.recover({ impasseId, strategy: "alternate-capability", procedure: { name: good.name, contractDigest: good.contractDigest, input: good.input } }, task, "native-recover", signal())).toMatchObject({ status: "blocked", reason: "current-verified-procedure-unavailable" });
  // This fixture represents a retained impasse loaded after its deadline.
  const retainedIndex = f.events.findIndex(e => e.type === "AikoHarnessImpasseRecorded");
  f.events[retainedIndex] = { ...f.events[retainedIndex]!, deadlineAt: Date.now() - 1 };
  expect(await f.recovery.recover({ impasseId, strategy: "owner-information" }, task, "native-recover", signal())).toMatchObject({ status: "blocked", reason: "parent-recovery-budget-expired" });
  expect(f.calls()).toBe(before);
});

test("cancellation arriving after child verification prevents parent dispatch", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), good = await f.seed("good", "return input.n * 2;", "read", true);
  const impasseId = await f.failTwice(bad.digest), before = f.calls();
  const append = f.journal.append;
  f.journal.append = async batch => {
    await append(batch);
    if (batch.some(e => e.type === "AikoHarnessChecked" && String(e.id).endsWith(":child")))
      f.events.push({ type: "CancellationRequested", invocation: { method: "message", id: task.turn, epoch: task.epoch } });
  };
  await expect(f.recovery.recover({ impasseId, strategy: "verified-procedure", procedure: { name: good.name, contractDigest: good.contractDigest, input: good.input } }, task, "native-recover", signal())).rejects.toThrow("append fence");
  expect(f.calls()).toBe(before + 1);
  expect(f.events.some(e => e.type === "AikoHarnessRunStarted" && String(e.id).endsWith(":parent"))).toBe(false);
  expect(f.events.some(e => e.type === "AikoHarnessRecoverySettled" && e.status === "recovered")).toBe(false);
});

test("a concurrent follower cannot settle the leader's still-running recovery as unknown", async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), good = await f.seed("good", "return input.n * 2;", "read", true);
  const impasseId = await f.failTwice(bad.digest), before = f.calls();
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(r => began = r), hold = new Promise<void>(r => release = r), execute = f.binding.execute;
  f.binding.execute = async (job, s) => { began(); await hold; return execute(job, s); };
  const request = { impasseId, strategy: "alternate-capability" as const, procedure: { name: good.name, contractDigest: good.contractDigest, input: good.input } };
  const leader = f.recovery.recover(request, task, "native-recover", signal());
  await started;
  expect(await new HarnessRecovery(f.binding, f.journal).recover(request, task, "native-recover", signal())).toMatchObject({ status: "unknown", reason: "recovery-execution-pending-or-interrupted" });
  expect(f.events.some(e => e.type === "AikoHarnessRecoverySettled")).toBe(false);
  release();
  expect(await leader).toMatchObject({ status: "recovered" });
  expect(f.calls()).toBe(before + 1);
});

for (const backend of ["bun", "account"] as const) for (const mode of ["recovery", "reconciliation"] as const) test(`${backend}: native code tool ${mode} retains its checked outcome through restart`, async () => {
  const f = fixture(), bad = await f.seed("bad", "return -1;"), good = await f.seed("good", "return input.n * 2;", "read", true);
  const writer = mode === "reconciliation" ? await f.seed("writer", "return input.n * 2;", "write") : undefined;
  let writes = 0, reads = 0;
  if (writer) {
    const execute = f.binding.execute, receipts = new Map<string, { inputDigest: HarnessDigest; execution: HarnessExecution }>();
    f.binding.execute = async (job, s) => {
      writes++;
      receipts.set(job.operationId, { inputDigest: harnessDigest(job.input), execution: await execute(job, s) });
      return { status: "unknown", evidence: ["synthetic-ack-lost-after-quickjs-receipt"] };
    };
    f.binding.reconcile = async job => {
      reads++;
      const receipt = receipts.get(job.operationId);
      return receipt?.inputDigest === harnessDigest(job.input) ? receipt.execution : { status: "unknown", evidence: ["original-receipt-unavailable"] };
    };
  }
  const directory = await mkdtemp("/tmp/harness-recovery-host-"); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
  const harness = new CodeHarness("123", task.thread, runCodeSegment, s => s);
  const definition = createAikoActor({ owner: "123", memory: { owner: "123", thread: task.thread, stateDir: directory, redact: s => s,
    readPage: async (after, limit) => host.readPage(task.thread, after, limit) },
    harnessLibrary: f.binding, codeHarness: harness, cognitiveRecovery: true, background: false, requireThinkFeel: false,
    voice: input => Effect.succeed({ text: input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : "Fixture reply", source: "template" as const }) });
  const program = writer ? `const first = await tools.call({name:'harness_run',arguments:{digest:${JSON.stringify(writer.digest)},input:{n:7},operationId:'native-write'}}); if(first.status !== 'unknown') throw Error('expected uncertain write'); const checked = await tools.call({name:'harness_reconcile',arguments:{operationId:'native-write',reconciliationId:'read-one'}}); if(checked.status !== 'satisfied') throw Error('receipt did not pass original checker'); return checked;` : `const run = (operationId) => tools.call({name:'harness_run',arguments:{digest:${JSON.stringify(bad.digest)},input:{n:7},operationId}}); await run('native-first'); const failure = await run('native-second'); const stopped = await run('native-third'); if (stopped.status !== 'blocked') throw Error('repeated failure dispatched'); return await tools.call({name:'harness_recover',arguments:{impasseId:failure.impasseId,strategy:'alternate-capability',procedure:${JSON.stringify({ name: good.name, contractDigest: good.contractDigest, input: good.input })}}});`;
  let models = 0;
  const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "recovery" } }), react: (request: any) => {
    models++;
    const returned = request.trajectory.findLast((e: Event) => e.type === "ToolReturned" && e.turn === request.identity.turn);
    if (!returned) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "compose-recovery", arguments: { code: program } });
    expect(returned.result.error).toBeUndefined();
    return Effect.succeed({ kind: "complete" as const, output: "Recovery checked" });
  } });
  const indexerThread = "background-123-indexer";
  const indexer = actor({ name: "aiko", methods: {}, components: [harnessSkillDeriver(f.binding)] });
  const indexerInference = Layer.succeed(Infer, {
    resolve: () => { throw Error("Indexer must not request inference"); },
    react: () => Effect.die(Error("Indexer must not request inference")),
  });
  const common = { actorName: "aiko", actorInstance: "recovery-test", actorFor: (thread: string) => {
    if (thread === task.thread) return definition;
    if (thread === indexerThread) return indexer;
    throw Error("Unexpected fixture thread");
  },
    layersFor: (thread: string) => thread === task.thread ? Layer.merge(harness.inference(model), harness.sandboxLayer()) : indexerInference, canAppend: (_thread: string, batch: readonly Event[], read: () => readonly Event[]) => harnessLibraryAppendAllowed(batch, read) };
  const open = () => backend === "bun" ? createBunHost({ ...common, database: join(directory, "native.sqlite") })
    : createCloudflareAccountHost({ ...common, storage, ownsThread: t => t === task.thread || t === indexerThread });
  let host = await open(); cleanups.push(() => host.close());
  for (const row of f.events.filter(e => e.type.startsWith("AikoHarness"))) await host.commitRoot(host.self(task.thread), row);
  const before = f.calls();
  const parentDeadline = Date.now() + 30_000;
  await host.commitRoot(host.self(task.thread), { type: "MessageReceived", id: "native-parent", text: "Use the capability and recover checked failures", at: Date.now(), deadlineAt: parentDeadline });
  await host.wake(task.thread);
  const events = await host.read(task.thread);
  if (writer) {
    expect(events.find(e => e.type === "AikoHarnessReconciled")).toMatchObject({ operationId: "native-write", task: { thread: task.thread, turn: "native-parent", epoch: 0 } });
    expect(harnessLibraryState(events, "123").witnesses.get("native-write")?.status).toBe("satisfied");
    expect(events.find(e => e.type === "AikoHarnessChecked" && e.id === "native-write")?.witness).toMatchObject({ status: "unknown" });
    expect(f.calls()).toBe(before + 1);
    expect(writes).toBe(1); expect(reads).toBe(1);
  } else {
    expect(events.find(e => e.type === "AikoHarnessImpasseRecorded")).toMatchObject({ task: { thread: task.thread, turn: "native-parent", epoch: 0 }, deadlineAt: parentDeadline });
    expect(events.find(e => e.type === "AikoHarnessRecoverySettled")).toMatchObject({ status: "recovered", parentTaskCompleted: false });
    expect(f.calls()).toBe(before + 3);
  }
  const modelCount = models;
  await host.close(); host = await open(); await host.recover();
  expect(await host.read(task.thread)).toEqual(events);
  expect(f.calls()).toBe(before + (writer ? 1 : 3)); expect(models).toBe(modelCount);
  if (writer) { expect(writes).toBe(1); expect(reads).toBe(1); }
  const evidence = process.env.AIKO_COGNITIVE_EVIDENCE_DIR;
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, `${backend}-${mode}-events.json`), JSON.stringify({ actor: "aiko", instance: "recovery-test", thread: task.thread, models, executions: f.calls() - before, writes, receiptReads: reads, events }, null, 2));
  }
});
