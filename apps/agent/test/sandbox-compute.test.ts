import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { actor, agentMessageMethod } from "tardie";
import { createBunHost } from "tardie/bun/host";
import { component } from "tardie/core/component";
import { cancellationRequested } from "tardie/core/method/cancellation";
import { threadCreated } from "tardie/core/thread";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { Self } from "tardie/core/runtime";
import { EventLog, withWatermark } from "tardie/core/log";
import { Codegraff, type SandboxStore } from "../src/codegraff.ts";
import { createHash } from "node:crypto";
import { SandboxCompute, sandboxComputeTools, sandboxComputeCancellation, computeExportPath, type ComputeStore } from "../src/sandbox-compute.ts";
import { redactor } from "../src/security.ts";

function fixture() {
  const rows = new Map<string, unknown>();
  const store: ComputeStore = { claim: async (key,value) => { if(rows.has(key)) return false; rows.set(key,structuredClone(value)); return true; }, get: async <T>(key: string) => structuredClone(rows.get(key)) as T, put: async (key, value) => { rows.set(key, structuredClone(value)); } };
  const calls: { path: string; body: any; method: string | undefined }[] = [];
  const files = new Map<string, string>();
  const state = { machine: "started", job: "running", exitCode: 0, output: "", loseLaunch: false, loseCancel: false, setupState: "completed", setupExit: 0, loseSetup: false, exportExit: 0, payload: new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 1, 2, 3, 4]) };
  const gateway = new Codegraff("private-host-key", async (url, init) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, method: init?.method });
    if (path.endsWith("/upload") && typeof body?.path === "string" && typeof body.contentBase64 === "string") {
      files.set(body.path, Buffer.from(body.contentBase64, "base64").toString("utf8"));
      return Response.json({ ok: true });
    }
    if (path.endsWith("/download")) {
      const text = files.get(body.path);
      if (text === undefined) return new Response("missing", { status: 404 });
      return Response.json({ contentBase64: Buffer.from(text, "utf8").toString("base64") });
    }
    if (path.endsWith("/exec") && body.command.startsWith("bash /tmp/aiko-compute-cloak-")) {
      if (state.loseSetup) throw Error("lost setup ack");
      return Response.json({execId:"cloak-setup"});
    }
    if (path.includes("/exec/cloak-setup")) return Response.json({state:state.setupState,exitCode:state.setupExit});
    if (path === "/v1/sandboxes") return Response.json({ id: "compute-test" });
    if (path.endsWith("/start")) { state.machine = "started"; return Response.json({ ok: true }); }
    if (path.endsWith("/exec") && body?.async === false) {
      if (typeof body.command === "string" && body.command.includes("aiko-export-") && body.command.includes("python3") && !body.command.includes("unlink")) {
        const match = /\/tmp\/aiko-export-([0-9a-f-]+)\.py/.exec(body.command);
        const job = match ? JSON.parse(files.get(`/tmp/aiko-export-${match[1]}.json`) ?? "{}") : {};
        if (state.exportExit !== 0) return Response.json({ state: "completed", exitCode: state.exportExit, output: "not_a_regular_file" });
        const prefix = String(job.outPrefix ?? "");
        const armor = Buffer.from(state.payload).toString("base64");
        files.set(`${prefix}.meta.json`, JSON.stringify({
          version: 1, size: state.payload.byteLength,
          sha256: createHash("sha256").update(state.payload).digest("hex"),
        }));
        files.set(`${prefix}.payload.b64`, armor);
        return Response.json({ state: "completed", exitCode: 0, output: "aiko-export-ready" });
      }
      return Response.json({ state: "completed", exitCode: 0, output: "" });
    }
    if (path.endsWith("/exec")) {
      if (state.loseLaunch) throw Error("connection_lost");
      return Response.json({ execId: "exec-test", state: "running" });
    }
    if (init?.method === "DELETE") {
      if (state.loseCancel) throw Error("lost cancellation acknowledgement");
      return Response.json({ ok: true });
    }
    if (path.includes("/exec/")) return Response.json({ state: state.job, ...(state.job === "completed" ? { exitCode: state.exitCode } : {}), output: state.output });
    return Response.json({ state: state.machine });
  });
  const compute = new SandboxCompute("123", gateway, store);
  return { compute, store, rows, calls, state, gateway };
}

