import { DefiniteComputeRuntimeFailure, type ComputeRuntimeRepair, type ComputeRuntimeRepairRequest } from "./compute-runtime-recovery.ts";
import {createHash} from "node:crypto";
import { harnessDigest, harnessBlobStore, type HarnessDigest } from "./harness-library.ts";
import { Codegraff } from "./codegraff.ts";
import { SandboxCompute, type ComputeStore } from "./sandbox-compute.ts";
import type { WorkflowKV } from "./workflow-host.ts";
import type { HarnessSandboxClient } from "./harness-sandbox.ts";
import {
  sandboxArtifactDependencies,
  sandboxDigest,
  sandboxCanonical,
  verifySandboxReceipt,
  type SandboxDigest,
  type SandboxJob,
  type SandboxJobReceipt,
} from "./sandbox-job.ts";

/** A trusted bundle invokes compute-runner-entry with the isolated Python runtime.
 * These are deployment artifacts, never model/candidate supplied configuration. */
export interface ComputeHarnessConfig {
  runtime?:Record<string,unknown>;
  runnerBundle: string;
  runtimeLockDigest: SandboxDigest;
  environmentDigest: SandboxDigest;
}
export type ComputeHarnessHostConfig = ComputeHarnessConfig & {
  javascriptEnvironmentDigest: SandboxDigest;
};
// A cold request can attest once and reconstruct once before the job starts.
// These control-plane wait ceilings never widen the candidate's job budget;
// an explicitly supplied caller signal always wins.
export const computeLifecycleBudgets = Object.freeze({ attestationWallMs: 120000, coldInvocationOverheadMs: 240000 });
type Retained = {
  digest: SandboxDigest;
  machine: string;
  path: string;
  receiptRef?: HarnessDigest;
};
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      done();
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, 100);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
/** Separate VM, separate command namespace, same owner private WorkflowKV.
 * A missing dispatch acknowledgement never permits another execution. Recovery
 * reads the exact receipt file, including when the provider lost its exec ID. */
