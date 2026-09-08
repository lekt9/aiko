import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import type { Event } from "tardie/core/event";
import { deriveComponent } from "tardie/core/component";
import { REPLY_SUFFIX } from "tardie/core/communication/message";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryComponent, harnessLibraryTools, type HarnessContract, type HarnessLibraryBinding } from "../src/harness-library.ts";
import { compileHarnessSkill, harnessSkillDeriver, harnessSkillForwarder, harnessSkillRequests, validateHarnessSkill } from "../src/harness-skill.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); });
const signal = () => AbortSignal.timeout(10000);
const foreground = "user-123", background = "background-123-indexer";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => resolve = r); return { promise, resolve }; };
async function fixture() {
  const dir = await mkdtemp("/tmp/harness-skill-"), privateDb = new Database(join(dir, "private.sqlite"));
  cleanups.push(async () => { privateDb.close(); await rm(dir, { recursive: true, force: true }); });
  let docGate: ReturnType<typeof deferred> | undefined, docEntered = deferred(), docWrites = 0, executes = 0, models = 0;
  let program = "return 'unused';", host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>, db!: Database;
  const counts = () => ({ docWrites, executes, models });
  const makeBlobs = () => {
    const custody = harnessBlobStore(sqliteWorkflowKV(privateDb));
    return { ...custody, put: async (owner: string, value: unknown) => {
      if (typeof value === "string" && value.startsWith("---\nname:")) { docWrites++; docEntered.resolve(); await docGate?.promise; }
      return custody.put(owner, value);
    } };
  };
  const verifier = { digest: harnessDigest("passive-skill-verifier"), evaluatorDigest: harnessDigest("passive-skill-cases"), cases: [{ id: "development", input: { n: 2 }, split: "development" as const }, { id: "held-out", input: { n: -11 }, split: "held-out" as const }], verify: async ({ input, output }: any) => ({ passed: output === input.n * 2, evidence: ["fixed-double-equality"], quality: 1 }) };
  const binding: HarnessLibraryBinding = {
    owner: "123", thread: foreground, blobs: makeBlobs(), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {},
    context: async () => ({ placement: "local", runtimeDigest: harnessDigest("passive-quickjs"), bindings: { sessionRevision: "fixture" } }),
    authorize: async () => true,
    execute: async (job, abort) => { executes++; const r = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, abort); return r.error ? { status: "failed", evidence: ["guest-failed"] } : { status: "succeeded", output: r.result as number, evidence: ["guest-completed"] }; },
  };
  const journal = { read: () => host.read(foreground), append: async (events: Event[]) => { for (const e of events) await host.commitRoot(host.self(foreground), e); } };
  const library = new HarnessLibrary(binding, journal);
  const open = async () => {
    db = new Database(join(dir, "native.sqlite"));
    const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
    const harness = new CodeHarness("123", foreground, runCodeSegment, s => s);
    const primary = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [harnessLibraryComponent("123"), harnessSkillForwarder(binding), infer([codeMode([harness.package(harnessLibraryTools(binding))]), outputValidateOnce])] });
    const indexer = actor({ name: "aiko", methods: {}, components: [harnessSkillDeriver(binding)] });
    const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "passive" } }), react: (request: any) => {
      models++;
      if (!request.trajectory.some((e: Event) => e.type === "ToolReturned")) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "skill-program", arguments: { code: program } });
      return Effect.succeed({ kind: "complete" as const, output: "Foreground result is ready" });
    } });
    host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "passive-skill", ownsThread: t => [foreground, background].includes(t), actorFor: thread => thread === foreground ? primary : indexer, layersFor: () => Layer.merge(harness.inference(model), harness.sandboxLayer()) });
  };
  await open(); cleanups.push(async () => { docGate?.resolve(); await host.close(); db.close(); });
  const contract: HarnessContract = { version: 1, outcome: "Return twice the input number", inputSchema: { type: "object", properties: { n: { type: "number" }, note: { type: "string" } }, required: ["n"], additionalProperties: false }, outputSchema: { type: "number" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {}, timeoutMs: 2000 };
  const seed = async (description = "Double the number") => {
    const contractDigest = await library.registerContract(contract);
    const artifact = { version: 1 as const, name: "Math.Double:v1", description, runtime: "javascript" as const, entrypoint: "main.js", files: { "main.js": "return input.n * 2;" }, dependencies: [], sources: [{ uri: "fixture:double", revision: "1", digest: harnessDigest("source"), license: "fixture" }], contractDigest };
    return { hash: await library.record(artifact), artifact, contract };
  };
  return { binding, library, contract, seed, counts, privateDb,
    get host() { return host; },
    events: (thread = foreground) => host.read(thread),
    block: () => { docGate = deferred(); docEntered = deferred(); return { entered: docEntered.promise, release: docGate.resolve }; },
    start: async (code: string) => { program = code; await host.commitRoot(host.self(foreground), { type: "MessageReceived", id: `task-${models}`, at: Date.now(), text: "Run the checked task" }); },
    restart: async () => { await host.close(); db.close(); binding.blobs = makeBlobs(); await open(); await host.recover(); },
    recoverPrefix: async (source: readonly Event[], target: readonly Event[]) => {
      await host.close(); db.close(); await rm(join(dir, "native.sqlite"));
      binding.blobs = makeBlobs(); await open();
      await host.seed(foreground, source); await host.seed(background, target);
      // History import intentionally never schedules work. Reopen the restored
      // host to exercise normal startup recovery of its pending components.
      await host.close(); db.close(); await open(); await host.recover();
    },
    erase: (hash: string) => privateDb.query("DELETE FROM workflow_records WHERE key=?").run(`harness-blobs:${harnessDigest("123")}:${hash}`),
  };
}

