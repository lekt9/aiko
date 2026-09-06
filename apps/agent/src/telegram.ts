import { telegram } from "tardie/channels/telegram";
import { Effect } from "effect";
import { boundedText, equalSecret, type HttpFetch } from "./security.ts";
import type { Sender } from "./actor.ts";
import {
  normalizeTelegramUpdate,
  type TelegramInbound,
} from "./telegram-normalize.ts";
import {
  createTelegramMedia,
  type TelegramMediaProcessor,
} from "./telegram-media.ts";
import { createTelegramOutbound } from "./telegram-outbound.ts";
export {
  normalizeTelegramUpdate,
  serializeTelegramInbound,
  redactTelegramInbound,
  telegramAlbumKey,
  TELEGRAM_ALLOWED_UPDATES,
  type TelegramInbound,
  type TelegramInboundPolicy,
} from "./telegram-normalize.ts";
export {
  TELEGRAM_CONTROL_BUTTONS,
  type TelegramRichResponse,
  type TelegramDelivery,
  type TelegramButton,
  type TelegramFile,
} from "./telegram-outbound.ts";
export function createTelegram(options: {
  token: string;
  secret: string;
  allowedUsers: ReadonlySet<string>;
  public?: boolean;
  fetch?: HttpFetch;
  redact?: (text: string) => string;
  mediaProcessor?: TelegramMediaProcessor;
}) {
  // Reuse the native Telegram provider's credential verification and normalization,
  // with a stricter application private-chat/allowlist boundary in front of it.
  const channel = telegram({
    name: "telegram",
    token: options.token,
    secretToken: options.secret,
    target: (source) => ({
      actor: "aiko",
      instance: "local",
      thread: `user-${source.sender}`,
    }),
  });
  const receive = async (
    request: Request,
  ): Promise<{ status: number; inbound?: TelegramInbound }> => {
    if (request.method !== "POST") return { status: 405 };
    if (
      !equalSecret(
        request.headers.get("x-telegram-bot-api-secret-token") ?? "",
        options.secret,
      )
    )
      return { status: 401 };
    let text: string;
    let update: any;
    try {
      text = await boundedText(new Response(request.body), 131_072);
      update = JSON.parse(text);
    } catch {
      return { status: 400 };
    }
    const result = normalizeTelegramUpdate(update, options);
    if (!result.inbound) return result;
    const inbound = result.inbound;
    // The native provider currently normalizes text only. Bridge the verified
    // media summary through it, retaining account-bound file descriptors separately.
    text = JSON.stringify({
      update_id: inbound.update,
      message: {
        message_id: inbound.messageId ?? inbound.update,
        date: Math.floor(inbound.at / 1000),
        from: { id: Number(inbound.user), is_bot: false },
        chat: { id: Number(inbound.user), type: "private" },
        text: inbound.text,
      },
    });
    const receipt = await Effect.runPromise(
      channel.provider.receive({
        url: request.url,
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": options.secret },
        body: new TextEncoder().encode(text),
        receivedAt: Date.now(),
      }),
    );
    const normalized = receipt.inbound[0];
    return {
      status: receipt.response.status,
      ...(normalized
        ? {
            inbound: {
              ...inbound,
              text: normalized.event.text,
            },
          }
        : {}),
    };
  };
  const send: Sender = async (chat, text, signal) => {
    if (
      (!options.public && !options.allowedUsers.has(chat)) ||
      !/^[1-9]\d{0,15}$/.test(chat) ||
      !text ||
      text.length > 4_000
    )
      return { status: "rejected" };
    try {
      const response = await (options.fetch ?? fetch)(
        `https://api.telegram.org/bot${options.token}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text,
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
          redirect: "manual",
        },
      );
      const body = JSON.parse(await boundedText(response)) as {
        ok?: boolean;
        result?: { message_id?: unknown };
      };
      if (
        response.ok &&
        body.ok === true &&
        Number.isSafeInteger(body.result?.message_id)
      )
        return {
          status: "delivered",
          providerId: String(body.result!.message_id),
        };
      // Telegram has no client idempotency key or read-back API. No automatic retry of unknown outcomes.
      return {
        status:
          response.status >= 400 && response.status < 500 && body.ok === false
            ? "rejected"
            : "unknown",
      };
    } catch {
      return { status: "unknown" };
    }
  };
  const outbound = createTelegramOutbound(options);
  return {
    receive,
    send,
    ...outbound,
    media: createTelegramMedia({
      token: options.token,
      fetch: options.fetch,
      redact: options.redact,
      processor: options.mediaProcessor,
    }),
  };
}
