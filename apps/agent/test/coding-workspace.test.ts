import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectContext, projectContextEventKey } from "../src/project-instructions.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { runCodingWorkspace, type CodingWorkspaceRuntime } from "../src/coding-workspace-runner.ts";
import { parseCodingRepositories, validateCodingWorkspaceRequest, type CodingRepositoryGrant, type CodingWorkspaceCommand, type CodingWorkspaceRequest } from "../src/coding-workspace.ts";
import { sandboxDigest } from "../src/sandbox-job.ts";
import { Codegraff } from "../src/codegraff.ts";
import { SandboxCompute, type ComputeStore } from "../src/sandbox-compute.ts";
import { CodegraffCodingWorkspace } from "../src/coding-workspace-host.ts";
import { Effect, Layer } from "effect";
import { actor, agentMessageMethod, codeMode, infer, Infer, outputValidateOnce } from "tardie";
import { EventLog, withWatermark } from "tardie/core/log";
import { Self } from "tardie/core/runtime";
import type { Event } from "tardie/core/event";
import { codingWorkspaceTools, codingWorkspaceInference, codingWorkspaceEventKey, codingWorkspacePending } from "../src/coding-workspace.ts";
import { CodeHarness } from "../src/code-harness.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { createCodeChildActor, scopedAgentsPackage, workerEventKey, workerInference, type WorkerBinding } from "../src/code-agents.ts";
import { createCloudflareAccountHost, type AccountStorage } from "../src/cloudflare-host.ts";

const cleanups: (() => Promise<void>)[] = [];
type Unscoped<Command> = Command extends CodingWorkspaceCommand ? Omit<Command, "repository" | "workspace"> & Partial<Pick<Command, "repository" | "workspace">> : never;
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const git = (root: string, ...args: string[]) => {
  const child = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@localhost", ...args], { cwd: root });
  if (child.exitCode !== 0) throw Error(child.stderr.toString());
  return child.stdout.toString().trim();
};
test("deployment grants accept only scoped repositories and explicit bounded verification commands", () => {
  const grant: CodingRepositoryGrant = { id: "repo", root: "/home/daytona/repos/repo", actions: ["create", "read", "list", "test", "merge"], checks: { unit: ["/home/daytona/.bun/bin/bun", "test"] } };
  expect(parseCodingRepositories(undefined)).toEqual({});
  expect(parseCodingRepositories(JSON.stringify({ ownerA: [grant] }))).toEqual({ ownerA: [grant] });
  for (const invalid of [{ ...grant, root: "/repo/../private" }, { ...grant, actions: ["anything"] }, { ...grant, checks: {} }, { ...grant, checks: { test: ["bash", "-c", "anything"] } }])
    expect(() => parseCodingRepositories(JSON.stringify({ ownerA: [invalid] }))).toThrow();
  expect(() => parseCodingRepositories(JSON.stringify({ "../owner": [grant] }))).toThrow();
  const thread = `ag.${"native-parent:".repeat(25)}`;
  expect(validateCodingWorkspaceRequest({ version: 1, owner: "ownerA", thread, turn: "turn", operationId: "call", command: { action: "status", repository: "repo", workspace: "feature" } }).thread).toBe(thread);
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "aiko-coding-")), root = join(directory, "repository"), stateRoot = join(directory, "private");
  await mkdir(root); await mkdir(stateRoot);
  await writeFile(join(root, "answer.ts"), "export function answer() { return 1; }\n");
  await writeFile(join(root, ".gitignore"), ".check-count\n.check-running\n.check-heartbeat\n");
  await writeFile(join(root, "verify.test.ts"), 'import {expect,test} from "bun:test"; import {answer} from "./answer"; test("answer",()=>expect(answer()).toBe(2));\n');
  git(root, "init", "-b", "main"); git(root, "add", "."); git(root, "commit", "-m", "Fixture");
  let db = new Database(join(stateRoot, "receipts.sqlite"));
  const runtime: CodingWorkspaceRuntime = { owner: "ownerA", stateRoot, repositories: [{ id: "fixture", root, actions: ["create", "status", "list", "read", "edit", "undo", "index", "query", "test", "reconcile", "merge", "close"], checks: { test: [process.execPath, "test", "verify.test.ts"] } }],
    environmentDigest: await sandboxDigest("coding-fixture"), journal: await sandboxJobJournal(db, join(stateRoot, "receipts.key")), wallMs: 10000 };
  let serial = 0;
  const request = (command: Unscoped<CodingWorkspaceCommand>, turn = "turnA", operationId = `op${++serial}`): CodingWorkspaceRequest => JSON.parse(JSON.stringify({ version: 1, owner: runtime.owner, thread: "user-ownerA", turn, operationId, command: { repository: "fixture", workspace: "feature", ...command } }));
  const invoke = (command: any, turn?: string) => runCodingWorkspace(request(command, turn), runtime);
  const restart = async () => { db.close(); db = new Database(join(stateRoot, "receipts.sqlite")); runtime.journal = await sandboxJobJournal(db, join(stateRoot, "receipts.key")); };
  const workspace = async () => join(stateRoot, "worktrees", (await readdir(join(stateRoot, "worktrees")))[0]!);
  cleanups.push(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  expect(await invoke({ action: "create" })).toMatchObject({ status: "completed" });
  return { directory, root, stateRoot, runtime, request, invoke, restart, workspace };
}

