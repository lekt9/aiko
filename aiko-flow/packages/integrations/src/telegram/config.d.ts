import { TelegramClientConfig as TelegramClientConfig$1, TelegramClientService } from './TelegramClientTypes.js';
import 'effect';
import '@smthrs/errors/SmithersError';

/**
 * Register process-wide Telegram config for outbound components.
 * Pass `null` to clear (tests).
 * @param {TelegramClientConfig | null} config
 */
declare function configureTelegram(config: TelegramClientConfig | null): void;
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
declare function resolveTelegramConfig(explicit?: (Partial<TelegramClientConfig> & {
    botTokenEnv?: string;
}) | undefined): TelegramClientConfig;
/**
 * Resolve config and build a client from it (outbound component seam).
 * @param {(Partial<TelegramClientConfig> & { botTokenEnv?: string }) | undefined} [explicit]
 */
declare function resolveTelegramClient(explicit?: (Partial<TelegramClientConfig> & {
    botTokenEnv?: string;
}) | undefined): TelegramClientService;
type TelegramClientConfig = TelegramClientConfig$1;

export { type TelegramClientConfig, configureTelegram, resolveTelegramClient, resolveTelegramConfig };
