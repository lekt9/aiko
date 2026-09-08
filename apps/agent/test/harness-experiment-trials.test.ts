import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer } from "effect";
import { actor } from "tardie";
import type { Event } from "tardie/core/event";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";
import { harnessExperimentWaitMethod } from "../src/harness-experiment.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryEventKey, harnessLibraryState,
  type HarnessArtifact, type HarnessContract, type HarnessDigest, type HarnessJournal, type HarnessLibraryBinding, type HarnessVerifier } from "../src/harness-library.ts";
import { createHarnessSandboxBinding, type HarnessSandboxAuthority } from "../src/harness-sandbox.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import type { SandboxJob, SandboxJobReceipt } from "../src/sandbox-job.ts";
import { HarnessExperimentTrials, harnessExperimentTrialLifecycle, harnessExperimentTrialEventKey, harnessExperimentTrialExternalEventAllowed,
  harnessExperimentTrialIsChild, harnessExperimentTrialOperation, harnessExperimentTrialThread, type HarnessExperimentTrialRequest } from "../src/harness-experiment-trials.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const signal = () => AbortSignal.timeout(20000);
const owner = "123", parentThread = "user-123";
async function fixture(options: { network?: boolean; write?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "harness-native-trials-"));
  const db = new Database(join(directory, "actor.sqlite"));
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost<any>>>;
  cleanup.push(async () => { await host?.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
  let alarm: number | null = null, allowed = true, checks = 0;
  let pause: "execute" | "return" | undefined;
  let rejectEvent: string | string[] | undefined;
  let lifecycleOnly = false, lifecycleOwner = owner;
  let parentRead: (() => Promise<readonly Event[]>) | undefined;
  let crashAfterChildEdge = false;
  let beforeAuthorize: (() => Promise<void>) | undefined, beforeRead: (() => Promise<void>) | undefined;
  let requestedNetwork!: () => void, requests = 0, networkAborts = 0;
  const networkEntered = new Promise<void>(resolve => { requestedNetwork = resolve; });
  const networkServer = options.network ? Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    requests++; requestedNetwork();
    // A real TCP request stays in flight until the sandbox's signal closes it.
    await new Promise<void>(resolve => request.signal.addEventListener("abort", () => resolve(), { once: true }));
    return Response.json(8);
  } }) : undefined;
  if (networkServer) cleanup.push(async () => { await networkServer.stop(true); });
  const storage: AccountStorage = { sql: { exec: (query, ...args) => { const rows = db.query(query).all(...args as any); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {
      if (crashAfterChildEdge && db.query("SELECT 1 FROM aiko_thread_events WHERE thread=? AND event LIKE '%\"type\":\"ChildCreated\"%' LIMIT 1").get(parentThread)) {
        crashAfterChildEdge = false; throw Error("fixture-crash-after-child-edge-before-router");
      }
    }, getAlarm: async () => alarm,
    setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  const runtimeDigest = await sandboxEnvironment("native-experiment-trials-v1");
  const authority: HarnessSandboxAuthority = { owner, active: true, runtimeDigest, contextRef: "controlled-fixture-context-v1", authorityRef: "fixture-read-v1",
    sessionRevision: null, effects: [options.write ? "write" : "read"], origins: networkServer ? [networkServer.url.origin] : [], methods: networkServer ? [options.write ? "POST" : "GET"] : [], budget: { wallMs: 5000, requests: networkServer ? 1 : 0, outputBytes: 32768 } };
  const sandbox = localHarnessSandbox({ owner, environmentDigest: runtimeDigest, journal: await sandboxJobJournal(db, join(directory, "sandbox.key")),
    ...(networkServer ? { send: async (request: any, s: AbortSignal) => {
      s.addEventListener("abort", () => { networkAborts++; }, { once: true });
      const response = await fetch(request.url, { method: request.method, signal: s });
      return { status: response.status, headers: { "content-type": "application/json" }, body: await response.json(), classification: "application" as const };
    } } : {}) });
  const jobs: SandboxJob[] = [];
  const receipts: SandboxJobReceipt[] = [];
  const networkReceipt = Promise.withResolvers<SandboxJobReceipt>();
  const transport = { harnessEnvironment: sandbox.harnessEnvironment, harnessJob: async (job: SandboxJob, s?: AbortSignal) => {
    jobs.push(structuredClone(job)); const receipt = await sandbox.harnessJob(job, s); receipts.push(receipt); if (job.artifact.kind === "network") networkReceipt.resolve(receipt); return receipt;
  } };
  const sandboxOptions = { placement: "local" as const, sandbox: transport, current: async () => authority };
  const bridge = createHarnessSandboxBinding({ ...sandboxOptions, owner, thread: parentThread });
  const verifier: HarnessVerifier = { digest: harnessDigest("native-trial-independent-verifier"), evaluatorDigest: harnessDigest("native-trial-fixed-dataset-v1"),
    cases: [
      { id: "development", split: "development", input: { n: 4, private_marker: "PRIVATE_DEVELOPMENT_80aef" } },
      { id: "heldout", split: "held-out", input: { n: -137, private_marker: "PRIVATE_HELDOUT_ab9d71" } },
    ], verify: async ({ input, output }) => { checks++; const passed = output === (input as any).n * 2;
      return { passed, quality: passed ? 1 : 0, evidence: [passed ? "fixed-double-verified" : "fixed-double-violated"] }; } };
  const binding: HarnessLibraryBinding = { owner, thread: parentThread, blobs: harnessBlobStore(sqliteWorkflowKV(db)), guard: () => {},
    verifiers: new Map([[verifier.digest, verifier]]), ...bridge,
    ...(options.write ? { authorizeEvaluation: async (artifact: HarnessArtifact, contract: HarnessContract) => !!networkServer && artifact.name === "waiting-network" && contract.effect === "write" } : {}) };
  const journal: HarnessJournal = { read: () => host.read(parentThread), append: async rows => { for (const row of rows) await host.commitRoot(host.self(parentThread), row); } };
  const trials = new HarnessExperimentTrials({ binding, journal, authorize: async scope => { await beforeAuthorize?.(); return allowed && scope.owner === owner; },
    sandbox: async () => sandboxOptions, readThread: async thread => { await beforeRead?.(); return host.read(thread); } });
  const open = async () => {
    const lifecycle = lifecycleOnly ? harnessExperimentTrialLifecycle({ owner: lifecycleOwner, parentThread: `user-${lifecycleOwner}`,
      readParent: () => parentRead ? parentRead() : host.read(parentThread) }) : trials;
    const parent = actor({ name: "aiko", methods: { harnessExperimentWait: harnessExperimentWaitMethod }, components: [lifecycle.component()] });
    const worker = lifecycle.worker();
    const controlled = { ...worker, machine: { ...worker.machine, output: (state: any) => {
      const output = worker.machine.output(state);
      return { ...output, transitions: output.transitions.filter(t => !pause || !t.key.startsWith(`aiko-harness-trial:${pause}:`)) };
    } } };
    const child = actor({ name: "aiko", methods: {}, components: [controlled] });
    host = await createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "native-trial-test", ownsThread: t => t === parentThread,
      allowChild: (parent, child) => parent === parentThread && harnessExperimentTrialIsChild(child),
      actorFor: t => t === parentThread ? parent : harnessExperimentTrialIsChild(t) ? child : undefined,
      layersFor: () => Layer.empty, keyOf: e => harnessExperimentTrialEventKey(e) ?? harnessLibraryEventKey(e),
      canAppend: (_thread, rows, read) => !rows.some(e => typeof rejectEvent === "string" ? e.type === rejectEvent : rejectEvent?.includes(e.type)) && harnessLibraryAppendAllowed(rows, read) });
  };
  await open();
  const library = new HarnessLibrary(binding, journal);
  const contract: HarnessContract = { version: 1, outcome: "Double fixed numeric inputs", inputSchema: { type: "object", properties: {
    n: { type: "number" }, private_marker: { type: "string" } }, required: ["n", "private_marker"], additionalProperties: false },
    outputSchema: { type: "number" }, effect: options.write ? "write" : "read", verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest,
    applicability: {}, timeoutMs: 5000 };
  const contractDigest = await library.registerContract(contract);
  const seed = async (source: string) => {
    const artifact: HarnessArtifact = { version: 1, name: "trial-double", description: "Fixed numeric trial", runtime: "javascript", entrypoint: "main.js",
      files: { "main.js": source }, dependencies: [], sources: [{ uri: "fixture:native-trial", revision: "v1", digest: harnessDigest(source), license: "fixture" }], contractDigest };
    return library.record(artifact);
  };
  const baseline = await seed("return input.n*2;"), candidate = await seed("return input.n < 0 ? 0 : input.n*2;");
  const network = networkServer ? await library.record({ version: 1, name: "waiting-network", description: "Controlled in-flight request", runtime: "network", entrypoint: "network.json", dependencies: [], sources: [], contractDigest,
    files: { "network.json": JSON.stringify({ actionId: "read", graph: { schemaVersion: 2, executorAbi: "site-harness/1", siteId: "trial-fixture", version: "1", sourceCaptureDigest: harnessDigest("trial-network-capture"), allowedOrigins: [networkServer.url.origin],
      actions: [{ id: "read", inputs: [{ name: "n", type: "number", required: true }, { name: "private_marker", type: "string", required: true }], steps: [{ id: "request", dependsOn: [], method: options.write ? "POST" : "GET", origin: networkServer.url.origin, path: "/wait", pathParameters: {}, query: {}, headers: {}, expectedStatuses: [200] }] }] } }) } }) : undefined;
  const deadlineAt = Date.now() + 60000;
  const request = async (harnessDigest: HarnessDigest, phase: HarnessExperimentTrialRequest["phase"] = "development", repeat = 0) => {
    const base = { experimentId: "native-trial-experiment", harnessDigest, phase, caseId: phase === "development" ? "development" : "heldout", repeat,
      contextDigest: harnessDigestFn(await binding.context(signal())), deadlineAt };
    return { ...base, operationId: harnessExperimentTrialOperation(base) };
  };
  const harnessDigestFn = harnessDigest;
  return { trials, binding, baseline, candidate, request, jobs, receipts, networkReceipt: networkReceipt.promise, network, networkEntered, networkCounts: () => ({ requests, networkAborts }), counts: () => ({ jobs: jobs.length, checks }), journal,
    get host() { return host; }, setAllowed: (v: boolean) => { allowed = v; }, setPause: (v: typeof pause) => { pause = v; },
    setRejectedEvent: (v: typeof rejectEvent) => { rejectEvent = v; },
    crashAfterChildEdge: () => { crashAfterChildEdge = true; },
    beforeAuthorize: (v: typeof beforeAuthorize) => { beforeAuthorize = v; }, beforeRead: (v: typeof beforeRead) => { beforeRead = v; },
    reopen: async () => { await host.close(); await open(); await host.recover(); },
    reopenLifecycle: async (scopeOwner = owner, read?: typeof parentRead) => {
      await host.close(); lifecycleOnly = true; lifecycleOwner = scopeOwner; parentRead = read;
      await open(); await host.recover();
    },
    db,
  };
}

