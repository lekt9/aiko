/** Protected acceptance fixture: actual native host + SQLite + codeMode + local sandbox.
 * No production credentials, provider, login or channel adapters are used.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Layer } from "../../apps/agent/node_modules/effect/dist/index.js";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "../../apps/agent/node_modules/tardie/src/agent/index.ts";
import { component } from "../../apps/agent/node_modules/tardie/src/core/component/index.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../../apps/agent/src/cloudflare-host.ts";
import { CodeHarness } from "../../apps/agent/src/code-harness.ts";
import { runCodeSegment } from "../../apps/agent/src/code-sandbox-runner.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryEventKey, harnessLibraryTools, type HarnessLibraryBinding, type HarnessContract, type HarnessArtifact } from "../../apps/agent/src/harness-library.ts";
import { sqliteWorkflowKV } from "../../apps/agent/src/workflow-store.ts";
import { createHarnessSandboxBinding } from "../../apps/agent/src/harness-sandbox.ts";
import { localHarnessSandbox } from "../../apps/agent/src/harness-sandbox-local.ts";
import { sandboxJobJournal } from "../../apps/agent/src/sandbox-job-journal.ts";
import { harnessSkillForwarder, harnessSkillDeriver } from "../../apps/agent/src/harness-skill.ts";
import { sandboxEnvironment } from "../../apps/agent/src/sandbox-job-runner.ts";

const [mode, dir, nonce] = process.argv.slice(2);
assert(["prepare", "recover"].includes(mode)); assert(dir && nonce);
const recovering = mode === "recover";
const counts = { model: 0, fetch: 0, build: 0, effect: 0, sandbox: 0, code: 0, documentWrites: 0, derivation: 0 };
const forbid = (kind: keyof typeof counts) => { counts[kind]++; if (recovering) throw Error(`Replay attempted ${kind}`); };
globalThis.fetch = Object.assign(async () => { forbid("fetch"); throw Error("External fetch forbidden in this fixture"); }, { preconnect: () => { forbid("fetch"); throw Error("External preconnect forbidden in this fixture"); } });
const build = Bun.build;
Bun.build = ((...args: Parameters<typeof Bun.build>) => { forbid("build"); return build(...args); }) as typeof Bun.build;
const db = new Database(join(dir, "native.sqlite"));
const privateDb = new Database(join(dir, "custody.sqlite"));
const kv = sqliteWorkflowKV(privateDb), custody = harnessBlobStore(kv);
const blobs = { ...custody, put: async (owner: string, value: unknown) => { if (typeof value === "string") forbid("documentWrites"); return custody.put(owner, value); } };
const storage: AccountStorage = {
  sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as any); return { toArray: () => rows as never }; } },
  transactionSync: fn => db.transaction(fn)(), sync: async () => {},
  getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
};
const runtimeDigest = await sandboxEnvironment("protected-projection-fixture-v1");
const sandbox = localHarnessSandbox({ owner: "123", environmentDigest: runtimeDigest, journal: await sandboxJobJournal(privateDb, join(dir, "sandbox.key")), send: async () => { forbid("effect"); throw Error("No transport authorized"); } });
const receipts: unknown[] = [];
const bridge = createHarnessSandboxBinding({ owner: "123", thread: "user-123", placement: "local", sandbox: {
  harnessEnvironment: sandbox.harnessEnvironment,
  harnessJob: async (job, signal) => { forbid("sandbox"); forbid("effect"); const receipt = await sandbox.harnessJob(job, signal); receipts.push(receipt); return receipt; },
}, current: async () => ({ owner: "123", active: true, runtimeDigest, contextRef: "fixture-context", authorityRef: "fixture-read", sessionRevision: "1", effects: ["read"], origins: [], methods: ["GET"], budget: { wallMs: 5000, requests: 0, outputBytes: 32768 } }) });
const verifier = { digest: harnessDigest("protected-double-check-v1"), evaluatorDigest: harnessDigest("protected-cases-v1"), cases: [{ id: "dev", input: { n: 3 }, split: "development" as const }, { id: "final", input: { n: -7 }, split: "held-out" as const }], verify: async ({ input, output }: any) => ({ passed: output === input.n * 2, evidence: ["protected-numeric-equality"], quality: output === input.n * 2 ? 1 : 0 }) };
const binding: HarnessLibraryBinding = { owner: "123", thread: "user-123", blobs, verifiers: new Map([[verifier.digest, verifier]]), guard: () => {}, ...bridge };
const contract: HarnessContract = { version: 1, outcome: "Return twice the supplied number", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, outputSchema: { type: "number" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {}, timeoutMs: 5000 };
const contractDigest = harnessDigest(contract);
const math = "export const double = n => n * 2;";
const artifact = (revision: number): HarnessArtifact => ({ version: 1, name: "double", description: `Protected projection fixture revision ${revision}`, runtime: "javascript", entrypoint: "main.js", files: { "main.js": `import {double} from "math.js"; export default input => double(input.n); // revision ${revision}`, "math.js": math }, dependencies: [{name:"math.js", digest:harnessDigest(math)}], sources: [{ uri: "fixture:double", revision: String(revision), digest: harnessDigest(`fixture-source-${revision}`), license: "fixture" }], contractDigest });
const first = artifact(1), second = artifact(2);
const code = `const a=await tools.call({name:"harness_record",arguments:{artifact:${JSON.stringify(first)}}}); await tools.call({name:"harness_evaluate",arguments:{digest:a.digest,evaluationId:"first"}}); await tools.call({name:"harness_promote",arguments:{digest:a.digest,evaluationId:"first",expectedGeneration:0}}); const b=await tools.call({name:"harness_record",arguments:{artifact:${JSON.stringify(second)}}}); await tools.call({name:"harness_evaluate",arguments:{digest:b.digest,evaluationId:"second"}}); await tools.call({name:"harness_promote",arguments:{digest:b.digest,evaluationId:"second",expectedGeneration:1}}); return await tools.call({name:"harness_run",arguments:{digest:b.digest,input:{n:17},operationId:"fresh"}});`;
const harness = new CodeHarness("123", "user-123", async (...args) => { forbid("code"); return runCodeSegment(...args); }, s => s);
const keys = component({ name: "protected-library-keys", keys: { prefixes: ["aiko-harness:"], keyOf: harnessLibraryEventKey }, initial: () => undefined, step: s => s, output: () => ({ view: undefined, transitions: [] }) });
const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [keys, harnessSkillForwarder(binding), infer([codeMode([harness.package(harnessLibraryTools(binding))]), outputValidateOnce])] });
const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "protected-fixture", model_id: "fixed-program" } }), react: (request: any) => {
  forbid("model"); const returned = request.trajectory.find((e: any) => e.type === "ToolReturned");
  if (!returned) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "protected-pipeline", arguments: { code } });
  assert.equal(returned.result.result.status, "satisfied");
  return Effect.succeed({ kind: "complete" as const, output: "Protected pipeline settled" });
} });
const indexerThread = "background-123-indexer";
const deriver = harnessSkillDeriver(binding);
// Observe entry into the actual native derivation action, without replacing it.
const countedDeriver = { ...deriver, machine: { ...deriver.machine, output: (state: unknown) => {
  const output = deriver.machine.output(state);
  return { ...output, transitions: output.transitions.map(t => t.kind === "effect" && t.key.includes(":AikoHarnessSkillDerived:") ? {
    ...t, act: (...args: Parameters<typeof t.act>) => Effect.suspend(() => { forbid("derivation"); return t.act(...args); }),
  } : t) };
} } };
const indexer = actor({ name: "aiko", methods: {}, components: [countedDeriver] });
const host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: `projection-${nonce}`, ownsThread: t => t === "user-123" || t === indexerThread, actorFor: t => t === "user-123" ? definition : indexer, layersFor: () => Layer.merge(harness.inference(model), harness.sandboxLayer()) });
const library = new HarnessLibrary(binding, { read: () => host.read("user-123"), append: async events => { for (const e of events) await host.commitRoot(host.self("user-123"), e); } });
try {
  if (!recovering) {
    await library.registerContract(contract);
    await host.commitRoot(host.self("user-123"), { type: "MessageReceived", id: nonce, text: "Run protected fixture", at: 1 });
    await host.drive();
  } else {
    // Delete the disposable materialized catalog. A fresh OS process has already
    // discarded all library/host in-memory projections and QuickJS state.
    unlinkSync(join(dir, "disposable-projection.json"));
    await host.recover();
  }
  const trace = await host.read("user-123");
  assert.equal(trace.find(e => e.type === "TurnCompleted")?.output, "Protected pipeline settled");
  assert.equal(trace.filter(e => e.type === "AikoHarnessCandidateRecorded").length, 2);
  const promotions = trace.filter(e => e.type === "AikoHarnessPromoted");
  assert.equal(promotions.length, 2);
  assert.deepEqual(promotions.map(e => e.generation), [1, 2]);
  assert.equal(trace.filter(e => e.type === "AikoHarnessChecked").length, 5);
  const projection = await library.list();
  assert.equal(projection.candidates.length, 2); assert.equal(projection.active.length, 1);
  assert.equal(projection.active[0].harnessDigest, harnessDigest(second));
  const skills: Record<string, string> = {};
  const resources: Record<string, Record<string, unknown>> = {};
  const indexerTrace = await host.read(indexerThread);
  const available = trace.filter(e => e.type === "AikoHarnessSkillAvailable");
  assert.equal(available.length, 2);
  assert.equal(projection.skills.length, 2);
  for (const type of ["AikoHarnessSkillRequested", "AikoHarnessSkillDerived", "AikoHarnessSkillPublished"]) assert.equal(indexerTrace.filter(e => e.type === type).length, 2);
  const terminalIndex = trace.findIndex(e => e.type === "TurnCompleted");
  assert(trace.every((e, i) => !["AikoHarnessSkillForwarded", "AikoHarnessSkillAvailable"].includes(e.type) || i > terminalIndex));
  for (const p of promotions) {
    const doc = await library.skill(p.harnessDigest as any);
    assert.equal(doc.status, "evaluated");
    assert.equal(typeof doc.markdown, "string");
    assert.equal(harnessDigest(doc.markdown), doc.skillRef);
    assert(doc.markdown!.includes(String(p.harnessDigest)));
    assert(available.some(e => e.harnessDigest === p.harnessDigest && e.skillRef === doc.skillRef));
    skills[String(doc.skillRef)] = doc.markdown!;
    const refs = doc.resources as Record<string, string>;
    assert.deepEqual(Object.keys(refs).sort(), ["references/contract.json", "references/evidence.json", "references/provenance.json"]);
    const bundle: Record<string, unknown> = {};
    for (const [path, ref] of Object.entries(refs)) {
      const selected = await library.skill(p.harnessDigest as any, path);
      const retained = await blobs.get("123", ref as any);
      assert.equal(selected.resourceRef, ref); assert.equal(harnessDigest(selected.value), ref);
      assert.deepEqual(selected.value, retained);
      // Store the exact canonical retained JSON text, not just existence or digest.
      bundle[path] = { reference: ref, bytes: JSON.stringify(retained) };
    }
    assert.deepEqual((await library.skill(p.harnessDigest as any, "references/contract.json")).value, contract);
    const original = p.harnessDigest === harnessDigest(first) ? first : second;
    assert.deepEqual((await library.skill(p.harnessDigest as any, "references/provenance.json")).value, {sources: original.sources, dependencies: original.dependencies});
    resources[String(p.harnessDigest)] = bundle;
  }
  assert.equal(Object.keys(skills).length, 2);
  const observations = { nonce, pid: process.pid, projection, skills, resources, counts, native: { candidates: 2, promotions: promotions.map(p => p.generation), checked: 5, packageReturns: trace.filter(e => e.type === "ToolReturned").length, threads: 2, available: available.length, derived: indexerTrace.filter(e => e.type === "AikoHarnessSkillDerived").length, afterSettlement: true }, receiptCount: receipts.length };
  writeFileSync(join(dir, `${mode}-trace.json`), JSON.stringify({foreground: trace, indexer: indexerTrace}, null, 2));
  writeFileSync(join(dir, `${mode}.json`), JSON.stringify(observations, null, 2));
  if (!recovering) {
    assert(counts.model > 0 && counts.build > 0 && counts.effect > 0 && counts.code > 0 && counts.documentWrites === 2 && counts.derivation === 2);
    assert.equal(receipts.length, 5);
    writeFileSync(join(dir, "sandbox-receipts.json"), JSON.stringify(receipts, null, 2));
    writeFileSync(join(dir, "disposable-projection.json"), JSON.stringify(projection));
  } else assert.deepEqual(counts, { model: 0, fetch: 0, build: 0, effect: 0, sandbox: 0, code: 0, documentWrites: 0, derivation: 0 });
} finally { await host.close(); db.close(); privateDb.close(); }