test.each([false, true])("native independent coding worker completion requires fresh passing checks and survives cold replay (%s)", async verified => {
  const f = await fixture(), db = new Database(":memory:"); cleanups.push(async () => db.close()); let alarm: number | null = null;
  const storage: AccountStorage = { sql: { exec: (sql, ...args) => { const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never }; } },
    transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  let dispatches = 0;
  const parent = "user-ownerA";
  async function open() {
    const harnesses = new Map<string, CodeHarness>(), definitions = new Map<string, ReturnType<typeof createCodeChildActor>>();
    const harness = (thread: string) => { let value = harnesses.get(thread); if (!value) harnesses.set(thread, value = new CodeHarness("ownerA", thread, runCodeSegment, text => text)); return value; };
    const worker = (thread: string): WorkerBinding => ({ owner: "ownerA", thread, readParent: () => host.read(parent) });
    const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }), react: request => Effect.succeed(request.trajectory.some(event => event.type === "ToolReturned")
      ? { kind: "complete" as const, output: request.identity.thread === parent ? "Parent dispatched" : "Claimed verified completion" }
      : { kind: "call" as const, name: "execute", callId: "execute", arguments: { code: request.identity.thread === parent
        ? "return await agents.run({text:'Edit and verify the fixture',scope:'coding',background:true,placement:'independent'});"
        : `const tool = async command => await tools.call({name:'coding_workspace',arguments:{repository:'fixture',workspace:'worker-feature',...command}}); await tool({action:'create'}); const original=await tool({action:'read',path:'answer.ts'}); await tool({action:'edit',changes:[{path:'answer.ts',expected:original.output.hash,content:'export function answer() { return 2; }\\n'}]}); ${verified ? "await tool({action:'test'});" : ""} return 'edits finished';` } }) });
    return createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "coding", ownsThread: thread => thread === parent,
      allowChild: (source, child) => source === parent && child.startsWith("ag."), allowIndependentChildren: true,
      keyOf: event => codingWorkspaceEventKey(event) ?? workerEventKey(event),
      actorFor: thread => {
        let value = definitions.get(thread);
        if (!value) {
          const native = codingWorkspaceTools({ owner: "ownerA", thread, redact: text => text, invoke: async (request, signal) => { dispatches++; return runCodingWorkspace(request, f.runtime, signal); } });
          value = thread === parent ? actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([codeMode([harness(thread).package([]), scopedAgentsPackage("ownerA", { scopes: ["coding"], readChild: child => host.read(child) })]), outputValidateOnce])] }) : createCodeChildActor(harness(thread), native, worker(thread));
          definitions.set(thread, value);
        }
        return value;
      }, layersFor: thread => Layer.merge(harness(thread).inference(thread === parent ? model : codingWorkspaceInference(workerInference(model, worker(thread)), "ownerA", thread)), harness(thread).sandboxLayer()) });
  }
  host = await open(); cleanups.push(() => host.close());
  await host.commitRoot(host.self(parent), { type: "MessageReceived", id: "coding", text: "Delegate edits", at: 1 }); await host.drive();
  const parentRows = await host.read(parent), claim = parentRows.find(event => event.type === "ChildCreated");
  if (!claim) throw Error(`Native child was not created: ${JSON.stringify(parentRows)}`);
  const child = String((claim.address as any).thread);
  const rows = await host.read(child);
  expect(rows.some(event => event.type === "TurnCompleted")).toBe(verified);
  if (!verified) expect(rows.find(event => event.type === "TurnFailed")).toMatchObject({ cause: "output_validation_failed", policy: { source: "coding_workspace_verification" } });
  expect(codingWorkspacePending(rows, "ownerA", child)).toHaveLength(verified ? 0 : 1);
  expect(JSON.stringify(rows.filter(event => event.type === "AikoCodingOperation"))).not.toContain("export function");
  const count = dispatches; await host.close(); await f.restart(); host = await open(); await host.recover();
  expect(dispatches).toBe(count); expect(codingWorkspacePending(await host.read(child), "ownerA", child)).toHaveLength(verified ? 0 : 1);
}, 30000);

test("an unresolved edit and a later failed check cannot reuse a previous passing completion receipt", async () => {
  const f = await fixture(), rows: Event[] = [], keys = new Set<string>();
  const log = withWatermark({ read: Effect.sync(() => rows), append: events => Effect.sync(() => { for (const event of events) { const key = codingWorkspaceEventKey(event)!; if (!keys.has(key)) { keys.add(key); rows.push(event); } } }) });
  const binding = { owner: "ownerA", thread: "user-ownerA", grantRevision: "registered-checks-v1", redact: (text: string) => text, invoke: (request: CodingWorkspaceRequest, signal: AbortSignal) => runCodingWorkspace(request, f.runtime, signal) };
  let serial = 0;
  const invoke = (command: any, selected = binding) => Effect.runPromise(codingWorkspaceTools(selected)[0]!.run({ repository: "fixture", workspace: "feature", ...command }, { callId: `gate${++serial}`, turn: "turn", signal: AbortSignal.timeout(10000) }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: binding.thread }), Effect.provideService(EventLog, log)));
  const initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  await invoke({ action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }] });
  await invoke({ action: "test" }); expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toEqual([]);
  expect(codingWorkspacePending(rows, binding.owner, binding.thread, "registered-checks-v2")).toHaveLength(1);
  expect(codingWorkspacePending(rows, binding.owner, binding.thread, "registered-checks-v1")).toEqual([]);
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const deferred = invoke({ action: "edit", changes: [{ path: "later.ts", expected: null, content: "later" }] }, { ...binding, invoke: async (request, signal) => { await wait; return binding.invoke(request, signal); } });
  for (let attempts = 0; !rows.some(event => event.phase === "started" && event.callId === `gate${serial}`); attempts++) { if (attempts > 100) throw Error("Edit did not start"); await Bun.sleep(1); }
  await invoke({ action: "test" }); expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toHaveLength(1);
  release(); await deferred;
  await invoke({ action: "test" }); expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toEqual([]);
  f.runtime.repositories[0]!.checks = { failure: [process.execPath, "-e", "process.exit(1)"] };
  await invoke({ action: "test" }); expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toHaveLength(1);
  const layer = codingWorkspaceInference(Layer.succeed(Infer, { react: () => Effect.succeed({ kind: "call" as const, name: "respond", callId: "reply", arguments: { text: "Done" } }) }), binding.owner, binding.thread);
  const action = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Infer).react({ identity: { actor: "aiko", instance: "fixture", thread: binding.thread, turn: "turn" }, system: "", trajectory: [], tools: [] }); }).pipe(Effect.provide(layer), Effect.provideService(EventLog, log)));
  expect(action).toMatchObject({ kind: "fail", failure: { cause: "output_validation_failed" } });
}, 30000);