test("native Router gives each candidate/case/repeat an isolated child sandbox and joins actual checked evidence", async () => {
  const f = await fixture();
  const requests = [await f.request(f.baseline), await f.request(f.baseline, "held-out"), await f.request(f.candidate), await f.request(f.candidate, "held-out"), await f.request(f.baseline, "development", 1)];
  for (const r of requests) expect((await f.trials.request(r, signal())).status).toBe("pending");
  await f.host.drive();
  expect(f.counts()).toEqual({ jobs: 5, checks: 5 });
  const children = new Set<string>();
  for (const r of requests) {
    const result = await f.trials.result(r.operationId, signal());
    expect(result.status).toBe("checked");
    if (result.status !== "checked") throw Error("Expected native checked witness");
    children.add(result.childThread);
    expect(result.witness.operationId).toBe(r.operationId);
    expect(result.witness.status).toBe(r.harnessDigest === f.candidate && r.phase === "held-out" ? "violated" : "satisfied");
    expect(result.witness.measurements).toEqual({ networkRequests: 0, browserStarts: 0, modelCalls: 0, tokens: 0 });
    const joined = (await f.journal.read()).find(e => e.type === "AikoHarnessTrialJoined" && e.id === r.operationId)!;
    expect(joined.witnessDigest).toBe(harnessDigest(result.witness));
    expect(joined.experimentId).toBe(r.experimentId);
    expect(joined.joinedLatencyMs).toBe(null);
    const rows = await f.host.read(result.childThread);
    expect(joined.inputRef).toBe(rows.find(e => e.type === "AikoHarnessRunStarted")!.inputRef);
    expect((rows[0]!.parent as any).thread).toBe(parentThread);
    expect(rows.filter(e => e.type === "AikoHarnessRunStarted")).toHaveLength(1);
    expect(rows.filter(e => e.type === "AikoHarnessChecked")).toHaveLength(1);
    expect(f.jobs.find(job => job.operationId === `harness:${harnessDigest([result.childThread, r.operationId]).slice(7)}`)?.owner).toBe(owner);
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_HELDOUT_ab9d71");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_DEVELOPMENT_80aef");
    expect(rows.some(e => e.type.startsWith("Inference") || e.type === "ModelCalled")).toBe(false);
  }
  expect(children.size).toBe(5);
  const parent = await f.journal.read();
  expect(parent.filter(e => e.type === "ChildCreated")).toHaveLength(5);
  expect(parent.filter(e => e.type === "AikoHarnessRunStarted")).toHaveLength(0);
  expect(JSON.stringify(parent)).not.toContain("PRIVATE_HELDOUT_ab9d71");
  await f.reopen();
  for (const r of requests) expect((await f.trials.request(r, signal())).status).toBe("checked");
  await f.host.drive();
  expect(f.counts()).toEqual({ jobs: 5, checks: 5 });
  expect(await f.journal.read()).toEqual(parent);
});

