import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Event } from "tardie/core/event";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryComponent, harnessLibraryEventKey, harnessLibraryState, harnessLibraryTools, type HarnessArtifact, type HarnessContract, type HarnessLibraryBinding, type HarnessVerifier } from "../src/harness-library.ts";
import { HarnessRevisions } from "../src/harness-revisions.ts";
import { harnessSourceState, sourceAwareHarnessBinding } from "../src/harness-sources.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { BrowserLearning } from "../src/browser-learning.ts";
import { ownedNetworkDefinitions } from "../src/capability-builder-network.ts";
import { executeHarnessAction } from "@unbrowse/browser-harness/harness-runtime";
import { compileHarnessSkill } from "../src/harness-skill.ts";

const dbs: Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const signal = () => AbortSignal.timeout(10000);
async function fixture() {
  const db = new Database(":memory:"); dbs.push(db);
  const events: Event[] = [];
  const journal = { read: async () => [...events], append: async (batch: Event[]) => {
    const fresh = batch.filter(e => !events.some(old => harnessLibraryEventKey(old) === harnessLibraryEventKey(e)));
    if (!harnessLibraryAppendAllowed(fresh, () => events)) throw Error("append fence");
    events.push(...structuredClone(fresh));
  } };
  const verifier: HarnessVerifier = { digest: harnessDigest("revision-independent-verifier"), evaluatorDigest: harnessDigest("revision-fixed-cases"),
    cases: [{ id: "positive", input: { n: 3 }, split: "development" }, { id: "negative", input: { n: -17 }, split: "held-out" }],
    verify: async ({ input, output }) => ({ passed: output === (input as { n: number }).n * 2, evidence: ["independent-arithmetic"], quality: null }) };
  let calls = 0, allowed = true, runtime = 1;
  const binding: HarnessLibraryBinding = { owner: "revision-owner", thread: "user-revision-owner", blobs: harnessBlobStore(sqliteWorkflowKV(db)), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {},
    context: async () => ({ placement: "local", runtimeDigest: harnessDigest(runtime), bindings: {} }),
    authorize: async () => allowed,
    execute: async (job, s) => {
      calls++;
      const result = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, s);
      return result.error ? { status: "failed", evidence: ["quickjs-error"] } : { status: "succeeded", output: result.result as number, evidence: ["quickjs-executed"] };
    } };
  const library = new HarnessLibrary(binding, journal);
  const contract: HarnessContract = { version: 1, outcome: "Double the supplied number", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false }, outputSchema: { type: "number" }, effect: "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, applicability: {}, timeoutMs: 2000, transfer: { version: 1, minimumNovelHeldOutInputs: 1 } };
  const contractDigest = await library.registerContract(contract);
  const artifact: HarnessArtifact = { version: 1, name: "revision.double", description: "Double a value", runtime: "javascript", entrypoint: "main.js", files: { "main.js": "return input.n * 2;" }, sources: [{ uri: "fixture:observed-source", revision: "original", digest: harnessDigest("original evidence"), license: "fixture" }], dependencies: [], contractDigest };
  const digest = await library.record(artifact);
  const revisions = new HarnessRevisions(library);
  return { events, journal, binding, library, revisions, artifact, digest, contract, contractDigest, verifier, calls: () => calls, revoke: () => allowed = false, drift: () => runtime++ };
}

