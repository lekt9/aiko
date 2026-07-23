import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";
import { Agent } from "../agent/agent";
import { DISPLAY_NAME } from "../brand";
import { createDaemon } from "../contract/daemon";
import * as contract from "../contract/native";
import { executeNeuronWaves } from "../contract/neurons";
import { createFractalEBM } from "../contract/fractal-ebm";
import { setFractalEBM } from "../contract/hooks";
import { ffiMirrorStatus } from "../contract/native";
import {
  getApiKey,
  getBaseURL,
  getCurrentModel,
  getCurrentSandboxMode,
  getCurrentSandboxSettings,
  getTelegramBotToken,
  loadUserSettings,
  type SandboxMode,
  type SandboxSettings,
  saveApprovedTelegramUserId,
  saveUserSettings,
} from "../utils/settings";
import { createTelegramBridge } from "./bridge";
import { activatePersonaHook, gateReply } from "./contract-reply-gate";
import {
  resolveTelegramHeadlessBridgePaths,
  type TelegramHeadlessBridgePathOptions,
  type TelegramHeadlessBridgePaths,
} from "./headless-bridge-paths";
import { approvePairingCode } from "./pairing";
import { createTurnCoordinator } from "./turn-coordinator";

export interface TelegramHeadlessBridgeOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  sandboxMode?: SandboxMode;
  sandboxSettings?: SandboxSettings;
  maxToolRounds?: number;
  logFile?: string;
  pairCodeFile?: string;
}

interface TelegramHeadlessStartupConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  sandboxMode: SandboxMode;
  sandboxSettings: SandboxSettings;
  maxToolRounds: number;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendLog(logFile: string, message: string): void {
  ensureParentDir(logFile);
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

function truncate(text: string, limit = 160): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;
}

function ensurePairCodeFile(pairCodeFile: string): void {
  ensureParentDir(pairCodeFile);
  if (!fs.existsSync(pairCodeFile)) {
    fs.writeFileSync(pairCodeFile, "", "utf8");
  }
}

function buildTelegramAgentFactory(startupConfig: TelegramHeadlessStartupConfig): (userId: number) => Agent {
  return (userId: number) => {
    // Deliberately do not reuse a mutable Agent/session. Durable continuity is
    // supplied by Contract; each inbound event gets an isolated reasoning worker.
    return new Agent(
      startupConfig.apiKey,
      startupConfig.baseURL,
      startupConfig.model,
      startupConfig.maxToolRounds,
      { sandboxMode: startupConfig.sandboxMode, sandboxSettings: startupConfig.sandboxSettings },
    );
  };
}

async function fetchBotIdentity(token: string, signal?: AbortSignal): Promise<{ username?: string; id: number }> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal });
  const data = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: { username?: string; id: number };
  };
  if (!data.ok || !data.result) {
    throw new Error(data.description || "Telegram getMe failed");
  }
  return data.result;
}

