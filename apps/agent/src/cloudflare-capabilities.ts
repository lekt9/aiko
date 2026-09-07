import runnerBundle from "../assets/runner.txt";
import bootstrap from "../assets/bootstrap.sh";
import mediaScript from "../assets/media.py";
import { BrowserController } from "./browser.ts";
import { Codegraff, CodegraffSandbox, searchTool, type SandboxStore } from "./codegraff.ts";
import type { MemoryBinding } from "./memory.ts";
import { withUnlockBrowser } from "./browser-unlock-factory.ts";

export function createCloudflareCapabilities(options: {
  owner: string;
  env: { CODEGRAFF_API_KEY: string };
  storage: SandboxStore;
  memory: MemoryBinding;
  unlock?: Parameters<typeof withUnlockBrowser>[1];
  onApprovalsChanged?: (owner:string,count:number)=>Promise<void>;
  emit: (event: Record<string, unknown>) => Promise<void>;
  tts?: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
}) {
  const gateway = new Codegraff(options.env.CODEGRAFF_API_KEY);
  const sandbox = new CodegraffSandbox({ owner: options.owner, gateway, store: options.storage, emit: options.emit, runnerBundle, bootstrap, mediaScript, tts: options.tts });
  const factory = options.unlock ? withUnlockBrowser(sandbox.browserFactory(),options.unlock) : sandbox.browserFactory();
  const browser = new BrowserController({ domains: ["*"], factory, redact: options.memory.redact, requireInteractionApproval: false, onApprovalsChanged:options.onApprovalsChanged, durableProfile: true, allowModelAnswers: true });
  return { browser, sandbox, search: searchTool(options.memory, gateway), searchFor: (memory: MemoryBinding) => searchTool(memory,gateway) };
}
