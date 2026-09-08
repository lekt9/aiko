import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { createService } from "../src/server.ts";
import { PERSONA } from "../src/config.ts";
import { parseModelRouting } from "../src/model-routing.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";
import { parseCodingRepositories } from "../src/coding-workspace.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function stream(value: string, callId?: string) {
  const delta = callId ? { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "execute", arguments: JSON.stringify({ code: value }) } }] } : { role: "assistant", content: value };
  return new Response([
    { id: "project-model", choices: [{ index: 0, delta, finish_reason: null }] },
    { id: "project-model", choices: [{ index: 0, delta: {}, finish_reason: callId ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 20, cost: 0.0001 } },
  ].map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}

function storageFixture(db: Database) {
  db.exec("CREATE TABLE fixture_kv(key TEXT PRIMARY KEY,value BLOB NOT NULL)");
  const get = async (key: string) => { const row = db.query("SELECT value FROM fixture_kv WHERE key=?").get(key) as { value: Uint8Array } | null; return row ? deserialize(row.value) : undefined; };
  const put = async (key: string, value: unknown) => { db.query("INSERT OR REPLACE INTO fixture_kv VALUES(?,?)").run(key, serialize(value)); };
  const storage: any = {
    get, put, delete: async (key: string) => { db.query("DELETE FROM fixture_kv WHERE key=?").run(key); },
    list: async ({ prefix = "" } = {}) => new Map(db.query("SELECT key,value FROM fixture_kv WHERE key LIKE ?").all(prefix + "%").map((row: any) => [row.key, deserialize(row.value)])),
    sql: { exec: (query: string, ...args: any[]) => { const rows = db.query(query).all(...args); return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } },
    transactionSync: (fn: () => unknown) => db.transaction(fn)(), transaction: async (fn: (tx: any) => Promise<unknown>) => fn(storage), sync: async () => {},
    getAlarm: async () => (await get("alarm")) ?? null, setAlarm: (at: number) => put("alarm", at), deleteAlarm: async () => storage.delete("alarm"),
  };
  return storage;
}

async function cloudflareModule() {
  const entrypoint = new URL("../src/cloudflare.ts", import.meta.url).pathname;
  const builder = Bun.spawn([process.execPath, "-e", `
    const built=await Bun.build({entrypoints:[${JSON.stringify(entrypoint)}],target:'bun',format:'esm',conditions:['workerd'],external:['node:*'],plugins:[{name:'platform',setup(builder){
      builder.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'platform'}));
      builder.onLoad({filter:/.*/,namespace:'platform'},()=>({loader:'js',contents:'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}'}));
      builder.onLoad({filter:/\\.(sh|py|txt)$/},async({path})=>({loader:'text',contents:await Bun.file(path).text()}));
    }}]});if(!built.success)throw Error(built.logs.map(String).join('\\n'));process.stdout.write(await built.outputs[0].text());
  `], { stdout: "pipe", stderr: "pipe" });
  const [source, error, code] = await Promise.all([new Response(builder.stdout).text(), new Response(builder.stderr).text(), builder.exited]);
  expect(code, error).toBe(0);
  const url = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  try { return await import(url); } finally { URL.revokeObjectURL(url); }
}

/** A local gateway fixture executes the actual uploaded runner CLI. The state
 * directory maps the owner VM's private disk into this test's temporary root. */
async function gatewayFixture(directory: string) {
  const uploaded = new Set<string>(), processes: { child: Bun.Subprocess; stderr: Promise<string> }[] = [], commands: any[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const target = new URL(String(url));
    if (target.origin !== "https://gateway.codegraff.com") throw Error("Unexpected external request in project host fixture");
    const path = target.pathname, body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/v1/sandboxes") return Response.json({ id: "project-fixture" });
    if (path.endsWith("/upload")) {
      if (body.path.startsWith("/tmp/aiko-coding-")) {
        let bytes = Buffer.from(body.contentBase64, "base64");
        if (body.path.endsWith(".config.json")) bytes = Buffer.from(JSON.stringify({ ...JSON.parse(bytes.toString()), stateRoot: join(directory, "vm-private") }));
        if (body.path.endsWith(".input.json")) commands.push(JSON.parse(bytes.toString()));
        await writeFile(body.path, bytes); uploaded.add(body.path);
      }
      return Response.json({ ok: true });
    }
    if (path.endsWith("/exec")) {
      if (body.command.startsWith("bash /tmp/aiko-compute-cloak-")) return Response.json({ execId: "setup" });
      const child = Bun.spawn([process.execPath, ...body.command.split(" ").slice(1)], { stdout: "ignore", stderr: "pipe", env: { PATH: process.env.PATH } });
      processes.push({ child, stderr: new Response(child.stderr).text() });
      return Response.json({ execId: `job-${processes.length - 1}` });
    }
    if (path.endsWith("/exec/setup")) return Response.json({ state: "completed", exitCode: 0 });
    if (path.includes("/exec/job-")) {
      const process = processes[Number(path.split("job-")[1])]!;
      if (init?.method === "DELETE") { process.child.kill(); return Response.json({ ok: true }); }
      const exitCode = await process.child.exited;
      expect(exitCode, await process.stderr).toBe(0);
      return Response.json({ state: "completed", exitCode, output: "" });
    }
    if (path.endsWith("/download")) {
      uploaded.add(body.path);
      try { return Response.json({ contentBase64: (await readFile(body.path)).toString("base64") }); }
      catch { return Response.json({ error: "missing" }, { status: 404 }); }
    }
    return Response.json({ state: "started" });
  }) as typeof fetch;
  cleanups.push(async () => { globalThis.fetch = previous; for (const { child } of processes) child.kill(); for (const path of uploaded) await rm(path, { force: true }); });
  return { commands, dispatches: () => processes.length };
}

