// @smithers-type-exports-begin
/** @typedef {import("./TelegramClientTypes.ts").TelegramClientConfig} TelegramClientConfig */
// @smithers-type-exports-end

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { makeTelegramClient } from "./TelegramClient.js";

/**
 * Try to read the bot token from ~/.aiko/user-settings.json (the native
 * aiko store written by `aiko native telegram set-token`). Returns undefined
 * when the file is absent or has no token — never throws for missing file.
 * This is the fallback that makes the bridge work with zero exports.
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
    // absent / unparsable / no token — caller falls through
  }
  return undefined;
}

/**
 * Module-level Telegram config used by the outbound components
 * (`SendMessage`, `EditMessage`, ...) when no explicit `config` prop is
 * given. `createSmithers({ integrations })` binding lands in a later phase;
 * until then call `configureTelegram(...)` once at workflow setup, or rely
 * on the `SMITHERS_TELEGRAM_BOT_TOKEN` env fallback.
 *
 * @type {TelegramClientConfig | null}
 */
let moduleConfig = null;

/**
 * Register process-wide Telegram config for outbound components.
 * Pass `null` to clear (tests).
 * @param {TelegramClientConfig | null} config
 */
export function configureTelegram(config) {
  moduleConfig = config;
}

/**
 * Resolve the effective Telegram config: explicit prop > `configureTelegram`
 * registry > `process.env[botTokenEnv]` > `SMITHERS_TELEGRAM_BOT_TOKEN`
 * > `~/.aiko/user-settings.json` (native).
 * Throws `INVALID_INPUT` when no bot token can be found — the error message
 * never includes any token material.
 *
 * `botTokenEnv` is the durable-input rule made mechanical: a workflow carries
 * the NAME of the variable, the process env carries the value, and the value
 * is read here — inside the call — so it never reaches a prop, a row, a
 * prompt, or a log. Prior art:
 * `.smithers/workflows/telegram-daily-digest.tsx:15,103,280`.
 * The native file fallback makes the bridge default to `aiko native telegram
 * set-token` without any export.
 *
 * @param {(Partial<TelegramClientConfig> & { botTokenEnv?: string }) | undefined} [explicit]
 * @returns {TelegramClientConfig}
 */
export function resolveTelegramConfig(explicit) {
  const namedEnv = explicit?.botTokenEnv ? process.env[explicit.botTokenEnv]?.trim() : undefined;
  const envToken = namedEnv || process.env.SMITHERS_TELEGRAM_BOT_TOKEN;
  const nativeToken = !envToken ? readNativeTelegramToken() : undefined;
  const fallbackToken = envToken || nativeToken;
  const base = moduleConfig ?? (fallbackToken ? { botToken: fallbackToken } : null);
  const { botTokenEnv: _botTokenEnv, ...explicitConfig } = explicit ?? {};
  const merged = { ...base, ...explicitConfig };
  if (!merged.botToken && fallbackToken) {
    merged.botToken = fallbackToken;
  }
  if (!merged.botToken) {
    throw new SmithersError(
      "INVALID_INPUT",
      "No Telegram bot token configured. Run `aiko native telegram set-token --token <TOKEN>` or set TELEGRAM_BOT_TOKEN / SMITHERS_TELEGRAM_BOT_TOKEN.",
    );
  }
  return /** @type {TelegramClientConfig} */ (merged);
}

/**
 * Resolve config and build a client from it (outbound component seam).
 * @param {(Partial<TelegramClientConfig> & { botTokenEnv?: string }) | undefined} [explicit]
 */
export function resolveTelegramClient(explicit) {
  return makeTelegramClient(resolveTelegramConfig(explicit));
}