test.each(["edit", "test"] as const)("an unknown %s result stays pending across later passing tests until explicit reconciliation and fresh verification", async action => {
  const f = await fixture(), rows: Event[] = [], keys = new Set<string>();
  const log = withWatermark({ read: Effect.sync(() => rows), append: events => Effect.sync(() => { for (const event of events) { const key = codingWorkspaceEventKey(event)!; if (!keys.has(key)) { keys.add(key); rows.push(event); } } }) });
  const binding = { owner: "ownerA", thread: "user-ownerA", redact: (text: string) => text, invoke: (request: CodingWorkspaceRequest, signal: AbortSignal) => runCodingWorkspace(request, f.runtime, signal) };
  let serial = 0, originalOperation = "";
  const invoke = (command: any, selected = binding) => Effect.runPromise(codingWorkspaceTools(selected)[0]!.run({ repository: "fixture", workspace: "feature", ...command }, { callId: `unknown${++serial}`, turn: "turn", signal: AbortSignal.timeout(10000) }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: binding.thread }), Effect.provideService(EventLog, log)));
  const initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  await invoke({ action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }] });
  const unknown = await invoke(action === "edit" ? { action, changes: [{ path: "later.ts", expected: null, content: "later" }] } : { action }, {
    ...binding, invoke: async (request, signal) => {
      originalOperation = request.operationId;
      const receipt = await binding.invoke(request, signal);
      return { ...receipt, status: "unknown" as const, output: undefined, outputDigest: undefined, reason: "Fixture lost host acknowledgement" };
    },
  });
  expect(unknown).toMatchObject({ status: "unknown" });
  await invoke({ action: "test" }); expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toHaveLength(1);
  expect(await invoke({ action: "status" })).toMatchObject({ pendingOperations: [{ operation: originalOperation, action, status: "unknown" }] });
  await f.restart();
  expect(await invoke({ action: "reconcile", operation: originalOperation })).toMatchObject({ output: { idle: true, verified: false } });
  expect(rows.filter(event => event.callId === originalOperation).map(event => event.phase)).toEqual(["started", "settled", "reconciled"]);
  expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toHaveLength(1);
  expect(await invoke({ action: "status" })).toMatchObject({ pendingOperations: [] });
  await invoke({ action: "test" }); expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toEqual([]);
}, 30000);

test("unknown native merge and close receipts block completion until lifecycle reconciliation proves the verified tree or closed manifest", async () => {
  const f = await fixture(), rows: Event[] = [], keys = new Set<string>();
  const log = withWatermark({ read: Effect.sync(() => rows), append: events => Effect.sync(() => { for (const event of events) { const key = codingWorkspaceEventKey(event)!; if (!keys.has(key)) { keys.add(key); rows.push(event); } } }) });
  const binding = { owner: "ownerA", thread: "user-ownerA", redact: (text: string) => text, invoke: (request: CodingWorkspaceRequest, signal: AbortSignal) => runCodingWorkspace(request, f.runtime, signal) };
  let serial = 0, originalOperation = "";
  const invoke = (command: any, lose = false) => Effect.runPromise(codingWorkspaceTools({ ...binding, invoke: async (request, signal) => {
    const receipt = await binding.invoke(request, signal);
    if (!lose) return receipt;
    originalOperation = request.operationId;
    return { ...receipt, status: "unknown" as const, output: undefined, outputDigest: undefined };
  } })[0]!.run({ repository: "fixture", workspace: "feature", ...command }, { callId: `lifecycle${++serial}`, turn: "turn", signal: AbortSignal.timeout(10000) }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: binding.thread }), Effect.provideService(EventLog, log)));
  const initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  await invoke({ action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }] });
  expect(await invoke({ action: "close" })).toMatchObject({ status: "blocked" });
  const tested = await invoke({ action: "test" }) as any;
  expect((await invoke({ action: "merge", testOperation: tested.operationId, message: "Verified lifecycle" }, true) as any).status).toBe("unknown");
  expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toHaveLength(1);
  const commit = git(f.root, "rev-parse", "HEAD"); await f.restart();
  expect(await invoke({ action: "reconcile", operation: originalOperation })).toMatchObject({ output: { idle: true, state: "merged", tree: tested.output.tree, verified: false } });
  expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toEqual([]); expect(git(f.root, "rev-parse", "HEAD")).toBe(commit);
  expect(await invoke({ action: "close" }, true)).toMatchObject({ status: "unknown" });
  expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toHaveLength(1);
  await f.restart();
  expect(await invoke({ action: "reconcile", operation: originalOperation })).toMatchObject({ output: { idle: true, state: "closed", verified: false } });
  expect(codingWorkspacePending(rows, binding.owner, binding.thread)).toEqual([]);
  expect(rows.filter(event => event.verified === true && event.phase === "settled")).toHaveLength(1);
}, 30000);

test("an interrupted create with no manifest reconciles only after confirmed termination without creating a worktree", async () => {
  const f = await fixture(), original = f.request({ action: "create", workspace: "missing" });
  const journal = f.runtime.journal;
  await expect(runCodingWorkspace(original, { ...f.runtime, journal: { ...journal, claim: async (...args) => { await journal.claim(...args); throw Error("Fixture process died before creating manifest"); } } })).rejects.toThrow("before creating manifest");
  await f.restart();
  const reconcile = () => ({ ...f.request({ action: "reconcile", workspace: "missing", operation: original.operationId }), reconciliation: { expectedDigest: "" } });
  const first = reconcile(); first.reconciliation.expectedDigest = await sandboxDigest(original);
  expect((await runCodingWorkspace(first, f.runtime)).output).toMatchObject({ idle: false, state: "absent", outcome: "unknown" });
  f.runtime.terminalOperation = { thread: original.thread, operation: original.operationId };
  const terminal = reconcile(); terminal.reconciliation.expectedDigest = await sandboxDigest(original);
  expect((await runCodingWorkspace(terminal, f.runtime)).output).toMatchObject({ idle: true, state: "absent", outcome: "unknown", verified: false });
  expect((await runCodingWorkspace(original, f.runtime)).status).toBe("unknown");
  expect(await readdir(join(f.stateRoot, "manifests"))).toHaveLength(1);
  expect(await readdir(join(f.stateRoot, "worktrees"))).toHaveLength(1);
}, 30000);

test("a host that silently rejects the native operation marker cannot dispatch a coding mutation", async () => {
  let dispatches = 0;
  const log = withWatermark({ read: Effect.succeed([]), append: () => Effect.void });
  const tool = codingWorkspaceTools({ owner: "ownerA", thread: "user-ownerA", redact: text => text, invoke: async () => { dispatches++; throw Error("Unjournaled dispatch"); } })[0]!;
  const result = await Effect.runPromise(tool.run({ action: "create", repository: "fixture", workspace: "feature" }, { callId: "denied", turn: "turn", signal: AbortSignal.timeout(10000) }).pipe(
    Effect.provideService(Self, { actor: "aiko", instance: "fixture", thread: "user-ownerA" }), Effect.provideService(EventLog, log)));
  expect(result).toMatchObject({ status: "blocked", reason: expect.stringContaining("did not persist") }); expect(dispatches).toBe(0);
});