for (const pause of ["execute", "return"] as const) test(`native SQLite restart at ${pause} preserves one trial and does not rerun settled work`, async () => {
  const f = await fixture(), request = await f.request(f.baseline, "held-out");
  f.setPause(pause);
  await f.trials.request(request, signal()); await f.host.drive();
  expect(f.counts()).toEqual({ jobs: pause === "return" ? 1 : 0, checks: pause === "return" ? 1 : 0 });
  expect((await f.trials.result(request.operationId, signal())).status).toBe("pending");
  f.setPause(undefined); await f.reopen();
  expect((await f.trials.result(request.operationId, signal())).status).toBe("checked");
  expect(f.counts()).toEqual({ jobs: 1, checks: 1 });
  expect((await f.journal.read()).filter(e => e.type === "ChildCreated")).toHaveLength(1);
});

test("revocation after handoff and foreign ownership deny execution; private input is never reconstructed", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  f.setPause("execute"); await f.trials.request(request, signal()); await f.host.drive();
  f.setAllowed(false); f.setPause(undefined); await f.reopen();
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
  await expect(f.trials.result(request.operationId, signal())).rejects.toThrow("scope_unavailable");
  const wrong = new HarnessExperimentTrials({ binding: { ...f.binding, owner: "456", thread: "user-456" }, journal: f.journal,
    authorize: async () => true, readThread: thread => f.host.read(thread), sandbox: async () => { throw Error("Foreign owner cannot reach sandbox"); } });
  await expect(wrong.request(request, signal())).rejects.toThrow();
  expect(harnessExperimentTrialThread("456", "user-456", request.operationId)).not.toBe(harnessExperimentTrialThread(owner, parentThread, request.operationId));
  expect(harnessExperimentTrialExternalEventAllowed({ type: "AikoHarnessTrialReturned", id: request.operationId, owner, status: "checked", quality: 1 })).toBe(false);
});