export class CodegraffComputeHarness implements HarnessSandboxClient {
  readonly compute: SandboxCompute;
  readonly blobs: ReturnType<typeof harnessBlobStore>;
  readonly pythonRuntimeLockDigest: SandboxDigest;
  constructor(
    readonly owner: string,
    readonly gateway: Codegraff,
    readonly kv: WorkflowKV,
    readonly config: ComputeHarnessConfig,
  ) {
    if (
      !owner ||
      !config.runnerBundle ||
      !/^sha256:[a-f0-9]{64}$/.test(config.runtimeLockDigest) ||
      !/^sha256:[a-f0-9]{64}$/.test(config.environmentDigest)
    )
      throw Error("Trusted compute runtime configuration unavailable");
    this.config = structuredClone(config);
    this.blobs = harnessBlobStore(kv);
    this.pythonRuntimeLockDigest = config.runtimeLockDigest;
    const prefix = `compute-harness:${owner}:`;
    const store: ComputeStore = {
      get: async <T>(key: string) =>
        (await kv.get(prefix + key)) as T | undefined,
      put: (key, value) => kv.put(prefix + key, value),
      claim: (key, value) => kv.claim(prefix + key, value),
    };
    this.compute = new SandboxCompute(owner, gateway, store);
  }
  private async upload(
    machine: string,
    path: string,
    text: string,
    signal: AbortSignal,
  ) {
    await this.gateway.request(
      `/v1/sandboxes/${machine}/upload`,
      { path, contentBase64: Buffer.from(text).toString("base64") },
      signal,
    );
  }
  private async download(
    machine: string,
    path: string,
    limit: number,
    signal: AbortSignal,
  ) {
    const value = await this.gateway.request(
      `/v1/sandboxes/${machine}/download`,
      { path },
      signal,
      undefined,
      Math.ceil((limit * 4) / 3) + 4096,
    );
    if (
      typeof value.contentBase64 !== "string" ||
      value.contentBase64.length > Math.ceil(limit / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value.contentBase64,
      )
    )
      throw Error("Invalid compute output encoding");
    const bytes = Buffer.from(value.contentBase64, "base64");
    const text = bytes.toString("utf8");
    if (bytes.length > limit || !Buffer.from(text).equals(bytes))
      throw Error("Invalid compute output bytes");
    const decoded=JSON.parse(text);
    if(decoded?.statusCode===404&&decoded?.source==="DAYTONA_DAEMON"&&decoded?.code==="FILE_NOT_FOUND")throw Error("codegraff_http_404");
    return decoded;
  }
  private async prepare(signal: AbortSignal) {
    const machine = await this.compute.ensureMachine(signal);
    const pin = (await sandboxDigest(this.config)).slice(7);
    const runner = `/tmp/aiko-compute-${pin}.js`;
    await this.upload(machine, runner, this.config.runnerBundle, signal);
    let runtimeArgument="";
    if(this.config.runtime){
      const path=`/tmp/aiko-compute-${pin}.config.json`;
      await this.upload(machine,path,JSON.stringify({runtime:this.config.runtime,runtimeLockDigest:this.config.runtimeLockDigest}),signal);
      runtimeArgument=` --config ${path}`;
    }
    return { machine, runner, pin,runtimeArgument };
  }
  async harnessEnvironment(cancellation?: AbortSignal): Promise<SandboxDigest> {
    const signal = cancellation ?? AbortSignal.timeout(computeLifecycleBudgets.attestationWallMs);
    const { machine, runner, pin,runtimeArgument } = await this.prepare(signal);
    const probe = (await sandboxDigest([pin, crypto.randomUUID()])).slice(7);
    const path = `/tmp/aiko-compute-${probe}.environment.json`;
    let status: any = await this.compute.exec(
      `user-${this.owner}`,
      `environment:${probe}`,
      { command: `bun ${runner}${runtimeArgument} environment ${path}` },
      signal,
    );
    while (status.state === "running") {
      await pause(signal);
      status = await this.compute.poll(
        `user-${this.owner}`,
        status.jobId,
        signal,
      );
    }
    const attestation = await this.download(machine, path, 4096, signal);
    if (status.state === "completed" && status.exitCode === 0 && attestation.ready === false &&
        ["runtime-missing", "runtime-lock-mismatch"].includes(attestation.reason) && attestation.runtimeLockDigest === this.config.runtimeLockDigest) {
      const failureRef = await this.blobs.putPrivate(this.owner, {version:1,owner:this.owner,machine,runnerDigest:await sandboxDigest(this.config.runnerBundle),runtimeLockDigest:this.config.runtimeLockDigest,environmentDigest:this.config.environmentDigest,runtimeConfigDigest:await sandboxDigest(this.config.runtime ?? {}),probe,reason:attestation.reason});
      throw new DefiniteComputeRuntimeFailure(failureRef);
    }
    if (
      attestation.environmentDigest !== this.config.environmentDigest ||
      attestation.runtimeLockDigest !== this.config.runtimeLockDigest
    )
      throw Error("Compute runtime attestation mismatch");
    return this.config.environmentDigest;
  }
  async harnessJob(
    value: SandboxJob,
    cancellation?: AbortSignal,
  ): Promise<SandboxJobReceipt> {
    const job = structuredClone(value),
      signal = cancellation ?? AbortSignal.timeout(job.budget.wallMs + computeLifecycleBudgets.coldInvocationOverheadMs);
    if (
      job.owner !== this.owner ||
      job.artifact.kind !== "python" ||
      job.artifact.runtimeLockDigest !== this.config.runtimeLockDigest ||
      job.environmentDigest !== this.config.environmentDigest ||
      job.authority.origins.length ||
      job.authority.methods.length ||
      job.budget.requests !== 0
    )
      throw Error("Compute harness scope/runtime/network denied");
    if (
      job.version !== 1 ||
      !/^[\w:.-]{1,200}$/.test(job.operationId) ||
      !job.contextRef ||
      !job.authorityRef ||
      !Number.isInteger(job.budget.wallMs) ||
      job.budget.wallMs < 1 ||
      job.budget.wallMs > 300000 ||
      !Number.isInteger(job.budget.outputBytes) ||
      job.budget.outputBytes < 1 ||
      job.budget.outputBytes > 2 * 1024 * 1024 ||
      job.harnessDigest !== (await sandboxDigest(job.artifact)) ||
      job.dependencyLockDigest !== (await sandboxDigest(job.dependencyLock)) ||
      sandboxCanonical(job.dependencyLock) !==
        sandboxCanonical(sandboxArtifactDependencies(job.artifact))
    )
      throw Error("Compute job pin or budget mismatch");
    const digest = await sandboxDigest(job),
      key = `compute-harness:${this.owner}:job:${(await sandboxDigest(job.operationId)).slice(7)}`;
    const base = {
      operationId: job.operationId,
      jobDigest: digest,
      harnessDigest: job.harnessDigest,
      environmentDigest: job.environmentDigest,
      requests: 0,
      browserStarts: 0 as const,
    };
    let retained = (await this.kv.get(key)) as Retained | undefined;
    if (retained && retained.digest !== digest)
      throw Error("Compute harness operation identity conflict");
    if (retained?.receiptRef)
      return verifySandboxReceipt(
        job,
        (await this.blobs.get(
          this.owner,
          retained.receiptRef,
        )) as SandboxJobReceipt,
      );
    if (!retained) {
      if (Buffer.byteLength(sandboxCanonical(job)) > 64 * 1024 * 1024)
        throw Error("Compute input exceeds byte budget");
      await this.harnessEnvironment(signal);
      const { machine, runner,runtimeArgument } = await this.prepare(signal);
      const path = `/tmp/aiko-job-${digest.slice(7)}`;
      retained = { digest, machine, path };
      if (await this.kv.claim(key, retained)) {
        // Upload can be retried safely, but a crash before dispatch stays unknown.
        // The retained operation identity is never reused to launch a new job.
        await this.upload(
          machine,
          `${path}.input.json`,
          sandboxCanonical(job),
          signal,
        );
        await this.compute.exec(
          `user-${this.owner}`,
          `harness:${digest.slice(7)}`,
          {
            command: `bun ${runner}${runtimeArgument} job ${path}.input.json ${path}.receipt.json`,
          },
          signal,
        );
      } else {
        retained = (await this.kv.get(key)) as Retained;
        if (!retained || retained.digest !== digest)
          throw Error("Compute harness operation identity conflict");
      }
    }
    const commandId = (await import("node:crypto"))
      .createHash("sha256")
      .update(
        JSON.stringify([
          this.owner,
          `user-${this.owner}`,
          `harness:${digest.slice(7)}`,
        ]),
      )
      .digest("hex");
    let terminalObserved = false;
    for (;;) {
      try {
        const manifest = await this.download(
          retained.machine,
          `${retained.path}.receipt.json`,
          job.budget.outputBytes + 16384,
          signal,
        );
        const receipt = await verifySandboxReceipt(job, manifest);
        if (
          !["completed", "failed", "unknown"].includes(receipt.status) ||
          receipt.browserStarts !== 0 ||
          receipt.requests !== 0
        )
          throw Error("Invalid compute receipt status");
        const receiptRef = await this.blobs.putPrivate(this.owner, receipt);
        await this.kv.put(key, { ...retained, receiptRef });
        return receipt;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "codegraff_http_404")
          throw error;
      }
      let status: any;
      try {
        status = await this.compute.poll(
          `user-${this.owner}`,
          commandId,
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        return {
          ...base,
          status: "unknown",
          reason: "compute_dispatch_or_output_unconfirmed",
        };
      }
      if (status.state !== "running" && terminalObserved)
        return {
          ...base,
          status: "unknown",
          reason: "compute_retained_output_unavailable",
        };
      terminalObserved = status.state !== "running";
      await pause(signal);
    }
  }
}