test("inspect, edit, test, promote and recall preserve source evidence and exact old watch pins across restart", async () => {
  const f = await fixture();
  await f.library.evaluate(f.digest, "baseline", signal()); await f.library.promote(f.digest, "baseline", 0, signal());
  const pinned = { harness: f.digest, contract: f.contractDigest };
  f.events.push({ type: "AikoChannelWiringConnected", owner: f.binding.owner, id: "existing-watch", wire: { handler: pinned } });
  const original = await f.revisions.inspect(f.digest, signal());
  expect(original.expectedGeneration).toBe(1);
  const next = await f.revisions.derive(f.digest, { files: { "main.js": "const n = input.n; return n + n;" } }, signal());
  const edited = await f.revisions.inspect(next.digest, signal());
  expect(edited.artifact.sources).toEqual(original.artifact.sources);
  expect(edited.lineage).toEqual({ version: 1, predecessorDigest: f.digest, changedFields: ["files"] });
  const document = compileHarnessSkill(edited.artifact, edited.contract, { harnessDigest: next.digest, contractDigest: f.contractDigest,
    verifierDigest: f.verifier.digest, evaluatorDigest: f.verifier.evaluatorDigest, sourceWatermark: 1,
    witnesses: [{ reference: harnessDigest("structural-doc-witness"), status: "unknown", contextDigest: harnessDigest("context") }], totalWitnesses: 1, evaluations: [] });
  expect(document.references["references/provenance.json"]).toMatchObject({ revision: edited.lineage, sources: original.artifact.sources });
  expect((await f.library.resolve(f.digest)).artifact).toEqual(original.artifact);
  expect((await f.revisions.evaluate(next.digest, "revision-cases", signal())).status).toBe("eligible");
  expect((await f.revisions.promote(next.digest, "revision-cases", 1, signal())).status).toBe("promoted");
  expect((f.events.find(e => e.id === "existing-watch")!.wire as any).handler).toEqual(pinned);
  const restarted = new HarnessRevisions(new HarnessLibrary(f.binding, f.journal));
  const calls = f.calls(), rows = f.events.length;
  const recalled = await restarted.recall(f.artifact.name, f.contractDigest, { n: 209 }, signal());
  expect(recalled).toMatchObject({ status: "available", digest: next.digest, procedure: { basis: "verified-transfer" } });
  expect(f.calls()).toBe(calls); expect(f.events).toHaveLength(rows);
  expect(JSON.stringify(recalled)).not.toContain('"n":-17');
  const fresh = await restarted.library.call(f.artifact.name, f.contractDigest, { n: 209 }, "fresh", signal());
  expect(await f.binding.blobs.get(f.binding.owner, fresh.outputRef!)).toBe(418);
  const old = await restarted.library.run(pinned.harness, { n: 11 }, "old-pin", signal());
  expect(await f.binding.blobs.get(f.binding.owner, old.outputRef!)).toBe(22);
});

test("failed and malformed revisions remain separate candidates without overwriting the working route", async () => {
  const f = await fixture(); await f.library.evaluate(f.digest, "baseline", signal()); await f.library.promote(f.digest, "baseline", 0, signal());
  const bad = await f.revisions.derive(f.digest, { files: { "main.js": "return 6;" } }, signal());
  expect((await f.revisions.evaluate(bad.digest, "bad-cases", signal())).status).toBe("failed");
  await expect(f.revisions.promote(bad.digest, "bad-cases", 1, signal())).rejects.toThrow("Passing evaluation");
  expect((await f.revisions.inspect(bad.digest, signal())).status).toBe("inspectable");
  expect((await f.revisions.recall(f.artifact.name, f.contractDigest, { n: 41 }, signal()))).toMatchObject({ digest: f.digest });
  for (const changes of [{ sources: [] }, { contractDigest: harnessDigest("unregistered") }, { name: "forge" }, { files: { "../escape.js": "return 1;" } }, {}])
    await expect(f.revisions.derive(f.digest, changes as any, signal())).rejects.toThrow();
  expect((await f.library.resolve(f.digest)).artifact).toEqual(f.artifact);
});

test("fresh input validation, current authority, owner isolation and runtime drift govern recall and execution", async () => {
  const f = await fixture(); await f.library.evaluate(f.digest, "baseline", signal()); await f.library.promote(f.digest, "baseline", 0, signal());
  expect(await f.revisions.recall(f.artifact.name, f.contractDigest, { typo: 2 }, signal())).toMatchObject({ status: "unavailable", reason: "input-schema-mismatch" });
  const foreign = new HarnessRevisions(new HarnessLibrary({ ...f.binding, owner: "other", thread: "user-other" }, f.journal));
  await expect(foreign.derive(f.digest, { description: "foreign" }, signal())).rejects.toThrow("Owned harness");
  f.revoke(); const before = f.calls();
  expect(await f.revisions.recall(f.artifact.name, f.contractDigest, { n: 4 }, signal())).toMatchObject({ status: "unavailable", reason: "current-authority-or-dependencies-unavailable" });
  expect(await f.revisions.promote(f.digest, "baseline", 1, signal())).toMatchObject({ status: "unavailable" });
  expect((await f.library.call(f.artifact.name, f.contractDigest, { n: 4 }, "revoked", signal())).status).toBe("blocked");
  f.drift();
  expect(await f.revisions.recall(f.artifact.name, f.contractDigest, { n: 4 }, signal())).toMatchObject({ status: "unavailable", reason: "verified-route-or-artifact-unavailable" });
  expect(f.calls()).toBe(before);
});

