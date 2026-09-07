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
import {
  acceptSecretary,
  createSecretaryActor,
  secretaryApi,
  secretaryCommand,
  secretaryEventKey,
  secretaryThread,
  withSecretaryHistory,
} from "./secretary.ts";
import { secretaryTelegram } from "./secretary-telegram.ts";
import { createModelRouting } from "./model-routing.ts";
import { withRoleInference } from "./inference-routing.ts";
import { connectorVault } from "./connector-vault.ts";
import { automationEventKey } from "./automations.ts";
import { createToolRouterActor, routerEventKey } from "./tool-router.ts";
import { routerCaller, validateRouterInput } from "./connector-router-host.ts";
import { ConnectorEngine } from "./connectors.ts";
import {
  FileConnectorStore,
  PostgresConnectorStore,
} from "./connectors-store.ts";
import { FilePasswordManagerHost } from "./password-managers.ts";
import {
  WorkflowController,
  createWorkflowStore,
  workflowDispatcher,
} from "./workflow-host.ts";
import { sqliteWorkflowKV } from "./workflow-store.ts";
import { withUnlockBrowser } from "./browser-unlock-factory.ts";
import { connectorApi } from "./connector-api.ts";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { browserTraceKeys } from "@unbrowse/browser-harness/trace";
import { harKeys } from "@unbrowse/browser-harness/network-facts";
import {
  accountDirectory,
  accountThreadDatabase,
  privateDatabaseFile,
  backgroundThread,
  threadBinding,
} from "./accounts.ts";
import {
  backgroundEventKey,
  createIndexerActor,
  createReflectionActor,
} from "./background.ts";
import { validateLearningInput } from "./learning.ts";
import { learningFromBrowserTrace } from "./unbrowse-learning.ts";
import { controlApi } from "./control-api.ts";
import { requestMemoryEventKey } from "./request-memory-events.ts";
import { observedActionEventKey } from "./observed-network.ts";
import { ensureUnlockSession } from "./unlock-session.ts";
import { createActionApprovals } from "./action-approval.ts";
import { Effect } from "effect";
import { EventLog, withWatermark } from "tardie/core/log";
import { CONTROL_HTML } from "./control.ts";
import { envelopeOf } from "tardie/core/communication/envelope";
import { linkOf } from "tardie/core/communication/link";
import { parseThreadAddress } from "tardie/core/communication/endpoint";
import { credentialDigest } from "./plane-auth.ts";
import { planeManifest, planeMemoryRead } from "./plane.ts";
import { ModelBudget } from "./model-budget.ts";
import { EmbeddingBudget } from "./embedding-budget.ts";
import { nodeStorage, openRouterEmbeddings } from "entity-learn";
import type { PublicPage } from "./public-web.ts";
import { Database } from "bun:sqlite";
import { createBunHost, type BunHost } from "tardie/bun/host";
import { cancellationRequested } from "tardie/core/method/cancellation";
import { infer as modelInference } from "tardie/model";
import { modelAdapters } from "tardie/model/adapter";
import { openAICompatibleAdapter } from "tardie/model/openai";
import {
  createAikoActor,
  demoInference,
  event,
  type AikoEvent,
} from "./actor.ts";
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
  telegramEventKey,
  type TelegramVision,
  type TelegramScreenshotCapture,
} from "./telegram-tools.ts";
import type { TelegramMediaProcessor } from "./telegram-media.ts";
import {
  controlCommand,
  telegramControl,
  createControlActor,
} from "./telegram-control.ts";
import {
  boundedText,
  equalSecret,
  redactor,
  safeUserId,
  verifyInitData,
  type HttpFetch,
} from "./security.ts";
import { RELEASE_GATES } from "./capabilities.ts";
import type { AikoConfig } from "./config.ts";
import { CONSOLE_HTML } from "./console.ts";
import { withSpokenHistory } from "./inference.ts";
import { BrowserController } from "./browser.ts";
import {
  browserDriverFactory,
  type BrowserDriverFactory,
} from "./browser-driver.ts";