export async function runTelegramHeadlessBridge(options: TelegramHeadlessBridgeOptions = {}): Promise<void> {
  const token = getTelegramBotToken();
  if (!token) {
    throw new Error("Missing Telegram bot token in user settings or TELEGRAM_BOT_TOKEN.");
  }

  const apiKey = options.apiKey ?? getApiKey();
  if (!apiKey) {
    throw new Error(`Missing ${DISPLAY_NAME} API key.`);
  }

  const startupConfig: TelegramHeadlessStartupConfig = {
    apiKey,
    baseURL: options.baseURL ?? getBaseURL(),
    model: options.model ?? getCurrentModel(),
    sandboxMode: options.sandboxMode ?? getCurrentSandboxMode(),
    sandboxSettings: options.sandboxSettings ?? getCurrentSandboxSettings(),
    maxToolRounds: options.maxToolRounds ?? 400,
  };
  const pathOptions: TelegramHeadlessBridgePathOptions = {
    logFile: options.logFile,
    pairCodeFile: options.pairCodeFile,
  };
  const paths: TelegramHeadlessBridgePaths = resolveTelegramHeadlessBridgePaths(process.cwd(), pathOptions);

  ensurePairCodeFile(paths.pairCodeFile);

  // Create the fractal EBM — the energy harness that stacks in a
  // fractal pattern throughout the whole OS. Every channel (telegram,
  // file, bash, web, payment, deploy) trains its own EBM prototype on
  // every fire. The tree IS the routing decision.
  //
  // This singleton is shared between the hook pipeline (which trains
  // it on every hook fire) and the daemon (which uses it to route
  // scheduled claims through the energy landscape).
  const fractalEBM = createFractalEBM();
  setFractalEBM(fractalEBM);

  // Activate the contract-native hook pipeline for Telegram output.
  // This registers the ThinkFeel persona hook into the generalised
  // contract/hooks pipeline, so every outgoing reply flows through
  // declare → gate → transform → mark_satisfied.
  // Each step also trains the fractal EBM.
  activatePersonaHook();

  // Start the contract daemon — the autonomic loop that ticks the
  // scheduler, gates claims through the substrate, auto-executes
  // learned patterns, and queues novel claims for agent deliberation.
  // This is the "spinal reflex" layer alongside the bridge's
  // "conscious thought" (agent-driven Telegram replies).
  // The daemon uses the fractal EBM for routing decisions.
  const contractDaemon = createDaemon({
    owner: "aiko-telegram-daemon",
    cwd: process.cwd(),
    maxItems: 5,
    leaseSeconds: 300,
    autoExecuteThreshold: 0.85,
    fractalEBM,
    log: (msg) => appendLog(paths.logFile, msg),
  });

  const coordinator = createTurnCoordinator(4);
  const getTelegramAgent = buildTelegramAgentFactory(startupConfig);
  const bridge = createTelegramBridge({
    token,
    getApprovedUserIds: () => loadUserSettings().telegram?.approvedUserIds ?? [],
    coordinator,
    getTelegramAgent,
    onInboundMessage: (event) => {
      const authorization = event.authorized ? "approved" : "pending_authorization";
      const plan =
        `Telegram ${event.kind} from user ${event.userId} (${authorization}): ` +
        truncate(event.content, 500);
      const children: contract.ContractGraphChild[] = [
        { key: "identity", plan: `Resolve Telegram identity ${event.userId}` },
        { key: "log", plan: `Record redacted evidence for ${event.turnKey}` },
        { key: "rules", plan: `Match durable notification rules for Telegram user ${event.userId}` },
        {
          key: "respond",
          plan: `Reason about and respond to Telegram event ${event.turnKey}`,
          depends_on: ["identity", "rules", "log"],
          requires_authorization: true,
          authorization,
        },
      ];
      const expansion = contract.expandGraph({
        plan,
        action: "channel-event",
        agent: `telegram:${event.userId}`,
        cwd: process.cwd(),
        children,
      });
      appendLog(
        paths.logFile,
        `inbound_contract user=${event.userId} authorized=${event.authorized} neuron=${expansion?.root_id ?? "unavailable"}`,
      );
      if (expansion) {
        void executeNeuronWaves(expansion, children, { cwd: process.cwd(), maxToolRounds: 100 }).then((grounded) => {
          appendLog(paths.logFile, `inbound_contract_complete root=${expansion.root_id} grounded=${grounded}`);
        });
      }
    },
    onUserMessage: (event) => {
      appendLog(paths.logFile, `user ${event.userId}: ${truncate(event.content)}`);
    },
    onAssistantMessage: (event) => {
      if (event.done) {
        appendLog(paths.logFile, `assistant ${event.userId}: ${truncate(event.content)}`);
      }
    },
    onToolCalls: (event) => {
      const names = event.toolCalls.map((toolCall) => toolCall.function.name).join(", ");
      appendLog(paths.logFile, `tools ${event.userId}: ${names}`);
    },
    onToolResult: (event) => {
      appendLog(paths.logFile, `tool_result ${event.userId}: ${event.toolCall.function.name}`);
    },
    onError: (message) => {
      appendLog(paths.logFile, `bridge_error: ${message}`);
    },
    transformReply: async (userId, text) => {
      const result = await gateReply(userId, text);
      if (result.transformed) {
        appendLog(paths.logFile, `contract_gate ${userId}: transformed reply [neuron=${result.neuronId ?? "none"}]`);
      }
      if (result.voiceFile) {
        appendLog(paths.logFile, `contract_gate ${userId}: voice note attached [${result.voiceFile}]`);
      }
      return { text: result.text, voiceFile: result.voiceFile };
    },
  });

  let lastPairInput = "";
  let pairWatcher: ReturnType<typeof setInterval> | undefined;
  let bridgeStarted = false;
  let stopping = false;
  let resolveShutdown: (() => void) | undefined;
  const shutdownComplete = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  const startupAbortController = new AbortController();

  const stopPairWatcher = () => {
    if (pairWatcher) {
      clearInterval(pairWatcher);
      pairWatcher = undefined;
    }
  };

  const stop = async (signal: string) => {
    if (stopping) {
      return;
    }

    stopping = true;
    startupAbortController.abort();
    stopPairWatcher();
    process.off("SIGINT", onSigInt);
    process.off("SIGTERM", onSigTerm);
    appendLog(paths.logFile, `shutdown: ${signal}`);
    contractDaemon.stop();
    if (bridgeStarted) {
      await bridge.stop().catch((error: unknown) => {
        appendLog(paths.logFile, `shutdown_error: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    resolveShutdown?.();
  };

  const onSigInt = () => {
    void stop("SIGINT");
  };
  const onSigTerm = () => {
    void stop("SIGTERM");
  };

  process.on("SIGINT", onSigInt);
  process.on("SIGTERM", onSigTerm);

  try {
    const bot = await fetchBotIdentity(token, startupAbortController.signal);
    if (stopping) {
      await shutdownComplete;
      return;
    }

    appendLog(paths.logFile, `bot_ready username=@${bot.username ?? "unknown"} id=${bot.id}`);
    appendLog(paths.logFile, `approved_users=${(loadUserSettings().telegram?.approvedUserIds ?? []).length}`);
    const contractStatus = ffiMirrorStatus();
    appendLog(
      paths.logFile,
      contractStatus.loaded
        ? "contract_native=loaded"
        : `contract_native=unavailable reason=${truncate(contractStatus.reason ?? "unknown")}`,
    );
    appendLog(paths.logFile, "telegram_bridge_starting");
    bridge.start();
    bridgeStarted = true;
    appendLog(paths.logFile, "telegram_bridge_started");

    // Start the contract daemon alongside the bridge.
    // The daemon is the autonomic loop — it ticks the scheduler,
    // processes claims through gate → recommend → execute → settle.
    // Learned patterns auto-execute; novel claims queue for agent.
    if (contractStatus.loaded) {
      contractDaemon.start();
      appendLog(paths.logFile, "contract_daemon_started");
    }

    pairWatcher = setInterval(() => {
      try {
        const code = fs.readFileSync(paths.pairCodeFile, "utf8").trim().toUpperCase();
        if (!code || code === lastPairInput) {
          return;
        }

        lastPairInput = code;
        const result = approvePairingCode(code);
        if (result.ok) {
          saveApprovedTelegramUserId(result.userId);
          fs.writeFileSync(paths.pairCodeFile, "", "utf8");
          appendLog(paths.logFile, `pair_approved user=${result.userId} code=${code.slice(0, 2)}****`);
          return;
        }

        appendLog(paths.logFile, `pair_rejected: ${result.error}`);
      } catch (error) {
        appendLog(paths.logFile, `pair_watcher_error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, 1000);

    await shutdownComplete;
  } catch (error) {
    if (!stopping) {
      stopPairWatcher();
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      if (bridgeStarted) {
        await bridge.stop().catch((stopError: unknown) => {
          appendLog(
            paths.logFile,
            `shutdown_error: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
          );
        });
      }
      throw error;
    }

    await shutdownComplete;
  }
}
