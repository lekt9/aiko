import { harnessDigest, validateHarnessArtifact, type HarnessArtifact, type HarnessContext, type HarnessContract, type HarnessJson, type HarnessLibraryBinding } from "./harness-library.ts";
import { validateSiteHarnessArtifact } from "@unbrowse/browser-harness/harness-artifact";
import { sandboxArtifactDependencies, sandboxDigest, verifySandboxReceipt, type SandboxArtifact, type SandboxDigest, type SandboxJob, type SandboxJobReceipt } from "./sandbox-job.ts";
import type { SandboxDispatchChallenge } from "./sandbox-dispatch.ts";

/** CodegraffSandbox implements this interface; the local adapter below uses the same runner. */
export interface HarnessSandboxClient {
  readonly pythonRuntimeLockDigest?: SandboxDigest;
  harnessEnvironment(signal?: AbortSignal): Promise<SandboxDigest>;
  harnessJob(job: SandboxJob, signal?: AbortSignal): Promise<SandboxJobReceipt>;
  harnessGuardedJob?(job: SandboxJob, authorize: (challenge: SandboxDispatchChallenge) => boolean | Promise<boolean>, signal?: AbortSignal): Promise<SandboxJobReceipt>;
  harnessReceipt?(job: SandboxJob, signal?: AbortSignal): Promise<SandboxJobReceipt>;
}
/** Resolved by trusted host code from current authority, never from candidate source/origins.
 * Revisions and references are public metadata. Do not place credentials in this object. */
export interface HarnessSandboxAuthority {
  owner: string;
  active: boolean;
  runtimeDigest: SandboxDigest;
  contextRef: string;
  authorityRef: string;
  sessionRevision: string | null;
  pythonRuntimeLockDigest?: SandboxDigest;
  effects: HarnessContract["effect"][];
  origins: string[];
  methods: string[];
  budget: SandboxJob["budget"];
}
export interface HarnessSandboxOptions {
  owner: string;
  thread: string;
  placement: HarnessContext["placement"];
  sandbox: HarnessSandboxClient;
  current(signal: AbortSignal): Promise<HarnessSandboxAuthority>;
  /** Trusted owner-scoped hydration; candidate input contains references, never host paths. */
  assets?: (input: Parameters<HarnessLibraryBinding["execute"]>[0], signal: AbortSignal) => Promise<NonNullable<SandboxJob["assets"]>>;
}
const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/** One file: async function BODY, `input` is the original JSON value.
 * Multiple files: .js/.mjs ESM, entry exports default(input). Every non-entry
 * module must be declared in dependencies with harnessDigest(source). Imports
 * resolve only supplied exact paths (or ./ paths); no package installation.
 * Python: .py modules, entry exports run(input); input is an object and
 * input._files contains only host-hydrated, read-only asset paths.
 * Network entry: JSON {graph: SiteHarnessArtifact, actionId: string}; returns
 * the terminal response body, with runtime trace retained in the sandbox receipt.
 */