test("returned score or substituted receipt cannot settle a parent without matching native child evidence", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  f.setPause("return"); await f.trials.request(request, signal()); await f.host.drive();
  const rows = await f.journal.read(), requested = rows.find(e => e.type === "AikoHarnessTrialRequested")!;
  // Adversarial trusted-history injection probes the parent checker; normal public
  // ingress rejects this event before it can acquire a Router source identity.
  await f.host.commit({ link: { source: parseThreadAddress(f.host.self(String(requested.childThread))), target: parseThreadAddress(f.host.self(parentThread)) }, event: {
    ...requested, type: "AikoHarnessTrialReturned", owner, id: request.operationId, briefRef: requested.briefRef,
    childThread: requested.childThread, status: "checked", witnessRef: harnessDigest("forged-perfect-score"), quality: 1,
  } });
  await f.host.drive();
  expect((await f.trials.result(request.operationId, signal())).status).toBe("unavailable");
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialJoined")).toBe(false);
  expect(f.counts()).toEqual({ jobs: 1, checks: 1 });
});

test("missing private brief remains unavailable on request replay without rebuilding custody or executing", async () => {
  const f = await fixture(), request = await f.request(f.baseline, "held-out");
  f.setPause("execute"); await f.trials.request(request, signal()); await f.host.drive();
  const requested = (await f.journal.read()).find(e => e.type === "AikoHarnessTrialRequested")!;
  const key = `harness-blobs:${harnessDigest(owner)}:${requested.briefRef}`;
  expect(f.db.query("DELETE FROM workflow_records WHERE key=?").run(key).changes).toBe(1);
  f.setPause(undefined); await f.reopen();
  await expect(f.trials.request(request, signal())).rejects.toThrow();
  expect(f.db.query("SELECT value FROM workflow_records WHERE key=?").get(key)).toBe(null);
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialUnavailable")).toBe(true);
});

test("missing checked witness custody rejects the return without recreating its reference or rerunning", async () => {
  const f = await fixture(), request = await f.request(f.baseline, "held-out");
  f.setPause("return"); await f.trials.request(request, signal()); await f.host.drive();
  const child = harnessExperimentTrialThread(owner, parentThread, request.operationId);
  const executed = (await f.host.read(child)).find(e => e.type === "AikoHarnessTrialExecuted")!;
  const key = `harness-blobs:${harnessDigest(owner)}:${executed.witnessRef}`;
  expect(f.db.query("DELETE FROM workflow_records WHERE key=?").run(key).changes).toBe(1);
  f.setPause(undefined); await f.reopen();
  expect((await f.trials.request(request, signal())).status).toBe("unavailable");
  expect(f.db.query("SELECT value FROM workflow_records WHERE key=?").get(key)).toBe(null);
  expect(f.counts()).toEqual({ jobs: 1, checks: 1 });
});