/** The logical environment commits to BOTH physical runtimes. Only this trusted
 * adapter translates physical job/receipt pins; artifact and output pins persist. */
export function dispatchHarnessSandbox(
  standard: HarnessSandboxClient,
  python: HarnessSandboxClient,
  javascriptEnvironmentDigest: SandboxDigest,
): HarnessSandboxClient & Partial<ComputeRuntimeRepair> & { pythonRuntimeLockDigest: SandboxDigest } {
  if (!/^sha256:[a-f0-9]{64}$/.test(javascriptEnvironmentDigest))
    throw Error("Configured JavaScript runtime pin unavailable");
  const environments = async (signal?: AbortSignal) => {
    const js = javascriptEnvironmentDigest,
      py = await python.harnessEnvironment(signal);
    return {
      js,
      py,
      combined: await sandboxDigest({
        version: 1,
        javascript: js,
        python: py,
        pythonLock: python.pythonRuntimeLockDigest,
      }),
    };
  };
  return {
    ...("repairRuntime" in python && typeof python.repairRuntime === "function" ? {
      repairRuntime: (request:ComputeRuntimeRepairRequest,signal:AbortSignal,authorized:()=>Promise<boolean>) => (python as HarnessSandboxClient & ComputeRuntimeRepair).repairRuntime(request,signal,authorized),
    } : {}),
    get pythonRuntimeLockDigest(){ return python.pythonRuntimeLockDigest!; },
    harnessEnvironment: async (signal) => (await environments(signal)).combined,
    harnessJob: async (job, signal) => {
      const pins = await environments(signal);
      if (job.environmentDigest !== pins.combined)
        throw Error("Dispatcher runtime changed");
      const isPython = job.artifact.kind === "python";
      if (!isPython && (await standard.harnessEnvironment(signal)) !== pins.js)
        throw Error("JavaScript runtime pin changed");
      const physical = {
        ...structuredClone(job),
        environmentDigest: isPython ? pins.py : pins.js,
      };
      const receipt = await verifySandboxReceipt(
        physical,
        await (isPython ? python : standard).harnessJob(physical, signal),
      );
      return {
        ...receipt,
        jobDigest: await sandboxDigest(job),
        environmentDigest: pins.combined,
      };
    },
  };
}