test("settled native foreground coalesces passive derivation without awaiting document storage", async () => {
  const f = await fixture(), { hash } = await f.seed(), gate = f.block();
  await f.start(`await tools.call({name:"harness_run",arguments:{digest:"${hash}",input:{n:5,note:"private-captured-input-731"},operationId:"first"}}); await tools.call({name:"harness_evaluate",arguments:{digest:"${hash}",evaluationId:"evaluation"}}); return await tools.call({name:"harness_promote",arguments:{digest:"${hash}",evaluationId:"evaluation",expectedGeneration:0}});`);
  const driving = f.host.drive();
  await Promise.race([gate.entered, new Promise((_, reject) => setTimeout(() => reject(Error("Derivation never started")), 5000))]);
  expect((await f.events()).find(e => e.type === "TurnCompleted")?.output).toBe("Foreground result is ready");
  expect((await f.library.skill(hash)).status).toBe("pending");
  expect(f.counts().models).toBe(2);
  gate.release(); await driving;
  const doc = await f.library.skill(hash);
  expect(doc.status).toBe("evaluated"); expect(doc.markdown).toContain("harness_run");
  expect(f.counts().docWrites).toBe(1);
  expect((await f.events(background)).filter(e => e.type === "AikoHarnessSkillRequested")).toHaveLength(1);
  expect(JSON.stringify(await f.events(background))).not.toContain("private-captured-input-731");
  expect(doc.markdown).not.toContain("private-captured-input-731");
  const before = [await f.events(), await f.events(background)], counts = f.counts();
  await f.restart();
  expect([await f.events(), await f.events(background)]).toEqual(before);
  expect((await f.library.skill(hash)).markdown).toBe(doc.markdown);
  expect(f.counts()).toEqual(counts);
});

test("a narrow candidate is documented before promotion and failures revise its exact evidence", async () => {
  const f = await fixture(), { hash } = await f.seed();
  await f.library.run(hash, { n: 8 }, "single", signal()); await f.host.drive();
  const first = await f.library.skill(hash);
  expect(first.status).toBe("private-candidate"); expect(first.markdown).toContain("1 satisfied");
  expect((await f.library.list()).active).toHaveLength(0);
  await f.library.run(hash, { n: "bad" } as any, "blocked", signal()); await f.host.drive();
  const second = await f.library.skill(hash);
  expect(second.skillRef).not.toBe(first.skillRef); expect(second.markdown).toContain("1 blocked");
  expect(await f.binding.blobs.get("123", first.skillRef as any)).toBe(first.markdown);
  const writes = f.counts().docWrites;
  await f.host.drive(); await f.restart();
  expect(f.counts().docWrites).toBe(writes);
  await expect(new HarnessLibrary({ ...f.binding, owner: "456" }, { read: () => f.events(), append: async () => {} }).skill(hash)).rejects.toThrow("Owned");
});

test("deleted artifacts or documents remain unavailable without execution or blind regeneration", async () => {
  const f = await fixture(), { hash } = await f.seed();
  await f.library.run(hash, { n: 3 }, "first", signal()); f.erase(hash); await f.host.drive();
  expect((await f.library.skill(hash)).status).toBe("unavailable"); expect(f.counts().executes).toBe(1);
  const good = await f.seed("Second artifact");
  await f.library.run(good.hash, { n: 9 }, "next", signal()); await f.host.drive();
  const doc = await f.library.skill(good.hash), before = f.counts();
  f.erase(String(doc.skillRef));
  await expect(f.library.skill(good.hash)).rejects.toThrow("unavailable");
  await f.restart(); expect(f.counts()).toEqual(before);
});