test("a final response cannot race a coding mutation in the same native batch", async () => {
  const log = withWatermark({ read: Effect.succeed([]), append: () => Effect.void });
  const layer = codingWorkspaceInference(Layer.succeed(Infer, { react: () => Effect.succeed({ kind: "calls" as const, calls: [
    { name: "execute", callId: "edit", arguments: { code: "return await tools.call({name:'coding_workspace',arguments:{action:'edit',repository:'fixture',workspace:'feature',changes:[]}})" } },
    { name: "respond", callId: "done", arguments: { text: "Done" } },
  ] }) }), "ownerA", "user-ownerA");
  const action = await Effect.runPromise(Effect.gen(function* () { return yield* (yield* Infer).react({ identity: { actor: "aiko", instance: "fixture", thread: "user-ownerA", turn: "turn" }, system: "", trajectory: [], tools: [] }); }).pipe(Effect.provide(layer), Effect.provideService(EventLog, log)));
  expect(action).toMatchObject({ kind: "fail", failure: { cause: "output_validation_failed", policy: { source: "coding_workspace_verification" } } });
});

test("real worktree edits, lexical indexing, optimistic guards, replay and turn undo survive runtime restart", async () => {
  const f = await fixture();
  const initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  const edit = f.request({ action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }, { path: "new.ts", expected: null, content: "export const added = true;\n" }] } as any);
  const receipt = await runCodingWorkspace(edit, f.runtime);
  expect(receipt.status).toBe("completed");
  expect(await readFile(join(f.root, "answer.ts"), "utf8")).toContain("return 1");
  const workspace = await f.workspace();
  expect(await readFile(join(workspace, "answer.ts"), "utf8")).toContain("return 2");
  await f.restart();
  expect(await runCodingWorkspace(edit, f.runtime)).toEqual(receipt);
  const index = await f.invoke({ action: "index" }); expect(index.status).toBe("completed");
  const query: any = (await f.invoke({ action: "query", query: "answer", kind: "symbol" })).output;
  expect(query.results).toContainEqual({ path: "answer.ts", name: "answer", line: 1 });
  const stale = await f.invoke({ action: "edit", changes: [{ path: "untouched.ts", expected: null, content: "wrong" }, { path: "answer.ts", expected: initial.hash, content: "wrong" }] });
  expect(stale.status).toBe("failed");
  expect(await Bun.file(join(workspace, "untouched.ts")).exists()).toBe(false);
  expect((await f.invoke({ action: "undo" })).status).toBe("completed");
  expect(await readFile(join(workspace, "answer.ts"), "utf8")).toBe(initial.text);
  expect(await Bun.file(join(workspace, "new.ts")).exists()).toBe(false);
  expect((await f.invoke({ action: "query", query: "answer" })).reason).toContain("stale");
}, 30000);

test("merge needs newly passing checks for the exact unchanged revision and preserves target edits", async () => {
  const f = await fixture();
  const failing = await f.invoke({ action: "test" });
  expect((failing.output as any).verified).toBe(false);
  expect((await f.invoke({ action: "merge", testOperation: failing.operationId, message: "No" })).reason).toContain("Fresh passing");
  const initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  await f.invoke({ action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }] });
  const passing = await f.invoke({ action: "test" }); expect((passing.output as any).verified).toBe(true);
  await f.invoke({ action: "edit", changes: [{ path: "later.ts", expected: null, content: "export const later=1;" }] }, "turnB");
  await f.invoke({ action: "undo" }, "turnB");
  expect((await f.invoke({ action: "merge", testOperation: passing.operationId, message: "Stale" })).reason).toContain("Fresh passing");
  const fresh = await f.invoke({ action: "test" });
  await writeFile(join(f.root, "local.txt"), "user work");
  expect((await f.invoke({ action: "merge", testOperation: fresh.operationId, message: "Blocked" })).reason).toContain("local changes");
  expect(await readFile(join(f.root, "local.txt"), "utf8")).toBe("user work");
  await rm(join(f.root, "local.txt"));
  const merged = await f.invoke({ action: "merge", testOperation: fresh.operationId, message: "Verified answer" });
  expect(merged.status).toBe("completed"); expect((merged.output as any).merged).toBe(true);
  expect(await readFile(join(f.root, "answer.ts"), "utf8")).toContain("return 2");
  expect(git(f.root, "log", "-1", "--format=%s")).toBe("Verified answer");
  expect((await f.invoke({ action: "close" })).status).toBe("completed");
  expect((await f.invoke({ action: "status" })).output).toMatchObject({ state: "closed" });
}, 30000);

test("scope, traversal and symlink checks deny filesystem access outside a registered workspace", async () => {
  const f = await fixture();
  await expect(runCodingWorkspace({ ...f.request({ action: "status" }), owner: "another" }, f.runtime)).rejects.toThrow("owner mismatch");
  await expect(runCodingWorkspace(f.request({ action: "status", repository: "unknown" }), f.runtime)).rejects.toThrow("owner grant");
  expect((await f.invoke({ action: "read", path: "../private/receipts.key" })).status).toBe("failed");
  expect((await f.invoke({ action: "read", path: ".git" })).status).toBe("failed");
  const workspace = await f.workspace();
  await symlink(f.stateRoot, join(workspace, "outside"));
  expect((await f.invoke({ action: "read", path: "outside/receipts.key" })).reason).toContain("symlink");
  expect((await f.invoke({ action: "edit", changes: [{ path: "outside/receipts.key", expected: null, content: "bad" }] })).reason).toContain("symlink");
  const key = await readFile(join(f.stateRoot, "receipts.key")); expect(key.length).toBe(32);
}, 30000);

