import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { Memory } from "entity-learn/cloudflare";
import { nodeStorage } from "entity-learn";
import { CodeHarness, codeHarnessEventKey } from "../src/code-harness.ts";
import { privateCodeSandbox } from "../src/code-agents.ts";
import { codeResultCustody } from "../src/code-result-custody.ts";
import { harnessBlobStore } from "../src/harness-library.ts";
import { sqliteWorkflowKV } from "../src/workflow-store.ts";
import { memoryTools, type MemoryBinding, type MemoryReceipt } from "../src/memory.ts";
import { memoryObservationDependency } from "../src/retained-result-dependencies.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

import { memoryTestAuthority } from "./memory-authority-fixture.ts";

for (const platform of ["bun", "worker"] as const) test(`${platform}: code-created memory copies erase and a fresh native call resumes interrupted cleanup`, async () => {
  const directory = await mkdtemp("/tmp/native-memory-custody-");
  const authority = memoryTestAuthority(directory);
  const custodyDb = new Database(join(directory, "custody.sqlite"));
  const workerDb = new Database(join(directory, "worker.sqlite"));
  const owner = "123", thread = "user-123", memoryFile = join(directory, "memory.sqlite");
  const openMemory = () => new Memory({ storage: nodeStorage(memoryFile), scope: `aiko:${owner}` });
  const kv = sqliteWorkflowKV(custodyDb), blobs = harnessBlobStore(kv);
  let alarm: number | null = null, failCleanup = true;
  const storage: AccountStorage = { sql: { exec: (query, ...args) => {
    const rows = workerDb.query(query).all(...args as never[]);
    return { toArray: () => rows as never };
  } }, transactionSync: fn => workerDb.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm,
    setAlarm: async value => { alarm = value; }, deleteAlarm: async () => { alarm = null; } };
  let host: Awaited<ReturnType<typeof createCloudflareAccountHost>> | Awaited<ReturnType<typeof createBunHost>> | undefined;
  let memory = openMemory();
  const producer = { kind: "agent" as const, reference: "controlled-native-custody-fixture" };
  const target = memory.remember({ subject: "private-target", title: "Controlled", type: "fact", payload: { text: "PRIVATE_CUSTODY_COPY_943" } }, { key: "target", producer });
  const linked = memory.remember({ subject: "independent-linked", title: "Keep", type: "fact", payload: { text: "INDEPENDENT_LINKED_FACT" }, links: [{ subject: target.subject, relation: "see-also" }] }, { key: "linked", producer });
  const independent = memory.remember({ subject: "unrelated", title: "Untouched", type: "fact", payload: { text: "UNRELATED_FACT" } }, { key: "independent", producer });
  const version = memory.journal.scopeVersion(memory.scope);
  memory.close();
  const binding: MemoryBinding = { owner, thread, stateDir: directory, ...authority.binding(owner), redact: value => value, openMemory,
    readPage: async (after, limit) => host!.readPage(thread, after, limit), eraseCopies: async (observations, operation) => {
      if (failCleanup) throw Error("controlled copy store interruption");
      return blobs.eraseDependencies!(owner, observations.map(memoryObservationDependency), operation);
    } };
  async function run(turn: string, code: string) {
    let answer: unknown, attempts = 0;
    const native = memoryTools(binding, { fixtures: false });
    const harness = new CodeHarness(owner, thread, runCodeSegment, value => value, undefined,
      codeResultCustody({ owner, thread, blobs, read: () => host!.read(thread), current: () => true, currentData: () => true, tools: () => native.map(tool => tool.spec) }));
    const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([privateCodeSandbox(codeMode([harness.package(native)]), harness), outputValidateOnce])] });
    const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "custody" } }), react: request => {
      if (attempts++ === 0) return Effect.succeed({ kind: "call" as const, name: "execute", callId: `code-${turn}`, arguments: { code } });
      answer = (request.trajectory.findLast(event => event.type === "ToolReturned")?.result as { result?: unknown })?.result;
      return Effect.succeed({ kind: "complete" as const, output: "Checked" });
    } });
    const common = { actorName: "aiko", actorInstance: "custody", actorFor: () => definition,
      layersFor: () => Layer.merge(harness.inference(model), harness.sandboxLayer()) };
    host = platform === "bun" ? await createBunHost({ ...common, database: join(directory, "host.sqlite"), keyOf: codeHarnessEventKey, workspaceSql: false })
      : await createCloudflareAccountHost({ ...common, storage, ownsThread: value => value === thread });
    await host.recover();
    await host.commitRoot(host.self(thread), { type: "MessageReceived", id: turn, text: turn, at: Date.now() });
    await host.drive();
    const rows = await host.read(thread);
    expect(rows.findLast(event => event.type === "TurnCompleted")?.output).toBe("Checked");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE_CUSTODY_COPY_943");
    await host.close(); host = undefined;
    return { answer, rows };
  }
  try {
    const captured = await run("capture", `const item = await tools.call({name:"memory_get",arguments:{observation:${JSON.stringify(target.id)}}});
      const kept = await tools.call({name:"memory_get",arguments:{observation:${JSON.stringify(linked.id)}},retain:true});
      const unrelated = await tools.call({name:"memory_get",arguments:{observation:${JSON.stringify(independent.id)}},retain:true});
      const derived = await tools.retain({value:{text:item.result.observation.payload.text.toLowerCase()}});
      await tools.bind({name:"derived",handle:derived,expectedGeneration:0});
      await tools.bind({name:"unrelated",handle:unrelated,expectedGeneration:0});
      return {derived,kept,unrelated};`);
    expect(captured.answer).toHaveProperty("derived.kind", "aiko-data.v1");
    const observedDependencies = captured.rows.filter(event => event.type === "AikoCodeToolSettled").flatMap(event => event.dependencies ?? []);
    expect(observedDependencies).toContain(memoryObservationDependency(target.id));
    expect(observedDependencies).toContain(memoryObservationDependency(linked.id));
    const privateRows = custodyDb.query("SELECT key,value FROM workflow_records WHERE key LIKE 'harness-blobs:%'").all() as { key: string; value: string }[];
    const deletedDependencies = new Set<string>([memoryObservationDependency(target.id), memoryObservationDependency(linked.id)]);
    const toErase = privateRows.filter(row => JSON.parse(row.value).dependencies?.some((id: string) => deletedDependencies.has(id)));
    expect(toErase.length).toBeGreaterThan(3);
    const pending = (await run("erase", `return await tools.call({name:"memory_erase",arguments:${JSON.stringify({ subject: target.subject, expected: target.id, expectedScopeVersion: version })}});`)).answer as MemoryReceipt;
    expect(pending).toMatchObject({ outcome: "error", result: { erased: true, copies: { status: "pending" } } });
    const resume = (pending.result as { resume: string }).resume;
    memory = openMemory(); const erasedVersion = memory.journal.scopeVersion(memory.scope); expect(memory.get(target.id)).toBeNull(); memory.close();
    failCleanup = false;
    const resumed = (await run("resume", `return await tools.call({name:"memory_erase",arguments:{resume:${JSON.stringify(resume)}}});`)).answer as MemoryReceipt;
    expect(resumed).toMatchObject({ outcome: "ok", result: { resume, copies: { status: "erased" } } });
    memory = openMemory(); expect(memory.journal.scopeVersion(memory.scope)).toBe(erasedVersion);
    const replacement = memory.journal.head(memory.scope, linked.subject)!;
    expect(memory.get(replacement.id)?.observation.payload).toEqual(linked.payload);
    expect(memory.get(replacement.id)?.observation.links).toEqual([]); memory.close();
    for (const prior of toErase) {
      const row = await kv.get(prior.key) as { kind?: string; ciphertext?: string };
      expect(row.kind).toBe("erased"); expect(row.ciphertext).toBeUndefined();
    }
    const replay = (await run("resume-again", `return await tools.call({name:"memory_erase",arguments:{resume:${JSON.stringify(resume)}}});`)).answer as MemoryReceipt;
    expect(replay.result).toEqual(resumed.result);
    const denied = await run("read-erased", `const old=await tools.load({name:"derived"});const kept=await tools.load({name:"unrelated"});return {old,kept:kept.handle.kind};`);
    expect(denied.answer).toMatchObject({ old: { error: expect.any(String) }, kept: "aiko-data.v1" });
    const fresh = await run("fresh-linked", `const item=await tools.call({name:"memory_get",arguments:{observation:${JSON.stringify(replacement.id)}}});return {payload:item.result.observation.payload,links:item.result.observation.links};`);
    expect(fresh.answer).toEqual({ payload: linked.payload, links: [] });
  } finally { await host?.close(); await authority.close(); custodyDb.close(); workerDb.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);
