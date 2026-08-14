import { EventSource } from '../core/EventSourceTypes.js';
import { IntegrationRuntime } from '../core/IntegrationRuntimeTypes.js';
import * as _smthrs_db_adapter from '@smthrs/db/adapter';
import '../core/CursorStoreTypes.js';
import 'effect';
import '@smthrs/errors/SmithersError';
import '../core/ExternalEventTypes.js';

/**
 * Read the bot token from the environment by NAME. The name may be logged;
 * the value never is.
 * @param {string} [envName]
 * @returns {string}
 */
declare function readTelegramBotToken(envName?: string): string;
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
declare function startTelegramBridgeHost(options: {
    adapter: _smthrs_db_adapter.SmithersDb;
    botToken: string;
    apiBaseUrl?: string;
    sourceId?: string;
    pollTimeoutSeconds?: number;
    allowedChatIds?: (number | string)[] | null;
    allowedUpdates?: string[];
    pollIntervalMs?: number;
}): {
    runtime: IntegrationRuntime;
    source: EventSource;
    shutdown: () => Promise<void>;
};
/**
 * Open a workspace store and run the host until `durationMs` elapses or a
 * signal arrives. Bounded by construction so a witness can never orphan it.
 *
 * @param {{ dbPath: string, tokenEnv?: string, apiBaseUrl?: string, durationMs?: number, pollTimeoutSeconds?: number, pollIntervalMs?: number, allowedChatIds?: (number|string)[] | null }} options
 */
declare function runTelegramBridgeHost(options: {
    dbPath: string;
    tokenEnv?: string;
    apiBaseUrl?: string;
    durationMs?: number;
    pollTimeoutSeconds?: number;
    pollIntervalMs?: number;
    allowedChatIds?: (number | string)[] | null;
}): Promise<void>;
declare const DEFAULT_TELEGRAM_TOKEN_ENV: "TELEGRAM_BOT_TOKEN";

export { DEFAULT_TELEGRAM_TOKEN_ENV, readTelegramBotToken, runTelegramBridgeHost, startTelegramBridgeHost };