async function executable(artifact: HarnessArtifact, contract: HarnessContract, authority: HarnessSandboxAuthority): Promise<SandboxArtifact> {
  if (artifact.runtime === "python") {
    if (!authority.pythonRuntimeLockDigest) throw Error("Python unavailable: isolated runtime not configured");
    if (contract.applicability.runtimeLockDigest !== undefined && contract.applicability.runtimeLockDigest !== authority.pythonRuntimeLockDigest) throw Error("Python contract runtime lock mismatch");
    if (contract.effect !== "read" || !authority.effects.includes("read") || authority.origins.length || authority.methods.length || authority.budget.requests !== 0) throw Error("Python authority must be pure and network-free");
    const files=Object.entries(artifact.files), dependencies=new Map(artifact.dependencies.map(d=>[d.name,d.digest]));
    if (files.some(([name])=>!name.endsWith(".py")) || dependencies.size!==files.length-1 || files.some(([name,source])=>name!==artifact.entrypoint && dependencies.get(name)!==harnessDigest(source))) throw Error("Python dependency source pin mismatch");
    const modules:Extract<SandboxArtifact,{kind:"python"}>["modules"]={};
    for(const [name,source] of files)modules[name]={source,digest:await sandboxDigest(source)};
    return {kind:"python",entry:artifact.entrypoint,modules,runtimeLockDigest:authority.pythonRuntimeLockDigest};
  }
  if (!authority.effects.includes(contract.effect)) throw Error("Contract effect outside current authority");
  if (artifact.runtime === "network") {
    if (artifact.dependencies.length || Object.keys(artifact.files).length !== 1) throw Error("Network dependencies unavailable");
    const parsed = JSON.parse(artifact.files[artifact.entrypoint]!);
    const graph = validateSiteHarnessArtifact(parsed.graph);
    const action = graph.actions.find(a => a.id === parsed.actionId);
    if (!action || graph.allowedOrigins.some(origin => !authority.origins.includes(origin))) throw Error("Network origin or action outside authority");
    if (action.steps.some(step => !authority.methods.includes(step.method) || contract.effect === "read" && !readMethods.has(step.method))) throw Error("Network method violates contract effect or authority");
    return {kind:"network",graph,actionId:action.id};
  }
  if (contract.effect !== "read") throw Error("Pure JavaScript sandbox cannot implement a write effect");
  const files = Object.entries(artifact.files);
  if (files.some(([name])=>! /\.(?:m?js)$/.test(name))) throw Error("Only JavaScript source files are supported");
  if (files.length === 1) {
    if (artifact.dependencies.length) throw Error("Unresolved JavaScript dependency");
    return {kind:"code",code:`return await (async (input) => {\n${artifact.files[artifact.entrypoint]}\n})(input.value);`};
  }
  const dependencies = new Map(artifact.dependencies.map(d=>[d.name,d.digest]));
  if (dependencies.size !== files.length-1 || files.some(([name,source])=>name !== artifact.entrypoint && dependencies.get(name) !== harnessDigest(source))) throw Error("Library dependency source pin mismatch");
  const shim = "__unlock_input_adapter__.js";
  if (Object.hasOwn(artifact.files,shim)) throw Error("Reserved sandbox module name");
  const modules: Extract<SandboxArtifact,{kind:"library"}>["modules"] = {};
  for (const [name,source] of [...files,[shim,`import run from ${JSON.stringify(artifact.entrypoint)}; export default envelope => run(envelope.value);`]])
    modules[name!] = {source:source!,digest:await sandboxDigest(source)};
  return {kind:"library",entry:shim,modules};
}

/** Spread this into HarnessLibraryBinding. execute repeats admission because a
 * previous authorize result cannot survive revocation or a session/runtime change. */