/** Privileged setup is a trusted deployment recipe, never a registry artifact. */
export interface TrustedComputeRecipe {
  version:1; id:string;
  native:Record<"python"|"ffmpeg"|"ffprobe"|"bun"|"droppriv",{path:string;sha256:string}>;
  bubblewrap:{url:string;sha256:string;bytes:number};
  requirements:string;
  models?:Record<string,TrustedComputeRecipe["model"]>;
  model:{repository:string;revision:string;files:Record<string,{sha256:string;bytes:number}>};
}
export interface ComputeSetupReport {
  capture?: { files:number; sourceBytes:number; retainedBytes:number; wallMs:number; memoryBefore:Record<string,string>; memoryAfter:Record<string,string> };
  version:1; recipeDigest:SandboxDigest; runnerDigest:SandboxDigest;
  runtimeLockDigest:SandboxDigest;environmentDigest:SandboxDigest;lock:unknown;
  runtime:Record<string,unknown>; cgroupRoot:string; ready:boolean; bunVersion:string; reason?:string;
}
/** Assembly is inert. Setup dispatch is claimed in the existing owner WorkflowKV;
 * a restarted native effect polls the original command/report and never reinstalls. */
export class ProvisionedComputeHarness implements HarnessSandboxClient {
  readonly compute:SandboxCompute;
  private configured?:CodegraffComputeHarness;
  private readonly blobs:ReturnType<typeof harnessBlobStore>;
  constructor(readonly owner:string,readonly gateway:Codegraff,readonly kv:WorkflowKV,readonly runnerBundle:string,readonly recipe:TrustedComputeRecipe){
    this.recipe=structuredClone(recipe);
    if(recipe.version!==1||!/^[-a-z0-9]{1,80}$/.test(recipe.id)||!runnerBundle)throw Error("Trusted runtime recipe unavailable");
    for(const pin of Object.values(recipe.native))if(!/^\/[A-Za-z0-9_./-]+$/.test(pin.path)||pin.path.includes("..")||!/^[a-f0-9]{64}$/.test(pin.sha256))throw Error("Invalid trusted native pin");
    if(!/^https:\/\/(?:security\.debian\.org|deb\.debian\.org)\//.test(recipe.bubblewrap.url)||!/^[a-f0-9]{64}$/.test(recipe.bubblewrap.sha256)||!Number.isSafeInteger(recipe.bubblewrap.bytes)||recipe.bubblewrap.bytes<1||recipe.bubblewrap.bytes>1048576)throw Error("Invalid trusted isolation package");
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(recipe.model.repository)||!/^[a-f0-9]{40}$/.test(recipe.model.revision)||!recipe.requirements.includes("--hash=sha256:"))throw Error("Invalid trusted dependency/model lock");
    for(const [name,pin]of Object.entries(recipe.model.files))if(!/^[A-Za-z0-9_.-]+$/.test(name)||!/^[a-f0-9]{64}$/.test(pin.sha256)||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>134217728)throw Error("Invalid trusted model file");
    for(const [directory,model] of Object.entries(recipe.models??{})){if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(directory)||directory==="."||directory===".."||directory==="whisper-tiny.en"||!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(model.repository)||!/^([a-f0-9]{40})$/.test(model.revision)||Object.keys(model.files).length!==4)throw Error("Invalid trusted additional model");for(const [name,pin] of Object.entries(model.files))if(!/^[A-Za-z0-9_.-]+$/.test(name)||name==="."||name===".."||!/^[a-f0-9]{64}$/.test(pin.sha256)||!Number.isSafeInteger(pin.bytes)||pin.bytes<1||pin.bytes>134217728)throw Error("Invalid trusted model file");}
    const prefix=`compute-harness:${owner}:`;
    this.compute=new SandboxCompute(owner,gateway,{get:async<T>(key:string)=>await kv.get(prefix+key) as T|undefined,put:(key,value)=>kv.put(prefix+key,value),claim:(key,value)=>kv.claim(prefix+key,value)});
    this.blobs=harnessBlobStore(kv);
  }
  get pythonRuntimeLockDigest(){return this.configured?.pythonRuntimeLockDigest;}
  async repairRuntime(request:ComputeRuntimeRepairRequest,signal:AbortSignal,authorized:()=>Promise<boolean>) {
    signal.throwIfAborted();
    if(request.owner!==this.owner || !/^[-A-Za-z0-9:._]{1,159}$/.test(request.operationId) || !request.grant || !Number.isSafeInteger(request.deadline) || request.deadline<=Date.now()) throw Error("Compute repair authority denied");
    if(!await authorized())throw Error("Compute repair authority denied");
    const failure=await this.blobs.get(this.owner,request.failureRef) as any;
    const machine=await this.kv.get(`compute-harness:${this.owner}:codegraff:compute`) as any;
    if(failure.version!==1 || failure.owner!==this.owner || failure.machine!==machine?.id || machine?.owner!==this.owner || failure.runnerDigest!==await sandboxDigest(this.runnerBundle) || !["runtime-missing","runtime-lock-mismatch"].includes(failure.reason)) throw Error("Compute repair evidence denied");
    const requestIdentity=await sandboxDigest([request.owner,request.operationId,request.failureRef,request.grant,request.deadline]);
    const operationKey=`compute-harness:${this.owner}:repair-operation:${request.operationId}`;
    await this.kv.claim(operationKey,requestIdentity);
    if(await this.kv.get(operationKey)!==requestIdentity)throw Error("Compute repair identity conflict");
    const identity=await sandboxDigest([this.owner,failure.machine,failure.runtimeLockDigest,failure.environmentDigest,failure.runtimeConfigDigest,request.grant,await sandboxDigest(this.recipe),await sandboxDigest(this.runnerBundle)]);
    if(!await authorized())throw Error("Compute repair authority denied");
    const claimKey=`compute-harness:${this.owner}:repair:${request.failureRef}`;
    await this.kv.claim(claimKey,identity);
    if(await this.kv.get(claimKey)!==identity)throw Error("Compute repair identity conflict");
    const report=await this.configuration(AbortSignal.any([signal,AbortSignal.timeout(Math.min(300000,request.deadline-Date.now()))]),{identity,machine:machine.id,authorized});
    if(!await authorized())throw Error("Compute repair authority denied");
    // Activation is durable and only follows a verified replacement report.
    await this.kv.put(`compute-harness:${this.owner}:active:${(await sandboxDigest([await sandboxDigest(this.recipe),await sandboxDigest(this.runnerBundle)])).slice(7)}`,identity);
    return {status:"ready" as const,runtimeLockDigest:report.runtimeLockDigest};
  }
  async configuration(signal:AbortSignal,repair?:{identity:SandboxDigest;machine:string;authorized:()=>Promise<boolean>}):Promise<ComputeSetupReport>{
    signal.throwIfAborted();
    const recipeDigest=await sandboxDigest(this.recipe),runnerDigest=await sandboxDigest(this.runnerBundle);
    const base=(await sandboxDigest([recipeDigest,runnerDigest])).slice(7);
    const active=repair?.identity ?? await this.kv.get(`compute-harness:${this.owner}:active:${base}`) as SandboxDigest|undefined;
    const generation=active ? (await sandboxDigest([base,active])).slice(7) : base;
    const key=`compute-harness:${this.owner}:setup:${generation}`;
    type Setup={machine:string;path:string;reportRef?:HarnessDigest;deadline?:number};
    let record=await this.kv.get(key) as Setup|undefined;
    const bounded=(row:Setup)=>{
      if(!repair)return;
      if(!Number.isSafeInteger(row.deadline)||row.deadline!<=Date.now())throw Error("Compute repair setup budget expired");
      signal=AbortSignal.any([signal,AbortSignal.timeout(row.deadline!-Date.now())]);
    };
    if(record)bounded(record);
    const validate=async(report:ComputeSetupReport)=>{
      if(repair && !await repair.authorized())throw Error("Compute repair authority denied");
      if(report.version===1&&report.recipeDigest===recipeDigest&&report.runnerDigest===runnerDigest&&report.ready===false&&typeof report.reason==="string")throw Error("Compute runtime unavailable: "+report.reason);
      const expectedEnvironment=typeof report.bunVersion==="string"?await sandboxDigest({abi:"unlock-compute-runner/1",runnerBundle:this.runnerBundle,runtimeLockDigest:report.runtimeLockDigest,bunVersion:report.bunVersion}):undefined;
      if(report.version!==1||report.ready!==true||report.recipeDigest!==recipeDigest||report.runnerDigest!==runnerDigest||report.runtimeLockDigest!==await sandboxDigest(report.lock)||report.environmentDigest!==expectedEnvironment||typeof report.runtime!=="object"||!report.cgroupRoot?.startsWith("/sys/fs/cgroup/aiko-compute-"))throw Error("Trusted compute setup attestation mismatch");
      this.configured=new CodegraffComputeHarness(this.owner,this.gateway,this.kv,{runnerBundle:this.runnerBundle,runtimeLockDigest:report.runtimeLockDigest,environmentDigest:report.environmentDigest,runtime:report.runtime});
      return report;
    };
    if(record?.reportRef)return validate(await this.blobs.get(this.owner,record.reportRef) as ComputeSetupReport);
    if(!record){
      const retainedMachine=await this.kv.get(`compute-harness:${this.owner}:codegraff:compute`) as any;
      if(repair && (retainedMachine?.owner!==this.owner || retainedMachine?.id!==repair.machine))throw Error("Retained repair machine unavailable; no allocation");
      const machine=repair ? repair.machine : await this.compute.ensureMachine(signal),path=`/tmp/aiko-setup-${generation}`;
      record={machine,path,...(repair?{deadline:Date.now()+300000}:{})};
      bounded(record);
      if(await this.kv.claim(key,record)){
        if(repair && !await repair.authorized())throw Error("Compute repair authority denied");
        for(const [suffix,text]of [[".js",this.runnerBundle],[".recipe.json",JSON.stringify(this.recipe)]])await this.gateway.request(`/v1/sandboxes/${machine}/upload`,{path:path+suffix,contentBase64:Buffer.from(text!).toString("base64")},signal);
        if(repair && !await repair.authorized())throw Error("Compute repair authority denied");
        // Repair cannot fall through ensureMachine's ordinary allocation path,
        // even if machine custody disappears between admission and dispatch.
        const executor=repair ? new SandboxCompute(this.owner,this.gateway,{
          get:async<T>(name:string)=>{
            const value=await this.kv.get(`compute-harness:${this.owner}:${name}`) as any;
            if(name==="codegraff:compute" && (value?.owner!==this.owner || value?.id!==repair.machine))throw Error("Retained repair machine unavailable; no allocation");
            return value as T;
          },
          put:(name,value)=>this.kv.put(`compute-harness:${this.owner}:${name}`,value),
          claim:(name,value)=>{
            if(!name.startsWith("codegraff:compute-job:"))throw Error("Repair cannot allocate or bootstrap a machine");
            return this.kv.claim(`compute-harness:${this.owner}:${name}`,value);
          },
        }) : this.compute;
        await executor.exec(`user-${this.owner}`,`setup:${path.split("-").at(-1)}`,{command:`bun ${path}.js setup ${path}.recipe.json ${path}.report.json`},signal);
      }else {record=await this.kv.get(key) as Setup;bounded(record);}
    }
    const invocation=`setup:${record.path.split("-").at(-1)}`;
    const commandId=(await import("node:crypto")).createHash("sha256").update(JSON.stringify([this.owner,`user-${this.owner}`,invocation])).digest("hex");
    let terminalObserved=false;
    for(;;){
      try{
        const value=await this.gateway.request(`/v1/sandboxes/${record.machine}/download`,{path:`${record.path}.report.json`},signal,undefined,4194304);
        if(typeof value.contentBase64!=="string")throw Error("Setup output unavailable");
        const text=Buffer.from(value.contentBase64,"base64").toString("utf8");
        const decoded=JSON.parse(text);
        if(decoded?.statusCode===404&&decoded?.source==="DAYTONA_DAEMON"&&decoded?.code==="FILE_NOT_FOUND")throw Error("codegraff_http_404");
        const report=await validate(decoded);
        const reportRef=await this.blobs.putPrivate(this.owner,report);await this.kv.put(key,{...record,reportRef});return report;
      }catch(error){if(!(error instanceof Error)||error.message!=="codegraff_http_404")throw error;}
      let status:any;try{status=await this.compute.poll(`user-${this.owner}`,commandId,signal);}catch{throw Error("Compute setup dispatch unknown; retained VM requires reconciliation");}
      if(status.state!=="running"&&terminalObserved)throw Error("Compute setup output unconfirmed; no automatic reinstall");
      terminalObserved=status.state!=="running";
      await pause(signal);
    }
  }
  async harnessEnvironment(signal=AbortSignal.timeout(300000)){await this.configuration(signal);return this.configured!.harnessEnvironment(signal);}
  async harnessJob(job:SandboxJob,signal=AbortSignal.timeout(300000)){await this.configuration(signal);return this.configured!.harnessJob(job,signal);}
}