test("finite project context reads registered repositories and selected worktrees with existing read/list grants", async () => {
  const f = await fixture();
  const put = async (path: string, text: string) => { await mkdir(dirname(join(f.root, path)), { recursive: true }); await writeFile(join(f.root, path), text); };
  await put("AGENTS.md", "ROOT PROJECT RULE"); await put("src/CLAUDE.md", "LOCAL PROJECT RULE");
  await put(".agents/skills/review/SKILL.md", "---\nname: review\ndescription: Review this repository\n---\nEXPLICIT SKILL BODY");
  await put(".codex/plugins/demo/.codex-plugin/plugin.json", JSON.stringify({ name: "demo" }));
  await put(".codex/plugins/demo/.mcp.json", JSON.stringify({ mcpServers: { example: { command: "/bin/anything", env: { TOKEN: "NEVER EXPOSE MCP TOKEN" } } } }));
  git(f.root, "add", "."); git(f.root, "commit", "-m", "Project guidance");
  expect((await f.invoke({ action: "create", workspace: "documented" })).status).toBe("completed");
  const readonly = { ...f.runtime, repositories: f.runtime.repositories.map(grant => ({ ...grant, actions: ["read", "list"] as CodingRepositoryGrant["actions"] })) };
  const rootRequest = f.request({ action: "context", workspace: undefined, cwd: "src", kind: "collect" });
  const first = await runCodingWorkspace(rootRequest, readonly);
  expect(first.output).toMatchObject({ instructionBodies: [{ path: "AGENTS.md", body: "ROOT PROJECT RULE" }, { path: "src/CLAUDE.md", body: "LOCAL PROJECT RULE" }],
    manifest: { skills: [{ name: "review", path: ".agents/skills/review/SKILL.md" }], plugins: [{ name: "demo" }] } });
  expect(JSON.stringify(first.output)).not.toContain("EXPLICIT SKILL BODY"); expect(JSON.stringify(first.output)).not.toContain("NEVER EXPOSE MCP TOKEN");
  await put("AGENTS.md", "FRESH ROOT RULE");
  expect(await runCodingWorkspace(rootRequest, readonly)).toEqual(first);
  expect((await runCodingWorkspace(f.request({ action: "context", workspace: undefined, kind: "collect" }), readonly)).output).toMatchObject({ instructionBodies: [{ body: "FRESH ROOT RULE" }] });
  const worktree = { ...f.request({ action: "context", workspace: "documented", kind: "collect" }), thread: "same-owner-reader" };
  expect((await runCodingWorkspace(worktree, readonly)).output).toMatchObject({ instructionBodies: [{ body: "ROOT PROJECT RULE" }] });
  expect((await runCodingWorkspace(f.request({ action: "context", workspace: "documented", kind: "load", path: ".agents/skills/review/SKILL.md" }), readonly)).output).toMatchObject({ kind: "skill", body: expect.stringContaining("EXPLICIT SKILL BODY") });
  expect((await runCodingWorkspace(f.request({ action: "context", workspace: undefined, kind: "load", path: "answer.ts" }), readonly)).reason).toContain("outside");
  await expect(runCodingWorkspace(f.request({ action: "context", workspace: undefined, kind: "collect" }), { ...readonly, repositories: readonly.repositories.map(grant => ({ ...grant, actions: ["read"] })) })).rejects.toThrow("no owner grant");
  await rm(join(f.root, "AGENTS.md")); await symlink(join(f.stateRoot, "receipts.key"), join(f.root, "AGENTS.md"));
  expect((await runCodingWorkspace(f.request({ action: "context", workspace: undefined, kind: "collect" }), readonly)).reason).toContain("escapes");
}, 30000);

test("lost edit acknowledgement remains unknown on replay and persisted before-images still support explicit undo", async () => {
  const f = await fixture(), initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  const request = f.request({ action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "changed once" }] } as any);
  const real = f.runtime.journal;
  f.runtime.journal = { ...real, settle: async () => { throw Error("receipt acknowledgement lost"); } };
  await expect(runCodingWorkspace(request, f.runtime)).rejects.toThrow("acknowledgement lost");
  await f.restart();
  expect(await runCodingWorkspace(request, f.runtime)).toMatchObject({ status: "unknown", reason: "dispatched_without_receipt_reconcile_required" });
  const workspace = await f.workspace();
  expect(await readFile(join(workspace, "answer.ts"), "utf8")).toBe("changed once");
  expect((await f.invoke({ action: "undo" })).status).toBe("completed");
  expect(await readFile(join(workspace, "answer.ts"), "utf8")).toBe(initial.text);
}, 30000);

test("successful check receipt is replayed from encrypted SQLite after restart without running the process again", async () => {
  const f = await fixture(), count = join(await f.workspace(), ".check-count");
  f.runtime.repositories[0]!.checks = { count: [process.execPath, "-e", 'require("fs").appendFileSync(".check-count", "x"); if(process.env.AIKO_TEST_PRIVATE_TOKEN) process.exit(9);'] };
  process.env.AIKO_TEST_PRIVATE_TOKEN = "fixture-private";
  cleanups.push(async () => { delete process.env.AIKO_TEST_PRIVATE_TOKEN; });
  const request = f.request({ action: "test" }), first = await runCodingWorkspace(request, f.runtime);
  expect((first.output as any).verified).toBe(true);
  await f.restart(); expect(await runCodingWorkspace(request, f.runtime)).toEqual(first);
  expect(await readFile(count, "utf8")).toBe("x");
}, 30000);

test("cancelling a running check terminates its process group and releases workspace mutation exclusion", async () => {
  const f = await fixture(), workspace = await f.workspace(), pidPath = join(workspace, ".check-running"), heartbeat = join(workspace, ".check-heartbeat");
  const descendant = 'const fs=require("fs");fs.writeFileSync(".check-running",String(process.pid));setInterval(()=>fs.appendFileSync(".check-heartbeat","x"),5);';
  f.runtime.repositories[0]!.checks = { wait: [process.execPath, "-e", `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(descendant)}],{detached:true,stdio:"ignore"});setInterval(()=>{},1000);`] };
  const cancellation = new AbortController(), running = runCodingWorkspace(f.request({ action: "test" }), f.runtime, cancellation.signal);
  for (let attempt = 0; !await Bun.file(pidPath).exists(); attempt++) { if (attempt > 100) throw Error("Check never started"); await Bun.sleep(10); }
  const conflict = await f.invoke({ action: "edit", changes: [{ path: "racing.ts", expected: null, content: "no" }] });
  expect(conflict.reason).toContain("live operation");
  cancellation.abort(); expect((await running).status).toBe("unknown");
  const before = await readFile(heartbeat, "utf8").catch(() => ""); await Bun.sleep(60);
  expect(await readFile(heartbeat, "utf8").catch(() => "")).toBe(before);
  expect((await f.invoke({ action: "status" })).status).toBe("completed");
}, 30000);

