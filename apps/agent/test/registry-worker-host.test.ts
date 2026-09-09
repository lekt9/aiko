import { expect, onTestFinished, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { serialize, deserialize } from "node:v8";
import { credentialDigest } from "../src/plane-auth.ts";
import { localHarnessSandbox } from "../src/harness-sandbox-local.ts";
import { sandboxEnvironment } from "../src/sandbox-job-runner.ts";
import { sandboxJobJournal } from "../src/sandbox-job-journal.ts";
import { runCodeSegment } from "../src/code-sandbox-runner.ts";

let workerModule: Promise<any> | undefined;
export function productionWorker() {
  return workerModule ??= (async () => {
    const build = await Bun.build({
      entrypoints: [new URL("../src/cloudflare.ts", import.meta.url).pathname],
      target: "bun", format: "esm", conditions: ["workerd"], external: ["node:*"],
      plugins: [{ name: "worker-platform-only", setup(builder) {
        builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: "workers", namespace: "platform" }));
        builder.onLoad({ filter: /.*/, namespace: "platform" }, () => ({ loader: "js", contents:
          "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }" }));
        builder.onLoad({ filter: /\.(sh|py|txt)$/ }, async ({ path }) => ({ loader: "text", contents: await readFile(path, "utf8") }));
      } }],
    });
    if (!build.success) throw Error(build.logs.map(String).join("\n"));
    const url = URL.createObjectURL(new Blob([await build.outputs[0]!.text()], { type: "application/javascript" }));
    try { return await import(url); } finally { URL.revokeObjectURL(url); }
  })();
}
/** Platform SQL/KV semantics backed by actual on-disk SQLite; no actor, Infer,
 * Router, experiment controller, verifier or checked result is replaced. */
