// @smithers-type-exports-begin
/** @typedef {import("./TelegramClientTypes.ts").TelegramClientConfig} TelegramClientConfig */
// @smithers-type-exports-end

import { SmithersError } from "@smthrs/errors/SmithersError";
import { makeTelegramClient } from "./TelegramClient.js";

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
 * registry > `process.env[botTokenEnv]` > `SMITHERS_TELEGRAM_BOT_TOKEN`.
 * Throws `INVALID_INPUT` when no bot token can be found — the error message
 * never includes any token material.
 *
 * `botTokenEnv` is the durable-input rule made mechanical: a workflow carries
 * the NAME of the variable, the process env carries the value, and the value
 * is read here — inside the call — so it never reaches a prop, a row, a
 * prompt, or a log. Prior art:
 * `.smithers/workflows/telegram-daily-digest.tsx:15,103,280`.
 *
 * @param {(Partial<TelegramClientConfig> & { botTokenEnv?: string }) | undefined} [explicit]
 * @returns {TelegramClientConfig}
 */
export function resolveTelegramConfig(explicit) {
  const namedEnv = explicit?.botTokenEnv ? process.env[explicit.botTokenEnv]?.trim() : undefined;
  const envToken = namedEnv || process.env.SMITHERS_TELEGRAM_BOT_TOKEN;
  const base = moduleConfig ?? (envToken ? { botToken: envToken } : null);
  const { botTokenEnv: _botTokenEnv, ...explicitConfig } = explicit ?? {};
  const merged = { ...base, ...explicitConfig };
  if (!merged.botToken && envToken) {
    merged.botToken = envToken;
  }
  if (!merged.botToken) {
    throw new SmithersError(
      "INVALID_INPUT",
      "No Telegram bot token configured. Pass config={ botToken } or config={ botTokenEnv } to the component, call configureTelegram({ botToken }), or set SMITHERS_TELEGRAM_BOT_TOKEN.",
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