test("lost child execution acknowledgement recovers from actual checked log with no repeat sandbox or verifier", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  f.setRejectedEvent("AikoHarnessTrialExecuted"); await f.trials.request(request, signal());
  await expect(f.host.drive()).rejects.toThrow();
  const child = harnessExperimentTrialThread(owner, parentThread, request.operationId);
  expect(harnessLibraryState(await f.host.read(child), owner).witnesses.get(request.operationId)?.status).toBe("satisfied");
  expect((await f.host.read(child)).some(e => e.type === "AikoHarnessTrialExecuted")).toBe(false);
  f.setRejectedEvent(undefined); await f.reopen();
  expect((await f.trials.result(request.operationId, signal())).status).toBe("checked");
  expect(f.counts()).toEqual({ jobs: 1, checks: 1 });
});

test("a lost checked receipt remains unknown and never reruns an already started trial", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  f.setRejectedEvent("AikoHarnessChecked"); await f.trials.request(request, signal()); await f.host.drive();
  expect((await f.trials.result(request.operationId, signal())).status).toBe("unknown");
  f.setRejectedEvent(undefined); await f.reopen();
  expect((await f.trials.request(request, signal())).status).toBe("unknown");
  expect(f.counts()).toEqual({ jobs: 1, checks: 1 });
});

const stopEvent = (request: HarnessExperimentTrialRequest, type = "AikoHarnessExperimentCancelled"): Event => ({
  type, owner, experimentId: request.experimentId, id: request.experimentId, at: Date.now(),
  ...(type === "AikoHarnessExperimentSettled" ? { status: "budget-exhausted", reason: "absolute-deadline-expired" } : {}),
  ...(type === "AikoHarnessExperimentProposalSettled" ? { status: "no-hypothesis" } : {}),
});
for (const terminal of ["AikoHarnessExperimentCancelled", "AikoHarnessExperimentSettled", "AikoHarnessExperimentProposalSettled"]) test(`${terminal} interrupts an actual in-flight sandbox HTTP job`, async () => {
  const f = await fixture({ network: true }), request = await f.request(f.network!);
  await f.trials.request(request, signal());
  const driving = f.host.drive();
  await f.networkEntered;
  expect(f.counts()).toEqual({ jobs: 1, checks: 0 });
  await f.journal.append([stopEvent(request, terminal)]);
  await driving;
  await f.networkReceipt;
  expect(f.networkCounts()).toEqual({ requests: 1, networkAborts: 1 });
  expect(f.receipts).toHaveLength(1);
  expect(f.receipts[0]!.status).toBe("failed");
  expect(f.receipts[0]!.reason).toBe("cancelled_or_deadline");
  const child = harnessExperimentTrialThread(owner, parentThread, request.operationId), rows = await f.host.read(child);
  expect(rows.some(e => e.type === "AikoHarnessTrialCancelled")).toBe(true);
  expect(rows.find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unknown");
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialJoined")).toBe(false);
  expect((await f.journal.read()).find(e => e.type === "AikoHarnessTrialUnavailable")?.experimentId).toBe(request.experimentId);
  await f.reopen();
  expect(f.counts()).toEqual({ jobs: 1, checks: 0 });
  expect(f.networkCounts().requests).toBe(1);
});

test("cancellation before dispatch allocates no child and survives restart", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  await f.trials.request(request, signal()); await f.journal.append([stopEvent(request)]); await f.host.drive();
  expect((await f.journal.read()).filter(e => e.type === "ChildCreated")).toHaveLength(0);
  expect((await f.journal.read()).find(e => e.type === "AikoHarnessTrialCancelSent")?.status).toBe("not-dispatched");
  expect((await f.host.threads()).length).toBe(1);
  await f.reopen(); expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
});

test("deleted brief and lost cancellation acknowledgement still cancel the retained child once", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  f.setPause("execute"); await f.trials.request(request, signal()); await f.host.drive();
  const requested = (await f.journal.read()).find(e => e.type === "AikoHarnessTrialRequested")!;
  f.db.query("DELETE FROM workflow_records WHERE key=?").run(`harness-blobs:${harnessDigest(owner)}:${requested.briefRef}`);
  f.setRejectedEvent("AikoHarnessTrialCancelSent"); await f.journal.append([stopEvent(request)]);
  await expect(f.host.drive()).rejects.toThrow();
  f.setRejectedEvent(undefined); f.setPause(undefined); await f.reopen();
  const child = harnessExperimentTrialThread(owner, parentThread, request.operationId);
  expect((await f.host.read(child)).filter(e => e.type === "AikoHarnessTrialCancelled")).toHaveLength(1);
  expect((await f.host.read(child)).find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unavailable");
  expect((await f.journal.read()).filter(e => e.type === "AikoHarnessTrialCancelSent")).toHaveLength(1);
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
});

