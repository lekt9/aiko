// The Telegram source host — the piece that was missing.
//
// (No shebang: tsup's dts pass refuses one in a package source file. Run it
// as `bun packages/integrations/src/telegram/bridgeHost.js`.)
//
// `makeTelegramSource` had no non-test caller anywhere in the repo and the
// server only ever built WEBHOOK sources, so nothing polled Telegram: the
// durable workflow could park on `<OnMessage>` forever because no process was
// turning `getUpdates` into signals. This is that process.
//
// Two refusals it exists to keep:
//   * the token is read from the ENVIRONMENT by name, never from argv — argv
//     is world-readable via `ps` and lands in shell history (the exact defect
//     in the failure transcript this bridge was built from);
//   * the cursor is durable (`makeDbCursorStore`), so a restart resumes at the
//     last acknowledged `update_id` instead of replaying or skipping.
//
// Run it detached beside the workflow:
//   bun packages/integrations/src/telegram/bridgeHost.js --db ./smithers.db
//   (reads $TELEGRAM_BOT_TOKEN; override the name with --token-env NAME)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Schedule } from "effect";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { openDurableSqliteDatabase } from "@smthrs/db/openDurableSqliteDatabase";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { makeDbCursorStore } from "../core/CursorStore.js";
import { makeIntegrationRuntime } from "../core/IntegrationRuntime.js";
import { makeTelegramSource } from "./TelegramSource.js";

export const DEFAULT_TELEGRAM_TOKEN_ENV = "TELEGRAM_BOT_TOKEN";

/**
 * Read the bot token from ~/.aiko/user-settings.json when the env var is
 * absent. Never throws for missing file — returns undefined so the caller
 * can decide. This is the same native store `aiko native telegram set-token`
 * writes to.
 * @returns {string | undefined}
 */
function readNativeTelegramToken() {
  try {
    const raw = readFileSync(join(homedir(), ".aiko", "user-settings.json"), "utf8");
    const parsed = JSON.parse(raw);
    const token = parsed?.telegram?.botToken;
    if (typeof token === "string" && token.trim().length > 0) {
      return token.trim();
    }
  } catch {
    // absent / unparsable — no native token
  }
  return undefined;
}

/**
 * Read the bot token from the environment by NAME, falling back to the
 * native file at ~/.aiko/user-settings.json. The env var name may be
 * logged; the value never is. This makes `aiko native telegram set-token`
 * the default — no export required.
 * @param {string} [envName]
 * @returns {string}
 */
export function readTelegramBotToken(envName = DEFAULT_TELEGRAM_TOKEN_ENV) {
  const envValue = process.env[envName]?.trim();
  if (envValue) {
    return envValue;
  }
  const native = readNativeTelegramToken();
  if (native) {
    return native;
  }
  // Also accept the generic Smithers env as a secondary fallback
  const smithersEnv = process.env.SMITHERS_TELEGRAM_BOT_TOKEN?.trim();
  if (smithersEnv) {
    return smithersEnv;
  }
  throw new SmithersError(
    "INVALID_INPUT",
    `No Telegram bot token found. Run \`aiko native telegram set-token --token <TOKEN>\` or export ${envName}=... before starting the source host.`,
    { envName },
  );
}

/**
 * Start the polling source + integration runtime against an existing adapter.
 * Returns the runtime so the caller owns shutdown.
 *
 * @param {{
 *   adapter: import("@smthrs/db/adapter").SmithersDb,
 *   botToken: string,
 *   apiBaseUrl?: string,
 *   sourceId?: string,
 *   pollTimeoutSeconds?: number,
 *   allowedChatIds?: (number | string)[] | null,
 *   allowedUpdates?: string[],
 *   pollIntervalMs?: number,
 * }} options
 */
export function startTelegramBridgeHost(options) {
  const {
    adapter,
    botToken,
    apiBaseUrl,
    sourceId,
    pollTimeoutSeconds = 25,
    allowedChatIds = null,
    allowedUpdates,
    pollIntervalMs,
  } = options;
  const source = makeTelegramSource({
    botToken,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(sourceId ? { sourceId } : {}),
    pollTimeoutSeconds,
    ...(allowedChatIds && allowedChatIds.length > 0 ? { allowedChatIds } : {}),
    ...(allowedUpdates ? { allowedUpdates } : {}),
    ...(pollIntervalMs != null ? { schedule: Schedule.spaced(`${pollIntervalMs} millis`) } : {}),
    cursorStore: makeDbCursorStore(adapter),
  });
  const runtime = makeIntegrationRuntime({ adapter, sources: [source] });
  return { runtime, source, shutdown: () => runtime.shutdown() };
}

/**
 * Open a workspace store and run the host until `durationMs` elapses or a
 * signal arrives. Bounded by construction so a witness can never orphan it.
 *
 * @param {{ dbPath: string, tokenEnv?: string, apiBaseUrl?: string, durationMs?: number, pollTimeoutSeconds?: number, pollIntervalMs?: number, allowedChatIds?: (number|string)[] | null }} options
 */
export async function runTelegramBridgeHost(options) {
  const botToken = readTelegramBotToken(options.tokenEnv);
  const { db, close } = openDurableSqliteDatabase(options.dbPath);
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  const { shutdown } = startTelegramBridgeHost({
    adapter,
    botToken,
    ...(options.apiBaseUrl ? { apiBaseUrl: options.apiBaseUrl } : {}),
    pollTimeoutSeconds: options.pollTimeoutSeconds ?? 25,
    ...(options.pollIntervalMs != null ? { pollIntervalMs: options.pollIntervalMs } : {}),
    allowedChatIds: options.allowedChatIds ?? null,
  });
  let stop = () => {};
  const stopped = new Promise((resolve) => {
    stop = () => resolve(undefined);
  });
  const onSignal = () => stop();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  /** @type {ReturnType<typeof setTimeout> | null} */
  let deadline = null;
  if (options.durationMs != null) {
    deadline = setTimeout(stop, options.durationMs);
  }
  try {
    await stopped;
  } finally {
    if (deadline) {
      clearTimeout(deadline);
    }
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await shutdown();
    close();
  }
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }
    const [name, inline] = arg.slice(2).split("=");
    flags[name] = inline ?? argv[++index] ?? "";
  }
  return flags;
}

if (import.meta.main) {
  const flags = parseArgs(process.argv.slice(2));
  await runTelegramBridgeHost({
    dbPath: flags.db ?? "./smithers.db",
    tokenEnv: flags["token-env"] ?? DEFAULT_TELEGRAM_TOKEN_ENV,
    ...(flags["api-base-url"] ? { apiBaseUrl: flags["api-base-url"] } : {}),
    ...(flags["duration-ms"] ? { durationMs: Number(flags["duration-ms"]) } : {}),
    ...(flags["poll-timeout-seconds"] ? { pollTimeoutSeconds: Number(flags["poll-timeout-seconds"]) } : {}),
    ...(flags["poll-interval-ms"] ? { pollIntervalMs: Number(flags["poll-interval-ms"]) } : {}),
    ...(flags["allowed-chat-ids"] ? { allowedChatIds: flags["allowed-chat-ids"].split(",") } : {}),
  });
  // The runtime holds fibers on a ManagedRuntime; exit explicitly so a
  // bounded host can never linger as an orphan.
  process.exit(0);
}
