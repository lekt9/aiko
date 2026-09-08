import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { Event } from "tardie/core/event";
import { browserWatchHarnessActions } from "../src/browser-watch-actions.ts";
import { browserWatchEventKey, type BrowserWatchDispatch } from "../src/browser-watches.ts";
import { BROWSER_EVENT_SCHEMA, type BrowserObservedEvent } from "../src/browser-events.ts";
import { channelDigest } from "../src/channel-bindings.ts";
import { channelSeal } from "../src/channel-custody.ts";
import { HarnessLibrary, harnessBlobStore, harnessDigest, harnessLibraryAppendAllowed, harnessLibraryEventKey, type HarnessArtifact, type HarnessContract, type HarnessExecution, type HarnessLibraryBinding, type HarnessJournal, type HarnessVerifier } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { browserWatchReceiptOperationId, harnessRecoveryAppendAllowed } from "../src/harness-recovery-log.ts";
const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const signal = () => AbortSignal.timeout(5000);
async function fixture() {
  const owner = "watch-actions", db = new Database(":memory:"); databases.push(db);
  db.exec("CREATE TABLE watch_action_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, body TEXT NOT NULL)");
  const read = async () => db.query("SELECT body FROM watch_action_events ORDER BY seq").all().map(row => JSON.parse((row as { body: string }).body) as Event);
  let enabled = true, paused = false, revision = 1, calls = 0, reconciles = 0, loseChecked = false, revokeOnClaim = false;
  let outcome: "ok" | "throw" | "failed" | "invalid" = "ok", receiptReady = true;
  const receipts = new Map<string, HarnessExecution>();
  const journal: HarnessJournal = { read, append: async batch => {
    if (loseChecked && batch.some(e => e.type === "AikoHarnessChecked" && String(e.id).startsWith("watch:"))) { loseChecked = false; throw Error("native-custody-lost"); }
    if (!harnessLibraryAppendAllowed(batch, () => db.query("SELECT body FROM watch_action_events ORDER BY seq").all().map(row => JSON.parse((row as { body: string }).body)))) throw Error("fixture-invalid-native-append");
    db.transaction(() => { for (const e of batch) db.query("INSERT OR IGNORE INTO watch_action_events(id,body) VALUES(?,?)").run(harnessLibraryEventKey(e) ?? browserWatchEventKey(e)!, JSON.stringify(e)); })();
    if (revokeOnClaim && batch.some(e => e.type === "AikoHarnessRunStarted" && String(e.id).startsWith("watch:"))) enabled = false;
  } };
  const verifier: HarnessVerifier = { digest: harnessDigest("watch-action-scale-check"), evaluatorDigest: harnessDigest("watch-action-scale-cases"),
    cases: [{ id: "one", input: { n: 2 }, split: "development" }, { id: "two", input: { n: 13 }, split: "held-out" }],
    verify: async ({ input, output }) => ({ passed: output === (input as { n: number }).n * 2, quality: null, evidence: ["independent-scale-equality"] }) };
  const contract: HarnessContract = { version: 1, outcome: "Return twice the current number", inputSchema: { type: "object", properties: { n: { type: "number" } }, required: ["n"], additionalProperties: false },
    outputSchema: { type: "number" }, effect: "read", applicability: {}, verifierDigest: verifier.digest, evaluatorDigest: verifier.evaluatorDigest, timeoutMs: 2000 };
  const base: HarnessLibraryBinding = { owner, thread: `user-${owner}`, blobs: harnessBlobStore(sqliteWorkflowKV(db)), verifiers: new Map([[verifier.digest, verifier]]), guard: () => {},
    context: async () => ({ placement: "local", runtimeDigest: harnessDigest(["quickjs-watch-actions", revision]), bindings: {} }), authorize: async () => true,
    execute: async (job, s) => {
      calls++;
      const computed = await runCodeSegment({ version: 1, code: job.artifact.files[job.artifact.entrypoint]!, packages: {}, values: { input: job.input }, ambient: { at: 0, seed: job.operationId }, history: [] }, s);
      const result: HarnessExecution = { status: "succeeded", output: computed.result as number, evidence: ["real-quickjs-execution"] };
      receipts.set(job.operationId, structuredClone(result));
      if (outcome === "throw") throw Error("provider-response-lost");
      if (outcome === "failed") return { status: "failed", evidence: ["executor-rejected-input"] };
      if (outcome === "invalid") return { ...result, output: -999 };
      return result;
    },
    reconcile: async job => { reconciles++; return receiptReady ? receipts.get(job.operationId)! : { status: "unknown", evidence: ["receipt-still-pending"] }; },
  };
  let library = new HarnessLibrary(base, journal);
  const contractDigest = await library.registerContract(contract);
  const artifact: HarnessArtifact = { version: 1, name: "watch-scale", description: "Scale the current input", runtime: "javascript", entrypoint: "main.js", files: { "main.js": "return input.n * 2;" }, dependencies: [],
    sources: [{ uri: "fixture:watch-actions", revision: "1", digest: harnessDigest("scale"), license: "test-fixture" }], contractDigest };
  const digest = await library.record(artifact);
  await library.evaluate(digest, "initial-evaluation", signal()); await library.promote(digest, "initial-evaluation", 0, signal()); calls = 0;
  const currentInputs: unknown[] = [];
  const current = async (intent: BrowserWatchDispatch, _signal:AbortSignal, operation:"execute"|"reconcile") => { currentInputs.push(structuredClone(intent.input)); return enabled && (!paused || operation === "reconcile"); };
  let adapter = browserWatchHarnessActions({ library, current });
  const intent = async (n: number, sequence = n): Promise<BrowserWatchDispatch> => {
    const event: BrowserObservedEvent = { type: "AikoBrowserPushObserved", schema: BROWSER_EVENT_SCHEMA, owner, id: `event-${sequence}`, producer: "watch-scale", epoch: "profile-1", profile: "owned", generation: 1,
      connectionId: "site", connectionRevision: "r1", sequence, occurrence: `occurrence-${sequence}`, kind: "push", observedAt: Date.now(), at: Date.now(), sourceId: `cdp-${sequence}`,
      fields: { origin: "https://site.example", outcome: "received" }, commitment: await channelSeal(base.blobs, owner, { sequence }), payloadRef: await channelSeal(base.blobs, owner, { n }) };
    const action: BrowserWatchDispatch["action"] = { kind: "harness", digest, contractDigest, input: { n: 0 }, eventInputs: { n: ["payload", "n"] } };
    const dispatch = { operationId: `watch:scale:1:${channelDigest([owner, event.id, action])}`, watchId: "scale", generation: 1, action, event, input: { n } };
    // The watch orchestration suite checks how these native dispatch claims are
    // produced. This executor fixture starts from that trusted admission boundary.
    await journal.append([{ type: "AikoBrowserWatchStarted", owner, id: dispatch.operationId, at: Date.now(), watchId: dispatch.watchId,
      generation: dispatch.generation, eventId: event.id, source: `checked-intent-${event.id}` }]);
    return dispatch;
  };
  return { digest, contractDigest, base, artifact, read, journal, currentInputs, intent,
    get library() { return library; }, get adapter() { return adapter; }, counts: () => ({ calls, reconciles }),
    restart: () => { library = new HarnessLibrary(base, journal); adapter = browserWatchHarnessActions({ library, current }); },
    revoke: () => { enabled = false; }, pause: () => { paused = true; }, revokeOnClaim: () => { revokeOnClaim = true; }, changeContext: () => { revision++; },
    setOutcome: (value: typeof outcome) => { outcome = value; }, loseChecked: () => { loseChecked = true; }, receiptReady: (ready: boolean) => { receiptReady = ready; },
    requestReceipt: async (intent: BrowserWatchDispatch, requestId: string) => {
      const fields = { owner, operationId: intent.operationId, watchId: intent.watchId, generation: intent.generation, source: `checked-intent-${intent.event.id}` };
      await journal.append([{ type: "AikoBrowserWatchSettled", ...fields, id: `${intent.operationId}:initial`, at: Date.now(), status: "unknown" },
        { type: "AikoBrowserWatchReconcileRequested", ...fields, id: `${intent.operationId}:${requestId}`, at: Date.now(), requestId }]);
    },
  };
}