for (const boundary of ["authorization", "joining"] as const) test(`cancellation during awaited ${boundary} cannot dispatch or join after it resumes`, async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  await f.trials.request(request, signal());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const wait = async () => { entered.resolve(); await release.promise; };
  if (boundary === "authorization") f.beforeAuthorize(wait); else f.beforeRead(wait);
  const driving = f.host.drive(); await entered.promise;
  await f.journal.append([stopEvent(request)]);
  f.beforeAuthorize(undefined); f.beforeRead(undefined); release.resolve(); await driving;
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialJoined")).toBe(false);
  expect(f.counts()).toEqual(boundary === "authorization" ? { jobs: 0, checks: 0 } : { jobs: 1, checks: 1 });
  await f.reopen();
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialJoined")).toBe(false);
});

test("host derives authenticated trial links and a sibling cannot forge cancellation or a returned witness", async () => {
  const f = await fixture({ network: true }), request = await f.request(f.network!);
  const siblingRequest = await f.request(f.baseline);
  await f.trials.request(siblingRequest, signal()); await f.host.drive();
  await f.trials.request(request, signal()); const driving = f.host.drive(); await f.networkEntered;
  const requested = (await f.journal.read()).find(e => e.type === "AikoHarnessTrialRequested" && e.id === request.operationId)!;
  const root = parseThreadAddress(f.host.self(parentThread)), target = parseThreadAddress(f.host.self(String(requested.childThread)));
  const sibling = parseThreadAddress(f.host.self(harnessExperimentTrialThread(owner, parentThread, siblingRequest.operationId)));
  await f.host.commit({ link: { source: sibling, target }, event: { ...requested, type: "AikoHarnessTrialCancelled", link: { source: root, target } } });
  const forged = (await f.host.read(target.thread)).find(e => e.type === "AikoHarnessTrialCancelled")!;
  expect((forged.link as any).source).toEqual(sibling);
  expect(f.networkCounts().networkAborts).toBe(0);
  await f.host.commit({ link: { source: sibling, target: root }, event: { ...requested, type: "AikoHarnessTrialReturned", status: "checked",
    witnessRef: harnessDigest("forged"), link: { source: target, target: root } } });
  const returned = (await f.journal.read()).find(e => e.type === "AikoHarnessTrialReturned" && e.id === request.operationId)!;
  expect((returned.link as any).source).toEqual(sibling);
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialJoined" && e.id === request.operationId)).toBe(false);
  await f.journal.append([stopEvent(request)]); await driving;
  await f.networkReceipt;
  expect(f.networkCounts()).toEqual({ requests: 1, networkAborts: 1 });
  expect((await f.host.read(target.thread)).filter(e => e.type === "AikoHarnessTrialCancelled")).toHaveLength(2);
  expect(f.counts()).toEqual({ jobs: 2, checks: 1 });
});

test("cancellation after ChildCreated but before Work closes the exact admitted child without executing", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  await f.trials.request(request, signal()); f.crashAfterChildEdge(); await expect(f.host.drive()).rejects.toThrow("fixture-crash");
  const child = harnessExperimentTrialThread(owner, parentThread, request.operationId);
  expect((await f.journal.read()).filter(e => e.type === "ChildCreated")).toHaveLength(1);
  expect(await f.host.threads()).not.toContain(child);
  await f.journal.append([stopEvent(request)]); await f.reopen();
  expect((await f.host.read(child)).find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unavailable");
  await f.reopen(); expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
});

