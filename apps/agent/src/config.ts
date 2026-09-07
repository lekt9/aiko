import { parseModelRouting, type ModelRoutingConfig } from "./model-routing.ts";
import { parseConnectorVault, type ConnectorVaultConfig } from "./connector-vault.ts";
import { lstat, readFile, mkdir, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { normalizeAgentBrowserAllowedDomains } from "@unbrowse/browser-harness/client";

import { parsePlaneCredentials, type PlaneCredential } from "./plane-auth.ts";
import { DEFAULT_MODEL_LIMITS, type ModelLimits } from "./model-budget.ts";
import { safeUserId } from "./security.ts";

export const PERSONA = "3c36e929-50ac-4971-919f-70e6fc6273b7";
export type AikoConfig = {
  mode: "demo" | "live";
  instanceId?: string;
  model?: string;
  modelLimits?: ModelLimits;
  publicWeb?: boolean;
  port: number;
  stateDir: string;
  operatorToken: string;
  modelKey?: string;
  /** Separate opt-in from paid chat inference; explicit owners, revision and global daily embedding allowance. */
  memoryEmbedding?: { apiKey: string; owners: readonly string[]; maxUsdPerDay: number; revision: string };
  cerebrasKey?: string;
  modelRouting?: ModelRoutingConfig;
  arcadeKey?: string;
  codeMode?: boolean;
  connectorVault?: ConnectorVaultConfig;
  /** Base64 32-byte AES key that seals password manager tokens at rest. Omitting it keeps the feature off. */
  managerKey?: string;
  /** Operator-level HashiCorp Vault cluster for the hashicorp-vault manager kind. */
  hashicorpVault?: { address: string; namespace?: string };
  voiceKey?: string;
  persona: string;
  voiceEnabled: boolean;
  replyStyle?: "thinkfeel" | "direct";
  botToken?: string;
  webhookSecret?: string;
  allowedUsers: ReadonlySet<string>;
  telegramMode?: "webhook" | "polling";
  telegramPublic?: boolean;
  maxAccounts?: number;
  planeCredentials?: readonly PlaneCredential[];
  /** null/omitted: no tool-count ceiling. A positive integer opts into a native budget. */
  toolCallLimit?: number | null;
  browser?: { executablePath: string; domains: readonly string[] };
};

/** Parse data, never source/evaluate a shell file. Secrets never enter actor definitions or event logs. */
export async function privateEnv(
  path: string,
): Promise<Record<string, string>> {
  const stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(
      "Aiko secret file must be owner-only (0600), regular, and owned by this user",
    );
  const result: Record<string, string> = {};
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("Invalid Aiko configuration line");
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

function parseManagerKey(value?: string) {
  if (!value) return undefined;
  if (!/^[A-Za-z0-9+/=_-]{43,44}$/.test(value.trim()))
    throw new Error("AIKO_MANAGER_KEY must be a base64 32-byte key");
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== 32)
    throw new Error("AIKO_MANAGER_KEY must decode to exactly 32 bytes");
  return value.trim();
}

function parseVaultAddress(address?: string, namespace?: string) {
  if (!address) {
    if (namespace)
      throw new Error("AIKO_HASHICORP_VAULT_NAMESPACE requires an address");
    return undefined;
  }
  const url = new URL(address);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw new Error(
      "AIKO_HASHICORP_VAULT_ADDRESS must be an origin-only HTTPS address",
    );
  if (namespace && (namespace.length > 200 || /\p{C}/u.test(namespace)))
    throw new Error("Invalid AIKO_HASHICORP_VAULT_NAMESPACE");
  return { address, ...(namespace ? { namespace } : {}) };
}

export async function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly?: boolean } = {},
): Promise<AikoConfig> {
  const path =
    env.AIKO_SECRET_FILE ?? join(homedir(), ".config/unbrowse/aiko.env");
  let file: Record<string, string> = {};
  try {
    file = await privateEnv(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const get = (key: string) => env[key] ?? file[key];
  const mode = get("AIKO_MODE") ?? "demo";
  if (mode !== "demo" && mode !== "live")
    throw new Error("AIKO_MODE must be demo or live");
  if (mode === "live" && get("AIKO_ALLOW_PAID_INFERENCE") !== "true")
    throw new Error(
      "Live inference requires explicit AIKO_ALLOW_PAID_INFERENCE=true",
    );
  const embeddingFlag = get("AIKO_MEMORY_CLOUD_EMBEDDINGS") ?? "false";
  if (!["true", "false"].includes(embeddingFlag)) throw new Error("Invalid cloud memory opt-in");
  let memoryEmbedding: AikoConfig["memoryEmbedding"];
  if (embeddingFlag === "true") {
    const apiKey = get("OPENROUTER_EMBEDDING_API_KEY");
    const owners = (get("AIKO_MEMORY_EMBEDDING_OWNERS") ?? "").split(",").map(v => v.trim());
    const maxUsdPerDay = Number(get("AIKO_MEMORY_EMBEDDING_MAX_USD_PER_DAY"));
    const revision = get("AIKO_MEMORY_EMBEDDING_REVISION") ?? "";
    if (mode !== "live" || !apiKey || /[\r\n]/.test(apiKey) || !owners.length || owners.some(o => !safeUserId(o)) ||
      !Number.isFinite(maxUsdPerDay) || maxUsdPerDay <= 0 || maxUsdPerDay > 10 || !/^[A-Za-z0-9_.:/-]{1,128}$/.test(revision))
      throw new Error("Cloud memory requires live mode, a dedicated environment key, explicit owner allowlist, revision and daily USD cap");
    memoryEmbedding = { apiKey, owners: [...new Set(owners)], maxUsdPerDay, revision };
  }
  const instanceId = get("AIKO_INSTANCE_ID") ?? mode;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(instanceId))
    throw new Error("Invalid stable actor instance ID");
  const model = get("AIKO_MODEL") ?? "glm-5.3-flash";
  if (!/^[A-Za-z0-9_./-]{1,128}$/.test(model))
    throw new Error("Invalid model identifier");
  const positive = (name: string, fallback: number, maximum: number) => {
    const value = Number(get(name) ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw new Error(`Invalid ${name}`);
    return value;
  };
  const modelLimits: ModelLimits = {
    globalPerDay: positive(
      "AIKO_MODEL_GLOBAL_CALLS_PER_DAY",
      DEFAULT_MODEL_LIMITS.globalPerDay,
      100000,
    ),
    accountPerDay: positive(
      "AIKO_MODEL_ACCOUNT_CALLS_PER_DAY",
      DEFAULT_MODEL_LIMITS.accountPerDay,
      10000,
    ),
    maxConcurrent: positive(
      "AIKO_MODEL_CONCURRENCY",
      DEFAULT_MODEL_LIMITS.maxConcurrent,
      16,
    ),
  };
  if (modelLimits.accountPerDay > modelLimits.globalPerDay)
    throw new Error("Account allowance exceeds global allowance");
  const webFlag =
    get("AIKO_PUBLIC_WEB") ?? (mode === "live" ? "true" : "false");
  if (!["true", "false"].includes(webFlag))
    throw new Error("AIKO_PUBLIC_WEB must be true or false");
  const publicWeb = webFlag === "true";
  const modelKey = get("CODEGRAFF_API_KEY");
  if (mode === "live" && !modelKey)
    throw new Error("CODEGRAFF_API_KEY is required in live mode");
  let operatorToken = get("AIKO_OPERATOR_TOKEN") ?? "";
  if (!operatorToken) {
    try {
      operatorToken =
        (
          await privateEnv(
            get("AIKO_OPERATOR_FILE") ??
              join(homedir(), ".config/unbrowse/aiko-operator.env"),
          )
        ).AIKO_OPERATOR_TOKEN ?? "";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (operatorToken.length < 32)
    throw new Error(
      "Set a private AIKO_OPERATOR_TOKEN of at least 32 characters",
    );
  const port = Number(get("AIKO_PORT") ?? "4242");
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid AIKO_PORT");
  const stateDir =
    get("AIKO_STATE_DIR") ??
    join(homedir(), ".local/share/unbrowse/aiko", mode);
  if (!isAbsolute(stateDir)) throw new Error("AIKO_STATE_DIR must be absolute");
  if (!options.readonly) await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateStat = await lstat(stateDir);
  if (
    !stateStat.isDirectory() ||
    stateStat.isSymbolicLink() ||
    (process.getuid && stateStat.uid !== process.getuid()) ||
    (options.readonly && (stateStat.mode & 0o077) !== 0)
  )
    throw new Error("Unsafe Aiko state directory");
  if (!options.readonly) await chmod(stateDir, 0o700);
  const botToken = get("TELEGRAM_BOT_TOKEN");
  const webhookSecret = get("TELEGRAM_WEBHOOK_SECRET");
  const allowedUsers = new Set(
    (get("AIKO_TELEGRAM_ALLOWED_USERS") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if ([...allowedUsers].some((id) => !/^[1-9]\d{0,15}$/.test(id)))
    throw new Error("Invalid Telegram allowlist");
  const telegramMode = get("AIKO_TELEGRAM_MODE") ?? "webhook";
  if (telegramMode !== "webhook" && telegramMode !== "polling")
    throw new Error("AIKO_TELEGRAM_MODE must be webhook or polling");
  const publicFlag = get("AIKO_TELEGRAM_PUBLIC") ?? "false";
  if (publicFlag !== "true" && publicFlag !== "false")
    throw new Error("Invalid Telegram public flag");
  const telegramPublic = publicFlag === "true";
  if (
    botToken &&
    (!webhookSecret ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret) ||
      (!allowedUsers.size && !telegramPublic))
  )
    throw new Error(
      "Telegram requires a webhook secret and an allowlist or explicit public onboarding",
    );
  const maxAccounts = Number(get("AIKO_MAX_ACCOUNTS") ?? "100");
  if (
    !Number.isSafeInteger(maxAccounts) ||
    maxAccounts < 1 ||
    maxAccounts > 1000
  )
    throw new Error("AIKO_MAX_ACCOUNTS must be 1–1000");
  const planeCredentials = parsePlaneCredentials(
    get("AIKO_PLANE_CREDENTIALS") ?? "[]",
  );
  const replyStyle = get("AIKO_REPLY_STYLE") ?? "thinkfeel";
  if (replyStyle !== "thinkfeel" && replyStyle !== "direct") throw new Error("Invalid reply style");
  const voiceEnabled =
    mode === "live" && replyStyle === "thinkfeel" && get("AIKO_ALLOW_THINKFEEL") === "true";
  const voiceKey = get("THINKFEEL_API_KEY");
  if (voiceEnabled && !voiceKey)
    throw new Error("ThinkFeel enabled without a key");
  const requestedLimit = (get("AIKO_TOOL_CALL_LIMIT") ?? "unlimited").trim();
  const toolCallLimit =
    requestedLimit === "unlimited" ? null : Number(requestedLimit);
  if (
    toolCallLimit !== null &&
    (!Number.isSafeInteger(toolCallLimit) || toolCallLimit < 1)
  )
    throw new Error(
      "AIKO_TOOL_CALL_LIMIT must be unlimited or a positive safe integer",
    );
  const browserEnabled = get("AIKO_BROWSER_ENABLED");
  if (
    browserEnabled !== undefined &&
    browserEnabled !== "true" &&
    browserEnabled !== "false"
  )
    throw new Error("AIKO_BROWSER_ENABLED must be true or false");
  let browser: AikoConfig["browser"];
  if (browserEnabled === "true") {
    const executablePath = get("AIKO_BROWSER_EXECUTABLE") ?? "";
    if (!isAbsolute(executablePath))
      throw new Error(
        "An explicit absolute AIKO_BROWSER_EXECUTABLE is required",
      );
    const stat = await lstat(executablePath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !(stat.mode & 0o111) ||
      stat.mode & 0o022
    )
      throw new Error(
        "Browser executable must be a non-shared-writable executable file",
      );
    browser = {
      executablePath,
      domains: normalizeAgentBrowserAllowedDomains(
        (get("AIKO_BROWSER_ALLOWED_DOMAINS") ?? "*")
          .split(",")
          .map((v) => v.trim()),
      ),
    };
  }
  return {
    mode,
    instanceId,
    model,
    modelLimits,
    publicWeb,
    toolCallLimit,
    browser,
    port,
    stateDir,
    operatorToken,
    modelKey,
    memoryEmbedding,
    cerebrasKey: get("CEREBRAS_API_KEY"),
    modelRouting: parseModelRouting(Object.fromEntries(["AIKO_MODEL", "AIKO_CONVERSATION_PROVIDER", "AIKO_CONVERSATION_MODEL", "AIKO_RAG_PROVIDER", "AIKO_RAG_MODEL", "AIKO_BROWSER_PROVIDER", "AIKO_BROWSER_MODEL"].map(k => [k, get(k)]))),
    arcadeKey: get("ARCADE_API_KEY"),
    codeMode: get("AIKO_CODE_MODE") === "true",
    connectorVault: parseConnectorVault(get("AIKO_CONNECTOR_VAULT_JSON")),
    managerKey: parseManagerKey(get("AIKO_MANAGER_KEY")),
    hashicorpVault: parseVaultAddress(get("AIKO_HASHICORP_VAULT_ADDRESS"), get("AIKO_HASHICORP_VAULT_NAMESPACE")),
    voiceKey,
    persona: get("THINKFEEL_PERSONA_ID") ?? PERSONA,
    voiceEnabled,
    replyStyle,
    botToken,
    webhookSecret,
    allowedUsers,
    telegramMode,
    telegramPublic,
    maxAccounts,
    planeCredentials,
  };
}
