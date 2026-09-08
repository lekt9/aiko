import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import { component } from "tardie/core/component";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryEventKey, harnessLibraryState, harnessLibraryTools, type HarnessArtifact, type HarnessContract, type HarnessLibraryBinding, type HarnessVerifier } from "../src/harness-library.ts";

const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = new Database(":memory:"); dbs.push(db);
  const blobs = harnessBlobStore(sqliteWorkflowKV(db));
  const events: Event[] = [];
  const journal = { read: async () => [...events], append: async (batch: Event[]) => {
    for (const event of batch) if (!events.some(e => harnessLibraryEventKey(e) === harnessLibraryEventKey(event))) events.push(structuredClone(event));
  } };
  const verifier: HarnessVerifier = {
    digest: harnessDigest("trusted-scale-check-v1"), evaluatorDigest: harnessDigest("scale-cases-v1"),
    cases: [{ id: "positive", input: { n: 2 }, split: "development" }, { id: "negative", input: { n: -13 }, split: "held-out" }],
    async verify({ input, output }) { return { passed: output === (input as { n: number }).n * 2, evidence: ["independent-scale-equality"], quality: output === (input as { n: number }).n * 2 ? 1 : 0 }; },
  };
  let calls = 0;
  const binding: HarnessLibraryBinding = {
    owner: "123", thread: "user-123", blobs, verifiers: new Map([[verifier.digest, verifier]]),
    context: async () => ({ placement: "local", runtimeDigest: harnessDigest("quickjs-fixture"), bindings: { sessionRevision: 1 } }),
    authorize: async () => true, guard: () => {},
    execute: async (job, signal) => {
      calls++;
      const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, signal);
      return result.error ? { status: "failed", evidence: ["quickjs-error"] } : { status: "succeeded", output: result.result as number, evidence: ["quickjs-executed"] };
    },
  };
  const contract: HarnessContract = { version: 1, outcome: "Return twice the supplied number", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, outputSchema: { type: "number" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {}, timeoutMs: 2000 };
  const library = new HarnessLibrary(binding, journal);
  const seed = async (code = "return input.n * 2;") => {
    const contractDigest = await library.registerContract(contract);
    const artifact: HarnessArtifact = { version: 1, name: "scale", description: "Scale numbers", runtime: "javascript", entrypoint: "main.js", files: { "main.js": code }, dependencies: [], sources: [{ uri: "fixture:scale", revision: "1", digest: harnessDigest(code), license: "test-fixture" }], contractDigest };
    return library.record(artifact);
  };
  return { db, binding, events, journal, verifier, contract, library, seed, calls: () => calls };
}
const signal = () => AbortSignal.timeout(5000);

test("procedure metadata distinguishes a saved example from independently checked input transfer without launching learning", async () => {
  const f = fixture(), hash = await f.seed();
  await f.library.run(hash, { n: 7 }, "saved-example", signal());
  const before = f.events.length, calls = f.calls();
  const saved = await f.library.procedure(hash, signal());
  expect(saved).toMatchObject({ basis: "saved-example", currentRoute: false, transfer: null });
  expect(saved.measurements.taskRuns).toMatchObject({ executions: 1, satisfied: 1, executorModelCalls: null, executorTokens: null });
  expect(saved.measurements.breakEvenUses).toBeNull();
  expect(f.events).toHaveLength(before); expect(f.calls()).toBe(calls);
  await f.library.evaluate(hash, "transfer", signal()); await f.library.promote(hash, "transfer", 0, signal());
  const learned = await f.library.procedure(hash, signal());
  expect(learned).toMatchObject({ basis: "verified-transfer", currentRoute: true, transfer: { eligible: true, novelHeldOutInputs: 1, checkedCases: 2 } });
  expect(learned.parameters).toEqual(f.contract.inputSchema);
  expect(JSON.stringify(learned)).not.toContain('"n":-13');
  expect(learned.measurements.coldEvaluation).toMatchObject({ executions: 2, satisfied: 2 });
  expect(harnessLibraryTools(f.binding).some(t => t.spec.name === "harness_procedure")).toBe(true);
});

