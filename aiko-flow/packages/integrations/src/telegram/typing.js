// Refreshable Telegram typing indicator.
//
// Telegram clears a chat action after about five seconds, so a single
// `sendChatAction` fired as a side effect inside a send (TelegramClient.js
// sendMessageSmart) cannot keep the indicator alive across a long agent turn:
// the user watches "typing…" disappear while the turn is still running. The
// fix is not a longer action — the Bot API has none — it is re-sending on an
// interval for as long as the turn lasts.
//
// Two refusals are built in:
//   * a chat action must never fail the turn it decorates, so every send is
//     best-effort and its error is swallowed (counted, not thrown);
//   * a refresher must never outlive the process, so it is bounded by `maxMs`
//     AND its timer is unref'd — an abandoned indicator can neither hold the
//     event loop open nor message a chat forever.

import { Effect } from "effect";
import { z } from "zod";

/** Durable result of a bounded typing hold — counts, never content. */
export const telegramTypingHoldSchema = z.object({
  chatId: z.string(),
  action: z.string(),
  sent: z.number(),
  failed: z.number(),
  refreshes: z.number(),
  elapsedMs: z.number(),
});

/** Telegram expires a chat action after ~5s; refresh comfortably inside that. */
export const DEFAULT_TYPING_REFRESH_MS = 4_000;
/** Hard stop for an unattended refresher (5 minutes). */
export const DEFAULT_TYPING_MAX_MS = 300_000;

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
export async function startTypingIndicator(client, chatId, options = {}) {
  const intervalMs = Math.max(250, options.intervalMs ?? DEFAULT_TYPING_REFRESH_MS);
  const maxMs = Math.max(0, options.maxMs ?? DEFAULT_TYPING_MAX_MS);
  const action = options.action ?? "typing";
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + maxMs;
  let sent = 0;
  let failed = 0;
  let refreshes = 0;
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Promise<unknown>} */
  let inFlight = Promise.resolve();

  const fire = () => {
    const attempt = Effect.runPromise(
      client.sendChatAction(chatId, action, {
        ...(options.messageThreadId != null ? { messageThreadId: options.messageThreadId } : {}),
      }),
    ).then(
      () => {
        sent += 1;
      },
      () => {
        // Best-effort: a rejected chat action must never fail the turn.
        failed += 1;
      },
    );
    inFlight = attempt;
    return attempt;
  };

  const schedule = () => {
    if (stopped || Date.now() + intervalMs > deadlineMs) {
      return;
    }
    timer = setTimeout(async () => {
      if (stopped) {
        return;
      }
      refreshes += 1;
      await fire();
      schedule();
    }, intervalMs);
    // Never hold the process open on the indicator alone.
    /** @type {any} */ (timer)?.unref?.();
  };

  await fire();
  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight.catch(() => {});
      return { sent, failed, refreshes, elapsedMs: Date.now() - startedAtMs };
    },
    sentCount: () => sent,
    isRunning: () => !stopped,
  };
}

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
export async function withTypingIndicator(client, chatId, body, options = {}) {
  const handle = await startTypingIndicator(client, chatId, options);
  try {
    const value = await body();
    const typing = await handle.stop();
    return { value, typing };
  } finally {
    if (handle.isRunning()) {
      await handle.stop();
    }
  }
}

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
export async function holdTypingIndicator(client, chatId, options = {}) {
  const action = options.action ?? "typing";
  const maxMs = Math.max(0, options.maxMs ?? DEFAULT_TYPING_MAX_MS);
  const handle = await startTypingIndicator(client, chatId, options);
  // NOT unref'd: this timer IS the task's body, so the run must not be
  // allowed to consider itself quiescent while the hold is still owed.
  await new Promise((resolve) => setTimeout(resolve, maxMs));
  const stats = await handle.stop();
  return { chatId: String(chatId), action, ...stats };
}
