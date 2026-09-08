import { createSecretaryWorkBinding, secretaryWorkApi, secretaryWorkView } from "./secretary-work.ts";
import { armAt } from "tardie/cloudflare/alarm";
import { workAppendAllowed, workEventKey, workExternalEventAllowed } from "./commitments.ts";
import codingRunnerBundle from "../assets/coding-runner.txt";
import { codingWorkspaceTools, codingWorkspaceInference, codingWorkspaceEventKey, parseCodingRepositories } from "./coding-workspace.ts";
import { CodegraffCodingWorkspace } from "./coding-workspace-host.ts";
import { createDatabaseBinding } from "./database-host.ts";
import { databaseInference } from "./database.ts";
import { databaseEventKey, databaseExternalEventAllowed } from "./database-component.ts";
import { databaseApi } from "./database-api.ts";
import { reauthorizeReplyResult } from "./database-artifacts.ts";
import { parseDatabaseWriteOwners } from "./config.ts";
import { ProjectContext, type ProjectContextOptions } from "./project-instructions.ts";
import { GeneralMcp, type McpBinding } from "./general-mcp.ts";
import { configuredMcpBinding, parseMcpServers } from "./general-mcp-config.ts";
import { createObservedNetworkTools, resolveObservedRead } from "./observed-network.ts";
import { publicWebTool } from "./public-web.ts";
import { telegramWebhookResponse } from "./telegram-webhook.ts";
import { channelLogSourceEventKey, channelLogSourceAppendAllowed, type ChannelLogSourcePolicy } from "./channel-log-source.ts";
import { proactiveAppendAllowed } from "./proactive-policy.ts";
import { providerAdapterRouteOwner, type ProviderAdapterPolicies } from "./provider-adapter.ts";
import { Infer } from "tardie";
import { registryModelBudget } from "./registry-model-budget.ts";
import { registryTrialActor, registryOptimizationHostOptions, registryExperimentApi } from "./registry-optimization.ts";
import { harnessExperimentTrialLifecycle, harnessExperimentTrialIsChild, harnessExperimentTrialEventKey } from "./harness-experiment-trials.ts";
import { registryManagementContinuations, type RegistryManagementPolicy } from "./registry-management.ts";
import { mediaHostEventKey,mediaIngressApi,telegramMediaAdmission } from "./media-host.ts";
import { mediaProcessingEventKey,mediaProcessingAppendAllowed } from "./media-processing.ts";
import { codeResultCustody } from "./code-result-custody.ts";
import { harnessBlobStore } from "./harness-library.ts";
import type {ComputeHarnessHostConfig} from "./compute-harness.ts";
import {defaultRegistryBinding, type RegistrySandboxTransport} from "./registry-defaults.ts";
import {harnessDigest} from "./harness-library.ts";
import {createChannelPublicIngress,channelBridgeEventKey,channelBridgeAppendAllowed} from "./channel-ingress.ts";
import {providerBridgeApi,providerBridgeReadiness,type ProviderIngressLookup,type ProviderBridgeFactory} from "./provider-bridge-host.ts";
import {checkedRegistryBinding,registryReadiness,registrySandboxEventKey,hostedChannelDeadlineKey,hostedRegistryNextWake,registryExternalEventAllowed,type RegistryHostFactory} from "./registry-host.ts";
import {channelHarnessHandlers} from "./channel-host.ts";
import {channelWiringEventKey,channelWiringAppendAllowed} from "./channel-wiring.ts";
import {harnessLibraryEventKey,harnessLibraryAppendAllowed} from "./harness-library.ts";
import {sourceAwareHarnessBinding} from "./harness-sources.ts";
import {loginObservationEvent,type NativeLoginObservation} from "./native-login-observation.ts";
import {connectorLoginEventKey} from "./connector-login.ts";
import {hostedLoginOperation,guardLoginOperationInput,loginOperationApi,loginRuntimeEvent} from "./login-operation-host.ts";
import {loginOperationEventKey,loginOperationNextWake,loginOperationWakeEvent,loginOperationExternalEventAllowed} from "./login-operation.ts";
import { createHostedChannels, channelApi, type ChannelAdapterBindings, type HostedChannels } from "./channel-host.ts";
import { channelEventKey, channelAppendAllowed } from "./channel-bindings.ts";
import { parseManagerProviders } from "./password-manager-mcp.ts";
import { approvalMenu } from "./telegram-mini-app.ts";
import { agentKeys } from "tardie/log/events";
import {
  cancellationKeys,
  methodCallKeys,
  methodResponseKeys,
  methodTimeoutKeys,
  methodIngressKeyOf,
} from "tardie/core/method";
import { turnEpochOf, turnTerminalOf } from "tardie/code/execution/turns";
import { validateActor } from "tardie/core/actor";
import { withRequiredResponse } from "./channel-response.ts";
import { parseFallbackVerbosity } from "./fallback-verbosity.ts";
import { nativeBrowserConnector } from "./native-browser-connector.ts";
import { browserOperation } from "./connectors-browser.ts";
import {
  acceptSecretary,
  createSecretaryActor,
  secretaryApi,
  secretaryCommand,
  secretaryEventKey,
  withSecretaryHistory,
} from "./secretary.ts";
import { secretaryTelegram } from "./secretary-telegram.ts";
import { createModelRouting, parseModelRouting } from "./model-routing.ts";
import { withRoleInference } from "./inference-routing.ts";
import { connectorVault, parseConnectorVault } from "./connector-vault.ts";
import { createToolRouterActor, routerEventKey } from "./tool-router.ts";
import { routerCaller, validateRouterInput } from "./connector-router-host.ts";
import {
  WorkflowController,
  createWorkflowStore,
  workflowDispatcher,
} from "./workflow-host.ts";
import { ConnectorEngine } from "./connectors.ts";
import { createCartesiaTts } from "./cartesia-tts.ts";
import { createOpsLogger, type OpsLogger } from "./ops.ts";

const workerOps = createOpsLogger((text) => text);
import { FilePasswordManagerHost } from "./password-managers.ts";
import { connectorApi } from "./connector-api.ts";
import { DurableObject } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { Memory, cloudflareStorage } from "entity-learn/cloudflare";
import { browserTraceKeys } from "@unbrowse/browser-harness/trace";
import { harKeys } from "@unbrowse/browser-harness/network-facts";
import { infer as modelInference } from "tardie/model";
import { modelAdapters } from "tardie/model/adapter";
import { openAICompatibleAdapter } from "tardie/model/openai";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { cancellationRequested } from "tardie/core/method/cancellation";
import type { Event } from "tardie/core/log/event";
import {
  createCloudflareAccountHost,
  type CloudflareAccountHost,
} from "./cloudflare-host.ts";
import {
  createAikoActor,
  demoInference,
  event,
  type AikoEvent,
} from "./actor.ts";
import {
  createIndexerActor,
  createReflectionActor,
  backgroundEventKey,
} from "./background.ts";
import { threadBinding, backgroundThread } from "./account-binding.ts";
import {
  memoryScope,
  memoryTools,
  openMemory,
  type MemoryBinding,
} from "./memory.ts";
import { Effect, Layer } from "effect";
import { CodeHarness } from "./code-harness.ts";
import { createCodeChildActor, workerGrantOf, workerCancellations, workerEventKey, workerInference, type WorkerBinding } from "./code-agents.ts";
import { createCloudflareCapabilities } from "./cloudflare-capabilities.ts";
import { createVoice, createThinkFeelComposer } from "./voice.ts";
import {
  createTelegram,
  redactTelegramInbound,
  serializeTelegramInbound,
  type TelegramInbound,
} from "./telegram.ts";
import { readReactionFor } from "./telegram-reactions.ts";
import {
  createTelegramTools,
  createTelegramTyping,
  createTelegramVision,
  telegramEventKey,
} from "./telegram-tools.ts";
import {
  controlCommand,
  telegramControl,
  createControlActor,
} from "./telegram-control.ts";
import { credentialDigest, parsePlaneCredentials } from "./plane-auth.ts";
import {
  boundedText,
  equalSecret,
  redactor,
  safeUserId,
  verifyInitData,
  createMiniAppSession,
  verifyMiniAppSession,
} from "./security.ts";
import { withSpokenHistory } from "./inference.ts";
import { controlApi } from "./control-api.ts";
import { requestMemoryEventKey } from "./request-memory-events.ts";
import { observedActionEventKey } from "./observed-network.ts";
import { ensureUnlockSession } from "./unlock-session.ts";
import { createActionApprovals } from "./action-approval.ts";
import { EventLog, withWatermark } from "tardie/core/log";
import { planeManifest, planeMemoryRead } from "./plane.ts";
import { validateLearningInput } from "./learning.ts";
import { learningFromBrowserTrace } from "./unbrowse-learning.ts";
import { CONTROL_HTML } from "./control.ts";
import {
  automationNextWake,
  automationEventKey,
  automationView,
  automationWakeEvent,
  automationAppendAllowed,
} from "./automations.ts";
import {
  promiseEventKey,
  promiseNextWake,
  promiseWakeEvent,
} from "./promises.ts";
import { CONSOLE_HTML } from "./console.ts";
import type { AikoConfig } from "./config.ts";
import { CloudBackups } from "./cloud-backup.ts";
import { backupApi, type AccountBackup } from "./backup-api.ts";
import {
  parseManagerKey,
} from "./password-managers.ts";

