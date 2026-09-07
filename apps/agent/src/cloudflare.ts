import { approvalMenu } from "./telegram-mini-app.ts";
import { agentKeys } from "tardie/log/events";
import { cancellationKeys, methodCallKeys, methodResponseKeys, methodTimeoutKeys, methodIngressKeyOf } from "tardie/core/method";
import { turnEpochOf, turnTerminalOf } from "tardie/code/execution/turns";
import { validateActor } from "tardie/core/actor";
import { withRequiredResponse } from "./channel-response.ts";
import { nativeBrowserConnector } from "./native-browser-connector.ts";
import { acceptSecretary, createSecretaryActor, secretaryApi, secretaryCommand, secretaryEventKey, withSecretaryHistory } from "./secretary.ts";
import { secretaryTelegram } from "./secretary-telegram.ts";
import { createModelRouting, parseModelRouting } from "./model-routing.ts";
import { withRoleInference } from "./inference-routing.ts";
import { connectorVault, parseConnectorVault } from "./connector-vault.ts";
import { createToolRouterActor, routerEventKey } from "./tool-router.ts";
import { routerCaller, validateRouterInput } from "./connector-router-host.ts";
import { WorkflowController, createWorkflowStore, workflowDispatcher } from "./workflow-host.ts";
import { ConnectorEngine } from "./connectors.ts";
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
import { memoryScope, memoryTools, openMemory, type MemoryBinding } from "./memory.ts";
import { Effect, Layer } from "effect";
import { CodeHarness } from "./code-harness.ts";
import { createCodeChildActor } from "./code-agents.ts";
import { createCloudflareCapabilities } from "./cloudflare-capabilities.ts";
import { createVoice, createThinkFeelComposer } from "./voice.ts";
import {
  createTelegram,
  redactTelegramInbound,
  serializeTelegramInbound,
  type TelegramInbound,
} from "./telegram.ts";
import {
  createTelegramTools,
  createTelegramTyping,
  createTelegramVision,
  telegramEventKey,
} from "./telegram-tools.ts";
import { controlCommand, telegramControl, createControlActor } from "./telegram-control.ts";
import { credentialDigest, parsePlaneCredentials } from "./plane-auth.ts";
import {
  boundedText,
  equalSecret,
  redactor,
  safeUserId,
  verifyInitData,
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
import { automationNextWake, automationEventKey, automationView, automationWakeEvent, automationAppendAllowed } from "./automations.ts";
import { CONSOLE_HTML } from "./console.ts";
import type { AikoConfig } from "./config.ts";

export interface AikoCloudflareEnv {
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
  ARCADE_API_KEY?: string;
  AIKO_CODE_MODE?: string;
  AIKO_CONNECTOR_VAULT_JSON?: string;
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
function configOf(env: AikoCloudflareEnv): AikoConfig {
  const mode = env.AIKO_MODE ?? "live";
  if (mode !== "demo" && mode !== "live")
    throw new Error("Invalid deployment mode");
  const replyStyle = env.AIKO_REPLY_STYLE ?? "thinkfeel";
  if (replyStyle !== "thinkfeel" && replyStyle !== "direct") throw new Error("Invalid reply style");
  const instanceId = env.AIKO_INSTANCE_ID ?? "demo";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId))
    throw new Error("Invalid actor instance");
  if (!env.AIKO_OPERATOR_TOKEN || env.AIKO_OPERATOR_TOKEN.length < 24)
    throw new Error("Operator authentication is not configured");
  if (mode === "live" && !env.CODEGRAFF_API_KEY)
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
    modelRouting: parseModelRouting({AIKO_MODEL: env.AIKO_MODEL, AIKO_RAG_PROVIDER: env.AIKO_RAG_PROVIDER, AIKO_RAG_MODEL: env.AIKO_RAG_MODEL, AIKO_BROWSER_PROVIDER: env.AIKO_BROWSER_PROVIDER, AIKO_BROWSER_MODEL: env.AIKO_BROWSER_MODEL, AIKO_CONVERSATION_PROVIDER: env.AIKO_CONVERSATION_PROVIDER, AIKO_CONVERSATION_MODEL: env.AIKO_CONVERSATION_MODEL}, {contextWindowTokens: env.AIKO_MODEL === "glm-5.3-flash" ? 1000000 : 32768, maxOutputTokens:4096}),
    arcadeKey: env.ARCADE_API_KEY,
    codeMode: env.AIKO_CODE_MODE === "true",
    connectorVault: parseConnectorVault(env.AIKO_CONNECTOR_VAULT_JSON),
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
    voiceEnabled: replyStyle === "thinkfeel" && env.AIKO_VOICE_ENABLED === "true",
    replyStyle,
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
  const auth = request.headers.get("authorization") ?? (request.headers.has("x-telegram-init-data") ? `tma ${request.headers.get("x-telegram-init-data")}` : "");
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
export const accountObjectName = (owner: string) => `${ACCOUNT_OBJECT_EPOCH}:${owner}`;

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
    redact(text: string): string;
    capabilities?: ReturnType<typeof createCloudflareCapabilities>;
    connectors: ConnectorEngine;
    route: ReturnType<typeof routerCaller>;
  }>;
  private admission = Promise.resolve();
  private failures = 0;
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
      (this.ctx.id.name !== undefined &&
        this.ctx.id.name !== accountObjectName(owner))
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
          error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 400) : "unknown",
        );
        throw error;
      });
    return this.runtime;
  }
  private async makeRuntime(owner: string) {
    const config = configOf(this.env);
    const redact = redactor([
      config.operatorToken,
      config.modelKey ?? "",
      config.cerebrasKey ?? "",
      config.arcadeKey ?? "",
      ...Object.values(config.connectorVault?.accounts ?? {}).map(a => a.token),
      config.botToken ?? "",
      config.webhookSecret ?? "",
      config.voiceKey ?? "",
    ]);
    const nativeStorage = cloudflareStorage(this.ctx.storage);
    const requireThinkFeel = config.mode === "live" && config.replyStyle !== "direct";
    const compose = requireThinkFeel ? createThinkFeelComposer({
      key: config.voiceKey, persona: config.persona, redact,
    }) : undefined;
    const voice = createVoice({
      enabled: config.voiceEnabled,
      key: config.voiceKey,
      persona: config.persona,
      compose,
      required: requireThinkFeel,
    });
    let host: CloudflareAccountHost;
    const bindingOf = (thread: string) => threadBinding(thread) ??
      (host?.rootThread(thread) === `user-${owner}` ? {owner,role:"child" as const} : undefined);
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
      };
    };
    const updateApprovalMenu=approvalMenu({owner,token:config.botToken});
    const capabilities =
      config.mode === "live"
        ? createCloudflareCapabilities({
            owner,
            onApprovalsChanged: (_owner,count) => updateApprovalMenu(count),
            env: { CODEGRAFF_API_KEY: config.modelKey! },
            storage: this.ctx.storage,
            memory: binding(`user-${owner}`),
            unlock: { config: config.connectorVault, engine:()=>connectors },
            emit: async (record) => {
              await host.commitRoot(
                host.self(`user-${owner}`),
                record as Event,
              );
            },
          })
        : undefined;
    const codeHarnesses = new Map<string, CodeHarness>();
    const harnessFor = (thread: string) => {
      if (!config.codeMode || !capabilities) return undefined;
      let harness = codeHarnesses.get(thread);
      if (!harness) {
        if (bindingOf(thread)?.owner !== owner) throw new Error("Foreign code harness binding");
        harness = new CodeHarness(owner,thread,(input,signal)=>capabilities.sandbox.codeSegment(input,signal),redact,workflowStore);
        codeHarnesses.set(thread,harness);
      }
      return harness;
    };
    const telegram = telegramOf(config, {
      redact,
      mediaProcessor: capabilities?.sandbox.processMedia,
    });
    const connectors: ConnectorEngine = new ConnectorEngine({ owner, secureBrowser: connectorVault(config.connectorVault, owner) ?? (capabilities ? nativeBrowserConnector(owner, capabilities.sandbox.browserFactory()) : undefined), env: { ARCADE_API_KEY: config.arcadeKey }, store: {
      get: key => this.ctx.storage.get(key),
      set: (key, value) => this.ctx.storage.put(key, value),
      list: async prefix => [...(await this.ctx.storage.list({ prefix })).values()],
    }, onEvent: async e => {
      await host.commitRoot(host.self(`user-${owner}`),event("AikoHooksActivated",{id:"background-v1"}));
      await host.commitRoot(host.self(`user-${owner}`),e);
      await this.kick(host);
    }, readOwnedLogs: async boundOwner => (await host.read(`user-${boundOwner}`)).filter(e => e.type === "AikoApiObserved" && e.owner === boundOwner).map(e => ({ owner: boundOwner, id: String(e.id), text: `${e.method} ${e.url}` })) });
    const workflowStore = createWorkflowStore({get:key=>this.ctx.storage.get(key),put:(key,value)=>this.ctx.storage.put(key,value),list:async prefix=>[...(await this.ctx.storage.list({prefix})).values()],update:async(key,change)=>{await this.ctx.storage.transaction(async txn=>{await txn.put(key,change(await txn.get(key)));});},claim:(key,value)=>this.ctx.storage.transaction(async txn=>{if(await txn.get(key)!==undefined)return false;await txn.put(key,value);return true;})});
    const workflows = new WorkflowController(owner,`user-${owner}`,{
      store:workflowStore,
      dispatcher:workflowDispatcher({owner,engine:connectors,redact,readEvents:()=>host.read(`user-${owner}`)}),guard:validateRouterInput,
    },redact);
    const routerBinding = { owner, engine: connectors, redact, readOwnedEvents: () => host.read(`user-${owner}`), listWorkflows:()=>workflows.engine.list(), vaultDomains: async () => Object.keys(config.connectorVault?.accounts[owner]?.connections ?? {}) };
    const route = routerCaller(routerBinding, () => host);
    const telegramTyping = telegram && createTelegramTyping(owner, telegram, { waitForDelivery: true });
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
                  provider: this.env.AIKO_VISION_PROVIDER ?? config.modelRouting!.roles.conversation.provider,
                  apiKey: (this.env.AIKO_VISION_PROVIDER ?? config.modelRouting!.roles.conversation.provider) === "cerebras" ? config.cerebrasKey! : config.modelKey!,
                  model: this.env.AIKO_VISION_MODEL ?? config.modelRouting!.roles.conversation.model,
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
    const routing = config.mode === "live" && config.modelRouting ? createModelRouting({owner, config: config.modelRouting, env: {CODEGRAFF_API_KEY: config.modelKey, CEREBRAS_API_KEY: config.cerebrasKey, AIKO_ALLOW_PAID_INFERENCE: "true"},stream:{firstChunkMs:90000,idleMs:90000,totalMs:300000}}) : undefined;
    const model = withSpokenHistory(
      config.mode === "demo"
        ? demoInference
        : routing ? withRoleInference(role => routing.layer(role)) : modelInference(
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
              throttleRetryDelaysMs: [],
              // Native Tardigrade stream bounds handle provider stalls. Do not
              // shorten them below long-context prefill/thinking latency.
            },
            modelAdapters(openAICompatibleAdapter),
          ),
    );
    host = await createCloudflareAccountHost({
      storage: this.ctx.storage,
      actorName: "aiko",
      actorInstance: config.instanceId!,
      ownsThread: (thread) => threadBinding(thread)?.owner === owner,
      allowChild: (parent,child) => config.codeMode === true && parent === `user-${owner}` && /^ag\.[0-9]+:/.test(child) && child.length < 2048,
      nextWake: async () => {
        const times = [await this.sandboxDeadline(host, capabilities), automationNextWake(await host.read(`user-${owner}`))].filter((n): n is number => n !== undefined);
        return times.length ? Math.min(...times) : undefined;
      },
      keyOf: (e) =>
      agentKeys.keyOf(e) ?? cancellationKeys.keyOf(e) ?? methodCallKeys.keyOf(e) ?? methodResponseKeys.keyOf(e) ?? methodTimeoutKeys.keyOf(e) ?? methodIngressKeyOf(e) ??
        secretaryEventKey(e) ??
        automationEventKey(e) ??
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
      canAppend: (_thread, events, read) => automationAppendAllowed(events, read),
      actorFor: (thread) => {
        const bound = bindingOf(thread)!;
        let definition = actors.get(thread);
        if (!definition) {
          const memory = binding(thread);
          definition =
            bound.role === "child"
              ? createCodeChildActor(harnessFor(thread)!,[...memoryTools(memory,{fixtures:false}),...(capabilities ? [capabilities.searchFor(memory)] : [])])
              : bound.role === "secretary"
              ? createSecretaryActor({ owner, redact, read: () => host.read(thread), telegram: config.botToken ? secretaryTelegram(config.botToken) : undefined })
              : bound.role === "control"
              ? createControlActor({ owner, voice, send: telegram?.send, live: requireThinkFeel, redact, publish: rows => host.seed(`user-${owner}`, rows) })
              : bound.role === "router"
              ? createToolRouterActor(routerBinding)
              : bound.role === "indexer"
              ? createIndexerActor(memory,(id,signal)=>connectors.initialContext(id,signal))
              : bound.role === "reflection"
                ? createReflectionActor(memory)
                : createAikoActor({
                    automations: true,
                    owner,
                    memory,
                    voice,
                    live: config.mode === "live",
                    publicWeb: false,
                    send: telegram?.send,
                    background: true,
                    toolRouter: { owner, thread, redact, readRouter: () => host.read(`router-${owner}`) },
                    workflow: workflows.component(),
                    workflowTools: workflows.codeTools(),
                    codeHarness: harnessFor(thread),
                    capabilityBuilder: { owner, thread, redact, checkArcade: async domain => (await connectors.search(domain)).fallbackAllowed,
                      session: (origin, signal) => ensureUnlockSession({ owner, origin, config: config.connectorVault, search: domain => connectors.search(domain), signal, renew: true }) },
                    connectors: { owner, thread, engine: connectors, deliverConnection: async (input, signal) => {
                      if (!telegram || input.owner !== owner) return { status: "rejected" as const };
                      const wording = compose ? await compose(input.text, signal) : undefined;
                      if (requireThinkFeel && wording?.status !== "ready") return { status: "rejected" as const };
                      return telegram.sendRich(owner, { kind: "text", text: wording?.status === "ready" ? wording.text : input.text, buttons: input.buttons }, signal);
                    } },
                    toolCallLimit: null,
                    requireThinkFeel,
                    ...(telegramTyping ? { telegramTyping } : {}),
                    extraTools: [
                      ...telegramTools,
                      ...(capabilities ? [capabilities.search] : []),
                    ],
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
        const role=bindingOf(thread)?.role;
        const base=role === "secretary" ? withSecretaryHistory(model) : role === "foreground"
          ? withRequiredResponse(workflows.inference(capabilities ? capabilities.browser.inference(model,owner) : model),redact) : model;
        const harness=role === "foreground" || role === "child" ? harnessFor(thread) : undefined;
        return harness ? Layer.merge(harness.inference(base),harness.sandboxLayer()) : base;
      },
    });
    return { host, config, binding, redact, capabilities, connectors, route };
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
    await this.ctx.storage.setAlarm(Math.min(alarm ?? Infinity, Date.now() + 1));
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
        e.type !== "AikoAutomationTick" && typeof e.at === "number" && Number.isFinite(e.at)
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
      const { host, config, redact } = await this.open(owner);
      if (!validOwner(config, owner))
        throw new Error("Account is not authorized");
      if (inbound?.secretary) {
        const status = await acceptSecretary(host, owner, redactTelegramInbound(inbound, redact));
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
        return prior.source === source && prior.text === redact(text) &&
          (!prior.telegramDigest || prior.telegramDigest === telegramDigest)
          ? "duplicate"
          : "conflict";
      await host.commitRoot(
        host.self(thread),
        event("AikoHooksActivated", { id: "background-v1" }),
      );
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
            stoppedDraftId: normalized?.stoppedDraftId, messageThreadId: normalized?.messageThreadId,
            secretary: text => secretaryCommand(host, owner, text, redact),
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
          ...(source === "operator" ? { channel: "telegram", chat: owner, sender: "operator" } : {}),
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
    if (!/^[1-9]\d{0,15}$/.test(owner) || !(await host.read(`user-${owner}`)).some(e =>
      e.type === "MessageReceived" && e.source === "telegram" && String(e.chat) === owner && String(e.sender) === owner))
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
    try {
      const { host, capabilities, connectors } = await this.open(this.owner);
      await connectors.flushEvents();
      const at = Date.now();
      const tick = automationWakeEvent(await host.read(`user-${this.owner}`), at);
      if (tick) await host.commitRoot(host.self(`user-${this.owner}`), tick);
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
            await this.ctx.storage.setAlarm(Math.min(await this.ctx.storage.getAlarm() ?? Infinity, Date.now() + 120_000));
            return;
          }
          await host.drive();
        } catch (error) {
          await this.ctx.storage.setAlarm(Math.min(await this.ctx.storage.getAlarm() ?? Infinity, Date.now() + 120_000));
          throw error;
        }
      });
    } catch {
      // A storage-timeout reset still drops this isolate. If we survived, keep a
      // near-term alarm so remaining native work is not stranded for the recovery delay.
      const current = await this.ctx.storage.getAlarm().catch(() => null);
      if (current === null)
        await this.ctx.storage.setAlarm(Date.now() + 1_000).catch(() => undefined);
    }
  }
  async handle(
    owner: string,
    request: Request,
    principal: Principal,
  ): Promise<Response> {
    if (!principal.operator && principal.owner !== owner)
      return json({ error: "forbidden" }, 403);
    if (!principal.scopes.includes(request.method === "GET" ? "read" : "write"))
      return json({ error: "forbidden" }, 403);
    const { host, config, binding, redact, capabilities, connectors, route } =
      await this.open(owner);
    const url = new URL(request.url);
    if (/^\/(?:api|v1)\/secretary(?:\/|$)/.test(url.pathname))
      return this.serialize(() => secretaryApi(request, owner, host, redact));
    if (/^\/(?:api|v1)\/connectors(?:\/|$)/.test(url.pathname)) return connectorApi(request, connectors, route);
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
    if (["/api/automations", "/v1/automations", "/api/control/automations"].includes(url.pathname) && request.method === "GET")
      return json({ owner, ...automationView(await host.read(`user-${owner}`)) });
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
            event("AikoHookReceived", { id, input: accepted, cause: id, automationSignal: true }),
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
      return json({pending: capabilities?.browser.status(owner).pending ?? []});
    if (path === "/api/browser" && request.method === "GET")
      return json(
        capabilities?.browser.status(owner) ?? {
          enabled: false,
          pending: [],
          observations: [],
        },
      );
    if (path === "/api/observed-actions/approval" && request.method === "POST") {
      const log = withWatermark({
        read: Effect.promise(() => host.read(thread)),
        append: events => Effect.promise(async () => { for (const event of events) await host.commitRoot(host.self(thread), event); }),
      });
      return Effect.runPromise(createActionApprovals({ owner, thread }).handleDecision(request, () => Effect.succeed({ owner, subject: `account:${owner}`, authenticated: true as const })).pipe(Effect.provideService(EventLog, log)));
    }
    if (["/api/browser/approval", "/api/approvals"].includes(path) && request.method === "POST") {
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
      const log = (await host.read(thread)) as AikoEvent[];
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
                  ].includes(e.type),
                )
                .slice(-100)
                .map((e) =>
                  e.type === "AikoReplyPrepared"
                    ? {
                        id: `reply:${e.turn}`,
                        turn: e.turn,
                        role: "assistant",
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
                    !log.some(
                      (r) => r.type === "AikoReplyPrepared" && r.turn === e.id,
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
      if (turnTerminalOf(log, body.id))
        return json({ error: "already_terminal" }, 409);
      await host.commitRoot(
        host.self(thread),
        cancellationRequested({
          invocation: { method: "message", id: body.id, epoch: turnEpochOf(log, body.id) },
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
  async fetch(request: Request, env: AikoCloudflareEnv, ctx?: { waitUntil(promise: Promise<unknown>): void }): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (
        request.headers.get("origin") &&
        request.headers.get("origin") !== url.origin
      )
        return json({ error: "invalid_origin" }, 403);
      if (request.method === "GET" && (url.pathname === "/connect" || url.pathname === "/connect.html" || url.pathname.startsWith("/assets/")) && env.CONNECTOR_ASSETS) {
        const target = new URL(request.url);
        if (target.pathname === "/connect") target.pathname = "/connect.html";
        const asset = await env.CONNECTOR_ASSETS.fetch(new Request(target, request));
        const response = new Response(asset.body, asset);
        response.headers.set("Referrer-Policy", "no-referrer");
        if (url.pathname.startsWith("/connect")) response.headers.set("Cache-Control", "no-store");
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
      const config = configOf(env);
      if (
        ["/health", "/ready"].includes(url.pathname) &&
        request.method === "GET"
      )
        return json({
          name: "Aiko",
          mode: config.mode,
          status: "ready",
          storage: "durable-object",
          harness: "tardie@0.22.0",
          models: { ...Object.fromEntries(Object.entries(config.modelRouting!.roles).map(([role, route]) => [role, {provider:route.provider,model:route.model}])),
            vision: {provider:env.AIKO_VISION_PROVIDER ?? config.modelRouting!.roles.conversation.provider,model:env.AIKO_VISION_MODEL ?? config.modelRouting!.roles.conversation.model} },
          replyStyle: config.replyStyle,
          capabilities: {
            inference: config.mode === "live",
            memory: true,
            search: config.mode === "live",
            browser: config.mode === "live",
            persistentSandbox: config.mode === "live",
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
        const pending = env.AIKO_ACCOUNTS.getByName(accountObjectName(owner)).acceptTelegram(
          owner,
          inbound,
        );
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
        // Durable Objects serialize alarm/drive with RPCs. If the account is mid-slice,
        // ack Telegram before the client times out; persist continues via waitUntil.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 8_000);
        });
        const raced = await Promise.race([pending, timeout]);
        if (timer) clearTimeout(timer);
        if (raced === "timeout") {
          ctx?.waitUntil((async () => { try { await pending; await answer(); } catch { /* persist/ack best-effort after Telegram 200 */ } })());
          return json({ ok: true, status: "accepted" }, 200);
        }
        await answer();
        return json(
          { ok: raced !== "conflict", status: raced },
          raced === "conflict" ? 409 : raced === "limited" ? 429 : 200,
        );
      }
      const principal = authenticate(request, config);
      if (!principal) return json({ error: "unauthorized" }, 401);
      if (
        !principal.scopes.includes(request.method === "GET" ? "read" : "write")
      )
        return json({ error: "forbidden" }, 403);
      if (url.pathname === "/api/control/messages") {
        if (!principal.operator) return json({ error: "forbidden" }, 403);
        if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        let body;
        try { body = JSON.parse(await boundedText(new Response(request.body), 20_000)); }
        catch { return json({ error: "invalid_body" }, 400); }
        if (!body || Object.keys(body).sort().join(",") !== "account,channel,id,text" ||
          typeof body.account !== "string" || !/^[1-9]\d{0,15}$/.test(body.account) || body.channel !== "telegram" ||
          typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(body.id) ||
          typeof body.text !== "string" || !body.text.trim() || body.text.length > 12_000)
          return json({ error: "invalid_body" }, 400);
        if (!(await registry.list()).some(entry => entry.owner === body.account)) return json({ error: "not_found" }, 404);
        const status = await env.AIKO_ACCOUNTS.getByName(accountObjectName(body.account)).acceptOperatorMessage(body.account, body.id, body.text);
        return json({ status, id: `operator:${body.id}`, channel: "telegram" }, status === "conflict" ? 409 : 202);
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
            await env.AIKO_ACCOUNTS.getByName(accountObjectName(owner)).describe(owner),
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
    } catch {
      return json({ error: "service_unavailable" }, 503);
    }
  },
};
