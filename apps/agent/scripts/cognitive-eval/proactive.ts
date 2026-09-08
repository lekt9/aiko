import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { Effect, Layer } from "effect";
import { actor, Infer } from "tardie";
import type { Event } from "tardie/core/event";
import { createAikoActor } from "../../src/actor.ts";
import { createReflectionActor } from "../../src/background.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../../src/cloudflare-host.ts";
import { CodeHarness } from "../../src/code-harness.ts";
import { runCodeSegment } from "../../src/code-sandbox-runner.ts";
import { harnessDigest } from "../../src/harness-library.ts";
import { openMemory, type MemoryBinding } from "../../src/memory.ts";
import { memorySnapshot } from "../../src/learning.ts";
import { defaultProactivePreferences, proactiveAppendAllowed, proactiveEvidence, type ProactivePreferences } from "../../src/proactive-policy.ts";
import { createWork, saveWork, workAppendAllowed, workState } from "../../src/commitments.ts";
import { applyWorkCommand } from "../../src/secretary-work.ts";
import type { SecretaryWorkBinding } from "../../src/secretary-policy.ts";
import type { CognitiveCase } from "./catalog.ts";

export type ProactiveArm = "direct-notify-silent" | "retained-contributions";

/** Native reflection/admission/wait/outbox comparison. Model output is supplied,
 * not scored for human usefulness. Clock substitution drives real AlarmFired
 * events; it is calendar/recovery evidence, not wall-clock scheduler latency.
 * Work cases start from declared synthetic task state, not real correspondence. */