test("renamed development inputs cannot satisfy an opted-in transfer contract", async () => {
  const f = fixture();
  f.contract.transfer = { version: 1, minimumNovelHeldOutInputs: 1 };
  (f.verifier.cases[1] as any).input = { n: 2 };
  const hash = await f.seed();
  expect((await f.library.evaluate(hash, "duplicated-input", signal())).eligible).toBe(true);
  expect(await f.library.transferEvidence(hash, "duplicated-input", signal())).toMatchObject({ eligible: false, novelHeldOutInputs: 0, reason: "insufficient-novel-held-out-inputs" });
  await expect(f.library.promote(hash, "duplicated-input", 0, signal())).rejects.toThrow("Independent transfer evidence");
  expect(harnessLibraryState(f.events, "123").heads.size).toBe(0);
});

test("transfer counts unique new inputs, and reuse still checks exact current authority and context", async () => {
  const f = fixture(); f.contract.transfer = { version: 1, minimumNovelHeldOutInputs: 2 };
  (f.verifier.cases as any[]).push({ id: "another-input", input: { n: 19 }, split: "held-out" });
  const hash = await f.seed();
  await f.library.evaluate(hash, "diverse-inputs", signal()); await f.library.promote(hash, "diverse-inputs", 0, signal());
  const before = f.calls();
  expect((await f.library.call("scale", harnessDigest(f.contract), { n: 103 }, "warm-new-input", signal())).status).toBe("satisfied");
  expect(f.calls()).toBe(before + 1);
  f.binding.authorize = async () => false;
  expect((await f.library.call("scale", harnessDigest(f.contract), { n: 104 }, "revoked-warm-input", signal())).status).toBe("blocked");
  expect(f.calls()).toBe(before + 1);
  f.binding.context = async () => ({ placement: "local", runtimeDigest: harnessDigest("changed-runtime"), bindings: {} });
  expect(await f.library.procedure(hash, signal())).toMatchObject({ basis: "saved-example", currentRoute: false });
  await expect(f.library.call("scale", harnessDigest(f.contract), { n: 105 }, "stale-warm-input", signal())).rejects.toThrow("No verified harness");
  expect(f.calls()).toBe(before + 1);
});

test("erased or mismatched held-out input custody cannot retain transfer eligibility", async () => {
  for (const change of ["mismatch", "erased"] as const) {
    const f = fixture(); f.contract.transfer = { version: 1, minimumNovelHeldOutInputs: 1 };
    const hash = await f.seed();
    await f.library.evaluate(hash, "current", signal()); await f.library.promote(hash, "current", 0, signal());
    const heldIndex = f.events.findIndex(e => e.type === "AikoHarnessRunStarted" && e.caseId === "negative");
    if (change === "mismatch") {
      const development = f.events.find(e => e.type === "AikoHarnessRunStarted" && e.caseId === "positive")!;
      f.events[heldIndex] = { ...f.events[heldIndex]!, inputRef: development.inputRef };
    } else await f.binding.blobs.erase!("123", f.events[heldIndex]!.inputRef as any, "forget-held-out-input");
    expect((await f.library.transferEvidence(hash, "current", signal())).eligible).toBe(false);
    const before = f.calls();
    await expect(f.library.call("scale", harnessDigest(f.contract), { n: 7 }, "after-evidence-loss", signal())).rejects.toThrow("Independent transfer evidence");
    expect(f.calls()).toBe(before);
  }
});

test("procedure cost summaries retain failed work and separate executor measurements from unknown learning costs", async () => {
  const f = fixture(), execute = f.binding.execute;
  f.binding.execute = async (job, s) => ({ ...await execute(job, s), costUsd: 0.02, measurements: { networkRequests: 0, browserStarts: 0, modelCalls: 2, tokens: 40 } });
  const hash = await f.seed("return input.n === 5 ? 0 : input.n * 2;");
  await f.library.evaluate(hash, "checked", signal()); await f.library.promote(hash, "checked", 0, signal());
  await f.library.run(hash, { n: 5 }, "failed-transfer-example", signal());
  const procedure = await f.library.procedure(hash, signal());
  expect(procedure.measurements.coldEvaluation).toMatchObject({ executions: 2, costUsd: 0.04, executorModelCalls: 4, executorTokens: 80 });
  expect(procedure.measurements.taskRuns).toMatchObject({ executions: 1, failed: 1, costUsd: 0.02 });
  expect(procedure.measurements.acquisitionAndGenerationCostUsd).toBeNull();
  expect(procedure.measurements.breakEvenUses).toBeNull();
});