export function createHarnessSandboxBinding(options: HarnessSandboxOptions): Pick<HarnessLibraryBinding,"context"|"authorize"|"execute"|"reconcile"> {
  const current = async (signal:AbortSignal) => {
    signal.throwIfAborted();
    const authority = structuredClone(await options.current(signal));
    if (!authority.active || authority.owner !== options.owner || !authority.contextRef || !authority.authorityRef ||
        !(authority.sessionRevision === null || typeof authority.sessionRevision === "string" && authority.sessionRevision.length > 0)) throw Error("Current sandbox owner/session authority unavailable");
    const runtimeDigest = await options.sandbox.harnessEnvironment(signal);
    signal.throwIfAborted();
    if (runtimeDigest !== authority.runtimeDigest) throw Error("Current sandbox runtime changed");
    const context: HarnessContext = {placement:options.placement,runtimeDigest,bindings:{owner:authority.owner,contextRef:authority.contextRef,authorityRef:authority.authorityRef,sessionRevision:authority.sessionRevision,scopeDigest:harnessDigest({pythonRuntimeLockDigest:authority.pythonRuntimeLockDigest ?? null,effects:authority.effects,origins:authority.origins,methods:authority.methods,budget:authority.budget})}};
    return {authority,context};
  };
  const admit = async (artifactValue:HarnessArtifact,contract:HarnessContract,context:HarnessContext,signal:AbortSignal) => {
    const artifact = validateHarnessArtifact(artifactValue);
    if (artifact.contractDigest !== harnessDigest(contract)) throw Error("Sandbox contract pin mismatch");
    const selected = await current(signal);
    if(harnessDigest(selected.context) !== harnessDigest(context)) throw Error("Sandbox context/session changed");
    const program = await executable(artifact,contract,selected.authority);
    return {...selected,program};
  };
  const perform = async (input: Parameters<HarnessLibraryBinding["execute"]>[0], signal: AbortSignal, receiptOnly = false): ReturnType<HarnessLibraryBinding["execute"]> => {
      // Keep mutable caller objects from changing after digest validation.
      input = structuredClone(input);
      if(input.owner !== options.owner || input.artifactDigest !== harnessDigest(input.artifact)) throw Error("Sandbox artifact owner/pin mismatch");
      const {authority,program} = await admit(input.artifact,input.contract,input.context,signal);
      const dependencyLock = sandboxArtifactDependencies(program);
      if ((program.kind === "network" || program.kind === "python") && (!input.input || typeof input.input !== "object" || Array.isArray(input.input))) throw Error("Network/Python input must be an object");
      const job:SandboxJob = {version:1,owner:options.owner,operationId:`harness:${harnessDigest([options.thread,input.operationId]).slice(7)}`,contextRef:harnessDigest([input.context,input.artifactDigest,harnessDigest(input.contract)]),authorityRef:authority.authorityRef,
        artifact:program,harnessDigest:await sandboxDigest(program),dependencyLock,dependencyLockDigest:await sandboxDigest(dependencyLock),environmentDigest:input.context.runtimeDigest,
        input:program.kind === "network" || program.kind === "python" ? input.input as Record<string,unknown> : {value:input.input},
        ...(program.kind === "python" && options.assets ? {assets:await options.assets(input,signal)} : {}),
        authority:{origins:authority.origins,methods:input.contract.effect === "read" ? authority.methods.filter(m=>readMethods.has(m)) : authority.methods},
        budget:{...authority.budget,outputBytes:Math.min(authority.budget.outputBytes,program.kind === "python" ? 2 * 1024 * 1024 : 262144),wallMs:Math.min(input.contract.timeoutMs,authority.budget.wallMs,program.kind === "python" ? 300000 : 30000)}};
      // Admission above is host-owned; candidates cannot grant themselves origin access.
      const latest = await current(signal);
      if (harnessDigest(latest.context) !== harnessDigest(input.context)) throw Error("Sandbox context/session changed before dispatch");
      signal.throwIfAborted();
      if (receiptOnly && !options.sandbox.harnessReceipt) return { status: "unknown", evidence: ["sandbox-receipt-reader-unavailable"] };
      const receipt = await verifySandboxReceipt(job, receiptOnly ? await options.sandbox.harnessReceipt!(job,signal) : await options.sandbox.harnessJob(job,signal));
      const pureCode = program.kind === "code" || program.kind === "library";
      const measurements = receiptOnly ? { networkRequests: 0, browserStarts: 0, modelCalls: 0, tokens: 0 }
        : {networkRequests:receipt.requests,browserStarts:receipt.browserStarts,modelCalls:pureCode ? 0 : null,tokens:pureCode ? 0 : null};
      // The operation links to the sealed sandbox receipt. Job and output hashes
      // include private values and stay in its private journal: small domains are
      // dictionary-recoverable even when the underlying payload is encrypted.
      const evidence = [`sandbox-operation:${receipt.operationId}`,`sandbox-artifact:${receipt.harnessDigest}`,`sandbox-environment:${receipt.environmentDigest}`,
        ...(receipt.builtDigest ? [`sandbox-build:${receipt.builtDigest}`] : [])];
      const settledContext = await current(signal);
      if (harnessDigest(settledContext.context) !== harnessDigest(input.context)) return {status:"unknown",evidence:[...evidence,"sandbox-context-changed-after-dispatch"],measurements};
      if(receipt.status !== "completed") return {status:receipt.status === "unknown" ? "unknown" : "failed",evidence,measurements};
      const output = program.kind === "network" ? (receipt.output as {terminal:HarnessJson}).terminal : receipt.output as HarnessJson;
      return {status:"succeeded",output,evidence,measurements};
    };
  return {
    context: async signal => (await current(signal)).context,
    authorize: async (artifact,contract,context,_input,signal) => {
      try { await admit(artifact,contract,context,signal); return true; } catch {return false;}
    },
    execute: (input, signal) => perform(input, signal),
    reconcile: (input, signal) => perform(input, signal, true),
  };
}