test.each(["bun", "cloudflare"] as const)("stock %s host discovers configured project instructions and worker skills without a factory", async platform => {
  const directory = await mkdtemp("/tmp/aiko-project-host-"), root = join(directory, "repository"), owner = "71234";
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
  await mkdir(join(root, ".codex-plugin"), { recursive: true });
  await mkdir(join(root, "src"));
  await writeFile(join(root, "AGENTS.md"), "PROJECT_ROOT_INITIAL_93612");
  await writeFile(join(root, "src", "CLAUDE.md"), "PROJECT_LOCAL_GUIDANCE_93612");
  await writeFile(join(root, ".agents", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review this project carefully\n---\nEXPLICIT_SKILL_BODY_93612");
  await writeFile(join(root, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "project-fixture", description: "Project fixture metadata" }));
  const git = Bun.spawnSync(["git", "init", "-b", "main"], { cwd: root }); expect(git.exitCode).toBe(0);
  const gateway = await gatewayFixture(directory);
  const repositories = parseCodingRepositories(JSON.stringify({ [owner]: [{ id: "app", root, actions: ["read", "list"], checks: {} }] }));
  let parentCalls = 0, childCalls = 0, rootMarker = "PROJECT_ROOT_INITIAL_93612";
  const modelFetch = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)), text = JSON.stringify(body.messages);
    expect(text).toContain(rootMarker);
    expect(text).toContain("Review this project carefully");
    expect(text).toContain("project-fixture");
    if (body.model === "project-child") {
      const step = childCalls++;
      if (step === 0) {
        expect(text).not.toContain("EXPLICIT_SKILL_BODY_93612");
        return stream("return await tools.call({name:'project_context_manifest',arguments:{repository:'app',cwd:'src'}});", "select-project");
      }
      expect(text).toContain("PROJECT_LOCAL_GUIDANCE_93612");
      if (step === 1) return stream("return await tools.call({name:'project_context_load',arguments:{path:'.agents/skills/review/SKILL.md'}});", "load-skill");
      expect(text).toContain("EXPLICIT_SKILL_BODY_93612");
      return stream("Project skill and scoped guidance inspected.");
    }
    if (parentCalls++ === 0) return stream("return await agents.run({text:'Inspect this project skill',scope:'research',placement:'independent',model:{provider:'codegraff',model_id:'project-child'}});", "delegate-project");
    return stream("Project inspection complete.");
  };
  const registrySandbox = () => ({ placement: "local" as const, codeTransport: runCodeSegment, sandbox: { harnessEnvironment: async () => ("sha256:" + "1".repeat(64)) as `sha256:${string}`, harnessJob: async () => { throw Error("Unexpected harness job"); } } });
  let open: () => Promise<{ host: any; close: () => Promise<unknown> }>;
  if (platform === "bun") {
    const config = { mode: "live" as const, port: 4242, stateDir: join(directory, "host"), operatorToken: "project-fixture-operator-12345678901234", persona: PERSONA, voiceEnabled: false, replyStyle: "direct" as const, allowedUsers: new Set([owner]), codeMode: true, modelKey: "project-fixture-key", codingRepositories: repositories,
      modelRouting: parseModelRouting({ AIKO_CONVERSATION_MODEL: "project-parent", AIKO_RAG_MODEL: "project-child" }) };
    open = () => createService(config, { modelFetch, registrySandbox });
  } else {
    const module = await cloudflareModule(), db = new Database(":memory:"), storage = storageFixture(db);
    cleanups.push(async () => db.close());
    const id = (name: string) => ({ name, equals: (other: any) => other?.name === name, toString: () => name });
    const env: any = { AIKO_MODE: "live", AIKO_CODE_MODE: "true", AIKO_INSTANCE_ID: "project-host", AIKO_REPLY_STYLE: "direct", AIKO_OPERATOR_TOKEN: "project-fixture-operator-12345678901234", CODEGRAFF_API_KEY: "project-fixture-key", AIKO_ALLOWED_USERS: owner, AIKO_VOICE_ENABLED: "false", AIKO_CONVERSATION_MODEL: "project-parent", AIKO_RAG_MODEL: "project-child", AIKO_CODING_REPOSITORIES: JSON.stringify(repositories), AIKO_MODEL_FETCH: modelFetch, AIKO_REGISTRY_SANDBOX: registrySandbox };
    const ctx = { id: id(module.accountObjectName(owner)), storage, waitUntil: () => {}, blockConcurrencyWhile: (fn: () => unknown) => fn() };
    let account: any;
    env.AIKO_ACCOUNTS = { idFromName: id, getByName: () => account };
    open = async () => { account = new module.AikoAccountDO(ctx, env); const runtime = await account.open(owner); return { host: runtime.host, close: () => runtime.host.close() }; };
  }
  let service = await open(); cleanups.push(() => service.close());
  await service.host.commitRoot(service.host.self(`user-${owner}`), { type: "MessageReceived", id: "project-turn", text: "Inspect this project", at: 1 });
  await service.host.drive();
  const parent = await service.host.read(`user-${owner}`), claim = parent.find((event: any) => event.type === "ChildCreated");
  expect(claim, JSON.stringify(parent)).toBeDefined();
  const child = await service.host.read(claim.address.thread);
  expect(child.some((event: any) => event.type === "TurnCompleted"), JSON.stringify(child)).toBe(true);
  expect(child.some((event: any) => event.type === "AikoProjectContextSelected")).toBe(true);
  expect(parent.find((event: any) => event.type === "AikoProjectContextPrepared")).toMatchObject({ owner, thread: `user-${owner}`, source: { tool: "project_context_manifest", arguments: { repository: "app" } } });
  const scopedSource=child.findLast((event:any)=>event.type==="AikoProjectContextPrepared");
  expect(scopedSource).toMatchObject({owner,thread:claim.address.thread,source:{tool:"project_context_manifest",arguments:{repository:"app",cwd:"src"}}});
  expect(scopedSource.source.definitionDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(JSON.stringify([...parent, ...child])).not.toContain("EXPLICIT_SKILL_BODY_93612");
  expect(JSON.stringify([...parent, ...child])).not.toContain("PROJECT_ROOT_INITIAL_93612");
  expect(gateway.commands.some(request => request.command.action === "context" && request.thread === claim.address.thread)).toBe(true);
  const beforeRestart = gateway.dispatches();
  await service.close(); service = await open();
  await service.host.recover();
  expect(gateway.dispatches()).toBe(beforeRestart);
  rootMarker = "PROJECT_ROOT_REFRESHED_93612";
  await writeFile(join(root, "AGENTS.md"), rootMarker);
  await service.host.commitRoot(service.host.self(`user-${owner}`), { type: "MessageReceived", id: "project-fresh", text: "Read fresh project guidance", at: 2 });
  await service.host.drive();
  expect((await service.host.read(`user-${owner}`)).some((event: any) => event.type === "TurnCompleted" && event.turn === "project-fresh")).toBe(true);
  expect(gateway.dispatches()).toBeGreaterThan(beforeRestart);
}, 120000);