test("verified promotion remains independent of passive documentation and reuses fresh inputs after replay", async () => {
  const f = fixture(), hash = await f.seed();
  const evaluation = await f.library.evaluate(hash, "baseline", signal());
  expect(evaluation.eligible).toBe(true);
  const head = await f.library.promote(hash, "baseline", 0, signal());
  expect(head.skillRef).toBeUndefined();
  expect(await f.library.skill(hash)).toEqual({ status: "pending", harnessDigest: hash });
  const before = f.calls();
  const recovered = new HarnessLibrary(f.binding, f.journal);
  expect((await recovered.list()).active).toHaveLength(1);
  expect(f.calls()).toBe(before);
  const witness = await recovered.run(hash, { n: 17 }, "fresh", signal());
  expect(witness.status).toBe("satisfied");
  expect(await f.binding.blobs.get("123", witness.outputRef!)).toBe(34);
  expect(await recovered.run(hash, { n: 17 }, "fresh", signal())).toEqual(witness);
  expect(f.calls()).toBe(before + 1);
  await expect(recovered.run(hash, { n: 18 }, "fresh", signal())).rejects.toThrow("identity conflict");
  expect(harnessLibraryState(f.events, "456").heads.size).toBe(0);
  await expect(f.binding.blobs.get("456", hash)).rejects.toThrow("unavailable");
});

test("plausible schema-valid answer and development-only success cannot pass the fixed verifier", async () => {
  const f = fixture(), hash = await f.seed("return 4;");
  expect((await f.library.evaluate(hash, "bad", signal())).eligible).toBe(false);
  await expect(f.library.promote(hash, "bad", 0, signal())).rejects.toThrow("Passing evaluation");
  expect(f.events.filter(e => e.type === "AikoHarnessChecked").map(e => (e.witness as any).status)).toEqual(["satisfied", "violated"]);
  const spec = harnessLibraryTools(f.binding).map(t => t.spec.name);
  expect(spec).not.toContain("harness_register_contract");
  await expect(f.library.registerContract({ ...f.contract, verifierDigest: harnessDigest("candidate supplied checker") })).rejects.toThrow("Trusted");
});

test("evaluation witnesses never expose development or held-out answers through ordinary output lookup", async () => {
  const f = fixture(), hash = await f.seed();
  const evaluated = await f.library.evaluate(hash, "private-evaluation", signal());
  expect(evaluated.eligible).toBe(true);
  for (const operationId of evaluated.witnessIds as string[]) await expect(f.library.output(operationId)).rejects.toThrow("unavailable");
  expect((await f.library.run(hash, { n: 7 }, "user-task", signal())).status).toBe("satisfied");
  expect((await f.library.output("user-task")).output).toBe(14);
});

test("trusted map keys cannot conceal a different verifier identity at registration or execution", async () => {
  const f = fixture();
  const original = f.verifier.digest;
  f.verifier.digest = harnessDigest("different-checker");
  await expect(f.library.registerContract(f.contract)).rejects.toThrow("Trusted harness contract");
  expect(f.events).toHaveLength(0);
  f.verifier.digest = original;
  const hash = await f.seed();
  await f.library.evaluate(hash, "consistent", signal());
  const before = f.calls();
  f.verifier.digest = harnessDigest("replacement-checker");
  await expect(f.library.run(hash, { n: 7 }, "wrong-checker", signal())).rejects.toThrow("Pinned verifier");
  await expect(f.library.evaluate(hash, "wrong-evaluation", signal())).rejects.toThrow("Pinned verifier");
  await expect(f.library.promote(hash, "consistent", 0, signal())).rejects.toThrow("Pinned verifier");
  expect(f.calls()).toBe(before);
  expect(f.events.some(e => e.type === "AikoHarnessRunStarted" && e.id === "wrong-checker")).toBe(false);
});