export interface AikoCloudflareEnv {
  AIKO_REGISTRY_FACTORY?: RegistryHostFactory;
  /** Trusted transport edges; defaults still own registry policy and assembly. */
  AIKO_REGISTRY_SANDBOX?: (owner: string, kv: import("./workflow-host.ts").WorkflowKV) => RegistrySandboxTransport | undefined;
  AIKO_MODEL_EFFORTS?: string;
  AIKO_MODEL_CAPABILITIES?: string;
  AIKO_CODING_REPOSITORIES?: string;
  AIKO_MCP?: (owner:string,thread:string)=>McpBinding|undefined;
  AIKO_MCP_SERVERS?: string;
  AIKO_PROJECT_CONTEXT?: (owner:string,thread:string)=>ProjectContextOptions|undefined;
  AIKO_WORKER_TOOLS?: (owner:string,thread:string)=>import("tardie/component/tool").NativeTool<import("tardie/core/runtime").Self|EventLog>[];
  AIKO_MODEL_FETCH?: Parameters<typeof createModelRouting>[0]["fetch"];
  AIKO_REGISTRY_MANAGEMENT?: (owner:string)=>RegistryManagementPolicy|undefined;
  AIKO_COMPUTE_HARNESS?: ComputeHarnessHostConfig;
  AIKO_CHANNEL_INGRESS?: ProviderIngressLookup;
  AIKO_CHANNEL_BRIDGE?: ProviderBridgeFactory;
  /** In-process trusted application capability factory, NOT a Wrangler JSON/secret variable.
   * Without it, channel mutations fail closed. Root may bind the verified harness registry. */
  AIKO_PROVIDER_ADAPTERS?: ProviderAdapterPolicies;
  AIKO_LOG_SOURCES?: ChannelLogSourcePolicy;
  AIKO_CHANNEL_ADAPTERS?: { forOwner(owner: string): ChannelAdapterBindings | undefined };
  AIKO_BACKUPS?: R2Bucket;
  AIKO_BACKUP_KEY?: string;
  CONNECTOR_ASSETS?: Fetcher;
  AIKO_ACCOUNTS: DurableObjectNamespace<AikoAccountDO>;
  AIKO_REGISTRY: DurableObjectNamespace<AikoRegistryDO>;
  AIKO_MODE?: "demo" | "live";
  AIKO_INSTANCE_ID?: string;
  AIKO_OPERATOR_TOKEN: string;
  AIKO_PLANE_CREDENTIALS?: string;
  CODEGRAFF_API_KEY?: string;
  CEREBRAS_API_KEY?: string;
  AIKO_RAG_PROVIDER?: string;
  AIKO_RAG_MODEL?: string;
  AIKO_BROWSER_PROVIDER?: string;
  AIKO_BROWSER_MODEL?: string;
  AIKO_CONVERSATION_PROVIDER?: string;
  AIKO_CONVERSATION_MODEL?: string;
  AIKO_CONVERSATION_FALLBACKS?: string;
  AIKO_RAG_FALLBACKS?: string;
  AIKO_BROWSER_FALLBACKS?: string;
  ARCADE_API_KEY?: string;
  AIKO_CARTESIA_KEY?: string;
  AIKO_CARTESIA_VOICE_ID?: string;
  AIKO_CARTESIA_MODEL?: string;
  AIKO_CODE_MODE?: string;
  AIKO_DATABASES?: string;
  AIKO_DATABASE_WRITE_OWNERS?: string;
  AIKO_CONNECTOR_VAULT_JSON?: string;
  AIKO_MANAGER_KEY?: string;
  AIKO_MANAGER_PROVIDERS_JSON?: string;
  AIKO_MODEL?: string;
  AIKO_VISION_MODEL?: string;
  AIKO_VISION_PROVIDER?: "codegraff" | "cerebras";
  AIKO_BOT_TOKEN?: string;
  AIKO_WEBHOOK_SECRET?: string;
  AIKO_ALLOWED_USERS?: string;
  AIKO_TELEGRAM_PUBLIC?: string;
  AIKO_VOICE_ENABLED?: string;
  AIKO_VOICE_KEY?: string;
  AIKO_PERSONA?: string;
  AIKO_MAX_ACCOUNTS?: string;
  AIKO_THINKFEEL_SENDS?: string;
  AIKO_REPLY_STYLE?: string;
  AIKO_VERBOSE_FALLBACKS?: string;
  AIKO_VERBOSE_FALLBACKS_SINCE?: string;
}
type Principal = {
  owner: string;
  scopes: readonly string[];
  operator: boolean;
};
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
function configOf(env: AikoCloudflareEnv, requireModel = true): AikoConfig {
  const mode = env.AIKO_MODE ?? "live";
  if (mode !== "demo" && mode !== "live")
    throw new Error("Invalid deployment mode");
  const replyStyle = env.AIKO_REPLY_STYLE ?? "thinkfeel";
  if (replyStyle !== "thinkfeel" && replyStyle !== "direct")
    throw new Error("Invalid reply style");
  const instanceId = env.AIKO_INSTANCE_ID ?? "demo";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId))
    throw new Error("Invalid actor instance");
  if (!env.AIKO_OPERATOR_TOKEN || env.AIKO_OPERATOR_TOKEN.length < 24)
    throw new Error("Operator authentication is not configured");
  if (requireModel && mode === "live" && !env.CODEGRAFF_API_KEY)
    throw new Error("Codegraff is not configured");
  if (!!env.AIKO_BOT_TOKEN !== !!env.AIKO_WEBHOOK_SECRET)
    throw new Error("Telegram credentials are incomplete");
  const maxAccounts =
    env.AIKO_MAX_ACCOUNTS === undefined
      ? undefined
      : Number(env.AIKO_MAX_ACCOUNTS);
  if (
    maxAccounts !== undefined &&
    (!Number.isSafeInteger(maxAccounts) || maxAccounts < 1)
  )
    throw new Error("Invalid account capacity");
  const allowedUsers = new Set(
    (env.AIKO_ALLOWED_USERS ?? "").split(/[\s,]+/).filter(Boolean),
  );
  if ([...allowedUsers].some((owner) => !safeUserId(owner)))
    throw new Error("Invalid account allowlist");
  return {
    mode,
    instanceId,
    model: env.AIKO_MODEL ?? "glm-5.3-flash",
    modelKey: env.CODEGRAFF_API_KEY,
    cerebrasKey: env.CEREBRAS_API_KEY,
    modelEfforts: env.AIKO_MODEL_EFFORTS,
    modelCapabilities: env.AIKO_MODEL_CAPABILITIES,
    codingRepositories: parseCodingRepositories(env.AIKO_CODING_REPOSITORIES),
    mcpServers: parseMcpServers(env.AIKO_MCP_SERVERS),
    modelRouting: parseModelRouting(
      {
        AIKO_MODEL: env.AIKO_MODEL,
        AIKO_RAG_PROVIDER: env.AIKO_RAG_PROVIDER,
        AIKO_RAG_MODEL: env.AIKO_RAG_MODEL,
        AIKO_BROWSER_PROVIDER: env.AIKO_BROWSER_PROVIDER,
        AIKO_BROWSER_MODEL: env.AIKO_BROWSER_MODEL,
        AIKO_CONVERSATION_PROVIDER: env.AIKO_CONVERSATION_PROVIDER,
        AIKO_CONVERSATION_MODEL: env.AIKO_CONVERSATION_MODEL,
        AIKO_CONVERSATION_FALLBACKS: env.AIKO_CONVERSATION_FALLBACKS,
        AIKO_RAG_FALLBACKS: env.AIKO_RAG_FALLBACKS,
        AIKO_BROWSER_FALLBACKS: env.AIKO_BROWSER_FALLBACKS,
      },
      {
        contextWindowTokens:
          env.AIKO_MODEL === "glm-5.3-flash" ? 1000000 : 32768,
        maxOutputTokens: 4096,
      },
    ),
    arcadeKey: env.ARCADE_API_KEY,
    cartesiaKey: env.AIKO_CARTESIA_KEY,
    cartesiaVoiceId: env.AIKO_CARTESIA_VOICE_ID,
    cartesiaModel: env.AIKO_CARTESIA_MODEL,
    codeMode: env.AIKO_CODE_MODE === "true",
    databaseWriteOwners: parseDatabaseWriteOwners(env.AIKO_DATABASES, env.AIKO_DATABASE_WRITE_OWNERS),
    connectorVault: parseConnectorVault(env.AIKO_CONNECTOR_VAULT_JSON),
    managerKey: parseManagerKey(env.AIKO_MANAGER_KEY),
    managerProviders: parseManagerProviders(env.AIKO_MANAGER_PROVIDERS_JSON),
    port: 0,
    stateDir: "durable-object",
    operatorToken: env.AIKO_OPERATOR_TOKEN,
    botToken: env.AIKO_BOT_TOKEN,
    webhookSecret: env.AIKO_WEBHOOK_SECRET,
    allowedUsers,
    telegramPublic: env.AIKO_TELEGRAM_PUBLIC === "true",
    telegramMode: "webhook",
    planeCredentials: parsePlaneCredentials(env.AIKO_PLANE_CREDENTIALS ?? "[]"),
    maxAccounts,
    persona: env.AIKO_PERSONA ?? "3c36e929-50ac-4971-919f-70e6fc6273b7",
    voiceEnabled:
      replyStyle === "thinkfeel" && env.AIKO_VOICE_ENABLED === "true",
    replyStyle,
    ...parseFallbackVerbosity(env.AIKO_VERBOSE_FALLBACKS, env.AIKO_VERBOSE_FALLBACKS_SINCE),
    voiceKey: env.AIKO_VOICE_KEY,
    toolCallLimit: null,
    publicWeb: false,
  };
}
function validOwner(config: AikoConfig, owner: string) {
  return (
    safeUserId(owner) &&
    (owner === "local" ||
      config.allowedUsers.has(owner) ||
      config.planeCredentials?.some((key) => key.account === owner) ||
      (config.telegramPublic && /^[1-9]\d{0,15}$/.test(owner)))
  );
}
function authenticate(
  request: Request,
  config: AikoConfig,
): Principal | undefined {
  const auth =
    request.headers.get("authorization") ??
    (request.headers.has("x-telegram-init-data")
      ? `tma ${request.headers.get("x-telegram-init-data")}`
      : "");
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    if (equalSecret(token, config.operatorToken))
      return { owner: "local", scopes: ["read", "write"], operator: true };
    const digest = credentialDigest(token);
    const key = config.planeCredentials?.find((key) =>
      equalSecret(digest, key.digest),
    );
    if (key) return { owner: key.account, scopes: key.scopes, operator: false };
  }
  if (auth.startsWith("tms ") && config.botToken) {
    const owner = verifyMiniAppSession(auth.slice(4), config.botToken);
    if (owner && validOwner(config, owner)) return { owner, scopes: ["read", "write"], operator: false };
  }
  if (auth.startsWith("tma ") && config.botToken) {
    const owner = verifyInitData(auth.slice(4), config.botToken);
    if (owner && validOwner(config, owner))
      return { owner, scopes: ["read", "write"], operator: false };
  }
}
function telegramOf(
  config: AikoConfig,
  extra: Pick<
    Parameters<typeof createTelegram>[0],
    "redact" | "mediaProcessor"
  > = {},
) {
  return config.botToken && config.webhookSecret
    ? createTelegram({
        token: config.botToken,
        secret: config.webhookSecret,
        allowedUsers: config.allowedUsers,
        public: config.telegramPublic,
        ...extra,
      })
    : undefined;
}

/** A durable inventory only; it never holds conversations, credentials, or entity memory. */
/**
 * Account object naming epoch. Bumping this abandons (and effectively resets)
 * every wedged account object: fresh names recreate empty objects while the
 * durable registry keyed by raw owner id still admits the same accounts.
 */
const ACCOUNT_OBJECT_EPOCH = "v2";
export const accountObjectName = (owner: string) =>
  `${ACCOUNT_OBJECT_EPOCH}:${owner}`;

export class AikoRegistryDO extends DurableObject<AikoCloudflareEnv> {
  constructor(ctx: DurableObjectState, env: AikoCloudflareEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS accounts(owner TEXT PRIMARY KEY,created_at INTEGER NOT NULL)",
    );
  }
  async admit(owner: string, maximum?: number) {
    if (!safeUserId(owner)) throw new Error("Invalid owner");
    const accepted = this.ctx.storage.transactionSync(() => {
      if (
        this.ctx.storage.sql
          .exec("SELECT 1 FROM accounts WHERE owner=?", owner)
          .toArray().length
      )
        return true;
      const count = this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM accounts")
        .toArray()[0].count;
      if (maximum !== undefined && count >= maximum) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO accounts VALUES(?,?)",
        owner,
        Date.now(),
      );
      return true;
    });
    await this.ctx.storage.sync();
    return accepted;
  }
  async list() {
    return this.ctx.storage.sql
      .exec<{ owner: string; created_at: number }>(
        "SELECT owner,created_at FROM accounts ORDER BY owner",
      )
      .toArray();
  }
}