export async function runProactiveCase(fixture: CognitiveCase, arm: ProactiveArm, scratch?: string) {
  if (fixture.driver !== "proactive-native") throw Error("Scenario driver is not implemented");
  const dir = scratch ?? await mkdtemp("/tmp/cognitive-proactive-"), owner = "123", thread = "user-123", reflectionThread = "background-123-reflection";
  const db = new Database(":memory:"), originalNow = Date.now;
  let now = fixture.scenario === "dst-transition" ? Date.parse("2026-11-01T05:30:00Z") : Date.parse("2026-09-08T12:00:00Z");
  Date.now = () => now;
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>> | undefined;
  const checks: { criterion: string; passed: boolean; evidence: unknown }[] = [];
  const check = (criterion: string, passed: boolean, evidence: unknown) => checks.push({ criterion, passed, evidence });
  const deliveries: { chat: string; text: string; at: number }[] = [];
  let modelCalls = 0, codeExecutions = 0, duringVoice: (() => Promise<void>) | undefined;
  try {
    const enabled = arm === "retained-contributions";
    const memory: MemoryBinding = { owner, thread, stateDir: dir, redact: text => text, readPage: async (after, limit) => host!.readPage(thread, after, limit) };
    const read = () => host!.read(thread);
    const append = async (events: Event[]) => { for (const e of events) await host!.commitRoot(host!.self(thread), e); };
    const work: SecretaryWorkBinding = { owner, thread, memory, read, append, readSecretary: async () => [], now: () => now };
    const code = new CodeHarness(owner, thread, async (...args) => { codeExecutions++; return runCodeSegment(...args); }, text => text);
    const definition = createAikoActor({ owner, memory, codeHarness: code, background: true, secretaryWork: work,
      contributionMode: enabled ? "enabled" : "disabled", requireThinkFeel: false,
      voice: input => Effect.promise(async () => { const hook = duringVoice; duringVoice = undefined; if (hook && input.kind === "task") await hook();
        return { text: input.kind === "answer" ? input.text : input.kind === "task" ? input.receipt : "Fixture reply", source: "template" as const }; }),
      send: async (chat, text) => { deliveries.push({ chat, text, at: now }); return { status: "delivered", providerId: `synthetic-${deliveries.length}` }; } });
    const reflection = createReflectionActor({ ...memory, thread: reflectionThread }, { contributions: enabled });
    const inference = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "cognitive-scripted-v1" } }), react: (request: any) => {
      modelCalls++;
      if (request.identity.thread === reflectionThread) {
        const message = request.trajectory.findLast((e: Event) => e.type === "MessageReceived" && e.id === request.identity.turn);
        const context = JSON.parse(message.text), useful = fixture.scenario !== "irrelevant-change" && fixture.scenario !== "direct-question";
        const supports = context.evidence.map((e: any) => e.observation);
        if (fixture.scenario === "older-support") supports.push(context.relatedEvidence.find((e: any) => e.subject === "release-approval")?.observation ?? "missing-related-evidence");
        const text = context.evidence[0].payload;
        const candidate = { decision: "notify", text, reason: "Declared synthetic opportunity", supports, delayMs: 0, relevance: useful ? 4 : 0, usefulness: useful ? 4 : 0, urgency: 2, novelty: 3, interruptionCost: 1 };
        const output = enabled ? { version: 2, reason: "Supplied fixture decision", contributions: fixture.scenario === "wording-duplicate" ? [candidate, { ...candidate, text: `In other words: ${text}` }] : [candidate] }
          : { decision: useful ? "notify" : "silent", reason: "Supplied fixture decision", text: useful ? text : "", supports: useful ? supports : [] };
        return Effect.succeed({ kind: "complete" as const, output: JSON.stringify(output), mode: { kind: "local" as const, name: "validate-once" } });
      }
      const returned = request.trajectory.findLast((e: Event) => e.type === "ToolReturned" && e.turn === request.identity.turn);
      if (!returned) return Effect.succeed({ kind: "call" as const, name: "execute", callId: "inspect-access", arguments: { code: "const receipt = await tools.call({name:'access_status',arguments:{}}); return {owner:receipt.owner, checked:receipt.kind==='read-receipt'};" } });
      if (returned.result.error || returned.result.result?.owner !== owner || !returned.result.result?.checked) throw Error("Direct answer lacks its native tool receipt");
      return Effect.succeed({ kind: "complete" as const, output: "I checked the available tools for your direct request." });
    } });
    const storage: AccountStorage = { sql: { exec: (q, ...args) => { const rows = db.query(q).all(...args as any); return { toArray: () => rows as never }; } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {} };
    const open = () => createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "cognitive-eval", ownsThread: t => [thread, reflectionThread, "background-123-indexer"].includes(t),
      actorFor: t => t === thread ? definition : t === reflectionThread ? reflection : actor({ name: "aiko", methods: {}, components: [] }),
      layersFor: t => t === thread ? Layer.merge(code.inference(inference), code.sandboxLayer()) : inference,
      canAppend: (t, events, prior) => proactiveAppendAllowed(events, prior, t) && workAppendAllowed(t, events, prior) });
    host = await open();
    const restart = async () => { await host!.close(); host = await open(); await host.recover(); };
    const drive = () => host!.drive();
    await append([{ type: "AikoControlReply", id: "owner-seen", source: "telegram", chat: owner, controlLane: true, at: now }]);
    await drive();
    let baselineDeliveries = deliveries.length;
    const remember = (key: string, subject = "release", text = "The checked release is ready.", supersedes?: string) => {
      const m = openMemory(memory);
      try { return m.remember({ subject, title: "Aurorapanda release schedule", type: "requirement", kind: "fact", payload: text, ...(supersedes ? { supersedes } : {}) }, { key, producer: { kind: "agent", reference: "fixture:owner-requirement" } }); }
      finally { m.close(); }
    };
    const forget = (saved: ReturnType<typeof remember>) => { const m = openMemory(memory); try { m.forget(saved.subject, saved.id, `forget-${saved.id}`); } finally { m.close(); } };
    const reflect = async (id: string, saved: ReturnType<typeof remember>) => {
      await host!.commitRoot(host!.self(reflectionThread), { type: "AikoReflectionRequested", id, owner, cause: id, root: harnessDigest([id]), changed: [{ observation: saved.id }], at: now });
      await drive();
    };
    const preferences = async (patch: Partial<ProactivePreferences>, id: string) => {
      const rows = await read(), previousRevision = rows.findLast(e => e.type === "AikoProactivePreferencesSet")?.id ?? "default";
      const preferences = { ...defaultProactivePreferences, ...patch };
      await append([{ type: "AikoProactivePreferencesSet", owner, id, previousRevision, preferences, preferencesDigest: harnessDigest(preferences), at: now }]);
      await drive();
    };
    // A retained native in-progress turn/epoch holds admission without inventing
    // a completed model result. Its old epoch terminal must not release it.
    const busy = async () => append([{ type: "TurnResumed", turn: "owner-working", epoch: 1, at: now }]);
    const release = async () => { await append([{ type: "TurnCompleted", turn: "owner-working", epoch: 1, output: "Synthetic ongoing work ended", at: now }]); await drive(); };
    const needsBusy = ["busy-owner", "corrected-requirement", "cancelled-task", "expired-support", "pending-capacity", "evidence-withdrawal"].includes(fixture.scenario);
    if (needsBusy && !["cancelled-task", "evidence-withdrawal"].includes(fixture.scenario)) await busy();
    if (fixture.scenario === "quiet-hours") await preferences({ quietHours: { timeZone: "UTC", startMinute: 720, endMinute: 780 } }, "quiet");
    if (fixture.scenario === "dst-transition") await preferences({ quietHours: { timeZone: "America/New_York", startMinute: 60, endMinute: 120 } }, "dst");
    if (fixture.scenario === "older-support") remember("older", "release-approval", "Owner approval is needed for the Aurorapanda release schedule.");
    const saved = remember("new");
    if (fixture.scenario === "dismissed-topic") await preferences({ dismissedTopics: proactiveEvidence(memory, [saved.id])!.topics }, "dismiss");
    if (fixture.scenario === "foreground-during-voice") duringVoice = busy;
    const workCase = ["cancelled-task", "evidence-withdrawal", "native-deadline"].includes(fixture.scenario);
    if (workCase) {
      const make = (id: string) => createWork(owner, { id, outcome: "Prepare the release", successCondition: "Owner reviewed the preparation", accountableParty: "You", nextAction: "Review the checked release", timeZone: "UTC", nextReviewAt: now + 60_000 }, "fixture:declared-task", true, now);
      if (fixture.scenario !== "native-deadline") {
        // Explicit initial condition: a retained synthetic prerequisite receipt.
        // End-to-end contact verification is covered separately, not claimed here.
        await saveWork(work, { ...make("prerequisite"), status: "completed", evidenceRefs: [saved.id] }, 0, "initial-prerequisite");
        await drive(); baselineDeliveries = deliveries.length; await busy();
        await saveWork(work, { ...make("preparation"), status: "waiting", waitingFor: "Checked release", dependencyRefs: ["prerequisite"] }, 0, "initial-parent");
      } else await saveWork(work, make("preparation"), 0, "initial-parent");
      await drive();
    } else if (fixture.scenario === "pending-capacity") {
      for (let i = 0; i < 17; i++) await reflect(`capacity-${i}`, remember(`capacity-${i}`, `release-${i}`));
    } else await reflect("new", saved);
    const beforeChange = await read(), sentBeforeChange = deliveries.length - baselineDeliveries;
    if (needsBusy || fixture.scenario === "foreground-during-voice") {
      check("no-interruption-while-busy", sentBeforeChange === 0, { sentBeforeChange });
      const calls = modelCalls; await restart();
      check("pending-restart-does-not-infer-or-send", modelCalls === calls && deliveries.length - baselineDeliveries === sentBeforeChange, { callsBefore: calls, callsAfter: modelCalls });
    }
    switch (fixture.scenario) {
      case "busy-owner":
        await append([{ type: "TurnCompleted", turn: "owner-working", epoch: 0, output: "Old epoch", at: now }]); await drive();
        check("old-epoch-does-not-release", deliveries.length === baselineDeliveries, deliveries);
        await release(); break;
      case "corrected-requirement": now++; await reflect("corrected", remember("corrected", "release", "The corrected release is on Thursday, not Tuesday.", saved.id)); await release(); break;
      case "cancelled-task": {
        const w = workState(await read(), owner).commitments.get("preparation")!;
        await applyWorkCommand(work, { action: "change", change: "cancel", id: w.id, expectedVersion: w.version, operationId: "cancel" }, { trusted: true, ref: "fixture:owner-cancel" }); await release(); break;
      }
      case "evidence-withdrawal": {
        const w = workState(await read(), owner).commitments.get("prerequisite")!;
        await saveWork(work, { ...w, version: w.version + 1, updatedAt: now, status: "ready", evidenceRefs: [] }, w.version, "withdraw"); await release(); break;
      }
      case "expired-support": forget(saved); await release(); break;
      case "quiet-hours": case "dst-transition": {
        const wait = beforeChange.findLast(e => e.type === "AikoProactiveDeferred");
        const expected = fixture.scenario === "dst-transition" ? Date.parse("2026-11-01T07:00:00Z") : Date.parse("2026-09-08T13:00:00Z");
        check("fixed-calendar-native-deadline", (wait?.call as any)?.deadlineAt === expected && sentBeforeChange === 0, wait);
        const calls = modelCalls; await restart(); now = expected;
        await append([{ type: "AlarmFired", scheduledFor: now, at: now }]); await drive();
        check("native-wait-wake-no-inference", calls === modelCalls, { callsBefore: calls, callsAfter: modelCalls }); break;
      }
      case "foreground-during-voice": await release(); break;
      case "native-deadline": {
        const rootBefore = memorySnapshot(memory).root;
        now += 60_000; await append([{ type: "AlarmFired", scheduledFor: now, at: now }]); await drive();
        check("work-deadline-produces-native-notice", (await read()).some(e => e.type === "AikoProactiveAccepted" && (e.work as any)?.workId === "preparation") && modelCalls === 0, { rootBefore, modelCalls }); break;
      }
      case "direct-question":
        await append([{ type: "MessageReceived", id: "direct", source: "telegram", chat: owner, text: fixture.prompt, at: now }]); await drive(); break;
    }
    const events = await read(), reflectionEvents = await host.read(reflectionThread);
    const sent = deliveries.slice(baselineDeliveries), accepted = events.filter(e => e.type === "AikoProactiveAccepted");
    if (!workCase) check("reflection-completed-with-valid-output", reflectionEvents.some(e => e.type === "TurnCompleted") && !reflectionEvents.some(e => e.type === "TurnFailed") &&
      !reflectionEvents.some(e => e.type === "AikoDecisionRecorded" && e.reason === "Reflection failed or returned an invalid decision"), reflectionEvents.filter(e => e.type === "AikoDecisionRecorded"));
    if (["irrelevant-change", "cancelled-task", "expired-support", "dismissed-topic", "evidence-withdrawal"].includes(fixture.scenario)) check("required-silence", sent.length === 0, sent);
    else if (fixture.scenario === "pending-capacity") {
      check("bounded-unsettled-topics", new Set(events.filter(e => e.type === "AikoProactiveDeferred").map(e => e.decisionId)).size === 16 && events.some(e => e.type === "AikoProactiveSuppressed" && e.reason === "contribution-capacity"), events.filter(e => e.type === "AikoProactiveSuppressed"));
    } else check("one-useful-delivery", sent.length === 1, sent);
    if (fixture.scenario === "corrected-requirement") check("only-corrected-notice", sent.length === 1 && sent[0]!.text.includes("Thursday") && events.some(e => e.type === "AikoProactiveSuppressed"), sent);
    if (fixture.scenario === "older-support") check("old-and-trigger-support-retained", accepted.some(e => (e.supports as any[])?.length === 2 && (e.contribution as any)?.triggerSupports.length === 1), accepted);
    if (fixture.scenario === "wording-duplicate") check("semantic-not-wording-dedup", accepted.length === 1 && sent.length === 1, { accepted, omitted: reflectionEvents.filter(e => e.type === "AikoDecisionRecorded").map(e => e.omitted ?? []) });
    if (fixture.scenario === "direct-question") check("direct-answer-checked-through-sandbox", codeExecutions > 0 && events.some(e => e.type === "TurnCompleted" && e.turn === "direct") && accepted.length === 0, { codeExecutions, accepted: accepted.length });
    check("owner-only-delivery", sent.every(d => d.chat === owner), sent.map(d => d.chat));
    const counters = [modelCalls, codeExecutions, deliveries.length]; await restart();
    check("settled-restart-exact-events-and-counters", harnessDigest(await read()) === harnessDigest(events) && harnessDigest(await host.read(reflectionThread)) === harnessDigest(reflectionEvents) && harnessDigest(counters) === harnessDigest([modelCalls, codeExecutions, deliveries.length]), { before: counters, after: [modelCalls, codeExecutions, deliveries.length] });
    return { id: fixture.id, category: fixture.category, split: fixture.split, arm, passed: checks.every(c => c.passed), checks, events, reflectionEvents, actor: "aiko", instance: "cognitive-eval", thread,
      metrics: { nativeModelCalls: modelCalls, codeExecutions, deliveries: sent.length, providerSpendUsd: 0, providerTokens: null, humanQuality: null },
      scope: "Actual actor/reflection/native tools/sandbox/waits/outbox; supplied inference, synthetic initial tasks and calendar clock. No autonomous or judged usefulness/timing claim." };
  } finally { await host?.close(); Date.now = originalNow; db.close(); await rm(dir, { recursive: true, force: true }); }
}