test("repository-authored checks cannot reach runner keys, grant state, sibling worktrees, git metadata, host processes or network", async () => {
  const f = await fixture(), workspace = await f.workspace();
  await f.invoke({ action: "create", workspace: "sibling" });
  const sibling = (await readdir(join(f.stateRoot, "worktrees"))).map(name => join(f.stateRoot, "worktrees", name)).find(path => path !== workspace)!;
  const key = await readFile(join(f.stateRoot, "receipts.key")), dotGit = await readFile(join(workspace, ".git"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("PRIVATE_HOST_NETWORK") });
  cleanups.push(async () => { server.stop(true); });
  const script = `const fs=require('fs'); const deny=fn=>{try{fn();return false}catch{return true}}; const key=${JSON.stringify(join(f.stateRoot, "receipts.key"))};
    const results={key:deny(()=>fs.readFileSync(key)),state:deny(()=>fs.readdirSync(${JSON.stringify(f.stateRoot)})),sibling:deny(()=>fs.readFileSync(${JSON.stringify(join(sibling, "answer.ts"))})),repository:deny(()=>fs.readFileSync(${JSON.stringify(join(f.root, "answer.ts"))})),
      procRoot:deny(()=>fs.readFileSync('/proc/1/root'+key)),parentRoot:deny(()=>fs.readFileSync('/proc/'+process.ppid+'/root'+key)),traversal:deny(()=>fs.readFileSync('../../'+key.slice(1))),git:deny(()=>fs.writeFileSync('.git','gitdir: /tmp/forged'))};
    fs.symlinkSync(key,'.escape');results.symlink=deny(()=>fs.readFileSync('.escape'));fs.unlinkSync('.escape');
    results.noPrivateFds=fs.readdirSync('/proc/self/fd').every(fd=>{try{return !fs.readlinkSync('/proc/self/fd/'+fd).includes(${JSON.stringify(f.stateRoot)})}catch{return true}});
    try{await fetch('http://127.0.0.1:${server.port}',{signal:AbortSignal.timeout(100)});results.network=false}catch{results.network=true}
    console.log(JSON.stringify(results)); if(Object.values(results).some(value=>!value))process.exit(1);`;
  expect((await f.invoke({ action: "edit", changes: [{ path: "hostile-check.ts", expected: null, content: script }] })).status).toBe("completed");
  f.runtime.repositories[0]!.checks = { hostile: [process.execPath, "hostile-check.ts"] };
  const receipt = await f.invoke({ action: "test" });
  expect(receipt.status).toBe("completed"); expect((receipt.output as any).verified).toBe(true);
  expect(JSON.parse((receipt.output as any).checks[0].output)).toEqual({ key: true, state: true, sibling: true, repository: true, procRoot: true, parentRoot: true, traversal: true, git: true, symlink: true, noPrivateFds: true, network: true });
  expect(await readFile(join(f.stateRoot, "receipts.key"))).toEqual(key); expect(await readFile(join(workspace, ".git"))).toEqual(dotGit);
  await f.restart(); expect((await f.invoke({ action: "status" })).status).toBe("completed");
}, 30000);

test("model-edited Git filter programs and attributes never run in the trusted receipt process", async () => {
  const f = await fixture(), marker = join(f.stateRoot, "filter-escaped"), secret = join(f.stateRoot, "receipts.key");
  const filter = `require('fs').writeFileSync(${JSON.stringify(marker)},require('fs').readFileSync(${JSON.stringify(secret)}));process.stdin.pipe(process.stdout);`;
  git(f.root, "config", "filter.hostile.clean", `${process.execPath} filter.ts`);
  git(f.root, "config", "filter.hostile.smudge", `${process.execPath} filter.ts`);
  git(f.root, "config", "filter.hostile.required", "true");
  const current: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  expect((await f.invoke({ action: "edit", changes: [{ path: ".gitattributes", expected: null, content: "*.ts filter=hostile\n" }, { path: "filter.ts", expected: null, content: filter },
    { path: "answer.ts", expected: current.hash, content: "export function answer() { return 2; }\n" }] })).status).toBe("completed");
  const checked = await f.invoke({ action: "test" }); expect((checked.output as any).verified).toBe(true);
  const merged = await f.invoke({ action: "merge", testOperation: checked.operationId, message: "Filters remain inert" });
  expect(merged.status).toBe("completed"); expect(await Bun.file(marker).exists()).toBe(false);
  expect((await f.invoke({ action: "create", workspace: "filtered-checkout" })).status).toBe("completed");
  expect(await Bun.file(marker).exists()).toBe(false);
}, 30000);

test("a second native worker cannot invalidate the creating worker's passing workspace verification", async () => {
  const f = await fixture(); let serial = 0;
  const worker = (thread: string, command: any) => runCodingWorkspace({ version: 1, owner: "ownerA", thread, turn: "turn", operationId: `owned${++serial}`,
    command: { repository: "fixture", workspace: "worker-owned", ...command } }, f.runtime);
  const owner = "ag.4:turnworkerA", sibling = "ag.4:turnworkerB";
  expect((await worker(owner, { action: "create" })).status).toBe("completed");
  const initial: any = (await worker(owner, { action: "read", path: "answer.ts" })).output;
  await worker(owner, { action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }] });
  const tested = await worker(owner, { action: "test" }); expect((tested.output as any).verified).toBe(true);
  await f.restart();
  const observed: any = (await worker(sibling, { action: "read", path: "answer.ts" })).output;
  expect(observed.text).toContain("return 2"); expect((await worker(sibling, { action: "status" })).status).toBe("completed");
  for (const command of [{ action: "edit", changes: [{ path: "answer.ts", expected: observed.hash, content: "unverified mutation" }] }, { action: "undo", turn: "turn" }, { action: "test" },
    { action: "merge", testOperation: tested.operationId, message: "Foreign merge" }, { action: "close" }])
    expect((await worker(sibling, command)).reason).toContain("creating native thread");
  expect((await worker(owner, { action: "read", path: "answer.ts" })).output).toMatchObject({ hash: observed.hash });
  expect((await worker(owner, { action: "merge", testOperation: tested.operationId, message: "Thread-owned verified change" })).status).toBe("completed");
}, 30000);