test("cancelling an already dispatched sandbox write retains unknown and never resends it", async () => {
  const f = await fixture({ network: true, write: true }), request = await f.request(f.network!);
  await f.trials.request(request, signal()); const driving = f.host.drive(); await f.networkEntered;
  await f.journal.append([stopEvent(request)]); await driving;
  const receipt = await f.networkReceipt;
  expect(receipt.status).toBe("unknown");
  expect(receipt.reason).toBe("write_requires_reconciliation");
  expect(f.jobs[0]!.authority.methods).toEqual(["POST"]);
  const child = harnessExperimentTrialThread(owner, parentThread, request.operationId);
  expect((await f.host.read(child)).find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unknown");
  await f.reopen(); expect(f.networkCounts()).toEqual({ requests: 1, networkAborts: 1 });
  expect(f.counts()).toEqual({ jobs: 1, checks: 0 });
});

const removeBrief = async (f: Awaited<ReturnType<typeof fixture>>, operation: string) => {
  const requested = (await f.journal.read()).find(e => e.type === "AikoHarnessTrialRequested" && e.id === operation)!;
  f.db.query("DELETE FROM workflow_records WHERE key=?").run(`harness-blobs:${harnessDigest(owner)}:${requested.briefRef}`);
  return requested;
};
const removeExecutionBindings = (f: Awaited<ReturnType<typeof fixture>>) => {
  let accesses = 0;
  const unavailable = async () => { accesses++; throw Error("fixture-execution-binding-unavailable"); };
  Object.assign(f.binding.blobs, { get: unavailable, put: unavailable, putPrivate: unavailable });
  Object.assign(f.binding, { context: unavailable, authorize: unavailable, execute: unavailable });
  Object.assign(f.binding, { verifiers: new Map() });
  return () => accesses;
};

test("metadata-only restart waits without execution then actual native deadline cancels an admitted child with deleted brief", async () => {
  const f = await fixture(), request = { ...await f.request(f.baseline), deadlineAt: Date.now() + 500 };
  f.setPause("execute"); await f.trials.request(request, signal()); await f.host.drive();
  await f.journal.append([{ ...harnessExperimentWaitMethod.event({
    invocation: { method: "harnessExperimentWait", id: request.experimentId, epoch: 0 },
    input: { experimentId: request.experimentId }, deadlineAt: request.deadlineAt, at: Date.now(),
  }), owner }]);
  const requested = await removeBrief(f, request.operationId), bindingAccesses = removeExecutionBindings(f);
  f.setPause(undefined); await f.reopenLifecycle();
  expect((await f.host.read(String(requested.childThread))).some(e => e.type === "AikoHarnessTrialExecuted")).toBe(false);
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialCancelSent")).toBe(false);
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
  await Bun.sleep(Math.max(1, request.deadlineAt - Date.now() + 5));
  await f.host.alarm();
  const childRows = await f.host.read(String(requested.childThread)), parentRows = await f.journal.read();
  expect(parentRows.filter(e => e.type === "AlarmFired")).toHaveLength(1);
  expect(parentRows.filter(e => e.type === "ChildCreated")).toHaveLength(1);
  expect(parentRows.find(e => e.type === "AikoHarnessTrialCancelSent")?.status).toBe("admitted");
  expect(childRows.find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unavailable");
  expect(parentRows.find(e => e.type === "AikoHarnessTrialReturned")?.status).toBe("unavailable");
  expect(parentRows.some(e => e.type === "AikoHarnessTrialJoined")).toBe(false);
  await f.reopenLifecycle();
  expect((await f.host.read(String(requested.childThread))).filter(e => e.type === "AikoHarnessTrialExecuted")).toHaveLength(1);
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
  expect(bindingAccesses()).toBe(0);
});

test("metadata-only child recovery obeys a no-hypothesis stop before parent settlement", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  f.setPause("execute");
  await f.trials.request(request, signal());
  await f.host.drive();
  const requested = await removeBrief(f, request.operationId), bindingAccesses = removeExecutionBindings(f);
  await f.journal.append([stopEvent(request, "AikoHarnessExperimentProposalSettled")]);
  f.setPause(undefined);
  await f.reopenLifecycle();
  const parent = await f.journal.read(), child = await f.host.read(String(requested.childThread));
  expect(parent.some(e => e.type === "AikoHarnessExperimentSettled")).toBe(false);
  expect(parent.find(e => e.type === "AikoHarnessTrialCancelSent")?.status).toBe("admitted");
  expect(child.find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unavailable");
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
  expect(bindingAccesses()).toBe(0);
  await f.reopenLifecycle();
  expect((await f.host.read(String(requested.childThread))).filter(e => e.type === "AikoHarnessTrialExecuted")).toHaveLength(1);
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 });
  expect(bindingAccesses()).toBe(0);
});

for (const retained of ["started", "checked"] as const) test(`metadata-only restart preserves ${retained} evidence and returns without hydration or execution`, async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  if (retained === "started") f.setRejectedEvent(["AikoHarnessChecked", "AikoHarnessTrialExecuted"]);
  else f.setPause("return");
  await f.trials.request(request, signal());
  if (retained === "started") await expect(f.host.drive()).rejects.toThrow(); else await f.host.drive();
  const requested = await removeBrief(f, request.operationId), before = f.counts();
  const originalChild = await f.host.read(String(requested.childThread));
  expect(originalChild.filter(e => e.type === "AikoHarnessRunStarted")).toHaveLength(1);
  expect(originalChild.filter(e => e.type === "AikoHarnessChecked")).toHaveLength(retained === "checked" ? 1 : 0);
  const executed = originalChild.find(e => e.type === "AikoHarnessTrialExecuted");
  const bindingAccesses = removeExecutionBindings(f);
  f.setRejectedEvent(undefined); f.setPause(undefined);
  await f.journal.append([stopEvent(request)]); await f.reopenLifecycle();
  const rows = await f.host.read(String(requested.childThread));
  const returned = (await f.journal.read()).find(e => e.type === "AikoHarnessTrialReturned")!;
  expect(returned.status).toBe(retained === "checked" ? "checked" : "unknown");
  if (retained === "checked") {
    expect(rows.find(e => e.type === "AikoHarnessTrialExecuted")).toEqual(executed);
    expect(returned.witnessRef).toBe(executed!.witnessRef);
  } else expect(rows.find(e => e.type === "AikoHarnessTrialExecuted")?.cancelled).toBe(true);
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialJoined")).toBe(false);
  await f.reopenLifecycle();
  expect((await f.host.read(String(requested.childThread))).filter(e => e.type === "AikoHarnessTrialExecuted")).toHaveLength(1);
  expect((await f.journal.read()).filter(e => e.type === "AikoHarnessTrialReturned")).toHaveLength(1);
  expect(f.counts()).toEqual(before); expect(bindingAccesses()).toBe(0);
});

