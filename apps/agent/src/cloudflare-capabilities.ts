import computeRunnerBundle from "../assets/compute-runner.txt";
import mediaRequirements from "../assets/media-requirements.lock" with {type:"text"};
import multilingualModelLock from "../assets/media-multilingual-model.lock.json";
import mediaModelLock from "../assets/media-model.lock.json";
import {CodegraffComputeHarness,ProvisionedComputeHarness,trustedCodegraffMediaRecipe,configuredJavascriptEnvironment,dispatchHarnessSandbox,type ComputeHarnessHostConfig} from "./compute-harness.ts";
import type {WorkflowKV} from "./workflow-host.ts";
import runnerBundle from "../assets/runner.txt";
import bootstrap from "../assets/bootstrap.sh";
import mediaScript from "../assets/media.py";
import { BrowserController } from "./browser.ts";
import { Codegraff, CodegraffSandbox, searchTool, type SandboxStore } from "./codegraff.ts";
import type { MemoryBinding } from "./memory.ts";
import { withUnlockBrowser } from "./browser-unlock-factory.ts";
import { SandboxCompute, sandboxComputeTools, sandboxComputeCancellation, type ComputeStore } from "./sandbox-compute.ts";

export function createCloudflareCapabilities(options: {
  owner: string;
  computeHarness?: {config?:ComputeHarnessHostConfig;kv:WorkflowKV};
  env: { CODEGRAFF_API_KEY: string };
  storage: ComputeStore;
  memory: MemoryBinding;
  unlock?: Parameters<typeof withUnlockBrowser>[1];
  onApprovalsChanged?: (owner:string,count:number)=>Promise<void>;
  emit: (event: Record<string, unknown>) => Promise<void>;
  tts?: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
}) {
  const gateway = new Codegraff(options.env.CODEGRAFF_API_KEY);
  const compute = new SandboxCompute(options.owner, gateway, options.storage);
  const sandbox = new CodegraffSandbox({ owner: options.owner, gateway, store: options.storage, emit: options.emit, runnerBundle, bootstrap, mediaScript, tts: options.tts });
  const harnessSandbox = options.computeHarness ? dispatchHarnessSandbox(sandbox,options.computeHarness.config?new CodegraffComputeHarness(options.owner,gateway,options.computeHarness.kv,options.computeHarness.config):new ProvisionedComputeHarness(options.owner,gateway,options.computeHarness.kv,computeRunnerBundle,trustedCodegraffMediaRecipe(mediaRequirements,mediaModelLock.model,multilingualModelLock.model)),options.computeHarness.config?.javascriptEnvironmentDigest??configuredJavascriptEnvironment(runnerBundle,bootstrap)) : sandbox;
  const factory = options.unlock ? withUnlockBrowser(sandbox.browserFactory(),options.unlock) : sandbox.browserFactory();
  const browser = new BrowserController({ domains: ["*"], factory, redact: options.memory.redact, requireInteractionApproval: false, onApprovalsChanged:options.onApprovalsChanged, durableProfile: true, allowModelAnswers: true });
  return { browser, sandbox, harnessSandbox, compute, computeToolsFor: (memory: MemoryBinding) => sandboxComputeTools(compute, memory), computeCancellationFor: (thread: string) => sandboxComputeCancellation(compute, thread), search: searchTool(options.memory, gateway), searchFor: (memory: MemoryBinding) => searchTool(memory,gateway) };
}