export function durableStorage(db: Database, afterCommit?: () => void) {
  db.exec("CREATE TABLE IF NOT EXISTS fixture_kv(key TEXT PRIMARY KEY, value BLOB NOT NULL)");
  const getSync = (key: string) => {
    const row = db.query("SELECT value FROM fixture_kv WHERE key=?").get(key) as { value: Uint8Array } | null;
    return row ? deserialize(row.value) : undefined;
  };
  const get = async (key: string) => getSync(key);
  const put = async (key: string, value: unknown) => { db.query("INSERT OR REPLACE INTO fixture_kv VALUES(?,?)").run(key, serialize(value)); };
  let transactionTail: Promise<unknown> = Promise.resolve();
  const storage: any = {
    get, put, kv: { get: getSync },
    delete: async (key: string) => { db.query("DELETE FROM fixture_kv WHERE key=?").run(key); },
    list: async ({ prefix = "" } = {}) => new Map((db.query("SELECT key,value FROM fixture_kv WHERE key LIKE ? ORDER BY key").all(prefix + "%") as { key: string; value: Uint8Array }[]).map(row => [row.key, deserialize(row.value)])),
    sql: { exec: (sql: string, ...args: any[]) => {
      const rows = db.query(sql).all(...args.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value));
      return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync: (fn: () => unknown) => { const result = db.transaction(fn)(); afterCommit?.(); return result; },
    transaction: (fn: (txn: any) => Promise<unknown>) => {
      const next = transactionTail.then(async () => { db.exec("SAVEPOINT fixture_atomic"); try { const value = await fn(storage); db.exec("RELEASE fixture_atomic"); return value; } catch (error) { db.exec("ROLLBACK TO fixture_atomic"); db.exec("RELEASE fixture_atomic"); throw error; } });
      transactionTail = next.catch(() => undefined); return next;
    },
    getAlarm: async () => (await get("fixture:alarm")) ?? null,
    setAlarm: (at: number | Date) => put("fixture:alarm", Number(at)),
    deleteAlarm: () => storage.delete("fixture:alarm"),
    sync: async () => {},
  };
  return storage;
}
function sse(value: unknown, call = false) {
  return new Response([
    { id: "controlled", object: "chat.completion.chunk", choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ index: 0, id: "controlled-execute", type: "function", function: { name: "execute", arguments: JSON.stringify({ code: value }) } }] } : { role: "assistant", content: typeof value === "string" ? value : JSON.stringify(value) }, finish_reason: null }] },
    { id: "controlled", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 120, completion_tokens: 40, cost: 0.001 } },
  ].map(row => `data: ${JSON.stringify(row)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
const privateInput = "PRIVATE_WORKER_RUNTIME_INPUT_f936b";
const program = `const policy=await tools.describe({name:"harness_experiment_start"});if(!policy.description.includes('"proposalTokens":1024'))throw Error("Host limits undiscoverable");const ready=await tools.call({name:"harness_acquire",arguments:{name:"json.project",operationId:"worker-acquire"}});if(ready.status!=="ready")throw Error("acquisition unavailable");const list=await tools.call({name:"harness_list",arguments:{}});const digest=list.candidates.find(c=>c.name==="json.project").harnessDigest;for(let i=0;i<3;i++){const witness=await tools.call({name:"harness_run",arguments:{digest,input:{value:{visible:String.fromCharCode(${[...privateInput].map(c=>c.charCodeAt(0)).join(",")}),omit:true},keys:["visible"]},operationId:"worker-ordinary-"+i}});if(witness.status!=="satisfied")throw Error("not checked");}await tools.call({name:"respond",arguments:{text:"Controlled Worker operations completed."}});return "done";`;

let networkFence: { original: typeof fetch; replacement: typeof fetch; users: number } | undefined;
function holdNetworkFence() {
  if (!networkFence) {
    const replacement = Object.assign(
      async () => { throw Error("Unexpected network outside the configured physical edges"); },
      { preconnect: () => { throw Error("Unexpected provider preconnect"); } },
    ) as typeof fetch;
    networkFence = { original: globalThis.fetch, replacement, users: 0 };
    globalThis.fetch = replacement;
  }
  const held = networkFence; held.users++;
  return async () => {
    if (--held.users !== 0) return;
    if (globalThis.fetch === held.replacement) globalThis.fetch = held.original;
    if (networkFence === held) networkFence = undefined;
  };
}

export async function fixture(options: { program?: string; logSources?: import("../src/channel-log-source.ts").ChannelLogSourcePolicy; allowBootFailure?: boolean } = {}) {
  const cleanups: (() => Promise<unknown>)[] = [];
  // Imported fixtures must attach teardown to the invoking test. A module's
  // afterEach does not cover tests in other files that call this factory.
  onTestFinished(async () => {
    const errors: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Worker fixture cleanup failed");
  });
  const module = await productionWorker(), directory = await mkdtemp("/tmp/optimizer-worker-");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  // Several fixtures may belong to one invoking test. Its teardown callbacks
  // need not run as a stack: keep the shared fence until the last fixture closes.
  cleanups.push(holdNetworkFence());
  let db = new Database(join(directory, "account.sqlite"));
  let workCut: Uint8Array | undefined, edgeCut: Uint8Array | undefined;
  const captureWork = () => {
    if (workCut) return;
    const table = db.query("SELECT name FROM sqlite_master WHERE name='aiko_thread_events'").get();
    if (!table) return;
    const rows = db.query("SELECT event FROM aiko_thread_events WHERE thread LIKE 'harness-trial-%'").all().map((r: any) => JSON.parse(r.event));
    if (!edgeCut && rows.length === 0) {
      const parent = db.query("SELECT event FROM aiko_thread_events WHERE thread='user-123'").all().map((r: any) => JSON.parse(r.event));
      if (parent.some(e => e.type === "AikoHarnessTrialRequested") && parent.some(e => e.type === "ChildCreated" && JSON.stringify(e).includes("harness-trial-")))
        edgeCut = db.serialize();
    }
    if (rows.some(e => e.type === "AikoHarnessTrialWork") && !rows.some(e => e.type === "AikoHarnessRunStarted"))
      workCut = db.serialize();
  };
  let storage = durableStorage(db, captureWork), account: any;
  const driving = new Set<Promise<unknown>>();
  cleanups.push(async () => {
    let runtime;
    try { runtime = await account?.runtime; }
    catch (error) { if (!options.allowBootFailure) throw error; }
    await runtime?.host.close(); await Promise.allSettled([...driving]); db.close();
  });
  const environment = await sandboxEnvironment("worker-production-registry-fixture");
  const token = "worker-fixture-owner-token-1234567890123456789";
  const requests: any[] = [], jobs: any[] = [];
  let foregroundDispatched = false;
  let onJob: ((job: any, signal: AbortSignal) => Promise<void>) | undefined;
  const id = (name: string) => ({ name, equals: (other: any) => other?.name === name, toString: () => name });
  const env: any = {
    AIKO_MODE: "live", AIKO_CODE_MODE: "true", AIKO_INSTANCE_ID: "optimizer-worker", AIKO_REPLY_STYLE: "direct",
    AIKO_OPERATOR_TOKEN: "worker-fixture-operator-1234567890123456789",
    CODEGRAFF_API_KEY: "worker-fixture-model-key", AIKO_ALLOWED_USERS: "123",
    AIKO_PLANE_CREDENTIALS: JSON.stringify([{ account: "123", digest: credentialDigest(token), scopes: ["read", "write"] }]),
    AIKO_VOICE_ENABLED: "false",
    AIKO_LOG_SOURCES: options.logSources,
    AIKO_MODEL_FETCH: async (_url: any, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); requests.push(body);
      if (JSON.stringify(body.messages).includes("Improve one reusable harness"))
        return sse({ hypothesis: "The fixed operation is already minimal; retain its checked implementation.", files: null });
      if (!foregroundDispatched && body.tools?.some((t: any) => t.function?.name === "execute")) { foregroundDispatched = true; return sse(options.program ?? program, true); }
      return sse("Controlled task complete.");
    },
    AIKO_REGISTRY_SANDBOX: () => ({ placement: "local", codeTransport: runCodeSegment,
      sandbox: { harnessEnvironment: async () => environment, harnessJob: async (job: any, signal: AbortSignal) => {
        jobs.push(job);
        await onJob?.(job, signal);
        const local = localHarnessSandbox({ owner: "123", environmentDigest: environment,
          journal: await sandboxJobJournal(db, join(directory, "sandbox-key")) });
        return local.harnessJob(job, signal);
      } } }),
  };
  const ctx = () => ({ id: id(module.accountObjectName("123")), storage, waitUntil: () => {}, blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn() });
  env.AIKO_ACCOUNTS = { idFromName: id, getByName: (name: string) => { if (name !== module.accountObjectName("123")) throw Error("Foreign account object"); return account; } };
  const registryDb = new Database(":memory:"); cleanups.push(async () => registryDb.close());
  const registry = new module.AikoRegistryDO({ storage: durableStorage(registryDb) }, env);
  env.AIKO_REGISTRY = { getByName: () => registry };
  account = new module.AikoAccountDO(ctx(), env);
  const request = (path: string, body?: unknown, bearer = token) => module.default.fetch(new Request("https://controlled.invalid" + path, {
    method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env);
  const events = () => db.query("SELECT event FROM aiko_thread_events WHERE thread='user-123' ORDER BY seq").all().map((row: any) => JSON.parse(row.event));
  return { env, request, requests, jobs, events,
    raw: (request: Request) => module.default.fetch(request, env),
    nativeHost: async () => (await account.runtime).host,
    onJob: (hook: typeof onJob) => { onJob = hook; },
    file: join(directory, "account.sqlite"),
    drive: () => { const run=account.alarm(); driving.add(run); void run.finally(()=>driving.delete(run)); return run; },
    db: () => db,
    workCut: () => workCut,
    edgeCut: () => edgeCut,
    restore: async (snapshot: Uint8Array) => {
      const runtime = await account.runtime; await runtime?.host.close();
      await Promise.allSettled([...driving]); db.close();
      await writeFile(join(directory, "account.sqlite"), snapshot);
      db = new Database(join(directory, "account.sqlite")); storage = durableStorage(db);
      account = new module.AikoAccountDO(ctx(), env);
    },
    storage: () => storage,
    restart: async () => { const runtime = await account.runtime; await runtime?.host.close(); db.close(); db = new Database(join(directory, "account.sqlite")); storage = durableStorage(db); account = new module.AikoAccountDO(ctx(), env); },
  };
}

test("actual Worker entry defaults trigger checked native children, one reflection and durable shared accounting across storage restart", async () => {
  const f = await fixture();
  const ready = await f.request("/api/harness/readiness"); expect(ready.status).toBe(200);
  expect(await ready.json()).toMatchObject({ experiments: true, optimizationPolicy: { candidates: 1, repeats: 2, proposalTokens: 1024, costUsd: 0.1 } });
  expect((await f.request("/api/messages", { id: "worker-optimizer-evidence", text: "Run the controlled stateless operations." })).status).toBe(202);
  for (let n=0;n<24 && !f.events().some((e:any)=>e.type==="AikoHarnessExperimentSettled");n++) await f.drive();
  const rows = f.events();
  expect(rows.filter((e:any)=>e.type==="AikoHarnessTrialJoined")).toHaveLength(4);
  expect(rows.some((e:any)=>e.type==="AikoHarnessExperimentHeldOutOpened")).toBe(false);
  expect(rows.find((e:any)=>e.type==="AikoHarnessExperimentSettled")?.reason).toBe("no-supported-hypothesis");
  expect(rows.find((e:any)=>e.type==="AikoHarnessExperimentSettled")?.status).toBe("retained-baseline");
  const reflection = f.requests.filter(body => JSON.stringify(body.messages).includes("Improve one reusable harness"));
  expect(reflection).toHaveLength(1); expect(reflection[0].max_tokens).toBe(1024);
  const childThreads = f.db().query("SELECT thread FROM aiko_child_threads").all() as {thread:string}[];
  expect(childThreads).toHaveLength(4);
  for(const {thread} of childThreads){
    const history=f.db().query("SELECT event FROM aiko_thread_events WHERE thread=? ORDER BY seq").all(thread).map((row:any)=>JSON.parse(row.event));
    expect(history.filter(e=>e.type==="AikoHarnessRunStarted")).toHaveLength(1);
    expect(history.filter(e=>e.type==="AikoHarnessChecked")).toHaveLength(1);
  }
  expect(new Set(f.jobs.map(job=>job.operationId)).size).toBe(f.jobs.length);
  expect(f.jobs.every(job=>job.owner==="123"&&job.authority.origins.length===0&&job.authority.methods.length===0)).toBe(true);
  const nativeTrace=JSON.stringify(f.db().query("SELECT event FROM aiko_thread_events").all());
  expect(nativeTrace).not.toContain(privateInput);
  expect(nativeTrace).not.toContain("worker-fixture-model-key");
  expect(nativeTrace).not.toContain("音声");
  expect(JSON.stringify(f.requests)).not.toContain("array-and-unicode");
  expect(JSON.stringify(f.requests)).not.toContain(privateInput);
  for(const file of [f.file, f.file+"-wal"]){
    const bytes=await readFile(file).catch(()=>Buffer.alloc(0));
    expect(bytes.includes(Buffer.from(privateInput))).toBe(false);
    expect(bytes.includes(Buffer.from("worker-fixture-model-key"))).toBe(false);
    expect(bytes.includes(Buffer.from("音声"))).toBe(false);
  }
  const budget = await f.storage().get(`model-budget:123:${new Date().toISOString().slice(0,10)}`);
  expect(budget.calls).toBe(f.requests.length);
  const count = f.jobs.length, calls = f.requests.length;
  await f.restart(); await f.drive(); await f.drive();
  expect(f.jobs).toHaveLength(count); expect(f.requests).toHaveLength(calls);
});

test("Worker rejects foreign admission and permits owner cancellation after the execution grant is revoked", async () => {
  const f = await fixture();
  expect((await f.request("/api/harness/readiness", undefined, "foreign-token")).status).toBe(401);
  expect((await f.request("/api/control/wake?account=456", {})).status).toBe(403);
  const entered = Promise.withResolvers<void>();
  let interrupted = 0;
  f.onJob(async (_job, signal) => {
    if (!f.events().some((e:any)=>e.type==="AikoHarnessExperimentRegistered")) return;
    entered.resolve();
    await new Promise<void>((_resolve,reject)=>{
      const abort = () => { interrupted++; reject(Error("Controlled physical job interrupted")); };
      if(signal.aborted)abort();else signal.addEventListener("abort",abort,{once:true});
    });
  });
  expect((await f.request("/api/messages",{id:"worker-cancel-evidence",text:"Run controlled cancellation operations."})).status).toBe(202);
  const driving = f.drive();
  const deadline = setTimeout(() => entered.reject(Error("Child job did not start")), 10000);
  try { await entered.promise; } finally { clearTimeout(deadline); }
  const registered=f.events().find((e:any)=>e.type==="AikoHarnessExperimentRegistered");
  f.env.CODEGRAFF_API_KEY="revoked-execution-route";
  expect(await (await f.request("/api/harness/readiness")).json()).toMatchObject({experiments:false});
  delete f.env.CODEGRAFF_API_KEY;
  const cancelled=await f.request(`/api/harness/experiments/${encodeURIComponent(registered.experimentId)}/cancel`,{});
  expect(cancelled.status).toBe(200);
  await driving;
  for(let n=0;n<6;n++)await f.drive();
  expect(interrupted).toBe(1);
  expect(f.events().find((e:any)=>e.type==="AikoHarnessExperimentSettled")?.status).toBe("cancelled");
  expect(f.requests.filter(body=>JSON.stringify(body.messages).includes("Improve one reusable harness"))).toHaveLength(0);
  const jobs=f.jobs.length,calls=f.requests.length;
  f.env.CODEGRAFF_API_KEY="restored-config-for-reopen";
  await f.restart();await f.drive();await f.drive();
  expect(f.jobs).toHaveLength(jobs);expect(f.requests).toHaveLength(calls);
});

test("Worker reports missing transport without silently replacing the configured edge", async () => {
  const f=await fixture(); f.env.AIKO_REGISTRY_SANDBOX=()=>undefined;
  expect(await (await f.request("/api/harness/readiness")).json()).toMatchObject({experiments:false,registry:false,reason:"sandbox_transport_not_configured"});
  expect(f.jobs).toHaveLength(0);expect(f.requests).toHaveLength(0);
});

for (const cut of ["edge", "work", "started"] as const) test(`actual Worker cold ${cut} recovery without execution bindings uses only retained lifecycle`, async () => {
  const f = await fixture();
  let startedCut: Uint8Array | undefined;
  f.onJob(async () => {
    if (!startedCut && f.events().some((e: any) => e.type === "AikoHarnessTrialRequested")) startedCut = f.db().serialize();
  });
  expect((await f.request("/api/messages", { id: `cold-${cut}`, text: "Run controlled stateless operations." })).status).toBe(202);
  for (let n = 0; n < 24 && !f.events().some((e: any) => e.type === "AikoHarnessExperimentSettled"); n++) await f.drive();
  const snapshot = cut === "edge" ? f.edgeCut() : cut === "work" ? f.workCut() : startedCut;
  expect(snapshot).toBeDefined();
  if (!snapshot) throw Error("Actual native cut not observed");
  if (cut !== "started") { f.env.AIKO_CODE_MODE = "false"; delete f.env.CODEGRAFF_API_KEY; }
  else f.env.AIKO_REGISTRY_SANDBOX = () => undefined;
  await f.restore(snapshot);
  // Delete all encrypted artifacts, inputs, fixtures and their key before boot.
  // Lifecycle must neither hydrate them nor reconstruct execution bindings.
  f.db().query("DELETE FROM fixture_kv WHERE key LIKE 'harness-blobs:%' OR key LIKE 'harness-custody:%'").run();
  const get = f.storage().get;
  let privateReads = 0;
  f.storage().get = async (key: string) => {
    if (/^harness-(blobs|custody):/.test(key)) { privateReads++; throw Error("Private custody deliberately unavailable"); }
    return get(key);
  };
  const registered = f.events().find((e: any) => e.type === "AikoHarnessExperimentRegistered");
  const path = `/api/harness/experiments/${encodeURIComponent(registered.experimentId)}`;
  const jobs = f.jobs.length, requests = f.requests.length;
  expect((await f.request(path + "/status", undefined, "foreign-token")).status).toBe(401);
  expect((await f.request("/api/harness/experiments/foreign-owner-experiment/status")).status).toBe(409);
  expect(await (await f.request("/api/harness/readiness")).json()).toMatchObject({ experiments: false });
  expect((await f.request(path + "/status")).status).toBe(200);
  const now = Date.now;
  try {
    if (cut !== "started") expect((await f.request(path + "/cancel", {})).status).toBe(200);
    else Date.now = () => Number(registered.deadlineAt) + 1000;
    for (let n = 0; n < 8; n++) await f.drive();
  } finally { Date.now = now; }
  const children = f.db().query("SELECT event FROM aiko_thread_events WHERE thread LIKE 'harness-trial-%'").all().map((r: any) => JSON.parse(r.event));
  expect(children.filter(e => e.type === "AikoHarnessTrialExecuted")).toHaveLength(1);
  expect(children.find(e => e.type === "AikoHarnessTrialExecuted")).toMatchObject({ status: cut !== "started" ? "unavailable" : "unknown" });
  expect(children.filter(e => e.type === "AikoHarnessChecked")).toHaveLength(0);
  expect(f.events().some((e: any) => e.type === "AikoHarnessExperimentSettled")).toBe(true);
  if (cut === "started") expect(f.events().some((e: any) => e.type === "AlarmFired")).toBe(true);
  expect(f.jobs).toHaveLength(jobs); expect(f.requests).toHaveLength(requests);
  expect(privateReads).toBe(0);
  await f.restart(); await f.drive(); await f.drive();
  expect(f.jobs).toHaveLength(jobs); expect(f.requests).toHaveLength(requests);
  expect(JSON.stringify(f.db().query("SELECT event FROM aiko_thread_events").all())).not.toContain(privateInput);
}, 30000);