test("an abrupt native acknowledgement loss is reconciled after restart without repeating the edit and still needs fresh tests", async () => {
  const f = await fixture(), db = new Database(":memory:"); cleanups.push(async () => db.close());
  const thread = "user-ownerA"; let alarm: number | null = null, loseAcknowledgement = true, edits = 0, originalOperation = "";
  const storage: AccountStorage = { sql: { exec: (sql, ...args) => {
    if (loseAcknowledgement && sql.startsWith("INSERT") && args.some(arg => typeof arg === "string" && arg.startsWith('{"type":"AikoCodingOperation"') && arg.includes('"phase":"settled"')))
      throw Error("Fixture host died before native coding acknowledgement");
    const rows = db.query(sql).all(...args as any); return { toArray: () => rows as never };
  } }, transactionSync: fn => db.transaction(fn)(), sync: async () => {}, getAlarm: async () => alarm, setAlarm: async at => { alarm = at; }, deleteAlarm: async () => { alarm = null; } };
  let host!: Awaited<ReturnType<typeof createCloudflareAccountHost>>;
  const initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  async function open() {
    const harness = new CodeHarness("ownerA", thread, runCodeSegment, text => text);
    const native = codingWorkspaceTools({ owner: "ownerA", thread, redact: text => text, invoke: (request, signal) => {
      if (request.command.action === "edit") { edits++; originalOperation = request.operationId; }
      return runCodingWorkspace(request, f.runtime, signal);
    } });
    const definition = actor({ name: "aiko", methods: { message: agentMessageMethod }, components: [infer([codeMode([harness.package(native)]), outputValidateOnce])] });
    const model = Layer.succeed(Infer, { resolve: () => ({ model: { provider: "fixture", model_id: "fixture" } }), react: request => {
      const calls = new Set(request.trajectory.filter(event => event.type === "ToolCalled" && event.turn === request.identity.turn).map(event => event.callId));
      if (request.trajectory.some(event => event.type === "ToolReturned" && calls.has(event.callId))) return Effect.succeed({ kind: "complete" as const, output: "Verified after reconciliation" });
      const command = request.identity.turn === "lost"
        ? { action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }] }
        : { action: "reconcile", operation: originalOperation };
      const code = `const tool = async command => await tools.call({name:'coding_workspace',arguments:{repository:'fixture',workspace:'feature',...command}}); const receipt=await tool(${JSON.stringify(command)}); ${request.identity.turn === "recovered" ? "await tool({action:'test'});" : ""} return receipt;`;
      return Effect.succeed({ kind: "call" as const, callId: `code-${request.identity.turn}`, name: "execute", arguments: { code } });
    } });
    return createCloudflareAccountHost({ storage, actorName: "aiko", actorInstance: "reconcile", ownsThread: candidate => candidate === thread, keyOf: codingWorkspaceEventKey,
      actorFor: () => definition, layersFor: () => Layer.merge(harness.inference(codingWorkspaceInference(model, "ownerA", thread)), harness.sandboxLayer()) });
  }
  host = await open(); cleanups.push(() => host.close());
  await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "lost", text: "Edit the fixture", at: 1 });
  await host.drive().catch(() => undefined);
  expect(edits).toBe(1); expect(codingWorkspacePending(await host.read(thread), "ownerA", thread)).toHaveLength(1);
  expect((await host.read(thread)).some(event => event.type === "AikoCodingOperation" && event.phase === "settled")).toBe(false);
  await host.close(); await f.restart(); loseAcknowledgement = false; host = await open(); await host.recover();
  await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "reconcile-only", text: "Reconcile the original operation", at: 2 }); await host.drive();
  let rows = await host.read(thread);
  expect(rows.find(event => event.type === "AikoCodingOperation" && event.callId === originalOperation && event.phase === "reconciled")).toMatchObject({ status: "unknown", verified: false, reconciledBy: expect.any(String) });
  expect(rows.some(event => event.type === "TurnCompleted" && event.turn === "reconcile-only")).toBe(false);
  expect(codingWorkspacePending(rows, "ownerA", thread)).toHaveLength(1);
  await host.commitRoot(host.self(thread), { type: "MessageReceived", id: "recovered", text: "Run fresh verification", at: 3 }); await host.drive();
  rows = await host.read(thread); expect(rows.find(event => event.type === "TurnCompleted" && event.turn === "recovered")?.output).toBe("Verified after reconciliation");
  expect(edits).toBe(1); expect(codingWorkspacePending(rows, "ownerA", thread)).toEqual([]);
}, 30000);

test("reconciliation of an unacknowledged runtime effect needs confirmed terminal evidence and never repeats it", async () => {
  const f = await fixture(), initial: any = (await f.invoke({ action: "read", path: "answer.ts" })).output;
  const original = f.request({ action: "edit", changes: [{ path: "answer.ts", expected: initial.hash, content: "export function answer() { return 2; }\n" }] } as any);
  const journal = f.runtime.journal; f.runtime.journal = { ...journal, settle: async () => { throw Error("Lost runtime receipt"); } };
  await expect(runCodingWorkspace(original, f.runtime)).rejects.toThrow("Lost runtime receipt"); await f.restart();
  const request = () => ({ ...f.request({ action: "reconcile", operation: original.operationId }), reconciliation: { expectedDigest: "" } });
  const pending = request(); pending.reconciliation.expectedDigest = await sandboxDigest(original);
  expect((await runCodingWorkspace(pending, f.runtime)).output).toMatchObject({ idle: false, outcome: "unknown", verified: false });
  f.runtime.terminalOperation = { thread: original.thread, operation: original.operationId };
  const proven = request(); proven.reconciliation.expectedDigest = await sandboxDigest(original);
  expect((await runCodingWorkspace(proven, f.runtime)).output).toMatchObject({ idle: true, outcome: "unknown", verified: false });
  expect(await runCodingWorkspace(original, f.runtime)).toMatchObject({ status: "unknown", reason: expect.stringContaining("terminal") });
  expect((await f.invoke({ action: "read", path: "answer.ts" })).output).toMatchObject({ text: "export function answer() { return 2; }\n" });
}, 30000);