export async function createService(
  config: AikoConfig,
  overrides: {
    model?: typeof demoInference;
    backgroundModel?: typeof demoInference;
    voiceFetch?: HttpFetch;
    telegramFetch?: HttpFetch;
    modelFetch?: HttpFetch;
    embeddingFetch?: HttpFetch;
    connectorFetch?: HttpFetch;
    connectorBrowser?: (
      owner: string,
    ) => import("./connectors-browser.ts").SecureBrowserAdapter;
    /** Test seam: deterministic password manager resolution without provider networks. */
    managerResolvers?: import("./password-managers.ts").ManagerResolvers;
    browserFactory?: BrowserDriverFactory;
    telegramStatus?: () => object;
    // Explicit owner-bound media capability injection. The local server never provisions a VM implicitly.
    telegramMedia?: (owner: string) => {
      processor: TelegramMediaProcessor;
      speak?: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
      vision?: TelegramVision;
      captureScreenshot?: TelegramScreenshotCapture;
    };
    webRead?: (url: string, signal: AbortSignal) => Promise<PublicPage>;
  } = {},
) {
  const redact = redactor([
    config.modelKey ?? "",
    config.memoryEmbedding?.apiKey ?? "",
    config.cerebrasKey ?? "",
    config.arcadeKey ?? "",
    ...Object.values(config.connectorVault?.accounts ?? {}).map((a) => a.token),
    config.voiceKey ?? "",
    config.operatorToken,
    config.botToken ?? "",
    config.webhookSecret ?? "",
  ]);
  const requireThinkFeel =
    config.mode === "live" && config.replyStyle !== "direct";
  const compose = requireThinkFeel
    ? createThinkFeelComposer({
        key: config.voiceKey,
        persona: config.persona,
        redact,
        fetch: overrides.voiceFetch,
      })
    : undefined;
  const voice = createVoice({
    compose,
    required: requireThinkFeel,
    key: config.voiceKey,
    persona: config.persona,
    enabled: config.replyStyle !== "direct" && config.voiceEnabled,
    fetch: overrides.voiceFetch,
  });
  const connectorStore =
    config.mode === "live" && config.connectorStorage === "postgres"
      ? new PostgresConnectorStore()
      : new FileConnectorStore(join(config.stateDir, "connectors"));
  const connectorEngines = new Map<string, ConnectorEngine>();
  const connectorsFor = (owner: string) => {
    let engine = connectorEngines.get(owner);
    if (!engine) {
      engine = new ConnectorEngine({
        owner,
        secureBrowser:
          overrides.connectorBrowser?.(owner) ??
          connectorVault(config.connectorVault, owner),
        store: connectorStore,
        env: { ARCADE_API_KEY: config.arcadeKey },
        fetch: overrides.connectorFetch,
        managers: config.managerKey
          ? new FilePasswordManagerHost({
              store: connectorStore,
              owner,
              key: config.managerKey,
              vault: config.hashicorpVault,
              onePasswordConnectUrl: config.onePasswordConnectUrl,
              resolvers: overrides.managerResolvers,
            })
          : undefined,
        onEvent: async (e) => {
          await host.commitRoot(
            host.self(`user-${owner}`),
            event("AikoHooksActivated", { id: "background-v1" }),
          );
          await host.commitRoot(host.self(`user-${owner}`), e);
          wake(owner);
        },
        readOwnedLogs: async (boundOwner) =>
          (await host.read(`user-${boundOwner}`))
            .filter(
              (e) => e.type === "AikoApiObserved" && e.owner === boundOwner,
            )
            .map((e) => ({
              owner: boundOwner,
              id: String(e.id),
              text: `${e.method} ${e.url}`,
            })),
      });
      connectorEngines.set(owner, engine);
    }
    return engine;
  };
  const workflowControllers = new Map<string, WorkflowController>();
  let workflowDb: Database | undefined;
  const workflowsFor = (owner: string) => {
    let controller = workflowControllers.get(owner);
    if (!controller) {
      controller = new WorkflowController(
        owner,
        `user-${owner}`,
        {
          store: createWorkflowStore(
            sqliteWorkflowKV(
              (workflowDb ??= new Database(
                privateDatabaseFile(join(config.stateDir, "workflows.sqlite")),
              )),
            ),
          ),
          dispatcher: workflowDispatcher({
            owner,
            engine: connectorsFor(owner),
            redact,
            readEvents: () => host.read(`user-${owner}`),
            read: overrides.webRead,
          }),
          guard: validateRouterInput,
        },
        redact,
      );
      workflowControllers.set(owner, controller);
    }
    return controller;
  };
  const routerBinding = (owner: string) => ({
    owner,
    engine: connectorsFor(owner),
    redact,
    readOwnedEvents: () => host.read(`user-${owner}`),
    listWorkflows: () => workflowsFor(owner).engine.list(),
    vaultDomains: async () =>
      Object.keys(config.connectorVault?.accounts[owner]?.connections ?? {}),
  });
  const routeFor = (owner: string) =>
    routerCaller(routerBinding(owner), () => host);
  const telegram =
    config.botToken && config.webhookSecret
      ? createTelegram({
          token: config.botToken,
          secret: config.webhookSecret,
          allowedUsers: config.allowedUsers,
          public: config.telegramPublic,
          fetch: overrides.telegramFetch,
          redact,
        })
      : undefined;
  const browser = config.browser
    ? new BrowserController({
        domains: config.browser.domains,
        redact,
        factory: withUnlockBrowser(
          overrides.browserFactory ??
            browserDriverFactory(config.browser.executablePath),
          { config: config.connectorVault, engine: connectorsFor },
        ),
      })
    : undefined;
  const actors = new Map<
    string,
    | ReturnType<typeof createAikoActor>
    | ReturnType<typeof createIndexerActor>
    | ReturnType<typeof createReflectionActor>
    | ReturnType<typeof createToolRouterActor>
    | ReturnType<typeof createControlActor>
    | ReturnType<typeof createSecretaryActor>
  >();
  const telegramLifecycles = new Map<
    string,
    ReturnType<typeof createTelegramTyping>
  >();
  const telegramShutdown = new AbortController();
  const validOwner = (id: string) =>
    safeUserId(id) &&
    (id === "local" ||
      config.allowedUsers.has(id) ||
      config.planeCredentials?.some((key) => key.account === id) ||
      (config.telegramPublic === true && /^[1-9]\d{0,15}$/.test(id)));
  // Enforce a single host per state directory. The OS releases this SQLite lock on a crash.
  const lock = new Database(
    privateDatabaseFile(join(config.stateDir, "host-lock.sqlite")),
    {
      create: true,
    },
  );
  try {
    lock.exec(
      "PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS host_lock (id INTEGER PRIMARY KEY)",
    );
  } catch {
    lock.close();
    throw new Error("Aiko state directory is already in use");
  }
  let modelBudget: ModelBudget | undefined;
  let embeddingBudget: EmbeddingBudget | undefined;
  try {
    modelBudget =
      config.mode === "live"
        ? new ModelBudget(config.stateDir, config.modelLimits)
        : undefined;
    if (config.mode === "live" && config.memoryEmbedding) {
      const storage = nodeStorage(
        privateDatabaseFile(join(config.stateDir, "embedding-budget.sqlite")),
      );
      try {
        embeddingBudget = new EmbeddingBudget(
          storage,
          config.memoryEmbedding.maxUsdPerDay,
        );
      } catch (error) {
        storage.close();
        throw error;
      }
    }
  } catch (error) {
    embeddingBudget?.close();
    modelBudget?.close();
    lock.close();
    throw error;
  }
  const embeddingFor = (owner: string) =>
    embeddingBudget && config.memoryEmbedding?.owners.includes(owner)
      ? openRouterEmbeddings({
          apiKey: () => config.memoryEmbedding!.apiKey,
          revision: config.memoryEmbedding.revision,
          admission: embeddingBudget.forOwner(owner),
          fetch: overrides.embeddingFetch,
        })
      : undefined;
  const host: BunHost = await createBunHost({
    database: join(config.stateDir, "actor.sqlite"),
    threadDatabase: (thread) => accountThreadDatabase(config.stateDir, thread),
    actorName: "aiko",
    actorInstance: config.instanceId ?? config.mode,
    workspaceSql: false,
    keyOf: (e) =>
      agentKeys.keyOf(e) ??
      cancellationKeys.keyOf(e) ??
      methodCallKeys.keyOf(e) ??
      methodResponseKeys.keyOf(e) ??
      methodTimeoutKeys.keyOf(e) ??
      methodIngressKeyOf(e) ??
      secretaryEventKey(e) ??
      browserTraceKeys.keyOf(e) ??
      requestMemoryEventKey(e) ??
      observedActionEventKey(e) ??
      harKeys.keyOf(e) ??
      telegramEventKey(e) ??
      routerEventKey(e) ??
      backgroundEventKey(e) ??
      automationEventKey(e) ??
      (e.type === "AikoControlReply" ? `aiko-control:${e.id}` : undefined),
    // Foreground work wins when capacity becomes available; background uses the same durable allowance.
    pick: (dirty) =>
      [...dirty].find(
        (thread) => threadBinding(thread)?.role === "foreground",
      ) ?? dirty.values().next().value!,
    actorFor: (thread) => {
      const address = threadBinding(thread);
      if (!address) return undefined;
      const { owner, role } = address;
      if (!validOwner(owner)) return undefined;
      let instance = actors.get(thread);
      if (!instance) {
        const media =
          role === "foreground" && owner !== "local"
            ? overrides.telegramMedia?.(owner)
            : undefined;
        const ownedTelegram =
          telegram && owner !== "local" && role === "foreground"
            ? media
              ? createTelegram({
                  token: config.botToken!,
                  secret: config.webhookSecret!,
                  allowedUsers: new Set([owner]),
                  fetch: overrides.telegramFetch,
                  redact,
                  mediaProcessor: media.processor,
                })
              : telegram
            : undefined;
        const telegramTyping =
          ownedTelegram && media
            ? createTelegramTyping(owner, ownedTelegram, {
                waitForDelivery: true,
                signal: telegramShutdown.signal,
              })
            : undefined;
        if (telegramTyping) telegramLifecycles.set(owner, telegramTyping);
        const memory = {
          stateDir: accountDirectory(config.stateDir, owner),
          owner,
          thread,
          // Foreground explicit tools only: followers/reflections never trigger bulk cloud embedding.
          ...(role === "foreground" ? { embedding: embeddingFor(owner) } : {}),
          redact,
          readPage: (after: number, limit: number) =>
            host.readPage(thread, after, limit),
        };
        instance =
          role === "secretary"
            ? createSecretaryActor({
                owner,
                redact,
                read: () => host.read(thread),
                telegram: config.botToken
                  ? secretaryTelegram(config.botToken, overrides.telegramFetch)
                  : undefined,
              })
            : role === "control"
              ? createControlActor({
                  owner,
                  voice,
                  send: telegram?.send,
                  live: requireThinkFeel,
                  redact,
                  publish: (rows) => host.seed(`user-${owner}`, rows),
                })
              : role === "router"
                ? createToolRouterActor(routerBinding(owner))
                : role === "indexer"
                  ? createIndexerActor(memory, (id, signal, route) =>
                      connectorsFor(owner).connectionPage(id, signal, route),
                    )
                  : role === "reflection"
                    ? createReflectionActor(memory)
                    : createAikoActor({
                        owner,
                        voice,
                        requireThinkFeel,
                        browser,
                        live: config.mode === "live",
                        publicWeb: config.publicWeb ?? config.mode === "live",
                        webRead: overrides.webRead,
                        toolCallLimit: config.toolCallLimit ?? null,
                        send: telegram?.send,
                        memory,
                        background: true,
                        workflow: workflowsFor(owner).component(),
                        toolRouter: {
                          owner,
                          thread,
                          redact,
                          readRouter: () => host.read(`router-${owner}`),
                        },
                        capabilityBuilder: {
                          owner,
                          thread,
                          redact,
                          checkArcade: async (domain) =>
                            (await connectorsFor(owner).search(domain))
                              .fallbackAllowed,
                          session: (origin, signal) =>
                            ensureUnlockSession({
                              owner,
                              origin,
                              config: config.connectorVault,
                              search: (domain) =>
                                connectorsFor(owner).search(domain),
                              signal,
                              renew: true,
                            }),
                        },
                        connectors: {
                          owner,
                          thread,
                          engine: connectorsFor(owner),
                          deliverConnection: async (input, signal) => {
                            if (!ownedTelegram || input.owner !== owner)
                              return { status: "rejected" as const };
                            const wording = compose
                              ? await compose(input.text, signal)
                              : undefined;
                            if (requireThinkFeel && wording?.status !== "ready")
                              return { status: "rejected" as const };
                            return ownedTelegram.sendRich(
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
                        ...(ownedTelegram
                          ? {
                              extraTools: createTelegramTools({
                                owner,
                                telegram: ownedTelegram,
                                compose,
                                redact,
                                speak: media?.speak,
                                inspectImages: media?.vision,
                                captureScreenshot: media?.captureScreenshot,
                              }),
                            }
                          : {}),
                        ...(telegramTyping ? { telegramTyping } : {}),
                      });
        actors.set(thread, validateActor(instance));
      }
      return instance;
    },
    layersFor: (thread) => {
      const address = threadBinding(thread)!;
      const routing =
        config.mode === "live" && config.modelRouting
          ? createModelRouting({
              owner: address.owner,
              config: config.modelRouting,
              env: {
                CODEGRAFF_API_KEY: config.modelKey,
                CEREBRAS_API_KEY: config.cerebrasKey,
                AIKO_ALLOW_PAID_INFERENCE: "true",
              },
              budget: modelBudget,
              fetch: overrides.modelFetch,
            })
          : undefined;
      const model = withSpokenHistory(
        (address.role === "reflection"
          ? overrides.backgroundModel
          : overrides.model) ??
          (config.mode === "demo"
            ? demoInference
            : routing
              ? address.role === "reflection"
                ? routing.layer("rag")
                : withRoleInference((role) => routing.layer(role))
              : modelInference(
                  {
                    provider: "codegraff",
                    baseUrl: "https://gateway.codegraff.com/v1",
                    apiKey: config.modelKey!,
                    model: config.model ?? "glm-5.3-flash",
                    protocol: "openai-chat-completions",
                    contextWindowTokens: 32_768,
                    maxOutputTokens: 1_024,
                    throttleRetryDelaysMs: [],
                    fetch: modelBudget!.transport(
                      address.owner,
                      overrides.modelFetch,
                    ),
                    stream: {
                      firstChunkMs: 20_000,
                      idleMs: 20_000,
                      totalMs: 60_000,
                    },
                  },
                  modelAdapters(openAICompatibleAdapter),
                )),
      );
      if (address.role === "secretary") return withSecretaryHistory(model);
      if (address.role !== "foreground") return model;
      return withRequiredResponse(
        workflowsFor(address.owner).inference(
          browser ? browser.inference(model, address.owner) : model,
        ),
        redact,
      );
    },
  }).catch((error) => {
    workflowDb?.close();
    embeddingBudget?.close();
    modelBudget?.close();
    lock.close();
    throw error;
  });
  let failures = 0;
  let closing = false;
  const wake = (owner: string) => {
    void host.wake(`user-${owner}`).catch(() => {
      failures++;
    });
  };
  try {
    // Activate after historical events. Installing hooks must not re-notify old conversations.
    for (const thread of await host.threads()) {
      if (threadBinding(thread)?.role === "foreground")
        await host.seed(thread, [
          event("AikoHooksActivated", { id: "background-v1" }),
        ]);
    }
    await host.recover();
  } catch (error) {
    await host.close();
    workflowDb?.close();
    embeddingBudget?.close();
    modelBudget?.close();
    lock.close();
    throw error;
  }
  const json = (data: unknown, status = 200) =>
    Response.json(data, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  // Serialize admission only; Tardie still owns execution, scheduling, effects and recovery.
  let admission: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>) {
    const result = admission.then(operation);
    admission = result.catch(() => undefined);
    return result;
  }
  async function accept(
    owner: string,
    id: string,
    text: string,
    source: "local" | "telegram" | "plane",
    inbound?: TelegramInbound,
  ) {
    return serialize(async () => {
      if (!validOwner(owner)) throw new Error("Unauthorized account");
      const threads = await host.threads();
      if (
        !threads.includes(`user-${owner}`) &&
        threads.filter((t) => threadBinding(t)?.role === "foreground").length >=
          (config.maxAccounts ?? 100)
      )
        return "limited";
      const log = (await host.read(`user-${owner}`)) as AikoEvent[];
      const prior = log.find(
        (e) => e.type === "MessageReceived" && e.id === id,
      );
      const normalized = inbound
        ? redactTelegramInbound(inbound, redact)
        : undefined;
      const telegramDigest = normalized
        ? createHash("sha256")
            .update(serializeTelegramInbound(normalized))
            .digest("hex")
        : undefined;
      if (prior)
        return prior.text === redact(text) &&
          (!prior.telegramDigest || prior.telegramDigest === telegramDigest)
          ? "duplicate"
          : "conflict";
      const messages = log.filter((e) => e.type === "MessageReceived");
      const at = Date.now();
      if (
        messages.length >= 1_000 ||
        messages.filter((e) => Number(e.at) > at - 60_000).length >= 10 ||
        messages.filter((e) => Number(e.at) > at - 86_400_000).length >= 100
      )
        return "limited";
      if (
        messages.filter((e) => !turnTerminalOf(log, String(e.id))).length >= 2
      )
        return "busy";
      await host.commitRoot(
        host.self(`user-${owner}`),
        event("AikoHooksActivated", { id: "background-v1" }),
      );
      await host.commitRoot(
        host.self(`user-${owner}`),
        event("MessageReceived", {
          id,
          text: redact(text),
          source,
          ...(source === "telegram"
            ? {
                chat: owner,
                sender: owner,
                ...(normalized
                  ? {
                      telegram: normalized,
                      telegramDigest,
                      media: normalized.media,
                      mediaGroupId: normalized.mediaGroupId,
                      messageId: normalized.messageId,
                    }
                  : {}),
              }
            : {}),
        }),
      );
      wake(owner);
      return "accepted";
    });
  }
  const prepareTelegram = async (
    request: Request,
  ): Promise<TelegramInbound | undefined> => {
    if (!telegram || closing) throw new Error("Telegram unavailable");
    const result = await telegram.receive(request);
    if (result.status === 400) return undefined; // Malformed/oversized provider input is never executable.
    if (result.status !== 200) throw new Error("Telegram input unauthorized");
    return result.inbound
      ? redactTelegramInbound(result.inbound, redact)
      : undefined;
  };
  const acceptInbound = async (inbound: TelegramInbound) => {
    const { user, update, text } = inbound;
    if (inbound.secretary)
      return serialize(async () => {
        if (!validOwner(user)) throw new Error("Unauthorized account");
        const accounts = new Set(
          (await host.threads())
            .map((t) => threadBinding(t)?.owner)
            .filter(Boolean),
        );
        if (!accounts.has(user) && accounts.size >= (config.maxAccounts ?? 100))
          return "limited" as const;
        const status = await acceptSecretary(
          host,
          user,
          redactTelegramInbound(inbound, redact),
        );
        void host.wake(secretaryThread(user)).catch(() => {
          failures++;
        });
        return status;
      });
    if (inbound.callback && telegram)
      await telegram.answerCallback(
        user,
        inbound.callback.id,
        AbortSignal.timeout(3_000),
      );
    if (inbound.media?.length || !controlCommand(text))
      return accept(user, `telegram:${update}`, text, "telegram", inbound);
    return serialize(async () => {
      if (!validOwner(user)) throw new Error("Unauthorized account");
      const threads = await host.threads();
      if (
        !threads.includes(`user-${user}`) &&
        threads.filter((t) => threadBinding(t)?.role === "foreground").length >=
          (config.maxAccounts ?? 100)
      )
        return "limited" as const;
      await host.commitRoot(
        host.self(`user-${user}`),
        event("AikoHooksActivated", { id: "background-v1" }),
      );
      const status = await telegramControl(
        host,
        user,
        `telegram:${update}`,
        text,
        config.mode === "live",
        config.publicWeb ?? config.mode === "live",
        modelBudget?.status(user),
        {
          stoppedDraftId: inbound.stoppedDraftId,
          messageThreadId: inbound.messageThreadId,
          secretary: (text) => secretaryCommand(host, user, text, redact),
          separateLane: true,
          media: !!overrides.telegramMedia,
          voice: false,
          connectors: connectorsFor(user),
          connectorsUrl: "https://aiko-agent.lewis-6d8.workers.dev/connect",
        },
      );
      if (status === "accepted")
        void host.wake(`control-${user}`).catch(() => {
          failures++;
        });
      return status;
    });
  };
  const authenticate = (request: Request) => {
    const auth =
      request.headers.get("authorization") ??
      (request.headers.has("x-telegram-init-data")
        ? `tma ${request.headers.get("x-telegram-init-data")}`
        : "");
    if (
      auth.startsWith("Bearer ") &&
      equalSecret(auth.slice(7), config.operatorToken)
    )
      return { owner: "local", scopes: ["read", "write"], operator: true };
    if (auth.startsWith("Bearer ")) {
      const digest = credentialDigest(auth.slice(7));
      const key = config.planeCredentials?.find((key) =>
        equalSecret(key.digest, digest),
      );
      if (key)
        return { owner: key.account, scopes: key.scopes, operator: false };
    }
    if (auth.startsWith("tma ") && config.botToken) {
      const user = verifyInitData(auth.slice(4), config.botToken);
      if (user && validOwner(user))
        return { owner: user, scopes: ["read", "write"], operator: false };
    }
    return undefined;
  };
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (closing) return json({ error: "shutting_down" }, 503);
    // Loopback bind alone doesn't prevent DNS rebinding or malicious-origin requests.
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
      return json({ error: "invalid_host" }, 403);
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== url.origin
    )
      return json({ error: "invalid_origin" }, 403);
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
    if (
      ["/health", "/ready"].includes(url.pathname) &&
      request.method === "GET"
    ) {
      const gateway = overrides.telegramStatus?.() as
        | { running?: boolean; lastPollAt?: number; consecutiveErrors?: number }
        | undefined;
      const ready =
        !failures &&
        (config.telegramMode !== "polling" ||
          (gateway?.running &&
            Date.now() - (gateway.lastPollAt ?? 0) < 90000 &&
            (gateway.consecutiveErrors ?? 0) < 3));
      return json(
        {
          name: "Aiko",
          mode: config.mode,
          status: ready ? "ready" : "degraded",
          capabilities: {
            inference: config.mode === "live",
            memory: true,
            publicWeb: config.publicWeb ?? config.mode === "live",
            connectedApps: false,
            arbitraryCode: false,
          },
          telegram: gateway ?? { enabled: !!telegram },
        },
        url.pathname === "/ready" && !ready ? 503 : 200,
      );
    }
    if (url.pathname === "/telegram/webhook") {
      if (!telegram || config.telegramMode === "polling")
        return json({ error: "telegram_webhook_disabled" }, 503);
      const result = await telegram.receive(request);
      if (result.inbound) {
        const status = await acceptInbound(result.inbound);
        // Admission failure is explicit; do not acknowledge a dropped task as accepted.
        if (status === "limited" || status === "busy")
          return json({ error: status }, 429);
        if (status === "conflict") return json({ error: status }, 409);
      }
      return json({ ok: result.status === 200 }, result.status);
    }
    const principal = authenticate(request);
    if (!principal) return json({ error: "unauthorized" }, 401);
    const { owner, scopes } = principal;
    if (!scopes.includes(request.method === "GET" ? "read" : "write"))
      return json({ error: "forbidden" }, 403);
    if (/^\/(?:api|v1)\/secretary(?:\/|$)/.test(url.pathname))
      return serialize(() => secretaryApi(request, owner, host, redact));
    if (/^\/(?:api|v1)\/connectors(?:\/|$)/.test(url.pathname))
      return connectorApi(request, connectorsFor(owner), routeFor(owner));
    if (url.pathname.startsWith("/api/control/"))
      return controlApi({
        host,
        config,
        principal,
        request,
        url,
        redact,
        serialize,
        validOwner,
        memoryBindingFor: (account) => ({
          owner: account,
          stateDir: accountDirectory(config.stateDir, account),
          thread: `user-${account}`,
          redact,
          readPage: (after, limit) =>
            host.readPage(`user-${account}`, after, limit),
        }),
      });
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
        input =
          url.pathname === "/v1/hooks/unbrowse"
            ? learningFromBrowserTrace(body)
            : validateLearningInput(body);
      } catch {}
      if (!input || redact(JSON.stringify(input)) !== JSON.stringify(input))
        return json({ error: "invalid_hook" }, 400);
      const accepted = input;
      return serialize(async () => {
        const foreground = `user-${owner}`;
        const threads = await host.threads();
        if (
          !threads.includes(foreground) &&
          threads.filter((t) => threadBinding(t)?.role === "foreground")
            .length >= (config.maxAccounts ?? 100)
        )
          return json({ error: "limited" }, 429);
        const thread = backgroundThread(owner, "indexer");
        const log = (await host.read(thread)) as AikoEvent[];
        const id = `hook:${accepted.id}`;
        const prior = log.find(
          (e) => e.type === "AikoHookReceived" && e.id === id,
        );
        if (prior)
          return JSON.stringify(prior.input) === JSON.stringify(accepted)
            ? json({ status: "duplicate", id }, 202)
            : json({ error: "conflict" }, 409);
        const hooks = log.filter((e) => e.type === "AikoHookReceived");
        if (
          hooks.length >= 10_000 ||
          hooks.filter((e) => Number(e.at) > Date.now() - 60_000).length >= 30
        )
          return json({ error: "limited" }, 429);
        await host.commitRoot(
          host.self(foreground),
          event("AikoAccountOpened", { id: "account" }),
        );
        await host.commitRoot(
          host.self(foreground),
          event("AikoHooksActivated", { id: "background-v1" }),
        );
        const source = parseThreadAddress(host.self(foreground));
        const target = parseThreadAddress(host.self(thread));
        await host.commit(
          envelopeOf(
            linkOf(source, target),
            event("AikoHookReceived", { id, input: accepted, cause: id }),
            { parent: source, depth: 1, placement: "colocated" },
          ),
        );
        void host.wake(thread).catch(() => {
          failures++;
        });
        return json({ status: "accepted", id }, 202);
      });
    }
    if (url.pathname === "/v1" && request.method === "GET")
      return json(planeManifest);
    if (request.method === "GET") {
      const memory = planeMemoryRead(url, {
        owner,
        stateDir: accountDirectory(config.stateDir, owner),
      });
      if (memory) return memory;
    }
    const planeRequest = url.pathname.startsWith("/v1/");
    if (
      [
        "/v1/status",
        "/v1/messages",
        "/v1/cancel",
        "/v1/browser",
        "/v1/browser/approval",
        "/v1/observed-actions/approval",
      ].includes(url.pathname)
    )
      url.pathname = url.pathname.replace("/v1/", "/api/");
    if (url.pathname === "/api/status" && request.method === "GET") {
      const log = (await host.read(`user-${owner}`)) as AikoEvent[];
      const followed = log.findLast((e) => e.type === "AikoLogMemoryFollowed");
      return json({
        name: "Aiko",
        account: owner,
        protocol: "aiko-plane/v1",
        isolation:
          "private account log, memory and browser profile; no arbitrary-code OS sandbox",
        company: "Unbrowse",
        mode: config.mode,
        model:
          config.mode === "demo"
            ? "deterministic fixture"
            : (config.model ?? "glm-5.3-flash"),
        inferenceUsage: modelBudget?.status(owner) ?? null,
        publicWeb: config.publicWeb ?? config.mode === "live",
        fixtures: config.mode === "demo",
        voice: config.voiceEnabled
          ? "enabled; factual allowlist"
          : "safe templates",
        telegram: !!telegram,
        gates: RELEASE_GATES,
        browser: browser ? "configured; public-web only" : "disabled",
        toolCallLimit: config.toolCallLimit ?? null,
        noProgressStop: false,
        memory: {
          engine: "entity-learn",
          version: "0.2.0",
          storage: "private per-user SQLite",
          harness: "tardie@0.22.0",
          logFollower: followed
            ? {
                status: followed.status,
                after: followed.after,
                at: followed.at,
              }
            : { status: "not_started", after: 0 },
        },
        failures,
      });
    }
    if (url.pathname === "/api/browser" && request.method === "GET")
      return json(
        browser?.status(owner) ?? {
          enabled: false,
          pending: [],
          observations: [],
        },
      );
    if (
      url.pathname === "/api/observed-actions/approval" &&
      request.method === "POST"
    ) {
      const thread = `user-${owner}`;
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
    if (url.pathname === "/api/browser/approval" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return json({ error: "json_required" }, 415);
      let body: unknown;
      try {
        body = JSON.parse(await boundedText(new Response(request.body), 512));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "approve,id" ||
        typeof (body as { id?: unknown }).id !== "string" ||
        typeof (body as { approve?: unknown }).approve !== "boolean"
      )
        return json({ error: "invalid_approval" }, 400);
      const { id, approve } = body as { id: string; approve: boolean };
      return browser?.decide(owner, id, approve)
        ? json({ status: "decision_received" }, 202)
        : json({ error: "not_found_or_expired" }, 404);
    }
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const log = (await host.read(`user-${owner}`)) as AikoEvent[];
      return json({
        messages: log
          .filter(
            (e) =>
              e.type === "MessageReceived" ||
              e.type === "AikoControlReply" ||
              e.type === "AikoReplyPrepared",
          )
          .slice(-100)
          .map((e) =>
            e.type === "MessageReceived" || e.type === "AikoControlReply"
              ? {
                  id: e.id,
                  role: "user",
                  text: e.text,
                  at: e.at,
                  ...(Array.isArray(e.media) ? { media: e.media } : {}),
                }
              : {
                  id: `reply:${e.turn}`,
                  turn: e.turn,
                  role: "assistant",
                  ...(e.result as object),
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
                ].includes(String((e.result as { action?: unknown })?.action))),
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
      });
    }
    if (url.pathname === "/api/messages" && request.method === "POST") {
      if (!request.headers.get("content-type")?.startsWith("application/json"))
        return json({ error: "json_required" }, 415);
      let body: any;
      try {
        body = JSON.parse(await boundedText(new Response(request.body), 8_192));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "id,text" ||
        typeof body.text !== "string" ||
        !body.text.trim() ||
        body.text.length > 4_000 ||
        typeof body.id !== "string" ||
        !/^[A-Za-z0-9_-]{8,80}$/.test(body.id)
      )
        return json({ error: "invalid_message" }, 400);
      const status = await accept(
        owner,
        `${planeRequest ? "plane" : "local"}:${body.id}`,
        body.text.trim(),
        planeRequest ? "plane" : "local",
      );
      return json(
        { status, id: `${planeRequest ? "plane" : "local"}:${body.id}` },
        status === "conflict"
          ? 409
          : status === "limited" || status === "busy"
            ? 429
            : 202,
      );
    }
    if (url.pathname === "/api/cancel" && request.method === "POST") {
      let body: any;
      try {
        body = JSON.parse(await boundedText(new Response(request.body), 512));
      } catch {
        return json({ error: "invalid_body" }, 400);
      }
      const log = (await host.read(`user-${owner}`)) as AikoEvent[];
      if (
        typeof body?.id !== "string" ||
        !log.some((e) => e.type === "MessageReceived" && e.id === body.id)
      )
        return json({ error: "not_found" }, 404);
      if (turnTerminalOf(log, body.id))
        return json({ error: "already_terminal" }, 409);
      await host.commitRoot(
        host.self(`user-${owner}`),
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
      wake(owner);
      return json({ status: "cancelling" }, 202);
    }
    return json({ error: "not_found" }, 404);
  };
  return {
    host,
    prepareTelegram,
    acceptTelegram: async (request: Request) => {
      const inbound = await prepareTelegram(request);
      return inbound ? acceptInbound(inbound) : ("ignored" as const);
    },
    fetch: (request: Request) =>
      handle(request).catch(() => {
        failures++;
        return json({ error: "internal_error" }, 500);
      }),
    close: async () => {
      if (closing) return;
      closing = true;
      telegramShutdown.abort();
      try {
        await Promise.all(
          [...telegramLifecycles.values()].map((lifecycle) =>
            lifecycle.close(),
          ),
        );
        await browser?.close();
        await host.drive();
      } finally {
        await host.close();
        workflowDb?.close();
        embeddingBudget?.close();
        modelBudget?.close();
        lock.close();
      }
    },
  };
}