test("a bounded native wait observes completion without relaunching the command", async () => {
  const f = fixture();
  const job = await f.compute.exec("user-123", "wait-test", {command: "generate-once"}, signal()) as { jobId: string };
  const waiting = f.compute.wait("user-123", job.jobId, signal(), 20);
  f.state.job = "completed";
  f.state.output = "artifact ready";
  expect(await waiting).toMatchObject({state: "completed", output: "artifact ready", exitCode: 0});
  expect(f.calls.filter(c => c.body?.command === "generate-once")).toHaveLength(1);
});

test("unchanged waits return a bounded running result and cancellation stops waiting", async () => {
  const f = fixture();
  const job = await f.compute.exec("user-123", "wait-test", {command: "generate-once"}, signal()) as { jobId: string };
  expect(await f.compute.wait("user-123", job.jobId, signal(), 5)).toMatchObject({state: "running", unchanged: true});
  await expect(f.compute.wait("user-123", job.jobId, AbortSignal.timeout(5), 1000)).rejects.toThrow();
  expect(f.calls.filter(c => c.body?.command === "generate-once")).toHaveLength(1);
  expect(await f.compute.poll("user-123", job.jobId, signal(), true)).toMatchObject({state: "cancelled"});
});
const signal = () => AbortSignal.timeout(5000);

test.each([
  ["cancelled", false, false], ["unknown", true, false], ["completed", false, true],
] as const)("native cancellation settles remote cleanup before the turn and survives recovery (%s)", async (expectedState, loseCancel, completed) => {
  const f = fixture(), directory = await mkdtemp("/tmp/aiko-compute-cancel-");
  f.state.loseCancel = loseCancel;
  f.state.job = completed ? "completed" : "running";
  f.state.output = "private-compute-output-sentinel";
  await f.compute.exec("user-123", "turn:command", {command:"generate-once"}, signal());
  const definition = actor({name:"aiko",methods:{message:agentMessageMethod},components:[
    sandboxComputeCancellation(f.compute,"user-123"),
    component<null,undefined>({name:"terminal-keys",initial:()=>null,step:s=>s,
      keys:{prefixes:["terminal:"],keyOf:e=>e.type==="TurnCancelled"?`terminal:${e.turn}:${e.epoch ?? 0}`:undefined},
      output:()=>({view:undefined,transitions:[]})}),
  ]});
  const open = () => createBunHost({database:`${directory}/actor.sqlite`,actorName:"aiko",actorInstance:"compute-test",actorFor:()=>definition,layersFor:()=>Layer.empty});
  let host = await open();
  try {
    await host.seed("user-123", [threadCreated(parseThreadAddress(host.self("user-123")),undefined,0),
      {type:"MessageReceived",id:"turn",text:"Generate",at:1},
      {type:"AikoCodeToolStarted",owner:"123",tool:"sandbox_exec",turn:"turn",callId:"command",at:2},
      cancellationRequested({request:"stop",cause:"requested",invocation:{method:"message",id:"turn",epoch:0},at:3}),
    ]);
    await host.wake("user-123");
    const events = await host.read("user-123");
    const settled = events.findIndex(e=>e.type==="AikoComputeCancellationSettled");
    expect(settled).toBeGreaterThan(-1);
    expect(events[settled]?.result).toMatchObject({state:expectedState});
    expect(JSON.stringify(events)).not.toContain("private-compute-output-sentinel");
    expect(events.findIndex(e=>e.type==="TurnCancelled")).toBeGreaterThan(settled);
    expect(f.calls.filter(c=>c.method==="DELETE")).toHaveLength(completed ? 0 : 1);
    await host.close(); host = await open(); await host.wake("user-123");
    expect(f.calls.filter(c=>c.method==="DELETE")).toHaveLength(completed ? 0 : 1);
    expect(f.calls.filter(c=>c.body?.command==="generate-once")).toHaveLength(1);
  } finally {await host.close();await rm(directory,{recursive:true,force:true});}
});