test("hosted compute transport runs the bundled trusted CLI and reuses persisted native compute dispatch on host restart", async () => {
  const f = await fixture(), uploaded = new Set<string>(), processes: Bun.Subprocess[] = [];
  const built = await Bun.build({ entrypoints: [new URL("../src/coding-workspace-main.ts", import.meta.url).pathname], target: "bun", minify: true });
  expect(built.success).toBe(true);
  const bundle = await built.outputs[0]!.text(), rows = new Map<string, unknown>();
  const store: ComputeStore = { get: async <T>(key: string) => structuredClone(rows.get(key)) as T, put: async (key, value) => { rows.set(key, structuredClone(value)); }, claim: async (key, value) => { if (rows.has(key)) return false; rows.set(key, structuredClone(value)); return true; } };
  let dispatches = 0, terminalHeld: string | undefined;
  const gateway = new Codegraff("fixture-gateway-key", async (url, init) => {
    const parsed = new URL(String(url)), path = parsed.pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/v1/sandboxes") return Response.json({ id: "coding-fixture" });
    if (path.endsWith("/upload")) {
      if (body.path.startsWith("/tmp/aiko-coding-")) { await writeFile(body.path, Buffer.from(body.contentBase64, "base64")); uploaded.add(body.path); }
      return Response.json({ ok: true });
    }
    if (path.endsWith("/exec")) {
      if (body.command.startsWith("bash /tmp/aiko-compute-cloak-")) return Response.json({ execId: "setup" });
      const argv = body.command.split(" ").slice(1);
      const child = Bun.spawn([process.execPath, ...argv], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } });
      processes.push(child); dispatches++;
      return Response.json({ execId: `job-${processes.length - 1}` });
    }
    if (path.includes("/exec/setup")) return Response.json({ state: "completed", exitCode: 0 });
    if (path.includes("/exec/job-")) {
      const child = processes[Number(path.split("job-")[1])]!;
      if (init?.method === "DELETE") { child.kill(); return Response.json({ ok: true }); }
      if (path.endsWith(`/exec/${terminalHeld}`)) return Response.json({ state: "running", output: "termination not confirmed" });
      // Real child work is awaited by this in-process gateway fixture.
      const exitCode = await child.exited;
      return Response.json({ state: "completed", exitCode, output: "" });
    }
    if (path.endsWith("/download")) {
      try { uploaded.add(body.path); return Response.json({ contentBase64: (await readFile(body.path)).toString("base64") }); }
      catch { return Response.json({ error: "missing" }, { status: 404 }); }
    }
    return Response.json({ state: "started" });
  });
  cleanups.push(async () => { for (const child of processes) child.kill(); for (const path of uploaded) await rm(path, { force: true }); });
  const config = { runnerBundle: bundle, bunVersion: Bun.version, repositories: f.runtime.repositories, stateRoot: join(f.directory, "hosted-private") };
  const open = () => new CodegraffCodingWorkspace(new SandboxCompute(f.runtime.owner, gateway, store), config);
  const request = f.request({ action: "create", workspace: "hosted" }, "hosted-turn", "hosted-create");
  const first = await open().invoke(request, AbortSignal.timeout(10000));
  expect(first.status).toBe("completed");
  expect(await open().invoke(request, AbortSignal.timeout(10000))).toEqual(first);
  expect(dispatches).toBe(1);
  const read = await open().invoke(f.request({ action: "read", workspace: "hosted", path: "answer.ts" } as any, "hosted-turn", "hosted-read"), AbortSignal.timeout(10000));
  expect(read.status).toBe("completed"); expect((read.output as any).text).toContain("return 1");
  const list = await open().invoke(f.request({ action: "list", workspace: "hosted" }, "hosted-turn", "hosted-list"), AbortSignal.timeout(10000));
  expect((list.output as any).entries).toContainEqual({ name: "answer.ts", kind: "file" });
  const edit = f.request({ action: "edit", workspace: "hosted", changes: [{ path: "answer.ts", expected: (read.output as any).hash, content: "export function answer() { return 2; }\n" }] } as any, "hosted-turn", "hosted-edit");
  expect((await open().invoke(edit, AbortSignal.timeout(10000))).status).toBe("completed");
  // Retain the real terminal compute receipt but remove the local final
  // acknowledgement, reproducing the runner's durable crash boundary.
  const journal = new Database(join(config.stateRoot, "jobs.sqlite"));
  journal.query("UPDATE sandbox_jobs SET receipt=NULL WHERE digest=?").run(await sandboxDigest(edit)); journal.close();
  // A cached cancellation records a DELETE acknowledgement, not a terminal
  // observation. It must not authorize clearing an unacknowledged effect.
  const originalCompute = [...rows.entries()].find(([key, value]) => key.startsWith("codegraff:compute-job:") && (value as any).execId === `job-${processes.length - 1}`)!;
  const originalJob = structuredClone(originalCompute[1]) as any;
  rows.set(originalCompute[0], { ...originalJob, state: "cancelled" });
  terminalHeld = originalJob.execId;
  const unconfirmed = await open().invoke({ ...f.request({ action: "reconcile", workspace: "hosted", operation: edit.operationId }, "hosted-turn", "hosted-cancelled-reconcile"), reconciliation: { expectedDigest: await sandboxDigest(edit) } }, AbortSignal.timeout(10000));
  expect(unconfirmed.output).toMatchObject({ idle: false, outcome: "unknown", verified: false });
  const unacknowledged = new Database(join(config.stateRoot, "jobs.sqlite"));
  expect(unacknowledged.query("SELECT receipt FROM sandbox_jobs WHERE digest=?").get(await sandboxDigest(edit))).toEqual({ receipt: null }); unacknowledged.close();
  terminalHeld = undefined;
  const beforeReconcile = dispatches;
  const recovered = await open().invoke({ ...f.request({ action: "reconcile", workspace: "hosted", operation: edit.operationId }, "hosted-turn", "hosted-reconcile"), reconciliation: { expectedDigest: await sandboxDigest(edit) } }, AbortSignal.timeout(10000));
  expect(recovered.output).toMatchObject({ idle: true, outcome: "unknown", verified: false });
  expect(dispatches).toBe(beforeReconcile + 1);
  const persisted = new Database(join(config.stateRoot, "jobs.sqlite"));
  const encrypted = await sandboxJobJournal(persisted, join(config.stateRoot, "receipt.key"));
  const row = persisted.query("SELECT id FROM sandbox_jobs WHERE digest=?").get(await sandboxDigest(edit)) as { id: string };
  expect((await encrypted.read(f.runtime.owner, row.id))?.receipt).toMatchObject({ status: "unknown" }); persisted.close();
}, 30000);