test("metadata-only recovery requires a real parent stop and rejects sibling or foreign-owner cancellation", async () => {
  const f = await fixture(), siblingRequest = await f.request(f.baseline), request = await f.request(f.candidate);
  await f.trials.request(siblingRequest, signal()); await f.host.drive();
  f.setPause("execute"); await f.trials.request(request, signal()); await f.host.drive();
  const requested = await removeBrief(f, request.operationId), bindingAccesses = removeExecutionBindings(f), before = f.counts();
  f.setPause(undefined); await f.reopenLifecycle();
  const root = parseThreadAddress(f.host.self(parentThread)), target = parseThreadAddress(f.host.self(String(requested.childThread)));
  const sibling = parseThreadAddress(f.host.self(harnessExperimentTrialThread(owner, parentThread, siblingRequest.operationId)));
  await f.host.commit({ link: { source: sibling, target }, event: { ...requested, type: "AikoHarnessTrialCancelled", link: { source: root, target } } });
  await f.host.commit({ link: { source: root, target }, event: { ...requested, owner: "foreign", type: "AikoHarnessTrialCancelled" } });
  await f.host.drive();
  expect((await f.host.read(target.thread)).some(e => e.type === "AikoHarnessTrialExecuted")).toBe(false);
  // Even an authenticated parent cancellation payload cannot invent its stop fact.
  await f.host.commit({ link: { source: root, target }, event: { ...requested, type: "AikoHarnessTrialCancelled" } });
  await expect(f.host.drive()).rejects.toThrow("harness_trial_scope_unavailable");
  expect((await f.host.read(target.thread)).some(e => e.type === "AikoHarnessTrialExecuted")).toBe(false);
  await f.journal.append([stopEvent(request)]); await f.reopenLifecycle();
  expect((await f.host.read(target.thread)).find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unavailable");
  expect(f.counts()).toEqual(before); expect(bindingAccesses()).toBe(0);
});

test("metadata-only child rejects a missing retained parent edge and mismatched owner host", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  f.setPause("execute"); await f.trials.request(request, signal()); await f.host.drive();
  const requested = await removeBrief(f, request.operationId), bindingAccesses = removeExecutionBindings(f);
  f.setPause(undefined); await f.journal.append([stopEvent(request)]);
  await f.reopenLifecycle("foreign");
  expect((await f.journal.read()).some(e => e.type === "AikoHarnessTrialCancelSent")).toBe(false);
  await expect(f.reopenLifecycle(owner, async () => (await f.journal.read()).filter(e => e.type !== "ChildCreated"))).rejects.toThrow("harness_trial_scope_unavailable");
  expect((await f.host.read(String(requested.childThread))).some(e => e.type === "AikoHarnessTrialExecuted")).toBe(false);
  await f.reopenLifecycle();
  expect((await f.host.read(String(requested.childThread))).find(e => e.type === "AikoHarnessTrialExecuted")?.status).toBe("unavailable");
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 }); expect(bindingAccesses()).toBe(0);
});

test("metadata-only parent never allocates a child when stopped before its native edge", async () => {
  const f = await fixture(), request = await f.request(f.baseline);
  await f.trials.request(request, signal()); await removeBrief(f, request.operationId);
  const bindingAccesses = removeExecutionBindings(f);
  await f.journal.append([stopEvent(request)]); await f.reopenLifecycle();
  expect((await f.journal.read()).filter(e => e.type === "ChildCreated")).toHaveLength(0);
  expect((await f.journal.read()).find(e => e.type === "AikoHarnessTrialCancelSent")?.status).toBe("not-dispatched");
  expect(await f.host.threads()).toEqual([parentThread]);
  expect(f.counts()).toEqual({ jobs: 0, checks: 0 }); expect(bindingAccesses()).toBe(0);
});