test("compute status does not allocate; commands use isolated VM and async gateway protocol", async () => {
  const f = fixture();
  f.rows.set("codegraff:sandbox", { owner: "123", id: "private-browser" });
  expect(await f.compute.status()).toMatchObject({ available: true, state: "unallocated" });
  expect(f.calls).toHaveLength(0);
  const job = await f.compute.exec("user-123", "first", { command: "node -v", cwd: "/tmp" }, signal()) as any;
  expect(job.state).toBe("running");
  expect(f.calls.find(c => c.path.endsWith("/exec") && !c.body.command.startsWith("bash /tmp/aiko-compute-cloak-"))?.body).toEqual({ command: "node -v", cwd: "/tmp", async: true });
  expect(f.calls[0]?.body).toEqual({ language: "javascript", autoStopMinutes: 30 });
  expect(JSON.stringify(f.calls)).not.toContain("private-host-key");
  expect(JSON.stringify(f.calls)).not.toContain("private-browser");
  f.state.job = "completed";
  f.state.exitCode = 7;
  f.state.output = "provider rejected authentication";
  expect(await f.compute.poll("user-123", job.jobId, signal())).toMatchObject({ state: "completed", exitCode: 7, output: "provider rejected authentication" });
});

test("reconstructed actor polls existing command instead of resubmitting", async () => {
  const f = fixture();
  const job = await f.compute.exec("user-123", "call", { command: "generate-once" }, signal()) as any;
  const restored = new SandboxCompute("123", f.gateway, f.store);
  expect(await restored.exec("user-123", "call", { command: "generate-once" }, signal())).toMatchObject({ jobId: job.jobId });
  expect(f.calls.filter(c => c.path.endsWith("/exec") && !c.body.command.startsWith("bash /tmp/aiko-compute-cloak-"))).toHaveLength(1);
  await expect(restored.poll("user-456", job.jobId, signal())).rejects.toThrow("account/thread");
  await expect(new SandboxCompute("456", f.gateway, f.store).status()).rejects.toThrow("owner mismatch");
});

test("uncertain command launch is never repeated, including after a restart", async () => {
  const f = fixture(); f.state.loseLaunch = true;
  expect(await f.compute.exec("user-123", "call", { command: "paid-generation" }, signal())).toMatchObject({ state: "unknown", jobId: expect.any(String) });
  const restored = new SandboxCompute("123", f.gateway, f.store);
  expect(await restored.exec("user-123", "call", { command: "paid-generation" }, signal())).toMatchObject({ state: "unknown" });
  expect(f.calls.filter(c => c.path.endsWith("/exec") && !c.body.command.startsWith("bash /tmp/aiko-compute-cloak-"))).toHaveLength(1);
});

test("concurrent commands share one compute VM and interrupted allocation cannot duplicate it", async () => {
  const f = fixture();
  await Promise.all(["a", "b"].map(id => f.compute.exec("user-123", id, { command: "node -v" }, signal())));
  expect(f.calls.filter(c => c.path === "/v1/sandboxes")).toHaveLength(1);
  const g = fixture(); g.rows.set("codegraff:compute", { owner: "123", phase: "provisioning" });
  await expect(g.compute.exec("user-123", "call", { command: "node -v" }, signal())).rejects.toThrow("outcome unknown");
  expect(g.calls).toHaveLength(0);
});

test("stopped compute resumes with retained disk; cancellation kills only the owned job", async () => {
  const f = fixture();
  await f.compute.exec("user-123", "a", { command: "node -v" }, signal());
  f.state.machine = "stopped";
  const job = await f.compute.exec("user-123", "b", { command: "node -v" }, signal()) as any;
  expect(f.calls.some(c => c.path.endsWith("/start"))).toBe(true);
  expect(await f.compute.poll("user-123", job.jobId, signal(), true)).toMatchObject({ state: "cancelled" });
  expect(f.calls.find(c => c.method === "DELETE")?.path).toBe("/v1/sandboxes/compute-test/exec/exec-test");
});