test("document validation rejects unsupported claims, invalid examples and secrets", async () => {
  const f = await fixture(), { hash, artifact, contract } = await f.seed();
  await f.library.run(hash, { n: 4, note: "private-guard-981" }, "witness", signal());
  const evidence = harnessSkillRequests(await f.events(), "123")[0]!.evidence;
  const doc = compileHarnessSkill(artifact, contract, evidence);
  expect(doc.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/); expect(doc.name.length).toBeLessThanOrEqual(64);
  expect(doc.path).toBe(`${doc.name}/SKILL.md`);
  expect(() => validateHarnessSkill({ ...doc, markdown: doc.markdown + "\nGuaranteed correct in every account." }, artifact, contract, evidence, () => {})).toThrow("Unsupported");
  expect(() => validateHarnessSkill({ ...doc, example: { n: "wrong" } }, artifact, contract, evidence, () => {})).toThrow("example");
  expect(() => validateHarnessSkill(doc, artifact, contract, evidence, () => { throw Error("private guard"); })).toThrow("private guard");
  expect(JSON.stringify(doc)).not.toContain("private-guard-981");
  expect(JSON.stringify(evidence)).not.toContain("private-guard-981");
});

test("native resumed epochs defer derivation while consumed parked replies do not create extra turns", async () => {
  const f = await fixture(), { hash } = await f.seed();
  await f.library.run(hash, { n: 2 }, "witness", signal());
  const facts = await f.events(), forwarder = harnessSkillForwarder(f.binding);
  const resumed: Event[] = [{ type: "MessageReceived", id: "turn" }, { type: "TurnFailed", turn: "turn", epoch: 0 }, { type: "TurnResumed", turn: "turn", failedEpoch: 0, epoch: 1 }, ...facts];
  expect(deriveComponent(forwarder, resumed).transitions).toHaveLength(0);
  expect(deriveComponent(forwarder, [...resumed, { type: "TurnCompleted", turn: "turn", epoch: 0 }]).transitions).toHaveLength(0);
  expect(deriveComponent(forwarder, [...resumed, { type: "TurnCompleted", turn: "turn", epoch: 1 }]).transitions).toHaveLength(1);
  const replied: Event[] = [{ type: "MessageReceived", id: "turn" }, { type: "PackageCalled", callId: "child", turn: "turn" }, { type: "MessageReceived", id: `child${REPLY_SUFFIX}` }, { type: "PackageReturned", callId: "child", turn: "turn" }, ...facts, { type: "TurnCompleted", turn: "turn" }];
  expect(deriveComponent(forwarder, replied).transitions).toHaveLength(1);
});

test("declared skill resources are readable by scope and missing dependencies cannot advertise an intact bundle", async () => {
  const f = await fixture(), { hash } = await f.seed();
  await f.library.run(hash, { n: 2 }, "witness", signal()); await f.host.drive();
  const doc = await f.library.skill(hash), provenance = await f.library.skill(hash, "references/provenance.json");
  expect(provenance.value).toMatchObject({ sources: [{ uri: "fixture:double", revision: "1", license: "fixture" }] });
  const readContract = await f.library.skill(hash, "references/contract.json");
  expect(readContract.value).toMatchObject({ inputSchema: f.contract.inputSchema, outputSchema: f.contract.outputSchema });
  await expect(f.library.skill(hash, "../private.sqlite")).rejects.toThrow("resource unavailable");
  const before = f.counts();
  f.erase(String((doc.resources as Record<string, string>)["references/contract.json"]));
  await expect(f.library.skill(hash)).rejects.toThrow("unavailable");
  await expect(f.library.skill(hash, "references/provenance.json")).rejects.toThrow("unavailable");
  await f.restart(); expect(f.counts()).toEqual(before);
});

test("lost source handoff acknowledgement reuses the existing document and immutable request identity", async () => {
  const f = await fixture(), { hash } = await f.seed();
  await f.library.run(hash, { n: 7 }, "source", signal());
  const source = await f.events();
  const firstRequest = harnessSkillRequests(source, "123")[0]!;
  await f.host.drive();
  const doc = await f.library.skill(hash), target = await f.events(background), settledSource = await f.events(), counts = f.counts();
  expect(harnessSkillRequests(source, "123")[0]).toEqual(firstRequest);
  // The receiver committed derivation before the source stored its handoff
  // acknowledgement. Publication has not started in this crash prefix.
  const derivedThrough = target.findIndex(e => e.type === "AikoHarnessSkillDerived") + 1;
  await f.recoverPrefix(source, target.slice(0, derivedThrough));
  expect(f.counts()).toEqual(counts);
  expect((await f.events(background)).filter(e => e.type === "AikoHarnessSkillRequested")).toHaveLength(1);
  expect((await f.library.skill(hash)).markdown).toBe(doc.markdown);
  // A lost publication acknowledgement must retain the receiving source's
  // committed Available event, rather than simulating loss of acknowledged data.
  const publishedAt = target.findIndex(e => e.type === "AikoHarnessSkillPublished");
  await f.recoverPrefix(settledSource, target.slice(0, publishedAt));
  expect((await f.library.skill(hash)).markdown).toBe(doc.markdown);
  expect(f.counts()).toEqual(counts);
});