/** Audited Codegraff Debian 13 amd64 baseline; image drift is a denial, not TOFU.
 * FFmpeg 7:7.1.5-0+deb13u1 binaries independently extracted from Debian's
 * ffmpeg_7.1.5-0+deb13u1_amd64.deb (2,001,944 bytes), package SHA256
 * 8669bc77e55393c14e0dd257ba9a916007cb6da0e1074c9b5e1d53812024f2af.
 * Source: https://packages.debian.org/trixie/amd64/ffmpeg/download
 * This is an explicit recipe revision, not trust-on-first-use or a fallback.
 * Media package/model locks are supplied from the application's checked assets. */
export function trustedCodegraffMediaRecipe(requirements:string,model:TrustedComputeRecipe["model"],multilingual?:TrustedComputeRecipe["model"]):TrustedComputeRecipe{
  return {version:1,id:"codegraff-debian13-amd64-media-v2",requirements,model,...(multilingual?{models:{"whisper-tiny":multilingual}}:{}),
    native:{droppriv:{path:"/usr/bin/setpriv",sha256:"401fa95e8cdd956d66c965fc004156d12ab9ba752c0be3368b0daddbf12a1708"},python:{path:"/usr/bin/python3.13",sha256:"e59d0124ff06c248546876e01fcfb1ea3cda63534949f94a9372bfcfe3bfc3f5"},ffmpeg:{path:"/usr/bin/ffmpeg",sha256:"e8a8d46f5225f3062cec7c07fb145d58ae73c603cb740dcd5bad34bfb54e455a"},ffprobe:{path:"/usr/bin/ffprobe",sha256:"cefc5f81c0b18429cdbf8fa5a89e1e9c759235e10f93f9b329ff1b2fdff26f46"},bun:{path:"/usr/local/share/nvm/versions/node/v25.9.0/lib/node_modules/bun/bin/bun.exe",sha256:"438bc6a718861b70a6a2df3e6f1859cae9b588833ef6c61c201d2e643c03c8a8"}},
    bubblewrap:{url:"https://security.debian.org/debian-security/pool/updates/main/b/bubblewrap/bubblewrap_0.12.0-1~deb13u1_amd64.deb",sha256:"70aca4fa8daeacb677ec00e8063eb586f08ae3d94b1f11e684370b5524c43431",bytes:56876}};
}

/** Mirrors the existing pinned browser bootstrap and sandbox-job ABI without
 * starting the browser VM during Python admission. Dispatch verifies it live. */
export function configuredJavascriptEnvironment(runner:string,bootstrap:string):SandboxDigest{
 const bun=bootstrap.match(/bun-v([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];if(!bun)throw Error("Pinned JavaScript bootstrap unavailable");
 return harnessDigest({runnerDigest:createHash("sha256").update(runner).digest("hex"),bun,quickjs:"0.32.0",abi:"unlock-sandbox-job/1"});
}