test("native tools enforce thread ownership and redact receipts without submitting key literals", async () => {
  const f = fixture();
  const tools = sandboxComputeTools(f.compute, { owner: "123", thread: "user-123", redact: redactor(["private-provider-value"]) });
  const events: import("tardie/core/event").Event[] = [];
  const log = withWatermark({ read: Effect.sync(() => [...events]), append: batch => Effect.sync(() => { events.push(...batch); }) });
  const run = (name: string, args: unknown, thread = "user-123") => Effect.runPromise(tools.find(t => t.spec.name === name)!.run(args, { callId: "one", turn: "turn", signal: signal() }).pipe(Effect.provideService(Self, { actor: "aiko", instance: "test", thread } as any), Effect.provideService(EventLog, log)));
  expect(await run("sandbox_exec", { command: "echo private-provider-value" })).toMatchObject({ status: "blocked" });
  expect(f.calls).toHaveLength(0);
  await expect(run("sandbox_status", {}, "user-456")).rejects.toThrow("scope mismatch");
  f.state.job = "completed"; f.state.output = "private-provider-value";
  expect(await run("sandbox_exec", { command: "node -v" })).toMatchObject({ output: "[redacted]" });
});


test("changed command arguments cannot reuse an active or retained invocation", async () => {
  const f = fixture();
  const first = f.compute.exec("user-123", "same", {command:"first"}, signal());
  await expect(f.compute.exec("user-123", "same", {command:"changed"}, signal())).rejects.toThrow("identity conflict");
  await first;
  await expect(new SandboxCompute("123", f.gateway, f.store).exec("user-123", "same", {command:"first",cwd:"/other"},signal())).rejects.toThrow("identity conflict");
  expect(f.calls.filter(c=>c.path.endsWith("/exec") && !c.body.command.startsWith("bash /tmp/aiko-compute-cloak-"))).toHaveLength(1);
});

test("separate compute instances atomically fence dispatch and unavailable atomic custody fails closed", async () => {
  const f = fixture();
  await f.compute.exec("user-123", "warm", {command:"warm"}, signal());
  const other = new SandboxCompute("123", f.gateway, f.store);
  await Promise.all([f.compute,other].map(c=>c.exec("user-123","race",{command:"once"},signal())));
  expect(f.calls.filter(c=>c.path.endsWith("/exec") && !c.body.command.startsWith("bash /tmp/aiko-compute-cloak-"))).toHaveLength(2);
  const unsafe = new SandboxCompute("123",f.gateway,{get:f.store.get,put:f.store.put});
  await expect(unsafe.exec("user-123","new",{command:"denied"},signal())).rejects.toThrow("Atomic compute custody unavailable");
});

