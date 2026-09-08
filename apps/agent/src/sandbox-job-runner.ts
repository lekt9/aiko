import { executeHarnessAction, type HarnessTransportRequest, type HarnessTransportResponse } from "@unbrowse/browser-harness/harness-runtime";
import { validateSiteHarnessArtifact } from "@unbrowse/browser-harness/harness-artifact";
import { sendObservedHttp, type ObservedHttpOptions, type ObservedHttpDispatch } from "./observed-network.ts";
import { runCodeSegment } from "./code-sandbox-runner.ts";
import { sandboxCanonical, sandboxDigest, sandboxArtifactDependencies, verifySandboxReceipt, type SandboxArtifact, type SandboxJob, type SandboxJobReceipt } from "./sandbox-job.ts";
import type { SandboxPythonRuntime } from "./sandbox-python.ts";

/** Exact running toolchain, including the vendored evaluator, is pinned by the VM runner digest. */
export const sandboxEnvironment = (runnerDigest: string) => sandboxDigest({ runnerDigest, bun: Bun.version, quickjs: "0.32.0", abi: "unlock-sandbox-job/1" });
export interface SandboxJobJournal {
  /** Atomic insert-if-absent, persisted before executing any guest or request. */
  claim(owner: string, operationId: string, digest: string): Promise<boolean>;
  read(owner: string, operationId: string): Promise<{ digest: string; receipt?: SandboxJobReceipt } | undefined>;
  settle(owner: string, operationId: string, receipt: SandboxJobReceipt): Promise<void>;
}
export interface SandboxJobBinding {
  owner: string;
  environmentDigest: SandboxJob["environmentDigest"];
  journal: SandboxJobJournal;
  /** Trusted local/private-network transport only; never accepted from guest input. */
  send?: (request: HarnessTransportRequest, signal: AbortSignal) => Promise<HarnessTransportResponse>;
  /** Trusted test/host dependencies of the real DNS-pinned HTTP primitive. */
  http?: Pick<ObservedHttpOptions, "lookup" | "request">;
  beforeNetworkDispatch?: (request: { jobDigest: SandboxJob["harnessDigest"]; requestDigest: SandboxJob["harnessDigest"];
    stepId: string; attempt: number; prepared: ObservedHttpDispatch }, signal: AbortSignal) => Promise<void>;
  /** Explicit isolated native runtime; absent in the browser/vault runner. */
  python?: SandboxPythonRuntime;
}
export async function buildSandboxLibrary(artifact: Extract<SandboxArtifact, {kind:"library"}>) {
  artifact = JSON.parse(sandboxCanonical(artifact));
  const names = Object.keys(artifact.modules);
  if (!names.length || names.length > 64 || !Object.hasOwn(artifact.modules, artifact.entry)) throw Error("Invalid library entry");
  for (const name of names) {
    if (!/^[a-zA-Z0-9_@./-]{1,200}$/.test(name) || name.includes("..") || name.startsWith("/")) throw Error("Invalid module name");
    const module = artifact.modules[name]!;
    if (typeof module.source !== "string" || module.digest !== await sandboxDigest(module.source)) throw Error("Module digest mismatch");
  }
  const result = await Bun.build({ entrypoints: ["__sandbox_entry__"], target: "browser", format: "iife", minify: true,
    plugins: [{ name: "pinned-sandbox-modules", setup(build) {
      build.onResolve({ filter: /.*/ }, args => {
        let name = args.path;
        if (name.startsWith("./")) name = `${args.importer.includes("/") ? args.importer.slice(0,args.importer.lastIndexOf("/")+1) : ""}${name.slice(2)}`;
        if (name !== "__sandbox_entry__" && !Object.hasOwn(artifact.modules, name)) throw Error(`Unpinned dependency: ${name}`);
        return { path: name, namespace: "pinned" };
      });
      build.onLoad({ filter: /.*/, namespace: "pinned" }, args => ({ contents: args.path === "__sandbox_entry__" ? `import run from ${JSON.stringify(artifact.entry)}; globalThis.__sandboxLibrary = {default:run};` : artifact.modules[args.path]!.source, loader: "js" }));
    }}] });
  if (!result.success || result.outputs.length !== 1) throw Error("Pinned library build failed");
  const code = `${await result.outputs[0]!.text()}\nreturn await __sandboxLibrary.default(input);`;
  if (Buffer.byteLength(code) > 65536) throw Error("Built code exceeds QuickJS segment budget");
  return { kind: "code" as const, code };
}
/** Read only: missing or running custody never enters claim/execute. */
export async function readSandboxReceipt(value: SandboxJob, binding: SandboxJobBinding, cancellation?: AbortSignal): Promise<SandboxJobReceipt> {
  cancellation?.throwIfAborted();
  const job = JSON.parse(sandboxCanonical(value)) as SandboxJob;
  if (job.version !== 1 || job.owner !== binding.owner || !/^[\w:.-]{1,200}$/.test(job.operationId) || job.environmentDigest !== binding.environmentDigest) throw Error("Sandbox receipt scope mismatch");
  const jobDigest = await sandboxDigest(job), retained = await binding.journal.read(binding.owner, job.operationId);
  cancellation?.throwIfAborted();
  if (retained && retained.digest !== jobDigest) throw Error("Sandbox receipt identity conflict");
  return verifySandboxReceipt(job, retained?.receipt ?? { operationId: job.operationId, jobDigest, harnessDigest: job.harnessDigest,
    environmentDigest: job.environmentDigest, requests: 0, browserStarts: 0, status: "unknown", reason: "no_retained_terminal_receipt" });
}
export async function runSandboxJob(job: SandboxJob, binding: SandboxJobBinding, cancellation?: AbortSignal): Promise<SandboxJobReceipt> {
  const encoded = sandboxCanonical(job);
  if (Buffer.byteLength(encoded) > (job.artifact.kind === "python" ? 64 * 1024 * 1024 : 1024 * 1024)) throw Error("Sandbox job exceeds byte budget");
  job = JSON.parse(encoded);
  if (job.version !== 1 || job.owner !== binding.owner || !/^[\w:.-]{1,200}$/.test(job.operationId) || !job.contextRef || !job.authorityRef) throw Error("Sandbox scope mismatch");
  if (!["code", "library", "network", "python"].includes(job.artifact.kind) || job.mode !== undefined && !["build", "run"].includes(job.mode)) throw Error("Unsupported sandbox artifact or mode");
  if (job.artifact.kind === "code" && (typeof job.artifact.code !== "string" || Buffer.byteLength(job.artifact.code) > 65536)) throw Error("Invalid code artifact");
  if (job.artifact.kind === "network") {
    const network = job.artifact;
    const graph = validateSiteHarnessArtifact(network.graph);
    if (!graph.actions.some(action => action.id === network.actionId)) throw Error("Network action unavailable");
  }
  if (job.environmentDigest !== binding.environmentDigest || job.harnessDigest !== await sandboxDigest(job.artifact) || job.dependencyLockDigest !== await sandboxDigest(job.dependencyLock)) throw Error("Sandbox pin mismatch");
  const {wallMs,requests,outputBytes} = job.budget;
  const python = job.artifact.kind === "python";
  if (![wallMs,requests,outputBytes].every(Number.isInteger) || wallMs < 1 || wallMs > (python ? 300000 : 30000) || requests < 0 || requests > 96 || outputBytes < 1 || outputBytes > (python ? 2 * 1024 * 1024 : 262144)) throw Error("Invalid sandbox budget");
  if (python && (!binding.python || binding.python.lockDigest !== (job.artifact as Extract<SandboxArtifact,{kind:"python"}>).runtimeLockDigest)) throw Error("Isolated Python runtime unavailable or changed");
  if (!python && job.assets !== undefined) throw Error("Binary assets require an isolated Python job");
  if (job.dispatch !== undefined && (job.dispatch.protocol !== "host-request/v1" || Object.keys(job.dispatch).length !== 1 ||
    job.artifact.kind !== "network" || job.mode === "build" || !binding.beforeNetworkDispatch || binding.send))
    throw Error("Sandbox physical dispatch authority unavailable");
  if (!Array.isArray(job.authority.origins) || !Array.isArray(job.authority.methods) || job.authority.origins.some(o => new URL(o).origin !== o) || job.authority.methods.some(m=> !["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"].includes(m))) throw Error("Invalid sandbox authority");
  const expectedLock = sandboxArtifactDependencies(job.artifact);
  if (sandboxCanonical(expectedLock) !== sandboxCanonical(job.dependencyLock)) throw Error("Unresolved dependency lock");
  const jobDigest = await sandboxDigest(job);
  const base = {operationId:job.operationId,jobDigest,harnessDigest:job.harnessDigest,environmentDigest:job.environmentDigest,requests:0,browserStarts:0 as const};
  if (!await binding.journal.claim(binding.owner,job.operationId,jobDigest)) {
    const prior = await binding.journal.read(binding.owner,job.operationId);
    if (!prior || prior.digest !== jobDigest) throw Error("Sandbox operation identity conflict");
    return prior.receipt ?? {...base,status:"unknown",reason:"dispatched_without_receipt_reconcile_required"};
  }
  const deadline = performance.now() + wallMs;
  const signal = AbortSignal.any([...(cancellation ? [cancellation] : []), AbortSignal.timeout(wallMs)]);
  let receipt: SandboxJobReceipt;
  let resources: SandboxJobReceipt["resources"];
  let writeDispatched = false;
  try {
    signal.throwIfAborted();
    const artifact = job.artifact.kind === "library" ? await buildSandboxLibrary(job.artifact) : job.artifact;
    signal.throwIfAborted();
    const built = job.artifact.kind === "library" ? {builtArtifact:artifact as Extract<SandboxArtifact,{kind:"code"}>,builtDigest:await sandboxDigest(artifact)} : {};
    let output: unknown;
    if (artifact.kind === "python") output = await binding.python!.execute(job, signal, usage => { resources = usage; });
    else if (job.mode === "build") output = {built:true};
    else if (artifact.kind === "code") {
      const result = await runCodeSegment({version:1,code:artifact.code,packages:{},values:{input:job.input},ambient:{at:0,seed:job.operationId},history:[]},signal,{cpuMs:Math.max(1,Math.min(1000,deadline-performance.now()))});
      if (result.error || !result.settled) throw Error("Sandbox code execution failed");
      output = result.result ?? null;
    } else if (artifact.kind === "network") {
      const graph = validateSiteHarnessArtifact(artifact.graph);
      if (graph.allowedOrigins.some(origin=>!job.authority.origins.includes(origin))) throw Error("Network origin outside authority");
      let terminal: unknown = null;
      const result = await executeHarnessAction({artifact:graph,actionId:artifact.actionId,input:job.input as any,
        limits:{maxRequests:requests,maxValueBytes:outputBytes},adapters:{clock:{now:()=>new Date()},uuid:{next:()=>crypto.randomUUID()},transport:{send:async request=>{
          signal.throwIfAborted();
          if (!job.authority.origins.includes(new URL(request.url).origin) || !job.authority.methods.includes(request.method) || base.requests >= requests) throw Error("Network authority or budget exceeded");
          base.requests++;
          const markDispatch = () => { writeDispatched ||= !["GET","HEAD","OPTIONS"].includes(request.method); };
          const response = binding.send
            ? (markDispatch(), await binding.send(request,signal))
            : await sendObservedHttp(request, signal, { ...binding.http,
              ...(job.dispatch ? { beforeDispatch: async (prepared: ObservedHttpDispatch) => {
                await binding.beforeNetworkDispatch!({ jobDigest, requestDigest: await sandboxDigest(prepared), stepId: request.stepId, attempt: request.attempt, prepared }, signal);
              } } : {}), onDispatch: markDispatch });
          signal.throwIfAborted();
          if (Buffer.byteLength(sandboxCanonical(response)) > outputBytes) throw Error("Response byte budget exceeded");
          terminal = response.body ?? null;
          return response;
        }}}});
      if(result.status !== "completed") throw Error("Network harness execution failed");
      output = {result,terminal};
    } else throw Error("Unsupported sandbox artifact");
    signal.throwIfAborted();
    if(performance.now() > deadline) throw Error("Sandbox deadline exceeded");
    if(Buffer.byteLength(sandboxCanonical(output)) > outputBytes) throw Error("Sandbox output budget exceeded");
    receipt = {...base,...built,...(resources ? {resources} : {}),status:"completed",output,outputDigest:await sandboxDigest(output)};
  } catch {
    receipt = {...base,...(resources ? {resources} : {}),status:writeDispatched?"unknown":"failed",reason:writeDispatched?"write_requires_reconciliation":signal.aborted?"cancelled_or_deadline":"sandbox_execution_failed"};
  }
  await binding.journal.settle(binding.owner,job.operationId,receipt);
  return receipt;
}
