import { TelegramClientService, TelegramChatAction } from './TelegramClientTypes.js';
import { z } from 'zod';
import 'effect';
import '@smthrs/errors/SmithersError';

/**
 * @typedef {object} TypingIndicatorHandle
 * @property {() => Promise<{ sent: number; failed: number; refreshes: number; elapsedMs: number }>} stop
 *   Stop refreshing and report what was sent. Idempotent.
 * @property {() => number} sentCount how many chat actions have been ACCEPTED so far
 * @property {() => boolean} isRunning
 */
/**
 * Start a refreshing typing indicator and resolve once the FIRST action has
 * been sent — so a caller that awaits this can assert the indicator precedes
 * whatever it decorates, rather than racing it.
 *
 * @param {import("./TelegramClientTypes.ts").TelegramClientService} client
 * @param {number | string} chatId
 * @param {{ intervalMs?: number; maxMs?: number; action?: import("./TelegramClientTypes.ts").TelegramChatAction; messageThreadId?: number }} [options]
 * @returns {Promise<TypingIndicatorHandle>}
 */
declare function startTypingIndicator(client: TelegramClientService, chatId: number | string, options?: {
    intervalMs?: number;
    maxMs?: number;
    action?: TelegramChatAction;
    messageThreadId?: number;
}): Promise<TypingIndicatorHandle>;
/**
 * Run `body` with the typing indicator held up for its whole duration. The
 * indicator is started (and awaited) BEFORE `body` and stopped in a finally,
 * so it can neither trail the work it announces nor outlive a throw.
 *
 * @template T
 * @param {import("./TelegramClientTypes.ts").TelegramClientService} client
 * @param {number | string} chatId
 * @param {() => Promise<T>} body
 * @param {{ intervalMs?: number; maxMs?: number; action?: import("./TelegramClientTypes.ts").TelegramChatAction; messageThreadId?: number }} [options]
 * @returns {Promise<{ value: T; typing: { sent: number; failed: number; refreshes: number; elapsedMs: number } }>}
 */
declare function withTypingIndicator<T>(client: TelegramClientService, chatId: number | string, body: () => Promise<T>, options?: {
    intervalMs?: number;
    maxMs?: number;
    action?: TelegramChatAction;
    messageThreadId?: number;
}): Promise<{
    value: T;
    typing: {
        sent: number;
        failed: number;
        refreshes: number;
        elapsedMs: number;
    };
}>;
/**
 * Hold the indicator for a bounded window with no body to wrap — the shape a
 * durable `<TypingIndicator>` task uses, where the long turn it decorates is
 * a SEPARATE node running in parallel and therefore cannot be wrapped.
 *
 * @param {import("./TelegramClientTypes.ts").TelegramClientService} client
 * @param {number | string} chatId
 * @param {{ intervalMs?: number; maxMs?: number; action?: import("./TelegramClientTypes.ts").TelegramChatAction; messageThreadId?: number }} [options]
 * @returns {Promise<{ chatId: string; action: string; sent: number; failed: number; refreshes: number; elapsedMs: number }>}
 */
declare function holdTypingIndicator(client: TelegramClientService, chatId: number | string, options?: {
    intervalMs?: number;
    maxMs?: number;
    action?: TelegramChatAction;
    messageThreadId?: number;
}): Promise<{
    chatId: string;
    action: string;
    sent: number;
    failed: number;
    refreshes: number;
    elapsedMs: number;
}>;
/** Durable result of a bounded typing hold — counts, never content. */
declare const telegramTypingHoldSchema: z.ZodObject<{
    chatId: z.ZodString;
    action: z.ZodString;
    sent: z.ZodNumber;
    failed: z.ZodNumber;
    refreshes: z.ZodNumber;
    elapsedMs: z.ZodNumber;
}, z.core.$strip>;
/** Telegram expires a chat action after ~5s; refresh comfortably inside that. */
declare const DEFAULT_TYPING_REFRESH_MS: 4000;
/** Hard stop for an unattended refresher (5 minutes). */
declare const DEFAULT_TYPING_MAX_MS: 300000;
type TypingIndicatorHandle = {
    /**
     *   Stop refreshing and report what was sent. Idempotent.
     */
    stop: () => Promise<{
        sent: number;
        failed: number;
        refreshes: number;
        elapsedMs: number;
    }>;
    /**
     * how many chat actions have been ACCEPTED so far
     */
    sentCount: () => number;
    isRunning: () => boolean;
};

export { DEFAULT_TYPING_MAX_MS, DEFAULT_TYPING_REFRESH_MS, type TypingIndicatorHandle, holdTypingIndicator, startTypingIndicator, telegramTypingHoldSchema, withTypingIndicator };