test("legacy mismatched registration and witness identities cannot authorize promotion", async () => {
  for (const field of ["verifierDigest", "evaluatorDigest", "contractDigest"] as const) {
    const f = fixture(), hash = await f.seed();
    await f.library.evaluate(hash, "checked", signal());
    const before = f.calls();
    // Simulate retained evidence written by a prior inconsistent host. Reading
    // historical receipts remains valid; those receipts cannot promote code.
    const row = f.events.find(e => e.type === "AikoHarnessChecked")!;
    (row.witness as Record<string, unknown>)[field] = harnessDigest("old-inconsistent-identity");
    await expect(f.library.promote(hash, "checked", 0, signal())).rejects.toThrow("Promotion witnesses");
    expect(f.calls()).toBe(before);
    expect(harnessLibraryState(f.events, "123").heads.size).toBe(0);
  }
  const f = fixture(), hash = await f.seed();
  (f.events.find(e => e.type === "AikoHarnessContractRegistered")! as Record<string, unknown>).verifierDigest = harnessDigest("legacy-checker");
  await expect(f.library.resolve(hash)).rejects.toThrow("Registered verifier identity");
  expect(f.calls()).toBe(0);
});

test("concurrent identical calls dispatch once, and interrupted writes are never replayed", async () => {
  const f = fixture(), hash = await f.seed();
  const result = await Promise.all([f.library.run(hash, { n: 5 }, "same", signal()), f.library.run(hash, { n: 5 }, "same", signal())]);
  expect(f.calls()).toBe(1);
  expect(result.some(w => w.status === "satisfied")).toBe(true);
  const started = f.events.find(e => e.type === "AikoHarnessRunStarted")!;
  f.events.splice(0, f.events.length, ...f.events.filter(e => e.type !== "AikoHarnessChecked"));
  const recovered = new HarnessLibrary(f.binding, f.journal);
  expect((await recovered.run(hash, { n: 5 }, String(started.id), signal())).status).toBe("unknown");
  expect(f.calls()).toBe(1);
});

test("current authority, context, immutable artifacts and missing retained data gate execution and promotion", async () => {
  const f = fixture(), hash = await f.seed();
  await f.library.evaluate(hash, "good", signal());
  f.binding.context = async () => ({ placement: "local", runtimeDigest: harnessDigest("new runtime"), bindings: {} });
  await expect(f.library.promote(hash, "good", 0, signal())).rejects.toThrow("current context");
  f.binding.authorize = async () => false;
  expect((await f.library.run(hash, { n: 4 }, "denied", signal())).status).toBe("blocked");
  expect(f.calls()).toBe(2);
  const artifact = (await f.library.resolve(hash)).artifact;
  await expect(f.library.record({ ...artifact, entrypoint: "../escape", files: { "../escape": "return 1" } })).rejects.toThrow("source path");
  f.db.query("DELETE FROM workflow_records WHERE key LIKE ?").run(`%${hash}`);
  await expect(f.library.resolve(hash)).rejects.toThrow("unavailable");
});

test("a concurrent losing rejection cannot settle another caller's authorized execution", async () => {
  const f = fixture(), hash = await f.seed();
  let admitted = 0, began!: () => void, release!: () => void;
  const running = new Promise<void>(resolve => began = resolve);
  const wait = new Promise<void>(resolve => release = resolve);
  f.binding.authorize = async () => ++admitted === 1;
  const execute = f.binding.execute;
  f.binding.execute = async (input, signal) => { began(); await wait; return execute(input, signal); };
  const journalRead = f.journal.read;
  let reads = 0;
  // Both callers observe the operation before either claims its native key.
  let synchronized!: () => void;
  const barrier = new Promise<void>(resolve => synchronized = resolve);
  f.journal.read = async () => {
    const snapshot = await journalRead();
    if (++reads <= 2) { if (reads === 2) synchronized(); await barrier; }
    return snapshot;
  };
  const calls = [f.library.run(hash, { n: 3 }, "race-admission", signal()), f.library.run(hash, { n: 3 }, "race-admission", signal())];
  await running;
  release();
  const witnesses = await Promise.all(calls);
  expect(witnesses.some(w => w.status === "satisfied")).toBe(true);
  expect(f.calls()).toBe(1);
  const checked = f.events.filter(e => e.type === "AikoHarnessChecked");
  expect(checked).toHaveLength(1);
  expect((checked[0]!.witness as { status: string }).status).toBe("satisfied");
});

test("a non-cooperative executor is deadline-bounded and recorded as unknown", async () => {
  const f = fixture(); f.contract.timeoutMs = 15;
  const hash = await f.seed();
  f.binding.execute = () => new Promise(() => {});
  const before = performance.now();
  expect((await f.library.run(hash, { n: 1 }, "timeout", signal())).status).toBe("unknown");
  expect(performance.now() - before).toBeLessThan(500);
});