const setups = (f: ReturnType<typeof fixture>) => f.calls.filter(c => c.path.endsWith("/exec") && c.body.command.startsWith("bash /tmp/aiko-compute-cloak-"));
test("raw allocation installs pinned browser before admitting HTTP and reuses retained VM across restart", async () => {
  const f = fixture();
  await f.compute.exec("t", "http", {command:"curl https://example.com"}, signal());
  expect(setups(f)).toHaveLength(1);
  expect(setups(f)[0]!.body.command).toEndWith(".js install");
  expect(setups(f)[0]!.body.command).toContain(".sh --compute &&");
  const uploads = f.calls.filter(c => c.path.endsWith("/upload"));
  const installer = Buffer.from(uploads.find(c => c.body.path.endsWith(".js"))!.body.contentBase64,"base64").toString();
  expect(installer.includes("CloakBrowser archive integrity failed")).toBe(true);
  expect(installer.includes("146.0.7680.177.5")).toBe(true);
  expect(f.calls.filter(c=>c.path.endsWith("/exec")).every(c=>! / (serve|health)( |$)/.test(c.body.command))).toBe(true);
  expect(f.calls.indexOf(setups(f)[0]!)).toBeLessThan(f.calls.findIndex(c=>c.body?.command==="curl https://example.com"));
  await new SandboxCompute("123",f.gateway,f.store).exec("t","second",{command:"true"},signal());
  expect(setups(f)).toHaveLength(1);
  expect(f.calls.filter(c=>c.path==="/v1/sandboxes")).toHaveLength(1);
  expect(await f.compute.status()).toMatchObject({available:true});
});
test("legacy retained raw VM receives installation in place, preserving the allocation handle", async () => {
  const f=fixture(); f.rows.set("codegraff:compute",{owner:"123",id:"compute-test",phase:"available"});
  expect(await f.compute.status()).toMatchObject({available:false,setupState:"required"});
  expect(await f.compute.ensureMachine(signal())).toBe("compute-test");
  expect(setups(f)).toHaveLength(1);
  expect(f.calls.filter(c=>c.path==="/v1/sandboxes")).toHaveLength(0);
});
test("interrupted installation resumes original exec; failure and lost acknowledgement never admit commands or allocate again", async () => {
  const f=fixture(); f.state.setupState="running";
  await expect(f.compute.ensureMachine(AbortSignal.timeout(20))).rejects.toThrow();
  expect(await f.compute.status()).toMatchObject({available:false,setupState:"running",setupExecId:"cloak-setup"});
  f.state.setupState="completed";
  expect(await new SandboxCompute("123",f.gateway,f.store).ensureMachine(signal())).toBe("compute-test");
  expect(setups(f)).toHaveLength(1);
  for(const lost of [false,true]) {
    const g=fixture();g.state.setupExit=7;g.state.loseSetup=lost;
    for(let i=0;i<2;i++) await expect(new SandboxCompute("123",g.gateway,g.store).exec("t","x",{command:"must-not-run"},signal())).rejects.toThrow("CloakBrowser setup");
    expect(await g.compute.status()).toMatchObject({available:false,setupState:lost?"dispatching":"failed"});
    expect(setups(g)).toHaveLength(1);
    expect(g.calls.filter(c=>c.path==="/v1/sandboxes")).toHaveLength(1);
    expect(g.calls.some(c=>c.body?.command==="must-not-run")).toBe(false);
  }
});

test("owned VM files export through host-armored download and reject foreign paths", async () => {
  expect(() => computeExportPath("/etc/passwd")).toThrow();
  expect(() => computeExportPath("/tmp/../etc/passwd")).toThrow();
  expect(() => computeExportPath("https://example.com/v.mp4")).toThrow();
  expect(computeExportPath("/tmp/ugc_v3.mp4")).toBe("/tmp/ugc_v3.mp4");
  const missing = fixture();
  await expect(missing.compute.exportFile("/tmp/ugc_v3.mp4", signal())).rejects.toThrow("No compute VM is allocated");
  const f = fixture();
  await f.compute.exec("user-123", "make-file", { command: "true" }, signal());
  const exported = await f.compute.exportFile("/tmp/ugc_v3.mp4", signal());
  expect(exported).toMatchObject({ fileName: "ugc_v3.mp4", size: f.state.payload.byteLength });
  expect([...exported.bytes]).toEqual([...f.state.payload]);
  expect(f.calls.some(c => c.path.endsWith("/upload") && String(c.body?.path ?? "").endsWith(".py"))).toBe(true);
  expect(f.calls.some(c => c.path.endsWith("/download") && String(c.body?.path ?? "").endsWith(".payload.b64"))).toBe(true);
  expect(JSON.parse(f.calls.find(c => c.path.endsWith("/upload") && String(c.body?.path ?? "").endsWith(".json"))!.body.contentBase64 ? Buffer.from(f.calls.find(c => c.path.endsWith("/upload") && String(c.body?.path ?? "").endsWith(".json"))!.body.contentBase64, "base64").toString() : "{}")).toMatchObject({ path: "/tmp/ugc_v3.mp4" });
  const failed = fixture();
  await failed.compute.exec("user-123", "make-file", { command: "true" }, signal());
  failed.state.exportExit = 2;
  await expect(failed.compute.exportFile("/tmp/ugc_v3.mp4", signal())).rejects.toThrow("not a regular owned file");
});