test("changed effects require a separately registered contract and controlled evaluation authority", async () => {
  const f = await fixture();
  const write = await f.library.registerContract({ ...f.contract, effect: "write" });
  const next = await f.revisions.derive(f.digest, { contractDigest: write }, signal());
  await expect(f.revisions.evaluate(next.digest, "write-without-fixtures", signal())).rejects.toThrow("Controlled fixture authorization");
  expect(f.calls()).toBe(0);
  expect(harnessLibraryState(f.events, f.binding.owner).heads.size).toBe(0);
});

test("re-evaluation after uncertain execution never silently re-dispatches it", async () => {
  const f = await fixture(); let calls = 0;
  f.binding.execute = async () => { calls++; return { status: "unknown", evidence: ["lost-ack"] }; };
  const next = await f.revisions.derive(f.digest, { description: "Uncertain candidate" }, signal());
  const first = await f.revisions.evaluate(next.digest, "unknown-eval", signal());
  expect(first.status).toBe("unknown");
  await new HarnessRevisions(new HarnessLibrary(f.binding, f.journal)).evaluate(next.digest, "unknown-eval", signal());
  expect(calls).toBe(2);
  await expect(f.revisions.promote(next.digest, "unknown-eval", 0, signal())).rejects.toThrow();
});

test("source-derived revision ancestry retains dependency drift checks", async () => {
  const f = await fixture();
  const sourceId = harnessDigest("source"), snapshotDigest = await f.binding.blobs.put(f.binding.owner, { license: { digest: harnessDigest("license") }, files: [{ path: "source.js", digest: harnessDigest("old-source") }] });
  f.events.push({ type: "AikoHarnessSourceObserved", owner: f.binding.owner, snapshotDigest },
    { type: "AikoHarnessSourceHeadChanged", owner: f.binding.owner, sourceId, snapshotDigest, generation: 1, previousGeneration: 0 },
    { type: "AikoHarnessSourceCandidateDerived", owner: f.binding.owner, harnessDigest: f.digest, sourceId, snapshotDigest, licenseDigest: harnessDigest("license"), dependencies: [{ path: "source.js", digest: harnessDigest("old-source") }] });
  const next = await f.revisions.derive(f.digest, { files: { "main.js": "return input.n + input.n;" } }, signal());
  expect(harnessSourceState(f.events, f.binding.owner).derived.has(next.digest)).toBe(true);
  const guarded = new HarnessLibrary(sourceAwareHarnessBinding(f.binding, f.journal), f.journal);
  expect((await guarded.run(next.digest, { n: 7 }, "before-drift", signal())).status).toBe("satisfied");
  const changedSnapshot = await f.binding.blobs.put(f.binding.owner, { license: { digest: harnessDigest("license") }, files: [{ path: "source.js", digest: harnessDigest("changed-source") }] });
  f.events.push({ type: "AikoHarnessSourceObserved", owner: f.binding.owner, snapshotDigest: changedSnapshot },
    { type: "AikoHarnessSourceHeadChanged", owner: f.binding.owner, sourceId, snapshotDigest: changedSnapshot, generation: 2, previousGeneration: 1 });
  const before = f.calls();
  expect((await guarded.run(next.digest, { n: 8 }, "after-drift", signal())).status).toBe("blocked");
  expect(f.calls()).toBe(before);
});

test("revision tools are mounted through the existing library facade", async () => {
  const f = await fixture(); const names = harnessLibraryTools(f.binding).map(t => t.spec.name);
  for (const name of ["inspect", "revise", "revision_evaluate", "revision_promote", "recall"]) expect(names).toContain(`harness_${name}`);
});