test("retained output and independently verified output share immutable accepted bytes", async () => {
  const f = fixture();
  f.contract.outputSchema = { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false };
  const hash = await f.seed();
  const returned = { value: 0 };
  f.binding.execute = async () => ({ status: "succeeded", output: returned, evidence: ["executor-receipt"] });
  const put = f.binding.blobs.putPrivate.bind(f.binding.blobs);
  f.binding.blobs.putPrivate = async (owner, value) => {
    const ref = await put(owner, value);
    if (value && typeof value === "object" && "value" in value) returned.value = 4;
    return ref;
  };
  const observed: unknown[] = [];
  f.verifier.verify = async ({ input, output }) => {
    observed.push(structuredClone(output));
    const passed = (output as { value: number }).value === (input as { n: number }).n * 2;
    (output as { value: number }).value = 999;
    return { passed, evidence: ["fixed-value-check"], quality: passed ? 1 : 0 };
  };
  const wrong = await f.library.run(hash, { n: 2 }, "wrong-retained", signal());
  expect(wrong.status).toBe("violated");
  expect(await f.binding.blobs.get("123", wrong.outputRef!)).toEqual({ value: 0 });
  const right = await f.library.run(hash, { n: 2 }, "right-retained", signal());
  expect(right.status).toBe("satisfied");
  expect(await f.binding.blobs.get("123", right.outputRef!)).toEqual({ value: 4 });
  expect(observed).toEqual([{ value: 0 }, { value: 4 }]);
});

test("schema and verifier failures retain the linked execution receipt", async () => {
  const f = fixture(), hash = await f.seed();
  f.binding.execute = async () => ({ status: "succeeded", output: "wrong schema", evidence: ["sandbox-receipt"] });
  const invalid = await f.library.run(hash, { n: 2 }, "invalid-output", signal());
  expect(invalid.status).toBe("violated");
  expect(invalid.evidence).toContain("sandbox-receipt");
  f.binding.execute = async () => ({ status: "succeeded", output: 4, evidence: ["sandbox-receipt-2"] });
  f.verifier.verify = async () => { throw Error("checker unavailable"); };
  const uncertain = await f.library.run(hash, { n: 2 }, "unknown-check", signal());
  expect(uncertain.status).toBe("unknown");
  expect(uncertain.evidence).toContain("sandbox-receipt-2");
});

test("cancelled evaluation resumes undispatched cases without repeating completed or uncertain cases", async () => {
  const f = fixture(), hash = await f.seed(), abort = new AbortController();
  const append = f.journal.append;
  f.journal.append = async batch => {
    await append(batch);
    if (batch.some(e => e.type === "AikoHarnessChecked")) abort.abort();
  };
  await expect(f.library.evaluate(hash, "recover-evaluation", abort.signal)).rejects.toThrow();
  expect(f.calls()).toBe(1);
  f.journal.append = append;
  const recovered = new HarnessLibrary(f.binding, f.journal);
  expect((await recovered.evaluate(hash, "recover-evaluation", signal())).eligible).toBe(true);
  expect(f.calls()).toBe(2);
  const negative = f.events.find(e => e.type === "AikoHarnessRunStarted" && e.caseId === "negative")!;
  f.events.splice(0, f.events.length, ...f.events.filter(e => e.type !== "AikoHarnessEvaluated" && !(e.type === "AikoHarnessChecked" && e.id === negative.id)));
  expect((await new HarnessLibrary(f.binding, f.journal).evaluate(hash, "recover-evaluation", signal())).type).toBe("AikoHarnessEvaluationPending");
  expect(f.calls()).toBe(2);
});

test("private artifacts are sealed and references cannot be guessed from low-entropy inputs", async () => {
  const f = fixture(), value = { privateText: "synthetic private transcript", n: 1 };
  const ref = await f.binding.blobs.putPrivate("123", value);
  expect(ref).not.toBe(harnessDigest(value));
  expect(await f.binding.blobs.putPrivate("456", value)).not.toBe(ref);
  expect(JSON.stringify(f.db.query("SELECT value FROM workflow_records").all())).not.toContain(value.privateText);
  const restored = harnessBlobStore(sqliteWorkflowKV(f.db));
  expect(await restored.get("123", ref)).toEqual(value);
  const row = f.db.query("SELECT key,value FROM workflow_records WHERE key LIKE ?").get(`%${ref}`) as { key: string; value: string };
  const sealed = JSON.parse(row.value); sealed.ciphertext = Buffer.from("corrupted ciphertext").toString("base64");
  f.db.query("UPDATE workflow_records SET value=? WHERE key=?").run(JSON.stringify(sealed), row.key);
  await expect(restored.get("123", ref)).rejects.toThrow();
});