test("watch harness actions use fresh event inputs and exact evaluated pins after another revision is promoted", async () => {
  const f = await fixture(), first = await f.intent(31), second = await f.intent(43);
  expect(await f.adapter.execute(first, signal())).toMatchObject({ status: "completed", result: { operationId: first.operationId, witness: { harnessDigest: f.digest, contractDigest: f.contractDigest, status: "satisfied" } } });
  const revised = await f.library.revise(f.digest, { description: "A new pinned revision" });
  await f.library.evaluate(revised, "revised-evaluation", signal()); await f.library.promote(revised, "revised-evaluation", 1, signal());
  expect(await f.adapter.execute(second, signal())).toMatchObject({ status: "completed", result: { witness: { harnessDigest: f.digest } } });
  expect((await f.library.output(first.operationId)).output).toBe(62);
  expect((await f.library.output(second.operationId)).output).toBe(86);
  expect(f.currentInputs).toContainEqual({ n: 31 }); expect(f.currentInputs).toContainEqual({ n: 43 });
  const before = f.counts(); f.restart(); await f.adapter.execute(first, signal());
  expect(f.counts()).toEqual(before);
  const events = JSON.stringify(await f.read()); expect(events).not.toContain('"n":31'); expect(events).not.toContain('"n":43');
});