test("native CodeMode revision tools evaluate and promote one immutable candidate then call fresh inputs", async () => {
  const f = await fixture(), db = new Database(":memory:"); dbs.push(db);
  let alarm: number | null = null;
  const storage: AccountStorage = { sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const codeHarness = new CodeHarness(f.binding.owner, f.binding.thread, runCodeSegment, value => value);
  const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [harnessLibraryComponent(f.binding.owner),
    infer([codeMode([codeHarness.package(harnessLibraryTools(f.binding))]), outputValidateOnce])] });
  const code = `const inspected = await tools.call({name:"harness_inspect",arguments:{digest:"${f.digest}"}});
    const candidate = await tools.call({name:"harness_revise",arguments:{predecessorDigest:"${f.digest}",changes:{files:{"main.js":"return input.n + input.n;"}}}});
    const evaluated = await tools.call({name:"harness_revision_evaluate",arguments:{digest:candidate.digest,evaluationId:"native-revision"}});
    const promoted = await tools.call({name:"harness_revision_promote",arguments:{digest:candidate.digest,evaluationId:"native-revision",expectedGeneration:inspected.expectedGeneration}});
    const recalled = await tools.call({name:"harness_recall",arguments:{name:"${f.artifact.name}",contractDigest:"${f.contractDigest}",input:{n:51}}});
    const result = await tools.call({name:"harness_run",arguments:{digest:recalled.digest,input:{n:51},operationId:"native-revision-fresh"}});
    return {evaluated:evaluated.status,promoted:promoted.status,recalled:recalled.status,result:result.status};`;
  const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }), react: (request: any) => {
    const returned = request.trajectory.find((e: Event) => e.type === "ToolReturned");
    if (!returned) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "revision-flow", arguments: { code } });
    expect(returned.result.result).toEqual({ evaluated: "eligible", promoted: "promoted", recalled: "available", result: "satisfied" });
    return Effect.succeed({ kind: "complete" as const, output: "Revision checked and reused" });
  } });
  const host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "revision-test", ownsThread: t => t === f.binding.thread,
    actorFor: () => definition, layersFor: () => Layer.merge(codeHarness.inference(model), codeHarness.sandboxLayer()) });
  try {
    for (const event of f.events) await host.commitRoot(host.self(f.binding.thread), event);
    await host.commitRoot(host.self(f.binding.thread), { type: "MessageReceived", id: "revision-turn", at: Date.now(), text: "Revise and test the reusable operation" });
    await host.drive();
    const events = await host.read(f.binding.thread);
    expect(events.find(e => e.type === "TurnCompleted")?.output).toBe("Revision checked and reused");
    const witness = events.find(e => e.type === "AikoHarnessChecked" && e.id === "native-revision-fresh")!.witness as any;
    expect(await f.binding.blobs.get(f.binding.owner, witness.outputRef)).toBe(102);
    const before = f.calls(); await host.drive(); expect(f.calls()).toBe(before);
  } finally { await host.close(); }
});

