import { AIKO_MINI_APP_URL } from "./telegram-mini-app.ts";
import { secretaryTelegram } from "./secretary-telegram.ts";
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
  miniAppUrl?: string;
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
    if (update && (update.business_connection || update.business_message || update.edited_business_message || update.deleted_business_messages))
      return { status: 200, inbound: await secretaryTelegram(options.token, options.fetch).receive(update, options) };
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
  const outbound = createTelegramOutbound({ ...options, miniAppUrl: options.miniAppUrl ?? AIKO_MINI_APP_URL });
  const send: Sender = (chat, text, signal, context) =>
    outbound.sendRich(chat, { kind: "text", text, ...context }, signal);
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