test("pins, input identity, current context and owner authority fail closed before further execution", async () => {
  const f = await fixture(), intent = await f.intent(17);
  expect((await f.adapter.execute({ ...intent, action: { ...intent.action, contractDigest: harnessDigest("changed") } as any }, signal())).status).toBe("failed");
  expect((await f.adapter.execute({ ...intent, event: { ...intent.event, owner: "foreign" } }, signal())).status).toBe("failed");
  expect(f.counts().calls).toBe(0);
  await f.adapter.execute(intent, signal());
  expect((await f.adapter.execute({ ...intent, input: { n: 999 } }, signal())).status).toBe("unknown"); expect(f.counts().calls).toBe(1);
  f.changeContext(); expect((await f.adapter.execute(await f.intent(18), signal())).status).toBe("failed"); expect(f.counts().calls).toBe(1);
  f.revoke(); expect((await f.adapter.reconcile!(intent, signal())).status).toBe("unknown"); expect(f.counts().reconciles).toBe(0);
});

test("authorization is rechecked after the native claim and before the actual executor", async () => {
  const f = await fixture(); f.revokeOnClaim();
  expect((await f.adapter.execute(await f.intent(9), signal())).status).toBe("failed");
  expect(f.counts().calls).toBe(0);
  expect((await f.read()).some(e => e.type === "AikoHarnessRunStarted" && String(e.id).startsWith("watch:"))).toBe(true);
});

test("unknown responses stay held across restart; named checks invoke only the native receipt reconciler", async () => {
  const f = await fixture(), intent = await f.intent(23); f.setOutcome("throw");
  expect((await f.adapter.execute(intent, signal())).status).toBe("unknown"); f.restart();
  expect((await f.adapter.execute(intent, signal())).status).toBe("unknown");
  expect((await f.adapter.reconcile!({ ...intent, input: undefined }, signal())).status).toBe("unknown");
  expect(f.counts()).toEqual({ calls: 1, reconciles: 0 });
  const named = { ...intent, input: undefined, reconciliationRequestId: "check-1" };
  await f.requestReceipt(intent, "check-1");
  f.receiptReady(false); expect((await f.adapter.reconcile!(named, signal())).status).toBe("unknown");
  f.receiptReady(true); expect((await f.adapter.reconcile!(named, signal())).status).toBe("unknown");
  expect(f.counts()).toEqual({ calls: 1, reconciles: 1 });
  await f.requestReceipt(intent, "check-2");
  expect((await f.adapter.reconcile!({ ...named, reconciliationRequestId: "check-2" }, signal())).status).toBe("completed");
  f.restart(); expect((await f.adapter.reconcile!({ ...intent, input: undefined }, signal())).status).toBe("completed");
  expect(f.counts()).toEqual({ calls: 1, reconciles: 2 });
});