test("verified action lookup executes fresh data without model arbitration and changed context cannot select it", async () => {
  const f = fixture(), hash = await f.seed();
  await f.library.evaluate(hash, "ready", signal());
  await f.library.promote(hash, "ready", 0, signal());
  const { artifact } = await f.library.resolve(hash);
  const witness = await f.library.call("scale", artifact.contractDigest, { n: 31 }, "resolved", signal());
  expect(await f.binding.blobs.get("123", witness.outputRef!)).toBe(62);
  f.binding.context = async () => ({ placement: "local", runtimeDigest: harnessDigest("changed"), bindings: {} });
  await expect(f.library.call("scale", artifact.contractDigest, { n: 31 }, "new", signal())).rejects.toThrow("No verified harness");
  // An already completed operation remains a historical receipt even after session/runtime changes.
  expect(await f.library.run(hash, { n: 31 }, "resolved", signal())).toEqual(witness);
});

test("route selection pins context through dispatch and cancelled promotion never publishes", async () => {
  const f = fixture(), hash = await f.seed();
  await f.library.evaluate(hash, "candidate", signal());
  const cancelled = new AbortController(); cancelled.abort();
  await expect(f.library.promote(hash, "candidate", 0, cancelled.signal)).rejects.toThrow();
  expect((await f.library.list()).active).toHaveLength(0);
  await f.library.promote(hash, "candidate", 0, signal());
  const originalContext = await f.binding.context(signal());
  let calls = 0;
  f.binding.context = async () => ++calls === 1 ? originalContext : { ...originalContext, bindings: { sessionRevision: 2 } };
  const before = f.calls();
  await expect(f.library.call("scale", (await f.library.resolve(hash)).artifact.contractDigest, { n: 4 }, "raced", signal())).rejects.toThrow("context changed");
  expect(f.calls()).toBe(before);
});

test("mutating fixture evaluation needs its own authorization and successful witnesses retain execution evidence", async () => {
  const f = fixture(); f.contract.effect = "write";
  const hash = await f.seed();
  await expect(f.library.evaluate(hash, "write-fixtures", signal())).rejects.toThrow("fixture authorization");
  expect(f.calls()).toBe(0);
  f.binding.authorizeEvaluation = async (_artifact, _contract, _context, fixture) => ["positive", "negative"].includes(fixture.id);
  expect((await f.library.evaluate(hash, "write-fixtures", signal())).eligible).toBe(true);
  const witness = harnessLibraryState(f.events, "123").witnesses.values().next().value!;
  expect(witness.evidence).toEqual(["quickjs-executed", "independent-scale-equality"]);
});

test("caller mutation during input retention cannot change the executed and verified request", async () => {
  const f = fixture(), hash = await f.seed(), original = f.binding.blobs.putPrivate;
  const input = { n: 2 };
  f.binding.blobs.putPrivate = async (owner, value) => {
    const ref = await original(owner, value);
    input.n = 99;
    return ref;
  };
  const result = await f.library.run(hash, input, "immutable-input", signal());
  expect(result.status).toBe("satisfied");
  expect(await f.binding.blobs.get("123", result.outputRef!)).toBe(4);
  const started = f.events.find(e => e.type === "AikoHarnessRunStarted")!;
  expect(await f.binding.blobs.get("123", started.inputRef as any)).toEqual({ n: 2 });
});

