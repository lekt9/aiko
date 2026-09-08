import { Database } from "bun:sqlite";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import type { Event } from "tardie/core/event";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryComponent, type HarnessContract, type HarnessLibraryBinding, type HarnessVerifier } from "../src/harness-library.ts";
import { harnessRegistryTools } from "../src/harness-sources.ts";
import { sandboxSourceTransport } from "../src/harness-source-sandbox.ts";
import { createHarnessSandboxBinding, type HarnessSandboxAuthority } from "../src/harness-sandbox.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";

// Opt-in read-only live witness: public GitHub, local isolated code, synthetic
// inputs, fixture inference. No production account, provider writes or deployment.
if (!process.argv.includes("--live")) throw Error("Pass --live to read lukeed/clsx from public GitHub");
const directory = await mkdtemp(join(tmpdir(), "unlock-registry-live-"));
const db = new Database(join(directory, "native.sqlite"));
const storage: AccountStorage = {
  sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
  transactionSync: fn => db.transaction(fn)(), sync: async () => {},
  getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
};
const runtimeDigest = await sandboxEnvironment("public-registry-witness-v1");
const authority: HarnessSandboxAuthority = { owner: "123", active: true, runtimeDigest, contextRef: "public-github", authorityRef: "public-source-read-only", sessionRevision: null, effects: ["read"], origins: ["https://api.github.com"], methods: ["GET"], budget: { wallMs: 20000, requests: 8, outputBytes: 262144 } };
const sandbox = localHarnessSandbox({ owner: "123", environmentDigest: runtimeDigest, journal: await sandboxJobJournal(db, join(directory, "receipt.key")) });
const receipts: any[] = [];
const client = { harnessEnvironment: sandbox.harnessEnvironment, harnessJob: async (...args: Parameters<typeof sandbox.harnessJob>) => { const receipt = await sandbox.harnessJob(...args); receipts.push(receipt); return receipt; } };
const context = { owner: "123", thread: "user-123", placement: "local" as const, sandbox: client, current: async () => authority };
const inputs = [
  { values: ["red", false, ["blue"], { bold: 1, hidden: 0 }] },
  { values: [0, null, false, "", {}, []] },
  { values: ["fresh", { confirmed: true }, ["reused"]] },
];
const expected = new Map(inputs.map((input, i) => [harnessDigest(input), ["red blue bold", "", "fresh confirmed reused"][i]!]));
const verifier: HarnessVerifier = {
  digest: harnessDigest("public-clsx-fixed-verifier-v1"), evaluatorDigest: harnessDigest("public-clsx-fixed-cases-v1"),
  cases: [{ id: "nested", input: inputs[0] as any, split: "development" }, { id: "empty", input: inputs[1] as any, split: "held-out" }],
  verify: async ({ input, output }) => ({ passed: expected.has(harnessDigest(input)) && output === expected.get(harnessDigest(input)), evidence: ["independent-fixed-class-list-expectation"], quality: null }),
};
const binding: HarnessLibraryBinding = { owner: "123", thread: "user-123", blobs: harnessBlobStore(sqliteWorkflowKV(db)), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {}, ...createHarnessSandboxBinding(context) };
const sourceBinding = { library: binding, transport: sandboxSourceTransport(context), authorize: async (repo: string) => repo === "lukeed/clsx" };
const harness = new CodeHarness("123", "user-123", runCodeSegment, value => value);
let contractDigest = "", modelCalls = 0;
const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [harnessLibraryComponent("123"), infer([codeMode([harness.package(harnessRegistryTools(sourceBinding))]), outputValidateOnce])] });
const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }), react: (request: any) => {
  modelCalls++;
  if (!request.trajectory.some((e: Event) => e.type === "ToolReturned")) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "live-registry", arguments: { code: `
const source = await tools.call({name:"harness_source_ingest",arguments:{repository:"lukeed/clsx",ref:"master",paths:["src/index.js","readme.md","package.json"],licensePath:"license",operationId:"live-source",expectedGeneration:0}});
const candidate = await tools.call({name:"harness_source_derive",arguments:{snapshotDigest:source.snapshotDigest,options:{name:"public.clsx",description:"Pinned class-list library with bounded fixture evidence",contractDigest:"${contractDigest}",kind:"code",entrypoint:"src/index.js",argumentKeys:["values"]}}});
await tools.call({name:"harness_evaluate",arguments:{digest:candidate.harnessDigest,evaluationId:"live-fixed-evaluation"}});
await tools.call({name:"harness_promote",arguments:{digest:candidate.harnessDigest,evaluationId:"live-fixed-evaluation",expectedGeneration:0}});
return await tools.call({name:"harness_run",arguments:{digest:candidate.harnessDigest,input:${JSON.stringify(inputs[2])},operationId:"live-fresh"}});` } });
  const returned = request.trajectory.find((e: Event) => e.type === "ToolReturned");
  assert.equal(returned.result.result.status, "satisfied");
  return Effect.succeed({ kind: "complete" as const, output: "Pinned repository source verified and reused" });
} });
const host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "public-source-witness", ownsThread: t => t === "user-123", actorFor: () => definition, layersFor: () => Layer.merge(harness.inference(model), harness.sandboxLayer()) });
try {
  const library = new HarnessLibrary(binding, { read: () => host.read("user-123"), append: async events => { for (const event of events) await host.commitRoot(host.self("user-123"), event); } });
  const contract: HarnessContract = { version: 1, outcome: "Render class tokens for the declared fixed validation cases", inputSchema: { type: "object", properties: { values: { type: "array" } }, required: ["values"], additionalProperties: false }, outputSchema: { type: "string" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: { coverage: "fixed-fixture-cases" }, timeoutMs: 20000 };
  contractDigest = await library.registerContract(contract);
  await host.commitRoot(host.self("user-123"), { type: "MessageReceived", id: "live-source-task", at: Date.now(), text: "Verify the public clsx source through the registry and sandbox" });
  await host.drive();
  const events = await host.read("user-123");
  const source = events.find(e => e.type === "AikoHarnessSourceObserved")!;
  const witness = events.find(e => e.type === "AikoHarnessChecked" && e.id === "live-fresh")?.witness as any;
  assert.equal(witness?.status, "satisfied");
  const result = await binding.blobs.get("123", witness.outputRef);
  assert.equal(result, "fresh confirmed reused");
  assert.equal(events.filter(e => e.type === "AikoHarnessChecked").length, 3);
  assert.ok(receipts.every(r => r.browserStarts === 0));
  const before = receipts.length, calls = modelCalls;
  await host.drive(); assert.equal(receipts.length, before); assert.equal(modelCalls, calls);
  const report = { status: "satisfied", repository: source.repository, revision: source.revision, sourceSnapshot: source.snapshotDigest, result, checkedCases: 3, sandboxJobs: receipts.length, browserStarts: 0, requests: receipts.reduce((sum, r) => sum + r.requests, 0), fixtureModelCalls: modelCalls, scope: "local sandbox, public GitHub, fixed validation cases; no Codegraff or general accuracy claim", directory };
  await writeFile(join(directory, "trace.json"), JSON.stringify(events, null, 2));
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await host.close(); db.close(); }