test("lost native terminal custody reconciles the same physical operation without dispatch replay", async () => {
  const f = await fixture(), intent = await f.intent(27); f.loseChecked();
  expect((await f.adapter.execute(intent, signal())).status).toBe("unknown"); f.restart();
  expect((await f.adapter.execute(intent, signal())).status).toBe("unknown");
  await f.requestReceipt(intent, "receipt");
  expect((await f.adapter.reconcile!({ ...intent, reconciliationRequestId: "receipt" }, signal())).status).toBe("completed");
  expect(f.counts()).toEqual({ calls: 1, reconciles: 1 });
});

test("paused watches can check an existing receipt without regaining execution authority", async () => {
  const f = await fixture(), intent = await f.intent(29); f.setOutcome("throw");
  expect((await f.adapter.execute(intent, signal())).status).toBe("unknown");
  f.pause(); f.restart();
  await f.requestReceipt(intent, "after-pause");
  expect((await f.adapter.reconcile!({...intent, reconciliationRequestId:"after-pause"}, signal())).status).toBe("completed");
  expect((await f.adapter.execute(await f.intent(30), signal())).status).toBe("failed");
  expect(f.counts()).toEqual({calls:1,reconciles:1});
});

test("executor failures and independent check failures never produce completed tasks; other actions remain unavailable", async () => {
  const f = await fixture(); f.setOutcome("failed");
  expect((await f.adapter.execute(await f.intent(41), signal())).status).toBe("failed");
  f.setOutcome("invalid"); expect((await f.adapter.execute(await f.intent(42), signal())).status).toBe("failed");
  const intent = await f.intent(43), before = f.counts();
  expect(await f.adapter.execute({ ...intent, action: { kind: "actor", instruction: "Send a message" } }, signal())).toMatchObject({ status: "failed", result: { reason: "watch_action_unsupported" } });
  expect(await f.adapter.execute({ ...intent, action: { kind: "webhook", destination: "external" } }, signal())).toMatchObject({ status: "failed", result: { reason: "watch_action_unsupported" } });
  expect(f.counts()).toEqual(before);
});

test("native receipt guard requires the retained watch request and original immutable execution identity", async () => {
  const f = await fixture(), intent = await f.intent(57); f.setOutcome("throw"); await f.adapter.execute(intent, signal());
  let rows = await f.read();
  const original = rows.find(e => e.type === "AikoHarnessRunStarted" && e.id === intent.operationId)!;
  const check: Event = { ...original, id: browserWatchReceiptOperationId(f.base.owner, intent.operationId, "check"),
    receiptOf: intent.operationId, reconciliationCallId: "check" };
  const allowed = (event = check, history = rows) => harnessRecoveryAppendAllowed([event], () => history);
  expect(allowed()).toBe(false);
  await f.requestReceipt(intent, "check"); rows = await f.read();
  expect(allowed()).toBe(true);
  expect(allowed({ ...check, owner: "foreign" })).toBe(false);
  expect(allowed({ ...check, inputRef: harnessDigest("different-input") })).toBe(false);
  expect(allowed({ ...check, contextDigest: harnessDigest("different-context") })).toBe(false);
  expect(allowed({ ...check, harnessDigest: harnessDigest("different-pin") })).toBe(false);
  expect(allowed({ ...check, id: `${check.id}:different` })).toBe(false);
  expect(allowed(check, rows.filter(e => e.type !== "AikoBrowserWatchSettled"))).toBe(false);
  expect(allowed(check, rows.map(e => e.type === "AikoBrowserWatchReconcileRequested" ? { ...e, source: "foreign-source" } : e))).toBe(false);
  expect(allowed(check, [...rows, { type: "AikoBrowserWatchSettled", owner: f.base.owner, id: "terminal", operationId: intent.operationId, status: "completed" }])).toBe(false);
  expect(allowed(check, [...rows, ...Array.from({ length: 7 }, (_, i) => ({ ...check, id: `prior-check-${i}` }))])).toBe(false);
});