test("concurrent evaluation and promotion expose only the winning durable results", async () => {
  const f = fixture(), hash = await f.seed();
  const outcomes = await Promise.all([f.library.evaluate(hash, "racing-eval", signal()), f.library.evaluate(hash, "racing-eval", signal())]);
  expect(f.calls()).toBe(2);
  const evaluations = f.events.filter(e => e.type === "AikoHarnessEvaluated");
  expect(evaluations).toHaveLength(1);
  expect(evaluations[0]!.eligible).toBe(true);
  for (const outcome of outcomes) if (outcome.type === "AikoHarnessEvaluated") expect(outcome).toEqual(evaluations[0]);
  const second = await f.seed("return input.n + input.n;");
  await f.library.evaluate(second, "other", signal());
  const promotion = await Promise.allSettled([f.library.promote(hash, "racing-eval", 0, signal()), f.library.promote(second, "other", 0, signal())]);
  expect(promotion.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(f.events.filter(e => e.type === "AikoHarnessPromoted")).toHaveLength(1);
  expect((await f.library.list()).active).toHaveLength(1);
});

test("a retained terminal witness can be read after the live session and verifier become unavailable", async () => {
  const f = fixture(), hash = await f.seed();
  const receipt = await f.library.run(hash, { n: 8 }, "completed", signal());
  f.binding.context = async () => { throw Error("Session gone"); };
  f.binding.verifiers = new Map();
  expect(await f.library.run(hash, { n: 8 }, "completed", signal())).toEqual(receipt);
  expect(f.calls()).toBe(1);
});

test("retained output composes privately, rejects unverified outcomes, and never performs a fresh execution", async () => {
  const f = fixture(), hash = await f.seed();
  await f.library.run(hash, { n: 7 }, "first-value", signal());
  const output = await f.library.output("first-value");
  expect(output).toMatchObject({ output: 14, freshness: "historical-operation" });
  expect(f.calls()).toBe(1);
  await f.library.run(hash, { n: output.output as number }, "composed-value", signal());
  expect((await f.library.output("composed-value")).output).toBe(28);
  const other = new HarnessLibrary({ ...f.binding, owner: "456", thread: "user-456" }, f.journal);
  await expect(other.output("first-value")).rejects.toThrow("unavailable");
  f.binding.authorize = async () => false;
  await f.library.run(hash, { n: 7 }, "blocked-value", signal());
  await expect(f.library.output("blocked-value")).rejects.toThrow("unavailable");
  f.db.query("DELETE FROM workflow_records WHERE key LIKE ?").run(`%${output.outputRef}`);
  await expect(f.library.output("first-value")).rejects.toThrow("unavailable");
  expect(f.calls()).toBe(2);
});

test("native codeMode invokes the library with scoped tools and durable receipt replay", async () => {
  const f = fixture(), hash = await f.seed();
  const db = new Database(":memory:"); dbs.push(db);
  let alarm: number | null = null;
  const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const harness = new CodeHarness("123", "user-123", runCodeSegment, s => s);
  const keys = component({ name: "harness-library-keys", keys: { prefixes: ["aiko-harness:"], keyOf: harnessLibraryEventKey }, initial: () => undefined, step: s => s, output: () => ({ view: undefined, transitions: [] }) });
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [keys, infer([codeMode([harness.package(harnessLibraryTools(f.binding))]), outputValidateOnce])] });
  const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }), react: (request: any) => {
    const returned = request.trajectory.find((e: Event) => e.type === "ToolReturned");
    if (!returned) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "verify", arguments: { code: `const witness = await tools.call({name:'harness_run',arguments:{digest:'${hash}',input:{n:9},operationId:'native-run'}}); const procedure = await tools.call({name:'harness_procedure',arguments:{digest:'${hash}'}}); return {...witness,procedureBasis:procedure.basis};` } });
    expect(returned.result.result.status).toBe("satisfied");
    expect(returned.result.result.procedureBasis).toBe("saved-example");
    return Effect.succeed({ kind: "complete" as const, output: "Witness verified" });
  } });
  const host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "library-fixture", ownsThread: t => t === "user-123", actorFor: () => definition, layersFor: () => Layer.merge(harness.inference(model), harness.sandboxLayer()) });
  for (const e of f.events) await host.commitRoot(host.self("user-123"), e);
  await host.commitRoot(host.self("user-123"), { type: "MessageReceived", id: "turn", text: "Use learned scale", at: 1 });
  await host.drive();
  const events = await host.read("user-123");
  expect(events.find(e => e.type === "TurnCompleted")?.output).toBe("Witness verified");
  expect(events.filter(e => e.type === "AikoHarnessChecked")).toHaveLength(1);
  await host.drive();
  expect(f.calls()).toBe(1);
});