test("learned indexed request becomes an evaluated network revision and recalls fresh HTTP inputs", async () => {
  const f = await fixture(); let sequence = 0;
  const learning = new BrowserLearning({ threadId: "owned-capture", nextSequence: () => ++sequence, emit: async e => { f.events.push(e); } });
  const entry = { startedDateTime: new Date(1000).toISOString(), time: 20, _observationComplete: true,
    request: { method: "GET", url: "https://api.vendor.com/double?n=3", headers: [], cookies: [] },
    response: { status: 200, headers: [], cookies: [], content: { mimeType: "application/json", size: 12, text: '{"result":6}' } } };
  await learning.observe(entry, 0, true);
  await learning.compile([entry], [{ callId: "learn", action: "navigate", startedAtMs: 999, endedAtMs: 1050, direct: true, resultObserved: true }], "https://api.vendor.com");
  const observed = ownedNetworkDefinitions(f.events)[0]!;
  expect(observed).toBeDefined();
  const query = observed.definition.steps[0]!.query.n;
  if (query?.kind !== "input") throw Error("Fixture query must be a declared input");
  const inputFor = (n: number) => Object.fromEntries(observed.definition.inputs.map(i => [i.name, i.name === query.name ? String(n) : "double"]));
  const verifier: HarnessVerifier = { digest: harnessDigest("network-revision-check"), evaluatorDigest: harnessDigest("network-revision-cases"),
    cases: [{ id: "positive", input: inputFor(3), split: "development" }, { id: "negative", input: inputFor(-11), split: "held-out" }],
    verify: async ({ input, output }) => ({ passed: (output as any).result === Number((input as any)[query.name]) * 2, evidence: ["independent-network-value"], quality: null }) };
  f.binding.verifiers = new Map([...f.binding.verifiers, [verifier.digest, verifier]]);
  const contract = { ...f.contract, inputSchema: { type: "object", properties: Object.fromEntries(observed.definition.inputs.map(i => [i.name, { type: i.type }])), required: observed.definition.inputs.filter(i => i.required).map(i => i.name), additionalProperties: false },
    outputSchema: { type: "object", properties: { result: { type: "number" } }, required: ["result"], additionalProperties: false },
    verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest,
    applicability: { observedRequest: { version: 1, toolDigest: observed.toolDigest, effect: "read" } } };
  const contractDigest = await f.library.registerContract(contract);
  expect(await f.revisions.fromRequest(observed.toolDigest as any, "learned.double", contractDigest, signal())).toMatchObject({ status: "unavailable" });
  f.events.push({ type: "AikoRequestMemoryIndexed", owner: f.binding.owner, toolDigest: observed.toolDigest });
  await expect(f.revisions.fromRequest(observed.toolDigest as any, "learned.double", f.contractDigest, signal())).rejects.toThrow("independently classify");
  const source = await f.revisions.fromRequest(observed.toolDigest as any, "learned.double", contractDigest, signal());
  if (source.status !== "candidate" || !source.digest) throw Error("Expected observed candidate");
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    requests++; return Response.json({ result: Number(new URL(request.url).searchParams.get("n")) * 2 });
  } });
  f.binding.execute = async (job, s) => {
    const executable = JSON.parse(job.artifact.files[job.artifact.entrypoint]!);
    let output: any;
    const result = await executeHarnessAction({ artifact: executable.graph, actionId: executable.actionId, input: job.input as any, adapters: {
      clock: { now: () => new Date() }, uuid: { next: () => crypto.randomUUID() },
      transport: { send: async request => {
        s.throwIfAborted(); const url = new URL(request.url);
        if (url.origin !== "https://api.vendor.com" || request.method !== "GET") throw Error("Outside controlled fixture authority");
        const response = await fetch(`${server.url.origin}${url.pathname}${url.search}`, { signal: s });
        output = await response.json();
        return { status: response.status, headers: { "content-type": "application/json" }, classification: "application", body: output };
      } },
    } });
    return { status: result.status === "completed" ? "succeeded" : "failed", output, evidence: [`controlled-http:${result.status}`] };
  };
  try {
    const inspected = await f.revisions.inspect(source.digest, signal());
    const graph = JSON.parse(inspected.artifact.files[inspected.artifact.entrypoint]!);
    graph.graph.actions[0].steps[0].expectedStatuses = [200, 201];
    const revision = await f.revisions.derive(source.digest, { files: { "request.json": JSON.stringify(graph) } }, signal());
    expect((await f.revisions.evaluate(revision.digest, "network-fixed-cases", signal())).status).toBe("eligible");
    expect((await f.revisions.promote(revision.digest, "network-fixed-cases", 0, signal())).status).toBe("promoted");
    const restarted = new HarnessRevisions(new HarnessLibrary(f.binding, f.journal));
    expect(await restarted.recall("learned.double", contractDigest, inputFor(43), signal())).toMatchObject({ status: "available", digest: revision.digest });
    expect(requests).toBe(2);
    const witness = await restarted.library.call("learned.double", contractDigest, inputFor(43), "network-new-input", signal());
    expect(await f.binding.blobs.get(f.binding.owner, witness.outputRef!)).toEqual({ result: 86 });
    expect(requests).toBe(3);
    f.binding.authorize = async () => {
      const index = f.events.findIndex(e => e.type === "AikoRequestMemoryIndexed"); if (index >= 0) f.events.splice(index, 1);
      return true;
    };
    expect((await restarted.library.run(revision.digest, inputFor(44), "source-retired-during-authorization", signal())).status).toBe("unknown");
    expect(await restarted.recall("learned.double", contractDigest, inputFor(44), signal())).toMatchObject({ status: "unavailable" });
    expect(await restarted.library.run(revision.digest, inputFor(43), "network-new-input", signal())).toEqual(witness);
    expect(requests).toBe(3);
  } finally { await server.stop(true); }
});