/** Physically siloed account: three private native logs, one shared native entity-learn journal. */
export class AikoAccountDO extends DurableObject<AikoCloudflareEnv> {
  private owner?: string;
  private runtime?: Promise<{
    host: CloudflareAccountHost;
    config: AikoConfig;
    binding(thread: string): MemoryBinding;
    databases: ReturnType<typeof createDatabaseBinding>;
    redact(text: string): string;
    capabilities?: ReturnType<typeof createCloudflareCapabilities>;
    connectors: ConnectorEngine;
    route: ReturnType<typeof routerCaller>;
    telegram: ReturnType<typeof telegramOf>;
    channels?: HostedChannels;
    media?:import("./media-host.ts").MediaHost;
    registryReadiness:()=>ReturnType<typeof registryReadiness>;
    providerAdapters?: import("./provider-adapter.ts").ProviderAdapterHost;
    experiments?: import("./harness-experiment.ts").HarnessExperimentBinding;
  }>;
  private admission = Promise.resolve();
  private failures = 0;
  private opsRedactor?: (text: string) => string;
  private opsFor(): OpsLogger {
    this.opsRedactor ??= (text) => {
      try {
        const config = configOf(this.env, false);
        return redactor([
          config.modelKey ?? "",
          config.cerebrasKey ?? "",
          config.arcadeKey ?? "",
          config.cartesiaKey ?? "",
          config.botToken ?? "",
          config.webhookSecret ?? "",
          config.operatorToken ?? "",
        ])(text);
      } catch {
        return text;
      }
    };
    return createOpsLogger(this.opsRedactor);
  }
  private get ops(): OpsLogger {
    return this.opsFor();
  }
  constructor(ctx: DurableObjectState, env: AikoCloudflareEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS aiko_account_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL)",
    );
    this.owner = this.ctx.storage.sql
      .exec<{ owner: string }>(
        "SELECT owner FROM aiko_account_owner WHERE singleton=1",
      )
      .toArray()[0]?.owner;
  }
  private bind(owner: string) {
    if (
      !safeUserId(owner) ||
      !this.ctx.id.equals(this.env.AIKO_ACCOUNTS.idFromName(accountObjectName(owner)))
    )
      throw new Error("Invalid account object binding");
    if (this.owner !== undefined && this.owner !== owner)
      throw new Error("Account object is already bound");
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO aiko_account_owner VALUES(1,?)",
      owner,
    );
    this.owner = owner;
  }
  private open(owner: string) {
    this.bind(owner);
    // A failed runtime must not stay cached: a rejected promise here wedges the
    // account object until isolate eviction, stranding every ingress route.
    if (!this.runtime)
      this.runtime = this.makeRuntime(owner).catch((error) => {
        this.runtime = undefined;
        console.error(
          "account_runtime_boot_failed",
          error instanceof Error
            ? `${error.name}: ${error.message}`.slice(0, 400)
            : "unknown",
        );
        throw error;
      });
    return this.runtime;
  }
  private async makeRuntime(owner: string) {
    const bootStarted = Date.now();
    this.ops("runtime.boot_started", { owner });
    const config = configOf(this.env, false);
    const redact = redactor([
      config.operatorToken,
      config.modelKey ?? "",
      config.cerebrasKey ?? "",
      config.arcadeKey ?? "",
      config.managerKey ?? "",
      ...Object.values(config.connectorVault?.accounts ?? {}).map(
        (a) => a.token,
      ),
      config.botToken ?? "",
      config.webhookSecret ?? "",
      config.voiceKey ?? "",
    ]);
    const nativeStorage = cloudflareStorage(this.ctx.storage);
    const requireThinkFeel =
      config.mode === "live" && config.replyStyle !== "direct";
    const compose = requireThinkFeel
      ? createThinkFeelComposer({
          key: config.voiceKey,
          persona: config.persona,
          redact,
        })
      : undefined;
    const voice = createVoice({
      enabled: config.voiceEnabled,
      key: config.voiceKey,
      persona: config.persona,
      compose,
      required: requireThinkFeel,
    });
    let host: CloudflareAccountHost;
    const bindingOf = (thread: string) =>
      threadBinding(thread) ??
      (host?.rootThread(thread) === `user-${owner}`
        ? { owner, role: "child" as const }
        : undefined);
    const binding = (thread: string): MemoryBinding => {
      if (bindingOf(thread)?.owner !== owner)
        throw new Error("Foreign memory binding");
      return {
        owner,
        thread,
        stateDir: "durable-object",
        redact,
        openMemory: (adapters) =>
          new Memory({
            storage: nativeStorage,
            scope: memoryScope(owner),
            adapters,
          }),
        readPage: (after, limit) => host.readPage(thread, after, limit),
        readSourcePage: async (source, after, limit) => {
          const sourceActor = source?.actor, sourceInstance = source?.instance, sourceThread = source?.thread;
          if (!source || sourceActor !== "aiko" || sourceInstance !== config.instanceId ||
              typeof sourceThread !== "string" || !validOwner(configOf(this.env, false), owner) || bindingOf(thread)?.owner !== owner || bindingOf(sourceThread)?.owner !== owner)
            throw new Error("Learning source scope denied");
          const first = await host.readPage(sourceThread, 0, 1);
          if (!first.length) throw new Error("Learning source unavailable");
          if (!validOwner(configOf(this.env, false), owner) || bindingOf(thread)?.owner !== owner || bindingOf(sourceThread)?.owner !== owner)
            throw new Error("Learning source scope denied");
          const rows = await host.readPage(sourceThread, after, limit);
          if (!validOwner(configOf(this.env, false), owner) || bindingOf(thread)?.owner !== owner || bindingOf(sourceThread)?.owner !== owner)
            throw new Error("Learning source scope denied");
          return rows;
        },
      };
    };
    const updateApprovalMenu = approvalMenu({ owner, token: config.botToken });
    const workflowKV: import("./workflow-host.ts").WorkflowKV = {
      get: (key) => this.ctx.storage.get(key),
      put: (key, value) => this.ctx.storage.put(key, value),
      list: async (prefix) => [
        ...(await this.ctx.storage.list({ prefix })).values(),
      ],
      update: async (key, change) => {
        await this.ctx.storage.transaction(async (txn) => {
          await txn.put(key, change(await txn.get(key)));
        });
      },
      claim: (key, value) =>
        this.ctx.storage.transaction(async (txn) => {
          if ((await txn.get(key)) !== undefined) return false;
          await txn.put(key, value);
          return true;
        }),
    };
    const databases = createDatabaseBinding({ owner, thread: `user-${owner}`, storage: nativeStorage, kv: workflowKV,
      readEvents: () => host.read(`user-${owner}`),
      sources: async (sourceId, digest, signal) => {
        if (sourceId !== digest) throw Error("Registered source digest required");
        const source = await resolveObservedRead({ owner, thread: `user-${owner}`, redact, readEvents: () => host.read(`user-${owner}`), checkArcade: async domain => (await connectors.search(domain)).fallbackAllowed, session: (origin, signal) => ensureUnlockSession({ owner, origin, config: config.connectorVault, search: domain => connectors.search(domain), signal, renew: false }) }, digest, signal);
        return { ...source, execute: (inputs, consume, signal, budget) => source.execute(inputs,
          (step, body) => consume(step, body === undefined ? undefined : JSON.parse(JSON.stringify(body))), signal, budget) };
      },
      authorize: async kind => {
        const current = configOf(this.env, false);
        return !!validOwner(current, owner) && (kind === "read" || current.databaseWriteOwners === undefined || current.databaseWriteOwners.includes(owner));
      },
    });
    const capabilities =
      config.mode === "live" && config.modelKey
        ? createCloudflareCapabilities({
            owner,
            computeHarness:{config:this.env.AIKO_COMPUTE_HARNESS,kv:workflowKV},
            onApprovalsChanged: (_owner, count) => updateApprovalMenu(count),
            env: { CODEGRAFF_API_KEY: config.modelKey! },
            tts: config.cartesiaKey && config.cartesiaVoiceId
              ? createCartesiaTts({ key: config.cartesiaKey, voiceId: config.cartesiaVoiceId, model: config.cartesiaModel })
              : undefined,
            storage: {get: <T>(key:string)=>this.ctx.storage.get<T>(key),put:(key,value)=>this.ctx.storage.put(key,value),claim:(key,value)=>this.ctx.storage.transaction(async txn=>{if(await txn.get(key)!==undefined)return false;await txn.put(key,value);return true;})},
            memory: binding(`user-${owner}`),
            unlock: { config: config.connectorVault, engine: () => connectors },
            emit: async (record) => {
              if(!registryExternalEventAllowed(record as Event) || !workExternalEventAllowed(record as Event))throw Error("Private registry event denied");
              await host.commitRoot(
                host.self(`user-${owner}`),
                loginRuntimeEvent(owner,record as Event),
              );
              if (record.type === "AikoNativeLoginStatus" && record.owner === owner && typeof record.connectionId === "string")
                await connectors.completeAuth(record.connectionId);
            },
          })
        : undefined;
    const modelBudget=registryModelBudget(owner,workflowKV);
    const registryContext={owner,thread:`user-${owner}`,read:()=>host.read(`user-${owner}`),sandbox:capabilities?.harnessSandbox,kv:workflowKV,append:async(events:Event[])=>{await host.commitRoot(host.self(`user-${owner}`),event("AikoHooksActivated",{id:"background-v1"}));await host.seed(`user-${owner}`,events);},serialize:<T>(fn:()=>Promise<T>)=>this.serialize(fn)};
    const optimization = registryOptimizationHostOptions({
      owner,
      instance: config.instanceId!,
      config: config.mode === "live" ? config.modelRouting : undefined,
      env: { CODEGRAFF_API_KEY: config.modelKey, CEREBRAS_API_KEY: config.cerebrasKey, AIKO_ALLOW_PAID_INFERENCE: "true" },
      budget: modelBudget,
      fetch: this.env.AIKO_MODEL_FETCH,
      currentOwner: () => !!validOwner(configOf(this.env, false), owner),
      readThread: async thread => {
        if (host.rootThread(thread) !== `user-${owner}`) throw Error("Foreign trial thread");
        return host.read(thread);
      },
    });
    const registryTransport = this.env.AIKO_REGISTRY_SANDBOX
      ? this.env.AIKO_REGISTRY_SANDBOX(owner, workflowKV)
      : capabilities ? {
          sandbox: capabilities.harnessSandbox,
          codeTransport: (input: Parameters<RegistrySandboxTransport["codeTransport"]>[0], signal: AbortSignal) => capabilities.sandbox.codeSegment(input, signal),
          placement: "codegraff" as const,
        } : undefined;
    const registryPolicy = () => {
      const current = configOf(this.env, false);
      return {
        owner, active: !!validOwner(current, owner) && current.codeMode === true,
        revision: harnessDigest({ owner, allowed: validOwner(current, owner), codeMode: current.codeMode === true,
          telegram: current.botToken ? harnessDigest(current.botToken) : null,
          key: current.modelKey ? harnessDigest(current.modelKey) : "no-key",
          model: current.modelRouting,
          cerebras: current.cerebrasKey ? harnessDigest(current.cerebrasKey) : null }),
      };
    };
    const registry = checkedRegistryBinding(owner, this.env.AIKO_REGISTRY_FACTORY
      ? this.env.AIKO_REGISTRY_FACTORY(registryContext)
      : defaultRegistryBinding({
          ...registryContext, optimization, transport: registryTransport,
          management: () => this.env.AIKO_REGISTRY_MANAGEMENT?.(owner),
          providerAdapters: this.env.AIKO_PROVIDER_ADAPTERS,
          logSources: this.env.AIKO_LOG_SOURCES,
          disabledReason: config.codeMode !== true ? "code_mode_disabled" : undefined,
          missingReason: config.mode === "live" && !config.modelKey ? "sandbox_secret_not_configured" : "sandbox_transport_not_configured",
          policy: registryPolicy,
          guard: value => { const text = JSON.stringify(value); if (redact(text) !== text) throw Error("Private registry structural input denied"); },
        }));
    const codeHarnesses = new Map<string, CodeHarness>();
    const harnessFor = (thread: string) => {
      if (!config.codeMode || (!capabilities&&!registry?.codeTransport)) return undefined;
      let harness = codeHarnesses.get(thread);
      if (!harness) {
        if (bindingOf(thread)?.owner !== owner)
          throw new Error("Foreign code harness binding");
        harness = new CodeHarness(
          owner,
          thread,
          registry?.codeTransport ?? ((input, signal) => capabilities!.sandbox.codeSegment(input, signal)),
          redact,
          workflowStore,
          codeResultCustody({owner,thread,blobs:(registry?.sources?.library??registry?.library)?.blobs??harnessBlobStore(workflowKV),read:()=>host.read(thread),currentData:async()=>!!validOwner(configOf(this.env,false),owner)&&bindingOf(thread)?.owner===owner&&configOf(this.env,false).codeMode===true&&!registry?.availability?.()&&!registry?.unavailableReason&&(bindingOf(thread)?.role!=="child"||!!workerGrantOf(workerBindingFor(thread),await host.read(`user-${owner}`),await host.read(thread))),current:async scope=>!!validOwner(configOf(this.env,false),owner)&&bindingOf(thread)?.owner===owner&&config.codeMode===true&&!registry?.availability?.()&&!registry?.unavailableReason&&(bindingOf(thread)?.role!=="child"||!!workerGrantOf(workerBindingFor(thread),await host.read(`user-${owner}`),await host.read(thread)))&&(!registry?.authorizeCodeResult||await registry.authorizeCodeResult(scope)),tools:()=>harness?.toolSpecs()??[]}),
        );
        codeHarnesses.set(thread, harness);
      }
      return harness;
    };
    const telegram = telegramOf(config, {
      redact,
      mediaProcessor: capabilities?.sandbox.processMedia,
    });
    const doStore = {
      get: (key: string) => this.ctx.storage.get(key),
      set: (key: string, value: unknown) => this.ctx.storage.put(key, value),
      list: async (prefix: string) => [
        ...(await this.ctx.storage.list({ prefix })).values(),
      ],
    };
    const connectors: ConnectorEngine = new ConnectorEngine({
      owner,
      secureBrowser:
        connectorVault(config.connectorVault, owner) ??
        (capabilities
          ? nativeBrowserConnector(owner, capabilities.sandbox.browserFactory(), async (record) => {
              if(!registryExternalEventAllowed(record as Event) || !workExternalEventAllowed(record as Event))throw Error("Private registry event denied");
              await host.commitRoot(host.self(`user-${owner}`), loginRuntimeEvent(owner,record as Event));
            }, () => capabilities.sandbox.progress())
          : undefined),
      env: { ARCADE_API_KEY: config.arcadeKey },
      store: doStore,
      managers: config.managerKey
        ? new FilePasswordManagerHost({
            store: doStore,
            owner,
            key: config.managerKey,
            providers: config.managerProviders,
          })
        : undefined,
      loginOperationGuard:(id,input)=>guardLoginOperationInput(owner,host,id,input),
      onEvent: async (e) => {
        await host.commitRoot(
          host.self(`user-${owner}`),
          event("AikoHooksActivated", { id: "background-v1" }),
        );
        await host.commitRoot(host.self(`user-${owner}`), e.type==="AikoPrivateLoginObserved" ? loginObservationEvent(owner,e as unknown as NativeLoginObservation) : e);
        await this.kick(host);
      },
      readOwnedLogs: async (boundOwner) =>
        (await host.read(`user-${boundOwner}`))
          .filter((e) => e.type === "AikoApiObserved" && e.owner === boundOwner)
          .map((e) => ({
            owner: boundOwner,
            id: String(e.id),
            text: `${e.method} ${e.url}`,
          })),
    });
    const workflowStore = createWorkflowStore(workflowKV);
    const workflows = new WorkflowController(
      owner,
      `user-${owner}`,
      {
        store: workflowStore,
        dispatcher: workflowDispatcher({
          owner,
          engine: connectors,
          redact,
          readEvents: () => host.read(`user-${owner}`),
        }),
        guard: validateRouterInput,
      },
      redact,
    );
    const routerBinding = {
      owner,
      engine: connectors,
      redact,
      readOwnedEvents: () => host.read(`user-${owner}`),
      listWorkflows: () => workflows.engine.list(),
      listCodeWorkflows: () => workflowStore.listCode!(owner),
      codeToolSpecs: () => codeHarnesses.get(`user-${owner}`)?.toolSpecs() ?? [],
      vaultDomains: async () =>
        Object.keys(config.connectorVault?.accounts[owner]?.connections ?? {}),
    };
    const route = routerCaller(routerBinding, () => host);
    const telegramTyping =
      telegram &&
      createTelegramTyping(owner, telegram, { waitForDelivery: true });
    const telegramTools = telegram
      ? createTelegramTools({
          owner,
          telegram,
          redact,
          compose,
          ...(capabilities
            ? {
                speak: capabilities.sandbox.speak.bind(capabilities.sandbox),
                captureScreenshot: capabilities.sandbox.captureScreenshot.bind(
                  capabilities.sandbox,
                ),
                inspectImages: createTelegramVision({
                  provider:
                    this.env.AIKO_VISION_PROVIDER ??
                    config.modelRouting!.roles.conversation.provider,
                  apiKey:
                    (this.env.AIKO_VISION_PROVIDER ??
                      config.modelRouting!.roles.conversation.provider) ===
                    "cerebras"
                      ? config.cerebrasKey!
                      : config.modelKey!,
                  model:
                    this.env.AIKO_VISION_MODEL ??
                    config.modelRouting!.roles.conversation.model,
                  redact,
                }),
              }
            : {}),
        })
      : [];
    const actors = new Map<
      string,
      | ReturnType<typeof createAikoActor>
      | ReturnType<typeof createIndexerActor>
      | ReturnType<typeof createReflectionActor>
      | ReturnType<typeof createToolRouterActor>
      | ReturnType<typeof createControlActor>
      | ReturnType<typeof createSecretaryActor>
    >();
    const routing =
      config.mode === "live" && config.modelRouting &&
      ({ CODEGRAFF_API_KEY: config.modelKey, CEREBRAS_API_KEY: config.cerebrasKey } as Record<string, string | undefined>)[config.modelRouting.roles.conversation.secretEnv]
        ? createModelRouting({
            owner,
            compactionBlobs:(registry?.sources?.library??registry?.library)?.blobs??harnessBlobStore(workflowKV),
            authorizeCompaction:async identity=>{
              if(!validOwner(configOf(this.env,false),owner)||identity.actor!=="aiko"||bindingOf(identity.thread)?.owner!==owner||identity.instance!==config.instanceId||registry?.availability?.()||registry?.unavailableReason)return false;
              return bindingOf(identity.thread)?.role!=="child"||!!workerGrantOf(workerBindingFor(identity.thread),await host.read(`user-${owner}`),await host.read(identity.thread));
            },
            config: config.modelRouting,
            env: {
              CODEGRAFF_API_KEY: config.modelKey,
              CEREBRAS_API_KEY: config.cerebrasKey,
              AIKO_ALLOW_PAID_INFERENCE: "true",
              AIKO_MODEL_EFFORTS: config.modelEfforts,
              AIKO_MODEL_CAPABILITIES: config.modelCapabilities,
            },
            budget:modelBudget,
            fetch: this.env.AIKO_MODEL_FETCH,
            stream: { firstChunkMs: 90000, idleMs: 90000, totalMs: 300000 },
          })
        : undefined;
    const model = withSpokenHistory(
      config.mode === "demo"
        ? demoInference
        : !config.modelKey && !routing
          ? Layer.succeed(Infer, { react: () => Effect.die(Error("Model transport unavailable")) })
          : routing
          ? withRoleInference((role) => routing.layer(role),ref=>routing.layerFor(ref))
          : modelInference(
              {
                provider: "codegraff",
                baseUrl: "https://gateway.codegraff.com/v1",
                apiKey: config.modelKey!,
                model: config.model!,
                protocol: "openai-chat-completions",
                // Verified against the gateway model catalog; native compaction owns this window.
                contextWindowTokens:
                  config.model === "glm-5.3-flash" ? 1_000_000 : 32_768,
                maxOutputTokens: 4096,
                fetch: modelBudget.transport(owner, this.env.AIKO_MODEL_FETCH),
                throttleRetryDelaysMs: [],
                // Native Tardigrade stream bounds handle provider stalls. Do not
                // shorten them below long-context prefill/thinking latency.
              },
              modelAdapters(openAICompatibleAdapter),
            ),
    );
    const workerContextFor=(model:import("tardie/inference/reference").ModelRef|undefined)=>{
      return routing?.contextForHistory(model).contextWindowTokens??config.modelRouting?.contextWindowTokens??32768;
    };
    const mcpClients=new Map<string,GeneralMcp|undefined>();
    const projectContexts=new Map<string,ProjectContext|undefined>();
    const projectFor=(thread:string)=>{if(!projectContexts.has(thread)){const options=this.env.AIKO_PROJECT_CONTEXT?.(owner,thread);if(options&&(options.owner!==owner||options.thread!==thread))throw Error("Foreign project context binding");projectContexts.set(thread,options?new ProjectContext(options):undefined);}return projectContexts.get(thread);};
    const mcpFor=(thread:string)=>{if(!mcpClients.has(thread)){const binding=this.env.AIKO_MCP?this.env.AIKO_MCP(owner,thread):configuredMcpBinding({owner,thread,servers:()=>parseMcpServers(this.env.AIKO_MCP_SERVERS),env:this.env as unknown as Readonly<Record<string,unknown>>,redact,current:()=>!!validOwner(configOf(this.env,false),owner)&&configOf(this.env,false).codeMode===true&&bindingOf(thread)?.owner===owner});if(binding&&(binding.owner!==owner||binding.thread!==thread))throw Error("Foreign MCP binding");mcpClients.set(thread,binding?new GeneralMcp(binding):undefined);}return mcpClients.get(thread);};
    const coding=capabilities&&config.codingRepositories?.[owner]?.length?new CodegraffCodingWorkspace(capabilities.compute,{repositories:[...config.codingRepositories[owner]!],runnerBundle:codingRunnerBundle,bunVersion:"1.4.0"}):undefined;
    const workerBindingFor=(thread:string):WorkerBinding=>({owner,thread,readParent:()=>host.read(`user-${owner}`),readChild:()=>host.read(thread),mcpCurrent:()=>mcpFor(thread)?.binding.servers()??[],active:()=>!!validOwner(configOf(this.env,false),owner)&&configOf(this.env,false).codeMode===true&&bindingOf(thread)?.owner===owner&&!registry?.availability?.()&&!registry?.unavailableReason,modelLayer:(model,effort)=>{if(!routing)throw Error("Worker model routing unavailable");return routing.layerFor(model,effort);}});
    const channelAdapters = this.env.AIKO_CHANNEL_ADAPTERS?.forOwner(owner) ?? registry?.providerAdapters?.adapters;
    const registryLibrary=registry?.sources?.library??registry?.library;
    const registryJournal={read:()=>host.read(`user-${owner}`),append:async(events:Event[])=>{await host.seed(`user-${owner}`,events);}};
    const wiring=registryLibrary?.verifiers.size&&registry?.authorizeReceiving?{blobs:registryLibrary.blobs,...channelHarnessHandlers(registry.sources?sourceAwareHarnessBinding(registryLibrary,registryJournal):registryLibrary,registryJournal,registry.authorizeReceiving,{accepts:(...a)=>registry.continuations?.accepts(...a)??Promise.resolve(false),execute:(...a)=>registry.continuations!.execute(...a),reconcile:(...a)=>registry.continuations!.reconcile(...a)})}:undefined;
    const channels = channelAdapters || wiring ? createHostedChannels(owner, () => host, channelAdapters, {
      requireThinkFeel,
      wiring,
      logSources:registry?.logSources,
      bridge:channelAdapters&&wiring?(this.env.AIKO_CHANNEL_BRIDGE?.(owner)??registry?.providerAdapters?.bridge):undefined,
      beforeCommit: async () => {
        const recoveryAt = Date.now() + 1000;
        const current = await this.ctx.storage.getAlarm();
        if (current === null || current > recoveryAt) await this.ctx.storage.setAlarm(recoveryAt);
      },
    }) : undefined;
    if(channels?.wiring&&registryLibrary&&registry?.management&&registry.codeTransport&&registry.defaultAuthorityRef)registry.continuations=registryManagementContinuations({binding:registry.sources?sourceAwareHarnessBinding(registryLibrary,registryJournal):registryLibrary,journal:registryJournal,transport:registry.codeTransport,wiring:()=>channels.wiring!,current:registry.management,receiving:registry.authorizeReceiving!,authorityRef:registry.defaultAuthorityRef});
    host = await createCloudflareAccountHost({
      storage: this.ctx.storage,
      actorName: "aiko",
      actorInstance: config.instanceId!,
      ownsThread: (thread) => threadBinding(thread)?.owner === owner,
      allowIndependentChildren: true,
      onClose:()=>Promise.all([...mcpClients.values()].map(client=>client?.close())).then(()=>undefined),
      allowChild: (parent, child) =>
        parent === `user-${owner}` && !!validOwner(configOf(this.env, false), owner) &&
        // The native host also requires the exact retained ChildCreated call ID
        // and lineage. Lifecycle-only trial workers cannot start execution.
        ((config.codeMode === true && /^ag\.[0-9]+:/.test(child)) || harnessExperimentTrialIsChild(child)) &&
        child.length < 2048,
      nextWake: async () => {
        const rows = await host.read(`user-${owner}`);
        const times = [
          await this.sandboxDeadline(host, capabilities),
          automationNextWake(rows),
          promiseNextWake(rows),
          hostedRegistryNextWake(rows,owner),
          loginOperationNextWake(rows,owner,`user-${owner}`),
        ].filter((n): n is number => n !== undefined);
        return times.length ? Math.min(...times) : undefined;
      },
      keyOf: (e) =>
        databaseEventKey(e) ??
        workerEventKey(e) ??
      codingWorkspaceEventKey(e) ??
        harnessExperimentTrialEventKey(e) ??
        agentKeys.keyOf(e) ??
        cancellationKeys.keyOf(e) ??
        methodCallKeys.keyOf(e) ??
        methodResponseKeys.keyOf(e) ??
        methodTimeoutKeys.keyOf(e) ??
        methodIngressKeyOf(e) ??
        workEventKey(e) ??
        secretaryEventKey(e) ??
        automationEventKey(e) ??
        channelEventKey(e) ??
        channelWiringEventKey(e) ??
        channelBridgeEventKey(e) ?? channelLogSourceEventKey(e) ??
        hostedChannelDeadlineKey(e) ??
        mediaHostEventKey(e) ?? mediaProcessingEventKey(e) ??
        harnessLibraryEventKey(e) ??
      registrySandboxEventKey(e) ??
        loginOperationEventKey(e) ??
        connectorLoginEventKey(e) ??
        promiseEventKey(e) ??
        routerEventKey(e) ??
        backgroundEventKey(e) ??
        telegramEventKey(e) ??
        browserTraceKeys.keyOf(e) ??
        requestMemoryEventKey(e) ??
        observedActionEventKey(e) ??
        harKeys.keyOf(e) ??
        (e.type === "AikoControlReply"
          ? `aiko-control:${e.id}`
          : e.type === "AikoSandboxAllocationReconciled"
            ? `aiko-sandbox-reconcile:${e.id}`
            : undefined),
      canAppend: (_thread, events, read) =>
        workAppendAllowed(_thread,events,read) && proactiveAppendAllowed(events,read,_thread) && mediaProcessingAppendAllowed(events,read) && automationAppendAllowed(events, read) && channelAppendAllowed(events, read) && channelWiringAppendAllowed(events,read) && harnessLibraryAppendAllowed(events,read) && channelBridgeAppendAllowed(events,read) && channelLogSourceAppendAllowed(events,read),
      actorFor: (thread) => {
        if(harnessExperimentTrialIsChild(thread))return registryTrialActor(
          requested => requested === owner && validOwner(configOf(this.env, false), owner) ? registry?.experiments : undefined,
          requested => requested === owner && validOwner(configOf(this.env, false), owner)
            ? harnessExperimentTrialLifecycle({ owner, parentThread: `user-${owner}`,
              readParent: () => host.read(`user-${owner}`) }) : undefined,
        );
        const bound = bindingOf(thread)!;
        let definition = actors.get(thread);
        if (!definition) {
          const memory = binding(thread);
          definition =
            bound.role === "child"
              ? createCodeChildActor(harnessFor(thread)!, [
                  ...memoryTools(memory, { fixtures: false }),
                  publicWebTool(memory),
                  ...(capabilities?.browser.workerInspectionTools(owner,thread,{parentThread:`user-${owner}`,current:async()=>{
                    const grant=workerGrantOf(workerBindingFor(thread),await host.read(`user-${owner}`),await host.read(thread));
                    return grant&&(grant.scope==="research"||grant.scope==="browser")?{scope:grant.scope,origins:grant.origins}:undefined;
                  }})??[]),
                  ...(capabilities ? [capabilities.searchFor(memory),...capabilities.computeToolsFor(memory)] : []),
                  ...(coding?codingWorkspaceTools(coding.binding(thread,redact)):[]),
                  ...(this.env.AIKO_WORKER_TOOLS?.(owner,thread)??[]),
                  ...(mcpFor(thread)?.tools()??[]),
                  ...(projectFor(thread)?.tools()??[]),
                  ...createObservedNetworkTools({owner,thread,redact,readEvents:()=>host.read(`user-${owner}`),approvalJournal:{thread:`user-${owner}`,read:()=>host.read(`user-${owner}`),append:rows=>host.seed(`user-${owner}`,rows)},checkArcade:async domain=>(await connectors.search(domain)).fallbackAllowed,session:(origin,signal)=>ensureUnlockSession({owner,origin,config:config.connectorVault,search:domain=>connectors.search(domain),signal,renew:true})}),
                ],workerBindingFor(thread),workerContextFor)
              : bound.role === "secretary"
                ? createSecretaryActor({
                    owner,
                    redact,
                    read: () => host.read(thread),
                    readOwner: () => host.read("user-" + owner),
                    telegram: config.botToken
                      ? secretaryTelegram(config.botToken)
                      : undefined,
                  })
                : bound.role === "control"
                  ? createControlActor({
                      owner,
                      voice,
                      send: telegram?.send,
                      live: requireThinkFeel,
                      verboseFallbacks: config.verboseFallbacks,
                      verboseFallbacksSince: config.verboseFallbacksSince,
                      redact,
                      publish: (rows) => host.seed(`user-${owner}`, rows),
                    })
                  : bound.role === "router"
                    ? createToolRouterActor(routerBinding)
                    : bound.role === "indexer"
                      ? createIndexerActor(memory, (id, signal, route) =>
                          connectors.connectionPage(id, signal, route),
                          registry?.sources?.library??registry?.library,
                          !!registry?.logSources,
                        )
                      : bound.role === "reflection"
                        ? createReflectionActor(memory)
                        : createAikoActor({
                            secretaryWork: createSecretaryWorkBinding(host, memory, config.botToken ? secretaryTelegram(config.botToken) : undefined),
                            databases,
                            channels,
                            channelContinuations:registry?.continuations,
                            registryBootstrap:registry?.bootstrap,
                            registryAuthorityRef:registry?.defaultAuthorityRef,
                            harnessSources:registry?.sources,
                            media:registry?.media,
                            experiments:registry?.experiments,
                            experimentRecovery: harnessExperimentTrialLifecycle({ owner, parentThread: `user-${owner}`,
                              readParent: () => host.read(`user-${owner}`) }),
                            optimizationTrigger:registry?.optimizationTrigger,
                            optimizationPolicy:registry?.optimizationPolicy,
                            harnessLibrary:registry?.library,
                            loginOperation:hostedLoginOperation(owner,()=>host,()=>connectors),
                            automations: true,
                            promises: capabilities
                              ? {
                                  executors: {
                                    harness: (segment, signal) =>
                                      capabilities.sandbox.codeSegment(
                                        segment,
                                        signal ?? AbortSignal.timeout(120_000),
                                      ),
                                  },
                                }
                              : undefined,
                            owner,
                            memory,
                            voice,
                            live: config.mode === "live",
                            publicWeb: false,
                            send: telegram?.send,
                            background: true,
                            toolRouter: {
                              owner,
                              thread,
                              redact,
                              readRouter: () => host.read(`router-${owner}`),
                            },
                            workflow: workflows.component(),
                            workflowTools: workflows.codeTools(),
                            codeHarness: harnessFor(thread),
                            contextWindowTokens:workerContextFor,
                            workers:{scopes:["research","browser",...(capabilities?["compute" as const]:[]),...(coding||this.env.AIKO_WORKER_TOOLS?.(owner,thread).some(t=>t.spec.name.startsWith("coding_"))?["coding" as const]:[])],models:()=>routing?.models()??[],mcp:()=>mcpFor(thread)?.binding.servers()??[],active:()=>!!validOwner(configOf(this.env,false),owner)&&configOf(this.env,false).codeMode===true,readChild:child=>bindingOf(child)?.owner===owner?host.read(child):Promise.reject(Error("Foreign worker"))},
                            capabilityBuilder: {
                              owner,
                              thread,
                              redact,
                              readEvents:()=>host.read(thread),
                          checkArcade: async (domain) =>
                                (await connectors.search(domain))
                                  .fallbackAllowed,
                              session: (origin, signal) =>
                                ensureUnlockSession({
                                  owner,
                                  origin,
                                  config: config.connectorVault,
                                  search: (domain) => connectors.search(domain),
                                  signal,
                                  renew: true,
                                }),
                            },
                            connectors: {
                              owner,
                              thread,
                              engine: connectors,
                              deliverConnection: async (input, signal) => {
                                if (!telegram || input.owner !== owner)
                                  return { status: "rejected" as const };
                                const wording = compose
                                  ? await compose(input.text, signal)
                                  : undefined;
                                if (
                                  requireThinkFeel &&
                                  wording?.status !== "ready"
                                )
                                  return { status: "rejected" as const };
                                return telegram.sendRich(
                                  owner,
                                  {
                                    kind: "text",
                                    text:
                                      wording?.status === "ready"
                                        ? wording.text
                                        : input.text,
                                    buttons: input.buttons,
                                  },
                                  signal,
                                );
                              },
                            },
                            toolCallLimit: null,
                            report: (event, fields) => this.ops(event, fields),
                            requireThinkFeel,
                            verboseFallbacks: config.verboseFallbacks,
                            verboseFallbacksSince: config.verboseFallbacksSince,
                            ...(telegramTyping ? { telegramTyping } : {}),
                            extraTools: [
                              ...(coding?codingWorkspaceTools(coding.binding(thread,redact)):[]),
                  ...(this.env.AIKO_WORKER_TOOLS?.(owner,thread)??[]),
                              ...(mcpFor(thread)?.tools()??[]),
                  ...(projectFor(thread)?.tools()??[]),
                              ...(registry?.providerAdapters?.tools(()=>channels!)??[]),
                              ...telegramTools,
                              ...(capabilities ? [capabilities.search] : []),
                              ...(capabilities ? capabilities.computeToolsFor(memory) : []),
                            ],
                            computeCancellation: capabilities?.computeCancellationFor(thread),
                            ...(capabilities
                              ? {
                                  browser: capabilities.browser,
                                  browserMode: "sandbox" as const,
                                }
                              : {}),
                          });
          actors.set(thread, validateActor(definition));
        }
        return definition;
      },
      layersFor: (thread) => {
        if(harnessExperimentTrialIsChild(thread))return Layer.succeed(Infer,{react:()=>Effect.die(Error("Trial inference unavailable"))});
        const role = bindingOf(thread)?.role;
        const rawBase =
          role === "secretary"
            ? withSecretaryHistory(model)
            : role === "foreground"
              ? withRequiredResponse(
                  workflows.inference(
                    capabilities
                      ? capabilities.browser.inference(registry?.media?.inference(model)??model, owner)
                      : registry?.media?.inference(model)??model,
                  ),
                  redact,
                )
              : role === "child" ? workerInference(model,workerBindingFor(thread)) : model;
        const ordinaryBase = role === "foreground" ? databaseInference(databases, rawBase) : rawBase;
        const projectBase=(role==="foreground"||role==="child")?projectFor(thread)?.inference(ordinaryBase)??ordinaryBase:ordinaryBase;
        const base=(role==="foreground"||role==="child")&&(coding||this.env.AIKO_WORKER_TOOLS?.(owner,thread).some(tool=>tool.spec.name.startsWith("coding_")))?codingWorkspaceInference(projectBase,owner,thread,coding?.grantRevision):projectBase;
        const harness =
          role === "foreground" || role === "child"
            ? harnessFor(thread)
            : undefined;
        if(!harness)return base;
        const wiring=role==="foreground"?channels?.wiring:undefined;
        const ordinary=wiring?wiring.sandboxLayer(harness.sandboxLayer()):harness.sandboxLayer();
        const sandbox=registry?.continuations?.sandboxLayer(ordinary)??ordinary;
        return Layer.merge(harness.inference(base),sandbox);
      },
    });
    this.ops("runtime.boot_completed", { owner, ms: Date.now() - bootStarted });
    return { host, config, binding, databases, redact, capabilities, connectors, route, telegram, channels, media:registry?.media, providerAdapters:registry?.providerAdapters, experiments:registry?.experiments, registryReadiness:()=>registryReadiness(registry,configOf(this.env, false).codeMode===true&&!!harnessFor(`user-${owner}`)) };
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.admission.then(operation);
    this.admission = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  private async kick(_host: CloudflareAccountHost) {
    // Acknowledge ingress after arming a real alarm. The alarm handler awaits the
    // native driver; an RPC return must not own a long-running inference lifetime.
    const alarm = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(
      Math.min(alarm ?? Infinity, Date.now() + 1),
    );
  }
  private async sandboxDeadline(
    host: CloudflareAccountHost,
    capabilities?: ReturnType<typeof createCloudflareCapabilities>,
  ) {
    if (!capabilities || !this.owner) return undefined;
    const sandbox = await capabilities.sandbox.status();
    if (
      !("id" in sandbox) ||
      !sandbox.id ||
      sandbox.phase !== "available" ||
      sandbox.stoppedAt
    )
      return undefined;
    const events = await host.read(`user-${this.owner}`);
    const lastEvent = events.reduce(
      (latest, e) =>
        e.type !== "AikoAutomationTick" &&
        e.type !== "AikoPromiseTick" &&
        typeof e.at === "number" &&
        Number.isFinite(e.at)
          ? Math.max(latest, e.at)
          : latest,
      0,
    );
    const deadline =
      Math.max(sandbox.lastActive ?? sandbox.startedAt, lastEvent) + 120_000;
    return capabilities.sandbox.busy
      ? Math.max(deadline, Date.now() + 120_000)
      : deadline;
  }
  private async accept(
    owner: string,
    id: string,
    text: string,
    source: "plane" | "local" | "telegram" | "operator",
    inbound?: TelegramInbound,
  ) {
    return this.serialize(async () => {
      const { host, config, redact, telegram } = await this.open(owner);
      if (!validOwner(config, owner))
        throw new Error("Account is not authorized");
      if (inbound?.secretary) {
        const status = await acceptSecretary(
          host,
          owner,
          redactTelegramInbound(inbound, redact),
          true,
        );
        await this.kick(host);
        return status;
      }
      const thread = `user-${owner}`;
      const log = await host.read(thread);
      const prior = log.find(
        (e) => e.type === "MessageReceived" && e.id === id,
      );
      const normalized = inbound && redactTelegramInbound(inbound, redact);
      const telegramDigest =
        normalized &&
        createHash("sha256")
          .update(serializeTelegramInbound(normalized))
          .digest("hex");
      if (prior)
        return prior.source === source &&
          prior.text === redact(text) &&
          (!prior.telegramDigest || prior.telegramDigest === telegramDigest)
          ? "duplicate"
          : "conflict";
      await host.commitRoot(
        host.self(thread),
        event("AikoHooksActivated", { id: "background-v1" }),
      );
      // Acknowledge ingestion immediately: a content-matched reaction shows
      // the message was read while the turn is still starting. Best effort —
      // a failed or rate-limited reaction must never break the turn.
      if (
        source === "telegram" &&
        telegram &&
        normalized?.messageId &&
        (!normalized.kind || normalized.kind === "message")
      )
        void telegram
          .react(
            owner,
            normalized.messageId,
            readReactionFor(text, Boolean(normalized.media?.length)),
            new AbortController().signal,
          )
          .catch(() => {});
      if (
        source === "telegram" &&
        !normalized?.media?.length &&
        controlCommand(text)
      ) {
        const status = await telegramControl(
          host,
          owner,
          id,
          text,
          config.mode === "live",
          config.mode === "live",
          undefined,
          {
            stoppedDraftId: normalized?.stoppedDraftId,
            messageThreadId: normalized?.messageThreadId,
            secretary: (text) => secretaryCommand(host, owner, text, redact),
            connectors: (await this.open(owner)).connectors,
            separateLane: true,
            connectorsUrl: "https://aiko-agent.lewis-6d8.workers.dev/connect",
            sandbox: config.mode === "live",
            media: config.mode === "live",
            voice: config.mode === "live",
          },
        );
        await this.kick(host);
        return status;
      }
      await host.commitRoot(
        host.self(thread),
        event("MessageReceived", {
          id,
          text: redact(text),
          source,
          ...(source === "operator"
            ? { channel: "telegram", chat: owner, sender: "operator" }
            : {}),
          ...(source === "telegram"
            ? {
                chat: owner,
                sender: owner,
                ...(normalized
                  ? {
                      telegram: normalized,
                      telegramDigest,
                      ...(normalized.media ? { media: normalized.media } : {}),
                    }
                  : {}),
              }
            : {}),
        }),
      );
      await this.kick(host);
      return "accepted";
    });
  }
  async acceptTelegram(owner: string, inbound: TelegramInbound) {
    if (inbound.user !== owner) throw new Error("Foreign Telegram owner");
    const runtime=await this.open(owner);
    if(runtime.telegram&&await telegramMediaAdmission(runtime.media,inbound,runtime.telegram.media.download)){await this.kick(runtime.host);return "accepted";}
    return this.accept(
      owner,
      `telegram:${inbound.update}`,
      inbound.text,
      "telegram",
      inbound,
    );
  }
  async acceptOperatorMessage(owner: string, id: string, text: string) {
    const { host } = await this.open(owner);
    if (
      !/^[1-9]\d{0,15}$/.test(owner) ||
      !(await host.read(`user-${owner}`)).some(
        (e) =>
          e.type === "MessageReceived" &&
          e.source === "telegram" &&
          String(e.chat) === owner &&
          String(e.sender) === owner,
      )
    )
      throw new Error("No established private Telegram conversation");
    return this.accept(owner, `operator:${id}`, text, "operator");
  }
  async describe(owner: string) {
    const { host } = await this.open(owner);
    return {
      account: owner,
      foreground: `user-${owner}`,
      threads: (await host.threads()).length,
    };
  }
  async alarm() {
    if (!this.owner) return;
    if (!this.ctx.id.equals(this.env.AIKO_ACCOUNTS.idFromName(accountObjectName(this.owner)))) {
      // Retired naming epochs retain their history, but cannot run the current account.
      await this.ctx.storage.deleteAlarm();
      this.ops("runtime.retired_alarm_disarmed", { owner: this.owner });
      return;
    }
    const alarmStarted = Date.now();
    try {
      const { host, capabilities, connectors } = await this.open(this.owner);
      await connectors.flushEvents();
      const at = Date.now();
      const tick = automationWakeEvent(
        await host.read(`user-${this.owner}`),
        at,
      );
      if (tick) await host.commitRoot(host.self(`user-${this.owner}`), tick);
      const promiseTick = promiseWakeEvent(
        await host.read(`user-${this.owner}`),
        at,
      );
      if (promiseTick)
        await host.commitRoot(host.self(`user-${this.owner}`), promiseTick);
      const loginAt=loginOperationNextWake(await host.read(`user-${this.owner}`),this.owner,`user-${this.owner}`);
      if(loginAt!==undefined&&loginAt<=at)await host.commitRoot(host.self(`user-${this.owner}`),loginOperationWakeEvent(this.owner,at));
      await host.alarm();
      await this.serialize(async () => {
        const deadline = await this.sandboxDeadline(host, capabilities);
        if (
          !capabilities ||
          deadline === undefined ||
          deadline > Date.now() ||
          capabilities.sandbox.busy ||
          !(await host.resting())
        )
          return;
        // Retire only this owner's cached browser, retaining the controller and durable VM/profile for later wake.
        if (!(await capabilities.browser.retire(this.owner!))) return;
        try {
          if (!(await capabilities.sandbox.stop())) {
            await this.ctx.storage.setAlarm(
              Math.min(
                (await this.ctx.storage.getAlarm()) ?? Infinity,
                Date.now() + 120_000,
              ),
            );
            return;
          }
          await host.drive();
        } catch (error) {
          await this.ctx.storage.setAlarm(
            Math.min(
              (await this.ctx.storage.getAlarm()) ?? Infinity,
              Date.now() + 120_000,
            ),
          );
          throw error;
        }
      });
    } catch (error) {
      this.failures++;
      this.ops("runtime.alarm_failed", {
        owner: this.owner,
        ms: Date.now() - alarmStarted,
        error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : String(error).slice(0, 500),
      });
      // A storage-timeout reset still drops this isolate. If we survived, keep a
      // near-term alarm so remaining native work is not stranded for the recovery delay.
      const current = await this.ctx.storage.getAlarm().catch(() => null);
      const retryAt = armAt(current, Date.now(), 1_000);
      if (retryAt !== null)
        await this.ctx.storage
          .setAlarm(retryAt)
          .catch(() => undefined);
    }
  }
  /** Receive-only RPC: resolve current configured capability again inside its owner DO. */
  async receiveChannel(owner:string,request:Request):Promise<Response>{
    return createChannelPublicIngress({lookup:async(route,token)=>{const grant=this.env.AIKO_CHANNEL_INGRESS?await this.env.AIKO_CHANNEL_INGRESS(route,token):await (await this.open(owner)).providerAdapters?.lookup(route,token);return grant?.owner===owner?grant:undefined;},hosted:async account=>account===owner?(await this.open(owner)).channels:undefined,wake:async()=>{const {host}=await this.open(owner);await this.kick(host);}})(request);
  }
  async handle(
    owner: string,
    request: Request,
    principal: Principal,
  ): Promise<Response> {
    if (!principal.operator && principal.owner !== owner)
      return json({ error: "forbidden" }, 403);
    if (!principal.scopes.includes(request.method === "GET" || /^\/(?:api|v1)\/databases\/query$/.test(new URL(request.url).pathname) ? "read" : "write"))
      return json({ error: "forbidden" }, 403);
    const handleStarted = Date.now();
    const handlePath = new URL(request.url).pathname;
    const { host, config, binding, databases, redact, capabilities, connectors, route, channels, media, registryReadiness:readiness } =
      await this.open(owner);
    const url = new URL(request.url);
    if (/^\/(?:api|v1)\/databases(?:\/|$)/.test(url.pathname)) return databaseApi(request, databases, {
      read: () => host.read(`user-${owner}`), commit: event => host.commitRoot(host.self(`user-${owner}`), event),
      wake: () => this.kick(host), serialize: run => this.serialize(run),
    }, { owner, scopes: principal.scopes });
    if (url.pathname === "/api/control/wake" && request.method === "POST") {
      if (!principal.operator) return json({ error: "forbidden" }, 403);
      await this.kick(host);
      return json({ status: "scheduled", account: owner }, 202);
    }
    if(["/api/media","/api/media/catalog"].includes(url.pathname)&&request.method==="POST")return mediaIngressApi(request,owner,media,()=>this.kick(host));
    if(["/api/provider-bridge/readiness","/v1/provider-bridge/readiness"].includes(url.pathname)&&request.method==="GET")return json(providerBridgeReadiness(channels,this.env.AIKO_CHANNEL_INGRESS??(await this.open(owner)).providerAdapters?.lookup));
    if(["/api/provider-bridge","/v1/provider-bridge"].includes(url.pathname))return providerBridgeApi(request,channels,()=>this.kick(host));
    if (url.pathname.startsWith("/api/harness/experiments/")) return registryExperimentApi(request, {
      owner,
      journal: { read: () => host.read(`user-${owner}`), append: events => host.seed(`user-${owner}`, events) },
      currentOwner: () => {
        const currentConfig = configOf(this.env, false), current = authenticate(request, currentConfig);
        return !!validOwner(currentConfig, owner) && !!current && (current.operator || current.owner === owner) &&
          current.scopes.includes(request.method === "GET" ? "read" : "write");
      },
      wake: () => this.kick(host),
    });
    if(["/api/harness/readiness","/v1/harness/readiness"].includes(url.pathname)&&request.method==="GET")return json(readiness());
    if (/^\/(?:api|v1)\/login-operations(?:\/|$)/.test(url.pathname))
      return this.serialize(async()=>{
        const recoveryAt=Date.now()+1000,current=await this.ctx.storage.getAlarm();
        if(current===null||current>recoveryAt)await this.ctx.storage.setAlarm(recoveryAt);
        return loginOperationApi(request,owner,host,connectors,principal,()=>{this.ctx.waitUntil(host.wake(`user-${owner}`));});
      });
    if (/^\/(?:api|v1)\/channels(?:\/|$)/.test(url.pathname))
      return channelApi(request, owner, channels, principal, () => {
        this.ctx.waitUntil(host.wake(`user-${owner}`));
      }, () => host.read(`user-${owner}`));
    if (["/api/secretary/work", "/v1/secretary/work"].includes(url.pathname))
      return this.serialize(() => secretaryWorkApi(request, createSecretaryWorkBinding(host, binding("user-" + owner),
        config.botToken ? secretaryTelegram(config.botToken) : undefined), () => this.kick(host)));
    if (/^\/(?:api|v1)\/secretary(?:\/|$)/.test(url.pathname))
      return this.serialize(() => secretaryApi(request, owner, host, redact));
    if (/^\/(?:api|v1)\/connectors(?:\/|$)/.test(url.pathname)) {
      // The connector engine serializes its own mutations. Private login and
      // progress must not wait behind an unrelated long-running actor slice.
      if (/\/native(?:\/progress)?$/.test(url.pathname)) return connectorApi(request, connectors, route);
      return this.serialize(() => connectorApi(request, connectors, route));
    }
    if (["/api/control/backup","/api/control/backups","/api/control/restore"].includes(url.pathname)) {
      if (!principal.operator) return json({error:"forbidden"},403);
      if (!this.env.AIKO_BACKUPS || !this.env.AIKO_BACKUP_KEY || !capabilities) return json({error:"backup_not_configured"},503);
      return this.serialize(async () => {
        const account = async ():Promise<AccountBackup> => {
          const memory=openMemory(binding(`user-${owner}`));
          try {
            const snapshot=this.ctx.storage.transactionSync(()=>({threads:host.exportHistory(),memory:memory.exportArchive()}));
            const state=[...(await this.ctx.storage.list()).entries()].filter(([key])=>!key.startsWith("backup:")&&!key.startsWith("codegraff:"));
            return {version:1,owner,...snapshot,state};
          } finally {memory.close();}
        };
        try {
          return await backupApi(request,{
            owner,backups:new CloudBackups(this.env.AIKO_BACKUPS!,this.env.AIKO_BACKUP_KEY!),sandbox:capabilities.sandbox,
            resting:()=>host.resting(),account,
            list:async()=>[...(await this.ctx.storage.list({prefix:"backup:"})).values()],
            record:async manifest=>{await this.ctx.storage.put(`backup:${manifest.id}`,{id:manifest.id,at:manifest.at,files:manifest.files.length,bytes:manifest.files.reduce((n,f)=>n+f.bytes,0)});},
            importAccount:async(id,archive)=>{
              if(!Array.isArray(archive.threads))throw Error("Invalid account history");
              // The native importer only accepts a fresh account or an exact
              // retry. Existing history and credential metadata are preserved.
              for(const [key,value] of archive.state) {
                if(typeof key!=="string"||key.startsWith("codegraff:")||key.startsWith("backup:"))throw Error("Invalid account state key");
                const current=await this.ctx.storage.get(key);
                if(current!==undefined && JSON.stringify(current)!==JSON.stringify(value))throw Error("Account state conflict");
              }
              const memory=openMemory(binding(`user-${owner}`));
              try {
                await host.importHistory(`backup:${id}`,archive.threads as {thread:string;events:Event[]}[],{fingerprint:createHash("sha256").update(JSON.stringify(archive.memory)).digest("hex"),import:()=>{memory.importArchive(archive.memory);}});
              } finally {memory.close();}
              await this.ctx.storage.put(Object.fromEntries(archive.state));
              await this.ctx.storage.sync();
            },
          });
        } catch {return json({error:"backup_or_restore_unavailable"},409);}
      });
    }
    if (
      url.pathname === "/api/control/sandbox/reconcile" &&
      request.method === "POST"
    ) {
      if (!principal.operator) return json({ error: "forbidden" }, 403);
      let input: { confirmAbsent?: unknown; startedAt?: unknown };
      try {
        input = JSON.parse(await boundedText(new Response(request.body), 512));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      if (
        !input ||
        Object.keys(input).sort().join(",") !== "confirmAbsent,startedAt" ||
        input.confirmAbsent !== true ||
        !Number.isSafeInteger(input.startedAt)
      )
        return json({ error: "explicit_verified_absence_required" }, 400);
      return this.serialize(async () => {
        if (
          !capabilities ||
          capabilities.sandbox.busy ||
          !(await host.resting())
        )
          return json({ error: "account_busy_or_sandbox_disabled" }, 409);
        const record = await capabilities.sandbox.status(),
          id = `absent:${input.startedAt}`;
        if (!("id" in record) && record.phase === "unallocated") {
          const duplicate = (await host.read(`user-${owner}`)).some(
            (e) => e.type === "AikoSandboxAllocationReconciled" && e.id === id,
          );
          return duplicate
            ? json({ status: "duplicate", allocation: "not_started" })
            : json({ error: "no_failed_allocation" }, 409);
        }
        if (
          !("startedAt" in record) ||
          record.startedAt !== input.startedAt ||
          record.id ||
          !["unknown", "provisioning"].includes(record.phase)
        )
          return json({ error: "allocation_changed_or_not_failed" }, 409);
        // The operator first verifies provider-side absence. This never retries automatically or adopts an arbitrary VM.
        await host.commitRoot(
          host.self(`user-${owner}`),
          event("AikoSandboxAllocationReconciled", {
            id,
            attempt: input.startedAt,
            decision: "operator_confirmed_absent",
          }),
        );
        await this.ctx.storage.delete("codegraff:sandbox");
        await this.ctx.storage.sync();
        await this.kick(host);
        return json({ status: "reconciled", allocation: "not_started" });
      });
    }
    if (url.pathname === "/api/control/import" && request.method === "POST") {
      if (!principal.operator) return json({ error: "forbidden" }, 403);
      return this.serialize(async () => {
        let input: {
          id?: unknown;
          threads?: { thread: string; events: Event[] }[];
          memory?: unknown;
        };
        try {
          input = JSON.parse(
            await boundedText(new Response(request.body), 8_000_000),
          );
        } catch {
          return json({ error: "invalid_import" }, 400);
        }
        if (
          typeof input.id !== "string" ||
          !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.id) ||
          !Array.isArray(input.threads) ||
          !input.threads.length ||
          input.threads.some(
            (h) =>
              !h ||
              typeof h.thread !== "string" ||
              !Array.isArray(h.events) ||
              h.events.some(
                (e) =>
                  !e ||
                  typeof e.type !== "string" ||
                  !loginOperationExternalEventAllowed(e) ||
                  !databaseExternalEventAllowed(e) ||
                  !registryExternalEventAllowed(e) || !workExternalEventAllowed(e) ||
                  typeof e.at !== "number" ||
                  !Number.isFinite(e.at),
              ),
          )
        )
          return json({ error: "invalid_import" }, 400);
        try {
          const memory = openMemory(binding(`user-${owner}`));
          try {
            const status = await host.importHistory(
              input.id,
              input.threads,
              input.memory === undefined
                ? undefined
                : {
                    fingerprint: createHash("sha256")
                      .update(JSON.stringify(input.memory))
                      .digest("hex"),
                    import: () => {
                      memory.importArchive(input.memory);
                    },
                  },
            );
            return json(
              {
                status,
                threads: input.threads.length,
                execution: "not_started",
                memory:
                  input.memory === undefined
                    ? "not_provided"
                    : "imported_native_journal",
              },
              201,
            );
          } finally {
            memory.close();
          }
        } catch {
          return json({ error: "import_conflict_or_unsettled_history" }, 409);
        }
      });
    }
    if (url.pathname === "/api/control/export" && request.method === "GET") {
      if (!principal.operator) return json({ error: "forbidden" }, 403);
      if (!(await host.resting())) return json({ error: "account_busy" }, 409);
      const memory = openMemory(binding(`user-${owner}`));
      try {
        const snapshot = this.ctx.storage.transactionSync(() => ({
          threads: host.exportHistory(),
          memory: memory.exportArchive(),
        }));
        return json({
          account: owner,
          actor: "aiko",
          instance: config.instanceId,
          ...snapshot,
        });
      } finally {
        memory.close();
      }
    }
    if (
      url.pathname === "/api/control/provider-check" &&
      request.method === "GET"
    ) {
      if (!principal.operator) return json({ error: "forbidden" }, 403);
      if (!capabilities)
        return json({ error: "live_capabilities_disabled" }, 503);
      const gateway = capabilities.sandbox.options.gateway;
      const checks: Record<string, unknown> = {};
      for (const capability of ["search", "sandboxes"] as const) {
        try {
          const result =
            capability === "search"
              ? await gateway.search("Eatigo Singapore")
              : await gateway.request("/v1/sandboxes");
          checks[capability] = {
            ok: true,
            count:
              capability === "search"
                ? result.results?.length
                : Array.isArray(result)
                  ? result.length
                  : null,
          };
        } catch (error) {
          checks[capability] = {
            ok: false,
            error: redact(
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : "unknown provider failure",
            ).slice(0, 400),
          };
        }
      }
      return json(checks);
    }
    if (
      [
        "/api/automations",
        "/v1/automations",
        "/api/control/automations",
      ].includes(url.pathname) &&
      request.method === "GET"
    )
      return json({
        owner,
        ...automationView(await host.read(`user-${owner}`)),
      });
    if (url.pathname.startsWith("/api/control/"))
      return controlApi({
        host,
        config,
        request,
        url,
        principal: { ...principal, owner },
        redact,
        serialize: (operation) => this.serialize(operation),
        validOwner: (account) => account === owner,
        memoryBindingFor: (account) => binding(`user-${account}`),
      });
    if (url.pathname === "/v1" && request.method === "GET")
      return json(planeManifest);
    if (request.method === "GET") {
      const response = planeMemoryRead(url, binding(`user-${owner}`));
      if (response) return response;
    }
    if (
      ["/v1/hooks", "/v1/hooks/unbrowse"].includes(url.pathname) &&
      request.method === "POST"
    ) {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return json({ error: "json_required" }, 415);
      let input;
      try {
        const body = JSON.parse(
          await boundedText(new Response(request.body), 24_000),
        );
        input = url.pathname.endsWith("/unbrowse")
          ? learningFromBrowserTrace(body)
          : validateLearningInput(body);
      } catch {}
      if (!input || redact(JSON.stringify(input)) !== JSON.stringify(input))
        return json({ error: "invalid_hook" }, 400);
      const accepted = input;
      return this.serialize(async () => {
        const thread = backgroundThread(owner, "indexer"),
          id = `hook:${accepted.id}`;
        const log = await host.read(thread);
        const prior = log.find(
          (e) => e.type === "AikoHookReceived" && e.id === id,
        );
        if (prior)
          return JSON.stringify(prior.input) === JSON.stringify(accepted)
            ? json({ status: "duplicate", id }, 202)
            : json({ error: "conflict" }, 409);
        const foreground = `user-${owner}`;
        await host.commitRoot(
          host.self(foreground),
          event("AikoAccountOpened", { id: "account" }),
        );
        await host.commitRoot(
          host.self(foreground),
          event("AikoHooksActivated", { id: "background-v1" }),
        );
        const source = parseThreadAddress(host.self(foreground)),
          target = parseThreadAddress(host.self(thread));
        await host.commit(
          envelopeOf(
            linkOf(source, target),
            event("AikoHookReceived", {
              id,
              input: accepted,
              cause: id,
              automationSignal: true,
            }),
            { parent: source, depth: 1, placement: "colocated" },
          ),
        );
        await this.kick(host);
        return json({ status: "accepted", id }, 202);
      });
    }
    const plane = url.pathname.startsWith("/v1/");
    const path = url.pathname.replace(/^\/v1\//, "/api/");
    const thread = `user-${owner}`;
    if (path === "/api/status" && request.method === "GET")
      return json({
        name: "Aiko",
        account: owner,
        protocol: "aiko-plane/v1",
        mode: config.mode,
        model: config.mode === "demo" ? "deterministic fixture" : config.model,
        isolation:
          "per-account Durable Object, native scoped thread logs and entity journal; persistent per-account Codegraff VM",
        fixtures: config.mode === "demo",
        telegram: !!config.botToken,
        toolCallLimit: null,
        codeMode: config.codeMode === true && !!capabilities,
        noProgressStop: false,
        publicWeb: !!capabilities,
        browser: capabilities ? "persistent Codegraff sandbox" : "disabled",
        failures: this.failures,
        memory: {
          engine: "entity-learn",
          storage: "account Durable Object SQLite",
          harness: "tardie@0.22.0",
        },
        sandbox: (await capabilities?.sandbox.status()) ?? null,
      });
    if (path === "/api/approvals" && request.method === "GET")
      return json({
        pending: capabilities?.browser.status(owner).pending ?? [],
      });
    if (path === "/api/browser" && request.method === "GET")
      return json(
        capabilities?.browser.status(owner) ?? {
          enabled: false,
          pending: [],
          observations: [],
        },
      );
    if (
      path === "/api/observed-actions/approval" &&
      request.method === "POST"
    ) {
      const log = withWatermark({
        read: Effect.promise(() => host.read(thread)),
        append: (events) =>
          Effect.promise(async () => {
            for (const event of events)
              await host.commitRoot(host.self(thread), event);
          }),
      });
      return Effect.runPromise(
        createActionApprovals({ owner, thread })
          .handleDecision(request, () =>
            Effect.succeed({
              owner,
              subject: `account:${owner}`,
              authenticated: true as const,
            }),
          )
          .pipe(Effect.provideService(EventLog, log)),
      );
    }
    if (
      ["/api/browser/approval", "/api/approvals"].includes(path) &&
      request.method === "POST"
    ) {
      let body;
      try {
        body = JSON.parse(await boundedText(new Response(request.body), 512));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      if (
        !body ||
        Object.keys(body).sort().join(",") !== "approve,id" ||
        typeof body.id !== "string" ||
        typeof body.approve !== "boolean"
      )
        return json({ error: "invalid_approval" }, 400);
      return capabilities?.browser.decide(owner, body.id, body.approve)
        ? json({ status: "decision_received" }, 202)
        : json({ error: "not_found_or_expired" }, 404);
    }
    if (path === "/api/messages" && request.method === "GET") {
      const log = await Promise.all(((await host.read(thread)) as AikoEvent[]).map(async event => event.type === "AikoReplyPrepared" ? { ...event, result: await reauthorizeReplyResult(databases, event.result, request.signal) } : event));
      return json(
        JSON.parse(
          redact(
            JSON.stringify({
              messages: log
                .filter((e) =>
                  [
                    "MessageReceived",
                    "AikoControlReply",
                    "AikoReplyPrepared",
                  ].includes(e.type) || (e.type === "AikoProgressSettled" && (e.result as any)?.status === "delivered"),
                )
                .slice(-100)
                .map((e) =>
                  e.type === "AikoReplyPrepared" || e.type === "AikoProgressSettled"
                    ? {
                        id: e.type === "AikoProgressSettled" ? `progress:${e.key}` : `reply:${e.turn}`,
                        turn: e.turn,
                        role: "assistant",
                        ...(e.type === "AikoProgressSettled" ? { progress: true } : {}),
                        ...(e.result as object),
                        at: e.at,
                      }
                    : {
                        id: e.id,
                        role: "user",
                        text: e.text,
                        ...(e.media ? { media: e.media } : {}),
                        at: e.at,
                      },
                ),
              deliveries: log
                .filter(
                  (e) =>
                    e.type === "AikoDeliverySettled" ||
                    (e.type === "AikoTelegramActionSettled" &&
                      [
                        "telegram_send",
                        "telegram_voice",
                        "telegram_screenshot",
                      ].includes(
                        (e.result as { action?: string } | undefined)?.action ??
                          "",
                      )),
                )
                .slice(-50)
                .map((e) => ({ turn: e.turn, result: e.result })),
              pending: log
                .filter(
                  (e) =>
                    e.type === "MessageReceived" &&
                    !turnTerminalOf(log, String(e.id)) &&
                    !log.some(
                      (r) => r.type === "AikoReplyPrepared" && r.turn === e.id &&
                        Number(r.epoch ?? 0) === turnEpochOf(log, String(e.id)),
                    ),
                )
                .map((e) => e.id),
            }),
          ),
        ),
      );
    }
    if (path === "/api/messages" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return json({ error: "json_required" }, 415);
      let body;
      try {
        body = JSON.parse(await boundedText(new Response(request.body), 8192));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      if (
        !body ||
        Object.keys(body).sort().join(",") !== "id,text" ||
        typeof body.id !== "string" ||
        !/^[A-Za-z0-9_-]{8,80}$/.test(body.id) ||
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > 4000
      )
        return json({ error: "invalid_message" }, 400);
      const id = `${plane ? "plane" : "local"}:${body.id}`;
      const status = await this.accept(
        owner,
        id,
        body.text.trim(),
        plane ? "plane" : "local",
      );
      return json({ status, id }, status === "conflict" ? 409 : 202);
    }
    if (path === "/api/cancel" && request.method === "POST") {
      let body;
      try {
        body = JSON.parse(await boundedText(new Response(request.body), 512));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      const log = await host.read(thread);
      if (
        typeof body?.id !== "string" ||
        !log.some((e) => e.type === "MessageReceived" && e.id === body.id)
      )
        return json({ error: "not_found" }, 404);
      const workerStops=await workerCancellations(thread.slice(5),log,body.id,t=>host.read(t));
      if (turnTerminalOf(log, body.id)&&!workerStops.length)
        return json({ error: "already_terminal" }, 409);
      for(const envelope of workerStops)await host.commit(envelope);
      await host.commitRoot(
        host.self(thread),
        cancellationRequested({
          invocation: {
            method: "message",
            id: body.id,
            epoch: turnEpochOf(log, body.id),
          },
          request: `cancel:${body.id}:${turnEpochOf(log, body.id)}`,
          cause: "requested",
          reason: "Cancelled by the owner",
          at: Date.now(),
        }),
      );
      await this.kick(host);
      return json({ status: "cancelling" }, 202);
    }
    return json({ error: "not_found" }, 404);
  }
}

export default {
  async fetch(
    request: Request,
    env: AikoCloudflareEnv,
    ctx?: { waitUntil(promise: Promise<unknown>): void },
  ): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        request.headers.get("origin") &&
        request.headers.get("origin") !== url.origin
      )
        return json({ error: "invalid_origin" }, 403);
      if (
        request.method === "GET" &&
        (url.pathname === "/connect" ||
          url.pathname === "/connect.html" ||
          url.pathname === "/password-manager-callback.html" ||
          url.pathname.startsWith("/assets/")) &&
        env.CONNECTOR_ASSETS
      ) {
        const target = new URL(request.url);
        if (target.pathname === "/connect") target.pathname = "/connect.html";
        const asset = await env.CONNECTOR_ASSETS.fetch(
          new Request(target, request),
        );
        const response = new Response(asset.body, asset);
        response.headers.set("Referrer-Policy", "no-referrer");
        if (url.pathname.startsWith("/connect") || url.pathname === "/password-manager-callback.html")
          response.headers.set("Cache-Control", "no-store");
        return response;
      }
      if (["/", "/control"].includes(url.pathname) && request.method === "GET")
        return new Response(
          url.pathname === "/control" ? CONTROL_HTML : CONSOLE_HTML,
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy":
                "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
              "x-frame-options": "DENY",
              "referrer-policy": "no-referrer",
            },
          },
        );
      // Owner control of retained experiments does not require a model secret.
      const experimentControl = /^\/api\/harness\/experiments\/[^/]+\/(cancel|status)$/.test(url.pathname);
      const config = configOf(env, !experimentControl && url.pathname !== "/api/harness/readiness");
      if(url.pathname.startsWith("/v1/channel-ingress/")){
        if(request.method!=="POST")return json({error:"receive_only"},405);
        const route=/^\/v1\/channel-ingress\/([A-Za-z0-9_-]{1,160})$/.exec(url.pathname),token=request.headers.get("x-channel-receive-capability");
        if(!route||url.search)return json({error:"channel_ingress_route"},404);
        if(!token||token.length>1024)return json({error:"receive_capability_required"},401);
        const generatedOwner=providerAdapterRouteOwner(route[1]!);
        if(!env.AIKO_CHANNEL_INGRESS && generatedOwner && validOwner(config,generatedOwner) && env.AIKO_PROVIDER_ADAPTERS)
          return env.AIKO_ACCOUNTS.getByName(accountObjectName(generatedOwner)).receiveChannel(generatedOwner,request);
        const grant=await env.AIKO_CHANNEL_INGRESS?.(route[1]!,token);
        if(!grant||grant.scope!=="receive"||grant.expiresAt<=Date.now()||!safeUserId(grant.owner)||!validOwner(config,grant.owner))return json({error:"receive_capability_denied"},403);
        return env.AIKO_ACCOUNTS.getByName(accountObjectName(grant.owner)).receiveChannel(grant.owner,request);
      }

      if (
        ["/health", "/ready"].includes(url.pathname) &&
        request.method === "GET"
      )
        return json({
          name: "Aiko",
          mode: config.mode,
          status: "ready",
          verboseFallbacks: config.verboseFallbacks === true,
          verboseFallbacksSince: config.verboseFallbacksSince ?? 0,
          storage: "durable-object",
          harness: "tardie@0.22.0",
          models: {
            ...Object.fromEntries(
              Object.entries(config.modelRouting!.roles).map(
                ([role, route]) => [
                  role,
                  { provider: route.provider, model: route.model,
                    ...(config.modelRouting!.fallbacks?.[role as "conversation" | "rag" | "browser"]?.length
                      ? { fallbacks: config.modelRouting!.fallbacks![role as "conversation" | "rag" | "browser"]!.map(({provider, model}) => ({provider, model})) } : {}),
                  },
                ],
              ),
            ),
            vision: {
              provider:
                env.AIKO_VISION_PROVIDER ??
                config.modelRouting!.roles.conversation.provider,
              model:
                env.AIKO_VISION_MODEL ??
                config.modelRouting!.roles.conversation.model,
            },
          },
          replyStyle: config.replyStyle,
          capabilities: {
            inference: config.mode === "live",
            memory: true,
            search: config.mode === "live",
            browser: config.mode === "live",
            persistentSandbox: config.mode === "live",
            commandSandbox: config.mode === "live",
          },
          telegram: { enabled: !!config.botToken, mode: "webhook" },
        });
      // Migration attestation is an operator control-plane read despite POST.
      // Keep it before namespace lookup: proving deployed credentials must not
      // create an account, wake an actor, send Telegram updates or call a provider.
      if (url.pathname === "/api/control/telegram-attest") {
        const principal = authenticate(request, config);
        if (!principal) return json({ error: "unauthorized" }, 401);
        if (!principal.operator) return json({ error: "forbidden" }, 403);
        if (request.method !== "POST") {
          const response = json({ error: "method_not_allowed" }, 405);
          response.headers.set("allow", "POST");
          return response;
        }
        let nonce: string;
        try {
          if (
            url.search ||
            request.headers
              .get("content-type")
              ?.split(";", 1)[0]
              ?.trim()
              .toLowerCase() !== "application/json"
          )
            return json({ error: "invalid_body" }, 400);
          const body: unknown = JSON.parse(
            await boundedText(new Response(request.body), 256),
          );
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            Object.keys(body).length !== 1 ||
            !("nonce" in body) ||
            typeof body.nonce !== "string" ||
            !/^[a-f0-9]{64}$/.test(body.nonce)
          )
            return json({ error: "invalid_body" }, 400);
          nonce = body.nonce;
        } catch {
          return json({ error: "invalid_body" }, 400);
        }
        if (
          !config.botToken ||
          !/^[1-9]\d{0,15}:[A-Za-z0-9_-]{16,256}$/.test(config.botToken) ||
          !config.webhookSecret ||
          !/^[A-Za-z0-9_-]{32,256}$/.test(config.webhookSecret)
        )
          return json({ error: "telegram_unavailable" }, 503);
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw",
          encoder.encode(config.webhookSecret),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        );
        const signature = await crypto.subtle.sign(
          "HMAC",
          key,
          encoder.encode(
            JSON.stringify([
              "aiko.telegram-cutover/v1",
              nonce,
              config.botToken,
            ]),
          ),
        );
        const proof = [...new Uint8Array(signature)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        return json({ botId: config.botToken.split(":", 1)[0], proof });
      }
      const registry = env.AIKO_REGISTRY.getByName("accounts");
      if (url.pathname === "/telegram/webhook") {
        const telegram = telegramOf(config);
        if (!telegram) return json({ error: "telegram_unavailable" }, 503);
        const received = await telegram.receive(request);
        if (!received.inbound)
          return json({ ok: received.status === 200 }, received.status);
        const owner = received.inbound.user;
        if (!(await registry.admit(owner, config.maxAccounts)))
          return json({ error: "limited" }, 429);
        const inbound = received.inbound;
        const pending = env.AIKO_ACCOUNTS.getByName(
          accountObjectName(owner),
        ).acceptTelegram(owner, inbound);
        const answer = () =>
          inbound.callback
            ? telegram
                .answerCallback(
                  owner,
                  inbound.callback.id,
                  AbortSignal.timeout(5_000),
                )
                .catch(() => undefined)
            : Promise.resolve();
        return telegramWebhookResponse(pending, answer, ctx ? work => ctx.waitUntil(work) : undefined);
      }
    if (url.pathname === "/api/connectors/session" && request.method === "POST") {
      const owner = config.botToken && verifyInitData(request.headers.get("x-telegram-init-data") ?? (request.headers.get("authorization")?.startsWith("tma ") ? request.headers.get("authorization")!.slice(4) : ""), config.botToken);
      if (!owner || !validOwner(config, owner)) return json({ error: "unauthorized" }, 401);
      return json({ token: createMiniAppSession(owner, config.botToken!) });
    }
      const principal = authenticate(request, config);
      if (!principal) return json({ error: "unauthorized" }, 401);
      if (
        !principal.scopes.includes(request.method === "GET" || /^\/(?:api|v1)\/databases\/query$/.test(url.pathname) ? "read" : "write")
      )
        return json({ error: "forbidden" }, 403);
      if (url.pathname === "/api/control/messages") {
        if (!principal.operator) return json({ error: "forbidden" }, 403);
        if (request.method !== "POST")
          return json({ error: "method_not_allowed" }, 405);
        let body;
        try {
          body = JSON.parse(
            await boundedText(new Response(request.body), 20_000),
          );
        } catch {
          return json({ error: "invalid_body" }, 400);
        }
        if (
          !body ||
          Object.keys(body).sort().join(",") !== "account,channel,id,text" ||
          typeof body.account !== "string" ||
          !/^[1-9]\d{0,15}$/.test(body.account) ||
          body.channel !== "telegram" ||
          typeof body.id !== "string" ||
          !/^[A-Za-z0-9_-]{1,100}$/.test(body.id) ||
          typeof body.text !== "string" ||
          !body.text.trim() ||
          body.text.length > 12_000
        )
          return json({ error: "invalid_body" }, 400);
        if (
          !(await registry.list()).some((entry) => entry.owner === body.account)
        )
          return json({ error: "not_found" }, 404);
        const status = await env.AIKO_ACCOUNTS.getByName(
          accountObjectName(body.account),
        ).acceptOperatorMessage(body.account, body.id, body.text);
        return json(
          { status, id: `operator:${body.id}`, channel: "telegram" },
          status === "conflict" ? 409 : 202,
        );
      }
      if (
        url.pathname === "/api/control/accounts" &&
        request.method === "GET"
      ) {
        const owners = principal.operator
          ? (await registry.list()).map((entry) => entry.owner)
          : [principal.owner];
        if (!owners.includes(principal.owner)) owners.unshift(principal.owner);
        const accounts = [];
        for (const owner of owners)
          accounts.push(
            await env.AIKO_ACCOUNTS.getByName(
              accountObjectName(owner),
            ).describe(owner),
          );
        return json({
          operator: principal.operator,
          writable: principal.scopes.includes("write"),
          accounts,
        });
      }
      let owner = url.pathname.startsWith("/api/control/")
        ? (url.searchParams.get("account") ?? principal.owner)
        : principal.owner;
      if (url.pathname === "/api/control/events")
        owner =
          threadBinding(url.searchParams.get("thread") ?? "")?.owner ?? "";
      if (url.pathname === "/api/control/hooks" && request.method === "POST") {
        try {
          const body = JSON.parse(
            await boundedText(new Response(request.clone().body), 512),
          );
          owner = body.account;
        } catch {
          return json({ error: "invalid_body" }, 400);
        }
      }
      if (
        !safeUserId(owner) ||
        (!principal.operator && owner !== principal.owner) ||
        (!principal.operator && !validOwner(config, owner))
      )
        return json({ error: "forbidden" }, 403);
      if (
        request.method !== "GET" &&
        !(await registry.admit(owner, config.maxAccounts))
      )
        return json({ error: "limited" }, 429);
      return await env.AIKO_ACCOUNTS.getByName(accountObjectName(owner)).handle(
        owner,
        request,
        principal,
      );
    } catch (error) {
      workerOps("request.failed", {
        path: new URL(request.url).pathname.slice(0, 60),
        method: request.method,
        error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : "unknown",
      });
      return json({ error: "service_unavailable" }, 503);
    }
  },
};
